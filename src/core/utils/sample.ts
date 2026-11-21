/** 列表抽样工具。 */

/**
 * 从有序列表里沿下标均匀抽取至多 limit 个元素。
 *
 * 保持原顺序，首尾元素一定会被选中；列表不超过 limit 时原样返回副本。
 * 用于弹幕这类按时间排好序的数据：截头只会留下开头那一段，均匀抽样才能覆盖整条时间轴。
 */
export function sampleEvenly<T>(items: readonly T[], limit: number): T[] {
  const n = items.length;
  const k = Math.floor(limit);
  if (!(k > 0) || n <= k) return items.slice();
  if (k === 1) return [items[0]!];

  const out: T[] = [];
  // 步长 (n-1)/(k-1) > 1，相邻两次取整后的下标一定不同，不会重复取同一个元素
  for (let i = 0; i < k; i++) {
    out.push(items[Math.round((i * (n - 1)) / (k - 1))]!);
  }
  return out;
}
