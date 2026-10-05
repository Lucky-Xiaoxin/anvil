/**
 * 一个源的数据只属于一个 handle：换了人就在这个源的域内清空重建。
 * submissions 会把两个人的提交叠在一起，rating_history 更狠 —— 它以 (source, contest_key) 为主键，
 * 两人打过的同一场会互相覆盖，曲线变成两个 rating 的拼图。
 */
export function switchNote(owner: string | null, handle: string, stale: number): string | null {
  if (owner === handle) return null;
  if (owner === null) return stale > 0 ? `本地数据无法归属 handle → 清空 ${stale} 条，为 ${handle} 重建` : null;
  return `换 handle：清掉 ${owner} 的 ${stale} 条数据，为 ${handle} 全量重建`;
}
