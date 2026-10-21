/**
 * 打开对象文件夹 / 文件（契约 §6.7 / §10.4）：
 * 只允许 VS Code 与资源管理器；spawn 一律参数数组 + shell:false，路径不拼命令行。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { WorkError } from './errors.ts';

export interface OpenSpawnOptions {
  shell: false;
  stdio: 'ignore';
}

export interface SpawnLike {
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'spawn', cb: () => void): unknown;
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

function spawnAndWait(cmd: string, args: string[], spawnImpl: SpawnFn): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    let child: SpawnLike;
    try {
      // 不设 windowsHide：它会把 VS Code / 资源管理器的 GUI 窗口一起藏掉
      child = spawnImpl(cmd, args, { shell: false, stdio: 'ignore' });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let settled = false;
    const ok = (): void => {
      if (settled) return;
      settled = true;
      resolvePromise();
    };
    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    child.on('spawn', ok);
    child.on('error', fail);
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

/** 文件夹 → explorer，文件 → code；失败再走另一条，二者都不可用 → 502 editor-unavailable */
export async function openTarget(opts: OpenTargetOptions): Promise<void> {
  const spawnImpl = opts.spawn ?? nodeSpawn;
  const platform = opts.platform ?? process.platform;
  const explorerArgs = opts.isDir ? [opts.target] : [`/select,${opts.target}`];

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
      await spawnAndWait(code, opts.isDir ? [opts.target] : ['--goto', opts.target], spawnImpl);
      return true;
    } catch {
      return false;
    }
  };

  if (opts.isDir ? await tryExplorer() : await tryCode()) return;
  if (opts.isDir ? await tryCode() : await tryExplorer()) return;
  throw new WorkError('editor-unavailable', '找不到 VS Code 或资源管理器');
}
