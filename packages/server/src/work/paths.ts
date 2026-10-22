/**
 * 工坊路径边界（契约 §10）：所有用户输入路径在这里过一遍。
 * 判据用 `path.relative`，不用字符串前缀；已存在的路径再走 realpath，越界链接直接拒绝。
 */
import { existsSync, lstatSync, realpathSync, statSync, type Stats } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { repoRoot as defaultRepoRoot, vaultDir as defaultVaultDir } from '../config.ts';
import { WorkError } from './errors.ts';

export const OBJ_REL_PATH_MAX = 160;

/** 统一成 POSIX 相对路径（索引与 DTO 都用这个形状） */
export function toPosix(p: string): string {
  return p.split(sep).join('/');
}

function isOutsideRel(rel: string): boolean {
  const posix = toPosix(rel);
  return posix === '..' || posix.startsWith('../') || isAbsolute(rel);
}

/** target 是否在 base 内；allowEqual 用于“根自身” */
export function within(base: string, target: string, allowEqual = false): boolean {
  if (process.platform === 'win32') {
    // win32 下盘符大小写不敏感；path.relative 负责大小写，但我们再兜一层
    base = base.toLowerCase();
    target = target.toLowerCase();
  }
  const rel = relative(base, target);
  if (rel === '') return allowEqual;
  return !isOutsideRel(rel);
}

export function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

export function statOrNull(p: string): Stats | null {
  try {
    return statSync(p);
  } catch {
    return null;
  }
}

/** 已存在路径的 realpath；不存在时把最近的已存在祖先 realpath 后拼回剩余段 */
export function deepestReal(p: string): string {
  const abs = resolve(p);
  const st = lstatOrNull(abs);
  if (st !== null) return realpathSync(abs);
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    rest.unshift(basename(cur));
    cur = parent;
    if (lstatOrNull(cur) !== null) break;
  }
  return join(realpathSync(cur), ...rest);
}

export interface RootValidationOptions {
  repoRoot?: string;
  vaultDir?: string;
}

/** Windows 资源管理器「复制为路径」会带引号；/ 与 \ 都当分隔符 */
export function normalizeInputPath(input: unknown): string {
  if (typeof input !== 'string') return '';
  let text = input.trim();
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) text = text.slice(1, -1).trim();
  }
  return text;
}

function forbiddenWindowsDir(abs: string): boolean {
  if (process.platform !== 'win32') return false;
  const bases = [resolve('C:\\Windows'), resolve('C:\\Program Files'), resolve('C:\\Program Files (x86)')];
  return bases.some((base) => within(base, abs, true));
}

/**
 * 受管根的绝对路径校验（§3.1）：盘符根 / Windows / Program Files / 仓库内 / vault 内全部拒绝。
 * 不在这里创建目录。
 */
