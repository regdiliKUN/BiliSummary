import { describe, expect, it } from 'vitest';
import { parseVideoInput } from '../src/core/bilibili/client.js';

describe('视频标识解析', () => {
  it('解析完整链接', () => {
    expect(parseVideoInput('https://www.bilibili.com/video/BV1GJ411x7h7')).toEqual({
      bvid: 'BV1GJ411x7h7',
      page: undefined,
    });
  });

  it('解析带 p 参数的链接', () => {
    const parsed = parseVideoInput('https://www.bilibili.com/video/BV1GJ411x7h7/?p=3');
    expect(parsed.bvid).toBe('BV1GJ411x7h7');
    expect(parsed.page).toBe(3);
  });

  it('解析裸 BV 号', () => {
    expect(parseVideoInput('BV1GJ411x7h7').bvid).toBe('BV1GJ411x7h7');
  });

  it('解析 av 号', () => {
    expect(parseVideoInput('av170001').aid).toBe(170001);
    expect(parseVideoInput('https://www.bilibili.com/video/av170001').aid).toBe(170001);
  });

  it('识别短链', () => {
    expect(parseVideoInput('https://b23.tv/abcdef').shortUrl).toBe('https://b23.tv/abcdef');
  });

  it('对无效输入抛错', () => {
    expect(() => parseVideoInput('不是链接')).toThrow();
    expect(() => parseVideoInput('')).toThrow();
  });
});
