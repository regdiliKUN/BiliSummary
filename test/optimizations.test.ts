/** 性能与体积优化（0.4.5）的回归测试。 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BilibiliClient } from '../src/core/bilibili/client.js';
import { encodeUploadParts, parseSegmentList, resolveFfmpegPath } from '../src/core/asr/audio.js';
import { audioMimeType } from '../src/core/asr/openaiCompat.js';
import { transcribeParts } from '../src/core/asr/parts.js';
import { parseWhisperProgress, pickWhisperThreads } from '../src/core/asr/whisperCpp.js';
import { renderMarkdown } from '../src/core/output/markdown.js';
import { OllamaProvider, pickNumCtx } from '../src/core/providers/ollama.js';
import { OpenAiProvider, retryDelayFor, HttpStatusError } from '../src/core/providers/openai.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { sampleEvenly } from '../src/core/utils/sample.js';
import type { AsrProvider, VideoInfo, VideoSummary } from '../src/core/types.js';

// 有 ffmpeg 时才跑真实切段（CI 机器可能没有）
const ffmpegForTest = await resolveFfmpegPath();

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('sampleEvenly', () => {
  it('不超过上限时原样返回副本', () => {
    const src = [1, 2, 3];
    const out = sampleEvenly(src, 5);
    expect(out).toEqual([1, 2, 3]);
    expect(out).not.toBe(src);
  });

  it('均匀覆盖首尾且不重复', () => {
    const src = Array.from({ length: 1000 }, (_, i) => i);
    const out = sampleEvenly(src, 10);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe(0);
    expect(out[9]).toBe(999);
    expect(new Set(out).size).toBe(10);
  });

  it('limit 非正数时不截断', () => {
    expect(sampleEvenly([1, 2, 3], 0)).toEqual([1, 2, 3]);
  });
});

describe('B 站客户端：视频信息缓存', () => {
  const view = {
    code: 0,
    data: { bvid: 'BV1xx411c7mD', aid: 7, cid: 9, title: '原标题', pages: [{ cid: 9, page: 1, part: 'P1', duration: 60 }] },
  };

  it('resolve + getVideoInfo 只打一次 view 接口', async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url.includes('finger/spi') ? jsonResponse({ code: 0, data: { b_3: 'b3', b_4: 'b4' } }) : jsonResponse(view),
    );
    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const { aid } = await client.resolve('BV1xx411c7mD');
    await client.getVideoInfo('BV1xx411c7mD');
    await client.getVideoInfo('BV1xx411c7mD');

    expect(aid).toBe(7);
    const viewCalls = fetchImpl.mock.calls.filter((c) => String((c as unknown[])[0]).includes('/web-interface/view'));
    expect(viewCalls).toHaveLength(1);
  });

  it('返回的是副本：调用方改标题不会污染缓存', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(view));
    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const first = await client.getVideoInfo('BV1xx411c7mD');
    first.title = '被改掉';
    const second = await client.getVideoInfo('BV1xx411c7mD');
    expect(second.title).toBe('原标题');
  });

  it('并发请求同一视频只发一次', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(view));
    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await Promise.all([client.getVideoInfo('BV1xx411c7mD'), client.getVideoInfo('BV1xx411c7mD')]);
    const viewCalls = fetchImpl.mock.calls.filter((c) => String((c as unknown[])[0]).includes('/web-interface/view'));
    expect(viewCalls).toHaveLength(1);
  });

  it('失败结果不缓存', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      if (!url.includes('/web-interface/view')) return jsonResponse({ code: 0, data: {} });
      call += 1;
      return call === 1 ? jsonResponse({ code: -404, message: 'x' }) : jsonResponse(view);
    });
    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.getVideoInfo('BV1xx411c7mD')).rejects.toThrow();
    await expect(client.getVideoInfo('BV1xx411c7mD')).resolves.toMatchObject({ aid: 7 });
  });
});

describe('B 站客户端：音频', () => {
  it('普通音轨按码率从低到高，Hi-Res 单对象不会抛错且排在最后', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        code: 0,
        data: {
          dash: {
            audio: [
              { bandwidth: 320000, baseUrl: 'https://a/high', backupUrl: ['https://b/high'] },
              { bandwidth: 64000, baseUrl: 'https://a/low' },
            ],
            flac: { display: true, audio: { bandwidth: 1500000, baseUrl: 'https://a/flac' } },
          },
        },
      }),
    );
    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const urls = await client.getAudioUrls('BV1xx411c7mD', 1);
    expect(urls).toEqual(['https://a/low', 'https://a/high', 'https://b/high', 'https://a/flac']);
  });

  it('downloadToFile 流式写盘并汇报进度', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bs-dl-'));
    try {
      const payload = Buffer.alloc(200_000, 7);
      const fetchImpl = vi.fn(async () => new Response(payload, { headers: { 'content-length': String(payload.length) } }));
      const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
      const progress: number[] = [];
      const dest = join(dir, 'a.m4s');
      const size = await client.downloadToFile('https://cdn/x', 'https://r/', dest, {
        onProgress: (r) => progress.push(r),
      });
      expect(size).toBe(payload.length);
      expect(readFileSync(dest).equals(payload)).toBe(true);
      expect(progress.at(-1)).toBe(payload.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('downloadToFile 遇到 403 给出地区提示', async () => {
    const fetchImpl = vi.fn(async () => new Response('no', { status: 403 }));
    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.downloadToFile('https://cdn/x', 'https://r/', join(tmpdir(), 'never.m4s'))).rejects.toThrow(/403/);
  });
});

describe('B 站客户端：弹幕抽样', () => {
  it('超过上限时覆盖整条时间轴，而不是只留开头', async () => {
    const xml = `<i>${Array.from({ length: 600 }, (_, i) => `<d p="${i},1,25,16777215">弹幕${i}</d>`).join('')}</i>`;
    const fetchImpl = vi.fn(async () => new Response(xml));
    const client = new BilibiliClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const items = await client.getDanmaku(1, 100);
    expect(items).toHaveLength(100);
    expect(items[0]!.time).toBe(0);
    expect(items.at(-1)!.time).toBe(599);
  });
});

describe('云端 ASR 分段', () => {
  it('解析 ffmpeg 分段清单并按起点排序', () => {
    const parts = parseSegmentList('upload-001.mp3,600.000000,1200.0\r\nupload-000.mp3,0.000000,600.0\n', '/tmp/x');
    expect(parts.map((p) => p.offset)).toEqual([0, 600]);
    expect(parts[0]!.path.endsWith('upload-000.mp3')).toBe(true);
  });

  it('分段转写后时间戳平移回整段时间轴', async () => {
    const asr: AsrProvider = {
      kind: 'openai',
      name: 'fake',
      transcribe: async (path) => ({ segments: [{ start: 1, end: 2, text: path }], model: 'w' }),
      healthCheck: async () => ({ ok: true, message: '' }),
    };
    const done: number[] = [];
    const res = await transcribeParts(
      asr,
      [
        { path: 'a', offset: 0 },
        { path: 'b', offset: 600 },
        { path: 'c', offset: 1200 },
      ],
      { concurrency: 2, onPart: (d) => done.push(d) },
    );
    expect(res.segments.map((s) => [s.start, s.text])).toEqual([
      [1, 'a'],
      [601, 'b'],
      [1201, 'c'],
    ]);
    expect(done).toEqual([1, 2, 3]);
    expect(res.model).toBe('w');
  });

  it('任意一段失败整体失败', async () => {
    const asr: AsrProvider = {
      kind: 'openai',
      name: 'fake',
      transcribe: async (path) => {
        if (path === 'b') throw new Error('HTTP 500');
        return { segments: [] };
      },
      healthCheck: async () => ({ ok: true, message: '' }),
    };
    await expect(
      transcribeParts(asr, [{ path: 'a', offset: 0 }, { path: 'b', offset: 1 }]),
    ).rejects.toThrow(/500/);
  });

  it('上传文件按扩展名声明 MIME', () => {
    expect(audioMimeType('x/upload-000.mp3')).toBe('audio/mpeg');
    expect(audioMimeType('a.WAV')).toBe('audio/wav');
  });

  it.skipIf(!ffmpegForTest)('ffmpeg 真实切段：mp3 小、偏移准确', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bs-seg-'));
    try {
      const input = join(dir, 'in.m4a');
      const gen = spawnSync(ffmpegForTest!, ['-y', '-hide_banner', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=25', '-c:a', 'aac', input]);
      expect(gen.status).toBe(0);
      const parts = await encodeUploadParts(ffmpegForTest!, input, dir, { segmentSeconds: 10 });
      expect(parts).toHaveLength(3);
      expect(parts[0]!.offset).toBe(0);
      expect(parts[1]!.offset).toBeCloseTo(10, 0);
      expect(parts[2]!.offset).toBeCloseTo(20, 0);
      for (const part of parts) expect(existsSync(part.path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('whisper.cpp', () => {
  it('线程数：少核用满，多核取一半，上限 8', () => {
    expect(pickWhisperThreads(2)).toBe(2);
    expect(pickWhisperThreads(4)).toBe(4);
    expect(pickWhisperThreads(8)).toBe(4);
    expect(pickWhisperThreads(16)).toBe(8);
    expect(pickWhisperThreads(64)).toBe(8);
    expect(pickWhisperThreads(Number.NaN)).toBe(4);
  });

  it('解析 -pp 进度输出，取最新值', () => {
    expect(parseWhisperProgress('whisper_print_progress_callback: progress =   5%\nwhisper_print_progress_callback: progress =  10%')).toBe(10);
    expect(parseWhisperProgress('nothing here')).toBeNull();
  });
});

describe('Ollama 上下文窗口', () => {
  it('默认配置下分块请求的 num_ctx 稳定且足够大', () => {
    const a = pickNumCtx('短提示', 4096, 8000);
    const b = pickNumCtx('另一段差不多长的提示'.repeat(50), 4096, 8000);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(4000 + 4096);
  });

  it('超长请求会按需调大，但不超过 32K', () => {
    const big = pickNumCtx('字'.repeat(20000), 4096, 8000);
    expect(big).toBeGreaterThanOrEqual(20000 + 4096);
    expect(pickNumCtx('字'.repeat(200000), 4096, 8000)).toBe(32768);
  });

  it('请求体带上 num_ctx', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ message: { content: '{}' } }));
    const provider = new OllamaProvider({ ...DEFAULT_CONFIG.ollama, model: 'qwen3:8b' }, fetchImpl as never);
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.options.num_ctx).toBeGreaterThanOrEqual(8192);
  });
});

describe('OpenAI 兼容接口重试', () => {
  const cfg = { ...DEFAULT_CONFIG.openai, apiKey: 'k' };
  const ok = () => jsonResponse({ choices: [{ message: { content: 'ok' } }] });

  it('429 后退避重试成功', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'rate limit' } }, 429))
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'busy' } }, 503))
      .mockResolvedValueOnce(ok());
    const provider = new OpenAiProvider(cfg, fetchImpl as never, 5000, { baseDelayMs: 0 });
    const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(res.content).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('401 / 400 不重试', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'bad key' } }, 401));
    const provider = new OpenAiProvider(cfg, fetchImpl as never, 5000, { baseDelayMs: 0 });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/401/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('重试次数用尽后抛出最后的错误', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: { message: 'down' } }, 502));
    const provider = new OpenAiProvider(cfg, fetchImpl as never, 5000, { retries: 2, baseDelayMs: 0 });
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(/502/);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('json 模式不支持时降级，不占用重试次数', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'response_format not supported' } }, 400))
      .mockResolvedValueOnce(ok());
    const provider = new OpenAiProvider(cfg, fetchImpl as never, 5000, { retries: 0 });
    const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }], json: true });
    expect(res.content).toBe('ok');
  });

  it('Retry-After 头优先于指数退避', () => {
    expect(retryDelayFor(new HttpStatusError('x', 429, 3000), 0, 1500)).toBe(3000);
    expect(retryDelayFor(new HttpStatusError('x', 429), 1, 1500)).toBe(3000);
    expect(retryDelayFor(new HttpStatusError('x', 404), 0, 1500)).toBeNull();
    expect(retryDelayFor(new Error('fetch failed'), 0, 1000)).toBe(1000);
    expect(retryDelayFor(new Error('请求超时（180s）'), 0, 1000)).toBeNull();
  });
});

describe('Markdown 高光弹幕', () => {
  const video = {
    bvid: 'BV1', aid: 1, cid: 1, title: 'T', desc: '', cover: '', duration: 600, pubdate: 0,
    owner: { mid: 1, name: 'U', face: '' },
    stat: { view: 0, danmaku: 0, reply: 0, favorite: 0, coin: 0, share: 0, like: 0 },
    parts: [], url: 'u', rawUrl: 'u',
  } as VideoInfo;
  const summary = {
    tldr: '', keyPoints: [], segments: [], outline: [], insights: [], warnings: [],
    model: 'm', provider: 'openai', transcriptSource: 'subtitle', createdAt: '',
  } as VideoSummary;

  it('有热点时列出名场面', () => {
    const md = renderMarkdown({
      video,
      summary,
      danmaku: [{ time: 1, text: 'a', mode: 1, color: 0, pool: '0' }],
      hotMoments: [{ time: 125, count: 42, samples: ['名场面 ×20', '哈哈哈'] }],
    });
    expect(md).toContain('## 高光弹幕');
    expect(md).toContain('`02:05` 名场面 ×20、哈哈哈（42 条弹幕）');
  });

  it('没有热点时均匀摘录', () => {
    const danmaku = Array.from({ length: 200 }, (_, i) => ({ time: i, text: `d${i}`, mode: 1, color: 0, pool: '0' }));
    const md = renderMarkdown({ video, summary, danmaku });
    expect(md).toContain('## 弹幕摘录');
    expect(md).toContain('d199');
  });
});
