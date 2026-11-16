/** 输入边界与状态判定工具的回归测试（第 6 / 7 / 13 / 16 轮）。 */
import { describe, expect, it } from 'vitest';
import {
  clampTaskPercent,
  clampVideoConcurrency,
  isSafeExternalUrl,
  isSafeFileName,
  isSafeId,
  isSafeTaskUrl,
  isSettledStatus,
  videoKey,
} from '../src/core/utils/limits.js';

describe('统一边界', () => {
  it('并发数钳制到 1-6', () => {
    expect(clampVideoConcurrency(999)).toBe(6);
    expect(clampVideoConcurrency(0)).toBe(1);
    expect(clampVideoConcurrency('2.8')).toBe(2);
    expect(clampVideoConcurrency('abc', 3)).toBe(3);
  });

  it('进度钳制到 0-100 且拒绝 NaN', () => {
    expect(clampTaskPercent(120)).toBe(100);
    expect(clampTaskPercent(-5)).toBe(0);
    expect(clampTaskPercent(Number.NaN)).toBe(0);
  });

  it('终态判定覆盖四种结束状态', () => {
    expect(isSettledStatus('done')).toBe(true);
    expect(isSettledStatus('cancelled')).toBe(true);
    expect(isSettledStatus('running')).toBe(false);
  });

  it('视频键统一大小写与分P缺省值', () => {
    expect(videoKey('BV1AbC', 1)).toBe(videoKey('bv1abc', undefined as unknown as number));
    expect(videoKey('BV1AbC', 2)).not.toBe(videoKey('BV1AbC', 1));
  });
});

describe('IPC 参数校验', () => {
  it('任务 ID 只允许安全字符', () => {
    expect(isSafeId('task_1720000000_abc123')).toBe(true);
    expect(isSafeId('../secret')).toBe(false);
    expect(isSafeId('')).toBe(false);
  });

  it('链接拒绝非 http(s)、凭据与超长输入', () => {
    expect(isSafeTaskUrl('https://www.bilibili.com/video/BV1xx411c7mD')).toBe(true);
    expect(isSafeTaskUrl('file:///C:/Windows/win.ini')).toBe(false);
    expect(isSafeTaskUrl('https://user:pass@example.com')).toBe(false);
    expect(isSafeTaskUrl(`https://example.com/${'a'.repeat(3000)}`)).toBe(false);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });

  it('导出文件名拒绝路径与控制字符', () => {
    expect(isSafeFileName('摘要-BV1xx.md')).toBe(true);
    expect(isSafeFileName('..\\..\\win.ini')).toBe(false);
    expect(isSafeFileName('a\u0000b.md')).toBe(false);
    expect(isSafeFileName('..')).toBe(false);
  });
});
