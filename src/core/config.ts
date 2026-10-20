/**
 * 配置定义与持久化。
 *
 * core 层不依赖 Electron：文件路径由调用方传入。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig } from './types.js';

export const DEFAULT_CONFIG: AppConfig = {
  llmProvider: 'openai',
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o-mini',
    temperature: 0.3,
    maxTokens: 4096,
    contextChars: 12000,
  },
  ollama: {
    baseUrl: 'http://127.0.0.1:11434',
    // 留空表示自动选择本机已安装的模型
    model: '',
    temperature: 0.3,
    maxTokens: 4096,
    contextChars: 8000,
    disableThinking: true,
  },
  bilibili: {
    useOutlineAsTitles: true,
  },
  asrProvider: 'none',
  openaiAsr: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'whisper-1',
    language: 'zh',
  },
  whisperCpp: {
    binaryPath: '',
    modelPath: '',
    language: 'zh',
    ffmpegPath: '',
  },
  cookie: '',
  summaryLanguage: 'zh',
  outputDir: '',
  exportTranscript: false,
  concurrency: 3,
  danmakuLimit: 300,
  useDanmaku: true,
};

/** 深合并用户配置与默认值，容忍缺失字段。 */
export function mergeConfig(
  partial: Partial<AppConfig> | undefined | null,
  base: AppConfig = DEFAULT_CONFIG,
): AppConfig {
  if (!partial || typeof partial !== 'object') return structuredClone(base);

  const out = structuredClone(base);
  const p = partial as unknown as Record<string, unknown>;

  for (const key of Object.keys(out) as (keyof AppConfig)[]) {
    const incoming = p[key];
    if (incoming === undefined || incoming === null) continue;

    const fallback = out[key];
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      if (typeof incoming === 'object' && !Array.isArray(incoming)) {
        out[key] = { ...fallback, ...(incoming as object) } as never;
      }
      continue;
    }
    if (typeof incoming === typeof fallback) {
      (out as unknown as Record<string, unknown>)[key] = incoming;
    }
  }
  return out;
}

/** 校验配置的必填项，返回可直接展示给用户的问题列表。 */
export function validateConfig(config: AppConfig): string[] {
  const issues: string[] = [];

  if (config.llmProvider === 'openai') {
    if (!config.openai.baseUrl) issues.push('OpenAI 兼容接口地址不能为空');
    if (!config.openai.model) issues.push('OpenAI 兼容接口的模型名不能为空');
    if (!config.openai.apiKey) issues.push('OpenAI 兼容接口的 API Key 为空（部分本地服务可留空）');
  } else if (config.llmProvider === 'ollama') {
    if (!config.ollama.baseUrl) issues.push('Ollama 地址不能为空');
    if (!config.ollama.model) issues.push('Ollama 模型名不能为空');
  }

  if (config.asrProvider === 'openai') {
    if (!config.openaiAsr.baseUrl) issues.push('ASR 接口地址不能为空');
    if (!config.openaiAsr.model) issues.push('ASR 模型名不能为空');
  } else if (config.asrProvider === 'whisper-cpp') {
    if (!config.whisperCpp.binaryPath) issues.push('whisper.cpp 可执行文件路径不能为空');
    if (!config.whisperCpp.modelPath) issues.push('whisper.cpp 模型文件路径不能为空');
  }

  if (config.concurrency < 1 || config.concurrency > 8) {
    issues.push('并发数需在 1-8 之间');
  }
  if (!config.summaryLanguage.trim()) {
    issues.push('摘要语言不能为空');
  }
  return issues;
}

/** JSON 文件配置存储。 */
export class ConfigStore {
  readonly filePath: string;
  private cache: AppConfig | null = null;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** 读取配置（文件不存在时返回默认值，不抛错）。 */
  load(): AppConfig {
    if (this.cache) return this.cache;
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf8');
        this.cache = mergeConfig(JSON.parse(raw));
      } else {
        this.cache = structuredClone(DEFAULT_CONFIG);
      }
    } catch (err) {
      console.error(`读取配置失败，使用默认配置：${(err as Error).message}`);
      this.cache = structuredClone(DEFAULT_CONFIG);
    }
    return this.cache;
  }

  /** 保存配置。 */
  save(config: AppConfig): AppConfig {
    const merged = mergeConfig(config);
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf8');
    this.cache = merged;
    return merged;
  }

  /** 在现有配置上做局部更新。 */
  patch(partial: Partial<AppConfig>): AppConfig {
    return this.save(mergeConfig(partial, this.load()));
  }
}

/** 根据用户主目录生成默认配置路径。 */
export function defaultConfigPath(userDataDir: string): string {
  return join(userDataDir, 'config.json');
}
