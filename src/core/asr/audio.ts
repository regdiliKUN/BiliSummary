/**
 * 音频下载与转码。
 *
 * 流程：下载 B 站 DASH 音频流 -> ffmpeg 转成 16kHz 单声道 wav（whisper 友好格式）。
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { BilibiliClient } from '../bilibili/client.js';

/**
 * 打包后位于 asar 内的可执行文件无法直接运行，
 * 需要把路径里的 app.asar 换成 app.asar.unpacked。
 */
export function fixAsarPath(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

/** 查找可用的 ffmpeg：优先用户配置，其次 ffmpeg-static，最后系统 PATH。 */
export async function resolveFfmpegPath(configured?: string): Promise<string | null> {
  if (configured) {
    try {
      await stat(configured);
      return configured;
    } catch {
      /* 继续找 */
    }
  }

  try {
    const mod: any = await import('ffmpeg-static');
    const p = mod?.default ?? mod;
    if (typeof p === 'string') {
      const fixed = fixAsarPath(p);
      await stat(fixed);
      return fixed;
    }
  } catch {
    /* 没装 ffmpeg-static */
  }

  // 尝试系统 PATH
  const found = await new Promise<string | null>((resolve) => {
    const proc = spawn(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
    let out = '';
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.on('close', (code) => {
      const first = out.split(/\r?\n/).find((l) => l.trim());
      resolve(code === 0 && first ? first.trim() : null);
    });
    proc.on('error', () => resolve(null));
  });
  return found;
}

/** 临时工作目录，调用方负责清理。 */
export interface AudioWorkspace {
  dir: string;
  rawPath: string;
  wavPath: string;
  cleanup(): Promise<void>;
}

/** 下载音频并转码为 wav。 */
export async function prepareAudio(
  client: BilibiliClient,
  bvid: string,
  cid: number,
  aid: number | undefined,
  ffmpegPath: string | null,
  signal?: AbortSignal,
): Promise<AudioWorkspace> {
  const dir = await mkdtemp(join(tmpdir(), 'bili-summary-'));
  const rawPath = join(dir, 'audio.m4s');
  const wavPath = join(dir, 'audio.wav');

  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const candidates = await client.getAudioUrls(bvid, cid, aid);
    if (!candidates.length) throw new Error('未找到可用的音频流');

    let data: Buffer | null = null;
    let lastError: unknown = null;
    for (const url of candidates) {
      if (signal?.aborted) throw new Error('任务已取消');
      try {
        data = await client.downloadBinary(
          url,
          `https://www.bilibili.com/video/${bvid}/`,
          signal,
        );
        break;
      } catch (err) {
        // 取消时不再尝试其它节点
        if (signal?.aborted) throw err;
        lastError = err;
        console.warn(`音频节点不可用，尝试下一个：${(err as Error).message}`);
      }
    }
    if (!data) {
      throw lastError instanceof Error
        ? lastError
        : new Error('所有音频节点均不可用');
    }

    await pipeline(Readable.from(data), createWriteStream(rawPath));

    if (!ffmpegPath) {
      throw new Error(
        '未找到 ffmpeg。请在设置中指定 ffmpeg 可执行文件路径，或安装 ffmpeg-static。',
      );
    }

    await runFfmpeg(ffmpegPath, [
      '-y',
      '-i',
      rawPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      wavPath,
    ], signal);

    return { dir, rawPath, wavPath, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** 执行 ffmpeg，失败时抛出带 stderr 的错误。 */
function runFfmpeg(bin: string, args: string[], signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('任务已取消'));
      return;
    }

    const proc = spawn(bin, args, { windowsHide: true });
    let stderr = '';
    let settled = false;

    const kill = () => {
      try {
        if (process.platform === 'win32' && proc.pid) {
          spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
        } else {
          proc.kill('SIGKILL');
        }
      } catch {
        proc.kill();
      }
    };

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };

    const onAbort = () => {
      kill();
      finish(new Error('转码已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on('error', (err) => finish(new Error(`无法启动 ffmpeg：${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(`ffmpeg 转码失败（退出码 ${code}）：${stderr.slice(-500)}`));
    });
  });
}
