/**
 * Ollama 供应商（本地模型）。
 *
 * 使用 `/api/chat` 接口。Ollama 原生支持 `format: "json"`，输出结构比
 * OpenAI 兼容端点更稳定。
 */
import type { AppConfig, ChatRequest, ChatResponse, LlmProvider } from '../types.js';
import { pickOllamaModel } from '../modelpicker.js';

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
    this.name = `Ollama (${cfg.model || '未指定模型'})`;
  }

  private endpoint(path: string): string {
    const base = (this.cfg.baseUrl || '').replace(/\/+$/, '');
    return `${base}${path}`;
  }

  /** 列出本机已安装的模型。 */
  async listModels(): Promise<string[]> {
    const res = await this.fetchImpl(this.endpoint('/api/tags'), {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`无法连接 Ollama（HTTP ${res.status}），请确认它已启动`);
    }
    const json = await res.json();
    const models: string[] = (json?.models ?? []).map((m: any) => m?.name).filter(Boolean);
    return models;
  }

  /**
   * 确认要用的模型。
   *
   * 配置里没指定模型时，从本机已安装的模型里自动挑一个合适的，
   * 避免用户必须知道自己装了什么。
   */
  async resolveModel(): Promise<string> {
    if (this.cfg.model) return this.cfg.model;

    const models = await this.listModels();
    const picked = pickOllamaModel(models);
    if (!picked) {
      throw new Error(
        models.length
          ? '本机只安装了嵌入类模型，没有可用于对话的模型。请执行 ollama pull qwen3:8b'
          : 'Ollama 没有已下载的模型。请执行 ollama pull qwen3:8b 后重试。',
      );
    }
    // 回写，后续调用直接用
    this.cfg.model = picked;
    return picked;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // 请求发出前就已被取消
    if (req.signal?.aborted) throw new Error('请求已取消');

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

      // qwen3 / deepseek-r1 这类模型默认会先输出思维链：
      // 既慢又容易把 num_predict 预算耗光导致正文为空。
      // 做结构化摘要时不需要思维链，默认关掉。
      if (this.cfg.disableThinking) body.think = false;

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
      if (json?.error) {
        throw new Error(String(json.error));
      }
      const content = json?.message?.content;
      if (typeof content !== 'string') {
        throw new Error(`响应格式异常：${text.slice(0, 200)}`);
      }
      if (!content.trim()) {
        // 模型把预算耗在思维链上了，正文为空
        const thinkingLen = (json?.message?.thinking ?? '').length;
        throw new Error(
          thinkingLen
            ? `模型没有返回正文（输出了 ${thinkingLen} 字符的思维链）。请在设置里关闭「思维链」或换用非推理模型。`
            : '模型没有返回任何内容，请检查模型名是否正确。',
        );
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
      const models = await this.listModels();
      if (!models.length) {
        return { ok: false, message: 'Ollama 已连接，但没有已下载的模型（请先 ollama pull）' };
      }
      if (!this.cfg.model) {
        const picked = pickOllamaModel(models);
        if (!picked) {
          return {
            ok: false,
            message:
              '本机只有嵌入类模型，没有可用于摘要的对话模型。' +
              '请执行 ollama pull qwen3:8b',
          };
        }
        return {
          ok: true,
          message: `连接正常，将自动使用模型 ${picked}。已安装：${models.join(', ')}`,
        };
      }
      const matched = models.some(
        (m) => m === this.cfg.model || m.startsWith(`${this.cfg.model}:`),
      );
      if (!matched) {
        const picked = pickOllamaModel(models);
        return {
          ok: false,
          message:
            `模型 ${this.cfg.model} 未安装。` +
            (picked ? `建议改用 ${picked}。` : '') +
            `已安装：${models.join(', ')}`,
        };
      }
      return { ok: true, message: `连接正常（已安装 ${models.length} 个模型）` };
    } catch (err) {
      const msg = (err as Error).message;
      if (/无法连接/.test(msg)) {
        return { ok: false, message: '连不上 Ollama。请确认已启动（终端执行 ollama serve）' };
      }
      return { ok: false, message: `连接失败：${msg}` };
    }
  }
}
