# AGENTS.md · ANVIL（铁砧）

个人 ICPC 训练工作台 · 本地 Web 应用 · Windows 优先 · 中文仓库。

**当前阶段：切片 1「工作台骨架」**。推进方式为切片制：一次只做一片，每片可独立验收；规格以 `docs/` 为准。

## 先读什么

1. `docs/04-骨架规格.md` —— **当前切片的实现契约**（交付物 / 数据层 / API / UI / 验收 / Out of Scope 与约束）。做切片 1 只信这份。
2. `docs/03-数据源可行性.md` —— 外部接口实测细节（切片 1 所需部分已内联在 04）。
3. `docs/02-设计讨论记录.md` —— 设计决策背景（选读）。

## 技术锁（不得更换，不得引入清单以外依赖）

- Node ≥ 24 + TypeScript strict；Fastify 5；内置 `node:sqlite`（禁止 better-sqlite3 等任何需编译的原生模块）。
- React 18 + Vite + **手写 CSS**（禁止 Tailwind / shadcn / UI 组件库）；活跃格子图必须自绘 CSS Grid。
- vitest；npm workspaces；单测禁止打真实网络（一律 mock）。

## 常用命令与位置

- `npm run dev` / `npm run build` / `npm start` / `npm test`；`start.bat` 为双击入口；服务端口 7788。
- 运行时数据在 `vault/`（gitignore；提供 `vault.example/` 用于初始化）。
- 视觉基线：`design/mock-01-dashboard.html`（**已冻结**，实现一律照抄；v2 截图见 `design/_shots/`）。

## 仓库结构

```
docs/       设计文档（架构侧维护，实现 agent 不要改）
design/     视觉稿（前端设计 agent 产出）
packages/   shared | server | web（npm workspaces）
vault/      运行时数据（gitignore）
```

## 规矩

- 一切以 `docs/04` 为契约；遇歧义 → 最小实现 + `// TODO(切片N)` 注释，不自由发挥大功能。
- 不做切片的"顺手扩展 / 顺手重构"；想新增依赖先停下来问。
- 完成后按 `docs/04` §6 自检，交付报告：完成度对照表 + 截图 + 已知问题。
