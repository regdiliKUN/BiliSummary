/**
 * 桌面快捷方式的平台相关纯逻辑（不依赖 Electron，便于测试）。
 */
import { dirname, join } from 'node:path';
import type { ShortcutPlatform } from './types.js';

/** 快捷方式指向的可执行文件及其参数。 */
export interface LaunchTarget {
  target: string;
  args: string;
  cwd: string;
  /** 图标文件；Windows 必须是 exe/dll */
  icon?: string;
  iconIndex?: number;
}

/** 各平台快捷方式的文件名（含扩展名）。 */
export function shortcutFileName(platform: ShortcutPlatform, name: string): string {
  switch (platform) {
    case 'win32':
      return `${name}.lnk`;
    case 'darwin':
      return `${name}.app`;
    case 'linux':
      return `${name}.desktop`;
    default:
      return name;
  }
}

/** 快捷方式完整路径。 */
export function shortcutPath(platform: ShortcutPlatform, desktopDir: string, name: string): string {
  return join(desktopDir, shortcutFileName(platform, name));
}

/**
 * 从可执行文件路径推导 macOS 的 .app 包体路径。
 *
 * /Applications/X.app/Contents/MacOS/X -> /Applications/X.app
 * 不是标准包体结构时返回 null。
 */
export function resolveMacBundle(execPath: string): string | null {
  const macosDir = dirname(execPath);
  const contentsDir = dirname(macosDir);
  const bundleDir = dirname(contentsDir);
  if (!bundleDir.endsWith('.app')) return null;
  return bundleDir;
}

/** 生成 Linux 的 .desktop 内容。 */
export function linuxDesktopEntry(
  launch: LaunchTarget,
  name: string,
  comment = 'B站视频总结工具',
): string {
  const exec = `${launch.target} ${launch.args}`.trim();
  const icon = launch.icon ?? launch.target;
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    `Name[en]=${name}`,
    `Comment=${comment}`,
    `Exec=${exec}`,
    `Icon=${icon}`,
    'Terminal=false',
    'Categories=Utility;',
    'StartupWMClass=BiliSummary',
    '',
  ].join('\n');
}

/** 从 .desktop 内容里读回 Exec。 */
export function parseLinuxExec(content: string): string | undefined {
  const match = content.match(/^Exec=(.*)$/m);
  return match?.[1]?.trim();
}

/** 解析 Windows 快捷方式的图标定位串（"路径, 索引"）。 */
export function parseIconLocation(value: string): { path: string; index: number } | null {
  if (!value) return null;
  const idx = value.lastIndexOf(',');
  if (idx === -1) return { path: value.trim(), index: 0 };
  const index = Number(value.slice(idx + 1).trim());
  return {
    path: value.slice(0, idx).trim(),
    index: Number.isFinite(index) ? index : 0,
  };
}
