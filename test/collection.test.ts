/** 合集：接口解析、时间轴拼接、时间戳还原、Markdown 渲染。 */
import { describe, expect, it } from 'vitest';

import { BilibiliClient } from '../src/core/bilibili/client.js';
import { mergeTimeline } from '../src/core/pipeline/collection.js';
import { renderCollectionMarkdown } from '../src/core/output/markdown.js';
import { formatCollectionTimestamp, locateCollectionTime } from '../src/core/utils/collection.js';
import type {
  CollectionResultInfo,
  Transcript,
  VideoInfo,
  VideoSummary,
} from '../src/core/types.js';

/* ------------------------------------------------------------------ */
/* 假响应                                                              */
/* ------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    url: '',
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function makeClient(viewData: unknown) {
  const calls: string[] = [];
  const client = new BilibiliClient({
    fetchImpl: (async (url: string) => {
      calls.push(url);
      if (url.includes('/x/frontend/finger/spi')) {
        return jsonResponse({ code: 0, data: { b_3: 'buvid3-x', b_4: 'buvid4-y' } });
      }
      if (url.includes('/x/web-interface/view')) {
        return jsonResponse({ code: 0, data: viewData });
      }
      throw new Error(`未预期的请求：${url}`);
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

const baseView = {
  bvid: 'BV1TEST00001',
  aid: 111,
  cid: 222,
  title: '第一集',
  desc: '',
  pic: 'http://i0.hdslb.com/a.jpg',
  duration: 600,
  pubdate: 1700000000,
  owner: { mid: 946974, name: '测试UP', face: '' },
  stat: { view: 100, danmaku: 1, reply: 1, favorite: 1, coin: 1, share: 1, like: 1 },
  pages: [{ cid: 222, page: 1, part: '正片', duration: 600 }],
  ugc_season: {
    id: 2046621,
    title: '样片日记',
    cover: 'http://i0.hdslb.com/cover.jpg',
    mid: 946974,
    intro: '合集简介',
    ep_count: 3,
    sections: [
      {
        id: 1,
        title: '正片',
        episodes: [
          {
            aid: 111,
            bvid: 'BV1TEST00001',
            cid: 222,
            title: '第一集',
            arc: {
              title: '第一集',
              duration: 600,
              pic: 'http://i0.hdslb.com/1.jpg',
              pubdate: 1700000000,
            },
          },
          {
            aid: 112,
            bvid: 'BV1TEST00002',
            cid: 223,
            title: '第二集',
            arc: {
              title: '第二集',
              duration: 700,
              pic: 'http://i0.hdslb.com/2.jpg',
              pubdate: 1700100000,
            },
          },
          {
            aid: 113,
            bvid: 'BV1TEST00003',
            cid: 224,
            title: '第三集',
            arc: {
              title: '第三集',
              duration: 800,
              pic: 'http://i0.hdslb.com/3.jpg',
              pubdate: 1700200000,
            },
          },
        ],
      },
    ],
  },
};

/* ------------------------------------------------------------------ */
/* 接口解析                                                            */
/* ------------------------------------------------------------------ */

