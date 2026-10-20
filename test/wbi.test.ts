import { describe, expect, it } from 'vitest';
import { getMixinKey, extractKey, signParams } from '../src/core/bilibili/wbi.js';

describe('wbi 签名', () => {
  it('从图片 URL 中取出 key', () => {
    expect(extractKey('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png')).toBe(
      '7cd084941338484aae1ad9425b84077c',
    );
    expect(extractKey('https://i0.hdslb.com/bfs/wbi/4932caff')).toBe('4932caff');
  });

  it('派生 32 位 mixinKey', () => {
    const key = getMixinKey(
      '7cd084941338484aae1ad9425b84077c',
      '4932caff2c0c2e8e14ff5f0e3f5f0e3f5',
    );
    expect(key).toHaveLength(32);
  });

  it('参数按 key 排序并附上 w_rid', () => {
    const { signedQuery, wts } = signParams({ bvid: 'BV1', cid: 2 }, 'k'.repeat(32), 1700000000);
    expect(wts).toBe(1700000000);
    expect(signedQuery).toMatch(/^bvid=BV1&cid=2&wts=1700000000&w_rid=[0-9a-f]{32}$/);
  });

  it("过滤掉 value 中的 !'()* 字符", () => {
    const { signedQuery } = signParams({ keyword: "a!b'c(d)e*f" }, 'k'.repeat(32), 1);
    expect(signedQuery).toContain('keyword=abcdef');
    expect(signedQuery).not.toContain('!');
  });

  it('跳过 undefined 值', () => {
    const { signedQuery } = signParams({ a: 1, b: undefined, c: null as any }, 'k'.repeat(32), 1);
    expect(signedQuery).not.toContain('b=');
    expect(signedQuery).not.toContain('c=');
  });

  it('同样的参数得到同样的签名', () => {
    const a = signParams({ x: 1, y: 2 }, 'k'.repeat(32), 100).signedQuery;
    const b = signParams({ y: 2, x: 1 }, 'k'.repeat(32), 100).signedQuery;
    expect(a).toBe(b);
  });
});
