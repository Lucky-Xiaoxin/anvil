# 实现说明 · UX 打磨批次

分支 `feat/ux-polish` · 基线 `main`（切片 4 合并提交 `6d683f5`）· 视觉基线 `design/mock-04-simboard.html` v6.1 · 工作清单 `docs/18`
完成日期 2026-10-10 · 环境 Windows 11 / Node 24 / 无头 Edge（`--headless=new` + CDP，脚本与 profile 全在系统 temp，仓库零临时产物）

## 0. 开工基线

| 项 | 结果 |
|---|---|
| 分支 | `feat/ux-polish`（未新建，沿用设计提交 `5627817` / `31474dc` / `96a6537`） |
| `npm test` | 开工 334 / 334 绿 → 收尾 334 / 334 绿（18 文件） |
| `npm run typecheck` | 三包干净 |
| `npm run build` | 干净（末轮 `index-DahhBpuL.js` 310.47 kB / gzip 94.96 kB） |

---

## 1. 任务一 · 榜体放大 + 填满内容区（`packages/web/src/styles.css`）

### 1.1 改动对照

| 位置 | 清单要求 | 实做 |
|---|---|---|
| `:root` | `--pcw` 30→36、`--rowh` 32→36、`--headh` 46→50 | ✅ 36 / 36 / 50（注释「内含 26px 格」同步为 32px） |
| `.simcol` | 去 `max-width:1030px` 与 `margin:0 auto` | ✅ 只剩 `width:100%;flex:1 1 auto;min-height:0;…` |
| `.ph b` / `.ph i` | 12.5→13 / 9→9.5 | ✅ 13px / 9.5px |
| `.pcell__t` / `.pcell__n` | 11.5→12.5 / 9→9.5 | ✅ 12.5px / 9.5px |
| 不动项 | `--c-r/--c-s/--c-sol/--c-pen`、`.brow` 结构与网格、`.content` 内边距、`--rail-dur:360ms`、`.catwrap` 的 1030 收口 | ✅ 全部原样（`--c-r:46 --c-s:34 --c-sol:46 --c-pen:56` 未动，目录仍 `max-width:1030px;margin:0 auto`） |

另：切片 4 段落头的出处注释由「mock-04 v5」订正为「v6.1」，与本批基线一致。

### 1.2 验收基准（DOM 实测 · 样张场次 ICPC 2023 杭州站 = 13 题 × 483 队，终榜态）

| 视口 | 侧栏 | 内容区 | 题列合计 | Org | Team | 行高 | 列头 | 内格 | 主/次读数 | 横滚 |
|---|---|---|---|---|---|---|---|---|---|---|
| 1280 | 展开 | **996** | **468** | 162 | 182 | 36 | 50 | 32 | 12.5 / 9.5 | 无 |
| 1280 | 收起 | **1160** | **468** | 240 | 268 | 36 | 50 | 32 | 12.5 / 9.5 | 无 |
| 1440 | 展开 | **1156** | **468** | 238 | 266 | 36 | 50 | 32 | 12.5 / 9.5 | 无 |
| 1440 | 收起 | 1320 | 468 | 315 | 353 | 36 | 50 | 32 | 12.5 / 9.5 | 无 |

列头 `b` = 13px、`i` = 9.5px（表内「主/次读数」指题格 `.pcell__t` / `.pcell__n`）。

- 内容区三档 996 / 1160 / 1156 与清单**逐字对上**；题列合计 468 对上（13 × 36）。
- 横滚判定按清单口径：页面级 `documentElement.scrollWidth == innerWidth`（1280=1280、1440=1440）；榜内 `scrollWidth - clientWidth = 2`，正是列头五档 `::before` 两侧各探 2px 被 `overflow-x:hidden` 裁掉的那 2px，榜内无可见横滚条（`.boardscroll` 计算值 `overflow-x: hidden`）。
- Org / Team 比清单约数高 4–5px：这两列是 `minmax(0,1fr)` 与 `minmax(0,1.12fr)` 吃掉剩余宽度的结果，剩余 = 内容区 − 182（四条定宽列）− 468，1280 展开档解析为 163.2 / 182.8，实测 162 / 182 即该公式值；清单的 ≈158 / ≈177 是向下取整的近似。见 §5 偏差 1。

