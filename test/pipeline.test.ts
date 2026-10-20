import { describe, expect, it } from 'vitest';
import { extractJson, cleanSubtitleText, toStringList, textWeight } from '../src/core/utils/text.js';
import { normalizeSegments, parseTimeValue } from '../src/core/pipeline/summarize.js';
import { formatTimestamp, formatDurationCn, toSrtTimestamp } from '../src/core/utils/time.js';

describe('JSON 提取', () => {
  it('解析纯 JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('剥离 ```json 包裹', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('从前后废话中提取', () => {
    expect(extractJson('好的，结果如下：{"a":1} 希望有帮助')).toEqual({ a: 1 });
  });

  it('处理嵌套与字符串中的括号', () => {
    const payload = { a: '有个 } 字符', b: [1, 2] };
    expect(extractJson(`前言 ${JSON.stringify(payload)} 后记`)).toEqual(payload);
  });

  it('对非法内容抛错', () => {
    expect(() => extractJson('完全不是 JSON')).toThrow();
  });
});

describe('时间值解析', () => {
  it('解析数字秒', () => {
    expect(parseTimeValue(12.5)).toBe(12.5);
    expect(parseTimeValue('12.5')).toBe(12.5);
  });

  it('解析 mm:ss 与 hh:mm:ss', () => {
    expect(parseTimeValue('01:23')).toBe(83);
    expect(parseTimeValue('1:02:03')).toBe(3723);
  });

  it('把毫秒换算成秒', () => {
    expect(parseTimeValue(120000)).toBe(120);
  });

  it('对无效值返回 undefined', () => {
    expect(parseTimeValue('abc')).toBeUndefined();
    expect(parseTimeValue(undefined)).toBeUndefined();
    expect(parseTimeValue('')).toBeUndefined();
  });
});

describe('分段结果归一化', () => {
  it('解析标准结构', () => {
    const segs = normalizeSegments({
      segments: [
        { start: 10, end: 30, title: '开场', points: ['要点一'], summary: '讲了什么' },
      ],
    });
    expect(segs).toHaveLength(1);
    expect(segs[0]!.title).toBe('开场');
    expect(segs[0]!.points).toEqual(['要点一']);
    expect(segs[0]!.start).toBe(10);
    expect(segs[0]!.end).toBe(30);
  });

  it('兼容数组顶层', () => {
    const segs = normalizeSegments([{ start: 1, end: 2, title: 'A' }]);
    expect(segs[0]!.title).toBe('A');
  });

  it('兼容 points 缺失', () => {
    const segs = normalizeSegments({ segments: [{ start: 1, end: 2, title: 'A', summary: 'S' }] });
    expect(segs[0]!.points).toEqual([]);
  });

  it('时间戳非法时回退到块范围', () => {
    const segs = normalizeSegments(
      { segments: [{ title: 'A', summary: 'S' }] },
      { index: 0, start: 100, end: 200, segments: [], text: '' },
    );
    expect(segs[0]!.start).toBe(100);
    expect(segs[0]!.end).toBe(200);
  });

  it('end 小于 start 时修正', () => {
    const segs = normalizeSegments({ segments: [{ start: 50, end: 10, title: 'A' }] });
    expect(segs[0]!.end).toBeGreaterThan(segs[0]!.start);
  });

  it('空结果时用块内容兜底', () => {
    const segs = normalizeSegments(
      { segments: [] },
      { index: 0, start: 0, end: 10, segments: [{ start: 0, end: 10, text: '原始文本' }], text: '' },
    );
    expect(segs).toHaveLength(1);
    expect(segs[0]!.summary).toContain('原始文本');
  });

  it('按 start 排序', () => {
    const segs = normalizeSegments({
      segments: [
        { start: 30, end: 40, title: 'B' },
        { start: 10, end: 20, title: 'A' },
      ],
    });
    expect(segs[0]!.title).toBe('A');
  });
});

describe('文本工具', () => {
  it('清洗字幕文本', () => {
    expect(cleanSubtitleText('  你好，世界  ')).toBe('你好，世界');
    expect(cleanSubtitleText('- 你好')).toBe('你好');
  });

  it('去掉说话人标签', () => {
    expect(cleanSubtitleText('[张三] 你好')).toBe('你好');
    expect(cleanSubtitleText('【李四】：再见')).toBe('再见');
  });

  it('纯音效标注被整体去掉', () => {
    expect(cleanSubtitleText('[音乐]')).toBe('');
  });

  it('把字符串列表转成数组', () => {
    expect(toStringList('- 一\n- 二')).toEqual(['一', '二']);
    expect(toStringList(['x', 'y'])).toEqual(['x', 'y']);
    expect(toStringList(undefined)).toEqual([]);
  });

  it('中文字符权重更高', () => {
    expect(textWeight('中文')).toBeGreaterThan(textWeight('ab'));
  });
});

describe('时间格式化', () => {
  it('formatTimestamp', () => {
    expect(formatTimestamp(65)).toBe('01:05');
    expect(formatTimestamp(3725)).toBe('01:02:05');
  });

  it('formatDurationCn', () => {
    expect(formatDurationCn(65)).toBe('1分05秒');
    expect(formatDurationCn(3725)).toBe('1小时02分');
  });

  it('toSrtTimestamp', () => {
    expect(toSrtTimestamp(65.5)).toBe('00:01:05,500');
  });
});
