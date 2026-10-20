/**
 * 桌面快捷方式。
 *
 * 各平台做法不同：
 * - Windows：用 Electron 的 shell.writeShortcutLink（原生 IShellLink，无额外依赖），
 *   失败时回退到 PowerShell 的 WScript.Shell COM。
 * - macOS：shell.writeShortcutLink 不支持，改为在桌面创建指向 .app 包体的符号链接
 *   （双击可用，且自动显示应用图标）。
 * - Linux：生成标准的 .desktop 文件并赋予可执行权限。
 */
import { app, shell } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  linuxDesktopEntry as buildLinuxDesktopEntry,
  parseLinuxExec,
  resolveMacBundle as resolveMacBundlePure,
  shortcutPath as shortcutPathPure,
  type LaunchTarget,
} from '../core/shortcut.js';
import type {
  ShortcutPlatform,
  ShortcutResult,
  ShortcutState,
} from '../core/types.js';

/** 与 electron-builder.yml 的 appId 保持一致，用于 Windows 任务栏分组。 */
export const APP_USER_MODEL_ID = 'com.bilisummary.app';

export type { ShortcutResult, ShortcutState, ShortcutPlatform } from '../core/types.js';

/** 快捷方式显示名称。 */
export function getShortcutName(): string {
  const name = (app.getName?.() || '').trim();
  // 打包后 app.getName() 返回 productName（"BiliSummary"）；
  // 开发模式返回 package.json 的 name（"bili-summary"）；
  // 某些上下文（如独立脚本）会返回 Electron 的默认名。
  if (!name || /^(bili-?summary|electron)$/i.test(name)) return 'BiliSummary';
  return name;
}

function getPlatform(): ShortcutPlatform {
  switch (process.platform) {
    case 'win32':
      return 'win32';
    case 'darwin':
      return 'darwin';
    case 'linux':
      return 'linux';
    default:
      return 'unsupported';
  }
}

/** 桌面目录。 */
export function getDesktopDir(): string {
  try {
    return app.getPath('desktop');
  } catch {
    return join(app.getPath('home'), 'Desktop');
  }
}

/** 快捷方式的完整路径。 */
export function getShortcutPath(): string {
  return shortcutPathPure(getPlatform(), getDesktopDir(), getShortcutName());
}

/** 快捷方式要启动的目标。 */

/**
 * 计算启动目标。
 *
 * 打包后：直接指向 exe/app 本身。
 * 开发模式：指向 electron 可执行文件，并把主进程脚本作为参数传入。
 */
function resolveLaunchTarget(): LaunchTarget {
  const execPath = process.execPath;

  if (app.isPackaged) {
    return {
      target: execPath,
      args: '',
      cwd: dirname(execPath),
      icon: execPath,
      iconIndex: 0,
    };
  }

  // 开发模式：electron.exe <项目目录>/dist/main/main.js
  const appPath = app.getAppPath();
  const mainScript = join(appPath, 'dist', 'main', 'main.js');
  const iconFile = join(appPath, 'resources', 'icon.ico');
  const hasIcon = existsSync(iconFile);

  return {
    target: execPath,
    args: `"${mainScript}"`,
    cwd: appPath,
    // icon 必须是 exe/dll；开发时用项目里的 ico 不一定被接受，退回 electron.exe
    icon: hasIcon ? iconFile : execPath,
    iconIndex: 0,
  };
}

/** macOS 的 .app 包体路径。 */
function resolveMacBundle(): string | null {
  return resolveMacBundlePure(process.execPath);
}

