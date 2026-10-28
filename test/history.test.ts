/** 历史记录存储：写入、读取、收藏、淘汰、导出。 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HistoryStore } from '../src/core/history.js';
import type { JobResult, VideoInfo } from '../src/core/types.js';

const video: VideoInfo = {
  bvid: 'BV1TEST00001',
  aid: 1,
  cid: 11,
  title: '测试视频标题',
  desc: '',
  cover: 'https://example.com/c.jpg',
  duration: 600,
  pubdate: 0,
  owner: { mid: 9, name: '测试UP', face: '' },
  stat: { view: 1, danmaku: 0, reply: 0, favorite: 0, coin: 0, share: 0, like: 0 },
  parts: [
    { cid: 11, page: 1, title: 'P1', duration: 600 },
    { cid: 12, page: 2, title: 'P2', duration: 700 },
  ],
  url: 'https://www.bilibili.com/video/BV1TEST00001',
  rawUrl: '',
};

function makeResult(overrides: { bvid?: string; title?: string; cid?: number } = {}): JobResult {
  const v: VideoInfo = {
    ...video,
    bvid: overrides.bvid ?? video.bvid,
    title: overrides.title ?? video.title,
    cid: overrides.cid ?? video.cid,
  };
  return {
    jobId: 'job-1',
    video: v,
    transcript: { source: 'subtitle', segments: [{ start: 0, end: 1, text: '你好' }] },
    danmaku: [],
    summary: {
      tldr: '一句话总结',
      keyPoints: ['要点一', '要点二'],
      segments: [],
      outline: [],
      insights: [],
      warnings: [],
      model: 'test-model',
      provider: 'openai',
      transcriptSource: 'subtitle',
      createdAt: new Date().toISOString(),
    },
    markdown: `# ${v.title}\n\n正文内容`,
  };
}

let dir: string;
let store: HistoryStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bs-history-'));
  store = new HistoryStore(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('HistoryStore', () => {
  it('写入后可列出并读回完整内容', () => {
    const entry = store.add(makeResult());
    expect(entry.bvid).toBe('BV1TEST00001');
    expect(entry.tldr).toBe('一句话总结');
    expect(entry.part).toBe(1);

    const list = store.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(entry.id);

    const record = store.get(entry.id);
    expect(record).not.toBeNull();
    expect(record!.result.markdown).toContain('正文内容');
    expect(record!.result.summary.model).toBe('test-model');
  });

  it('索引与内容分开落盘，重启后仍能读到', () => {
    const entry = store.add(makeResult());
    const reopened = new HistoryStore(dir);
    expect(reopened.list().map((e) => e.id)).toEqual([entry.id]);
    expect(reopened.get(entry.id)?.result.video.bvid).toBe('BV1TEST00001');
    expect(existsSync(join(dir, 'index.json'))).toBe(true);
    expect(existsSync(join(dir, 'items', `${entry.id}.json`))).toBe(true);
  });

  it('多条记录按新到旧排序', () => {
    const first = store.add(makeResult({ bvid: 'BV1AAA00001' }));
    const second = store.add(makeResult({ bvid: 'BV1BBB00002' }));
    expect(store.list().map((e) => e.id)).toEqual([second.id, first.id]);
  });

  it('能按 bvid + 分P 判断是否已存在', () => {
    store.add(makeResult());
    expect(store.find('BV1TEST00001', 1)).not.toBeNull();
    expect(store.find('BV1TEST00001', 2)).toBeNull();
    expect(store.find('BV1NOTEXIST0', 1)).toBeNull();
  });

  it('分P 记录可从标题中还原', () => {
    const result = makeResult({ cid: 12, title: '测试视频标题 - P2 第二节' });
    const entry = store.add(result);
    expect(entry.part).toBe(2);
    expect(entry.id).toContain('_p2_');
  });

  it('收藏状态可持久化', () => {
    const entry = store.add(makeResult());
    store.setFavorite(entry.id, true);
    expect(new HistoryStore(dir).list()[0]!.favorite).toBe(true);
    store.setFavorite(entry.id, false);
    expect(new HistoryStore(dir).list()[0]!.favorite).toBe(false);
  });

  it('删除单条会同时删掉内容文件', () => {
    const entry = store.add(makeResult());
    expect(store.remove(entry.id)).toBe(true);
    expect(store.list()).toHaveLength(0);
    expect(existsSync(join(dir, 'items', `${entry.id}.json`))).toBe(false);
    expect(store.get(entry.id)).toBeNull();
  });

  it('清空会移除索引与全部内容文件', () => {
    store.add(makeResult({ bvid: 'BV1AAA00001' }));
    store.add(makeResult({ bvid: 'BV1BBB00002' }));
    expect(store.clear()).toBe(2);
    expect(store.list()).toHaveLength(0);
    expect(readdirSync(join(dir, 'items'))).toHaveLength(0);
  });

  it('超过上限时淘汰最旧记录并清理文件', () => {
    for (let i = 0; i < 5; i += 1) {
      store.add(makeResult({ bvid: `BV1LIM0000${i}` }), { limit: 3 });
    }
    const list = store.list();
    expect(list).toHaveLength(3);
    // 最新的三条保留
    expect(list.map((e) => e.bvid)).toEqual(['BV1LIM00004', 'BV1LIM00003', 'BV1LIM00002']);
    expect(readdirSync(join(dir, 'items'))).toHaveLength(3);
  });

  it('合并导出包含目录与每篇正文', () => {
    const a = store.add(makeResult({ bvid: 'BV1AAA00001', title: '第一篇' }));
    const b = store.add(makeResult({ bvid: 'BV1BBB00002', title: '第二篇' }));
    const { content, missing } = store.buildMergedMarkdown([a.id, b.id, 'missing-id']);
    expect(missing).toEqual(['missing-id']);
    expect(content).toContain('共 2 篇');
    expect(content).toContain('1. 第一篇（BV1AAA00001）');
    expect(content).toContain('2. 第二篇（BV1BBB00002）');
    expect(content.match(/正文内容/g)).toHaveLength(2);
  });

  it('按文件导出会生成合法文件名并避开重名', () => {
    const a = store.add(makeResult({ bvid: 'BV1AAA00001', title: 'A/B:C*D?E' }));
    const b = store.add(makeResult({ bvid: 'BV1AAA00001', title: 'A/B:C*D?E' }));
    const outDir = join(dir, 'export');
    const { written, missing } = store.exportToFolder([a.id, b.id], outDir);
    expect(written).toBe(2);
    expect(missing).toHaveLength(0);
    const files = readdirSync(outDir);
    expect(files).toHaveLength(2);
    expect(files.every((f) => !/[\\/:*?"<>|]/.test(f))).toBe(true);
    const content = readFileSync(join(outDir, files[0]!), 'utf8');
    expect(content).toContain('正文内容');
  });

  it('索引损坏时降级为空列表而不是崩溃', () => {
    store.add(makeResult());
    const indexFile = join(dir, 'index.json');
    writeFileSync(indexFile, '{ broken json', 'utf8');
    const reopened = new HistoryStore(dir);
    expect(reopened.list()).toEqual([]);
  });
});
