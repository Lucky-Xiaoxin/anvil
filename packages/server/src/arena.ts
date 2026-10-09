/**
 * 模拟榜单数据层（docs/16 §2）：目录与单场榜单经 jsDelivr 拉取 + `vault/arena/` 落盘缓存。
 *
 * 许可证纪律（§2.4，AGPL-3.0）：只运行时拉取、只落 `vault/`（gitignore），
 * 不把 srk-collection 的代码或数据文件带进本仓。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { vaultDir } from './config.ts';
import type { ArenaCatalogDto, ArenaContestDto, ArenaCatalogNode } from '@anvil/shared';

export const ARENA_BASE = 'https://cdn.jsdelivr.net/gh/algoux/srk-collection@master/';
export const CATALOG_PATH = 'official/config.yaml';
/** 目录 20s、单场 90s（单场实测 ~1.5MB，docs/16 §2.1） */
export const CATALOG_TIMEOUT_MS = 20_000;
export const CONTEST_TIMEOUT_MS = 90_000;
export const MAX_RETRIES = 1;

/** 路径白名单：只允许 official 下的逐段小写名 + 结尾 .srk.json（§2.1，拒 `..` / 编码绕过 / 外部域） */
export const CONTEST_PATH_RE = /^official\/[a-z0-9_\-]+(\/[a-z0-9_\-]+)*\.srk\.json$/;

const USER_AGENT = 'ANVIL/1.0 (personal ICPC training dashboard)';

export type ArenaErrorKind = 'invalid' | 'unavailable';

export class ArenaError extends Error {
  readonly kind: ArenaErrorKind;

  constructor(kind: ArenaErrorKind, message: string) {
    super(message);
    this.name = 'ArenaError';
    this.kind = kind;
  }
}

export const arenaDir = join(vaultDir, 'arena');

export function contestPathOk(path: string): boolean {
  // JS 的 `$` 会放过结尾那枚换行，`%0a` 这类绕过要靠这条显式挡掉
  return CONTEST_PATH_RE.test(path) && !/[\r\n]/.test(path);
}

function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.name === 'TimeoutError' ? '请求超时' : err.message;
  return String(err);
}

function mtimeSeconds(file: string): number {
  return Math.floor(statSync(file).mtimeMs / 1000);
}

/** 原子写入：先落同目录 tmp 再 rename，避免半截文件被下一次命中当缓存读走 */
function writeFileAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, file);
}

/* ---------- 窄 YAML 解析（§2.1：手写、零依赖、缩进 2 空格、只认四个键） ---------- */

interface Line {
  /** 键起始列（列表项 `- key:` 的键列 = 破折号列 + 2） */
  indent: number;
  /** 破折号列；非列表项为 null */
  dash: number | null;
  key: string;
  value: string;
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    const q = s[0];
    if ((q === "'" || q === '"') && s.endsWith(q)) {
      const body = s.slice(1, -1);
      return q === "'" ? body.replace(/''/g, "'") : body.replace(/\\(["\\])/g, '$1');
    }
  }
  return s;
}

/** 去掉行尾注释：`#` 前必须是空白且不在引号内才算注释起点 */
function stripComment(line: string): string {
  let inQuote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote !== null) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inQuote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || line[i - 1] === ' ' || line[i - 1] === '\t')) return line.slice(0, i);
  }
  return line;
}

function tokenize(raw: string): Line[] {
  const out: Line[] = [];
  for (const origin of raw.split('\n')) {
    const text = stripComment(origin.replace(/\r$/, '')).replace(/\s+$/, '');
    if (text.trim() === '') continue;
    const body = text.trimStart();
    const lead = text.length - body.length;
    const isItem = body === '-' || body.startsWith('- ');
    const dash = isItem ? lead : null;
    const keyCol = isItem ? lead + 2 : lead;
    const rest = isItem ? body.slice(2) : body;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)[ \t]*:(.*)$/.exec(rest);
    const [, key = '', restValue = ''] = m ?? [];
    // 裸列表项（`- official`）：key 留空，整段值进 value
    if (key === '') {
      if (isItem) out.push({ indent: keyCol, dash, key: '', value: unquote(restValue || rest) });
      continue;
    }
    out.push({ indent: keyCol, dash, key, value: unquote(restValue) });
  }
  return out;
}

/** 认这五个键：四个结构键 + `root`（config.yaml 顶层那层容器，形状外多出来的一层） */
const KEYS = new Set(['name', 'path', 'format', 'children', 'root']);
const SCALARS = new Set(['name', 'path', 'format']);

/** 解析期的节点：`kids` 必带，出树时才折成 DTO 的可选 `children` */
interface Draft {
  name: string;
  path?: string;
  format?: string;
  kids: Draft[];
}