export function validateRootPath(input: string, opts: RootValidationOptions = {}): string {
  const raw = normalizeInputPath(input);
  if (raw === '') throw new WorkError('root-invalid', '受管根不能为空');
  if (!isAbsolute(raw)) throw new WorkError('root-invalid', '受管根必须是绝对路径');
  const abs = resolve(raw);
  if (parse(abs).root === abs) throw new WorkError('root-invalid', '受管根不能是盘符根目录');
  if (forbiddenWindowsDir(abs)) throw new WorkError('root-invalid', '受管根不能放在 Windows 或 Program Files 下');

  const repo = resolve(opts.repoRoot ?? defaultRepoRoot);
  const vault = resolve(opts.vaultDir ?? defaultVaultDir);
  const st = lstatOrNull(abs);
  if (st !== null && st.isSymbolicLink()) throw new WorkError('root-invalid', '受管根不能是符号链接');
  if (st !== null && !st.isDirectory()) throw new WorkError('root-invalid', '受管根必须指向目录');

  if (st === null) {
    // 不存在的路径：最近祖先必须是目录，且真实落点不能钻进本仓 / vault
    const realCandidate = deepestReal(abs);
    let cur = abs;
    while (lstatOrNull(cur) === null) {
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    const ancestor = lstatOrNull(cur);
    if (ancestor !== null && !ancestor.isDirectory()) throw new WorkError('root-invalid', '受管根的上级路径不是目录');
    if (within(repo, realCandidate, true) || within(vault, realCandidate, true)) {
      throw new WorkError('root-invalid', '受管根不能位于本仓库或 vault/ 内');
    }
  } else {
    const realCandidate = realpathSync(abs);
    if (
      within(repo, abs, true) ||
      within(vault, abs, true) ||
      within(deepestReal(repo), realCandidate, true) ||
      within(deepestReal(vault), realCandidate, true)
    ) {
      throw new WorkError('root-invalid', '受管根不能位于本仓库或 vault/ 内');
    }
  }
  return abs;
}

export interface ImportSourceValidation {
  /** 用户输入路径归一化后的绝对路径 */
  abs: string;
  /** 校验过的真实路径（不允许任何组件是链接） */
  real: string;
}

function isUncPath(abs: string): boolean {
  return abs.startsWith('\\\\') || abs.startsWith('//') || parse(abs).root.startsWith('\\\\');
}

function assertNoSymlinkPath(abs: string): void {
  const rootPart = parse(abs).root;
  let cur = rootPart;
  for (const part of abs.slice(rootPart.length).split(sep).filter((p) => p !== '')) {
    cur = join(cur, part);
    const st = lstatOrNull(cur);
    if (st === null) throw new WorkError('import-source-invalid', `源路径不存在：${part}`);
    if (st.isSymbolicLink()) {
      throw new WorkError('import-source-invalid', '源路径的任一级目录都不能是符号链接或 junction');
    }
  }
}

/**
 * 旧代码导入的源目录校验（契约 §4.1）：绝对、普通目录、非盘符根 / UNC / 系统目录，
 * 与受管根无祖先 / 后代关系；逐级检查已存在组件，不跟链接读别处。
 * 不能复用只接受根内相对路径的 resolveInside()。
 */
export function validateImportSource(input: unknown, managedRoot: string): ImportSourceValidation {
  const raw = normalizeInputPath(input);
  if (raw === '') throw new WorkError('import-source-invalid', '源目录不能为空');
  if (raw.includes('\0')) throw new WorkError('import-source-invalid', '源路径含非法字符');
  if (!isAbsolute(raw)) throw new WorkError('import-source-invalid', '源目录必须是绝对路径');
  const abs = resolve(raw);
  if (parse(abs).root === abs) throw new WorkError('import-source-invalid', '源目录不能是盘符根目录');
  if (isUncPath(raw) || isUncPath(abs)) throw new WorkError('import-source-invalid', '源目录不能是 UNC 路径');
  if (forbiddenWindowsDir(abs)) throw new WorkError('import-source-invalid', '源目录不能位于 Windows 或 Program Files 下');

  const st = lstatOrNull(abs);
  if (st === null) throw new WorkError('import-source-invalid', '源目录不存在');
  if (st.isSymbolicLink()) throw new WorkError('import-source-invalid', '源目录不能是符号链接或 junction');
  if (!st.isDirectory()) throw new WorkError('import-source-invalid', '源路径必须是目录');
  assertNoSymlinkPath(abs);

  const real = realpathSync(abs);
  const rootAbs = resolve(managedRoot);
  const rootReal = realpathSync(rootAbs);
  if (within(rootAbs, abs, true) || within(abs, rootAbs, true) || within(rootReal, real, true) || within(real, rootReal, true)) {
    throw new WorkError('import-source-invalid', '源目录与工坊受管根不能互为祖先或后代');
  }
  return { abs, real };
}

/** 已存在路径中任何一段是符号链接都拒绝（open / adopt / restore 用） */
export function assertNoSymlinkComponents(root: string, abs: string): void {
  const st = lstatOrNull(root);
  if (st === null || st.isSymbolicLink()) throw new WorkError('unsafe-path', '受管根不可用');
  const rel = relative(root, abs);
  if (rel === '') return;
  if (isOutsideRel(rel)) throw new WorkError('unsafe-path', '路径越出受管根');
  let cur = root;
  for (const part of toPosix(rel).split('/')) {
    if (part === '') continue;
    cur = join(cur, part);
    const partStat = lstatOrNull(cur);
    if (partStat === null) break;
    if (partStat.isSymbolicLink()) throw new WorkError('unsafe-path', '不允许跟随符号链接');
  }
}

export interface ResolveInsideOptions {
  allowRoot?: boolean;
  allowMissing?: boolean;
}

/**
 * 用户输入相对路径 → 根内绝对路径。`..`、绝对路径、盘符、UNC、越界链接全部拒绝。
 * 不读取文件内容，只做路径判据。
 */
export function resolveInside(root: string, relPath: string, opts: ResolveInsideOptions = {}): string {
  if (typeof relPath !== 'string') throw new WorkError('unsafe-path', '路径必须是字符串');
  const rel = normalizeInputPath(relPath);
  if (rel === '') throw new WorkError('unsafe-path', '路径不能为空');
  if (rel.includes('\0')) throw new WorkError('unsafe-path', '路径含非法字符');
  if (isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\') || rel.startsWith('//')) {
    throw new WorkError('unsafe-path', '路径必须是受管根内的相对路径');
  }
  const abs = resolve(root, rel);
  if (!within(root, abs, opts.allowRoot ?? false)) throw new WorkError('unsafe-path', '路径越出受管根');
  assertNoSymlinkComponents(root, abs);
  const st = lstatOrNull(abs);
  if (st === null) {
    if (!opts.allowMissing) throw new WorkError('not-found', '路径不存在');
    return abs;
  }
  if (st.isSymbolicLink()) throw new WorkError('unsafe-path', '不允许符号链接');
  const realRoot = realpathSync(root);
  const realAbs = realpathSync(abs);
  if (!within(realRoot, realAbs, opts.allowRoot ?? false)) throw new WorkError('unsafe-path', '路径越出受管根');
  return abs;
}

export function relPosix(root: string, abs: string): string {
  return toPosix(relative(root, abs));
}

/* ------------------------------------------------------------------ */
/* 忽略表（§8.2）                                                       */
/* ------------------------------------------------------------------ */

const IGNORED_DIRS = new Set([
  '.anvil',
  '.git',
  'node_modules',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  'dist',
  'build',
  '.next',
  'out',
]);

const IGNORED_EXT = new Set(['.exe', '.o', '.obj', '.class', '.pyc']);

/** 目录 / 文件是否忽略；`.anvil.json` 由扫描单独作为元数据读取，不靠这里 */
export function isIgnoredName(name: string, isDir: boolean): boolean {
  if (name.startsWith('.')) return true;
  const lower = name.toLowerCase();
  if (isDir) return IGNORED_DIRS.has(name) || IGNORED_DIRS.has(lower);
  if (lower === 'thumbs.db') return true;
  return IGNORED_EXT.has(lower.slice(lower.lastIndexOf('.')));
}

/** 顶层桶与 .anvil 不能作为 adopt 目标 */
export const TOP_BUCKETS = new Set(['contests', 'practice', 'templates', 'notes', '.anvil']);

export function localTrashStamp(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}
