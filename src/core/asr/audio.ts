/**
 * 音频下载与转码。
 *
 * 流程：流式下载 B 站 DASH 音频到临时目录 -> 按 ASR 后端用 ffmpeg 转码：
 * - whisper.cpp：16kHz 单声道 wav（whisper 友好格式）；
 * - OpenAI 兼容接口：16kHz 单声道 32kbps mp3，按 10 分钟切段上传。
 *   wav 每小时约 115 MB，远超 OpenAI / Groq 等服务 25 MB 的单文件上限，
 *   mp3 每段只有 2.4 MB 左右，上传也快得多。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { BilibiliClient } from '../bilibili/client.js';

/** 找不到 ffmpeg 时给用户看的提示。 */
export const FFMPEG_MISSING_MESSAGE =
  '未找到 ffmpeg。请在设置中指定 ffmpeg 可执行文件路径，或安装 ffmpeg-static。';

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
    const proc = spawn(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
      windowsHide: true,
    });
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

/** 下载进度：已收字节数与总字节数（服务器没给长度时为 0）。 */
export type DownloadProgress = (received: number, total: number) => void;

/** 下载好的原始音频，调用方负责 cleanup。 */
export interface DownloadedAudio {
  dir: string;
  rawPath: string;
  cleanup(): Promise<void>;
}

/** 临时工作目录（含转好的 wav），调用方负责清理。 */
export interface AudioWorkspace extends DownloadedAudio {
  wavPath: string;
}

/**
 * 把音频流式下载到新建的临时目录，逐个尝试 CDN 节点。
 * 任何一步失败都会清理临时目录后再抛出。
 */
export async function downloadAudio(
  client: BilibiliClient,
  bvid: string,
  cid: number,
  aid: number | undefined,
  signal?: AbortSignal,
  onProgress?: DownloadProgress,
): Promise<DownloadedAudio> {
  const dir = await mkdtemp(join(tmpdir(), 'bili-summary-'));
  const rawPath = join(dir, 'audio.m4s');
  const cleanup = async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  try {
    const candidates = await client.getAudioUrls(bvid, cid, aid);
    if (!candidates.length) throw new Error('未找到可用的音频流');

    let lastError: unknown = null;
    for (const url of candidates) {
      if (signal?.aborted) throw new Error('任务已取消');
      try {
        await client.downloadToFile(url, `https://www.bilibili.com/video/${bvid}/`, rawPath, {
          signal,
          onProgress,
        });
        return { dir, rawPath, cleanup };
      } catch (err) {
        // 取消时不再尝试其它节点
        if (signal?.aborted) throw err;
        lastError = err;
        console.warn(`音频节点不可用，尝试下一个：${(err as Error).message}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('所有音频节点均不可用');
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** 转成 whisper.cpp 需要的 16kHz 单声道 16bit wav。 */
export async function convertToWav(
  ffmpegPath: string,
  inputPath: string,
  wavPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await runFfmpeg(
    ffmpegPath,
    ['-y', '-hide_banner', '-nostdin', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath],
    signal,
  );
}

/** 上传给云端 ASR 时每段的时长（秒）：32kbps 下约 2.4 MB，远低于 25 MB 上限。 */
export const UPLOAD_SEGMENT_SECONDS = 600;

/** 一段待上传的音频及它在整段音频里的起始时间（秒）。 */
export interface UploadPart {
  path: string;
  offset: number;
}

/**
 * 把音频压成 16kHz 单声道 32kbps mp3 并按时长切段，供云端 ASR 逐段上传。
 * 各段的起始时间取自 ffmpeg 写出的分段清单，转写结果据此平移回整段时间轴。
 */
export async function encodeUploadParts(
  ffmpegPath: string,
  inputPath: string,
  outDir: string,
  opts: { segmentSeconds?: number; signal?: AbortSignal } = {},
): Promise<UploadPart[]> {
  const seconds = Math.max(1, Math.floor(opts.segmentSeconds ?? UPLOAD_SEGMENT_SECONDS));
  const listPath = join(outDir, 'upload-parts.csv');
  await runFfmpeg(
    ffmpegPath,
    [
      '-y',
      '-hide_banner',
      '-nostdin',
      '-i',
      inputPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '32k',
      '-f',
      'segment',
      '-segment_time',
      String(seconds),
      '-reset_timestamps',
      '1',
      '-segment_list',
      listPath,
      '-segment_list_type',
      'csv',
      join(outDir, 'upload-%03d.mp3'),
    ],
    opts.signal,
  );

  const parts = parseSegmentList(await readFile(listPath, 'utf8'), outDir);
  if (!parts.length) throw new Error('音频切段失败：ffmpeg 没有产出任何分段');
  return parts;
}

/** 解析 ffmpeg 的 csv 分段清单：每行「文件名,开始秒,结束秒」。 */
export function parseSegmentList(csv: string, dir: string): UploadPart[] {
  const parts: UploadPart[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cells = trimmed.split(',');
    const name = (cells[0] ?? '').trim().replace(/^"|"$/g, '');
    if (!name) continue;
    const offset = Number(cells[1]);
    parts.push({
      path: join(dir, basename(name)),
      offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
    });
  }
  return parts.sort((a, b) => a.offset - b.offset);
}

/** 下载音频并转码为 wav（whisper.cpp 与诊断脚本使用）。 */
export async function prepareAudio(
  client: BilibiliClient,
  bvid: string,
  cid: number,
  aid: number | undefined,
  ffmpegPath: string | null,
  signal?: AbortSignal,
  onProgress?: DownloadProgress,
): Promise<AudioWorkspace> {
  // 没有 ffmpeg 就不必白白下载几十 MB 的音频
  if (!ffmpegPath) throw new Error(FFMPEG_MISSING_MESSAGE);

  const audio = await downloadAudio(client, bvid, cid, aid, signal, onProgress);
  const wavPath = join(audio.dir, 'audio.wav');
  try {
    await convertToWav(ffmpegPath, audio.rawPath, wavPath, signal);
    return { ...audio, wavPath };
  } catch (err) {
    await audio.cleanup();
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
