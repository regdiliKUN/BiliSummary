/**
 * 合集合并生成：把勾选的多集字幕拼成一条时间轴，一次性生成一份整体摘要。
 *
 * 与「每集单独生成」的区别：
 * - 只调用一次最终摘要，能给出跨集的主题脉络，而不是 N 份互不相干的摘要；
 * - 时间戳统一映射回「第 N 集 mm:ss」，用户在 Markdown 里能看懂。
 *
 * 某几集没有字幕时不会让整个任务失败，而是跳过并在 warnings 里说明。
 */
import { BilibiliClient } from '../bilibili/client.js';
import { createProvider } from '../providers/index.js';
import { renderCollectionMarkdown } from '../output/markdown.js';
import { JobError, fetchTranscript } from './job.js';
import { summarize } from './summarize.js';
import type {
  AppConfig,
  CollectionJobRequest,
  CollectionResultEpisode,
  CollectionResultInfo,
  JobProgress,
  JobResult,
  LlmProvider,
  Transcript,
  TranscriptSegment,
  VideoInfo,
} from '../types.js';

export interface RunCollectionOptions {
  request: CollectionJobRequest;
  config: AppConfig;
  jobId?: string;
  client?: BilibiliClient;
  signal?: AbortSignal;
  onProgress?: (progress: JobProgress) => void;
  /** 覆盖默认供应商（测试用） */
  provider?: LlmProvider;
}

/** 合并时间轴上，每集之间留的间隔（秒）。 */
const EPISODE_GAP = 1;

interface EpisodeTranscript {
  bvid: string;
  title: string;
  url: string;
  duration: number;
  video: VideoInfo;
  transcript: Transcript;
}

