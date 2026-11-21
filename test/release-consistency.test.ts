/** 发布版本一致性回归（第 18 / 20 轮）。 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const pkg = JSON.parse(read('package.json')) as { version: string };
const lock = JSON.parse(read('package-lock.json')) as { version: string; packages: Record<string, { version: string }> };

describe('发布版本一致性', () => {
  it('package.json 与 lockfile 根版本一致', () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
  });

  // release/ 下除说明文档外都不入库：CI 的干净检出里没有 latest.yml，只在本地打包后校验。
  it.skipIf(!existsSync(join(root, 'release/latest.yml')))('latest.yml 指向当前构建版本', () => {
    const yml = read('release/latest.yml');
    expect(yml).toMatch(new RegExp(`^version:\\s*${pkg.version.replace(/\./g, '\\.')}$`, 'm'));
    expect(yml).toContain(`BiliSummary-${pkg.version}-x64-setup.exe`);
  });
});
