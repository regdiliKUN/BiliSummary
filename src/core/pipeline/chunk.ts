/**
 * 字幕分段分块。
 *
 * 按字符预算把字幕切成若干块，每块保留完整的时间范围，
 * 供 LLM 逐块做结构化摘要。
 */
import type { TranscriptSegment } from '../types.js';
import { textWeight } from '../utils/text.js';

export interface TranscriptChunk {
  index: number;
  start: number;
  end: number;
  segments: TranscriptSegment[];
  /** 拼好的带时间戳的文本 */
  text: string;
}

/** 单块最少/最多条数，避免碎片块过多。 */
const MIN_SEGMENTS_PER_CHUNK = 6;

/**
 * 把字幕切分成块。
 * @param budget 每块的字符预算（按中文字符加权计算）
 */
export function chunkTranscript(
  segments: TranscriptSegment[],
  budget: number,
): TranscriptChunk[] {
  if (!segments.length) return [];

  const effectiveBudget = Math.max(1500, budget);
  const chunks: TranscriptChunk[] = [];

  let current: TranscriptSegment[] = [];
  let weight = 0;

  const flush = () => {
    if (!current.length) return;
    chunks.push({
      index: chunks.length,
      start: current[0]!.start,
      end: current[current.length - 1]!.end,
      segments: current,
      text: renderChunkText(current),
    });
    current = [];
    weight = 0;
  };

  for (const seg of segments) {
    const segWeight = textWeight(seg.text) + 12;
    // 已经有内容且再加这一段就超预算 -> 先切一块
    if (current.length >= MIN_SEGMENTS_PER_CHUNK && weight + segWeight > effectiveBudget) {
      flush();
    }
    current.push(seg);
    weight += segWeight;
  }
  flush();

  // 如果块数太多（字幕段很短导致），做一次合并
  return mergeTinyChunks(chunks, effectiveBudget);
}

/** 合并过碎的相邻块。 */
function mergeTinyChunks(chunks: TranscriptChunk[], budget: number): TranscriptChunk[] {
  if (chunks.length <= 1) return chunks;

  const out: TranscriptChunk[] = [];
  for (const chunk of chunks) {
    const prev = out[out.length - 1];
    if (prev) {
      const prevWeight = textWeight(prev.text);
      const curWeight = textWeight(chunk.text);
      if (prev.segments.length < MIN_SEGMENTS_PER_CHUNK && prevWeight + curWeight <= budget * 1.2) {
        const merged = [...prev.segments, ...chunk.segments];
        out[out.length - 1] = {
          index: prev.index,
          start: merged[0]!.start,
          end: merged[merged.length - 1]!.end,
          segments: merged,
          text: renderChunkText(merged),
        };
        continue;
      }
    }
    out.push(chunk);
  }
  return out.map((c, i) => ({ ...c, index: i }));
}

/** 把字幕段渲染成 `[mm:ss] 文本` 的形式，保留时间戳信息。 */
export function renderChunkText(segments: TranscriptSegment[]): string {
  return segments
    .map((s) => `[${formatShort(s.start)}] ${s.text}`)
    .join('\n');
}

/** 紧凑时间戳：`12:34` / `1:02:03` */
export function formatShort(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
