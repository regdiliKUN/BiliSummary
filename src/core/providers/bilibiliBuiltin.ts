/**
 * B 站官方 AI 总结供应商。
 *
 * 与通用 LLM 不同：它不是对话式接口，而是直接返回 B 站为该视频生成的
 * 结论（summary + 带时间戳的 outline）。这里把它包装成与其它供应商
 * 相同的接口，从而让上层流程无需区分实现。
 */
import { BilibiliClient } from '../bilibili/client.js';
import type {
  AppConfig,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  ProviderContext,
  SummarySegment,
  VideoSummary,
} from '../types.js';
import { splitSentences } from '../utils/text.js';

/** 可直接产出完整摘要的供应商（无需分块调用 LLM）。 */
export interface DirectSummaryProvider extends LlmProvider {
  fetchConclusion(): Promise<VideoSummary | null>;
}

export class BilibiliBuiltinProvider implements DirectSummaryProvider {
  readonly kind = 'bilibili' as const;
  readonly name = 'B站官方AI总结';

  private readonly client: BilibiliClient;
  private readonly cfg: AppConfig['bilibili'];
  private ctx: ProviderContext = {};

  constructor(client: BilibiliClient, cfg: AppConfig['bilibili'] = { useOutlineAsTitles: true }) {
    this.client = client;
    this.cfg = cfg;
  }

  bind(ctx: ProviderContext): void {
    this.ctx = { ...this.ctx, ...ctx };
  }

  /** 直接拉取官方结论并组装成标准摘要结构。 */
  async fetchConclusion(): Promise<VideoSummary | null> {
    const { bvid, cid, upMid } = this.ctx;
    if (!bvid || !cid) {
      throw new Error('未绑定视频信息，无法获取官方总结');
    }

    const conclusion = await this.client.getBuiltinSummary(bvid, cid, upMid ?? 0);
    if (!conclusion) return null;

    const keyPoints = splitSentences(conclusion.summary).slice(0, 10);

    const segments: SummarySegment[] = conclusion.outline.map((item, i) => {
      const next = conclusion.outline[i + 1];
      const end = item.end > 0 ? item.end : next?.start ?? this.ctx.videoDuration ?? item.start;
      return {
        start: item.start,
        end: Math.max(end, item.start),
        title: item.title,
        points: [],
        // 官方结论只给标题，正文统一放在 summary 里
        summary: this.cfg.useOutlineAsTitles ? '' : item.title,
      };
    });

    return {
      tldr: conclusion.summary,
      keyPoints,
      segments,
      outline: conclusion.outline.map((o) => ({ start: o.start, title: o.title })),
      insights: [],
      warnings: [],
      model: 'B站官方AI总结',
      provider: 'bilibili',
      transcriptSource: 'bilibili-ai',
      createdAt: new Date().toISOString(),
    };
  }

  /** 与 LLM 供应商保持接口一致：把官方结论渲染成 JSON 文本。 */
  async chat(_req: ChatRequest): Promise<ChatResponse> {
    const summary = await this.fetchConclusion();
    if (!summary) {
      return { content: JSON.stringify({ tldr: '', keyPoints: [], segments: [], insights: [] }) };
    }
    return { content: JSON.stringify(summary), model: 'B站官方AI总结' };
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    const { bvid, cid } = this.ctx;
    if (!bvid || !cid) {
      return { ok: true, message: 'B站官方总结可用（需在生成时检查该视频是否支持）' };
    }
    try {
      const conclusion = await this.client.getBuiltinSummary(bvid, cid, this.ctx.upMid ?? 0);
      if (!conclusion) {
        return { ok: false, message: '该视频没有官方 AI 总结' };
      }
      return {
        ok: true,
        message: `官方总结可用，共 ${conclusion.outline.length} 个章节`,
      };
    } catch (err) {
      return { ok: false, message: `获取失败：${(err as Error).message}` };
    }
  }
}
