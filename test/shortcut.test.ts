import { describe, expect, it } from 'vitest';
import { basename, join } from 'node:path';
import {
  linuxDesktopEntry,
  parseIconLocation,
  parseLinuxExec,
  resolveMacBundle,
  shortcutFileName,
  shortcutPath,
} from '../src/core/shortcut.js';

describe('各平台快捷方式文件名', () => {
  it('Windows 用 .lnk', () => {
    expect(shortcutFileName('win32', 'BiliSummary')).toBe('BiliSummary.lnk');
  });

  it('macOS 用 .app', () => {
    expect(shortcutFileName('darwin', 'BiliSummary')).toBe('BiliSummary.app');
  });

  it('Linux 用 .desktop', () => {
    expect(shortcutFileName('linux', 'BiliSummary')).toBe('BiliSummary.desktop');
  });

  it('不支持的平台退回纯名称', () => {
    expect(shortcutFileName('unsupported', 'BiliSummary')).toBe('BiliSummary');
  });

  it('路径拼接使用桌面目录', () => {
    // 用 path.join 生成期望值，避免写死平台分隔符
    expect(shortcutPath('win32', join('C:', 'Users', 'x', 'Desktop'), 'BiliSummary')).toBe(
      join('C:', 'Users', 'x', 'Desktop', 'BiliSummary.lnk'),
    );
  });

  it('桌面目录与名称拼接顺序正确', () => {
    // 只断言与平台无关的部分：目录在前、文件名在后
    const p = shortcutPath('linux', join('home', 'x', 'Desktop'), 'BiliSummary');
    expect(basename(p)).toBe('BiliSummary.desktop');
    expect(p).toContain(join('home', 'x', 'Desktop'));
  });
});

describe('macOS 包体推导', () => {
  it('从可执行文件路径推出 .app', () => {
    expect(
      resolveMacBundle('/Applications/BiliSummary.app/Contents/MacOS/BiliSummary'),
    ).toBe('/Applications/BiliSummary.app');
  });

  it('非标准结构返回 null', () => {
    expect(resolveMacBundle('/usr/local/bin/something')).toBeNull();
    expect(resolveMacBundle('C:\\Program Files\\BiliSummary\\BiliSummary.exe')).toBeNull();
  });
});

describe('Linux .desktop 生成', () => {
  const launch = {
    target: '/opt/BiliSummary/bili-summary',
    args: '--flag',
    cwd: '/opt/BiliSummary',
    icon: '/opt/BiliSummary/icon.png',
  };

  it('包含标准字段', () => {
    const entry = linuxDesktopEntry(launch, 'BiliSummary');
    expect(entry).toContain('[Desktop Entry]');
    expect(entry).toContain('Type=Application');
    expect(entry).toContain('Name=BiliSummary');
    expect(entry).toContain('Exec=/opt/BiliSummary/bili-summary --flag');
    expect(entry).toContain('Icon=/opt/BiliSummary/icon.png');
    expect(entry).toContain('Terminal=false');
  });

  it('没有 icon 时退回 target', () => {
    const entry = linuxDesktopEntry({ target: '/x/y', args: '', cwd: '/x' }, 'N');
    expect(entry).toContain('Icon=/x/y');
  });

  it('可以读回 Exec', () => {
    const entry = linuxDesktopEntry(launch, 'BiliSummary');
    expect(parseLinuxExec(entry)).toBe('/opt/BiliSummary/bili-summary --flag');
  });

  it('没有 Exec 时返回 undefined', () => {
    expect(parseLinuxExec('[Desktop Entry]\nName=x')).toBeUndefined();
  });
});

describe('Windows 图标定位串解析', () => {
  it('解析 "路径, 索引"', () => {
    expect(parseIconLocation('C:\\App\\BiliSummary.exe, 0')).toEqual({
      path: 'C:\\App\\BiliSummary.exe',
      index: 0,
    });
  });

  it('只有路径时索引取 0', () => {
    expect(parseIconLocation('C:\\App\\BiliSummary.exe')).toEqual({
      path: 'C:\\App\\BiliSummary.exe',
      index: 0,
    });
  });

  it('空串返回 null', () => {
    expect(parseIconLocation('')).toBeNull();
  });
});
