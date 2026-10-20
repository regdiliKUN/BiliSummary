/**
 * whisper.cpp 本地转写供应商。
 *
 * 调用 whisper-cli（也兼容 main 可执行文件），用 `-oj` 输出 JSON，
 * 解析出带时间戳的分段。
 */
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AppConfig, AsrProvider, AsrResult, TranscriptSegment } from '../types.js';
import { cleanSubtitleText } from '../utils/text.js';

export class WhisperCppProvider implements AsrProvider {
  readonly kind = 'whisper-cpp' as const;
  readonly name: string;

  private readonly cfg: AppConfig['whisperCpp'];
  private readonly timeout: number;

  constructor(cfg: AppConfig['whisperCpp'], timeout = 3 * 60 * 60 * 1000) {
    this.cfg = cfg;
    this.timeout = timeout;
    this.name = 'whisper.cpp 本地转写';
  }

  async transcribe(audioPath: string, opts: { signal?: AbortSignal } = {}): Promise<AsrResult> {
    const outBase = join(dirname(audioPath), 'whisper-out');
    const args = [
      '-m',
      this.cfg.modelPath,
      '-f',
      audioPath,
      '-oj',
      '-of',
      outBase,
      '-l',
      this.cfg.language || 'auto',
      '-nt',
    ];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(this.cfg.binaryPath, args, { windowsHide: true });
      let stderr = '';
      let stdout = '';

      const onAbort = () => {
        proc.kill();
        reject(new Error('转写已取消'));
      };
      opts.signal?.addEventListener('abort', onAbort, { once: true });

      proc.stdout?.on('data', (d) => {
        stdout += d.toString();
        if (stdout.length > 20000) stdout = stdout.slice(-20000);
      });
      proc.stderr?.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 20000) stderr = stderr.slice(-20000);
      });

      proc.on('error', (err) => {
        opts.signal?.removeEventListener('abort', onAbort);
        reject(new Error(`无法启动 whisper：${err.message}`));
      });

      proc.on('close', (code) => {
        opts.signal?.removeEventListener('abort', onAbort);
        if (code === 0) resolve();
        else reject(new Error(`whisper 退出码 ${code}：${stderr.slice(-500) || stdout.slice(-500)}`));
      });
    });

    const jsonPath = `${outBase}.json`;
    let payload: any;
    try {
      payload = JSON.parse(await readFile(jsonPath, 'utf8'));
    } catch (err) {
      throw new Error(`无法解析 whisper 输出：${(err as Error).message}`);
    } finally {
      await rm(jsonPath, { force: true }).catch(() => {});
    }

    const segments = parseWhisperJson(payload);
    if (!segments.length) {
      throw new Error('whisper 未产生任何转写结果');
    }
    return { segments, language: this.cfg.language, model: basename(this.cfg.modelPath) };
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    if (!this.cfg.binaryPath) return { ok: false, message: '未配置 whisper 可执行文件路径' };
    if (!this.cfg.modelPath) return { ok: false, message: '未配置 whisper 模型文件路径' };
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(this.cfg.binaryPath, ['--help'], { windowsHide: true });
        proc.on('error', (err) => reject(err));
        proc.on('close', () => resolve());
      });
      return { ok: true, message: 'whisper.cpp 可执行' };
    } catch (err) {
      return { ok: false, message: `无法执行：${(err as Error).message}` };
    }
  }
}

/** 兼容 whisper.cpp 不同版本的 JSON 输出结构。 */
export function parseWhisperJson(payload: any): TranscriptSegment[] {
  const list: any[] = Array.isArray(payload) ? payload : payload?.transcription || [];

  return list
    .map((item: any) => {
      const text = cleanSubtitleText(String(item.text ?? ''));
      let start = Number(item?.offsets?.from ?? 0);
      let end = Number(item?.offsets?.to ?? 0);
      if (!start && item?.timestamps?.from) {
        start = parseTimestamp(item.timestamps.from);
        end = parseTimestamp(item.timestamps.to);
      }
      if (!Number.isFinite(start)) start = 0;
      if (!Number.isFinite(end) || end <= start) end = start;
      return { start: start / 1000, end: end / 1000, text };
    })
    .filter((s: TranscriptSegment) => s.text);
}

/** `00:00:02,500` -> 2500 毫秒 */
function parseTimestamp(ts: string): number {
  const m = ts.match(/(?:(\d+):)?(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  const h = Number(m[1] || 0);
  const min = Number(m[2] || 0);
  const sec = Number(m[3] || 0);
  const ms = Number(m[4] || 0);
  return ((h * 60 + min) * 60 + sec) * 1000 + ms;
}
