/**
 * B 站 API 客户端。
 *
 * 覆盖：视频信息、分P、官方字幕、官方 AI 总结、音频直链、弹幕。
 * 所有请求统一带上桌面浏览器 UA 与 Referer，避免被风控拦下。
 */
import { createHash } from 'node:crypto';
import type {
  CollectionEpisode,
  DanmakuItem,
  Transcript,
  TranscriptSegment,
  VideoCollection,
  VideoInfo,
  VideoPart,
  VideoStat,
} from '../types.js';
import { cleanSubtitleText, normalizeText } from '../utils/text.js';
import { extractKey, getMixinKey, signParams } from './wbi.js';

const API_BASE = 'https://api.bilibili.com';
const WEB_BASE = 'https://www.bilibili.com';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

/**
 * 备用 UA 列表。
 *
 * B 站的风控会校验 UA 声明的浏览器与实际 TLS 指纹是否一致：
 * Node 的 TLS 指纹配上 Chrome 的 UA 会被判定为爬虫并返回 412。
 * 因此一旦遇到 412，就降级到中性的 UA 重试。
 */
const FALLBACK_USER_AGENTS = [
  'curl/8.4.0',
  'BiliSummary/0.1 (https://github.com/bili-summary)',
];

export class BilibiliError extends Error {
  readonly code: number;
  readonly url: string;

  constructor(message: string, code = -1, url = '') {
    super(message);
    this.name = 'BilibiliError';
    this.code = code;
    this.url = url;
  }
}

/** B 站接口错误码 -> 可读提示。 */
const CODE_MESSAGES: Record<number, string> = {
  [-400]: '请求参数错误',
  [-403]: '访问权限不足（通常需要登录或触发风控）',
  [-404]: '内容不存在',
  [-101]: '账号未登录，请先在设置中登录 B 站',
  [-111]: 'csrf 校验失败',
  [-352]: '风控校验失败，请稍后重试或更换网络',
  62002: '视频不可见（可能需要大会员或已被删除）',
  62004: '稿件审核中',
  62012: '仅 UP 主自己可见',
};

/** 从 URL / 输入串中解析视频标识。 */
export interface ParsedInput {
  bvid?: string;
  aid?: number;
  /** 短链需要跟随重定向才能确定 */
  shortUrl?: string;
  /** URL 中的 p 参数 */
  page?: number;
}

export function parseVideoInput(input: string): ParsedInput {
  const raw = (input || '').trim();
  if (!raw) throw new BilibiliError('请输入视频链接或 BV/av 号');

  const bvidMatch = raw.match(/BV[0-9A-Za-z]{10}/);
  if (bvidMatch) {
    const pageMatch = raw.match(/[?&]p=(\d+)/);
    return { bvid: bvidMatch[0], page: pageMatch ? Number(pageMatch[1]) : undefined };
  }

  // av 号：av170001 / /video/av170001 / 纯数字
  const avMatch = raw.match(/(?:^|\/)av(\d+)/i) ?? raw.match(/^(\d+)$/);
  if (avMatch) {
    const pageMatch = raw.match(/[?&]p=(\d+)/);
    return { aid: Number(avMatch[1]), page: pageMatch ? Number(pageMatch[1]) : undefined };
  }

  if (/b23\.tv|bili2233\.cn/i.test(raw)) {
    const pageMatch = raw.match(/[?&]p=(\d+)/);
    return { shortUrl: raw, page: pageMatch ? Number(pageMatch[1]) : undefined };
  }

  throw new BilibiliError(`无法识别的视频标识：${raw}`);
}

interface RawSubtitle {
  id: number;
  lan: string;
  lan_doc: string;
  subtitle_url: string;
  type?: number;
  ai_status?: number;
  author?: { name?: string };
}

interface RawSegment {
  from?: number;
  to?: number;
  content?: string;
  start?: number;
  end?: number;
  text?: string;
}

export interface BilibiliClientOptions {
  /** 完整的 Cookie 字符串，包含 SESSDATA 等 */
  cookie?: string;
  /** 自定义 UA */
  userAgent?: string;
  /** 请求超时（毫秒） */
  timeout?: number;
  /** 自定义 fetch 实现（测试用） */
  fetchImpl?: typeof fetch;
}

