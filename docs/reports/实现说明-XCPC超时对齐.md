# 实现说明 · XCPC 前端等待上限对齐

> **日期**：2026-10-28
> **类型**：交付报告（修复批次）
> **分支**：`fix/catalog-refresh-stale`（按用户决定与本批同分支）
> **契约**：`docs/contracts/14-XCPC规格.md` §2.2（2026-10-28 补记）
> **基线**：579/579 → **580/580**（`npm run verify`：typecheck + vitest + build 全绿）

## 1. 背景

用户反馈 XCPC「一直拉取失败」。只读检查：

- 本地 `vault/anvil.db` 的 `xcpc:last_error` = `请求超时 · 已重试 1 次`；最后成功同步是 2026-10-18，档案快照仍是 2026-10-11 版本。
- 当前分支未改 `packages/server/src/sync/xcpc.ts` / XCPC 路由；失败与目录刷新失败可见性改动无关。
- 用内存数据库（复制本地档案，不写真实库）跑完整刷新链路实测：meta 11.3s、官方榜 meta 0.7s、选手分片第一次 60s 超时、重试后约 38.7s 下载完 1,832,583 字节；整次刷新 **110.5s 成功**。
- 前端 `claimXcpc` / `refreshXcpc` 原来只等 **90s**，后端最坏预算约 **161s**（meta 2×20s + 详情 2×60s + 退避），存在「后台还在下载、前台先报失败」的错配。慢链路下就会表现为“一直拉取失败”。

## 2. 修法（最小范围）

- `packages/web/src/api.ts`：新增 `XCPC_SYNC_TIMEOUT_MS = 180_000`；`claimXcpc` / `refreshXcpc` 从 90s 改为该值，覆盖后端最坏预算并留余量。服务端取数、重试、错误文案均不变。
- `packages/web/test/xcpc-timeout.test.ts`：断言两个请求都用 180s，且 180s ≥ 服务端最坏预算 161s，防止以后再把前端超时调小。

## 3. 完成度对照

| 条目 | 状态 | 落点 / 证据 |
|---|---|---|
| 认领 / 刷新等待覆盖后端最坏预算 | 完成 | `api.ts` `XCPC_SYNC_TIMEOUT_MS` |
| 防回归测试 | 完成 | `xcpc-timeout.test.ts` |
| 契约口径 | 完成 | 契约 14 §2.2 补记 |

## 4. 测试与 verify

- 新增用例：`npx vitest run packages/web/test/xcpc-timeout.test.ts` → 1/1。
- `npm run verify`：**typecheck ✓ / vitest 29 文件 580/580 / build ✓**（579 → 580）。
- 本次没有启动真实服务、没有写真实 `vault/`；诊断只读真实库，复现用内存数据库。

## 5. 已知问题 / 不处理项

- 180s 的等待时间较长；慢链路下界面会一直显示同步中。若以后要缩短，应把服务端改成「总预算」取数（与模拟榜单目录同类），而不是再调小前端超时。
- 本次只对齐认领 / 刷新；搜索仍是 45s（服务端最坏约 40.5s），不在用户报告的失败链路上。
- 上游持续超时仍会失败，错误文案保持 `请求超时 · 已重试 1 次`。

## 6. 主要改动与复现

- `packages/web/src/api.ts`：超时常量与两处调用。
- `packages/web/test/xcpc-timeout.test.ts`：新增。
- 复现诊断：`npx vitest run packages/web/test/xcpc-timeout.test.ts`；真机慢链路复现见 §1（内存库，不写真实档案）。
