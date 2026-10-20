/**
 * 打包版自检 / 快捷方式创建。
 *
 * 环境变量 BILISUMMARY_SELFTEST：
 * - `shortcut`        完整自检：创建 -> 校验 -> 重复创建 -> 删除（测完不留残留）
 * - `shortcut-create` 只创建并保留快捷方式，不删除
 */
import { app, shell } from 'electron';
import { existsSync, readdirSync } from 'node:fs';
import { createDesktopShortcut, getShortcutState, removeDesktopShortcut } from './shortcut.js';

function log(ok: boolean, label: string, detail?: string): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

/** 只创建并保留快捷方式。 */
export async function createShortcutOnly(): Promise<void> {
  console.log('=== BiliSummary 打包版：创建桌面快捷方式 ===');
  console.log(`可执行文件 : ${process.execPath}`);
  console.log(`应用名称   : ${app.getName()}`);
  console.log('');

  const before = getShortcutState();
  console.log(`桌面目录   : ${before.desktopDir}`);
  console.log(`快捷方式   : ${before.path}`);
  if (before.exists && before.target) {
    console.log(`原有指向   : ${before.target}`);
  }
  console.log('');

  const res = await createDesktopShortcut();
  console.log(res.message);

  const after = getShortcutState();
  console.log('');
  console.log(`状态: ${after.message}`);
  if (after.target) console.log(`指向: ${after.target}`);
  console.log(
    after.target === process.execPath
      ? '\n✓ 快捷方式已指向当前打包版程序'
      : '\n✗ 指向不正确',
  );
}

export async function runShortcutSelfCheck(): Promise<void> {
  console.log('=== BiliSummary 打包版快捷方式自检 ===');
  console.log(`平台       : ${process.platform}`);
  console.log(`打包状态   : ${app.isPackaged ? '已打包' : '开发模式'}`);
  console.log(`可执行文件 : ${process.execPath}`);
  console.log(`应用名称   : ${app.getName()}`);
  console.log('');

  const before = getShortcutState();
  console.log(`桌面目录   : ${before.desktopDir}`);
  console.log(`快捷方式   : ${before.path}`);
  console.log('');

  log(before.supported, '当前平台受支持');
  log(before.writable, '桌面目录可写', before.writable ? '' : before.message);

  const created = await createDesktopShortcut();
  log(created.ok, '创建成功', created.message);
  log(existsSync(created.path), '文件已生成');

  if (process.platform === 'win32') {
    const details = shell.readShortcutLink(created.path);
    log(details.target === process.execPath, '指向当前可执行文件', details.target);
    log(!!details.icon, '图标已设置', details.icon ?? '');
    log(!!details.description, '描述已设置', details.description ?? '');
    log(
      details.appUserModelId === 'com.bilisummary.app',
      'AppUserModelID 正确',
      details.appUserModelId ?? '',
    );
    log(!details.args, '打包后不携带多余参数', details.args ?? '(空)');
  }

  const again = await createDesktopShortcut();
  log(again.ok, '重复创建不报错', again.message);
  log(again.action === 'updated', '识别为更新而非新建');

  const count = readdirSync(before.desktopDir).filter((f) =>
    f.toLowerCase().includes('bilisummary'),
  ).length;
  log(count === 1, '桌面只有一个 BiliSummary 快捷方式', `实际 ${count} 个`);

  const removed = await removeDesktopShortcut();
  log(removed.ok, '删除成功', removed.message);
  log(!existsSync(created.path), '文件已移除');

  console.log(process.exitCode ? '\n✗ 存在失败项' : '\n✓ 全部通过');
}
