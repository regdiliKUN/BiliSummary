/**
 * 端到端流程测试：用假的模型供应商驱动完整摘要管线。
 */
import { describe, expect, it, vi } from 'vitest';
import { summarize } from '../src/core/pipeline/summarize.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type {
  AppConfig,
  ChatRequest,
  ChatResponse,
  LlmProvider,
  Transcript,
  VideoInfo,
} from '../src/core/types.js';

const video: VideoInfo = {
  bvid: 'BV1TEST00000',
  aid: 1,
  cid: 2,
  title: '测试视频',
  desc: '',
  cover: '',
  duration: 600,
  pubdate: 0,
  owner: { mid: 1, name: 'UP', face: '' },
  stat: { view: 0, danmaku: 0, reply: 0, favorite: 0, coin: 0, share: 0, like: 0 },
  parts: [{ cid: 2, page: 1, title: 'P1', duration: 600 }],
  url: 'https://www.bilibili.com/video/BV1TEST00000',
  rawUrl: '',
};

const transcript: Transcript = {
  source: 'subtitle',
  language: 'zh-CN',
  segments: Array.from({ length: 60 }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 9,
    text: `这是第 ${i} 段字幕，讲述了一些内容。`,
  })),
};

/** 记录调用次数，按调用顺序返回不同的 JSON。 */
function makeProvider(handler: (req: ChatRequest, callIndex: number) => string) {
  const calls: ChatRequest[] = [];
  const provider: LlmProvider = {
    kind: 'openai',
    name: 'mock',
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const index = calls.length;
      calls.push(req);
      return { content: handler(req, index) };
    },
    async healthCheck() {
      return { ok: true, message: 'mock' };
    },
  };
  return { provider, calls };
}

const config: AppConfig = { ...DEFAULT_CONFIG, openai: { ...DEFAULT_CONFIG.openai, contextChars: 3000 } };

