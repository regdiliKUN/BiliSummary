/**
 * Ollama 供应商（本地模型）。
 *
 * 使用 `/api/chat` 接口。Ollama 原生支持 `format: "json"`，输出结构比
 * OpenAI 兼容端点更稳定。
 */
import type { AppConfig, ChatRequest, ChatResponse, LlmProvider } from '../types.js';

export class OllamaProvider implements LlmProvider {
  readonly kind = 'ollama' as const;
  readonly name: string;

  private readonly cfg: AppConfig['ollama'];
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;

  constructor(cfg: AppConfig['ollama'], fetchImpl: typeof fetch = fetch, timeout = 300000) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.name = `Ollama (${cfg.model})`;
  }

  private endpoint(path: string): string {
    const base = (this.cfg.baseUrl || '').replace(/\/+$/, '');
    return `${base}${path}`;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const onAbort = () => controller.abort();
    req.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const body: Record<string, unknown> = {
        model: this.cfg.model,
        messages: req.messages,
        stream: false,
        options: {
          temperature: req.temperature ?? this.cfg.temperature,
          num_predict: req.maxTokens ?? this.cfg.maxTokens,
        },
      };
      if (req.json) body.format = 'json';

      const res = await this.fetchImpl(this.endpoint('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const json = JSON.parse(text);
      const content = json?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(`响应格式异常：${text.slice(0, 200)}`);
      }
      return {
        content,
        model: json?.model,
        usage: {
          promptTokens: json?.prompt_eval_count,
          completionTokens: json?.eval_count,
        },
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (req.signal?.aborted) throw new Error('请求已取消');
        throw new Error(`请求超时（${Math.round(this.timeout / 1000)}s）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await this.fetchImpl(this.endpoint('/api/tags'), {
          signal: controller.signal,
        });
        if (!res.ok) {
          return { ok: false, message: `Ollama 不可达：HTTP ${res.status}` };
        }
        const json = await res.json().catch(() => null);
        const models: string[] = json?.models?.map((m: any) => m.name) ?? [];
        if (!models.length) {
          return { ok: false, message: 'Ollama 已连接，但没有已下载的模型（请先 ollama pull）' };
        }
        if (!models.some((m) => m === this.cfg.model || m.startsWith(`${this.cfg.model}:`))) {
          return {
            ok: false,
            message: `模型 ${this.cfg.model} 未安装。可用：${models.slice(0, 8).join(', ')}`,
          };
        }
        return { ok: true, message: `连接正常（${models.length} 个模型）` };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        return { ok: false, message: '连接超时，请确认 Ollama 已启动' };
      }
      return { ok: false, message: `连接失败：${(err as Error).message}` };
    }
  }
}
