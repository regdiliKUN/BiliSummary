/**
 * 完整任务流程：解析 -> 拉信息 -> 取字幕 -> 摘要 -> 渲染。
 *
 * 保持与 Electron 无关，便于单独测试或在 CLI 中复用。
 */
import { BilibiliClient } from '../bilibili/client.js';
import { createAsrProvider, prepareAudio, resolveFfmpegPath } from '../asr/index.js';
import { createProvider } from '../providers/index.js';
import { renderMarkdown, renderSrt, renderTranscriptMarkdown } from '../output/markdown.js';
import type {
  AppConfig,
  DanmakuItem,
  JobProgress,
  JobRequest,
  JobResult,
  LlmProvider,
  Transcript,
  VideoInfo,
} from '../types.js';
import { summarize } from './summarize.js';

export class JobError extends Error {
  constructor(message: string, readonly hint?: string) {
    super(message);
    this.name = 'JobError';
  }
}

export interface RunJobOptions {
  request: JobRequest;
  config: AppConfig;
  onProgress?: (progress: JobProgress) => void;
  signal?: AbortSignal;
  /** 已创建好的客户端（便于注入 Cookie 变化） */
  client?: BilibiliClient;
  /** 覆盖默认供应商（测试 / 演练用） */
  provider?: LlmProvider;
  /** 直接指定字幕，跳过抓取（测试 / 演练用） */
  transcript?: Transcript;
  /** 复用外部的 jobId，保证进度事件与调用方一致 */
  jobId?: string;
}

