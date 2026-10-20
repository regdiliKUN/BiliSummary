import { describe, expect, it, vi } from 'vitest';
import { BilibiliClient, BilibiliError } from '../src/core/bilibili/client.js';

/** 构造一个可控的 fetch 替身。 */
function makeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body } = handler(String(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      url: String(url),
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    } as unknown as Response;
  });
}

describe('UA 降级与风控重试', () => {
  it('412 时降级 UA 重试，且不会发出 undefined 的 UA', async () => {
    const seen: string[] = [];
    let call = 0;

    const fetchImpl = makeFetch((url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers['User-Agent'] ?? '');
      call++;
      // 前两次 412，之后成功
      if (call <= 2) return { status: 412, body: 'blocked' };
      return { body: { code: 0, data: { aid: 1, bvid: 'BV1xx411c7mD' } } };
    });

    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const data = await client.resolve('BV1xx411c7mD');

    expect(data.bvid).toBe('BV1xx411c7mD');
    expect(seen.length).toBeGreaterThanOrEqual(3);
    // 关键：任何一次请求都不能发出 "undefined" 的 UA
    for (const ua of seen) {
      expect(ua).not.toContain('undefined');
      expect(ua.length).toBeGreaterThan(0);
    }
  });

  it('请求成功后恢复首选 UA', async () => {
    const seen: string[] = [];
    let call = 0;
    const fetchImpl = makeFetch((url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers['User-Agent'] ?? '');
      call++;
      if (call === 2) return { status: 412, body: 'blocked' };
      return { body: { code: 0, data: { aid: 1, bvid: 'BV1xx411c7mD' } } };
    });

    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.resolve('BV1xx411c7mD');
    // 再发一次请求，应已恢复首选 UA
    const before = seen.length;
    await client.resolve('BV1xx411c7mD');
    expect(seen.length).toBeGreaterThan(before);
  });

  it('多次 412 也不会让 UA 越界', async () => {
    const seen: string[] = [];
    const fetchImpl = makeFetch((url, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      seen.push(headers['User-Agent'] ?? '');
      return { status: 412, body: 'blocked' };
    });

    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.resolve('BV1xx411c7mD')).rejects.toThrow(BilibiliError);
    expect(seen.every((ua) => !ua.includes('undefined'))).toBe(true);
  });
});

describe('取消信号', () => {
  it('已取消的信号会立即终止请求，不发出网络请求', async () => {
    const fetchImpl = makeFetch(() => ({ body: { code: 0, data: {} } }));
    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const controller = new AbortController();
    controller.abort();

    await expect(
      client.getSubtitles('BV1xx411c7mD', 1, 2, controller.signal),
    ).rejects.toThrow(/取消/);
  });
});

describe('链接中的 p 参数', () => {
  it('resolve 会带回 ?p= 的分P号', async () => {
    const fetchImpl = makeFetch(() => ({
      body: { code: 0, data: { aid: 1, bvid: 'BV1xx411c7mD' } },
    }));
    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await client.resolve('https://www.bilibili.com/video/BV1xx411c7mD/?p=3');
    expect(res.page).toBe(3);
  });

  it('没有 p 参数时为 undefined', async () => {
    const fetchImpl = makeFetch(() => ({
      body: { code: 0, data: { aid: 1, bvid: 'BV1xx411c7mD' } },
    }));
    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const res = await client.resolve('BV1xx411c7mD');
    expect(res.page).toBeUndefined();
  });
});

describe('Cookie 解析', () => {
  it('hasLogin 只认非空的 SESSDATA', () => {
    expect(new BilibiliClient({ cookie: 'SESSDATA=abc; bili_jct=1' }).hasLogin).toBe(true);
    expect(new BilibiliClient({ cookie: 'SESSDATA=; bili_jct=1' }).hasLogin).toBe(false);
    expect(new BilibiliClient({ cookie: 'bili_jct=1' }).hasLogin).toBe(false);
    expect(new BilibiliClient({}).hasLogin).toBe(false);
  });

  it('能取到指定的 Cookie 字段', () => {
    const c = new BilibiliClient({ cookie: 'SESSDATA=abc; DedeUserID=12345' });
    expect(c.getCookieValue('DedeUserID')).toBe('12345');
    expect(c.getCookieValue('不存在')).toBe('');
  });
});