describe('摘要管线', () => {
  it('分块 -> 逐块摘要 -> 合并，产出完整结构', async () => {
    const { provider, calls } = makeProvider((req) => {
      // 合并阶段的提示词里含「全局关键要点」
      const isMerge = req.messages[1]?.content.includes('全局关键要点') ?? false;
      if (isMerge) {
        return JSON.stringify({
          tldr: '整体总结',
          keyPoints: ['要点一', '要点二'],
          outline: [{ start: 0, title: '开篇' }],
          segments: [{ start: 0, end: 100, title: '开篇', points: ['要点'], summary: '概述' }],
          insights: ['洞见一'],
        });
      }
      return JSON.stringify({
        segments: [{ start: 0, end: 100, title: '段落', points: ['要点'], summary: '概述' }],
      });
    });

    const summary = await summarize({ provider, video, transcript, config });

    expect(summary.tldr).toBe('整体总结');
    expect(summary.keyPoints).toEqual(['要点一', '要点二']);
    expect(summary.segments.length).toBeGreaterThan(0);
    expect(summary.segments[0]!.title).toBe('开篇');
    expect(summary.insights).toEqual(['洞见一']);
    expect(summary.model).toBe(config.openai.model);
    expect(summary.provider).toBe('openai');
    expect(summary.transcriptSource).toBe('subtitle');
    // 分块调用 + 1 次合并
    expect(calls.length).toBeGreaterThan(1);
  });

  it('模型返回非法 JSON 时尝试修复一次', async () => {
    let attempt = 0;
    const { provider, calls } = makeProvider(() => {
      attempt++;
      if (attempt === 1) return '这不是 JSON';
      return JSON.stringify({
        segments: [{ start: 0, end: 50, title: '修复后', points: [], summary: '好了' }],
      });
    });

    const summary = await summarize({ provider, video, transcript, config });
    expect(calls.length).toBeGreaterThan(1);
    expect(summary.segments[0]!.title).toBe('修复后');
  });

  it('合并失败时降级为拼接各块摘要', async () => {
    let call = 0;
    const provider: LlmProvider = {
      kind: 'openai',
      name: 'mock',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        call++;
        // 分块阶段正常返回，合并阶段（最后一个 prompt 含「请输出如下 JSON」）抛错
        if (req.messages[1]?.content.includes('请输出如下 JSON 结构') &&
            req.messages[1].content.includes('全局关键要点')) {
          throw new Error('模拟合并失败');
        }
        return {
          content: JSON.stringify({
            segments: [{ start: 0, end: 100, title: `块${call}`, points: ['p'], summary: 's' }],
          }),
        };
      },
      async healthCheck() {
        return { ok: true, message: 'mock' };
      },
    };

    const summary = await summarize({ provider, video, transcript, config });
    expect(summary.segments.length).toBeGreaterThan(0);
    expect(summary.tldr.length).toBeGreaterThan(0);
  });

  it('没有字幕时抛出明确错误', async () => {
    const { provider } = makeProvider(() => '{}');
    await expect(
      summarize({ provider, video, transcript: { source: 'none', segments: [] }, config }),
    ).rejects.toThrow(/字幕/);
  });

  it('单块失败不会让整个任务失败', async () => {
    // 更小的预算 => 切成多块，才能验证「部分失败」
    const multiConfig: AppConfig = {
      ...config,
      openai: { ...config.openai, contextChars: 800 },
    };

    let call = 0;
    const provider: LlmProvider = {
      kind: 'openai',
      name: 'mock',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        call++;
        const prompt = req.messages[1]?.content ?? '';
        if (prompt.includes('全局关键要点')) {
          return {
            content: JSON.stringify({
              tldr: 'T',
              keyPoints: ['k'],
              outline: [],
              segments: [{ start: 0, end: 10, title: 'A', points: [], summary: 's' }],
              insights: [],
            }),
          };
        }
        // 第一块报错，其余正常
        if (call === 1) throw new Error('模拟单块失败');
        return {
          content: JSON.stringify({
            segments: [{ start: 0, end: 10, title: 'ok', points: [], summary: 's' }],
          }),
        };
      },
      async healthCheck() {
        return { ok: true, message: 'mock' };
      },
    };

    const summary = await summarize({ provider, video, transcript, config: multiConfig });
    expect(summary.tldr).toBe('T');
    expect(summary.segments.length).toBeGreaterThan(0);
  });

  it('所有分块都失败时抛出错误', async () => {
    const provider: LlmProvider = {
      kind: 'openai',
      name: 'mock',
      async chat(): Promise<ChatResponse> {
        throw new Error('全部失败');
      },
      async healthCheck() {
        return { ok: true, message: 'mock' };
      },
    };

    await expect(summarize({ provider, video, transcript, config })).rejects.toThrow(/全部失败/);
  });

  it('B站官方供应商走直连路径', async () => {
    const provider = {
      kind: 'bilibili' as const,
      name: 'B站官方AI总结',
      bind() {},
      async chat(): Promise<ChatResponse> {
        return { content: '{}' };
      },
      async healthCheck() {
        return { ok: true, message: 'ok' };
      },
      async fetchConclusion() {
        return {
          tldr: '官方总结',
          keyPoints: ['要点'],
          segments: [{ start: 0, end: 60, title: '章节', points: [], summary: '' }],
          outline: [{ start: 0, title: '章节' }],
          insights: [],
          model: 'B站官方AI总结',
          provider: 'bilibili',
          transcriptSource: 'bilibili-ai' as const,
          createdAt: new Date().toISOString(),
        };
      },
    };

    const summary = await summarize({ provider, video, transcript, config });
    expect(summary.tldr).toBe('官方总结');
    expect(summary.transcriptSource).toBe('bilibili-ai');
  });

  it('进度回调按阶段上报', async () => {
    const { provider } = makeProvider((_req, i) =>
      i === 0
        ? JSON.stringify({ segments: [{ start: 0, end: 10, title: 'A', points: [], summary: 'b' }] })
        : JSON.stringify({ tldr: 'T', keyPoints: [], outline: [], segments: [], insights: [] }),
    );

    const onProgress = vi.fn();
    await summarize({ provider, video, transcript, config, onProgress });
    expect(onProgress).toHaveBeenCalled();
    const percents = onProgress.mock.calls.map((c: any) => c[0].percent);
    expect(Math.max(...percents)).toBeGreaterThanOrEqual(88);
  });
});