/**
 * 缩进式 YAML 树 → `{name, path, format?, children?, count}` + 每层叶子计数（docs/16 §2.1）。
 *
 * 手写、零依赖、只认四个键：其余键带标量值的直接跳过，带子树的当作多一层容器（实测顶层是
 * `root:` 那层包装）。读不懂的行忽略而不是抛 —— 目录里一行脏数据不该让整屏空掉。
 * `path` 实测可能是标量，也可能是分段列表（契约原文「path 以 / 连接」），两种都收。
 */
export function parseCatalogYaml(raw: string): { tree: ArenaCatalogNode[]; total: number } {
  const lines = tokenize(raw);

  /** 下一个键是否落在 `keyIndent` 这个键的作用域内（更深缩进，或更深的列表项） */
  const inScope = (i: number, keyIndent: number): boolean => {
    const l = lines[i];
    if (l === undefined) return false;
    return l.indent > keyIndent || (l.dash !== null && l.dash > keyIndent);
  };

  /** 取从 `i` 开始的整段列表项标量（`path:` 的分段写法） */
  const scalarList = (i: number, dashIndent: number): { values: string[]; next: number } => {
    const values: string[] = [];
    let p = i;
    while (p < lines.length) {
      const l = lines[p];
      if (l === undefined || l.dash !== dashIndent || l.key !== '') break;
      values.push(l.value);
      p++;
    }
    return { values, next: p };
  };

  /** 从 `i` 起、键列为 `keyIndent` 的一个映射节点（首键可以挂在列表项上） */
  function nodeAt(i: number, keyIndent: number): { node: Draft; next: number } {
    const node: Draft = { name: '', kids: [] };
    let p = i;
    for (;;) {
      const l = lines[p];
      // 同键列的另一枚 `-` = 兄弟项，本节点到此结束；首键例外（它就是那枚 `-`）
      if (l === undefined || l.indent !== keyIndent || (l.dash !== null && p !== i)) break;
      p++;
      if (!KEYS.has(l.key)) {
        while (inScope(p, keyIndent)) p++;
        continue;
      }
      if (SCALARS.has(l.key)) {
        if (l.value !== '') {
          if (l.key === 'name') node.name = l.value;
          else if (l.key === 'path') node.path = l.value;
          else node.format = l.value;
          continue;
        }
        // 空值标量键：可能是分段列表（path），也可能是被忽略的空容器
        const nx = lines[p];
        if (nx !== undefined && nx.dash !== null && nx.dash > keyIndent && nx.key === '') {
          const got = scalarList(p, nx.dash);
          if (l.key === 'path') node.path = got.values.join('/');
          p = got.next;
          continue;
        }
        continue;
      }
      // children: / root: → 子树（列表项，或更深缩进的一层映射）；`children: []` 是空列表写法
      if (l.value === '[]' || l.value === '{}') continue;
      const nx = lines[p];
      if (nx === undefined || nx.indent <= keyIndent) continue;
      if (nx.dash === null) {
        const kid = nodeAt(p, nx.indent);
        node.kids.push(kid.node);
        p = kid.next;
        continue;
      }
      const dashIndent = nx.dash;
      while (p < lines.length) {
        const item = lines[p];
        if (item === undefined || item.dash !== dashIndent) break;
        const kid = nodeAt(p, item.indent);
        node.kids.push(kid.node);
        p = kid.next;
      }
    }
    return { node, next: p };
  }

  const wrappers: Draft[] = [];
  let i = 0;
  for (;;) {
    const top = lines[i];
    if (top === undefined) break;
    if (!KEYS.has(top.key)) {
      i++;
      while (inScope(i, top.indent)) i++;
      continue;
    }
    const kid = nodeAt(i, top.indent);
    wrappers.push(kid.node);
    i = kid.next;
  }

  /*
   * 顶层那层 `root:` 包装不是类目，五类才是。契约的形状是 `root.children[]`，包装链最多两层
   * （`root:` 那枚键 + 它映射本身），所以这里最多剥两跳 —— 不设上限的话，一份只有一个类目的
   * 目录会被连带剥成它的子年份，类目名就没了。
   */
  let forest = wrappers.filter((n) => n.path !== undefined || n.kids.length > 0);
  for (let hop = 0; hop < 2; hop++) {
    const only = forest[0];
    if (forest.length !== 1 || only === undefined || only.path !== undefined || only.kids.length === 0) break;
    forest = only.kids;
  }

  const normalize = (path: string, format: string | undefined): string => {
    const bare = path.replace(/^\/+/, '');
    const withDir = bare.startsWith('official/') ? bare : `official/${bare}`;
    const isSrk = format === undefined || format === 'srk.json';
    return isSrk && !withDir.endsWith('.srk.json') ? `${withDir}.srk.json` : withDir;
  };

  const countLeaves = (n: Draft): number =>
    n.path !== undefined ? 1 : n.kids.reduce((sum, c) => sum + countLeaves(c), 0);

  const toDto = (n: Draft): ArenaCatalogNode => {
    const count = countLeaves(n);
    if (n.path !== undefined) {
      const leaf: ArenaCatalogNode = { name: n.name, path: normalize(n.path, n.format), count };
      if (n.format !== undefined) leaf.format = n.format;
      return leaf;
    }
    return { name: n.name, children: n.kids.map(toDto), count };
  };

  const tree = forest.map(toDto);
  return { tree, total: tree.reduce((sum, n) => sum + (n.count ?? 0), 0) };
}

