# 实现 agent · 开工提示词 · UX 打磨批次

> **交付对象：实现 agent**。本文件 = 本批次唯一工作清单；**视觉基线 = `design/mock-04-simboard.html`（v6.1）**，对照图 `design/_shots/_shot-v6-*.png`（8 张）。
> 背景：切片 4「模拟榜单」已交付合并（main，合并提交 `6d683f5`）。本批次在既有分支 **`feat/ux-polish`** 上做四块调整 —— 全部是用户验收反馈的落地：① 榜体放大并填满；② 侧栏页脚按模块语境化；③ 榜单屏收放侧栏卡顿修复；④ 飞屏动效提速 + 启停脚本。

---

## 0. 开工三件事（先做）

1. `git status` 干净、`git branch --show-current` = **`feat/ux-polish`**（该分支已有设计提交 `5627817` / `31474dc` / `96a6537`，**不要新建分支**）。
2. `npm test` → 基线 **334 / 334 全绿**；`npm run typecheck` 干净。（不绿先查环境，别在红灯上开工。）
3. 浏览器打开 `design/mock-04-simboard.html`：底部 mockbar 切屏 —— `s2` 回放榜 / `s3` 回顾 / `s4` 有页脚样张（Sidebar foot）与密度读数（Board scale）；**拿不准的设计细节一律以 mock 为准，mock 没画的不要自由发挥。**

---

## 任务一｜榜体放大 + 填满内容区（只改 `packages/web/src/styles.css`）

以 mock 的 Board scale 密度读数为准，逐项改：

| 位置（约行号） | 改动 |
|---|---|
| `:root`（62–64） | `--pcw: 30px → 36px`（内格 26→32）、`--rowh: 32px → 36px`、`--headh: 46px → 50px` |
| `.simcol`（895） | 去掉 `max-width:1030px` 与 `margin:0 auto` —— 榜体屏（s2/s3）填满内容区 |
| `.ph b` / `.ph i`（1029–1030） | `12.5px → 13px` / `9px → 9.5px` |
| `.pcell__t` / `.pcell__n`（1044–1045） | `11.5px → 12.5px` / `9px → 9.5px` |

**不动**：`--c-r/--c-s/--c-sol/--c-pen`、`.brow` 结构与 `.brow` 网格定义、`.content` 内边距、`--rail-dur:360ms`、**目录（`.catwrap`）的 1030 收口保持原样**（本批只放榜体屏）。

**验收基准（DOM 实测，无头或真机均可）**：

| 视口 | 内容区 | 题列合计 | Org | Team | 横滚 |
|---|---|---|---|---|---|
| 1280（侧栏展开） | 996 | 468 | ≈158 | ≈177 | 无 |
| 1280（侧栏收起） | 1160 | 468 | ≈235 | ≈264 | 无 |
| 1440 | 1156 | 468 | ≈233 | ≈262 | 无 |

行高 36 · 题列 36（内格 32）· 列头 50 · 主读数 12.5 / 次读数 9.5。

**坑**：列头五档的 `::before` 两侧各多探 2px（`inset:-3px -2px -2px`），榜内 `scrollWidth` 可能 = `clientWidth + 2`，被 `overflow-x:hidden` 裁掉 —— **这是正常的，不是横滚**。判定口径 =「页面级 `scrollWidth == innerWidth`，且榜内无可见横滚条」。

---

## 任务二｜侧栏页脚按模块语境化（`AppShell.tsx` + 三处小管道）

现状：navfoot 只跟 `source`（个人数据当前选中的源），切到别的模块不换内容。目标按 `view` 分流（`AppShell.tsx` 的 navfoot 块，约 97–137 行）：

- **`dashboard`：保持现状，一行不改**（三源读数）。
- **`arena`**：三行 ——
  `目录 <b>N</b> 场 · 榜单本地缓存` / `源 <code>srk-collection</code> 社区快照` / `端口 <b>7788</b> · 不出网`；
  收起态 = 灰点（`#39434F`）+ `<b>N</b>` + 浮标「目录 N 场」/ small「vault/arena · 本地缓存」。
- **`settings` 与 `master`**：两行 ——
  `本地 <code>vault/</code> · 端口 <b>7788</b>` / `不出网 · 数据只在本机`；
  收起态 = 灰点 + `<b>本地</b>` + 浮标「ANVIL · vault/ · 端口 7788」。

`N`（目录场次）的管道（约 10 行，客户端内闭环，无新接口）：

1. `App.tsx`：`const [arenaCount, setArenaCount] = useState<number | null>(null)`；渲染 `#/arena` 时 `<Arena onCount={setArenaCount} />`；把 `arenaCount` 传给 `AppShell`。
2. `Arena.tsx`：`onCount` 透传给 `ArenaCatalog`。
3. `ArenaCatalog.tsx`：目录拉取**成功后** `onCount(data.total)`；失败**不动**（保持上次值）；`null` 时页脚显 `—`（与个人数据页脚未知计数的既有做法一致）。
4. 若按 view 分流后有个别计算变量不再被用到，顺手清掉（别留死代码）。

