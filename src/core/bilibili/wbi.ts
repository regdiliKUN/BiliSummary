/**
 * B 站 WBI 签名。
 *
 * 部分接口（`x/player/wbi/v2`、`view/conclusion/get` 等）要求在 query 中附带
 * `wts`（秒级时间戳）与 `w_rid`（由参数与 mixinKey 计算出的 MD5）。
 */
import { createHash } from 'node:crypto';

/** 官方固定的打乱表，用于从 img_key + sub_key 派生 mixinKey。 */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
] as const;

/** 取 URL 路径最后一个 `/` 之后、`扩展名` 之前的部分。 */
export function extractKey(url: string): string {
  const path = url.slice(url.lastIndexOf('/') + 1);
  const dot = path.indexOf('.');
  return dot === -1 ? path : path.slice(0, dot);
}

/** 由 img_key 与 sub_key 派生 32 位 mixinKey。 */
export function getMixinKey(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let out = '';
  for (const idx of MIXIN_KEY_ENC_TAB) {
    out += raw[idx] ?? '';
    if (out.length >= 32) break;
  }
  return out.slice(0, 32);
}

/** 过滤掉 value 中 `!'()*` 五个字符，并按 key 升序拼接。 */
function sanitizeAndSort(params: Record<string, string | number | undefined>): string {
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    cleaned[k] = String(v).replace(/[!'()*]/g, '');
  }
  return Object.keys(cleaned)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(cleaned[k]!)}`)
    .join('&');
}

/** 计算 `w_rid`。 */
export function signParams(
  params: Record<string, string | number | undefined>,
  mixinKey: string,
  wts: number,
): { signedQuery: string; wts: number } {
  const withTs = { ...params, wts };
  const query = sanitizeAndSort(withTs);
  const w_rid = createHash('md5').update(query + mixinKey).digest('hex');
  return { signedQuery: `${query}&w_rid=${w_rid}`, wts };
}
