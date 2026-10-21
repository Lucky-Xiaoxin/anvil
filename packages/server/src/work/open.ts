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
  windowsHide: boolean;
}

export interface SpawnLike {
  on(event: 'error', cb: (err: Error) => void): unknown;
  on(event: 'spawn', cb: () => void): unknown;
  unref?: () => void;
}

export type SpawnFn = (cmd: string, args: string[], opts: OpenSpawnOptions) => SpawnLike;

export const nodeSpawn: SpawnFn = (cmd, args, opts) => spawn(cmd, args, opts) as unknown as SpawnLike;

function where(exe: string): string | null {
  const res = spawnSync('where.exe', [exe], { encoding: 'utf8', windowsHide: true });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '');
  return first === undefined ? null : first;
}

/**
 * Windows 上 `code` 通常是 `…\bin\code.cmd`；契约要求解析到 Code.exe，且不得走 shell。
 * 找不到就返回 null，交给 explorer 回退。
 */
export function defaultFindCode(): string | null {
  if (process.platform !== 'win32') return 'code';
  for (const candidate of [where('Code.exe'), where('code')]) {
    if (candidate === null) continue;
    if (candidate.toLowerCase().endsWith('.exe') && existsSync(candidate)) return candidate;
    if (/\.(cmd|bat)$/i.test(candidate)) {
      const exe = resolve(dirname(candidate), '..', 'Code.exe');
      if (existsSync(exe)) return exe;
    }
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
      child = spawnImpl(cmd, args, { shell: false, stdio: 'ignore', windowsHide: true });
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

/** code → explorer；两者都起不来 → 502 editor-unavailable */
export async function openTarget(opts: OpenTargetOptions): Promise<void> {
  const spawnImpl = opts.spawn ?? nodeSpawn;
  const code = (opts.findCode ?? defaultFindCode)();
  if (code !== null) {
    try {
      await spawnAndWait(code, opts.isDir ? [opts.target] : ['--goto', opts.target], spawnImpl);
      return;
    } catch {
      // code 起不来才回退；起得来就到此为止（不等待退出码）
    }
  }
  if ((opts.platform ?? process.platform) === 'win32') {
    const args = opts.isDir ? [opts.target] : [`/select,${opts.target}`];
    try {
      await spawnAndWait('explorer.exe', args, spawnImpl);
      return;
    } catch {
      /* 落到下面的统一错误 */
    }
  }
  throw new WorkError('editor-unavailable', '找不到 VS Code 或资源管理器');
}
