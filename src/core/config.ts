/**
 * 配置定义与持久化。
 *
 * core 层不依赖 Electron：文件路径由调用方传入。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig, LlmProviderKind } from './types.js';

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
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 4096,
    // deepseek-chat 支持 64K 上下文，单块预算可以比 4o-mini 更宽
    contextChars: 16000,
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
  videoConcurrency: 2,
  danmakuLimit: 300,
  useDanmaku: true,
  saveHistory: true,
  historyLimit: 500,
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
        // 只接纳默认配置里已经存在的键：IPC 传入的未知字段（如 outputDir
        // 之外的任意属性）不能借浅合并写进用户配置或污染后续读取。
        const allowed = fallback as unknown as Record<string, unknown>;
        const from = incoming as Record<string, unknown>;
        const picked: Record<string, unknown> = {};
        for (const name of Object.keys(allowed)) {
          const value = from[name];
          if (value !== undefined && typeof value === typeof allowed[name]) {
            picked[name] = value;
          }
        }
        out[key] = { ...fallback, ...picked } as never;
      }
      continue;
    }
    if (typeof incoming === typeof fallback) {
      (out as unknown as Record<string, unknown>)[key] = incoming;
    }
  }
  return out;
}

/** 校验配置的必填项与数值边界，返回可直接展示给用户的问题列表。 */
export function validateConfig(config: AppConfig): string[] {
  const issues: string[] = [];
  const inRange = (label: string, value: number, min: number, max: number): void => {
    if (!Number.isFinite(value) || value < min || value > max) {
      issues.push(`${label}需在 ${min}-${max} 之间`);
    }
  };

  if (config.llmProvider === 'openai') {
    if (!config.openai.baseUrl) issues.push('OpenAI 兼容接口地址不能为空');
    if (!config.openai.model) issues.push('OpenAI 兼容接口的模型名不能为空');
    if (!config.openai.apiKey) issues.push('OpenAI 兼容接口的 API Key 为空（部分本地服务可留空）');
  } else if (config.llmProvider === 'deepseek') {
    if (!config.deepseek.baseUrl) issues.push('DeepSeek 接口地址不能为空');
    if (!config.deepseek.model) issues.push('DeepSeek 模型名不能为空');
    if (!config.deepseek.apiKey) issues.push('DeepSeek 的 API Key 为空');
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

  inRange('并发数', config.concurrency, 1, 8);
  inRange('视频并发数', config.videoConcurrency, 1, 6);
  if (!Number.isInteger(config.historyLimit) || (config.historyLimit !== -1 && config.historyLimit < 1)) {
    issues.push('历史条数需为 -1（不限制）或不小于 1 的整数');
  }
  if (!Number.isInteger(config.danmakuLimit) || config.danmakuLimit < 0 || config.danmakuLimit > 5000) {
    issues.push('弹幕数量需在 0-5000 之间');
  }

  // NaN 会通过 typeof 检查混进配置，必须显式用 Number.isFinite 拦截。
  const llm = config.llmProvider === 'deepseek'
    ? config.deepseek
    : config.llmProvider === 'ollama'
      ? config.ollama
      : config.openai;
  inRange('temperature', llm.temperature, 0, 2);
  inRange('maxTokens', llm.maxTokens, 256, 128_000);
  inRange('上下文字符预算', llm.contextChars, 2000, 200_000);

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
    // 与历史索引一样采用「临时文件 + rename」：进程被强杀或磁盘写满时，
    // 原配置仍完整可读，不会出现半截 JSON 导致下次启动全部回退默认值。
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8');
      renameSync(tmp, this.filePath);
    } catch (err) {
      try {
        if (existsSync(tmp)) renameSync(tmp, `${tmp}.failed`);
      } catch {
        /* 保留残留文件供排查，不覆盖原始错误 */
      }
      throw err;
    }
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

/**
 * 取某个供应商的「模型名 + 单块字符预算」。
 *
 * 每个供应商的配置互相独立，业务层不该硬编码 openai/ollama 两分支，
 * 否则新增供应商时会静默用错模型名和分块预算。
 */
export function resolveModelProfile(
  config: AppConfig,
  kind: LlmProviderKind,
): { model: string; contextChars: number } {
  switch (kind) {
    case 'ollama':
      return { model: config.ollama.model, contextChars: config.ollama.contextChars || 8000 };
    case 'deepseek':
      return { model: config.deepseek.model, contextChars: config.deepseek.contextChars || 16000 };
    case 'bilibili':
      return { model: 'B站官方AI总结', contextChars: 12000 };
    case 'openai':
    default:
      return { model: config.openai.model, contextChars: config.openai.contextChars || 12000 };
  }
}