---

## 2. 任务二 · 侧栏页脚按模块语境化

### 2.1 分流与文案（实测 innerText，1440 视口）

| view | 展开态（`.navfoot__full`） | 收起态（`.navfoot__rail`） |
|---|---|---|
| `dashboard` | `253 条提交 · 104 题` / `本地 vault/anvil.db` / `端口 7788 · 不出网`（**一行未改**） | 源状态点 + `253` + 浮标「Codeforces 读数 / vault/anvil.db · 本地」（未改） |
| `arena` | `目录 394 场 · 榜单本地缓存` / `源 srk-collection 社区快照` / `端口 7788 · 不出网` | 灰点 `#39434F` + `394` + 浮标「目录 394 场 / vault/arena · 本地缓存」 |
| `settings` | `本地 vault/ · 端口 7788` / `不出网 · 数据只在本机` | 灰点 + `本地` + 浮标「ANVIL · vault/ · 端口 7788」 |
| `master` | 同 `settings`（实测文案一致） | 同 `settings` |

- 与 mock 逐字对齐；mock 里的演示数 394 由真实 `total` 顶替（实测正是 394）。
- 端口取 `window.location.port || '7788'`，与既有页脚同源，不写死。
- 数字用 `<b className="num">`（`.navfoot b` = dim 色 600 字重）、路径与源名用 `<code>`，沿用现有页脚样式。
- 页脚定高与隔断线未动（`navfoot` 规则未改）。

### 2.2 `N`（目录场次）管道

| 环节 | 实做 |
|---|---|
| `App.tsx` | `const [arenaCount, setArenaCount] = useState<number \| null>(null)`；`view === 'arena'` 时渲染 `<Arena onCount={setArenaCount} />`；`arenaCount` 传给 `AppShell` |
| `Arena.tsx` | 新增 `onCount` prop，透给 `ArenaCatalog`（回放屏不挂目录，值保持上一次） |
| `ArenaCatalog.tsx` | `fetchCatalog` 成功分支里 `onCount(res.total)`；失败分支不碰（页脚留旧值）；`null` 时页脚显 `—` |
| 死代码 | 逐变量核过：`isXcpc / state / src / claimed / railCount / name / days / ready` 在顶栏与 dashboard 分支仍被用，无残留 |

客户端内闭环，未新增接口、未新增依赖。

---

## 3. 任务三 · 榜单屏收放卡顿修复

### 3.1 改动

1. `styles.css`：`.brow--body` 追加 `content-visibility:auto;contain-intrinsic-size:auto var(--rowh)`（实测生效值 `contentVisibility: auto`）。**未缩 `--rail-dur`（仍 360ms）、未上虚拟化。**
2. `ArenaBoard.tsx`：`openCellPop` / `openTeamPop` 改 `useCallback(…, [])`；`BoardRowView` 包 `memo`。

### 3.2 自证数字（同一场次、同一 profile、同一脚本，两轮各测）

样张：ICPC 2023 杭州站 **live 态**（预置钟到 110 分钟使榜体填满）· 483 行 × 19 列 · 6279 个题格 · 视口 1280×900 · 不强制 reduced-motion（轨道补间照跑）。
方法：rAF 帧间隔采样 + `PerformanceObserver`（`longtask` / `long-animation-frame`）+ CDP `Performance.getMetrics` 的布局累计量。

**(a) 收放侧栏 6 次（3 收 + 3 放，各隔 900ms，窗口 6.0s）**

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 最坏帧 | **39ms** | **17ms** |
| p95 帧 | **33ms** | **11ms** |
| 中位帧 | 6ms | 6ms |
| >30ms 帧数 | 56 | **0** |
| >50ms 帧数 | 0 | 0 |
| 布局次数 / 时长 | 90 / 914ms | 276 / **686ms** |
| 单次布局均耗 | 10.2ms | **2.5ms** |
| 重算样式时长 | 174ms | 120ms |

