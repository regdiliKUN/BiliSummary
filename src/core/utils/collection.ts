/**
 * 合集合并摘要的时间轴工具。
 *
 * 合并生成时，多集字幕会被拼到一条「虚拟时间轴」上（各集首尾相接）。
 * 模型给出的时间戳是这条虚拟轴上的秒数，用户看不懂，
 * 需要还原成「第 3 集 12:34」这种形式。
 */
import type { CollectionResultEpisode } from '../types.js';

export interface EpisodeHit {
  episode: CollectionResultEpisode;
  /** 该集内部的相对时间（秒） */
  localTime: number;
}

/** mm:ss 或 h:mm:ss。 */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

/** 把虚拟时间轴上的秒数定位到具体某一集。 */
export function locateCollectionTime(
  episodes: CollectionResultEpisode[],
  seconds: number,
): EpisodeHit | null {
  if (!episodes.length) return null;
  const t = Math.max(0, seconds || 0);

  for (const episode of episodes) {
    if (t >= episode.start && t < episode.end) {
      return { episode, localTime: t - episode.start };
    }
  }

  const last = episodes[episodes.length - 1]!;
  if (t >= last.end) {
    return { episode: last, localTime: Math.max(0, Math.min(last.duration, t - last.start)) };
  }
  const first = episodes[0]!;
  return { episode: first, localTime: 0 };
}

/**
 * 「第 3 集 12:34」；定位不到时退化成普通时间。
 *
 * 模型给的 segment 标题通常已经带了「第3集 · xxx」，
 * 这时再拼一次集号会很啰嗦，所以传入标题做去重。
 */
export function formatCollectionTimestamp(
  episodes: CollectionResultEpisode[],
  seconds: number,
  title?: string,
): string {
  const hit = locateCollectionTime(episodes, seconds);
  if (!hit) return formatClock(seconds);
  const clock = formatClock(hit.localTime);
  if (title && new RegExp(`第\\s*${hit.episode.index}\\s*集`).test(title)) return clock;
  return `第${hit.episode.index}集 ${clock}`;
}

/** 给合集里的每一集标上序号（index 从 1 开始）。 */
export function withEpisodeIndex(
  episodes: Omit<CollectionResultEpisode, 'index'>[],
): CollectionResultEpisode[] {
  return episodes.map((ep, i) => ({ ...ep, index: i + 1 }));
}
