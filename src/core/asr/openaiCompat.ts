/**
 * OpenAI 兼容的语音转写供应商。
 *
 * 兼容 OpenAI / Groq / SiliconFlow / 阿里云 DashScope 等实现了
 * `/audio/transcriptions` 且支持 `verbose_json` 的服务。
 */
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import type { AppConfig, AsrProvider, AsrResult, TranscriptSegment } from '../types.js';
import { cleanSubtitleText } from '../utils/text.js';

export class OpenAiAsrProvider implements AsrProvider {
  readonly kind = 'openai' as const;
  readonly name: string;

  private readonly cfg: AppConfig['openaiAsr'];
  private readonly fetchImpl: typeof fetch;
  private readonly timeout: number;

  constructor(cfg: AppConfig['openaiAsr'], fetchImpl: typeof fetch = fetch, timeout = 600000) {
    this.cfg = cfg;
    this.fetchImpl = fetchImpl;
    this.timeout = timeout;
    this.name = `OpenAI 兼容 ASR (${cfg.model})`;
  }

  async transcribe(audioPath: string, opts: { signal?: AbortSignal } = {}): Promise<AsrResult> {
    // 请求发出前就已被取消
    if (opts.signal?.aborted) throw new Error('转写已取消');

    const form = new FormData();
    const blob = await openAsBlob(audioPath, { type: 'audio/wav' });
    form.append('file', blob, basename(audioPath));
    form.append('model', this.cfg.model);
    form.append('response_format', 'verbose_json');
    if (this.cfg.language) form.append('language', this.cfg.language);
    form.append('timestamp_granularities[]', 'segment');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const headers: Record<string, string> = {};
      if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;

      const base = (this.cfg.baseUrl || '').replace(/\/+$/, '');
      const res = await this.fetchImpl(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      }

      const json = JSON.parse(text);
      const segments: TranscriptSegment[] = (json.segments || [])
        .map((s: any) => ({
          start: Number(s.start ?? 0),
          end: Number(s.end ?? s.start ?? 0),
          text: cleanSubtitleText(String(s.text ?? '')),
        }))
        .filter((s: TranscriptSegment) => s.text);

      if (!segments.length) {
        // 有些服务只返回纯文本，按整段处理
        const plain = String(json.text ?? '').trim();
        if (plain) {
          segments.push({ start: 0, end: Number(json.duration ?? 0), text: plain });
        }
      }

      return {
        segments,
        language: json.language,
        model: this.cfg.model,
      };
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        if (opts.signal?.aborted) throw new Error('转写已取消');
        throw new Error(`转写超时（${Math.round(this.timeout / 1000)}s）`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  async healthCheck(): Promise<{ ok: boolean; message: string }> {
    if (!this.cfg.baseUrl) return { ok: false, message: 'ASR 接口地址为空' };
    if (!this.cfg.model) return { ok: false, message: 'ASR 模型名为空' };
    const base = (this.cfg.baseUrl || '').replace(/\/+$/, '');
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const headers: Record<string, string> = {};
        if (this.cfg.apiKey) headers.Authorization = `Bearer ${this.cfg.apiKey}`;
        const res = await this.fetchImpl(`${base}/models`, { headers, signal: controller.signal });
        if (!res.ok) {
          return { ok: false, message: `接口不可达：HTTP ${res.status}` };
        }
        const json = await res.json().catch(() => null);
        const models: string[] = json?.data?.map((m: any) => m.id) ?? [];
        if (models.length && !models.includes(this.cfg.model)) {
          return {
            ok: false,
            message: `模型 ${this.cfg.model} 不可用。可用：${models.slice(0, 8).join(', ')}`,
          };
        }
        return { ok: true, message: '连接正常' };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return { ok: false, message: '连接超时' };
      return { ok: false, message: `连接失败：${(err as Error).message}` };
    }
  }
}
