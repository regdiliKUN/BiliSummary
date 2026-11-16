/** 跨主进程与渲染进程复用的输入边界与状态判定工具。 */

/** 视频级并发数：界面、配置、调度器统一到 1-6。 */
export function clampVideoConcurrency(value: unknown, fallback = 2): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(6, Math.max(1, Math.trunc(n)));
}

/** 任务进度百分比统一到 0-100。 */
export function clampTaskPercent(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

/** 已结束的任务状态：迟到的进度事件不能把它们改回运行中。 */
export function isSettledStatus(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'cancelled' || status === 'skipped';
}

/** 同一视频同一分P 在队列/去重中的稳定键。 */
export function videoKey(bvid: string, part: number): string {
  return `${bvid.trim().toLowerCase()}#${Number.isFinite(part) && part > 0 ? Math.trunc(part) : 1}`;
}

/** IPC 任务 ID：只允许渲染进程自身生成的简单标识。 */
export function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

/** 视频链接：拒绝超长串、非 http(s) 与带凭据的 URL。 */
export function isSafeTaskUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return false;
  try {
    const url = new URL(value.trim());
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** 系统浏览器外链校验；规则比任务链接更保守。 */
export function isSafeExternalUrl(value: unknown): value is string {
  return isSafeTaskUrl(value);
}

/** 导出文件名：不接受路径、控制字符与 Windows 保留字符。 */
export function isSafeFileName(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 180) return false;
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/.test(value)) return false;
  return value.trim() !== '.' && value.trim() !== '..';
}
