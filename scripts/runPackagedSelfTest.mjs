/**
 * 在已打包的应用里跑一次快捷方式自检。
 *
 * 用法：npm run check:shortcut:packaged
 * 需要先执行 npm run dist:win 生成 release/win-unpacked。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

const candidates = [
  join(root, 'release', 'win-unpacked', 'BiliSummary.exe'),
  join(root, 'release', 'win-unpacked', 'BiliSummary.app', 'Contents', 'MacOS', 'BiliSummary'),
  join(root, 'release', 'linux-unpacked', 'bili-summary'),
];

const exe = candidates.find((p) => existsSync(p));
if (!exe) {
  console.error('找不到已打包的程序，请先执行：npm run dist:win');
  process.exit(1);
}

console.log(`运行: ${exe}\n`);

const proc = spawn(exe, [], {
  stdio: 'inherit',
  env: { ...process.env, BILISUMMARY_SELFTEST: 'shortcut' },
});

proc.on('close', (code) => {
  process.exit(code ?? 0);
});