describe('合集识别（getVideoInfo）', () => {
  it('解析 ugc_season 为合集结构', async () => {
    const { client } = makeClient(baseView);
    const info = await client.getVideoInfo('BV1TEST00001');

    expect(info.collection).toBeTruthy();
    const collection = info.collection!;
    expect(collection.id).toBe(2046621);
    expect(collection.title).toBe('样片日记');
    expect(collection.total).toBe(3);
    expect(collection.complete).toBe(true);
    expect(collection.episodes).toHaveLength(3);
    expect(collection.episodes[0]).toMatchObject({
      bvid: 'BV1TEST00001',
      index: 1,
      title: '第一集',
      duration: 600,
    });
    expect(collection.episodes[2]!.index).toBe(3);
    // 图片统一升级成 https，否则渲染层 CSP 会拦掉
    expect(collection.cover.startsWith('https://')).toBe(true);
    expect(collection.episodes[1]!.cover.startsWith('https://')).toBe(true);
  });

  it('没有 ugc_season 时 collection 为空', async () => {
    const { ugc_season: _drop, ...plain } = baseView;
    const { client } = makeClient(plain);
    const info = await client.getVideoInfo('BV1TEST00001');
    expect(info.collection).toBeNull();
  });

  it('合集只返回部分集数时会标记为不完整', async () => {
    const partial = {
      ...baseView,
      ugc_season: { ...baseView.ugc_season, ep_count: 26 },
    };
    const { client, calls } = makeClient(partial);
    const info = await client.getVideoInfo('BV1TEST00001');
    // 补齐请求会打 archives 接口，这里没有桩，捕获后静默失败
    expect(info.collection!.episodes.length).toBeLessThan(26);
    expect(info.collection!.complete).toBe(false);
    expect(calls.some((u) => u.includes('seasons_archives_list'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 时间轴                                                              */
/* ------------------------------------------------------------------ */

function makeTranscript(startAt: number, count: number): Transcript {
  return {
    source: 'subtitle',
    segments: Array.from({ length: count }, (_, i) => ({
      start: startAt + i * 10,
      end: startAt + i * 10 + 9,
      text: `第 ${i + 1} 句`,
    })),
  };
}

const fakeVideo = (bvid: string, title: string): VideoInfo => ({
  bvid,
  aid: 1,
  cid: 2,
  title,
  desc: '',
  cover: '',
  duration: 0,
  pubdate: 0,
  owner: { mid: 1, name: 'UP', face: '' },
  stat: { view: 0, danmaku: 0, reply: 0, favorite: 0, coin: 0, share: 0, like: 0 },
  parts: [],
  url: `https://www.bilibili.com/video/${bvid}`,
  rawUrl: '',
});

describe('mergeTimeline', () => {
  const episodes = [
    {
      bvid: 'BV1A',
      title: '第一集',
      url: 'u1',
      duration: 100,
      video: fakeVideo('BV1A', '第一集'),
      transcript: makeTranscript(0, 3),
    },
    {
      bvid: 'BV1B',
      title: '第二集',
      url: 'u2',
      duration: 200,
      video: fakeVideo('BV1B', '第二集'),
      transcript: makeTranscript(0, 2),
    },
  ];

  it('每集首尾相接，并插入分集标记', () => {
    const { merged, timeline } = mergeTimeline(episodes);

    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({ index: 1, start: 0, duration: 100, segmentCount: 3 });
    // 第一集 1s 标记 + 100s 内容 = 第二集从 101s 开始
    expect(timeline[1]!.start).toBe(101);

    const markers = merged.segments.filter((s) => s.text.startsWith('—— 第'));
    expect(markers.map((m) => m.text)).toEqual(['—— 第 1 集：第一集 ——', '—— 第 2 集：第二集 ——']);
  });

  it('字幕时间被平移到虚拟时间轴上', () => {
    const { merged, timeline } = mergeTimeline(episodes);
    const secondStart = timeline[1]!.start;
    // 第二集开头先放 1s 的分集标记，随后才是它自己的第一句
    const marker = merged.segments.find((s) => s.start === secondStart && s.text.includes('第 2 集'));
    expect(marker).toBeTruthy();
    const firstOfSecond = merged.segments.find(
      (s) => s.start === secondStart + 1 && s.text === '第 1 句',
    );
    expect(firstOfSecond).toBeTruthy();
  });

  it('时间戳单调递增', () => {
    const { merged } = mergeTimeline(episodes);
    for (let i = 1; i < merged.segments.length; i += 1) {
      expect(merged.segments[i]!.start).toBeGreaterThanOrEqual(merged.segments[i - 1]!.start);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 时间戳还原                                                          */
/* ------------------------------------------------------------------ */

describe('合集时间戳', () => {
  const timeline = [
    { bvid: 'A', title: '一', duration: 100, url: '', index: 1, start: 0, end: 100, transcriptSource: 'subtitle' as const, segmentCount: 3 },
    { bvid: 'B', title: '二', duration: 200, url: '', index: 2, start: 100, end: 300, transcriptSource: 'subtitle' as const, segmentCount: 3 },
  ];

  it('定位到具体某一集', () => {
    const hit = locateCollectionTime(timeline, 165);
    expect(hit?.episode.index).toBe(2);
    expect(hit?.localTime).toBe(65);
  });

  it('格式化成「第 N 集 mm:ss」', () => {
    expect(formatCollectionTimestamp(timeline, 0)).toBe('第1集 00:00');
    expect(formatCollectionTimestamp(timeline, 65)).toBe('第1集 01:05');
    expect(formatCollectionTimestamp(timeline, 165)).toBe('第2集 01:05');
    expect(formatCollectionTimestamp(timeline, 999)).toBe('第2集 03:20');
  });

  it('空时间轴退化成普通时间', () => {
    expect(formatCollectionTimestamp([], 75)).toBe('01:15');
  });
});

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

describe('renderCollectionMarkdown', () => {
  const collection: CollectionResultInfo = {
    id: 1,
    title: '样片日记',
    total: 26,
    covered: 2,
    episodes: [
      { bvid: 'BV1A', title: '第一集 | 竖线测试', duration: 600, url: 'https://x/1', index: 1, start: 0, end: 600, transcriptSource: 'subtitle', segmentCount: 10 },
      { bvid: 'BV1B', title: '第二集', duration: 700, url: 'https://x/2', index: 2, start: 600, end: 1300, transcriptSource: 'asr', segmentCount: 12 },
    ],
  };

  const summary: VideoSummary = {
    tldr: '整个合集讲了如何拍样片。',
    keyPoints: ['跨集要点一', '跨集要点二'],
    outline: [{ start: 0, title: '第一集开场' }, { start: 610, title: '第二集实操' }],
    segments: [
      { start: 0, end: 300, title: '第1集 · 开场', points: ['要点'], summary: '概述' },
      { start: 610, end: 900, title: '第2集 · 实操', points: [], summary: '概述二' },
    ],
    insights: ['洞察'],
    warnings: ['第 3 集没有字幕'],
    model: 'deepseek-chat',
    provider: 'openai',
    transcriptSource: 'subtitle',
    createdAt: new Date().toISOString(),
  };

  const md = renderCollectionMarkdown({ collection, summary });

  it('标题与元信息包含合集与覆盖集数', () => {
    expect(md).toContain('# 合集《样片日记》摘要');
    expect(md).toContain('本次覆盖 | 2 集（合集共 26 集）');
  });

  it('收录视频表格列出每一集并转义竖线', () => {
    expect(md).toContain('## 收录视频');
    expect(md).toContain('第一集 \\| 竖线测试');
    expect(md).toContain('https://x/2');
  });

  it('时间戳用「第 N 集 mm:ss」而不是虚拟轴秒数', () => {
    expect(md).toContain('`第1集 00:00`');
    expect(md).toContain('`第2集 00:10`');
  });

  it('标题里已经带了集号时不再重复', () => {
    // 分段标题是「第2集 · 实操」，时间戳只保留 mm:ss
    expect(md).toContain('### 00:10 - 05:00 · 第2集 · 实操');
  });

  it('warnings 会写进正文，不静默丢弃', () => {
    expect(md).toContain('第 3 集没有字幕');
  });
});

/* ------------------------------------------------------------------ */
/* 端到端：合并生成                                                     */
/* ------------------------------------------------------------------ */

import { runCollectionJob } from '../src/core/pipeline/collection.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { ChatRequest, ChatResponse, JobProgress, LlmProvider } from '../src/core/types.js';

function fakeProvider(): LlmProvider {
  return {
    kind: 'openai',
    name: 'fake',
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      return {
        content: JSON.stringify({
          tldr: '合集整体讲了拍样片的流程',
          keyPoints: ['跨集要点'],
          outline: [{ start: 0, title: '开场' }],
          segments: [
            { start: 0, end: 60, title: '第1集 · 开场', points: ['p1'], summary: 's1' },
            { start: 700, end: 800, title: '第2集 · 实操', points: ['p2'], summary: 's2' },
          ],
          insights: ['洞察'],
        }),
        model: 'fake-model',
      };
    },
    async healthCheck() {
      return { ok: true, message: 'ok' };
    },
  };
}

function fakeBiliClient(noSubtitleFor: string[] = []) {
  return {
    hasLogin: true,
    async resolve(url: string) {
      const bvid = url.match(/BV[0-9A-Za-z]{10}/)?.[0] ?? 'BVUNKNOWN000';
      return { bvid, aid: 1, page: undefined };
    },
    async getVideoInfo(bvid: string) {
      return {
        ...fakeVideo(bvid, `视频 ${bvid}`),
        aid: 1,
        cid: 10,
        duration: 120,
        parts: [{ cid: 10, page: 1, title: '正片', duration: 120 }],
      };
    },
    async getSubtitles(bvid: string) {
      if (noSubtitleFor.includes(bvid)) return null;
      return makeTranscript(0, 3);
    },
    async getBuiltinSummary() {
      return null;
    },
  } as unknown as BilibiliClient;
}

describe('runCollectionJob', () => {
  const request = {
    title: '测试合集',
    collectionId: 7,
    total: 5,
    episodes: [
      { url: 'https://www.bilibili.com/video/BV1AAAAAAAA1' },
      { url: 'https://www.bilibili.com/video/BV1BBBBBBBB2' },
    ],
  };

  it('合并多集产出 1 份摘要，带时间轴与收录清单', async () => {
    const progress: JobProgress[] = [];
    const result = await runCollectionJob({
      request,
      config: { ...DEFAULT_CONFIG, asrProvider: 'none' },
      client: fakeBiliClient(),
      provider: fakeProvider(),
      onProgress: (p) => progress.push(p),
    });

    expect(result.collection?.covered).toBe(2);
    expect(result.collection?.total).toBe(5);
    expect(result.collection?.episodes).toHaveLength(2);
    expect(result.collection?.episodes[1]!.start).toBeGreaterThan(0);
    expect(result.video.title).toBe('合集《测试合集》');
    expect(result.markdown).toContain('# 合集《测试合集》摘要');
    expect(result.markdown).toContain('## 收录视频');
    // 分集标记写进了合并字幕
    expect(result.transcript.segments.some((s) => s.text.includes('第 2 集'))).toBe(true);
    // 进度最后到 100
    expect(progress.at(-1)?.percent).toBe(100);
  });

  it('某一集没字幕时跳过并写进 warnings，不整体失败', async () => {
    const result = await runCollectionJob({
      request,
      config: { ...DEFAULT_CONFIG, asrProvider: 'none' },
      client: fakeBiliClient(['BV1BBBBBBBB2']),
      provider: fakeProvider(),
    });

    expect(result.collection?.covered).toBe(1);
    // 跳过的集必须如实告知，不能静默丢内容
    expect(result.summary.warnings?.some((w) => w.includes('已跳过'))).toBe(true);
    expect(result.markdown).toContain('已跳过');
  });

  it('B 站官方总结供应商不支持合并模式，给出明确提示', async () => {
    await expect(
      runCollectionJob({
        request,
        config: { ...DEFAULT_CONFIG, llmProvider: 'bilibili' },
        client: fakeBiliClient(),
      }),
    ).rejects.toThrow(/不支持合集合并/);
  });
});
