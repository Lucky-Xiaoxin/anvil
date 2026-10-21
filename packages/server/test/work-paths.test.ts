import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkError } from '../src/work/errors.ts';
import { isIgnoredName, resolveInside, validateRootPath } from '../src/work/paths.ts';

const made: string[] = [];
function tempBase(): string {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-work-paths-'));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length > 0) {
    const dir = made.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function opts(base: string) {
  const repo = join(base, 'repo');
  const vault = join(base, 'vault');
  mkdirSync(repo, { recursive: true });
  mkdirSync(vault, { recursive: true });
  return { repoRoot: repo, vaultDir: vault };
}

const errorKind = (fn: () => unknown): string => {
  try {
    fn();
    return 'no-error';
  } catch (err) {
    return err instanceof WorkError ? err.kind : 'other';
  }
};

describe('受管根校验（契约 §3.1 / §10）', () => {
  it('接受普通绝对目录与尚不存在的绝对路径', () => {
    const base = tempBase();
    const o = opts(base);
    const root = join(base, 'root');
    mkdirSync(root);
    expect(validateRootPath(root, o)).toBe(root);
    expect(validateRootPath(join(base, 'not-created'), o)).toBe(join(base, 'not-created'));
  });

  it('接受反斜杠与「复制为路径」的引号（Windows 默认复制形状）', () => {
    const base = tempBase();
    const o = opts(base);
    const root = join(base, 'root');
    mkdirSync(root);
    const winPath = root.replace(/\//g, '\\');
    expect(validateRootPath(`  "${winPath}"  `, o)).toBe(root);
    expect(validateRootPath(`'${winPath}'`, o)).toBe(root);
  });

  it('拒绝相对路径、盘符根、已存在的文件', () => {
    const base = tempBase();
    const o = opts(base);
    expect(errorKind(() => validateRootPath('anvil-work', o))).toBe('root-invalid');
    expect(errorKind(() => validateRootPath(parse(base).root, o))).toBe('root-invalid');
    const file = join(base, 'file.txt');
    writeFileSync(file, 'x');
    expect(errorKind(() => validateRootPath(file, o))).toBe('root-invalid');
  });

  it('拒绝仓库内、vault 内、Windows 与 Program Files', () => {
    const base = tempBase();
    const o = opts(base);
    expect(errorKind(() => validateRootPath(join(o.repoRoot, 'work'), o))).toBe('root-invalid');
    expect(errorKind(() => validateRootPath(join(o.vaultDir, 'work'), o))).toBe('root-invalid');
    if (process.platform === 'win32') {
      expect(errorKind(() => validateRootPath('C:\\Windows\\Temp', o))).toBe('root-invalid');
      expect(errorKind(() => validateRootPath('C:\\Program Files\\anvil', o))).toBe('root-invalid');
    }
  });

  it('根本身是符号链接 → 拒绝', () => {
    const base = tempBase();
    const o = opts(base);
    const real = join(base, 'real-root');
    mkdirSync(real);
    const link = join(base, 'link-root');
    try {
      symlinkSync(real, link, 'junction');
    } catch {
      return; // 本机不支持 junction 时跳过
    }
    expect(errorKind(() => validateRootPath(link, o))).toBe('root-invalid');
  });
});

describe('根内相对路径（契约 §10.1 / §10.2）', () => {
  it('接受普通子路径，拒绝 .. / 绝对路径 / 盘符 / UNC', () => {
    const base = tempBase();
    const root = join(base, 'root');
    mkdirSync(join(root, 'contests', 'x'), { recursive: true });
    expect(resolveInside(root, 'contests/x')).toBe(join(root, 'contests', 'x'));
    expect(resolveInside(root, 'contests\\x')).toBe(join(root, 'contests', 'x'));
    expect(resolveInside(root, '"contests\\x"')).toBe(join(root, 'contests', 'x'));
    for (const bad of ['..', '../x', 'contests/../../x', join(base, 'x'), 'C:\\Windows', '\\\\server\\share', '/etc/passwd']) {
      expect(errorKind(() => resolveInside(root, bad)), bad).toBe('unsafe-path');
    }
  });

  it('缺失目标：allowMissing 与否', () => {
    const base = tempBase();
    const root = join(base, 'root');
    mkdirSync(root);
    expect(errorKind(() => resolveInside(root, 'missing'))).toBe('not-found');
    expect(resolveInside(root, 'missing', { allowMissing: true })).toBe(join(root, 'missing'));
  });

  it('越界 junction / 中间段链接 → 拒绝', () => {
    const base = tempBase();
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'x');
    const link = join(root, 'link');
    try {
      symlinkSync(outside, link, 'junction');
    } catch {
      return; // 本机不支持 junction 时跳过
    }
    expect(errorKind(() => resolveInside(root, 'link'))).toBe('unsafe-path');
    expect(errorKind(() => resolveInside(root, 'link/secret.txt'))).toBe('unsafe-path');
  });

  it('忽略表（§8.2）', () => {
    expect(isIgnoredName('.anvil', true)).toBe(true);
    expect(isIgnoredName('.anvil.json', false)).toBe(true);
    expect(isIgnoredName('node_modules', true)).toBe(true);
    expect(isIgnoredName('build', true)).toBe(true);
    expect(isIgnoredName('out', true)).toBe(true);
    expect(isIgnoredName('a.exe', false)).toBe(true);
    expect(isIgnoredName('a.OBJ', false)).toBe(true);
    expect(isIgnoredName('Thumbs.db', false)).toBe(true);
    expect(isIgnoredName('main.cpp', false)).toBe(false);
    expect(isIgnoredName('contest', false)).toBe(false);
  });
});