/** 目录是否可写。 */
function isWritable(dir: string): boolean {
  try {
    const probe = join(dir, `.bili-write-test-${process.pid}-${Date.now()}`);
    writeFileSync(probe, 'ok');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 读取现有快捷方式指向的目标（Windows）。 */
function readWindowsTarget(path: string): string | undefined {
  try {
    const details = shell.readShortcutLink(path);
    return details?.target || undefined;
  } catch {
    return undefined;
  }
}

/** macOS 符号链接当前指向。 */
function readLinkTarget(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    return readlinkSync(path);
  } catch {
    return undefined;
  }
}

/** Linux .desktop 里的 Exec=。 */
function readLinuxExec(path: string): string | undefined {
  try {
    return parseLinuxExec(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 查询当前快捷方式状态。 */
export function getShortcutState(): ShortcutState {
  const platform = getPlatform();
  const desktopDir = getDesktopDir();
  const path = getShortcutPath();
  const name = getShortcutName();

  const base = {
    platform,
    name,
    path,
    desktopDir,
    exists: false,
    writable: false,
    message: '',
  };

  if (platform === 'unsupported') {
    return {
      ...base,
      supported: false,
      message: `当前平台（${process.platform}）暂不支持创建桌面快捷方式。`,
    };
  }

  const writable = isWritable(desktopDir);
  const exists = existsSync(path);

  let target: string | undefined;
  if (exists) {
    if (platform === 'win32') target = readWindowsTarget(path);
    else if (platform === 'darwin') target = readLinkTarget(path);
    else target = readLinuxExec(path);
  }

  let message: string;
  if (!writable) {
    message = `没有写入桌面目录的权限：${desktopDir}。请检查权限，或以管理员身份运行。`;
  } else if (exists) {
    message = `桌面快捷方式已存在：${path}`;
  } else {
    message = `点击即可在桌面创建「${name}」快捷方式。`;
  }

  return { ...base, supported: true, exists, writable, target, message };
}

/* ------------------------------------------------------------------ */
/* Windows                                                             */
/* ------------------------------------------------------------------ */

/** PowerShell 单引号字符串的转义。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * 以 -EncodedCommand 的方式执行 PowerShell 脚本。
 *
 * 不能用 `-Command <script> <arg>`：PowerShell 会把后面的参数直接拼到脚本末尾，
 * 而不是放进 $args。改用 Base64(UTF-16LE) 编码并把参数直接写进脚本里。
 */
function runPowerShell(script: string, timeout = 20000): Promise<void> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encoded,
      ],
      { windowsHide: true, timeout },
      (err) => (err ? reject(err) : resolve()),
    );
  });
}

/**
 * 通知资源管理器刷新。
 *
 * 通过文件系统 API 新建的文件不会触发 Explorer 的变更通知，
 * 桌面图标可能要按 F5 才出现。这里主动发一条通知让图标立刻显示。
 */
async function notifyShellChange(path: string): Promise<void> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -Namespace Native -Name Shell -MemberDefinition @'",
    '[DllImport("shell32.dll", CharSet=CharSet.Auto, SetLastError=true)]',
    'public static extern void SHChangeNotify(int eventId, uint flags, string item1, IntPtr item2);',
    "'@",
    // SHCNE_CREATE = 0x00000002
    `[Native.Shell]::SHChangeNotify(0x00000002, 0x0000, ${psQuote(path)}, [IntPtr]::Zero)`,
  ].join('\n');

  try {
    await runPowerShell(script, 10000);
  } catch {
    // 刷新失败不影响快捷方式本身
  }
}

/** 用 PowerShell 的 WScript.Shell 创建快捷方式（回退方案）。 */
async function writeWindowsShortcutFallback(
  path: string,
  launch: LaunchTarget,
): Promise<void> {
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    '$sc = $shell.CreateShortcut(' + psQuote(path) + ')',
    '$sc.TargetPath = ' + psQuote(launch.target),
    '$sc.Arguments = ' + psQuote(launch.args),
    '$sc.WorkingDirectory = ' + psQuote(launch.cwd),
    '$sc.Description = ' + psQuote(`${getShortcutName()} - B站视频总结工具`),
    'if (' + psQuote(launch.icon ?? '') + ') { $sc.IconLocation = ' +
      psQuote(launch.icon ?? '') + ' + "," + ' + psQuote(String(launch.iconIndex ?? 0)) + ' }',
    '$sc.Save()',
  ].join('; ');

  await runPowerShell(script, 20000);
}

/* ------------------------------------------------------------------ */
/* Linux                                                               */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 创建                                                                */
/* ------------------------------------------------------------------ */

