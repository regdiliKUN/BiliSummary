/**
 * 全局共享类型定义。
 * core 层不依赖 Electron，可在 Node/测试环境中直接使用。
 */

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

export type LlmProviderKind = 'openai' | 'ollama' | 'bilibili';
export type AsrProviderKind = 'none' | 'openai' | 'whisper-cpp';
export type TranscriptSource = 'subtitle' | 'asr' | 'bilibili-ai' | 'none';

export interface OpenAiProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  /** 每次请求的最大上下文（字符数），用于分块。 */
  contextChars: number;
}

export interface OllamaProviderConfig {
  baseUrl: string;
  model: string;
  temperature: number;
  maxTokens: number;
  contextChars: number;
}

export interface BilibiliProviderConfig {
  /** B 站官方 AI 总结不返回可自由提问的结论，勾选后作为最终结果。 */
  useAsFinalResult: boolean;
}

export interface OpenAiAsrConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  language: string;
}

export interface WhisperCppConfig {
  /** whisper-cli / main 可执行文件路径 */
  binaryPath: string;
  /** ggml 模型文件路径 (ggml-*.bin) */
  modelPath: string;
  language: string;
  /** 可选：额外的 ffmpeg 可执行文件路径，留空则用内置 ffmpeg-static */
  ffmpegPath: string;
}

export interface AppConfig {
  llmProvider: LlmProviderKind;
  openai: OpenAiProviderConfig;
  ollama: OllamaProviderConfig;
  bilibili: BilibiliProviderConfig;
  asrProvider: AsrProviderKind;
  openaiAsr: OpenAiAsrConfig;
  whisperCpp: WhisperCppConfig;
  /** B 站 Cookie（SESSDATA 等），用于获取官方字幕 */
  cookie: string;
  /** 摘要输出语言，如 zh / en */
  summaryLanguage: string;
  /** 默认输出目录，空则弹窗询问 */
  outputDir: string;
  /** 是否把字幕全文一并导出 */
  exportTranscript: boolean;
  /** 并发请求数（分块摘要阶段） */
  concurrency: number;
  /** 弹幕数量上限，0 表示不抓取 */
  danmakuLimit: number;
  /** 抓取弹幕是否启用 */
  useDanmaku: boolean;
}

/* ------------------------------------------------------------------ */
/* B 站数据                                                            */
/* ------------------------------------------------------------------ */

export interface VideoOwner {
  mid: number;
  name: string;
  face: string;
}

export interface VideoStat {
  view: number;
  danmaku: number;
  reply: number;
  favorite: number;
  coin: number;
  share: number;
  like: number;
}

export interface VideoPart {
  cid: number;
  page: number;
  title: string;
  duration: number;
}

export interface VideoInfo {
  bvid: string;
  aid: number;
  cid: number;
  title: string;
  desc: string;
  cover: string;
  duration: number;
  pubdate: number;
  owner: VideoOwner;
  stat: VideoStat;
  parts: VideoPart[];
  /** 跳转链接 */
  url: string;
  /** 原始完整链接 */
  rawUrl: string;
}

/* ------------------------------------------------------------------ */
/* 字幕 / 转写                                                          */
/* ------------------------------------------------------------------ */

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  source: TranscriptSource;
  language?: string;
  segments: TranscriptSegment[];
  /** 官方字幕的原始 lan 标识 */
  lan?: string;
  /** AI 转写时使用的模型名 */
  model?: string;
}

export interface DanmakuItem {
  time: number;
  text: string;
  /** 弹幕类型：1 滚动 4 底部 5 顶部 */
  mode: number;
  color: number;
  pool: string;
}

/* ------------------------------------------------------------------ */
/* LLM 供应商                                                          */
/* ------------------------------------------------------------------ */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 供应商运行上下文（B 站官方总结等需要绑定具体视频）。 */
export interface ProviderContext {
  bvid?: string;
  cid?: number;
  upMid?: number;
  aid?: number;
  videoTitle?: string;
  videoDuration?: number;
}

export interface ChatRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** 要求返回 JSON */
  json?: boolean;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  model?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

export interface LlmProvider {
  readonly kind: LlmProviderKind;
  readonly name: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** 探测是否可用（能否连通、模型是否存在） */
  healthCheck(): Promise<{ ok: boolean; message: string }>;
  /** 绑定视频上下文（B 站官方总结需要） */
  bind?(ctx: ProviderContext): void;
}

/* ------------------------------------------------------------------ */
/* ASR 供应商                                                          */
/* ------------------------------------------------------------------ */

export interface AsrResult {
  segments: TranscriptSegment[];
  language?: string;
  model?: string;
}

export interface AsrProvider {
  readonly kind: AsrProviderKind;
  readonly name: string;
  transcribe(audioPath: string, opts: { signal?: AbortSignal }): Promise<AsrResult>;
  healthCheck(): Promise<{ ok: boolean; message: string }>;
}

/* ------------------------------------------------------------------ */
/* 摘要结构                                                            */
/* ------------------------------------------------------------------ */

export interface SummarySegment {
  start: number;
  end: number;
  title: string;
  points: string[];
  summary: string;
}

export interface VideoSummary {
  /** 一句话总结 */
  tldr: string;
  /** 全局关键要点 */
  keyPoints: string[];
  /** 分段摘要（带时间戳） */
  segments: SummarySegment[];
  /** 章节标题列表 */
  outline: { start: number; title: string }[];
  /** 关键洞察 / 值得注意的细节 */
  insights: string[];
  /** 生成时使用的模型描述 */
  model: string;
  provider: string;
  /** 使用的字幕来源 */
  transcriptSource: TranscriptSource;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* 任务与进度                                                          */
/* ------------------------------------------------------------------ */

export type JobStage =
  | 'queued'
  | 'fetching-info'
  | 'fetching-subtitle'
  | 'fetching-danmaku'
  | 'downloading-audio'
  | 'transcribing'
  | 'summarizing'
  | 'rendering'
  | 'done'
  | 'error'
  | 'cancelled';

export interface JobProgress {
  jobId: string;
  stage: JobStage;
  message: string;
  /** 0-100 */
  percent: number;
  /** 当前步骤细分 */
  detail?: string;
}

export interface JobRequest {
  /** BV 号 / av 号 / 完整链接 */
  url: string;
  /** 指定分P，留空则第一个 */
  part?: number;
  /** 强制指定字幕来源 */
  source?: TranscriptSource;
  /** 覆盖配置里的 LLM 供应商 */
  provider?: LlmProviderKind;
}

export interface JobResult {
  jobId: string;
  summary: VideoSummary;
  transcript: Transcript;
  video: VideoInfo;
  danmaku: DanmakuItem[];
  markdown: string;
  savedPath?: string;
}
