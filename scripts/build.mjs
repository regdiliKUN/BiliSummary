/** 构建脚本：用 esbuild 打包主进程、preload 与渲染进程。 */
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist');
const watch = process.argv.includes('--watch');

/**
 * ffmpeg-static 必须保持 external：
 * 它通过 __dirname 计算自身路径，被打包后路径会失效。
 * 运行时从 node_modules 解析，打包时再把 app.asar 换成 app.asar.unpacked。
 */
const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron', 'ffmpeg-static'],
  define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
};

async function main() {
  await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, 'renderer'), { recursive: true });

  const contexts = [];

  // 主进程
  contexts.push(
    await build({
      ...common,
      entryPoints: [join(root, 'src/main/main.ts')],
      outfile: join(outdir, 'main/main.js'),
      external: ['electron', 'ffmpeg-static'],
    }),
  );

  // preload
  contexts.push(
    await build({
      ...common,
      entryPoints: [join(root, 'src/preload/preload.ts')],
      outfile: join(outdir, 'preload/preload.js'),
      external: ['electron', 'ffmpeg-static'],
    }),
  );

  // 渲染进程
  contexts.push(
    await build({
      ...common,
      entryPoints: [join(root, 'src/renderer/app.ts')],
      outfile: join(outdir, 'renderer/app.js'),
      platform: 'browser',
      format: 'iife',
      external: ['electron', 'ffmpeg-static'],
    }),
  );

  // 静态资源
  await cp(join(root, 'src/renderer/index.html'), join(outdir, 'renderer/index.html'));
  await cp(join(root, 'src/renderer/styles.css'), join(outdir, 'renderer/styles.css'));

  console.log('✓ 构建完成 -> dist/');

  if (watch) {
    console.log('（监听模式由 scripts/dev.mjs 处理）');
    for (const ctx of contexts) await ctx.dispose();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
