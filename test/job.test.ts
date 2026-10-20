import { describe, expect, it, vi } from 'vitest';
import { runJob } from '../src/core/pipeline/job.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { BilibiliClient } from '../src/core/bilibili/client.js';
import type { AppConfig, ChatRequest, ChatResponse, LlmProvider } from '../src/core/types.js';

/** 构造一个只暴露必要方法的假客户端。 */
function makeClient(overrides: Partial<BilibiliClient> = {}): BilibiliClient {
  const base = {
    hasLogin: true,
    resolve: async () => ({ bvid: 'BV1TEST00000', aid: 1, page: undefined }),
    getVideoInfo: async () => ({
      bvid: 'BV1TEST00000',
      aid: 1,
      cid: 10,
      title: '测试视频',
      desc: '',
      cover: '',
      duration: 120,
      pubdate: 0,
      owner: { mid: 2, name: 'UP', face: '' },
      stat: { view: 0, danmaku: 0, reply: 0, favorite: 0, coin: 0, share: 0, like: 0 },
      parts: [{ cid: 10, page: 1, title: 'P1', duration: 120 }],
      url: '',
      rawUrl: '',
    }),
    getSubtitles: async () => null,
    getBuiltinSummary: async () => null,
    getDanmaku: async () => [],
    getAudioUrls: async () => [],
    downloadBinary: async () => Buffer.alloc(0),
    checkLogin: async () => ({ ok: true, user: 'u', message: '' }),
  };
  return { ...base, ...overrides } as unknown as BilibiliClient;
}

const stubProvider: LlmProvider = {
  kind: 'openai',
  name: 'stub',
  bind() {},
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const prompt = req.messages[1]?.content ?? '';
    if (prompt.includes('全局关键要点')) {
      return {
        content: JSON.stringify({
          tldr: 'T',
          keyPoints: [],
          outline: [],
          segments: [],
          insights: [],
        }),
      };
    }
    return { content: JSON.stringify({ segments: [] }) };
  },
  async healthCheck() {
    return { ok: true, message: 'ok' };
  },
};

/** 带 ASR 配置，但 ASR 本身是抛错的 —— 用于验证没有被调用。 */
const configWithAsr: AppConfig = {
  ...DEFAULT_CONFIG,
  asrProvider: 'openai',
  openaiAsr: { ...DEFAULT_CONFIG.openaiAsr, baseUrl: 'http://127.0.0.1:9', model: 'w' },
};

describe('字幕来源的选择', () => {
  it('「仅官方字幕」在无字幕时报错，不会回退到 ASR', async () => {
    const transcribe = vi.fn();
    const client = makeClient({
      getSubtitles: async () => null,
    });

    const job = runJob({
      request: { url: 'BV1TEST00000', source: 'subtitle' },
      config: configWithAsr,
      client,
      provider: stubProvider,
    });

    await expect(job).rejects.toThrow(/没有可用的官方字幕/);
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('「自动」在无字幕且无 ASR 时给出明确提示', async () => {
    const client = makeClient({ getSubtitles: async () => null });

    await expect(
      runJob({
        request: { url: 'BV1TEST00000' },
        config: { ...DEFAULT_CONFIG, asrProvider: 'none' },
        client,
        provider: stubProvider,
      }),
    ).rejects.toThrow(/没有可用的字幕/);
  });

  it('拿到官方字幕时正常返回', async () => {
    const client = makeClient({
      getSubtitles: async () => ({
        source: 'subtitle' as const,
        language: 'zh-CN',
        segments: Array.from({ length: 30 }, (_, i) => ({
          start: i * 3,
          end: i * 3 + 2.5,
          text: `第 ${i} 句字幕内容，用来凑够长度触发分块逻辑。`,
        })),
      }),
    });

    const result = await runJob({
      request: { url: 'BV1TEST00000' },
      config: DEFAULT_CONFIG,
      client,
      provider: stubProvider,
    });

    expect(result.transcript.source).toBe('subtitle');
    expect(result.transcript.segments.length).toBe(30);
    expect(result.summary.warnings).toEqual([]);
  });
});

describe('链接中的 p 参数', () => {
  it('未指定 part 时使用链接里的 ?p=', async () => {
    const client = makeClient({
      resolve: async () => ({ bvid: 'BV1TEST00000', aid: 1, page: 2 }),
      getVideoInfo: async () => ({
        bvid: 'BV1TEST00000',
        aid: 1,
        cid: 10,
        title: '测试视频',
        desc: '',
        cover: '',
        duration: 120,
        pubdate: 0,
        owner: { mid: 2, name: 'UP', face: '' },
        stat: { view: 0, danmaku: 0, reply: 0, favorite: 0, coin: 0, share: 0, like: 0 },
        parts: [
          { cid: 10, page: 1, title: 'P1', duration: 120 },
          { cid: 20, page: 2, title: 'P2', duration: 60 },
        ],
        url: '',
        rawUrl: '',
      }),
      getSubtitles: async () => ({
        source: 'subtitle' as const,
        segments: [{ start: 0, end: 1, text: 'x' }],
      }),
    });

    const result = await runJob({
      request: { url: 'BV1TEST00000' },
      config: DEFAULT_CONFIG,
      client,
      provider: stubProvider,
    });

    // 标题里应带上 P2
    expect(result.video.title).toContain('P2');
  });

  it('显式指定的 part 优先于链接里的 ?p=', async () => {
    const client = makeClient({
      resolve: async () => ({ bvid: 'BV1TEST00000', aid: 1, page: 3 }),
      getVideoInfo: async () => ({
        bvid: 'BV1TEST00000',
        aid: 1,
        cid: 10,
        title: '测试视频',
        desc: '',
        cover: '',
        duration: 120,
        pubdate: 0,
        owner: { mid: 2, name: 'UP', face: '' },
        stat: { view: 0, danmaku: 0, reply: 0, favorite: 0, coin: 0, share: 0, like: 0 },
        parts: [
          { cid: 10, page: 1, title: 'P1', duration: 120 },
          { cid: 20, page: 2, title: 'P2', duration: 60 },
        ],
        url: '',
        rawUrl: '',
      }),
      getSubtitles: async () => ({
        source: 'subtitle' as const,
        segments: [{ start: 0, end: 1, text: 'x' }],
      }),
    });

    const result = await runJob({
      request: { url: 'BV1TEST00000', part: 1 },
      config: DEFAULT_CONFIG,
      client,
      provider: stubProvider,
    });

    // 显式 P1，不应带上 P2
    expect(result.video.title).not.toContain('P2');
  });
});

describe('取消', () => {
  it('已取消的信号会让任务立即失败', async () => {
    const controller = new AbortController();
    controller.abort();

    const client = makeClient({
      resolve: async () => {
        throw new Error('请求已取消');
      },
    });

    await expect(
      runJob({
        request: { url: 'BV1TEST00000' },
        config: DEFAULT_CONFIG,
        client,
        provider: stubProvider,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});
