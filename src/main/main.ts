/**
 * Electron 主进程。
 *
 * 负责：窗口管理、配置读写、B 站登录窗口、任务调度、文件导出。
 */
import { app, BrowserWindow, dialog, ipcMain, shell, session } from 'electron';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BilibiliClient } from '../core/bilibili/client.js';
import { ConfigStore, defaultConfigPath, validateConfig } from '../core/config.js';
import { createProvider } from '../core/providers/index.js';
import { createAsrProvider } from '../core/asr/index.js';
import { installWhisper, type WhisperModelSize } from '../core/asr/whisperInstall.js';
import { OllamaProvider } from '../core/providers/ollama.js';
import { runJob } from '../core/pipeline/job.js';
import {
  APP_USER_MODEL_ID,
  createDesktopShortcut,
  getShortcutState,
  removeDesktopShortcut,
} from './shortcut.js';
import type {
  AppConfig,
  JobProgress,
  JobRequest,
  LlmProviderKind,
  VideoInfo,
} from '../core/types.js';

/** B 站登录窗口使用独立分区，登录态与主窗口隔离且可持久化。 */
const BILI_PARTITION = 'persist:bilibili-login';

let mainWindow: BrowserWindow | null = null;
let loginWindow: BrowserWindow | null = null;
let configStore: ConfigStore | null = null;

/** 运行中的任务，用于取消。 */
const runningJobs = new Map<string, AbortController>();

/** 取消所有正在运行的任务。 */
function abortAllJobs(): void {
  for (const controller of runningJobs.values()) {
    try {
      controller.abort();
    } catch {
      /* 忽略 */
    }
  }
  runningJobs.clear();
}

/** 正在进行的 ASR 安装任务。 */
let installAbort: AbortController | null = null;

/** 向渲染进程发送消息，窗口已销毁时静默跳过。 */
function sendToRenderer(channel: string, payload: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const contents = mainWindow.webContents;
  if (contents.isDestroyed()) return;
  try {
    contents.send(channel, payload);
  } catch {
    /* 窗口可能在发送过程中被销毁 */
  }
}

function getConfigStore(): ConfigStore {
  if (!configStore) {
    configStore = new ConfigStore(defaultConfigPath(app.getPath('userData')));
  }
  return configStore;
}

function getConfig(): AppConfig {
  return getConfigStore().load();
}

/**
 * 全局复用的 B 站客户端。
 *
 * 复用后 buvid 指纹与 WBI 签名密钥都能跨任务缓存，
 * 省掉每次任务都重新握手，也降低触发风控的概率。
 */
let sharedClient: BilibiliClient | null = null;
let sharedClientCookie = '';

