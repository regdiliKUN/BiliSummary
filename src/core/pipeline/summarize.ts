/**
 * 摘要生成主流程。
 *
 * 1) 官方字幕/ASR 结果 -> 分块 -> 并发逐块结构化摘要
 * 2) 各块摘要 -> 合并 -> 全局摘要（TL;DR / 要点 / 章节 / 洞察）
 *
 * 任何一步的模型输出异常都会降级处理，保证流程不中断。
 */
import type {
  AppConfig,
  ChatMessage,
  DanmakuItem,
  LlmProvider,
  SummarySegment,
  Transcript,
  VideoInfo,
  VideoSummary,
} from '../types.js';
import { extractJson, normalizeText, toStringList } from '../utils/text.js';
import { chunkTranscript, formatShort, type TranscriptChunk } from './chunk.js';
import { buildChunkPrompt, buildMergePrompt, CHUNK_SYSTEM, MERGE_SYSTEM } from './prompts.js';

export interface SummarizeOptions {
  provider: LlmProvider;
  video: VideoInfo;
  transcript: Transcript;
  config: AppConfig;
  danmaku?: DanmakuItem[];
  signal?: AbortSignal;
  onProgress?: (info: { percent: number; message: string; detail?: string }) => void;
}

export class SummaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SummaryError';
  }
}

