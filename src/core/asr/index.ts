/** ASR 供应商工厂。 */
import type { AppConfig, AsrProvider, AsrProviderKind } from '../types.js';
import { OpenAiAsrProvider } from './openaiCompat.js';
import { WhisperCppProvider } from './whisperCpp.js';

export { OpenAiAsrProvider } from './openaiCompat.js';
export { WhisperCppProvider } from './whisperCpp.js';
export { prepareAudio, resolveFfmpegPath } from './audio.js';
export type { AudioWorkspace } from './audio.js';

/** 根据配置创建 ASR 供应商；'none' 返回 null。 */
export function createAsrProvider(
  kind: AsrProviderKind,
  config: AppConfig,
): AsrProvider | null {
  switch (kind) {
    case 'openai':
      return new OpenAiAsrProvider(config.openaiAsr);
    case 'whisper-cpp':
      return new WhisperCppProvider(config.whisperCpp);
    case 'none':
    default:
      return null;
  }
}
