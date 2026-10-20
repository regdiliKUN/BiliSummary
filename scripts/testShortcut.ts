/**
 * 在真实 Electron 运行时里验证桌面快捷方式的创建/更新/删除。
 *
 * 用法：npm run check:shortcut
 */
import { app } from 'electron';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { shell } from 'electron';
import {
  createDesktopShortcut,
  getShortcutState,
  removeDesktopShortcut,
} from '../src/main/shortcut.js';

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  await app.whenReady();
  console.log(`平台: ${process.platform}`);
  console.log(`打包状态: ${app.isPackaged ? '已打包' : '开发模式'}`);

  console.log('\n[1] 初始状态');
  const before = getShortcutState();
  console.log(`    桌面目录: ${before.desktopDir}`);
  console.log(`    快捷方式路径: ${before.path}`);
  console.log(`    已存在: ${before.exists}`);
  assert(before.supported, '当前平台受支持');
  assert(before.writable, '桌面目录可写');

  console.log('\n[2] 创建');
  const created = await createDesktopShortcut();
  console.log(`    ${created.message}`);
  assert(created.ok, '创建成功');
  assert(created.action === 'created' || created.action === 'updated', 'action 正确');
  assert(existsSync(created.path), '快捷方式文件已生成');

  console.log('\n[3] 验证指向与图标');
  if (process.platform === 'win32') {
    const details = shell.readShortcutLink(created.path);
    console.log(`    TargetPath: ${details.target}`);
    console.log(`    Arguments : ${details.args}`);
    console.log(`    IconLocation: ${details.icon}`);
    console.log(`    WorkingDirectory: ${details.cwd}`);
    console.log(`    Description: ${details.description}`);
    assert(details.target === process.execPath, '指向当前可执行文件');
    assert(!!details.icon, '图标已设置');
    assert(details.appUserModelId === 'com.bilisummary.app', 'AppUserModelID 正确');
  }

  console.log('\n[4] 重复点击（不应产生重复项）');
  const again = await createDesktopShortcut();
  console.log(`    ${again.message}`);
  assert(again.ok, '重复创建仍然成功');
  assert(again.action === 'updated', '识别为更新而非新建');

  const count = readdirSync(before.desktopDir).filter((f) =>
    f.toLowerCase().includes('bilisummary'),
  ).length;
  console.log(`    桌面上匹配「BiliSummary」的文件数: ${count}`);
  assert(count === 1, '桌面只存在一个 BiliSummary 快捷方式');

  console.log('\n[5] 删除');
  const removed = await removeDesktopShortcut();
  console.log(`    ${removed.message}`);
  assert(removed.ok, '删除成功');
  assert(!existsSync(created.path), '文件已移除');

  console.log(
    process.exitCode ? '\n✗ 存在失败项' : '\n✓ 全部通过',
  );

  // 退出，否则 Electron 主进程会一直挂着
  app.exit(Number(process.exitCode ?? 0));
}

main().catch((err) => {
  console.error('验证失败:', err);
  process.exit(1);
});