function getClient(): BilibiliClient {
  const cookie = getConfig().cookie;
  if (!sharedClient) {
    sharedClient = new BilibiliClient({ cookie });
    sharedClientCookie = cookie;
  } else if (cookie !== sharedClientCookie) {
    sharedClient.setCookie(cookie);
    sharedClientCookie = cookie;
  }
  return sharedClient;
}

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createMainWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    backgroundColor: '#0f1115',
    title: 'BiliSummary',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    // 窗口关掉后，正在跑的任务没有接收方，立即取消以免继续消耗网络与额度
    abortAllJobs();
  });

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const devServer = process.env.VITE_DEV_SERVER_URL;
  if (devServer) {
    void mainWindow.loadURL(devServer);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/** 打开 B 站登录窗口。 */
function openLoginWindow(): Promise<{ ok: boolean; message: string; cookie?: string }> {
  return new Promise((resolve) => {
    // 窗口已存在：聚焦它并立即返回，否则调用方会一直挂起
    if (loginWindow && !loginWindow.isDestroyed()) {
      loginWindow.focus();
      resolve({ ok: false, message: '登录窗口已打开，请在其中完成登录' });
      return;
    }

    const loginSession = session.fromPartition(BILI_PARTITION);
    loginWindow = new BrowserWindow({
      width: 1000,
      height: 720,
      title: '登录 B 站',
      webPreferences: {
        partition: BILI_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    let settled = false;
    const finish = async (result: { ok: boolean; message: string; cookie?: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const checkLogin = async () => {
      try {
        const cookies = await loginSession.cookies.get({ domain: '.bilibili.com' });
        const sess = cookies.find((c) => c.name === 'SESSDATA');
        if (!sess?.value) return false;

        const cookieStr = cookies
          .filter((c) => c.domain?.includes('bilibili.com'))
          .map((c) => `${c.name}=${c.value}`)
          .join('; ');

        const client = new BilibiliClient({ cookie: cookieStr });
        const status = await client.checkLogin();
        if (status.ok) {
          getConfigStore().patch({ cookie: cookieStr });
          sendToRenderer('login:changed', { ok: true, user: status.user });
          finish({ ok: true, message: `登录成功：${status.user}`, cookie: cookieStr });
          return true;
        }
        return false;
      } catch {
        return false;
      }
    };

    // 定时轮询登录态
    const timer = setInterval(async () => {
      if (!loginWindow || loginWindow.isDestroyed()) {
        clearInterval(timer);
        return;
      }
      if (await checkLogin()) {
        clearInterval(timer);
        loginWindow?.close();
      }
    }, 2000);

    loginWindow.on('closed', () => {
      clearInterval(timer);
      loginWindow = null;
      if (!settled) {
        finish({ ok: false, message: '已关闭窗口，未完成登录' });
      }
    });

    void loginWindow.loadURL('https://passport.bilibili.com/login');
  });
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  // --- 配置 ---
  ipcMain.handle('config:get', () => getConfig());

  ipcMain.handle('config:set', (_e, partial: Partial<AppConfig>) => {
    const merged = getConfigStore().patch(partial);
    return merged;
  });

  ipcMain.handle('config:validate', () => validateConfig(getConfig()));

  // --- 登录 ---
  ipcMain.handle('login:start', () => openLoginWindow());

  ipcMain.handle('login:status', async () => {
    return getClient().checkLogin();
  });

  ipcMain.handle('login:logout', async () => {
    getConfigStore().patch({ cookie: '' });
    try {
      const loginSession = session.fromPartition(BILI_PARTITION);
      await loginSession.clearStorageData();
      await loginSession.clearCache();
    } catch {
      /* 忽略 */
    }
    sendToRenderer('login:changed', { ok: false, user: '' });
    return { ok: true };
  });

  ipcMain.handle('login:import', (_e, cookie: string) => {
    const trimmed = (cookie || '').trim();
    if (!trimmed) throw new Error('Cookie 不能为空');
    getConfigStore().patch({ cookie: trimmed });
    return { ok: true };
  });

  // --- 视频信息 ---
  ipcMain.handle('video:info', async (_e, url: string): Promise<VideoInfo> => {
    const client = getClient();
    const { bvid } = await client.resolve(url);
    return client.getVideoInfo(bvid);
  });

  // --- 任务 ---
  ipcMain.handle('job:start', async (_e, request: JobRequest) => {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const controller = new AbortController();
    runningJobs.set(jobId, controller);

    const config = getConfig();

    // 后台执行，立刻返回 jobId
    void (async () => {
      try {
        const result = await runJob({
          request,
          config,
          jobId,
          client: getClient(),
          signal: controller.signal,
          onProgress: (progress: JobProgress) => {
            sendToRenderer('job:progress', progress);
          },
        });
        sendToRenderer('job:done', result);
      } catch (err) {
        if (controller.signal.aborted) {
          sendToRenderer('job:cancelled', { jobId });
        } else {
          sendToRenderer('job:failed', {
            jobId,
            message: (err as Error).message,
            hint: (err as { hint?: string }).hint,
          });
        }
      } finally {
        runningJobs.delete(jobId);
      }
    })();

    return { jobId };
  });

  ipcMain.handle('job:cancel', (_e, jobId: string) => {
    const controller = runningJobs.get(jobId);
    if (controller) {
      controller.abort();
      runningJobs.delete(jobId);
      return { ok: true };
    }
    return { ok: false };
  });

  // --- 供应商检测 ---
  ipcMain.handle('provider:check', async (_e, kind: LlmProviderKind) => {
    const config = getConfig();
    const provider = createProvider(kind, config, getClient());
    return provider.healthCheck();
  });

  ipcMain.handle('asr:check', async () => {
    const config = getConfig();
    const asr = createAsrProvider(config.asrProvider, config);
    if (!asr) return { ok: false, message: '未配置 ASR' };
    return asr.healthCheck();
  });

  // --- ASR 一键安装 ---
  ipcMain.handle('asr:install', async (_e, model: WhisperModelSize) => {
    const installDir = join(app.getPath('userData'), 'asr');
    const controller = new AbortController();
    installAbort = controller;

    try {
      const result = await installWhisper({
        installDir,
        model,
        signal: controller.signal,
        onProgress: (p) => {
          sendToRenderer('asr:install:progress', p);
        },
      });

      // 装完直接写进配置，用户不用手动填路径
      if (result.ok && result.binaryPath && result.modelPath) {
        const config = getConfig();
        getConfigStore().patch({
          asrProvider: 'whisper-cpp',
          whisperCpp: {
            ...config.whisperCpp,
            binaryPath: result.binaryPath,
            modelPath: result.modelPath,
          },
        });
      }
      return result;
    } catch (err) {
      return { ok: false, message: `安装失败：${(err as Error).message}` };
    } finally {
      installAbort = null;
    }
  });

  ipcMain.handle('asr:cancelInstall', () => {
    installAbort?.abort();
    installAbort = null;
    return { ok: true };
  });

  // --- Ollama 模型列表 ---
  ipcMain.handle('ollama:listModels', async (_e, baseUrl?: string) => {
    const config = getConfig();
    const provider = new OllamaProvider({
      ...config.ollama,
      baseUrl: baseUrl || config.ollama.baseUrl,
    });
    try {
      const models = await provider.listModels();
      return { ok: true, models };
    } catch (err) {
      return { ok: false, models: [], message: (err as Error).message };
    }
  });

  // --- 导出 ---
  ipcMain.handle('file:save', async (_e, defaultName: string, content: string) => {
    const config = getConfig();
    const defaultPath = config.outputDir
      ? join(config.outputDir, defaultName)
      : defaultName;

    const result = await dialog.showSaveDialog({
      title: '保存摘要',
      defaultPath: defaultPath,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: '文本', extensions: ['txt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });

    if (result.canceled || !result.filePath) {
      return { ok: false, canceled: true };
    }
    writeFileSync(result.filePath, content, 'utf8');
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('file:exportTranscript', async (_e, defaultName: string, content: string) => {
    const result = await dialog.showSaveDialog({
      title: '导出字幕',
      defaultPath: defaultName,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'SRT 字幕', extensions: ['srt'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    writeFileSync(result.filePath, content, 'utf8');
    return { ok: true, path: result.filePath };
  });

  ipcMain.handle('shell:open', async (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });

  // --- 桌面快捷方式 ---
  ipcMain.handle('shortcut:state', () => getShortcutState());

  ipcMain.handle('shortcut:create', async () => {
    try {
      return await createDesktopShortcut();
    } catch (err) {
      return {
        ok: false,
        path: '',
        action: 'failed' as const,
        message: `创建快捷方式时发生意外错误：${(err as Error).message}`,
      };
    }
  });

  ipcMain.handle('shortcut:remove', async () => {
    try {
      return await removeDesktopShortcut();
    } catch (err) {
      return {
        ok: false,
        path: '',
        action: 'failed' as const,
        message: `删除快捷方式时发生意外错误：${(err as Error).message}`,
      };
    }
  });

  // --- 选择本地可执行文件 / 模型文件 ---
  ipcMain.handle('dialog:pickFile', async (_e, kind: 'exe' | 'model' | 'binary') => {
    const filters =
      kind === 'model'
        ? [{ name: '模型文件', extensions: ['bin', 'gguf', 'pt', 'onnx'] }]
        : kind === 'binary'
          ? [{ name: '可执行文件', extensions: ['exe', 'bat', 'cmd', ''] }]
          : [{ name: '所有文件', extensions: ['*'] }];

    const result = await dialog.showOpenDialog({
      title:
        kind === 'model'
          ? '选择模型文件'
          : kind === 'binary'
            ? '选择 ffmpeg 可执行文件'
            : '选择 whisper 可执行文件',
      properties: kind === 'model' ? ['openFile'] : ['openFile'],
      filters,
    });

    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, path: result.filePaths[0] };
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    configPath: getConfigStore().filePath,
    appUserModelId: APP_USER_MODEL_ID,
  }));
}

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(async () => {
    // 允许通过文件关联打开 .md 摘要时直接显示
    // 设置 AppUserModelID，Windows 上让任务栏分组与桌面快捷方式保持一致
    if (process.platform === 'win32') {
      app.setAppUserModelId(APP_USER_MODEL_ID);
    }

    // 打包版自检：用于验证安装后的快捷方式功能
    const selfTest = process.env.BILISUMMARY_SELFTEST;
    if (selfTest === 'shortcut' || selfTest === 'shortcut-create') {
      const { runShortcutSelfCheck, createShortcutOnly } = await import(
        './shortcutSelfCheck.js'
      );
      if (selfTest === 'shortcut-create') {
        await createShortcutOnly();
      } else {
        await runShortcutSelfCheck();
      }
      app.exit(Number(process.exitCode ?? 0));
      return;
    }

    registerIpc();
    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
