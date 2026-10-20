/**
 * 从弹幕里提取「热点时刻」。
 *
 * 弹幕在某个时间点密集出现，通常意味着那里是名场面/高潮，
 * 是给模型补充信息的高价值信号（字幕往往只记录了「说了什么」）。
 */
import type { DanmakuItem } from '../types.js';

/** 热点时刻。 */
export interface HotMoment {
  time: number;
  /** 该时间窗口内的弹幕条数 */
  count: number;
  /** 出现最多的几条弹幕 */
  samples: string[];
}

/** 每个时间窗口的秒数。 */
const BUCKET_SECONDS = 10;

/**
 * 计算热点时刻。
 * @param limit 最多返回多少个热点
 */
export function findHotMoments(
  danmaku: DanmakuItem[],
  duration: number,
  limit = 12,
): HotMoment[] {
  if (!danmaku.length) return [];

  const buckets = new Map<number, DanmakuItem[]>();
  for (const item of danmaku) {
    const key = Math.floor(item.time / BUCKET_SECONDS);
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }

  // 阈值以「整段视频的平均密度」为基准。
  // 用所有时间窗口（含空窗口）算中位数，这样视频开头刷屏
  // 不会把真正的热点一起压掉；同时 2 倍中位数能过滤掉整体都很忙的时段。
  const span = duration > 0 ? Math.max(1, Math.ceil(duration / BUCKET_SECONDS)) : 0;
  const totalBuckets = Math.max(span, buckets.size);
  const density: number[] = new Array(totalBuckets).fill(0);
  for (const [key, items] of buckets) {
    if (key < totalBuckets) density[key] = items.length;
  }
  density.sort((a, b) => a - b);
  const median = density.length ? density[Math.floor(density.length / 2)]! : 0;
  const threshold = Math.max(3, median * 2);

  const moments: HotMoment[] = [];
  for (const [key, items] of buckets) {
    if (items.length < threshold) continue;

    // 统计重复出现的弹幕
    const counts = new Map<string, number>();
    for (const item of items) {
      const text = item.text.trim();
      if (!text || text.length > 30) continue;
      counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    const samples = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([text, n]) => (n > 1 ? `${text} ×${n}` : text));

    if (!samples.length) continue;
    moments.push({ time: key * BUCKET_SECONDS, count: items.length, samples });
  }

  moments.sort((a, b) => b.count - a.count);
  const top = moments.slice(0, limit);
  top.sort((a, b) => a.time - b.time);

  // 落在视频时长范围内的
  if (duration > 0) {
    return top.filter((m) => m.time < duration);
  }
  return top;
}

/** 把热点时刻渲染成提示词里的一段文字。 */
export function renderHotMoments(moments: HotMoment[], range?: { start: number; end: number }): string {
  const relevant = range
    ? moments.filter((m) => m.time >= range.start && m.time < range.end)
    : moments;
  if (!relevant.length) return '';
  return relevant
    .map((m) => `- [${formatMmSs(m.time)}] ${m.samples.join('、')}`)
    .join('\n');
}

function formatMmSs(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
