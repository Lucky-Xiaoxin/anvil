# AGENTS.md · ANVIL（铁砧）

个人 ICPC 训练工作台 · 本地 Web 应用 · Windows 优先 · 中文仓库。

**当前阶段：切片 4、UX 打磨批次、审计修复批次、队名 i18n 修复批次、榜单增强批次（目录「预拉取」+ 回放榜「我的成绩」幽灵行 v8 逐发录入）、榜单修复批次（首杀可见性 / 罚时认第一发 / 弹层空态 / 服务日志）、审计修复批次 2（引擎边界 / 前端健壮性 / 服务卫生 / 文档分层）、奖牌带修复批次（各段名额非累计上界 / 比率分母只数正式队 / 零名额不挂带）均已交付合并（交付见 `docs/reports/实现说明-*.md`；回顾「封榜视角」两态、「我的成绩」幽灵行 v8 口径为最新已交付口径）；**切片 5a「工坊·代码管辖」已以 `--no-ff` 合回 main（`34cfe59`），5a.1「列表分组 / 模板内联编辑 / 默认模板」已通过 PR #1 合并（`7383361`），自测 471/471**。**切片 5a-2「旧代码导入 / 题组语义 / VS Code 打开」已完成修复批次，并以 `--no-ff` 合回 main（`bb0f756`）：一个源目录 = 一个题组（`contest` 文件夹），不再新建 `problem`；旧 `problem` 保留兼容；自测 536/536**。5a-3「批量题组导入 / 来源视图」已按 `docs/contracts/25-工坊-批量题组导入契约.md` 实现并完成修复批次（默认选择祖先优先 / 结果提示 / 同批重复 / 未选中交互）于分支 `feat/workbench-5a.3`（实现提交 `8ed04d9`；`npm run verify` 573/573），**待合并 main**；报告见 `docs/reports/实现说明-工坊-5a3.md`。**5a-4「题组组合 / 对象角色收口」已按 `docs/contracts/26-工坊-题组组合契约.md` 实现于分支 `feat/workbench-5a.3`（实现提交 `dfc6a63`；`npm run verify` 589/589），与 5a-3 同分支待合并 main**：比赛 = `contest`、题组 = `problemset`，题组可选逻辑关联比赛（0..1），生命周期独立；旧数据迁移必须预览 + 确认，**真实 `E:\ACM` 尚未迁移**（用户在工坊「题组迁移」里执行）；报告见 `docs/reports/实现说明-工坊-5a4.md`。项目文档规范见 `docs/文档规范.md`。推进方式为切片制：一次只做一片，每片可独立验收；规格以 `docs/` 为准。

## 先读什么

1. `docs/README.md` —— **文档总索引**（现行契约 / 历史提示词 / 交付报告 / 归档各在哪）。
2. `docs/文档规范.md` —— **文档类型、命名、状态、必备章节、索引与收工检查清单**；写任何新文档前先读。
3. `docs/contracts/26-工坊-题组组合契约.md` —— **5a-4 现行契约（已实现待合并，分支 `feat/workbench-5a.3`）**：比赛 = `contest`、题组 = `problemset`；题组可选逻辑关联比赛（0..1），生命周期独立；旧数据预览迁移。实现见 `docs/reports/实现说明-工坊-5a4.md`；5a-3 按 `arenaPath` 猜角色的 WIP 已作废，以本文为准。
4. `docs/contracts/25-工坊-批量题组导入契约.md` —— **5a-3 草案（已实现待合并，分支 `feat/workbench-5a.3`；对象类型由 26 接管）**：批量叶子题组导入 / 散题 / `sourcePath` 来源视图；不建年 / 月对象或物理目录。`docs/contracts/24-工坊-旧代码导入契约.md` 是 5a-2 已交付契约，单目录安全 / staging / manifest / 去重规则继续有效；`docs/contracts/23-工坊-代码管辖契约.md` 是 5a 基础契约，对象模型 / 标签 / 扫描规则以 23 为准。5a.1 交付见 `docs/reports/实现说明-工坊-5a1.md`；5a-2 报告见 `docs/reports/实现说明-工坊-5a2.md`（早期多候选）/ `docs/reports/实现说明-工坊-题组语义.md`，修复批次见 `docs/reports/实现说明-工坊-5a2修复.md`；5a-3 见 `docs/reports/实现说明-工坊-5a3.md`。
5. `docs/contracts/20-榜单增强规格.md` —— **最新已交付榜单契约**（v8：目录「预拉取」+ 回放榜「我的成绩」逐发录入）。`docs/contracts/16-模拟榜单规格.md` 是切片 4 基础契约；**srk 数据源与许可证纪律仍以它 §2 为准**。
6. `docs/reference/03-数据源可行性.md` —— 外部接口实测细节（含 2026-10-04 AT 段复验更正）。
7. `docs/archive/02-设计讨论记录.md` —— 设计决策背景（选读）。

## 技术锁（不得更换，不得引入清单以外依赖）

- Node ≥ 24 + TypeScript strict；Fastify 5；内置 `node:sqlite`（禁止 better-sqlite3 等任何需编译的原生模块）。
- React 18 + Vite + **手写 CSS**（禁止 Tailwind / shadcn / UI 组件库）；活跃格子图必须自绘 CSS Grid。
- vitest；npm workspaces；单测禁止打真实网络（一律 mock）。

## 常用命令与位置