文案与 mock 一字不差（mock 里的 394 是演示数字，实现取真实 total）；数字/路径样式沿用现有页脚（`<b>` 用 dim 色、`<code>` 包路径）。

---

## 任务三｜榜单屏收放卡顿修复（两处，均已实测定位）

1. **`styles.css` `.brow--body`（约 998 行）追加**：
   `.brow--body{content-visibility:auto;contain-intrinsic-size:auto var(--rowh)}`
   —— 根因：收放动画对 `.app` 的 `grid-template-columns` 做 360ms 补间，**每帧全表重排**（356 行 × 19 列）；行级 content-visibility 让屏外行跳过重排，无头实测收放时 p95 帧 39→11ms。**不许缩 `--rail-dur`、不许上虚拟化。**
2. **`ArenaBoard.tsx`**：`openCellPop` / `openTeamPop`（约 205–213 行）改 `useCallback`（依赖数组应为空）；`BoardRowView`（约 631 行）包 `memo`。
   —— 根因：回调每次渲染新建，打穿 `CellView` 的 memo；live 态走钟每秒 `setElapsed` 会带着整张表 reconcile（实测每 1000ms 一次 22–28ms 尖峰）。修好后：**live 态每秒只重渲顶栏计时，不碰表体**。

**自证（必须给数字，别只说"感觉流畅了"）**：修复前后各测两组 ——
(a) 榜单屏收放侧栏过程的帧时间（max / p95 / 超 50ms 帧数）；
(b) live 态静置 3s 的帧时间（应无 1s 周期的尖峰）。
方法：无头 Edge + CDP（rAF 帧间隔采样 + `PerformanceObserver` 的 `longtask`/`long-animation-frame`），脚本放**系统 temp** 不进仓库。本机已知坑：browser-use MCP 不可用（页面 `innerWidth=0`）；同一 URL 再次 `Page.navigate` 不重载（先切 `about:blank`）。

---

## 任务四｜飞屏提速 + 启停脚本

### 4a. `packages/web/src/fly.ts`（约 8–18 行）

- `out { dur:360, step:41, durStep:9 }` → `{ dur:180, step:20, durStep:5 }`
- `in { dur:520, step:30, durStep:14 }` → `{ dur:260, step:15, durStep:7 }`
- `handoff: 40 → 20`
- 整段从 1390/1484ms → **约 695/742ms**（n=6/7 口径，用户要"约砍半"）。
- **不动**：时序不变量（起步/完成严格递增）、"编排期不可打断"、reduced-motion 直落、`rise/scale/dead`；注释里把口径更新到新数字。

### 4b. `start.bat`（仓库根）+ 新增 `stop.bat`

- `start.bat`：**先查端口 7788**，被占时显示占用者 PID 并弹三选一（用 `choice`）：
  `[1] 结束它并启动  [2] 打开已有实例（start 浏览器）  [3] 退出`；
  顺手修掉一个 bug：`call npm start` 那行没兜错误（其余行都有 `|| goto fail`），失败会直接关窗 → 补 `|| goto fail`（fail 分支保持 pause）。
- `stop.bat`：找 7788 的 LISTENING PID → `taskkill`；没有则提示"未在运行"；结束前 `pause`。
- **控制台文案用英文**（沿用 start.bat 现有风格，.bat 里中文有编码坑）；bat 里 `netstat | findstr` 的管道要写成 `^|`。
- 自证：先手动开着服务双击 `start.bat` 走 [1]/[2]/[3] 三个分支各一次；再 `stop.bat` 关掉、`start.bat` 正常起。

---

## 硬纪律（照抄自查）

- 单 agent、**只提交到 `feat/ux-polish`**；新文件写完就 commit（工作树卫生）；**不要合并分支、不要 push**（合并由用户点头、架构侧执行）。
- **不改 `docs/`、不改 `design/mock-*`**；可以在 `design/_shots/` 新增本批证据图 `ux-*.png`；不新增依赖；不碰 `vault/`。
- 不做清单之外的："顺手"重构 / 虚拟化 / `--rail-dur` 调整 / 目录 1030 改动 / 个人数据页脚改动 / ≥1600 的 Org·Team 上限。
- 测完**关掉自己起的服务**（自己的进程自己收）。
- `npm test`（334 基线不许转红）+ `npm run typecheck` + `npm run build` 全绿才算完。

## 交付报告（`实现说明-UX批次.md`，仓库根，随分支提交）

1. 任务一~四**逐条对照**（含上面全部基准数字的实测值：榜体三档视口读数、卡顿修复前后帧时间、live 态尖峰前后、飞屏整段时长）。
2. 自证截图（定稿图放 `design/_shots/ux-*.png`）：榜体 1280/1440 两档、页脚三语境（个人数据/榜单/设置）两态、收放卡顿修复证据、start.bat 三分支 + stop.bat。
3. 已知问题与偏差 —— 如实列，不藏。
