/**
 * 预加载脚本：把主进程能力以安全的方式暴露给渲染进程。
 */
import { contextBridge, ipcRenderer } from 'electron';
import type {
  AppConfig,
  JobProgress,
  JobRequest,
  JobResult,
  LlmProviderKind,
  ShortcutResult,
  ShortcutState,
  VideoInfo,
} from '../core/types.js';

export interface BiliSummaryApi {
  /* 配置 */
  getConfig(): Promise<AppConfig>;
  setConfig(partial: Partial<AppConfig>): Promise<AppConfig>;
  validateConfig(): Promise<string[]>;

  /* 登录 */
  startLogin(): Promise<{ ok: boolean; message: string; cookie?: string }>;
  getLoginStatus(): Promise<{ ok: boolean; user: string; message: string }>;
  logout(): Promise<{ ok: boolean }>;
  importCookie(cookie: string): Promise<{ ok: boolean }>;
  onLoginChanged(cb: (state: { ok: boolean; user: string }) => void): () => void;

  /* 视频 */
  fetchVideoInfo(url: string): Promise<VideoInfo>;

  /* 任务 */
  startJob(request: JobRequest): Promise<{ jobId: string }>;
  cancelJob(jobId: string): Promise<{ ok: boolean }>;
  onJobProgress(cb: (progress: JobProgress) => void): () => void;
  onJobDone(cb: (result: JobResult) => void): () => void;
  onJobFailed(cb: (info: { jobId: string; message: string; hint?: string }) => void): () => void;
  onJobCancelled(cb: (info: { jobId: string }) => void): () => void;

  /* 检测 */
  checkProvider(kind: LlmProviderKind): Promise<{ ok: boolean; message: string }>;
  checkAsr(): Promise<{ ok: boolean; message: string }>;

  /* 文件 */
  saveMarkdown(defaultName: string, content: string): Promise<{ ok: boolean; path?: string; canceled?: boolean }>;
  exportTranscript(defaultName: string, content: string): Promise<{ ok: boolean; path?: string; canceled?: boolean }>;
  openExternal(url: string): Promise<void>;

  /** 弹出文件选择框，返回所选路径 */
  pickFile(kind: 'exe' | 'model' | 'binary'): Promise<{ ok: boolean; path?: string; canceled?: boolean }>;

  /* 桌面快捷方式 */
  getShortcutState(): Promise<ShortcutState>;
  createShortcut(): Promise<ShortcutResult>;
  removeShortcut(): Promise<ShortcutResult>;

  /* 应用信息 */
  getAppInfo(): Promise<{ version: string; platform: string; configPath: string }>;
}

const api: BiliSummaryApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
  validateConfig: () => ipcRenderer.invoke('config:validate'),

  startLogin: () => ipcRenderer.invoke('login:start'),
  getLoginStatus: () => ipcRenderer.invoke('login:status'),
  logout: () => ipcRenderer.invoke('login:logout'),
  importCookie: (cookie) => ipcRenderer.invoke('login:import', cookie),
  onLoginChanged: (cb) => {
    const listener = (_e: unknown, state: { ok: boolean; user: string }) => cb(state);
    ipcRenderer.on('login:changed', listener);
    return () => ipcRenderer.removeListener('login:changed', listener);
  },

  fetchVideoInfo: (url) => ipcRenderer.invoke('video:info', url),

  startJob: (request) => ipcRenderer.invoke('job:start', request),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
  onJobProgress: (cb) => {
    const listener = (_e: unknown, p: JobProgress) => cb(p);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },
  onJobDone: (cb) => {
    const listener = (_e: unknown, r: JobResult) => cb(r);
    ipcRenderer.on('job:done', listener);
    return () => ipcRenderer.removeListener('job:done', listener);
  },
  onJobFailed: (cb) => {
    const listener = (_e: unknown, info: { jobId: string; message: string; hint?: string }) => cb(info);
    ipcRenderer.on('job:failed', listener);
    return () => ipcRenderer.removeListener('job:failed', listener);
  },
  onJobCancelled: (cb) => {
    const listener = (_e: unknown, info: { jobId: string }) => cb(info);
    ipcRenderer.on('job:cancelled', listener);
    return () => ipcRenderer.removeListener('job:cancelled', listener);
  },

  checkProvider: (kind) => ipcRenderer.invoke('provider:check', kind),
  checkAsr: () => ipcRenderer.invoke('asr:check'),

  saveMarkdown: (defaultName, content) =>
    ipcRenderer.invoke('file:save', defaultName, content),
  exportTranscript: (defaultName, content) =>
    ipcRenderer.invoke('file:exportTranscript', defaultName, content),
  openExternal: (url) => ipcRenderer.invoke('shell:open', url),
  pickFile: (kind) => ipcRenderer.invoke('dialog:pickFile', kind),

  getShortcutState: () => ipcRenderer.invoke('shortcut:state'),
  createShortcut: () => ipcRenderer.invoke('shortcut:create'),
  removeShortcut: () => ipcRenderer.invoke('shortcut:remove'),

  getAppInfo: () => ipcRenderer.invoke('app:info'),
};

contextBridge.exposeInMainWorld('api', api);