**(b) live 态静置 4.2s（走钟中）**

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 最坏帧（1s 周期尖峰） | **22ms** | **11ms** |
| p95 帧 | 6ms | 6ms |
| >50ms 帧 / longtask 条数 | 0 / 0 | 0 / 0 |
| 窗口内布局次数 / 时长 | 5 / 2ms | 6 / 3ms |

- 清单口径的 p95 由 33→11ms（与 `docs/18` 记的「p95 帧 39→11ms」同一量级，本轮 39 出现在最坏帧、p95 为 33）。
- 静置尖峰 22→11ms：修好后每秒那次更新只重渲顶栏计时，表体被 `memo` 跳过；`long-animation-frame` 两轮都无条目（该 API 只报 >50ms 帧，与 >50ms 帧数为 0 相互印证）。
- 布局**次数**上升是这味药的预期形状：屏外行各自成小布局任务（次数多、每次便宜），总时长从 914ms 降到 686ms。

---

## 4. 任务四 · 飞屏提速 + 启停脚本

### 4.1 `fly.ts`

| 参数 | 前 | 后 |
|---|---|---|
| `out` | dur 360 / step 41 / durStep 9 | **dur 180 / step 20 / durStep 5** |
| `in` | dur 520 / step 30 / durStep 14 | **dur 260 / step 15 / durStep 7** |
| `handoff` | 40 | **20** |
| 整段（n=6 / n=7） | 1390 / 1484ms | **695 / 742ms** |

- 不动项全部保持：时序不变量（起步与完成仍严格递增）、编排期不可打断、reduced-motion 直落、`rise 72` / `scale 4` / `dead 0.03`、两段 easing。
- 注释里的口径已更新到新数字，并保留定档与 2026-10-05 那两轮的沿革。
- **连带改测**：`packages/web/test/fly.test.ts` 钉的就是这套数字（`legTimes` 的 start/duration 数组与 1390/1484 总时长），不改它会转红；已同步为 695/742 与新数组，用例数不变（334 条）。
- 无头实测（挂钩 `Element.prototype.animate` 记录每次调用的 delay/duration，CF→AT 真点一次）：out 段 6 张 · 起步 0/20/40/60/80/100 · 完成 180…305（**outTotal 305**）；in 段 7 张 · **inTotal 392**；整段 **746ms**（比参数算出的 742 多 4ms，是无头 `setTimeout` 交接抖动，见 §5 偏差 6）。

### 4.2 `start.bat`（改）+ `stop.bat`（新增）

`start.bat`：起跑前用 `netstat -ano | findstr ":7788" | findstr "LISTENING"` 探端口（bat 内管道写成 `^|`），占用则打印占用者 PID 并用 `choice /c 123` 弹三选一；控制台文案全英文。顺手补上 `call npm start || goto fail`（原来这一行没兜错误，失败直接关窗）。
`stop.bat`：找 7788 的 LISTENING PID → `taskkill /F`；没有则明说「not running」；两条路径结束前都 `pause`。

自证（`cmd //c` 驱动、stdin 喂 `choice`，逐分支各走一次）：

| 分支 | 实测输出与结果 |
|---|---|
| `[3] 退出` | 打印 `port 7788 is already in use by PID 34864.` + 菜单，选 3 后直接退出，服务与端口未受影响（仍在 LISTENING 34864） |
| `[2] 打开已有实例` | 同一菜单选 2 → 浏览器开 `http://localhost:7788`，脚本退出，旧服务未被动 |
| `[1] 结束它并启动` | 旧 PID 23028 → `taskkill` 成功 → 新实例起来（PID 41852，`curl` 首页 **200**） |
| 端口空闲正常起跑 | `stop.bat` 关掉后跑 `start.bat` → 打印 `[ANVIL] http://localhost:7788` 并起服务（PID 46232，200） |
| `stop.bat`（在跑） | `stopping PID 34864 (port 7788) ...` → 成功终止，端口释放 |
| `stop.bat`（没在跑） | `nothing is listening on port 7788 - ANVIL is not running.` → `pause` |

