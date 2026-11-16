/** 时间戳格式化工具。 */

/** 秒 -> HH:MM:SS（不足一小时为 MM:SS）。 */
export function formatTimestamp(seconds: number, forceHours = false): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (h > 0 || forceHours) return `${pad(h)}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

/** 秒 -> `1小时23分` / `23分05秒` 形式的中文时长。 */
export function formatDurationCn(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}小时${String(m).padStart(2, '0')}分`;
  if (m > 0) return `${m}分${String(sec).padStart(2, '0')}秒`;
  return `${sec}秒`;
}

/** 秒 -> SRT 时间戳 `00:00:00,000`。 */
export function toSrtTimestamp(seconds: number): string {
  // 先取整到毫秒再拆分，避免 0.9996 这类值四舍五入后产生非法的 `,1000`。
  const totalMs = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds * 1000)) : 0;
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const sec = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(sec)},${pad(ms, 3)}`;
}

/** Unix 时间戳(秒) -> 本地可读日期。 */
export function formatDate(unixSeconds: number): string {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
