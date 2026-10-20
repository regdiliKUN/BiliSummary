/**
 * 一键安装 whisper.cpp。
 *
 * 目的：让用户不必自己去 GitHub 找压缩包、解压、再单独下载几 GB 的模型。
 * 流程：查 release 资产 -> 下载 -> 解压 -> 下载模型 -> 回填路径。
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const GITHUB_RELEASES = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=12';
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

/** 可选的模型档位。 */
export type WhisperModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3-turbo';

export interface WhisperModelInfo {
  id: WhisperModelSize;
  label: string;
  sizeMB: number;
  /** 适用场景提示 */
  note: string;
}

export const WHISPER_MODELS: WhisperModelInfo[] = [
  { id: 'tiny', label: 'tiny', sizeMB: 75, note: '最快，质量最差' },
  { id: 'base', label: 'base', sizeMB: 141, note: '偏快，中文勉强可用' },
  { id: 'small', label: 'small', sizeMB: 466, note: '推荐，中文可用' },
  { id: 'medium', label: 'medium', sizeMB: 1530, note: '较慢，质量好' },
  { id: 'large-v3-turbo', label: 'large-v3-turbo', sizeMB: 1620, note: '最慢，质量最好' },
];

export interface WhisperInstallProgress {
  percent: number;
  message: string;
  /** 当前阶段 */
  stage: 'query' | 'download-binary' | 'extract' | 'download-model' | 'done';
}

export interface WhisperInstallResult {
  ok: boolean;
  binaryPath?: string;
  modelPath?: string;
  message: string;
}

/** 当前平台对应的发布资产名。 */
function assetNameForPlatform(): { asset: string; isTarGz: boolean } | null {
  switch (process.platform) {
    case 'win32':
      return { asset: 'whisper-bin-x64.zip', isTarGz: false };
    case 'linux':
      return { asset: 'whisper-bin-ubuntu-x64.tar.gz', isTarGz: true };
    default:
      // macOS 的 release 只提供 XCFramework，没有命令行可执行文件
      return null;
  }
}

/** 找到最新的、包含所需资产的 release。 */
async function findRelease(
  assetName: string,
): Promise<{ url: string; tag: string } | null> {
  const res = await fetch(GITHUB_RELEASES, {
    headers: {
      'User-Agent': 'BiliSummary',
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) {
    throw new Error(`查询 GitHub release 失败：HTTP ${res.status}`);
  }
  const releases = (await res.json()) as any[];
  for (const rel of releases) {
    const asset = (rel.assets ?? []).find((a: any) => a.name === assetName);
    if (asset?.browser_download_url) {
      return { url: asset.browser_download_url, tag: rel.tag_name };
    }
  }
  return null;
}

/** 带进度回调的下载。 */
async function downloadWithProgress(
  url: string,
  dest: string,
  onProgress?: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'BiliSummary' },
    signal,
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`下载失败 HTTP ${res.status}`);
  }
  const total = Number(res.headers.get('content-length') ?? 0);
  let received = 0;

  const source = Readable.fromWeb(res.body as any);
  source.on('data', (chunk: Buffer) => {
    received += chunk.length;
    onProgress?.(received, total);
  });

  await pipeline(source, createWriteStream(dest));
}

/** 解压（Windows 用内置 bsdtar，Linux 用 tar）。 */
async function extract(archive: string, dest: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const args = process.platform === 'win32' ? ['-xf', archive, '-C', dest] : ['-xzf', archive, '-C', dest];
    const proc = spawn('tar', args, { windowsHide: true });
    let stderr = '';
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', (err) => reject(new Error(`无法启动 tar：${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`解压失败（退出码 ${code}）：${stderr.slice(-300)}`));
    });
  });
}

/** 递归找可执行文件。 */
async function findBinary(dir: string, name: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findBinary(full, name);
      if (found) return found;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return full;
    }
  }
  return null;
}

/**
 * 一键安装 whisper.cpp + 模型。
 *
 * @param installDir 安装目录（通常是应用的用户数据目录）
 */
