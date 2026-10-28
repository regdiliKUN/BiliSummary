import { describe, expect, it, vi } from 'vitest';
import { DeepSeekProvider, translateDeepSeekError } from '../src/core/providers/deepseek.js';
import { describeExitCode } from '../src/core/asr/whisperCpp.js';
import { DEFAULT_CONFIG, resolveModelProfile, validateConfig } from '../src/core/config.js';
import type { DeepSeekProviderConfig } from '../src/core/types.js';

function makeCfg(over: Partial<DeepSeekProviderConfig> = {}): DeepSeekProviderConfig {
  return { ...DEFAULT_CONFIG.deepseek, apiKey: 'sk-test', ...over };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('DeepSeek 供应商', () => {
  it('默认配置指向官方端点与 deepseek-chat', () => {
    expect(DEFAULT_CONFIG.deepseek.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(DEFAULT_CONFIG.deepseek.model).toBe('deepseek-chat');
  });

  it('缺 API Key 时直接给出可照做的提示，不发请求', async () => {
    const fetchImpl = vi.fn();
    const provider = new DeepSeekProvider(makeCfg({ apiKey: '' }), fetchImpl as never);
    await expect(provider.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toThrow(
      /API Key/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('请求打到 /chat/completions 并带上 Bearer 头', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ model: 'deepseek-chat', choices: [{ message: { content: 'ok' } }] }),
    );
    const provider = new DeepSeekProvider(makeCfg(), fetchImpl as never);
    const res = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });

    expect(res.content).toBe('ok');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test');
  });

  it('reasoner 模型不发 response_format，避免 400', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ choices: [{ message: { content: '{"tldr":"x"}' } }] }),
    );
    const provider = new DeepSeekProvider(makeCfg({ model: 'deepseek-reasoner' }), fetchImpl as never);
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], json: true });

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.response_format).toBeUndefined();
    expect(body.model).toBe('deepseek-reasoner');
  });

  it('普通模型保留 JSON 模式', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({ choices: [{ message: { content: '{"tldr":"x"}' } }] }),
    );
    const provider = new DeepSeekProvider(makeCfg(), fetchImpl as never);
    await provider.chat({ messages: [{ role: 'user', content: 'hi' }], json: true });

    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('DeepSeek 错误翻译', () => {
  it('401 说清是 Key 无效', () => {
    expect(translateDeepSeekError('HTTP 401: Authentication Fails')).toMatch(/API Key 无效/);
  });

  it('402 说清是余额不足', () => {
    expect(translateDeepSeekError('HTTP 402: Insufficient Balance')).toMatch(/余额不足/);
  });

  it('429 说清是限流', () => {
    expect(translateDeepSeekError('HTTP 429: Rate limit reached')).toMatch(/限流/);
  });

  it('无关错误原样返回', () => {
    expect(translateDeepSeekError('network timeout')).toBe('network timeout');
  });
});

describe('whisper 退出码翻译', () => {
  it('0xC0000139 指向 DLL 损坏而不是 API Key', () => {
    const text = describeExitCode(3221225785);
    expect(text).toContain('0xC0000139');
    expect(text).toMatch(/DLL/);
    expect(text).toMatch(/ggml-base\.dll/);
  });

  it('0xC0000005 提示重装与杀软排查', () => {
    expect(describeExitCode(3221225477)).toMatch(/访问冲突/);
  });

  it('未收录的退出码只回传输出内容', () => {
    expect(describeExitCode(1, 'bad args')).toBe('：bad args');
  });
});

describe('供应商模型画像', () => {
  it('DeepSeek 用自己那一套模型名与预算', () => {
    const cfg = { ...DEFAULT_CONFIG, deepseek: { ...DEFAULT_CONFIG.deepseek, model: 'deepseek-reasoner', contextChars: 9000 } };
    expect(resolveModelProfile(cfg, 'deepseek')).toEqual({
      model: 'deepseek-reasoner',
      contextChars: 9000,
    });
  });

  it('OpenAI 与 Ollama 各用各自配置', () => {
    expect(resolveModelProfile(DEFAULT_CONFIG, 'openai').model).toBe('gpt-4o-mini');
    expect(resolveModelProfile(DEFAULT_CONFIG, 'ollama').contextChars).toBe(8000);
  });

  it('选 DeepSeek 但没填 Key 时校验会报出来', () => {
    const cfg = { ...DEFAULT_CONFIG, llmProvider: 'deepseek' as const };
    expect(validateConfig(cfg).join('；')).toMatch(/DeepSeek 的 API Key 为空/);
  });
});
