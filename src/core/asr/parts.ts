/** 分段转写：逐段调用 ASR，再把时间戳平移回整段音频的时间轴。 */
import type { AsrProvider, AsrResult, TranscriptSegment } from '../types.js';
import type { UploadPart } from './audio.js';

export interface TranscribePartsOptions {
  signal?: AbortSignal;
  /** 同时上传的段数，默认 3 */
  concurrency?: number;
  /** 每完成一段回调一次 */
  onPart?: (done: number, total: number) => void;
}

/**
 * 并发转写各段并按原顺序拼接。
 *
 * 任意一段失败都会让整体失败（缺一段的转写会让摘要悄悄漏掉内容），
 * 失败后其它并发槽位不再领取新的分段，避免继续消耗额度。
 */
export async function transcribeParts(
  asr: AsrProvider,
  parts: UploadPart[],
  opts: TranscribePartsOptions = {},
): Promise<AsrResult> {
  const { signal, onPart } = opts;
  const results: (AsrResult | undefined)[] = new Array(parts.length);
  const limit = Math.max(1, Math.min(Math.floor(opts.concurrency ?? 3), parts.length || 1));
  let cursor = 0;
  let done = 0;
  let failed = false;

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (!failed && cursor < parts.length) {
        if (signal?.aborted) throw new Error('转写已取消');
        const index = cursor++;
        const part = parts[index]!;
        try {
          results[index] = await asr.transcribe(part.path, { signal });
        } catch (err) {
          failed = true;
          throw err;
        }
        done += 1;
        onPart?.(done, parts.length);
      }
    }),
  );

  const segments: TranscriptSegment[] = [];
  results.forEach((result, i) => {
    const offset = parts[i]?.offset ?? 0;
    for (const seg of result?.segments ?? []) {
      segments.push({ start: seg.start + offset, end: seg.end + offset, text: seg.text });
    }
  });

  const first = results.find((r): r is AsrResult => !!r);
  return { segments, language: first?.language, model: first?.model };
}