export async function installWhisper(params: {
  installDir: string;
  model: WhisperModelSize;
  onProgress?: (p: WhisperInstallProgress) => void;
  signal?: AbortSignal;
}): Promise<WhisperInstallResult> {
  const { installDir, model, onProgress, signal } = params;

  const platform = assetNameForPlatform();
  if (!platform) {
    return {
      ok: false,
      message:
        process.platform === 'darwin'
          ? 'macOS 的 whisper.cpp 发行包不含命令行程序，请用 Homebrew 安装：brew install whisper-cpp'
          : `暂不支持的平台：${process.platform}`,
    };
  }

  const binDir = join(installDir, 'whisper');
  const modelDir = join(installDir, 'whisper-models');
  const tempDir = join(tmpdir(), `whisper-install-${Date.now()}`);

  try {
    // --- 1. 查 release ---
    onProgress?.({ percent: 2, message: '正在查询 whisper.cpp 最新版本…', stage: 'query' });
    const release = await findRelease(platform.asset);
    if (!release) {
      return {
        ok: false,
        message: `没有找到包含 ${platform.asset} 的发行版本，请到 GitHub 手动下载。`,
      };
    }

    // --- 2. 下载程序 ---
    await mkdir(tempDir, { recursive: true });
    const archivePath = join(tempDir, basename(platform.asset));
    onProgress?.({
      percent: 5,
      message: `正在下载 whisper.cpp（${release.tag}）…`,
      stage: 'download-binary',
    });

    await downloadWithProgress(
      release.url,
      archivePath,
      (received, total) => {
        if (total > 0) {
          onProgress?.({
            percent: 5 + Math.round((received / total) * 20),
            message: `正在下载 whisper.cpp… ${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB`,
            stage: 'download-binary',
          });
        }
      },
      signal,
    );

    // --- 3. 解压 ---
    onProgress?.({ percent: 27, message: '正在解压…', stage: 'extract' });
    await mkdir(binDir, { recursive: true });
    await extract(archivePath, binDir);

    const exeName = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
    const binaryPath = await findBinary(binDir, exeName);
    if (!binaryPath) {
      return {
        ok: false,
        message: `解压完成但没找到 ${exeName}，目录：${binDir}`,
      };
    }

    // --- 4. 下载模型 ---
    const modelInfo = WHISPER_MODELS.find((m) => m.id === model) ?? WHISPER_MODELS[2]!;
    await mkdir(modelDir, { recursive: true });
    const modelPath = join(modelDir, `ggml-${modelInfo.id}.bin`);

    if (!existsSync(modelPath) || (await stat(modelPath)).size < 1024 * 1024) {
      onProgress?.({
        percent: 30,
        message: `正在下载模型 ${modelInfo.label}（约 ${modelInfo.sizeMB} MB）…`,
        stage: 'download-model',
      });

      const tmpModel = `${modelPath}.part`;
      await downloadWithProgress(
        `${HF_BASE}/ggml-${modelInfo.id}.bin`,
        tmpModel,
        (received, total) => {
          if (total > 0) {
            onProgress?.({
              percent: 30 + Math.round((received / total) * 68),
              message: `正在下载模型 ${modelInfo.label}… ${(received / 1048576).toFixed(0)}/${(total / 1048576).toFixed(0)} MB`,
              stage: 'download-model',
            });
          }
        },
        signal,
      );
      await writeFile(modelPath, await import('node:fs/promises').then((fs) => fs.readFile(tmpModel)));
      await rm(tmpModel, { force: true });
    } else {
      onProgress?.({ percent: 98, message: '模型已存在，跳过下载', stage: 'download-model' });
    }

    onProgress?.({ percent: 100, message: '安装完成', stage: 'done' });

    return {
      ok: true,
      binaryPath,
      modelPath,
      message: `安装完成：${basename(binaryPath)} + ggml-${modelInfo.id}.bin`,
    };
  } catch (err) {
    const message = (err as Error).message;
    if (signal?.aborted) return { ok: false, message: '已取消' };
    return { ok: false, message: `安装失败：${message}` };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