/** 创建（或更新）桌面快捷方式。 */
export async function createDesktopShortcut(): Promise<ShortcutResult> {
  const platform = getPlatform();
  const path = getShortcutPath();
  const desktopDir = getDesktopDir();
  const name = getShortcutName();

  if (platform === 'unsupported') {
    return {
      ok: false,
      path,
      action: 'failed',
      message: `当前平台（${process.platform}）暂不支持创建桌面快捷方式。`,
    };
  }

  // 桌面目录不存在时尝试创建（部分精简版 Windows 会这样）
  if (!existsSync(desktopDir)) {
    try {
      mkdirSync(desktopDir, { recursive: true });
    } catch (err) {
      return {
        ok: false,
        path,
        action: 'failed',
        message: `桌面目录不存在且无法创建（${(err as Error).message}）。`,
      };
    }
  }

  if (!isWritable(desktopDir)) {
    return {
      ok: false,
      path,
      action: 'failed',
      message:
        `没有写入桌面的权限：${desktopDir}。` +
        (platform === 'win32'
          ? '请以管理员身份运行本应用，或手动创建快捷方式。'
          : '请检查该目录的权限设置。'),
    };
  }

  const launch = resolveLaunchTarget();
  const alreadyExists = existsSync(path);

  try {
    switch (platform) {
      case 'win32': {
        // 已存在时用 update 刷新指向，避免产生重复项
        const operation = alreadyExists ? 'update' : 'create';
        let ok = false;
        try {
          ok = shell.writeShortcutLink(path, operation, {
            target: launch.target,
            args: launch.args,
            cwd: launch.cwd,
            icon: launch.icon,
            iconIndex: launch.iconIndex ?? 0,
            description: `${name} - B站视频总结工具`,
            appUserModelId: APP_USER_MODEL_ID,
          });
        } catch {
          ok = false;
        }

        if (!ok) {
          // 回退到 PowerShell
          await writeWindowsShortcutFallback(path, launch);
        }
        break;
      }

      case 'darwin': {
        const bundle = resolveMacBundle();
        if (!bundle) {
          return {
            ok: false,
            path,
            action: 'failed',
            message: '无法定位 .app 包体（当前不是标准 macOS 应用包）。',
          };
        }
        // 先删掉旧的再重建，保证指向最新
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
        symlinkSync(bundle, path, 'dir');
        break;
      }

      case 'linux': {
        writeFileSync(path, buildLinuxDesktopEntry(launch, name), 'utf8');
        try {
          chmodSync(path, 0o755);
        } catch {
          /* 某些文件系统不支持 */
        }
        // 同时放进应用目录并刷新缓存（失败不影响桌面图标）
        try {
          const appsDir = join(app.getPath('home'), '.local', 'share', 'applications');
          mkdirSync(appsDir, { recursive: true });
          writeFileSync(
            join(appsDir, 'bili-summary.desktop'),
            buildLinuxDesktopEntry(launch, name),
            'utf8',
          );
          chmodSync(join(appsDir, 'bili-summary.desktop'), 0o755);
          try {
            execFileSync('update-desktop-database', [appsDir], { stdio: 'ignore' });
          } catch {
            /* 没装就不刷新 */
          }
        } catch {
          /* 忽略 */
        }
        break;
      }
    }
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    let message = `创建快捷方式失败：${error.message}`;
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      message =
        `没有写入桌面的权限（${error.code}）。` +
        (platform === 'win32' ? '请以管理员身份运行本应用。' : '请检查目录权限。');
    } else if (error.code === 'ENOENT') {
      message = `路径不存在：${error.message}`;
    }
    return { ok: false, path, action: 'failed', message };
  }

  // 二次确认
  if (!existsSync(path)) {
    return {
      ok: false,
      path,
      action: 'failed',
      message: '创建快捷方式后未在预期位置找到文件，请重试。',
    };
  }

  // 让桌面立刻显示新图标（不必手动 F5）
  if (platform === 'win32') {
    await notifyShellChange(path);
  }

  return {
    ok: true,
    path,
    action: alreadyExists ? 'updated' : 'created',
    message: alreadyExists
      ? `已更新桌面快捷方式：${path}`
      : `已在桌面创建快捷方式：${path}`,
  };
}

/**
 * 删除桌面快捷方式。
 *
 * Windows 在写入 .lnk 之后可能会短暂持有文件句柄，
 * 因此删除要做重试，否则会出现 EBUSY。
 */
export async function removeDesktopShortcut(): Promise<ShortcutResult> {
  const platform = getPlatform();
  const path = getShortcutPath();

  if (platform === 'unsupported') {
    return { ok: false, path, action: 'failed', message: '当前平台不支持该操作。' };
  }
  if (!existsSync(path)) {
    return { ok: false, path, action: 'failed', message: '桌面快捷方式不存在。' };
  }

  let lastError: NodeJS.ErrnoException | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return { ok: true, path, action: 'removed', message: `已删除桌面快捷方式：${path}` };
    } catch (err) {
      lastError = err as NodeJS.ErrnoException;
      // EBUSY/EPERM 往往是文件被短暂占用，稍等再试
      if (lastError.code !== 'EBUSY' && lastError.code !== 'EPERM') break;
      await sleep(150 * (attempt + 1));
    }
  }

  const error = lastError!;
  const message =
    error.code === 'EACCES' || error.code === 'EPERM' || error.code === 'EBUSY'
      ? `无法删除快捷方式（${error.code}）。文件可能正被占用，或当前账户没有删除权限，请稍后重试。`
      : `删除失败：${error.message}`;
  return { ok: false, path, action: 'failed', message };
}

/** 等待指定毫秒。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
