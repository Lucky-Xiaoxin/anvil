/**
 * 榜单路径白名单（docs/contracts/16 §2.1）：工坊的 `links.arenaPath` 也要用同一套判据，
 * 所以纯正则搬进 shared；server 侧 arena.ts 从这里引用并继续 re-export，别复制第二份。
 */
export const CONTEST_PATH_RE = /^official\/[a-z0-9_\-]+(\/[a-z0-9_\-]+)*\.srk\.json$/;

export function contestPathOk(path: string): boolean {
  // JS 的 `$` 会放过结尾那枚换行，`%0a` 这类绕过要靠这条显式挡掉
  return CONTEST_PATH_RE.test(path) && !/[\r\n]/.test(path);
}