export async function runCollectionJob(opts: RunCollectionOptions): Promise<JobResult> {
  const { request, config, signal } = opts;
  const jobId = opts.jobId ?? `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const report = (
    stage: JobProgress['stage'],
    message: string,
    percent: number,
    detail?: string,
  ) => {
    opts.onProgress?.({ jobId, stage, message, percent, detail });
  };

  const targets = request.episodes.filter((ep) => ep?.url);
  if (!targets.length) throw new JobError('没有勾选任何视频');

  const client = opts.client ?? new BilibiliClient({ cookie: config.cookie });
  const providerKind = request.provider ?? config.llmProvider;

  if (providerKind === 'bilibili') {
    throw new JobError(
      '「B站官方 AI 总结」不支持合集合并生成。',
      '合并模式需要能处理长文本的模型，请在顶部把「模型」改成 OpenAI 兼容接口或 Ollama；' +
        '想用官方总结的话，改用「每个视频单独生成」。',
    );
  }

  try {
    const provider = opts.provider ?? createProvider(providerKind, config, client);
    const warnings: string[] = [];
    const total = targets.length;

    // --- 1. 逐集取字幕 ---
    report('fetching-subtitle', `正在处理 ${total} 集`, 4);
    const collected: (EpisodeTranscript | null)[] = new Array(total).fill(null);

    let done = 0;
    await mapPool(targets, 2, async (target, index) => {
      if (signal?.aborted) return;
      const label = target.title ? `第 ${index + 1} 集《${target.title}》` : `第 ${index + 1} 集`;
      report(
        'fetching-subtitle',
        `正在获取字幕 ${done + 1}/${total}`,
        5 + Math.round((done / total) * 48),
        label,
      );

      try {
        const { bvid, aid, page } = await client.resolve(target.url);
        const video = await client.getVideoInfo(bvid);

        let cid = video.cid;
        if (page && page > 1) {
          const part = video.parts.find((p) => p.page === page);
          if (part) cid = part.cid;
        }

        const transcript = await fetchTranscript({
          client,
          config,
          source: request.source,
          bvid,
          cid,
          aid: aid || video.aid,
          video,
          report: () => undefined, // 单集进度不往外抛，避免总进度乱跳
          signal,
        });

        if (!transcript.segments.length) {
          warnings.push(`第 ${index + 1} 集《${video.title}》没有可用字幕，已跳过`);
          return;
        }

        collected[index] = {
          bvid,
          title: video.title,
          url: video.url,
          duration: video.duration || transcript.segments[transcript.segments.length - 1]!.end,
          video,
          transcript,
        };
      } catch (err) {
        if (signal?.aborted) throw err;
        warnings.push(`第 ${index + 1} 集处理失败，已跳过：${(err as Error).message}`);
      } finally {
        done += 1;
        report(
          'fetching-subtitle',
          `已获取 ${done}/${total} 集字幕`,
          5 + Math.round((done / total) * 48),
        );
      }
    });

    if (signal?.aborted) throw new JobError('任务已取消');

    const episodes = collected.filter((item): item is EpisodeTranscript => item !== null);
    if (!episodes.length) {
      throw new JobError(
        '勾选的视频都没有取到字幕。',
        '可以试试在「设置 → 语音识别」装好本地 whisper 后重试，或改用「每个视频单独生成」逐集处理。',
      );
    }

    // --- 2. 拼接成一条时间轴 ---
    report('summarizing', `正在拼接 ${episodes.length} 集字幕`, 55);
    const { merged, timeline } = mergeTimeline(episodes);

    const collectionInfo: CollectionResultInfo = {
      id: request.collectionId ?? 0,
      title: request.title,
      total: request.total ?? episodes.length,
      covered: episodes.length,
      episodes: timeline,
    };

    const mergedVideo: VideoInfo = {
      ...episodes[0]!.video,
      title: `合集《${request.title}》`,
      desc: buildDescription(request.title, episodes),
      duration: timeline[timeline.length - 1]!.end,
      parts: [],
      collection: null,
    };

    // --- 3. 统一摘要 ---
    const summary = await summarize({
      provider,
      video: mergedVideo,
      transcript: merged,
      config,
      danmaku: [],
      signal,
      collection: {
        title: request.title,
        total: collectionInfo.total,
        covered: collectionInfo.covered,
      },
      onProgress: (info) => {
        // summarize 内部是 45-100 的百分比，映射到本任务的 58-94
        const mapped = 58 + Math.round(((info.percent - 45) / 55) * 36);
        report('summarizing', info.message, Math.min(94, Math.max(58, mapped)), info.detail);
      },
    });

    if (warnings.length) {
      summary.warnings = [...(summary.warnings ?? []), ...warnings];
    }

    // --- 4. 渲染 ---
    report('rendering', '正在生成 Markdown', 96);
    const markdown = renderCollectionMarkdown({
      collection: collectionInfo,
      summary,
      transcript: merged,
      includeTranscript: config.exportTranscript,
    });
    report('done', '完成', 100);

    return {
      jobId,
      summary,
      transcript: merged,
      video: mergedVideo,
      danmaku: [],
      markdown,
      collection: collectionInfo,
    };
  } catch (err) {
    if (signal?.aborted) {
      report('cancelled', '任务已取消', 0);
      throw err;
    }
    report('error', (err as Error).message, 0);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 时间轴拼接                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把各集字幕首尾相接，并在每集开头插一条分界标记。
 *
 * 分界标记本身也是一条「字幕」，模型因此能知道集与集的边界；
 * 同时记录每集的 [start, end) 区间，便于把时间戳还原成「第 N 集 mm:ss」。
 */
export function mergeTimeline(episodes: EpisodeTranscript[]): {
  merged: Transcript;
  timeline: CollectionResultEpisode[];
} {
  const segments: TranscriptSegment[] = [];
  const timeline: CollectionResultEpisode[] = [];
  let cursor = 0;

  const sources = new Set(episodes.map((ep) => ep.transcript.source));

  episodes.forEach((episode, i) => {
    const start = cursor;
    const index = i + 1;

    segments.push({
      start,
      end: start + EPISODE_GAP,
      text: `—— 第 ${index} 集：${episode.title} ——`,
    });
    cursor += EPISODE_GAP;

    for (const seg of episode.transcript.segments) {
      segments.push({
        start: cursor + Math.max(0, seg.start),
        end: cursor + Math.max(seg.start, seg.end),
        text: seg.text,
      });
    }

    const span =
      episode.duration ||
      episode.transcript.segments[episode.transcript.segments.length - 1]?.end ||
      0;
    cursor += Math.max(1, span);

    timeline.push({
      bvid: episode.bvid,
      title: episode.title,
      duration: Math.max(1, span),
      url: episode.url,
      index,
      start,
      end: cursor,
      transcriptSource: episode.transcript.source,
      segmentCount: episode.transcript.segments.length,
    });
  });

  const merged: Transcript = {
    // 只要有一集是 ASR 就标成 ASR，避免谎报「全是官方字幕」
    source: sources.size === 1 ? [...sources][0]! : 'subtitle',
    segments,
  };

  return { merged, timeline };
}

function buildDescription(title: string, episodes: EpisodeTranscript[]): string {
  const lines = [`合集《${title}》本次合并 ${episodes.length} 集：`];
  episodes.slice(0, 60).forEach((ep, i) => {
    lines.push(`${i + 1}. ${ep.title}`);
  });
  if (episodes.length > 60) lines.push(`…等 ${episodes.length} 集`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 限并发且保持顺序地执行。 */
async function mapPool<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const size = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) continue;
        await worker(item, index);
      }
    }),
  );
}