/** 生成完整视频摘要。 */
export async function summarize(opts: SummarizeOptions): Promise<VideoSummary> {
  const { provider, video, transcript, config, signal, onProgress } = opts;

  // B 站官方总结：直接产出，无需分块
  if (provider.kind === 'bilibili') {
    onProgress?.({ percent: 40, message: '正在获取 B 站官方 AI 总结' });
    const anyProvider = provider as LlmProvider & {
      fetchConclusion?: () => Promise<VideoSummary | null>;
    };
    if (typeof anyProvider.fetchConclusion !== 'function') {
      throw new SummaryError('B 站官方总结供应商未正确初始化');
    }
    const summary = await anyProvider.fetchConclusion();
    if (!summary) {
      throw new SummaryError('该视频没有可用的 B 站官方 AI 总结，请改用其它模型或提供字幕');
    }
    summary.model = 'B站官方AI总结';
    summary.provider = 'bilibili';
    summary.transcriptSource = 'bilibili-ai';
    summary.warnings = summary.warnings ?? [];
    return summary;
  }

  if (!transcript.segments.length) {
    throw new SummaryError('没有可用的字幕内容，无法生成摘要');
  }

  // --- 分块 ---
  const budget = provider.kind === 'ollama' ? config.ollama.contextChars : config.openai.contextChars;
  const chunks = chunkTranscript(transcript.segments, budget || 12000);
  if (!chunks.length) {
    throw new SummaryError('字幕内容为空');
  }
  onProgress?.({
    percent: 45,
    message: `字幕已切分为 ${chunks.length} 段`,
    detail: `共 ${transcript.segments.length} 条字幕`,
  });

  // --- 逐块摘要 ---
  const chunkResults: { index: number; start: number; end: number; data: SummarySegment[] }[] = [];
  const chunkErrors: Error[] = [];
  const warnings: string[] = [];
  let done = 0;

  const processChunk = async (chunk: TranscriptChunk) => {
    let segments: SummarySegment[] = [];
    try {
      segments = await summarizeChunk({
        provider,
        video,
        chunk,
        chunkTotal: chunks.length,
        language: config.summaryLanguage,
        signal,
      });
    } catch (err) {
      // 单块失败不应该让整个任务失败，先记下来
      if (signal?.aborted) throw err;
      chunkErrors.push(err as Error);
      console.warn(`第 ${chunk.index + 1} 段分析失败：${(err as Error).message}`);
    }
    chunkResults.push({ index: chunk.index, start: chunk.start, end: chunk.end, data: segments });
    done++;
    onProgress?.({
      percent: 45 + Math.round((done / chunks.length) * 40),
      message: `已完成 ${done}/${chunks.length} 段字幕的分析`,
    });
  };

  await runPool(chunks, Math.max(1, config.concurrency || 2), processChunk, signal);

  // 所有分块都失败才算彻底失败
  if (chunkErrors.length === chunks.length) {
    throw chunkErrors[0] ?? new Error('所有分块的分析都失败了');
  }
  if (chunkErrors.length) {
    // 必须让用户知道摘要并不完整，不能静默丢内容
    const msg = `有 ${chunkErrors.length}/${chunks.length} 段字幕分析失败，摘要可能不完整`;
    warnings.push(msg);
    console.warn(msg);
    onProgress?.({ percent: 85, message: msg });
  }

  chunkResults.sort((a, b) => a.index - b.index);

  // --- 合并 ---
  onProgress?.({ percent: 88, message: '正在汇总生成最终摘要' });
  const merged = await mergeSummaries({
    provider,
    video,
    chunkResults,
    language: config.summaryLanguage,
    signal,
  });

  return {
    tldr: merged.tldr,
    keyPoints: merged.keyPoints,
    segments: merged.segments,
    outline: merged.outline,
    insights: merged.insights,
    warnings,
    model: provider.kind === 'ollama' ? config.ollama.model : config.openai.model,
    provider: provider.kind,
    transcriptSource: transcript.source,
    createdAt: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* 单块摘要                                                            */
/* ------------------------------------------------------------------ */

async function summarizeChunk(params: {
  provider: LlmProvider;
  video: VideoInfo;
  chunk: TranscriptChunk;
  chunkTotal: number;
  language: string;
  signal?: AbortSignal;
}): Promise<SummarySegment[]> {
  const { provider, video, chunk, chunkTotal, language, signal } = params;

  const previousTail = chunk.index > 0 ? tailOf(chunk) : undefined;
  const prompt = buildChunkPrompt({
    title: video.title,
    duration: video.duration,
    chunkText: chunk.text,
    chunkIndex: chunk.index,
    chunkTotal,
    isFirst: chunk.index === 0,
    previousTail,
    language,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: CHUNK_SYSTEM },
    { role: 'user', content: prompt },
  ];

  const raw = await callJson(provider, messages, signal);
  return normalizeSegments(raw, chunk);
}

/** 取块末尾的一句作为下一块的上下文。 */
function tailOf(chunk: TranscriptChunk): string {
  const last = chunk.segments[chunk.segments.length - 1];
  if (!last) return '';
  return `[${formatShort(last.start)}] ${last.text}`;
}

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

async function mergeSummaries(params: {
  provider: LlmProvider;
  video: VideoInfo;
  chunkResults: { index: number; start: number; end: number; data: SummarySegment[] }[];
  language: string;
  signal?: AbortSignal;
}): Promise<{
  tldr: string;
  keyPoints: string[];
  segments: SummarySegment[];
  outline: { start: number; title: string }[];
  insights: string[];
}> {
  const { provider, video, chunkResults, language, signal } = params;

  const prompt = buildMergePrompt({
    title: video.title,
    duration: video.duration,
    chunkSummaries: chunkResults,
    language,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: MERGE_SYSTEM },
    { role: 'user', content: prompt },
  ];

  const fallback = buildFallbackSummary(video, chunkResults);

  let raw: unknown;
  try {
    raw = await callJson(provider, messages, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    // 合并失败：退回到直接拼接各块摘要
    return fallback;
  }

  const normalized = normalizeFinal(raw, fallback, video);
  return normalized;
}

/* ------------------------------------------------------------------ */
/* 模型调用与 JSON 解析                                                 */
/* ------------------------------------------------------------------ */

/** 调用模型并解析 JSON；解析失败时尝试一次修复。 */
async function callJson(
  provider: LlmProvider,
  messages: ChatMessage[],
  signal?: AbortSignal,
): Promise<unknown> {
  const res = await provider.chat({ messages, json: true, signal });
  try {
    return extractJson(res.content);
  } catch (firstErr) {
    // 修复重试：把不合法输出交给模型纠正
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: 'assistant', content: res.content },
      {
        role: 'user',
        content:
          '上面的输出不是合法 JSON。请只输出一个合法的 JSON 对象，严格遵循之前要求的结构，不要有任何其它文字。',
      },
    ];
    const retry = await provider.chat({ messages: repairMessages, json: true, signal });
    try {
      return extractJson(retry.content);
    } catch {
      throw new SummaryError(
        `模型未返回合法的 JSON：${(firstErr as Error).message}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* 结果归一化                                                          */
/* ------------------------------------------------------------------ */

/** 把模型输出的各种形态归一化成 SummarySegment[]。 */
export function normalizeSegments(raw: unknown, chunk?: TranscriptChunk): SummarySegment[] {
  const list = extractSegmentList(raw);
  const out: SummarySegment[] = [];

  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;

    const start = parseTimeValue(obj.start ?? obj.from ?? obj.start_time);
    const end = parseTimeValue(obj.end ?? obj.to ?? obj.end_time);
    const title = normalizeText(String(obj.title ?? obj.name ?? obj.heading ?? ''));
    const points = toStringList(obj.points ?? obj.key_points ?? obj.bullets ?? obj.items);
    const summary = normalizeText(String(obj.summary ?? obj.content ?? obj.text ?? ''));

    if (!title && !points.length && !summary) continue;

    // 时间戳缺失或非法时，落到块范围内
    const fallbackStart = chunk ? chunk.start : 0;
    const fallbackEnd = chunk ? chunk.end : (start ?? 0);
    const s = start ?? fallbackStart;
    let e = end ?? fallbackEnd;
    if (e <= s) e = Math.max(s + 1, fallbackEnd);

    out.push({ start: s, end: e, title: title || '未命名片段', points, summary });
  }

  if (!out.length && chunk) {
    // 模型没给出结构，退化成按块的一整段
    out.push({
      start: chunk.start,
      end: chunk.end,
      title: '内容概述',
      points: [],
      summary: chunk.segments.map((s) => s.text).join(' ').slice(0, 500),
    });
  }

  out.sort((a, b) => a.start - b.start);
  return out;
}

/** 从 raw 里找出 segments 数组。 */
function extractSegmentList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['segments', 'chapters', 'parts', 'items', 'sections']) {
      if (Array.isArray(obj[key])) return obj[key];
    }
  }
  return [];
}

/** 解析时间：支持数字秒、"01:23"、"00:01:23.5"、毫秒。 */
export function parseTimeValue(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    // 视频不可能长到 100000 秒，这么大的值一定是毫秒
    return value > 100000 ? value / 1000 : value;
  }

  const str = String(value).trim();

  if (/^\d+(\.\d+)?$/.test(str)) {
    const num = Number(str);
    return num > 100000 ? num / 1000 : num;
  }

  const m = str.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/);
  if (m) {
    const h = Number(m[1] || 0);
    const min = Number(m[2]);
    const sec = Number(m[3]);
    return h * 3600 + min * 60 + sec;
  }
  return undefined;
}

/** 归一化最终结果，缺什么补什么。 */
export function normalizeFinal(
  raw: unknown,
  fallback: {
    tldr: string;
    keyPoints: string[];
    segments: SummarySegment[];
    outline: { start: number; title: string }[];
    insights: string[];
  },
  video: VideoInfo,
): {
  tldr: string;
  keyPoints: string[];
  segments: SummarySegment[];
  outline: { start: number; title: string }[];
  insights: string[];
} {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;

  const segments = normalizeSegments(raw);
  const finalSegments = segments.length ? segments : fallback.segments;

  const tldr = normalizeText(String(obj.tldr ?? obj.summary ?? obj.abstract ?? '')) || fallback.tldr;

  let keyPoints = toStringList(obj.keyPoints ?? obj.key_points ?? obj.highlights ?? obj.points);
  if (!keyPoints.length) keyPoints = fallback.keyPoints;

  let insights = toStringList(obj.insights ?? obj.notes ?? obj.details ?? obj.tips);
  if (!insights.length) insights = fallback.insights;

  // outline
  let outline: { start: number; title: string }[] = [];
  const rawOutline = obj.outline ?? obj.chapters ?? obj.toc;
  if (Array.isArray(rawOutline)) {
    outline = rawOutline
      .map((item: any) => {
        if (typeof item === 'string') {
          return { start: 0, title: normalizeText(item) };
        }
        const start = parseTimeValue(item?.start ?? item?.timestamp ?? item?.time);
        const title = normalizeText(String(item?.title ?? item?.name ?? ''));
        return start === undefined || !title ? null : { start, title };
      })
      .filter(Boolean) as { start: number; title: string }[];
  }
  if (!outline.length) {
    outline = finalSegments.map((s) => ({ start: s.start, title: s.title }));
  }
  outline.sort((a, b) => a.start - b.start);

  return { tldr, keyPoints, segments: finalSegments, outline, insights };
}

/** 合并失败时的兜底摘要：直接把各块结果拼起来。 */
function buildFallbackSummary(
  video: VideoInfo,
  chunkResults: { index: number; start: number; end: number; data: SummarySegment[] }[],
): {
  tldr: string;
  keyPoints: string[];
  segments: SummarySegment[];
  outline: { start: number; title: string }[];
  insights: string[];
} {
  const segments = chunkResults.flatMap((c) => c.data);
  const keyPoints = segments.flatMap((s) => s.points).slice(0, 10);
  const tldr = segments
    .map((s) => s.summary || s.title)
    .filter(Boolean)
    .join(' ')
    .slice(0, 300);

  return {
    tldr: tldr || video.title,
    keyPoints,
    segments,
    outline: segments.map((s) => ({ start: s.start, title: s.title })),
    insights: [],
  };
}

/* ------------------------------------------------------------------ */
/* 简单并发池                                                          */
/* ------------------------------------------------------------------ */

/** 并发执行任务，最多 limit 个同时进行。 */
export async function runPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const size = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;

  const runners = Array.from({ length: size }, async () => {
    while (true) {
      // 取消后不再领取新任务
      if (signal?.aborted) return;
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]!, index);
    }
  });

  await Promise.all(runners);

  if (signal?.aborted) {
    throw new Error('任务已取消');
  }
}
