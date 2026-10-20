/**
 * 安装后自检：确保 ffmpeg-static 的二进制可用。
 *
 * ffmpeg-static 的 install 脚本在网络异常时可能下载失败，
 * 结果是二进制悄悄缺失，表现为「ASR 用不了」但没有任何提示。
 * 这里在 postinstall 阶段补一次，并给出明确说明。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

function binaryPath() {
  try {
    const p = require('ffmpeg-static');
    return typeof p === 'string' ? p : p?.default;
  } catch {
    return null;
  }
}

const path = binaryPath();

if (path && existsSync(path) && statSync(path).size > 0) {
  console.log('✓ ffmpeg-static 就绪');
  process.exit(0);
}

console.warn('! ffmpeg-static 的二进制缺失，正在重试下载…');

try {
  // 注意: 不能用 shell: true —— node.exe 路径里通常有空格 (C:\Program Files\...)
  const result = spawnSync(
    process.execPath,
    [join(process.cwd(), 'node_modules', 'ffmpeg-static', 'install.js')],
    { stdio: 'inherit' },
  );

  if (result.status === 0 && path && existsSync(path)) {
    console.log('✓ ffmpeg-static 修复完成');
    process.exit(0);
  }
} catch {
  /* 落到下面的提示 */
}

console.warn(
  '\n! ffmpeg 下载失败。\n' +
    '  语音识别（ASR）功能会不可用，但不影响「官方字幕 + LLM 摘要」这条主路径。\n' +
    '  稍后重试：npm run postinstall\n' +
    '  或手动安装 ffmpeg 并在「设置」里指定可执行文件路径。\n',
);