/** 执行一次完整的总结任务。 */
export async function runJob(opts: RunJobOptions): Promise<JobResult> {
  const { request, config, onProgress, signal } = opts;

  const jobId = opts.jobId ?? `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const report = (stage: JobProgress['stage'], message: string, percent: number, detail?: string) => {
    onProgress?.({ jobId, stage, message, percent, detail });
  };

  const client = opts.client ?? new BilibiliClient({ cookie: config.cookie });
  const providerKind = request.provider ?? config.llmProvider;

  try {
    report('fetching-info', '正在解析视频链接', 5);

    // --- 1. 视频信息 ---
    const { bvid, aid, page: urlPage } = await client.resolve(request.url);
    const video: VideoInfo = await client.getVideoInfo(bvid);

    // 选择分P：显式指定的优先，其次是链接里的 ?p=，最后是 P1
    const targetPart = request.part ?? urlPage ?? 1;
    let cid = video.cid;
    if (targetPart > 1) {
      const part = video.parts.find((p) => p.page === targetPart);
      if (!part) throw new JobError(`该视频没有 P${targetPart}`);
      cid = part.cid;
      video.cid = part.cid;
      video.duration = part.duration || video.duration;
      video.title = `${video.title} - P${part.page} ${part.title}`;
    } else if (targetPart === 1 && video.parts.length > 1) {
      const part = video.parts[0];
      if (part) {
        cid = part.cid;
        video.cid = part.cid;
      }
    }

    report('fetching-info', `已获取视频信息：${video.title}`, 15);

    // --- 2. 字幕 / 转写 ---
    const provider = opts.provider ?? createProvider(providerKind, config, client);
    provider.bind?.({
      bvid,
      cid,
      aid,
      upMid: video.owner.mid,
      videoTitle: video.title,
      videoDuration: video.duration,
    });

    // B 站官方总结不需要字幕，直接走结论接口，避免因无字幕而中断
    const usesBuiltinSummary = provider.kind === 'bilibili';
    const transcript: Transcript = usesBuiltinSummary
      ? { source: 'bilibili-ai', segments: [] }
      : (opts.transcript ??
        (await acquireTranscript({
          client,
          config,
          request,
          bvid,
          cid,
          aid,
          video,
          report,
          signal,
        })));

    if (!usesBuiltinSummary) {
      report('fetching-subtitle', '字幕获取完成', 45);
    }

    // --- 3. 摘要 ---
    const summary = await summarize({
      provider,
      video,
      transcript,
      config,
      signal,
      onProgress: (info) => {
        report('summarizing', info.message, info.percent, info.detail);
      },
    });

    // --- 4. 弹幕（只用于输出，放在摘要之后以保证进度单调递增）---
    let danmaku: DanmakuItem[] = [];
    if (config.useDanmaku && config.danmakuLimit > 0) {
      report('fetching-danmaku', '正在抓取弹幕', 92);
      try {
        danmaku = await client.getDanmaku(cid, config.danmakuLimit);
      } catch (err) {
        console.warn('弹幕抓取失败，忽略：', (err as Error).message);
        danmaku = [];
      }
    }

    // --- 5. 渲染 ---
    report('rendering', '正在生成 Markdown', 95);
    const markdown = renderMarkdown({
      video,
      summary,
      transcript,
      danmaku,
      includeTranscript: config.exportTranscript,
    });
    report('done', '完成', 100);

    return { jobId, summary, transcript, video, danmaku, markdown };
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
/* 字幕获取：官方字幕 -> ASR -> B站官方总结                              */
/* ------------------------------------------------------------------ */

async function acquireTranscript(params: {
  client: BilibiliClient;
  config: AppConfig;
  request: JobRequest;
  bvid: string;
  cid: number;
  aid: number;
  video: VideoInfo;
  report: (stage: JobProgress['stage'], message: string, percent: number, detail?: string) => void;
  signal?: AbortSignal;
}): Promise<Transcript> {
  const { client, config, request, bvid, cid, aid, video, report, signal } = params;

  const forceSource = request.source;

  // 用户强制使用 ASR
  if (forceSource === 'asr') {
    return transcribeAudio(params);
  }

  // 用户强制使用 B 站官方总结 -> 用官方字幕兜底
  if (forceSource === 'bilibili-ai') {
    const conclusion = await client.getBuiltinSummary(bvid, cid, video.owner.mid, signal);
    if (conclusion) {
      return {
        source: 'bilibili-ai',
        segments: conclusion.outline.map((o) => ({
          start: o.start,
          end: o.end,
          text: o.title,
        })),
      };
    }
  }

  // 优先官方字幕
  {
    report('fetching-subtitle', '正在获取官方字幕', 20);
    try {
      const subtitle = await client.getSubtitles(bvid, cid, aid, signal);
      if (subtitle?.segments.length) {
        return subtitle;
      }
    } catch (err) {
      if (signal?.aborted) throw err;
      console.warn('官方字幕获取失败：', (err as Error).message);
    }

    if (!client.hasLogin) {
      report('fetching-subtitle', '未登录，无法获取官方字幕', 20);
    } else {
      report('fetching-subtitle', '该视频没有官方字幕', 20);
    }
  }

  // 用户明确选择了「仅官方字幕」，到此为止，不再回退到 ASR
  if (forceSource === 'subtitle') {
    throw new JobError(
      '该视频没有可用的官方字幕。',
      '若该视频确实没有字幕，可以在「摘要来源」里改选「语音识别」自动转写。',
    );
  }

  // 回退：ASR
  if (config.asrProvider !== 'none') {
    return transcribeAudio(params);
  }

  throw new JobError(
    '没有可用的字幕，且未配置语音识别（ASR）作为备选方案。',
    '请在「设置」中登录 B 站以获取官方字幕，或配置 ASR（OpenAI 兼容接口 / whisper.cpp）。',
  );
}

/** 下载音频并转写。 */
async function transcribeAudio(params: {
  client: BilibiliClient;
  config: AppConfig;
  bvid: string;
  cid: number;
  aid: number;
  report: (stage: JobProgress['stage'], message: string, percent: number, detail?: string) => void;
  signal?: AbortSignal;
}): Promise<Transcript> {
  const { client, config, bvid, cid, aid, report, signal } = params;

  const asr = createAsrProvider(config.asrProvider, config);
  if (!asr) {
    throw new JobError('未配置语音识别（ASR）服务。');
  }

  report('downloading-audio', '正在下载音频', 25);
  const ffmpegPath = await resolveFfmpegPath(config.whisperCpp.ffmpegPath);
  const workspace = await prepareAudio(client, bvid, cid, aid, ffmpegPath, signal);

  try {
    report('transcribing', `正在转写音频（${asr.name}）`, 32);
    const result = await asr.transcribe(workspace.wavPath, { signal });
    if (!result.segments.length) {
      throw new JobError('语音识别没有产出任何内容。');
    }
    return {
      source: 'asr',
      language: result.language,
      model: result.model,
      segments: result.segments,
    };
  } finally {
    await workspace.cleanup();
  }
}

export { renderMarkdown, renderSrt, renderTranscriptMarkdown };
