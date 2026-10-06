# AGENTS.md · ANVIL（铁砧）

个人 ICPC 训练工作台 · 本地 Web 应用 · Windows 优先 · 中文仓库。

**当前阶段：切片 3「XCPC 实装」已交付合并（2026-10-07）；下一片待定（候选：切片 4 = 掌握图）**。推进方式为切片制：一次只做一片，每片可独立验收；规格以 `docs/` 为准。

## 先读什么

1. `docs/14-XCPC规格.md` —— 切片 3「XCPC 实装」的实现契约（**已交付**；含实现期修订与复核后修订，XCPC 数据源细节以它 §2 为准）。`docs/09-AT规格.md` 是切片 2 契约；`docs/04-骨架规格.md` 是切片 1 契约（均已交付），均作背景参考。
2. `docs/03-数据源可行性.md` —— 外部接口实测细节（含 2026-10-04 AT 段复验更正）。
3. `docs/02-设计讨论记录.md` —— 设计决策背景（选读）。

## 技术锁（不得更换，不得引入清单以外依赖）

- Node ≥ 24 + TypeScript strict；Fastify 5；内置 `node:sqlite`（禁止 better-sqlite3 等任何需编译的原生模块）。
- React 18 + Vite + **手写 CSS**（禁止 Tailwind / shadcn / UI 组件库）；活跃格子图必须自绘 CSS Grid。
- vitest；npm workspaces；单测禁止打真实网络（一律 mock）。

## 常用命令与位置

- `npm run dev` / `npm run build` / `npm start` / `npm test`；`start.bat` 为双击入口；服务端口 7788。
- 运行时数据在 `vault/`（gitignore；提供 `vault.example/` 用于初始化）。
- 视觉基线：`design/mock-01-dashboard.html`（切片 1，已冻结）+ `design/mock-02-three-ends.html`（切片 2，已冻结）+ `design/mock-03x-xcpc-explore.html`（切片 3，已定稿：平台色玫瑰）；截图见 `design/_shots/`。

## 仓库结构

```
docs/       设计文档（架构侧维护，实现 agent 不要改）
design/     视觉稿（前端设计 agent 产出）
packages/   shared | server | web（npm workspaces）
vault/      运行时数据（gitignore）
```

## 规矩

- **操作分支前必须经过用户同意**（切分支、合并、删除、改名、重置等，一律先问再动）。
- **只有合并回 `main`（或后续的长期分支，如 `develop`）时用 `--no-ff`**（显式加参数，保留分支结构的 merge commit，供 GitHub graph 查看）；**其他合并场景不加**（分支间同步等能快进就快进）。仓库没有全局 `merge.ff` 配置，别依赖默认值。
- 一切以当前切片契约（现为 `docs/14`）为准；切片 1 / 2 基线参考 `docs/04` / `docs/09`。遇歧义 → 最小实现 + `// TODO(切片N)` 注释，不自由发挥大功能。
- 不做切片的"顺手扩展 / 顺手重构"；想新增依赖先停下来问。
- 完成后按当前切片契约「测试与验收」节自检，交付报告：完成度对照表 + 截图 + 已知问题。