export class BilibiliClient {
  private cookie: string;
  private readonly ua: string;
  private readonly timeout: number;
  private readonly fetchImpl: typeof fetch;
  private mixinKeyCache: { key: string; expires: number } | null = null;
  /** 风控设备指纹 cookie（buvid3 / buvid4） */
  private buvid: { buvid3: string; buvid4: string } | null = null;
  private buvidPromise: Promise<void> | null = null;
  /** 当前使用的 UA 序号，0 为浏览器 UA，后续为降级 UA */
  private uaIndex = 0;

  constructor(opts: BilibiliClientOptions = {}) {
    this.cookie = opts.cookie?.trim() || '';
    this.ua = opts.userAgent || DEFAULT_UA;
    this.timeout = opts.timeout ?? 15000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * 更新 Cookie（登录/退出后调用）。
   * 保留 buvid 与 WBI 缓存，避免每次都重新握手。
   */
  setCookie(cookie: string): void {
    this.cookie = (cookie || '').trim();
  }

  /** 当前生效的 UA。 */
  private get currentUa(): string {
    if (this.uaIndex === 0) return this.ua;
    // 下标越界时回退到最后一个备选，避免发出 "undefined" 的 UA
    return FALLBACK_USER_AGENTS[Math.min(this.uaIndex, FALLBACK_USER_AGENTS.length) - 1]!;
  }

  /** 当前是否已携带登录态。 */
  get hasLogin(): boolean {
    return this.getCookieValue('SESSDATA').length > 0;
  }

  /** 从 Cookie 串中取出某个字段。 */
  getCookieValue(name: string): string {
    const match = this.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]!) : '';
  }
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': this.currentUa,
      Referer: `${WEB_BASE}/`,
      Origin: WEB_BASE,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...extra,
    };
    const parts: string[] = [];
    if (this.buvid) {
      parts.push(`buvid3=${this.buvid.buvid3}`, `buvid4=${this.buvid.buvid4}`);
    }
    if (this.cookie) parts.push(this.cookie);
    if (parts.length) h.Cookie = parts.join('; ');
    return h;
  }

  /**
   * 获取设备指纹 cookie。
   *
   * B 站的多数接口在没有 buvid3 时会返回 412（风控），必须先握手一次。
   */
  async ensureBuvid(force = false): Promise<void> {
    if (this.buvid && !force) return;
    if (this.buvidPromise && !force) return this.buvidPromise;

    this.buvidPromise = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const res = await this.fetchImpl(`${API_BASE}/x/frontend/finger/spi`, {
          method: 'GET',
          headers: {
            'User-Agent': this.currentUa,
            Referer: `${WEB_BASE}/`,
            Origin: WEB_BASE,
          },
          signal: controller.signal,
        });
        if (!res.ok) return;
        const json: any = await res.json().catch(() => null);
        const b3 = json?.data?.b_3;
        const b4 = json?.data?.b_4;
        if (b3) {
          this.buvid = { buvid3: String(b3), buvid4: String(b4 || '') };
        }
      } catch {
        /* 拿不到就按没有处理，后续请求可能 412 */
      } finally {
        clearTimeout(timer);
        this.buvidPromise = null;
      }
    })();

    return this.buvidPromise;
  }

  /** 发起一次 GET 并解析 B 站标准响应结构。 */
  private async getJson<T = unknown>(
    url: string,
    extraHeaders: Record<string, string> = {},
    raw = false,
    signal?: AbortSignal,
  ): Promise<T> {
    // 首次请求前先握手拿 buvid3，否则大概率 412
    await this.ensureBuvid();

    const maxAttempts = FALLBACK_USER_AGENTS.length + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await this.getJsonOnce<T>(url, extraHeaders, raw, signal);
        // 成功即恢复首选 UA（此前的降级只针对那一次风控）
        this.uaIndex = 0;
        return result;
      } catch (err) {
        lastError = err;
        // 412 = 风控：换一个 UA 并刷新指纹后重试
        if (err instanceof BilibiliError && err.code === 412 && attempt < maxAttempts - 1) {
          this.uaIndex = Math.min(this.uaIndex + 1, FALLBACK_USER_AGENTS.length);
          await this.ensureBuvid(true);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  private async getJsonOnce<T = unknown>(
    url: string,
    extraHeaders: Record<string, string> = {},
    raw = false,
    signal?: AbortSignal,
  ): Promise<T> {
    const body = await this.fetchJsonOnce(url, extraHeaders, signal);
    if (raw) return body as unknown as T;
    const json = body as any;
    if (json.code !== 0) {
      const msg = CODE_MESSAGES[json.code] || json.message || `未知错误码 ${json.code}`;
      throw new BilibiliError(msg, json.code, url);
    }
    return json.data as T;
  }

  /** 拿到完整的 JSON 响应体，不校验 code。 */
  private async fetchJsonOnce(
    url: string,
    extraHeaders: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    // 请求发出前就已经被取消
    if (signal?.aborted) {
      clearTimeout(timer);
      throw new BilibiliError('请求已取消', -2, url);
    }
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: this.headers(extraHeaders),
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok) {
        throw new BilibiliError(`HTTP ${res.status} ${res.statusText}`, res.status, url);
      }
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new BilibiliError('接口返回了非 JSON 内容', -1, url);
      }
    } catch (err) {
      if (err instanceof BilibiliError) throw err;
      if ((err as Error).name === 'AbortError') {
        if (signal?.aborted) throw new BilibiliError('请求已取消', -2, url);
        throw new BilibiliError('请求超时', -1, url);
      }
      throw new BilibiliError(`网络请求失败：${(err as Error).message}`, -1, url);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * 请求不校验 code 的接口（nav 在未登录时返回 -101，但 data 依然有效）。
   */
  private async getJsonLoose<T = unknown>(
    url: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    await this.ensureBuvid();
    const maxAttempts = FALLBACK_USER_AGENTS.length + 1;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const body = (await this.fetchJsonOnce(url, extraHeaders)) as any;
        if (body?.code === 412) throw new BilibiliError('风控', 412, url);
        this.uaIndex = 0;
        return (body?.data ?? body) as T;
      } catch (err) {
        lastError = err;
        if (err instanceof BilibiliError && err.code === 412 && attempt < maxAttempts - 1) {
          this.uaIndex = Math.min(this.uaIndex + 1, FALLBACK_USER_AGENTS.length);
          await this.ensureBuvid(true);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /** 获取（并缓存）mixinKey，用于 WBI 签名。 */
  async getMixinKey(force = false): Promise<string> {
    if (!force && this.mixinKeyCache && this.mixinKeyCache.expires > Date.now()) {
      return this.mixinKeyCache.key;
    }
    // nav 接口未登录时返回 -101，但 data.wbi_img 依然有效，所以不能用严格校验
    const data = await this.getJsonLoose<{ wbi_img?: { img_url: string; sub_url: string } }>(
      `${API_BASE}/x/web-interface/nav`,
    );
    if (!data?.wbi_img?.img_url) {
      throw new BilibiliError('无法获取 WBI 签名密钥', -1, `${API_BASE}/x/web-interface/nav`);
    }
    const key = getMixinKey(extractKey(data.wbi_img.img_url), extractKey(data.wbi_img.sub_url));
    // 官方建议缓存约 30 分钟
    this.mixinKeyCache = { key, expires: Date.now() + 30 * 60 * 1000 };
    return key;
  }

  /** 带 WBI 签名的 GET。 */
  private async getJsonWbi<T = unknown>(
    path: string,
    params: Record<string, string | number | undefined>,
    signal?: AbortSignal,
  ): Promise<T> {
    const mixinKey = await this.getMixinKey();
    const { signedQuery } = signParams(params, mixinKey, Math.floor(Date.now() / 1000));
    return this.getJson<T>(`${API_BASE}${path}?${signedQuery}`, {}, false, signal);
  }

  /** 解析短链 / 普通链接，拿到 bvid 与 aid。 */
  async resolve(input: string): Promise<{ bvid: string; aid: number; page?: number }> {
    let parsed = parseVideoInput(input);

    if (parsed.shortUrl) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      try {
        const res = await this.fetchImpl(parsed.shortUrl, {
          method: 'GET',
          headers: this.headers(),
          signal: controller.signal,
          redirect: 'follow',
        });
        const finalUrl = res.url || parsed.shortUrl;
        parsed = parseVideoInput(finalUrl);
      } catch {
        throw new BilibiliError('短链解析失败，请直接使用完整的 bilibili.com 链接', -1, parsed.shortUrl);
      } finally {
        clearTimeout(timer);
      }
    }

    if (parsed.bvid) {
      const data = await this.getJson<{ aid: number }>(
        `${API_BASE}/x/web-interface/view?bvid=${parsed.bvid}`,
      );
      return { bvid: parsed.bvid, aid: data.aid, page: parsed.page };
    }

    if (parsed.aid) {
      const data = await this.getJson<{ bvid: string }>(
        `${API_BASE}/x/web-interface/view?aid=${parsed.aid}`,
      );
      return { bvid: data.bvid, aid: parsed.aid, page: parsed.page };
    }

    throw new BilibiliError('无法解析视频标识');
  }

  /** 获取视频基本信息。 */
  async getVideoInfo(bvid: string): Promise<VideoInfo> {
    const data = await this.getJson<any>(`${API_BASE}/x/web-interface/view?bvid=${bvid}`);
    const parts: VideoPart[] = (data.pages || []).map((p: any, i: number) => ({
      cid: p.cid,
      page: p.page ?? i + 1,
      title: p.part || `P${i + 1}`,
      duration: p.duration || 0,
    }));

    const stat: VideoStat = {
      view: data.stat?.view ?? 0,
      danmaku: data.stat?.danmaku ?? 0,
      reply: data.stat?.reply ?? 0,
      favorite: data.stat?.favorite ?? 0,
      coin: data.stat?.coin ?? 0,
      share: data.stat?.share ?? 0,
      like: data.stat?.like ?? 0,
    };

    // 合集信息（B 站「合集」= ugc_season）。绝大多数情况一次就能拿全，
    // 超大合集只返回前 N 集，需要再用 archives 接口补齐。
    let collection = this.parseSeason(data.ugc_season);
    if (collection && !collection.complete) {
      collection = await this.fillSeason(collection);
    }

    return {
      bvid: data.bvid,
      aid: data.aid,
      cid: data.cid,
      title: data.title,
      desc: data.desc || '',
      // B 站的部分图片 URL 是 http://，渲染层的 CSP 只放行 https://，这里统一升级
      cover: toHttps(data.pic || ''),
      duration: data.duration || parts[0]?.duration || 0,
      pubdate: data.pubdate || 0,
      owner: {
        mid: data.owner?.mid ?? 0,
        name: data.owner?.name ?? '未知UP主',
        face: toHttps(data.owner?.face || ''),
      },
      stat,
      parts,
      url: `${WEB_BASE}/video/${data.bvid}`,
      rawUrl: `${WEB_BASE}/video/${data.bvid}/`,
      collection,
    };
  }

  /** 把 view 接口返回的 ugc_season 转成内部的合集结构。 */
  private parseSeason(raw: any): VideoCollection | null {
    if (!raw || typeof raw !== 'object') return null;
    const sections = Array.isArray(raw.sections) ? raw.sections : [];
    const episodes: CollectionEpisode[] = [];

    for (const section of sections) {
      const list = Array.isArray(section?.episodes) ? section.episodes : [];
      for (const ep of list) {
        const bvid = ep?.bvid;
        if (!bvid) continue;
        const arc = ep?.arc ?? {};
        episodes.push({
          bvid: String(bvid),
          aid: Number(ep?.aid ?? arc.aid ?? 0),
          cid: Number(ep?.cid ?? ep?.page?.cid ?? 0) || undefined,
          title: String(arc.title || ep?.title || bvid),
          duration: Number(arc.duration ?? ep?.page?.duration ?? 0) || 0,
          cover: toHttps(String(arc.pic || '')),
          pubdate: Number(arc.pubdate ?? 0) || 0,
          section: section?.title ? String(section.title) : undefined,
          index: episodes.length + 1,
        });
      }
    }

    if (!episodes.length) return null;
    const total = Number(raw.ep_count) || episodes.length;
    return {
      id: Number(raw.id) || 0,
      title: String(raw.title || '未命名合集'),
      cover: toHttps(String(raw.cover || '')),
      mid: Number(raw.mid) || 0,
      intro: String(raw.intro || ''),
      total,
      episodes,
      complete: episodes.length >= total,
    };
  }

  /** 合集集数超过 view 接口返回上限时，用 archives 接口分页补齐。 */
  private async fillSeason(collection: VideoCollection): Promise<VideoCollection> {
    if (!collection.mid || !collection.id) return collection;

    const seen = new Set(collection.episodes.map((ep) => ep.bvid));
    const merged = collection.episodes.slice();
    const pageSize = 30;

    for (let page = 1; page <= 30; page += 1) {
      if (merged.length >= collection.total) break;
      let archives: any[] = [];
      try {
        const data = await this.getJson<any>(
          `${API_BASE}/x/polymer/web-space/seasons_archives_list` +
            `?mid=${collection.mid}&season_id=${collection.id}&page_num=${page}&page_size=${pageSize}`,
        );
        archives = Array.isArray(data?.archives) ? data.archives : [];
      } catch (err) {
        console.warn(`合集分页补齐失败（第 ${page} 页）：${(err as Error).message}`);
        break;
      }
      if (!archives.length) break;

      for (const item of archives) {
        const bvid = item?.bvid;
        if (!bvid || seen.has(bvid)) continue;
        seen.add(bvid);
        merged.push({
          bvid: String(bvid),
          aid: Number(item?.aid ?? 0),
          title: String(item?.title || bvid),
          duration: Number(item?.duration ?? 0) || 0,
          cover: toHttps(String(item?.pic || '')),
          pubdate: Number(item?.pubdate ?? 0) || 0,
          index: merged.length + 1,
        });
      }
      if (archives.length < pageSize) break;
    }

    return { ...collection, episodes: merged, complete: merged.length >= collection.total };
  }

  /**
   * 获取官方字幕（CC / AI 字幕）。
   * 需要登录态；返回 null 表示该视频没有可用字幕。
   */
  async getSubtitles(
    bvid: string,
    cid: number,
    aid?: number,
    signal?: AbortSignal,
  ): Promise<Transcript | null> {
    const params = { bvid, cid, aid: aid ?? 0 };
    let data: any;
    try {
      data = await this.getJsonWbi<any>('/x/player/wbi/v2', params, signal);
    } catch (err) {
      // 取消时不要回退，直接抛出
      if (err instanceof BilibiliError && err.code === -2) throw err;
      // 回退到旧接口
      data = await this.getJson<any>(
        `${API_BASE}/x/player/v2?bvid=${bvid}&cid=${cid}`,
        {},
        false,
        signal,
      );
    }

    const list: RawSubtitle[] = data?.subtitle?.subtitles || [];
    if (!list.length) return null;

    // 优先中文，其次其它
    const sorted = [...list].sort((a, b) => {
      const score = (s: RawSubtitle) =>
        (s.lan === 'zh-CN' || s.lan === 'zh-Hans' ? 0 : s.lan?.startsWith('zh') ? 1 : 2);
      return score(a) - score(b);
    });

    for (const sub of sorted) {
      if (!sub.subtitle_url) continue;
      const url = sub.subtitle_url.startsWith('//')
        ? `https:${sub.subtitle_url}`
        : sub.subtitle_url;
      try {
        const payload = await this.getJson<{ body?: RawSegment[] }>(url, {
          Referer: `${WEB_BASE}/video/${bvid}`,
        });
        const segments = this.normalizeSubtitleBody(payload.body);
        if (segments.length) {
          return {
            source: 'subtitle',
            language: sub.lan,
            lan: sub.lan,
            segments,
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /** 把官方字幕的 body 结构转成统一 segment。 */
  private normalizeSubtitleBody(body?: RawSegment[]): TranscriptSegment[] {
    if (!body?.length) return [];
    const out: TranscriptSegment[] = [];
    for (const item of body) {
      const start = item.from ?? item.start ?? 0;
      const end = item.to ?? item.end ?? start;
      const text = cleanSubtitleText(item.content ?? item.text ?? '');
      if (!text) continue;
      out.push({ start, end: Math.max(end, start), text });
    }
    return out;
  }

  /** B 站官方 AI 总结（conclusion 接口）。 */
  async getBuiltinSummary(
    bvid: string,
    cid: number,
    upMid: number,
    signal?: AbortSignal,
  ): Promise<{ summary: string; outline: { start: number; end: number; title: string }[] } | null> {
    let data: any;
    try {
      data = await this.getJsonWbi<any>(
        '/x/web-interface/view/conclusion/get',
        {
          bvid,
          cid,
          up_mid: upMid,
        },
        signal,
      );
    } catch (err) {
      if (err instanceof BilibiliError) {
        if (err.code === -404) return null;
        if (err.code === -101) {
          throw new BilibiliError(
            'B 站官方 AI 总结需要登录后才能获取，请先在设置中登录 B 站。',
            err.code,
            err.url,
          );
        }
      }
      throw err;
    }

    const model = data?.model_result;
    if (!model) return null;

    const summary = normalizeText(String(model.summary ?? ''));
    const outline = (model.outline || [])
      .map((o: any) => ({
        start: Number(o.timestamp_start ?? 0),
        end: Number(o.timestamp_end ?? 0),
        title: String(o.title ?? '').trim(),
      }))
      .filter((o: any) => o.title);

    // model_result 存在但内容为空是常见情况（视频没有官方总结），
    // 这时要明确返回 null，否则会被当成"有官方总结"却拿不到任何内容。
    if (!summary && !outline.length) return null;

    return { summary, outline };
  }

  /**
   * 获取音频直链（DASH）。
   * 返回按优先级排序的候选地址，下载时逐个尝试（CDN 可能有多个可用节点）。
   */
  async getAudioUrls(bvid: string, cid: number, aid?: number): Promise<string[]> {
    const params = new URLSearchParams({
      bvid,
      cid: String(cid),
      qn: '80',
      fnval: '4048',
      fourk: '1',
    });
    if (aid) params.set('avid', String(aid));

    const data = await this.getJson<any>(
      `${API_BASE}/x/player/playurl?${params.toString()}`,
      { Referer: `${WEB_BASE}/video/${bvid}/` },
    );

    const dash = data?.dash;
    const audioList: any[] = [
      ...(dash?.flac?.audio || []),
      ...(dash?.dolby?.audio || []),
      ...(dash?.audio || []),
    ];

    const urls: string[] = [];

    if (audioList.length) {
      // 码率高的优先
      audioList.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
      for (const item of audioList) {
        const primary = item.baseUrl || item.base_url;
        if (primary) urls.push(primary);
        for (const backup of item.backupUrl || item.backup_url || []) {
          if (backup) urls.push(backup);
        }
      }
    }

    if (!urls.length) {
      // 老接口：直接拿 mp4（内含音轨）
      const durl = await this.getJson<any>(
        `${API_BASE}/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=64&fnval=1&platform=html5`,
        { Referer: `${WEB_BASE}/video/${bvid}/` },
      );
      const url = durl?.durl?.[0]?.url;
      if (!url) throw new BilibiliError('未找到可用的音频流');
      urls.push(url);
    }

    return [...new Set(urls)];
  }

  /** 获取音频直链（取第一个候选）。 */
  async getAudioUrl(bvid: string, cid: number, aid?: number): Promise<string> {
    const urls = await this.getAudioUrls(bvid, cid, aid);
    return urls[0]!;
  }

  /** 下载二进制内容（音频等）。 */
  async downloadBinary(
    url: string,
    referer: string,
    signal?: AbortSignal,
    timeout = 300000,
  ): Promise<Buffer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      clearTimeout(timer);
      throw new BilibiliError('下载已取消', -2, url);
    }
    try {
      const res = await this.fetchImpl(url, {
        headers: { 'User-Agent': this.currentUa, Referer: referer, Origin: WEB_BASE },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new BilibiliError(
          res.status === 403
            ? '音频 CDN 拒绝访问（HTTP 403）。通常意味着当前网络所在地区无法访问 B 站媒体服务器，可尝试切换网络或代理。'
            : `下载失败 HTTP ${res.status}`,
          res.status,
          url,
        );
      }
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (err instanceof BilibiliError) throw err;
      if ((err as Error).name === 'AbortError') {
        if (signal?.aborted) throw new BilibiliError('下载已取消', -2, url);
        throw new BilibiliError(
          `下载超时（${Math.round(timeout / 1000)}s），网络过慢或文件过大`,
          -1,
          url,
        );
      }
      throw new BilibiliError(`下载失败：${(err as Error).message}`, -1, url);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** 获取弹幕（XML 协议，需解压）。 */
  async getDanmaku(oid: number, limit = 0): Promise<DanmakuItem[]> {
    const { gunzipSync, inflateSync, unzipSync } = await import('node:zlib');
    const url = `${API_BASE}/x/v1/dm/list.so?oid=${oid}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let buf: Buffer;
    try {
      const res = await this.fetchImpl(url, {
        headers: this.headers({ Accept: 'application/xml, text/xml' }),
        signal: controller.signal,
      });
      if (!res.ok) throw new BilibiliError(`弹幕获取失败 HTTP ${res.status}`, res.status);
      buf = Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }

    let xml = '';
    try {
      xml = buf.toString('utf8');
    } catch {
      xml = '';
    }
    if (!xml.includes('<d ')) {
      // 尝试常见的压缩格式
      for (const fn of [gunzipSync, inflateSync, unzipSync]) {
        try {
          const out = fn(buf).toString('utf8');
          if (out.includes('<d ')) {
            xml = out;
            break;
          }
        } catch {
          /* 试下一个 */
        }
      }
    }

    const items: DanmakuItem[] = [];
    const re = /<d\s+p="([^"]+)"[^>]*>([\s\S]*?)<\/d>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const attrs = m[1]!.split(',');
      const time = Number(attrs[0] || 0);
      const mode = Number(attrs[1] || 1);
      const text = decodeEntities(m[2] || '').trim();
      if (!text) continue;
      items.push({
        time,
        text,
        mode,
        color: Number(attrs[4] || 16777215),
        pool: '0',
      });
    }

    items.sort((a, b) => a.time - b.time);
    return limit > 0 ? items.slice(0, limit) : items;
  }

  /** 校验 Cookie 是否可用（返回登录用户名或错误信息）。 */
  async checkLogin(): Promise<{ ok: boolean; user: string; message: string }> {
    if (!this.hasLogin) {
      return { ok: false, user: '', message: '未配置 SESSDATA Cookie' };
    }
    try {
      const data = await this.getJsonLoose<{ isLogin?: boolean; uname?: string }>(
        `${API_BASE}/x/web-interface/nav`,
      );
      if (data?.isLogin) {
        return { ok: true, user: data.uname || '已登录', message: '登录态有效' };
      }
      return { ok: false, user: '', message: 'Cookie 已失效，请重新登录' };
    } catch (err) {
      return { ok: false, user: '', message: (err as Error).message };
    }
  }

  /** 计算 wbi 签名（导出供测试）。 */
  static sign(params: Record<string, string | number | undefined>, mixinKey: string): string {
    return signParams(params, mixinKey, Math.floor(Date.now() / 1000)).signedQuery;
  }
}

/** 把 http:// 升级为 https://（B 站图片在混合内容下会被浏览器拦截）。 */
function toHttps(url: string): string {
  return url.startsWith('http://') ? `https://${url.slice(7)}` : url;
}

/** 解码弹幕里的 HTML 实体。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
