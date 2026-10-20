/**
 * 模拟榜单数据层（docs/contracts/16 §2）：目录与单场榜单经 jsDelivr 拉取 + `vault/arena/` 落盘缓存。
 *
 * 许可证纪律（§2.4，AGPL-3.0）：只运行时拉取、只落 `vault/`（gitignore），
 * 不把 srk-collection 的代码或数据文件带进本仓。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { vaultDir } from './config.ts';
import { writeFileAtomic } from './atomic.ts';
import type { ArenaCatalogDto, ArenaContestDto, ArenaCatalogNode } from '@anvil/shared';

/**
 * 上游镜像顺序。契约（§2.1）只钉了 jsDelivr 一条，实测不够用：
 * srk-collection 整包已过 jsDelivr 的 50MB 上限，边缘节点命中缓存时照常 200，
 * 一回源就稳定 403「Package size exceeded the configured limit of 50 MB」（三个镜像同答），
 * 而 raw.githubusercontent 没有包大小限制、但大文件偶发连接重置 —— 两边互兜才拉得动。
 */
export const ARENA_BASE = 'https://cdn.jsdelivr.net/gh/algoux/srk-collection@master/';
export const ARENA_RAW_BASE = 'https://raw.githubusercontent.com/algoux/srk-collection/master/';
export const ARENA_HOSTS = [ARENA_BASE, ARENA_RAW_BASE];
export const CATALOG_PATH = 'official/config.yaml';
/**
 * 取数预算（docs/contracts/16 §2.1）：目录 20s、单场 90s。
 * 这两个数是**总预算** —— 重试与退避都从里面扣，不让"重试到天荒地老"把界面挂住。
 */
export const CATALOG_TIMEOUT_MS = 20_000;
export const CONTEST_TIMEOUT_MS = 90_000;
/**
 * 契约写"失败重试 1 次"，实测不够：jsDelivr 对**冷缓存 / 突发**会回 403，
 * 同一文件连打几轮就通（2026-10-09 抽样 20 场：首试失败 5，全部在 2–4 轮内成功）。
 * 所以按 3 次退避重试实现，理由与影响写进交付报告。
 */
export const MAX_RETRIES = 3;
export const DEFAULT_BACKOFF_MS = [500, 1_500, 4_000];

/** 路径白名单：只允许 official 下的逐段小写名 + 结尾 .srk.json（§2.1，拒 `..` / 编码绕过 / 外部域） */
export const CONTEST_PATH_RE = /^official\/[a-z0-9_\-]+(\/[a-z0-9_\-]+)*\.srk\.json$/;

const USER_AGENT = 'ANVIL/1.0 (personal ICPC training dashboard)';

export type ArenaErrorKind = 'invalid' | 'unavailable' | 'not-found';

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

/** 报错文案里只留主机名：用户要看得懂是哪条源不通，不需要一整条 URL */
function hostOf(base: string): string {
  const h = base.split('/')[2] ?? base;
  return h === 'cdn.jsdelivr.net' ? 'jsDelivr' : h === 'raw.githubusercontent.com' ? 'GitHub' : h;
}

