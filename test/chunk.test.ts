import { describe, expect, it } from 'vitest';
import { chunkTranscript, formatShort } from '../src/core/pipeline/chunk.js';
import type { TranscriptSegment } from '../src/core/types.js';

function makeSegments(count: number, text = '这是一段用于测试的字幕内容'): TranscriptSegment[] {
  return Array.from({ length: count }, (_, i) => ({
    start: i * 2,
    end: i * 2 + 1.8,
    text: `${text}${i}`,
  }));
}

describe('字幕分块', () => {
  it('空字幕返回空数组', () => {
    expect(chunkTranscript([], 5000)).toEqual([]);
  });

  it('短字幕合成一块', () => {
    const chunks = chunkTranscript(makeSegments(5), 10000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.segments).toHaveLength(5);
  });

  it('长字幕被切成多块', () => {
    const chunks = chunkTranscript(makeSegments(200), 3000);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('块的时间范围递增且不重叠', () => {
    const chunks = chunkTranscript(makeSegments(200), 3000);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]!.start).toBeGreaterThanOrEqual(chunks[i - 1]!.end - 0.001);
    }
  });

  it('块索引连续', () => {
    const chunks = chunkTranscript(makeSegments(200), 3000);
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it('文本包含时间戳标记', () => {
    const chunks = chunkTranscript(makeSegments(3), 10000);
    expect(chunks[0]!.text).toMatch(/^\[00:00\]/);
  });

  it('不丢字幕', () => {
    const segs = makeSegments(120);
    const chunks = chunkTranscript(segs, 3000);
    const total = chunks.reduce((n, c) => n + c.segments.length, 0);
    expect(total).toBe(120);
  });
});

describe('时间戳格式化', () => {
  it('不足一小时显示 mm:ss', () => {
    expect(formatShort(0)).toBe('00:00');
    expect(formatShort(65)).toBe('01:05');
    expect(formatShort(599)).toBe('09:59');
  });

  it('超过一小时显示 h:mm:ss', () => {
    expect(formatShort(3600)).toBe('1:00:00');
    expect(formatShort(3725)).toBe('1:02:05');
  });
});
