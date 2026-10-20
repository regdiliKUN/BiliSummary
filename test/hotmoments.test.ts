import { describe, expect, it } from 'vitest';
import { findHotMoments, renderHotMoments } from '../src/core/pipeline/hotmoments.js';
import type { DanmakuItem } from '../src/core/types.js';

function dm(time: number, text: string): DanmakuItem {
  return { time, text, mode: 1, color: 0, pool: '0' };
}

describe('弹幕热点识别', () => {
  it('空弹幕返回空数组', () => {
    expect(findHotMoments([], 100)).toEqual([]);
  });

  it('识别出弹幕密集的时间点', () => {
    const danmaku: DanmakuItem[] = [
      // 30 秒处很热
      ...Array.from({ length: 10 }, (_, i) => dm(30 + i * 0.2, '名场面')),
      // 其它时间只有零星几条
      dm(5, '路过'),
      dm(100, '路过'),
    ];
    const moments = findHotMoments(danmaku, 200);
    expect(moments.length).toBeGreaterThan(0);
    expect(moments[0]!.time).toBe(30);
    expect(moments[0]!.count).toBe(10);
  });

  it('统计重复弹幕的出现次数', () => {
    const danmaku: DanmakuItem[] = Array.from({ length: 8 }, (_, i) =>
      dm(60 + i * 0.1, '哈哈哈哈哈'),
    );
    const moments = findHotMoments(danmaku, 200);
    expect(moments[0]!.samples[0]).toBe('哈哈哈哈哈 ×8');
  });

  it('过滤掉零散的单个弹幕', () => {
    // 每个 10 秒窗口里只有 1 条，不算热点
    const danmaku: DanmakuItem[] = [dm(1, 'a'), dm(11, 'b'), dm(21, 'c'), dm(31, 'd')];
    expect(findHotMoments(danmaku, 200)).toEqual([]);
  });

  it('开头刷屏不会压掉后面的真热点', () => {
    const danmaku: DanmakuItem[] = [
      // 开头 200 条刷屏
      ...Array.from({ length: 200 }, (_, i) => dm(i * 0.05, '前奏')),
      // 30 秒处 6 条 —— 相对密度仍然很高
      ...Array.from({ length: 6 }, (_, i) => dm(30 + i * 0.1, '名场面')),
      // 其它时间零星几条
      dm(80, '路过'),
      dm(120, '路过'),
    ];
    const moments = findHotMoments(danmaku, 200);
    const times = moments.map((m) => m.time);
    expect(times).toContain(30);
  });

  it('超出视频时长的热点被丢弃', () => {
    const danmaku: DanmakuItem[] = Array.from({ length: 12 }, (_, i) => dm(500 + i * 0.1, 'x'));
    expect(findHotMoments(danmaku, 100)).toEqual([]);
  });

  it('返回的热点按时间排序', () => {
    const danmaku: DanmakuItem[] = [
      ...Array.from({ length: 8 }, (_, i) => dm(90 + i * 0.1, 'b')),
      ...Array.from({ length: 12 }, (_, i) => dm(20 + i * 0.1, 'a')),
    ];
    const moments = findHotMoments(danmaku, 200);
    const times = moments.map((m) => m.time);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
  });

  it('忽略过长的弹幕文本', () => {
    const long = 'x'.repeat(50);
    const danmaku: DanmakuItem[] = Array.from({ length: 8 }, (_, i) => dm(30 + i * 0.1, long));
    // 全都过长 -> 提取不到样本 -> 该时刻不作为热点
    expect(findHotMoments(danmaku, 200)).toEqual([]);
  });
});

describe('热点渲染', () => {
  it('没有热点时返回空串', () => {
    expect(renderHotMoments([])).toBe('');
  });

  it('按时间范围过滤', () => {
    const moments = [
      { time: 10, count: 5, samples: ['a'] },
      { time: 100, count: 5, samples: ['b'] },
    ];
    const text = renderHotMoments(moments, { start: 0, end: 50 });
    expect(text).toContain('[00:10]');
    expect(text).not.toContain('[01:40]');
  });

  it('输出可读的时间戳', () => {
    const moments = [{ time: 65, count: 5, samples: ['x'] }];
    expect(renderHotMoments(moments)).toBe('- [01:05] x');
  });
});
