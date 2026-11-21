/**
 * OpenAI 兼容接口供应商。
 *
 * 兼容绝大多数第三方服务：OpenAI / DeepSeek / Kimi / GLM(智谱) / 豆包 /
 * SiliconFlow / Groq / Together / vLLM / LM Studio / Ollama 的 OpenAI 端点等。
 */
import type {
  AppConfig,
  ChatRequest,
  ChatResponse,
  LlmProvider,
} from '../types.js';
import { extractJson } from '../utils/text.js';

/** 带 HTTP 状态码的错误，便于判断是否值得重试。 */
export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

export interface RetryOptions {
  /** 遇到限流 / 服务端错误时最多额外重试几次，默认 2 */
  retries?: number;
  /** 指数退避的基准间隔，默认 1500ms */
  baseDelayMs?: number;
}

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 20000;

/** 是否为可重试的暂时性错误；返回本次应等待的毫秒数，不可重试返回 null。 */
export function retryDelayFor(err: unknown, attempt: number, baseDelayMs: number): number | null {
  const backoff = Math.min(MAX_RETRY_DELAY_MS, baseDelayMs * 2 ** attempt);
  if (err instanceof HttpStatusError) {
    if (!RETRYABLE_STATUS.has(err.status)) return null;
    return err.retryAfterMs !== undefined ? Math.min(MAX_RETRY_DELAY_MS, err.retryAfterMs) : backoff;
  }
  const msg = (err as Error)?.message ?? '';
  // 连接被重置等网络抖动；超时与取消不重试（超时重来只会再等一轮）
  if (/fetch failed|ECONNRESET|socket hang up|EPIPE|ETIMEDOUT|EAI_AGAIN/i.test(msg)) return backoff;
  return null;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('请求已取消'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('请求已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class OpenAiProvider implements LlmProvider {
  readonly kind = 'openai' as const;
  readonly name: string;

  private readonly cfg: AppConfig['openai'];
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;
  private readonly retries: number;
  private readonly baseDelayMs: number;

  constructor(
    cfg: AppConfig['openai'],
    fetchImpl: typeof fetch = fetch,
    timeout = 180000,
    retry: RetryOptions = {},
  ) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.retries = Math.max(0, retry.retries ?? 2);
    this.baseDelayMs = Math.max(0, retry.baseDelayMs ?? 1500);
    this.name = `OpenAI 兼容 (${cfg.model})`;
  }

  private endpoint(path: string): string {
    const base = (this.cfg.baseUrl || '').replace(/\/+$/, '');
    return `${base}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.cfg.apiKey) h.Authorization = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: req.messages,
      temperature: req.temperature ?? this.cfg.temperature,
      max_tokens: req.maxTokens ?? this.cfg.maxTokens,
    };

    // 部分服务/模型不支持 response_format，先带格式要求，失败后降级重试
    if (req.json) body.response_format = { type: 'json_object' };

    // 批量生成时多块并发，云端接口的 429 / 5xx 很常见：
    // 以前一次失败就记为「分块分析失败」，摘要直接缺一段；现在按退避重试。
    let retried = 0;
    for (;;) {
      try {
        return await this.doRequest(body, req.signal);
      } catch (err) {
        const msg = (err as Error).message || '';
        // "不支持 json 模式"：去掉 response_format 立即重发，不计入重试次数
        if (body.response_format && /response_format|json_object|not support/i.test(msg)) {
          delete body.response_format;
          continue;
        }
        if (req.signal?.aborted || retried >= this.retries) throw err;
        const delay = retryDelayFor(err, retried, this.baseDelayMs);
        if (delay === null) throw err;
        retried += 1;
        await sleep(delay, req.signal);
      }
    }
  }

  private async doRequest(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatResponse> {
    // 请求发出前就已被取消：AbortSignal 不会为后注册的监听者补发 abort 事件
    if (signal?.aborted) throw new Error('请求已取消');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await this.fetchImpl(this.endpoint('/chat/completions'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new HttpStatusError(
          `HTTP ${res.status}: ${truncateBody(text)}`,
          res.status,
          parseRetryAfter(res.headers?.get?.('retry-after') ?? null),
        );
      }

      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`返回内容不是 JSON：${truncateBody(text)}`);
      }

      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error(`响应中缺少内容：${truncateBody(text)}`);
      }
      return {
        content,
        model: json?.model,
        usage: {
          promptTokens: json?.usage?.prompt_tokens,
          completionTokens: json?.usage?.completion_tokens,
        },
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (signal?.aborted) throw new Error('请求已取消');
        throw new Error(`请求超时（${Math.round(this.timeout / 1000)}s）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await this.fetchImpl(this.endpoint('/models'), {
          headers: this.headers(),
          signal: controller.signal,
        });
        if (!res.ok) {
          return { ok: false, message: `接口不可达：HTTP ${res.status}` };
        }
        const json = await res.json().catch(() => null);
        const models: string[] = json?.data?.map((m: any) => m.id) ?? [];
        if (models.length && !models.includes(this.cfg.model)) {
          return {
            ok: false,
            message: `模型 ${this.cfg.model} 不在该接口的模型列表中。可用：${models.slice(0, 8).join(', ')}`,
          };
        }
        return { ok: true, message: `连接正常（${models.length || '未知'} 个模型可用）` };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return { ok: false, message: '连接超时' };
      }
      return { ok: false, message: `连接失败：${(err as Error).message}` };
    }
  }
}

/** 从错误响应体里截取有用信息。 */
function truncateBody(text: string, max = 300): string {
  try {
    const json = JSON.parse(text);
    const err = json?.error?.message || json?.message;
    if (err) return String(err).slice(0, max);
  } catch {
    /* 不是 JSON */
  }
  return (text || '').slice(0, max);
}

export { extractJson };