/* ---------- 取数 ---------- */

export interface ArenaClientOptions {
  fetchImpl?: typeof fetch;
  dir?: string;
}

export class ArenaClient {
  private readonly fetchImpl: typeof fetch;
  readonly dir: string;
  private readonly catalogFile: string;

  constructor(options: ArenaClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dir = options.dir ?? arenaDir;
    this.catalogFile = join(this.dir, '_catalog.yaml');
  }

  /** 429/5xx 与网络异常重试 1 次；其余状态码原样回给调用方判 */
  private async send(path: string, timeoutMs: number): Promise<{ status: number; text: string }> {
    for (let attempt = 0; ; attempt++) {
      let transient = '';
      try {
        const res = await this.fetchImpl(`${ARENA_BASE}${path}`, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { 'user-agent': USER_AGENT },
        });
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) transient = `HTTP ${res.status}`;
        else return { status: res.status, text };
      } catch (err) {
        transient = reasonOf(err);
      }
      if (attempt >= MAX_RETRIES) throw new ArenaError('unavailable', `${transient} · 已重试 ${MAX_RETRIES} 次`);
    }
  }

  private readCatalogCache(): { fetchedAt: number; text: string } | null {
    if (!existsSync(this.catalogFile)) return null;
    try {
      return { fetchedAt: mtimeSeconds(this.catalogFile), text: readFileSync(this.catalogFile, 'utf8') };
    } catch {
      return null;
    }
  }

  /** 目录：命中缓存直接回；`refresh` 强制重拉；上游失败但有缓存 → 照常回缓存（§2.1 降级不崩） */
  async catalog(refresh = false): Promise<ArenaCatalogDto> {
    const cached = this.readCatalogCache();
    if (cached !== null && !refresh) return this.toCatalogDto(cached.fetchedAt, cached.text);
    try {
      const res = await this.send(CATALOG_PATH, CATALOG_TIMEOUT_MS);
      if (res.status !== 200 || res.text.trim() === '') throw new ArenaError('unavailable', '目录返回的不是 YAML');
      writeFileAtomic(this.catalogFile, res.text);
      return this.toCatalogDto(mtimeSeconds(this.catalogFile), res.text);
    } catch (err) {
      if (cached !== null) return this.toCatalogDto(cached.fetchedAt, cached.text);
      throw err instanceof ArenaError ? err : new ArenaError('unavailable', reasonOf(err));
    }
  }

  private toCatalogDto(fetchedAt: number, text: string): ArenaCatalogDto {
    const { tree, total } = parseCatalogYaml(text);
    return { fetchedAt, total, tree };
  }

  /** 单场：路径镜像落盘，内容终局不变 → 已缓存即回，永不过期（§2.1） */
  async contest(path: string, refresh = false): Promise<ArenaContestDto> {
    if (!contestPathOk(path)) throw new ArenaError('invalid', '榜单路径不合法');
    const file = join(this.dir, path);
    const cached = this.readContestCache(file);
    if (cached !== null && !refresh) return { fetchedAt: cached.fetchedAt, fromCache: true, data: cached.data };
    try {
      const res = await this.send(path, CONTEST_TIMEOUT_MS);
      if (res.status !== 200) throw new ArenaError('unavailable', `榜单文件取不到（HTTP ${res.status}）`);
      const data = JSON.parse(res.text) as unknown;
      writeFileAtomic(file, res.text);
      return { fetchedAt: mtimeSeconds(file), fromCache: false, data };
    } catch (err) {
      if (cached !== null) return { fetchedAt: cached.fetchedAt, fromCache: true, data: cached.data };
      throw err instanceof ArenaError ? err : new ArenaError('unavailable', reasonOf(err));
    }
  }

  /** 磁盘上的缓存可能是半截文件（上一次写入被中断）：读不懂就当作没有，去重拉而不是把路由打成 500 */
  private readContestCache(file: string): { fetchedAt: number; data: unknown } | null {
    if (!existsSync(file)) return null;
    try {
      return { fetchedAt: mtimeSeconds(file), data: JSON.parse(readFileSync(file, 'utf8')) as unknown };
    } catch {
      return null;
    }
  }
}
