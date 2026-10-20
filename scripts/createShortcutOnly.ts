/**
 * 只创建桌面快捷方式，不删除。
 *
 * 用于让开发/测试后桌面上保留一个可用的入口。
 * 用法：npm run shortcut:create
 */
import { app } from 'electron';
import { createDesktopShortcut, getShortcutState } from '../src/main/shortcut.js';

async function main() {
  await app.whenReady();

  const state = getShortcutState();
  console.log(`桌面目录 : ${state.desktopDir}`);
  console.log(`快捷方式 : ${state.path}`);
  console.log(`已存在   : ${state.exists}`);
  if (state.exists && state.target) {
    console.log(`当前指向 : ${state.target}`);
  }
  console.log('');

  const res = await createDesktopShortcut();
  console.log(res.message);

  const after = getShortcutState();
  console.log('');
  console.log(`创建后状态: ${after.message}`);
  if (after.target) console.log(`指向      : ${after.target}`);

  app.exit(res.ok ? 0 : 1);
}

main().catch((err) => {
  console.error('创建失败:', err);
  app.exit(1);
});
