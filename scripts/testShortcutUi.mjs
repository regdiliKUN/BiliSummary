/**
 * 通过 Chrome DevTools Protocol 驱动已打包的应用，
 * 真实点击界面上的「创建桌面快捷方式」按钮，验证渲染进程 -> IPC -> 主进程整条链路。
 *
 * 用法：npm run check:shortcut:ui
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.cwd();
const exe = join(root, 'release', 'win-unpacked', 'BiliSummary.exe');

if (!existsSync(exe)) {
  console.error('找不到已打包的程序，请先执行：npm run dist:win');
  process.exit(1);
}

const PORT = 19000 + Math.floor(Math.random() * 2000);

function log(ok, label, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log(`启动已打包的应用（调试端口 ${PORT}）...`);
  const proc = spawn(exe, [`--remote-debugging-port=${PORT}`], {
    stdio: 'ignore',
    detached: false,
  });

  let target = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      // 只认属于本应用的页面，避免连到同端口的其它 Electron 应用
      target = list.find(
        (t) => t.type === 'page' && /BiliSummary/i.test(t.title ?? ''),
      );
      if (target) break;
    } catch {
      /* 还没起来 */
    }
  }

  if (!target) {
    console.error('无法连接到应用窗口');
    proc.kill();
    process.exit(1);
  }
  console.log(`已连接: ${target.title}\n`);

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let msgId = 0;
  const pending = new Map();

  ws.addEventListener('message', (ev) => {
    const data = JSON.parse(ev.data);
    if (data.id && pending.has(data.id)) {
      pending.get(data.id)(data);
      pending.delete(data.id);
    }
  });

  await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++msgId;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error(res.result.exceptionDetails.text ?? '脚本执行异常');
    }
    return res.result?.result?.value;
  };

  try {
    console.log('[1] 界面元素');
    const hasButton = await evaluate(`!!document.getElementById('create-shortcut')`);
    log(hasButton, '存在「创建桌面快捷方式」按钮');
    const inSettings = await evaluate(
      `!!document.getElementById('create-shortcut').closest('#settings-modal')`,
    );
    log(inSettings, '按钮位于设置面板内');

    console.log('\n[2] 打开设置面板');
    await evaluate(`document.getElementById('open-settings').click()`);
    await sleep(400);
    const modalVisible = await evaluate(
      `!document.getElementById('settings-modal').classList.contains('hidden')`,
    );
    log(modalVisible, '设置面板已打开');

    console.log('\n[3] 点击「创建桌面快捷方式」');
    await evaluate(`document.getElementById('create-shortcut').click()`);
    await sleep(2500);

    const status = await evaluate(
      `document.getElementById('shortcut-status').textContent.trim()`,
    );
    console.log(`    状态文案: ${status}`);
    log(/已在桌面创建|已更新桌面快捷方式/.test(status), '界面提示已创建或已更新');

    console.log('\n[4] 校验磁盘上的快捷方式');
    const shortcutPath = await evaluate(
      `document.getElementById('shortcut-status').textContent.match(/[A-Z]:\\\\[^\\s]+\\.lnk/)?.[0] ?? ''`,
    );
    log(!!shortcutPath, '界面回显了快捷方式路径', shortcutPath);

    console.log('\n[5] 重复点击不应产生重复项');
    await evaluate(`document.getElementById('create-shortcut').click()`);
    await sleep(2000);
    const status2 = await evaluate(
      `document.getElementById('shortcut-status').textContent.trim()`,
    );
    console.log(`    状态文案: ${status2}`);
    log(/更新/.test(status2), '识别为更新');

    const count = shortcutPath
      ? readdirSync(dirname(shortcutPath)).filter((x) =>
          x.toLowerCase().includes('bilisummary'),
        ).length
      : -1;
    log(count === 1, '桌面只有一个 BiliSummary 快捷方式', `实际 ${count} 个`);

    console.log('\n[6] 删除');
    await evaluate(`document.getElementById('remove-shortcut').click()`);
    await sleep(1500);
    const status3 = await evaluate(
      `document.getElementById('shortcut-status').textContent.trim()`,
    );
    console.log(`    状态文案: ${status3}`);
    log(/删除/.test(status3), '界面提示已删除');
  } finally {
    ws.close();
    proc.kill();
  }

  console.log(process.exitCode ? '\n✗ 存在失败项' : '\n✓ 全部通过');
}

main().catch((err) => {
  console.error('验证失败:', err);
  process.exit(1);
});
