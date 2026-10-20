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

export class OpenAiProvider implements LlmProvider {
  readonly kind = 'openai' as const;
  readonly name: string;

  private readonly cfg: AppConfig['openai'];
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;

  constructor(cfg: AppConfig['openai'], fetchImpl: typeof fetch = fetch, timeout = 180000) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
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

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.doRequest(body, req.signal);
      } catch (err) {
        lastError = err as Error;
        const msg = (err as Error).message || '';
        // 只有"不支持 json 模式"才降级重试
        if (attempt === 0 && req.json && /response_format|json_object|not support/i.test(msg)) {
          delete body.response_format;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new Error('请求失败');
  }

  private async doRequest(body: Record<string, unknown>, signal?: AbortSignal): Promise<ChatResponse> {
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
        throw new Error(`HTTP ${res.status}: ${truncateBody(text)}`);
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