- `npm run dev`（vite 5173 + 服务 7788，前端热更新）/ `npm run build` + `npm start`（只起 7788 服务构建产物）/ `npm test`；**启停以命令行为主入口**。`start.bat` / `stop.bat` 是双击便捷入口（start 自动构建、独立窗口起服务、端口占用弹三选一；stop 先认 `vault/server.pid`，端口与 PID 不一致时先确认），但 Windows 资源管理器双击 `.bat` 可能弹「无法验证发布者」——那是 Explorer 的外壳检查，与脚本无关（同一文件在命令行里跑不会弹）。服务端口 7788。
- 运行时数据在 `vault/`（gitignore；提供 `vault.example/` 用于初始化）。
- 远端 `origin` = GitHub **私库**（仅作备份）：push 前须经用户同意（同「操作分支」一条）。
- 视觉基线：`design/mock-01-dashboard.html`（切片 1，已冻结）+ `design/mock-02-three-ends.html`（切片 2，已冻结）+ `design/mock-03x-xcpc-explore.html`（切片 3，已定稿）+ `design/mock-04-simboard.html`（切片 4，已冻结；v6 修订 2026-10-10：榜体放大 / 页脚语境化 / 列头五档回迁；v7 修订 2026-10-13：目录「预拉取」+ 「我的成绩」幽灵行；**v8 修订 2026-10-14：幽灵改逐发录入 + 顶栏排名读数，契约 `docs/contracts/20`**）；切片 5a 无独立视觉稿，按契约 §11 + 现有 token 实现，截图见 `design/_shots/work-*.png` / `arena-*.png`；5a.1 截图见 `design/_shots/work-5a1-*.png`；5a-2 截图见 `design/_shots/work-5a2-*.png` 与 `design/_shots/work-group-*.png`；5a-3 截图见 `design/_shots/work-5a3-*.png`；其余截图见 `design/_shots/`。

## 仓库结构

```
docs/       设计文档（架构侧维护；实现 agent 需改契约 / 索引时先征得用户同意）
  README.md   文档总索引
  contracts/  现行契约
  reference/  数据源实测参考
  prompts/    开工提示词（历史）
  briefs/     设计 brief（历史）
  reports/    交付报告 / 审计（历史记录）
  archive/    问卷、草案、讨论记录
design/     视觉稿（前端设计 agent 产出）
packages/   shared | server | web（npm workspaces）
vault/      运行时数据（gitignore）
```

## 规矩

- **操作分支前必须经过用户同意**（切分支、合并、删除、改名、重置等，一律先问再动）。
- **只有合并回 `main`（或后续的长期分支，如 `develop`）时用 `--no-ff`**（显式加参数，保留分支结构的 merge commit，供 GitHub graph 查看）；**其他合并场景不加**（分支间同步等能快进就快进）。仓库没有全局 `merge.ff` 配置，别依赖默认值。
- **工作树卫生**（同一个坑踩过两轮）：所有实现工作**只在自己的分支上提交**——新文件写完就 commit 到本分支，不许长期以"未跟踪"状态留在工作区（未跟踪/未提交的东西不属于任何分支，切回 `main` 时会原样跟着走，看起来就是"main 上又冒出一堆怪文件"）；浏览器 profile、截图草稿、临时脚本一律放**系统 temp**，仓库里（含 `design/`）不留任何临时产物；**被要求回 `main` 或删分支之前，先 `git status` 把工作树清干净**（自己的产物自己收）。
- **服务卫生**：调试起服务就自己收 —— 收工前关掉**自己起的**服务（服务窗口 Ctrl+C，或 `stop.bat`），别把端口留给下一个启动的人。**只收自己启动的进程**（起服务时记 PID）：本机可能同时跑着用户/他人的任务，**绝不按端口号或进程名批量扫杀**（端口被占时最多只读查看）。
- 一切以当前切片契约为准：切片 5a-4 以 `docs/contracts/26` 为现行口径（题组组合 / 对象角色收口；已实现待合并），切片 5a-3 以 `docs/contracts/25` 为导入机制口径（对象类型由 26 接管；已实现待合并），5a-2 以 `docs/contracts/24` 为已交付口径，5a 基础以 `docs/contracts/23` 为准；切片 4 基础契约是 `docs/contracts/16`，榜单增强以 `docs/contracts/20` 为最新已交付；后续切片以各自契约为准。遇歧义 → 最小实现 + `// TODO(切片N)` 注释，不自由发挥大功能。
- 文档按 `docs/文档规范.md` 执行：新文档必须进 `docs/README.md`，状态头 / 类型 / 必备章节 / 收工检查不得省略；历史报告不按新口径重写。
- 不做切片的"顺手扩展 / 顺手重构"；想新增依赖先停下来问。
- 完成后按当前切片契约「测试与验收」节自检，交付报告：完成度对照表 + 截图 + 已知问题。

## PR / 合并入口

- **只在“合回 `main`（或长期分支）”时开 PR**：一个批次分支 = 一个 PR；不为每个 commit 开，不为分支间同步开，废弃分支也不开。
- PR 正文只写三件事：**改了什么 / `npm run verify` 结果 / 已知不处理项**，并链接 `docs/reports/` 下对应报告。原始 agent 审计长文、会话记录不入库。
- **栈叠分支先清底座**：如果当前分支是在另一个未合并分支上切的（例如 `chore/docs-index` 栈在 `fix/audit-round2` 上），先合并底座或 rebase 到最新 `main`，再开 PR；保证 PR diff 只含本批次。
- `push`、开 PR、合并回 `main` 仍需用户明确同意；合并用 `--no-ff`，合并后删分支。用户明确说“这次直接提交”时，才允许跳过 PR。
- PR 是验收入口，不是文档仓库：契约、提示词、交付报告仍按 `docs/README.md` 的目录规则落位。
