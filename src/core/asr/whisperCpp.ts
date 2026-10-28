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
    // 请求发出前就已被取消
    if (opts.signal?.aborted) throw new Error('转写已取消');

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
      let settled = false;

      const kill = () => {
        // Windows 下 kill 只终止主进程，需要连同子进程一起结束
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
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
        if (err) reject(err);
        else resolve();
      };

      // 超时兜底：whisper 卡死时不能让任务永远挂起
      const timer = setTimeout(() => {
        kill();
        finish(new Error(`whisper 转写超时（${Math.round(this.timeout / 60000)} 分钟）`));
      }, this.timeout);

      const onAbort = () => {
        kill();
        finish(new Error('转写已取消'));
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
        finish(new Error(`无法启动 whisper：${err.message}`));
      });

      proc.on('close', (code) => {
        if (code === 0) finish();
        else {
          const detail = (stderr.slice(-400) || stdout.slice(-400)).trim();
          finish(new Error(`whisper 退出码 ${code}${describeExitCode(code, detail)}`));
        }
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
    const probe = await verifyBinary(this.cfg.binaryPath);
    return probe.ok ? { ok: true, message: probe.message } : { ok: false, message: probe.message };
  }
}

/**
 * 判断可执行文件能否正常启动。
 *
 * 只判断 spawn 是否抛错是不够的：DLL 不匹配时进程会以 0xC0000139 之类的
 * 状态码立刻退出，stdout/stderr 全是空的，spawn 本身却「成功」了。
 */
export async function verifyBinary(binaryPath: string): Promise<{ ok: boolean; message: string }> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const done = (result: { ok: boolean; message: string }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(binaryPath, ['--help'], { windowsHide: true });
    } catch (err) {
      return done({ ok: false, message: `无法执行：${(err as Error).message}` });
    }

    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* 忽略 */
      }
      done({ ok: false, message: '启动自检超时（15s 无响应）' });
    }, 15000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      done({ ok: false, message: `无法执行：${err.message}` });
    });
    proc.stdout?.on('data', (d) => {
      out += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      out += d.toString();
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      // 部分构建的 --help 以非 0 退出，但会打印 usage，也算能跑
      if (code === 0 || /usage:/i.test(out)) {
        return done({ ok: true, message: 'whisper.cpp 可执行' });
      }
      done({ ok: false, message: `whisper 无法启动（退出码 ${code}）${describeExitCode(code, out)}` });
    });
  });
}

/**
 * 把 Windows 的异常退出码翻译成人能看懂的原因。
 *
 * 这些码都不是 whisper 自己返回的，而是加载器/运行时在进程启动阶段就失败了，
 * 所以 stderr 一定是空的——用户看到的「退出码 NNN：」后面什么都没有。
 */
export function describeExitCode(code: number | null, detail = ''): string {
  const tail = detail.trim() ? `：${detail.trim().slice(-300)}` : '';
  const name = EXIT_CODES.get(code ?? -1);
  if (!name) return tail ? `${tail}` : '';
  return `（${name.hex} ${name.title}）${name.hint}${tail}`;
}

const EXIT_CODES = new Map<
  number,
  { hex: string; title: string; hint: string }
>([
  [
    3221225785,
    {
      hex: '0xC0000139',
      title: '找不到 DLL 入口点',
      hint:
        'whisper 的依赖 DLL 版本对不上或文件损坏（最常见是 ggml-base.dll / ggml-cpu-*.dll 解压不完整）。' +
        '解决：删除 %APPDATA%\\BiliSummary\\asr\\whisper 后重新一键安装，或手动解压 whisper-bin-x64.zip 覆盖。',
    },
  ],
  [
    3221225477,
    {
      hex: '0xC0000005',
      title: '访问冲突',
      hint:
        '进程启动即崩溃，通常是 DLL 混用/被杀软拦截/文件损坏。先重装 whisper，仍失败再排查杀毒软件与 VC++ 运行库。',
    },
  ],
  [
    3221225595,
    {
      hex: '0xC000007B',
      title: '映像格式无效',
      hint: '32 位与 64 位组件混用，或下载的文件本身损坏，请重新下载 x64 版本。',
    },
  ],
  [
    3221225781,
    {
      hex: '0xC0000135',
      title: '缺少 DLL',
      hint: '缺少 VC++ 运行库或 whisper 自带的 DLL，请安装 Microsoft Visual C++ 2015-2022 x64 运行库。',
    },
  ],
  [
    3221226505,
    {
      hex: '0xC0000409',
      title: '栈溢出/安全校验失败',
      hint: '常见于杀毒软件注入或模型文件损坏，请重装 whisper 并重新下载模型。',
    },
  ],
]);

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
