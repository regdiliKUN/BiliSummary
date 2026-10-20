/** 开发模式：构建并启动 Electron，改动后自动重启。 */
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
};

async function buildAll() {
  await build({
    ...common,
    entryPoints: [join(root, 'src/main/main.ts')],
    outfile: join(outdir, 'main/main.js'),
    external: ['electron'],
  });
  await build({
    ...common,
    entryPoints: [join(root, 'src/preload/preload.ts')],
    outfile: join(outdir, 'preload/preload.js'),
    external: ['electron'],
  });
  await build({
    ...common,
    entryPoints: [join(root, 'src/renderer/app.ts')],
    outfile: join(outdir, 'renderer/app.js'),
    platform: 'browser',
    format: 'iife',
  });
}

let electronProc = null;
let restarting = false;

function startElectron() {
  electronProc = spawn(
    join(root, 'node_modules/.bin/electron.cmd'),
    [join(outdir, 'main/main.js')],
    { stdio: 'inherit', shell: true, env: { ...process.env, NODE_ENV: 'development' } },
  );

  electronProc.on('close', () => {
    electronProc = null;
  });
}

async function restart() {
  if (restarting) return;
  restarting = true;
  try {
    electronProc?.kill();
    await buildAll();
    startElectron();
  } catch (err) {
    console.error('重建失败：', err.message);
  } finally {
    restarting = false;
  }
}

await buildAll();
startElectron();

// 监听源码变化
let timer = null;
for (const dir of ['src/main', 'src/preload', 'src/renderer', 'src/core']) {
  watch(join(root, dir), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => void restart(), 300);
  });
}

console.log('✓ 开发模式已启动，修改源码会自动重启');