/** 403 在这条 CDN 上是"暂时"而不是"没有"：冷缓存与限流都回它，实测几轮后必通 */
function isTransient(status: number): boolean {
  return status === 403 || status === 408 || status === 429 || status >= 500;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mtimeSeconds(file: string): number {
  return Math.floor(statSync(file).mtimeMs / 1000);
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

/** 解析期的节点：`seg` = 该节点的 `path` 段（真实目录里每个节点都带一段，不是整条路径） */
interface Draft {
  name: string;
  seg: string;
  format?: string;
  kids: Draft[];
}

/**
 * 缩进式 YAML 树 → `{name, path, format?, children?, count}` + 每层叶子计数（docs/contracts/16 §2.1）。
 *
 * 手写、零依赖、只认四个键（实测 config.yaml 2026-10-09 的形状）：
 * - 每个节点的 `path` 是**一段**目录名，完整官方路径 = 沿链的 `path` 段以 `/` 连接 + `official/` 前缀
 *   + `.` + `format`（契约原文「official/<path 以 / 连接>.srk.json」）；
 * - 叶子 = 没有 `children` 的节点，判据是 `format` 而不是 `path`（分组同样带 `path`）；
 * - `root:` 那层容器不带 `path`，当作透明容器把 children 提上来，五类才是顶层；
 * - 其余键带标量值的直接跳过，带子树的当作多一层容器；读不懂的行忽略而不是抛 ——
 *   目录里一行脏数据不该让整屏空掉（§2.1 的防御要求）。
 */
export function parseCatalogYaml(raw: string): { tree: ArenaCatalogNode[]; total: number } {
  const lines = tokenize(raw);

  /** 下一个键是否落在 `keyIndent` 这个键的作用域内（更深缩进，或更深的列表项） */
  const inScope = (i: number, keyIndent: number): boolean => {
    const l = lines[i];
    if (l === undefined) return false;
    return l.indent > keyIndent || (l.dash !== null && l.dash > keyIndent);
  };

  /** 取从 `i` 开始的整段列表项标量（`path:` 的分段写法，防御用） */
  const scalarList = (i: number, dashIndent: number): { values: string[]; next: number } => {
    const values: string[] = [];
    let p = i;
    for (;;) {
      const l = lines[p];
      if (l === undefined || l.dash !== dashIndent || l.key !== '') break;
      values.push(l.value);
      p++;
    }
    return { values, next: p };
  };

  /** 从 `i` 起、键列为 `keyIndent` 的一个映射节点（首键可以挂在列表项上） */
  function nodeAt(i: number, keyIndent: number): { node: Draft; next: number } {
    const node: Draft = { name: '', seg: '', kids: [] };
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
          else if (l.key === 'path') node.seg = l.value;
          else node.format = l.value;
          continue;
        }
        const nx = lines[p];
        if (nx !== undefined && nx.dash !== null && nx.dash > keyIndent && nx.key === '') {
          const got = scalarList(p, nx.dash);
          if (l.key === 'path') node.seg = got.values.join('/');
          p = got.next;
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
      for (;;) {
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

  /**
   * 出树：叶子拼完整官方路径，分组带 children 与计数；不带 `path` 段的容器（`root:` 那层）
   * 透明地把 children 提到父层，所以顶层就是契约说的五类。
   */
  const build = (n: Draft, chain: string[]): ArenaCatalogNode[] => {
    const here = n.seg === '' ? chain : [...chain, n.seg];
    if (n.kids.length === 0) {
      // 叶子 = 带 `format` 的那个键（真实目录里分组同样带 path，靠 format 区分）；
      // 既没孩子也没 format = 空分组（`children: []`），丢掉而不是编出一条取不到的路径
      if (n.seg === '' || n.format === undefined) return [];
      const leaf: ArenaCatalogNode = { name: n.name, path: `official/${here.join('/')}.${n.format}`, count: 1 };
      leaf.format = n.format;
      return [leaf];
    }
    const children = n.kids.flatMap((k) => build(k, here));
    if (children.length === 0) return [];
    if (n.seg === '') return children;
    const count = children.reduce((sum, c) => sum + (c.count ?? 0), 0);
    return [{ name: n.name, children, count }];
  };

  const tree = wrappers.flatMap((w) => build(w, []));
  return { tree, total: tree.reduce((sum, n) => sum + (n.count ?? 0), 0) };
}

/* ---------- 取数 ---------- */

export interface ArenaClientOptions {
  fetchImpl?: typeof fetch;
  dir?: string;
  /** 退避节奏；单测传全 0 免等 */
  backoffMs?: number[];
  /** 上游镜像列表；单测只给一条就能钉住"逐源兜底"的顺序 */
  hosts?: string[];
}

export class ArenaClient {
  private readonly fetchImpl: typeof fetch;
  readonly dir: string;
  private readonly catalogFile: string;
  private readonly backoffMs: number[];
  private readonly hosts: string[];

  constructor(options: ArenaClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.dir = options.dir ?? arenaDir;
    this.catalogFile = join(this.dir, '_catalog.yaml');
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.hosts = options.hosts ?? ARENA_HOSTS;
  }

  /**
   * 在 `budgetMs` 总预算内取文件：逐源轮转，每源 403/408/429/5xx 与网络异常按退避重试；
   * 某源回 404 就换下一源，**所有源都 404** 才判「上游没有」（重试无意义，也不该诱导用户再点）。
   */
  private async send(path: string, budgetMs: number): Promise<{ status: number; text: string }> {
    const deadline = Date.now() + budgetMs;
    const notes: string[] = [];
    let missing = 0;
    for (const base of this.hosts) {
      const host = hostOf(base);
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        try {
          const res = await this.fetchImpl(`${base}${path}`, {
            signal: AbortSignal.timeout(left),
            headers: { 'user-agent': USER_AGENT },
          });
          const text = await res.text();
          if (res.status === 404) {
            missing += 1;
            notes.push(`${host} 404`);
            break;
          }
          if (!isTransient(res.status)) return { status: res.status, text };
          notes.push(`${host} HTTP ${res.status}`);
        } catch (err) {
          if (err instanceof ArenaError) throw err;
          notes.push(`${host} ${reasonOf(err)}`);
        }
        const wait = attempt < MAX_RETRIES ? Math.min(this.backoffMs[attempt] ?? 1_000, Math.max(0, deadline - Date.now())) : 0;
        if (wait > 0) await sleep(wait);
      }
    }
    const tried = [...new Set(notes)].join(' → ');
    if (missing === this.hosts.length) throw new ArenaError('not-found', '上游没有这份榜单');
    throw new ArenaError('unavailable', `${tried || '请求超时'} · 已重试 ${MAX_RETRIES} 次 · ${this.hosts.length} 个源`);
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
      /*
       * 先解析后落盘（与 contest() 同纪）：`parseCatalogYaml` 吃垃圾**不抛错**（返回空树），
       * 一个 200 的垃圾响应若先落盘，会把好缓存覆盖成「目录 0 场」且回退分支永远走不到。
       * 空树视为无效 → 抛 unavailable，降级路径（有旧缓存回旧缓存）保持原样。
       */
      const parsed = parseCatalogYaml(res.text);
      if (parsed.tree.length === 0) throw new ArenaError('unavailable', '目录内容不合法');
      writeFileAtomic(this.catalogFile, res.text);
      return {
        fetchedAt: mtimeSeconds(this.catalogFile),
        total: parsed.total,
        tree: this.annotateCached(parsed.tree),
      };
    } catch (err) {
      if (cached !== null) return this.toCatalogDto(cached.fetchedAt, cached.text);
      throw err instanceof ArenaError ? err : new ArenaError('unavailable', reasonOf(err));
    }
  }

  private toCatalogDto(fetchedAt: number, text: string): ArenaCatalogDto {
    const { tree, total } = parseCatalogYaml(text);
    return { fetchedAt, total, tree: this.annotateCached(tree) };
  }

  /**
   * 给树叶子标 `cached`（docs/contracts/20 §1）：镜像文件 `vault/arena/<官方路径>` 在不在磁盘上。
   * 目录的**两条**回吐路径（新鲜拉取 / 读缓存文件）都要过这里 —— 只标一条会在读缓存目录时全漏。
   * 394 枚叶子 × existsSync，本地磁盘判断，零压力。
   */
  private annotateCached(nodes: ArenaCatalogNode[]): ArenaCatalogNode[] {
    return nodes.map((n) =>
      n.path !== undefined
        ? { ...n, cached: contestPathOk(n.path) && existsSync(join(this.dir, n.path)) }
        : { ...n, children: this.annotateCached(n.children ?? []) },
    );
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
