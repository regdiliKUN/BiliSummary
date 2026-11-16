import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigStore, DEFAULT_CONFIG, mergeConfig, validateConfig } from '../src/core/config.js';
import { renderMarkdown, renderSrt, buildFileName } from '../src/core/output/markdown.js';
import { toSrtTimestamp } from '../src/core/utils/time.js';
import type { VideoInfo, VideoSummary, Transcript } from '../src/core/types.js';

const video: VideoInfo = {
  bvid: 'BV1GJ411x7h7',
  aid: 1,
  cid: 2,
  title: '测试视频标题',
  desc: '视频简介内容',
  cover: '',
  duration: 3665,
  pubdate: 1700000000,
  owner: { mid: 1, name: '测试UP主', face: '' },
  stat: { view: 12345, danmaku: 100, reply: 50, favorite: 20, coin: 30, share: 5, like: 200 },
  parts: [{ cid: 2, page: 1, title: 'P1', duration: 3665 }],
  url: 'https://www.bilibili.com/video/BV1GJ411x7h7',
  rawUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/',
};

const summary: VideoSummary = {
  tldr: '这是一句话总结。',
  keyPoints: ['要点一', '要点二'],
  segments: [
    { start: 0, end: 125.5, title: '开场介绍', points: ['介绍主题'], summary: '讲了背景。' },
    { start: 125.5, end: 3665, title: '正文', points: [], summary: '展开讲。' },
  ],
  outline: [
    { start: 0, title: '开场介绍' },
    { start: 125.5, title: '正文' },
  ],
  insights: ['一个值得注意的点'],
  warnings: [],
  model: 'test-model',
  provider: 'openai',
  transcriptSource: 'subtitle',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('配置合并', () => {
  it('缺省字段用默认值补齐', () => {
    const merged = mergeConfig({ llmProvider: 'ollama' });
    expect(merged.llmProvider).toBe('ollama');
    expect(merged.openai.model).toBe(DEFAULT_CONFIG.openai.model);
  });

  it('嵌套对象做浅合并', () => {
    const merged = mergeConfig({ openai: { model: 'x' } as any });
    expect(merged.openai.model).toBe('x');
    expect(merged.openai.baseUrl).toBe(DEFAULT_CONFIG.openai.baseUrl);
  });

  it('类型不匹配时忽略', () => {
    const merged = mergeConfig({ concurrency: 'abc' as any });
    expect(merged.concurrency).toBe(DEFAULT_CONFIG.concurrency);
  });

  it('null / undefined 输入返回默认值副本', () => {
    const merged = mergeConfig(null);
    expect(merged).toEqual(DEFAULT_CONFIG);
    expect(merged).not.toBe(DEFAULT_CONFIG);
  });

  it('忽略未知字段与嵌套字段的类型错误（第 3 轮）', () => {
    const merged = mergeConfig({
      openai: { model: 'x', injected: 'evil', temperature: 'hot' },
      unexpected: { nested: true },
    } as any);
    expect((merged.openai as any).injected).toBeUndefined();
    expect(merged.openai.model).toBe('x');
    expect(merged.openai.temperature).toBe(DEFAULT_CONFIG.openai.temperature);
    expect((merged as any).unexpected).toBeUndefined();
  });
});

describe('配置持久化', () => {
  it('保存后无临时文件残留且内容可重新读取（第 4 轮）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bs-config-'));
    try {
      const file = join(dir, 'config.json');
      const store = new ConfigStore(file);
      store.save({ ...DEFAULT_CONFIG, summaryLanguage: 'en' });
      expect(JSON.parse(readFileSync(file, 'utf8')).summaryLanguage).toBe('en');
      expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('配置校验', () => {
  it('默认配置不报致命问题', () => {
    const issues = validateConfig(DEFAULT_CONFIG);
    // 默认没配 API Key，属于提醒项
    expect(issues.every((i) => !i.includes('并发'))).toBe(true);
  });

  it('检出并发数越界', () => {
    const issues = validateConfig({ ...DEFAULT_CONFIG, concurrency: 99 });
    expect(issues.some((i) => i.includes('并发'))).toBe(true);
  });

  it('检出空的模型名', () => {
    const issues = validateConfig({
      ...DEFAULT_CONFIG,
      openai: { ...DEFAULT_CONFIG.openai, model: '' },
    });
    expect(issues.some((i) => i.includes('模型名'))).toBe(true);
  });

  it('检出 NaN 与数值越界（第 5 轮）', () => {
    expect(validateConfig({ ...DEFAULT_CONFIG, concurrency: Number.NaN }).some((i) => i.includes('并发数'))).toBe(true);
    expect(validateConfig({ ...DEFAULT_CONFIG, historyLimit: -2 }).some((i) => i.includes('历史条数'))).toBe(true);
    expect(
      validateConfig({
        ...DEFAULT_CONFIG,
        openai: { ...DEFAULT_CONFIG.openai, temperature: Number.NaN },
      }).some((i) => i.includes('temperature')),
    ).toBe(true);
  });
});

describe('Markdown 渲染', () => {
  const md = renderMarkdown({ video, summary });

  it('包含标题与元信息', () => {
    expect(md).toContain('# 测试视频标题');
    expect(md).toContain('测试UP主');
    expect(md).toContain('BV1GJ411x7h7');
  });

  it('包含 TL;DR 与要点', () => {
    expect(md).toContain('这是一句话总结。');
    expect(md).toContain('要点一');
  });

  it('包含带时间戳的分段', () => {
    expect(md).toContain('00:00 - 02:05 · 开场介绍');
    expect(md).toContain('## 章节速览');
  });

  it('包含洞察', () => {
    expect(md).toContain('一个值得注意的点');
  });

  it('可选包含字幕全文', () => {
    const transcript: Transcript = {
      source: 'subtitle',
      segments: [{ start: 0, end: 1, text: '字幕一行' }],
    };
    const withTranscript = renderMarkdown({ video, summary, transcript, includeTranscript: true });
    expect(withTranscript).toContain('## 字幕全文');
    expect(withTranscript).toContain('字幕一行');
  });
});

describe('SRT 渲染', () => {
  it('毫秒进位不会生成 ,1000（第 1 轮）', () => {
    expect(toSrtTimestamp(0.9996)).toBe('00:00:01,000');
    expect(toSrtTimestamp(59.9996)).toBe('00:01:00,000');
    expect(toSrtTimestamp(Number.NaN)).toBe('00:00:00,000');
  });

  it('生成标准 SRT 结构', () => {
    const srt = renderSrt({
      source: 'subtitle',
      segments: [
        { start: 0, end: 1.5, text: '第一句' },
        { start: 1.5, end: 3, text: '第二句' },
      ],
    });
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,500\n第一句');
    expect(srt).toContain('2\n00:00:01,500 --> 00:00:03,000\n第二句');
  });
});

describe('文件名生成', () => {
  it('去掉非法字符', () => {
    const name = buildFileName({ ...video, title: 'a/b:c*d?e"f<g>h|i' });
    expect(name).not.toMatch(/[\\/:*?"<>|]/);
  });

  it('处理控制字符、隐藏文件名与 Windows 保留名（第 2 轮）', () => {
    expect(buildFileName({ ...video, title: '..\u0000CON\n' })).toMatch(/^_CON-/);
    expect(buildFileName({ ...video, title: '   ' })).toMatch(/^未命名-/);
  });

  it('Markdown 表格单元格中的竖线与换行被转义（第 15 轮）', () => {
    const md = renderMarkdown({ video: { ...video, owner: { ...video.owner, name: 'A|B\nC' } }, summary });
    expect(md).toContain('| UP主 | A\\|B C |');
  });
});
