/** 供应商工厂：按配置创建对应的 LLM 供应商。 */
import { BilibiliClient } from '../bilibili/client.js';
import type { AppConfig, LlmProvider, LlmProviderKind } from '../types.js';
import { BilibiliBuiltinProvider } from './bilibiliBuiltin.js';
import { OllamaProvider } from './ollama.js';
import { OpenAiProvider } from './openai.js';

export { BilibiliBuiltinProvider } from './bilibiliBuiltin.js';
export { OllamaProvider } from './ollama.js';
export { OpenAiProvider } from './openai.js';
export type { DirectSummaryProvider } from './bilibiliBuiltin.js';

/** 根据配置创建供应商。 */
export function createProvider(
  kind: LlmProviderKind,
  config: AppConfig,
  client: BilibiliClient,
): LlmProvider {
  switch (kind) {
    case 'ollama':
      return new OllamaProvider(config.ollama);
    case 'bilibili':
      return new BilibiliBuiltinProvider(client, config.bilibili);
    case 'openai':
    default:
      return new OpenAiProvider(config.openai);
  }
}
