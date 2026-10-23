/**
 * 打开对象文件夹 / 文件（契约 §6.7 / §10.4）：
 * 只允许 VS Code 与资源管理器；spawn 一律参数数组 + shell:false，路径不拼命令行。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { WorkOpenApp } from '@anvil/shared';
import { WorkError } from './errors.ts';

export interface OpenSpawnOptions {
  shell: false;
  stdio: 'ignore';
  env?: NodeJS.ProcessEnv;
}

export interface SpawnLike {
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'spawn', cb: () => void): unknown;
  on(event: 'exit', cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  unref?: () => void;
}

export type SpawnFn = (cmd: string, args: string[], opts: OpenSpawnOptions) => SpawnLike;

export const nodeSpawn: SpawnFn = (cmd, args, opts) => spawn(cmd, args, opts) as unknown as SpawnLike;

function whereAll(exe: string): string[] {
  const res = spawnSync('where.exe', [exe], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || typeof res.stdout !== 'string') return [];
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** `where code` 的第一行常是 `…\bin\code`（无扩展），单看 .cmd 会漏掉；两种都向上找 Code.exe */
export function codeExeFromWherePath(candidate: string): string | null {
  if (candidate.toLowerCase().endsWith('.exe') && existsSync(candidate)) return candidate;
  const base = candidate.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (/^code(\.(cmd|bat))?$/.test(base)) {
    const exe = resolve(dirname(candidate), '..', 'Code.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

/**
 * Windows 上 `code` 通常是 `…\bin\code.cmd`；契约要求解析到 Code.exe，且不得走 shell。
 * 找不到就返回 null，交给 explorer 回退。
 */
export function defaultFindCode(): string | null {
  if (process.platform !== 'win32') return 'code';
  for (const candidate of [...whereAll('Code.exe'), ...whereAll('code')]) {
    const exe = codeExeFromWherePath(candidate);
    if (exe !== null) return exe;
  }
  const local = process.env.LOCALAPPDATA;
  if (local !== undefined) {
    const exe = join(local, 'Programs', 'Microsoft VS Code', 'Code.exe');
    if (existsSync(exe)) return exe;
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (base === undefined) continue;
    const exe = join(base, 'Microsoft VS Code', 'Code.exe');
    if (existsSync(exe)) return exe;
  }
  return null;
}

interface SpawnWaitOptions {
  /** 启动后最多等多久看退出码；不设 = 收到 spawn 就算成功（auto / explorer 保持旧行为） */
  exitGraceMs?: number;
  /** 宽限期内非零退出视为启动失败（显式 vscode） */
  failOnNonZeroExit?: boolean;
}

function spawnAndWait(
  cmd: string,
  args: string[],
  spawnImpl: SpawnFn,
  env?: NodeJS.ProcessEnv,
  wait: SpawnWaitOptions = {},
): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let child: SpawnLike;
    try {
      // 不设 windowsHide：它会把 VS Code / 资源管理器的 GUI 窗口一起藏掉
      child = spawnImpl(cmd, args, { shell: false, stdio: 'ignore', ...(env === undefined ? {} : { env }) });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clearTimer = (): void => {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    };
    const ok = (): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      resolvePromise();
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      reject(err);
    };
    child.on('error', fail);
    if (wait.exitGraceMs === undefined) {
      child.on('spawn', ok);
    } else {
      child.on('spawn', () => {
        // 有些安装会「spawn 成功但立刻带错误参数退出」；显式 vscode 在短窗口内看退出码
        timer = setTimeout(ok, wait.exitGraceMs);
        timer.unref?.();
      });
      child.on('exit', (code) => {
        if (wait.failOnNonZeroExit === true && code !== 0) {
          fail(new Error(`编辑器进程提前退出（code=${String(code)}）`));
        } else {
          ok();
        }
      });
    }
    // 子进程不阻塞服务退出；编辑器自己活
    try {
      child.unref?.();
    } catch {
      /* 注入实现可能没有 unref */
    }
  });
}

export interface OpenTargetOptions {
  target: string;
  isDir: boolean;
  spawn?: SpawnFn;
  findCode?: () => string | null;
  platform?: NodeJS.Platform;
}

export interface OpenTargetAppOptions extends OpenTargetOptions {
  app: WorkOpenApp;
}

function explorerArgsOf(target: string, isDir: boolean): string[] {
  return isDir ? [target] : [`/select,${target}`];
}

function codeArgsOf(target: string, isDir: boolean, newWindow: boolean): string[] {
  if (!isDir) return ['--goto', target];
  return newWindow ? ['--new-window', target] : [target];
}