---

## 5. 已知问题与偏差

1. **Org / Team 比清单约数高 4–5px**（1280 展开实测 162/182，清单写 ≈158/≈177）。这两列是 `1fr : 1.12fr` 的解析结果，公式值就是 163.2/182.8；清单数字是向下取整的近似，不是实现差。
2. **无头帧数字不等于真机观感**：headless 的 rAF 不受 60Hz 约束（本轮中位帧 6ms ≈ 160fps），所以表里给的是**同机同法的前后对比**，绝对值比真机乐观；相对降幅（最坏帧 −56%、p95 −67%、静置尖峰 −50%）才是结论。真机 GPU 光栅下收放本就比无头软件光栅更轻。
3. **`content-visibility` 让布局次数从 90 涨到 276**：总时长下降（914→686ms）、单次均耗降到 1/4，属该药预期形状；若日后有人按「布局次数」做回归阈值会误报。
4. **`call npm start || goto fail` 的副作用**：用 Ctrl+C 正常停服务时 `npm` 退出码非 0，会走 fail 分支打印 `startup failed` 并 `pause`，看起来像失败。这是清单指定要补的兜法，代价如实记在这里；关窗退出（正常用法）不受影响。
5. **bat 控制台里的中文乱码不是本批引入**：`taskkill` / `pause` 的系统文案在 GBK 代码页下输出乱码（Git Bash 里看更是字节垃圾），我们自己的文案保持纯 ASCII。
6. **飞屏整段实测 746ms vs 参数算出 742ms**：无头 `setTimeout` 交接抖动 ~4ms（in 段起步比标称晚 29ms 同因）。口径以参数计算值 695/742 为准。
7. **`arenaCount` 的 `null → —` 分支未做端到端实测**：要造「目录拉取失败」才走得到（需断上游）。代码路径与个人数据页脚未知计数的既有做法一致（`—`），失败时不动旧值。
8. **1440 收起态 Org/Team 到 315/353**：清单里「≥1600 的 Org·Team 上限」属不做项，未加上限；超宽屏下学校/队名列会更宽。
9. **`docs/18` 未列但必须连带的两处**：`fly.test.ts` 断言数字同步（否则 334 转红）；`switcher.ts` 与 `App.tsx` 注释里「整段 1390/1484ms」的口径同步。
10. 未合并分支、未 push、未改 `docs/` 与 `design/mock-*`、未碰 `vault/`、未新增依赖。自起的服务与无头实例收尾已全部关闭。

---

## 6. 证据图（`design/_shots/ux-*.png`，12 张）

| 文件 | 内容 |
|---|---|
| `ux-board-1280.png` | 榜体 1280 展开 · 终榜态填满内容区（页脚为榜单语境） |
| `ux-board-1440.png` | 榜体 1440 展开 |
| `ux-board-1280-rail.png` | 榜体 1280 收起态（轨道 56px，榜体铺满 · 灰点 + 394） |
| `ux-foot-dashboard.png` / `ux-foot-dashboard-rail.png` | 个人数据页脚两态（未改，作对照） |
| `ux-foot-arena.png` / `ux-foot-arena-rail.png` / `ux-foot-arena-rail-hover.png` | 模拟榜单页脚两态 + 收起态浮标 |
| `ux-foot-settings.png` / `ux-foot-settings-rail.png` | 设置页脚两态（工坊共用） |
| `ux-fly-out.png` | 飞出段中途帧（点击后 ~150ms，6 卡阶梯外散） |
| `ux-fly-in.png` | 飞入段中途帧（~380ms，新屏卡片自底部升起） |

## 7. 提交清单（`feat/ux-polish`）

| 提交 | 内容 |
|---|---|
| `06a6fbd` | 任务一 · 榜体放大并填满内容区 |
| `addd0ab` | 任务三 · 收放与走钟卡顿修复（含前后帧数字） |
| `52c6026` | 任务二 · 侧栏页脚按模块语境化 |
| `a2a10c4` | 任务四 · 飞屏提速 + start/stop.bat |
| 本次 | 证据图 12 张 + 本说明 |
