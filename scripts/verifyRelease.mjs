/**
 * 校验 release 目录的自动更新元数据与实际安装包是否一致。
 *
 * electron-builder 生成 latest.yml 后，若手工替换/重命名安装包而忘记同步
 * 哈希，用户端会静默更新失败。这个脚本把一致性检查变成可重复的一条命令。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = process.argv[2] ?? join(root, 'release');
const ymlPath = join(releaseDir, 'latest.yml');

if (!existsSync(ymlPath)) throw new Error(`找不到 ${ymlPath}`);
const yml = readFileSync(ymlPath, 'utf8');

const pick = (pattern) => {
  const match = pattern.exec(yml);
  return match?.[1]?.trim() ?? '';
};

const version = pick(/^version:\s*(\S+)/m);
const filename = pick(/^\s*(?:-\s*)?url:\s*(\S+)/m);
const expectedSha512 = pick(/^\s*sha512:\s*(\S+)/m);
const expectedSize = Number(pick(/^\s*size:\s*(\d+)/m));

if (!version || !filename || !expectedSha512 || !Number.isFinite(expectedSize)) {
  throw new Error('latest.yml 缺少 version / url / sha512 / size');
}

const exePath = join(releaseDir, filename);
if (!existsSync(exePath)) throw new Error(`latest.yml 指向的文件不存在：${exePath}`);

const content = readFileSync(exePath);
const actualSha512 = createHash('sha512').update(content).digest('base64');
const actualSize = statSync(exePath).size;
const problems = [];
if (actualSha512 !== expectedSha512) problems.push(`sha512 不一致：${actualSha512}`);
if (actualSize !== expectedSize) problems.push(`size 不一致：${actualSize}`);

if (problems.length) {
  console.error(`发布物校验失败：\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

console.log(
  `发布物校验通过：${filename} · v${version} · ${actualSize} bytes · sha512 ${actualSha512.slice(0, 16)}…`,
);