export interface CodeLaunch {
  args: string[];
  env?: NodeJS.ProcessEnv;
}

/**
 * 有些 Windows 安装把 Electron 资源放在版本目录（如 `2d0b7506a3/resources/app`），
 * 根上的 Code.exe 直接收 `--new-window` 会报 bad option；此时按 bin/code.cmd 的入口
 * 用 ELECTRON_RUN_AS_NODE=1 跑 cli.js。官方布局仍直接 spawn Code.exe。
 */
export function codeLaunchFor(codeExe: string, target: string, isDir: boolean, newWindow: boolean): CodeLaunch {
  const direct: CodeLaunch = { args: codeArgsOf(target, isDir, newWindow) };
  if (!existsSync(codeExe)) return direct;
  const installRoot = dirname(codeExe);

  let version: string | null = null;
  const cmdFile = join(installRoot, 'bin', 'code.cmd');
  if (existsSync(cmdFile)) {
    try {
      const text = readFileSync(cmdFile, 'utf8');
      const match = text.match(/([0-9a-f]{8,})\\resources\\app\\out\\cli\.js/i);
      if (match?.[1] !== undefined) version = match[1];
    } catch {
      /* 读不到就退回目录探测 */
    }
  }
  if (version === null) {
    try {
      const candidates = readdirSync(installRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^[0-9a-f]{8,}$/i.test(entry.name))
        .map((entry) => entry.name);
      version = candidates.find((name) => existsSync(join(installRoot, name, 'resources', 'app', 'out', 'cli.js'))) ?? null;
    } catch {
      version = null;
    }
  }
  if (version === null) return direct;
  const cli = join(installRoot, version, 'resources', 'app', 'out', 'cli.js');
  if (!existsSync(cli)) return direct;
  return {
    args: [cli, ...direct.args],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  };
}

/** 文件夹 → explorer，文件 → code；失败再走另一条，二者都不可用 → 502 editor-unavailable */
export async function openTarget(opts: OpenTargetOptions): Promise<void> {
  const spawnImpl = opts.spawn ?? nodeSpawn;
  const platform = opts.platform ?? process.platform;
  const explorerArgs = explorerArgsOf(opts.target, opts.isDir);

  const tryExplorer = async (): Promise<boolean> => {
    if (platform !== 'win32') return false;
    try {
      await spawnAndWait('explorer.exe', explorerArgs, spawnImpl);
      return true;
    } catch {
      return false;
    }
  };

  const tryCode = async (): Promise<boolean> => {
    const code = (opts.findCode ?? defaultFindCode)();
    if (code === null) return false;
    try {
      const launch = codeLaunchFor(code, opts.target, opts.isDir, false);
      await spawnAndWait(code, launch.args, spawnImpl, launch.env);
      return true;
    } catch {
      return false;
    }
  };

  if (opts.isDir ? await tryExplorer() : await tryCode()) return;
  if (opts.isDir ? await tryCode() : await tryExplorer()) return;
  throw new WorkError('editor-unavailable', '找不到 VS Code 或资源管理器');
}

/**
 * 显式 app（契约 §11）：auto 保持既有回退；vscode / explorer 只走一条，
 * 失败直接 502，不回退到另一条。spawn 仍是参数数组 + shell:false。
 */
export async function openTargetWithApp(opts: OpenTargetAppOptions): Promise<void> {
  if (opts.app === 'auto') return openTarget(opts);
  const spawnImpl = opts.spawn ?? nodeSpawn;
  const platform = opts.platform ?? process.platform;

  if (opts.app === 'explorer') {
    if (platform !== 'win32') throw new WorkError('editor-unavailable', '资源管理器只在 Windows 下可用');
    try {
      await spawnAndWait('explorer.exe', explorerArgsOf(opts.target, opts.isDir), spawnImpl);
      return;
    } catch {
      throw new WorkError('editor-unavailable', '资源管理器启动失败');
    }
  }

  const code = (opts.findCode ?? defaultFindCode)();
  if (code === null) throw new WorkError('editor-unavailable', '找不到 VS Code（未安装或不在 PATH 里）');
  try {
    const launch = codeLaunchFor(code, opts.target, opts.isDir, true);
    await spawnAndWait(code, launch.args, spawnImpl, launch.env, { exitGraceMs: 300, failOnNonZeroExit: true });
  } catch {
    throw new WorkError('editor-unavailable', 'VS Code 启动失败');
  }
}
