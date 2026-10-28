/**
 * DeepSeek 官方 API 供应商。
 *
 * DeepSeek 的 /chat/completions 与 OpenAI 完全同构（OpenAI SDK 可直接指向
 * https://api.deepseek.com），所以这里复用 OpenAiProvider，只补三件事：
 *
 * 1. 独立的 kind / name，便于 UI 与历史记录区分；
 * 2. 错误信息翻译：401 / 402 / 429 这类状态码对普通用户不直观；
 * 3. deepseek-reasoner 的适配：它默认先吐思维链，且 response_format 支持不稳定，
 *    这里关掉 JSON 直出模式，交给提示词 + extractJson 兜底解析。
 */
import type {
  ChatRequest,
  ChatResponse,
  DeepSeekProviderConfig,
  LlmProvider,
} from '../types.js';
import { OpenAiProvider } from './openai.js';

export class DeepSeekProvider implements LlmProvider {
  readonly kind = 'deepseek' as const;
  readonly name: string;

  private readonly cfg: DeepSeekProviderConfig;
  private readonly inner: OpenAiProvider;

  constructor(cfg: DeepSeekProviderConfig, fetchImpl: typeof fetch = fetch) {
    this.cfg = cfg;
    this.inner = new OpenAiProvider(cfg, fetchImpl);
    this.name = `DeepSeek (${cfg.model || 'deepseek-chat'})`;
  }

  /** R1 / reasoner 系列：先输出 reasoning_content，正文才在 content 里。 */
  private get isReasoner(): boolean {
    return /reasoner|(^|[-_/])r1($|[-_/])/i.test(this.cfg.model || '');
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    if (!this.cfg.apiKey) {
      throw new Error('未填写 DeepSeek 的 API Key，请在设置 → 摘要模型 → DeepSeek 中填入');
    }
    try {
      // 推理模型不走 response_format，避免 400；正文仍由提示词约束成 JSON
      const payload = this.isReasoner ? { ...req, json: false } : req;
      return await this.inner.chat(payload);
    } catch (err) {
      throw new Error(translateDeepSeekError((err as Error).message));
    }
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    if (!this.cfg.apiKey) return { ok: false, message: '未填写 API Key' };
    try {
      const res = await this.inner.healthCheck();
      return res.ok ? res : { ok: false, message: translateDeepSeekError(res.message) };
    } catch (err) {
      return { ok: false, message: translateDeepSeekError((err as Error).message) };
    }
  }
}

/** 把 HTTP 状态码翻译成能直接照做的提示。 */
export function translateDeepSeekError(message: string): string {
  const text = message || '';
  if (/\b401\b|invalid.*api.?key|unauthorized/i.test(text)) {
    return `API Key 无效或已过期（${text.slice(0, 120)}）。请到 platform.deepseek.com 重新生成后再填入`;
  }
  if (/\b402\b|insufficient.*balance|quota/i.test(text)) {
    return `DeepSeek 账户余额不足（${text.slice(0, 120)}），请先充值`;
  }
  if (/\b429\b|rate.?limit/i.test(text)) {
    return `触发 DeepSeek 限流（${text.slice(0, 120)}），请降低并发数后重试`;
  }
  if (/ENOTFOUND|ECONNREFUSED|fetch failed|getaddrinfo/i.test(text)) {
    return `无法连接 DeepSeek 接口（${text.slice(0, 120)}），请检查网络或 Base URL`;
  }
  return text;
}
