# 实现 agent · 开工提示词 · 榜单增强批次（目录「预拉取」+ 回放榜「我的成绩」幽灵行）

> **交付对象：实现 agent**。本文件 = 本批次唯一工作清单；**实现契约 = `docs/20-榜单增强规格.md`（开工前整篇读完，遇到与本文冲突处，以 docs/20 为准并报告）**；**视觉基线 = `design/mock-04-simboard.html` v7（只读，不许改）**，五张对照图 `design/_shots/_shot-v7-{catalog,board,panel,review,sheet}.png`。开工基线 = `main` @ `904dc37`（`npm test` **345/345 全绿**）。
> 两块互相独立：**① 预拉取（服务器 + 目录行）→ ② 幽灵行（存储 + 引擎 + 界面）**。逐块提交。
>
> **注（2026-10-14 收口）**：本文件的**幽灵部分（第二部分）已被 v8 改向取代**——用户验收 v7 后拍板改「逐发录入」（题 · 判名 · 时:分）+ 顶栏排名读数；现行口径见已回写的 `docs/20` 与 `实现说明-榜单增强.md` §7。第一部分（预拉取）照本文件原样交付有效。

---

## 0. 开工三件事（先做）

1. `git status` —— 工作树应干净（有个别意料外文件先报告再动）。
2. `git branch --show-current` 应为 `main`；新建并切到本批分支：**`git switch -c feat/arena-plus`**。
3. `npm test` 基线 **345/345 全绿**；`npm run typecheck` 干净。

---

## 第一部分｜目录「预拉取」

**语义**（docs/20 §1）：把某一场的 srk.json（~1.5MB）经服务端拉到 `vault/arena/` 缓存、**不进回放**；已缓存 → 断网可回放。已缓存的行显示「本地」小标替代按钮。

### 1.1 服务端：目录叶子带 `cached`（`packages/server/src/arena.ts`）

- `catalog()` 的新鲜路径（约 `:358-377`，构造 `{fetchedAt,total,tree}` 处）与 `toCatalogDto()`（约 `:379-382`，命中缓存文件的回吐路径）**两条都**给树做 `cached` 标注——只给其中一条会在"读缓存目录"时全部漏标。
- 标注实现：`private annotateCached(nodes)` 递归——叶子（`path !== undefined`）→ `{ ...n, cached: existsSync(join(this.dir, n.path)) }`；分组 → 递归 `children ?? []`。`this.dir` 就是缓存根，镜像路径可直接 join。394 个叶子 × existsSync，零压力。
- 共享类型（`packages/shared/src/types.ts` `ArenaCatalogNode`，约 `:261`）加可选字段：`/** 叶子：该场快照已在本地缓存 */ cached?: boolean;`

### 1.2 客户端：目录行第三枚动作

- `packages/web/src/components/arena/catalog.ts`：`LeafRow` 加 `cached?: boolean`；`leafRowOf()`（约 `:70`）带上 `cached: node.cached === true`。
- `packages/web/src/components/arena/ArenaCatalog.tsx`：
  - 容器新增三个短状态：`cachedNow: Set<string>`（本次会话内刚拉完的）、`busyPath: string | null`、`prefetchErr: { path: string; text: string } | null`。
  - `prefetch(row)`：`getArenaContest(row.path)`（`web/src/api.ts:89`，与进回放同一条接口、同一套失败口径）；成功 → 路径进 `cachedNow`；失败 → `prefetchErr = {path, text: messageOf(err)}`；`busyPath` 防重复点。
  - `Row`（约 `:338`）props 加 `cached` / `busy` / `err` / `onPrefetch`（callback 要 `useCallback` 稳定，`Row` 是 `memo`）；三处 `<Row>`（搜索命中 `:269`、分组 `:327`）都要传。
  - 渲染（`crow__acts` 内、**非 live 行**才显示，live 行动作照旧只有「回到回放」）：
    - 未缓存：`btn btn--xs btn--ghost` + `i-sync` 图标「预拉取」；busy 时 `disabled` + 文案换「拉取中…」（保持图标）。
    - 已缓存（`row.cached || cachedNow.has(row.path)`）：`<span className="crow__cache"><i className="dot dot--ok" />本地</span>` 替代按钮。
    - 失败提示：该行 actions 后一行小字（新类 `crow__err`，暗红），下次点预拉取或换行即清——不弹大 alert、不动全屏 error 态。
- 样式（`packages/web/src/styles.css`，放 `.crow__acts` 附近约 `:949`）：
  - `.crow__cache{display:inline-flex;align-items:center;gap:6px;font-family:var(--font-num);font-size:10.5px;color:var(--text-mute);border:1px solid var(--line);border-radius:999px;padding:2px 9px}` + `.crow__cache .dot{width:5px;height:5px}`（照 mock v7 `:536-537` 抄）。
  - `.crow__err`：`font-size:10.5px;color:var(--bad)` 级。

---

## 第二部分｜「我的成绩」幽灵行

**口径以 docs/20 §2 为准**。幽灵是**占名额**的合成行：走正式队通道占 `place`、吃奖牌带；`S#` 不给号；不进榜脚「榜上 N 队 / 累计过题」、不进列头读数；封榜带「结果未知」读数**要含**它；永不是 FB。要点与落点：

### 2.1 存储（`packages/web/src/components/arena/session.ts`，同 try/catch 纪律）

- 键：`arena:ghost:<官方路径>`；形状 `{ show: boolean, marks: [{ p: 题序, ac?: 分钟, fails?: 数 }] }`（`ac` 缺省 = 未过；单位 = 比赛分钟）。
- 类型：`interface GhostData { show: boolean; marks: GhostMark[] }`（`GhostMark` 从 engine 导出，见 2.2）。读写三件套 `loadGhost / saveGhost / clearGhost`，照该文件现有函数写法（`Store` 接口已有）。
- 读时 sanitize：非数组/坏 JSON → `null`（当没有）；marks 里非法项（p 非整数、ac 非正有限数、fails 非 ≥1 整数）逐条丢弃；缺 `show` 默认 `true`。写前按 `p` 升序排（minuteKey 要序列化它）。
- 文件头注释一句话带上这个键族。

### 2.2 引擎（`packages/web/src/components/arena/engine.ts`）

- 类型：
  ```ts
  export interface GhostMark { p: number; ac?: number; fails?: number }
  ```
  `BoardRow` 加 `ghost?: boolean`；`Board` 加 `ghostTeam?: TeamModel | null`。
- 新导出 `export function ghostCell(mark: GhostMark | undefined, elapsed: number, cap: number, freezeStart: number): Cell`——**不要伪造 `SrkSolution` 去骗 `cellAt`**（WA 没有时刻）。规则：
  - 无 `ac`：`fails>0` → `{st:'pen', t:0, n:fails, fails, nCap:fails, post:false}`（`t:0` = 无时刻，显示层只出 `−n`）；否则 `EMPTY_CELL`。
  - 有 `ac`（`t = ac × 60000`）：`t ≤ cap` → `{st:'ac', t, n:fails+1, fails, nCap:fails+1, post: t > freezeStart}`；`cap < t ≤ elapsed`（封榜段）→ `{st:'frz', t, n:fails+1, fails:0, nCap:fails+1, post:false}`；`t > elapsed`（还没到这一刻）→ 按"未过"处理（同上 `−fails` / 空）。
  - **AC 前失败计入罚时（×20）；未过题的失败不计罚时**——这是 ICPC 与全榜口径。
- `buildBoard(model, elapsed, onlyFormal, unsealed = false, ghost?: GhostMark[] | null)`：传来就注入（UI 负责 gate）。
  - 幽灵 acc：`{ ti:-1, solved, pen, last, star:false, org:'我的成绩', cells, ghost:true }` 进排序（并列时 `ti:-1` 自然排最前，照 mock）；`place`/奖牌带照正式队走（占名额）；`srank` 保持空串；`col` 循环整体跳过它；`frzCells` / `frozenRows` **照常计入**；`solvedTotal` 不计。
  - 返回 `ghostTeam: TeamModel`＝合成队伍：`{ ti:-1, name:'你', org:'我的成绩', members:[], seat:'—', star:false, subs:[], summaries:[], verdicts:[] }`。
  - 现有调用方只有 `ArenaBoard.tsx` 与测试，改签名无兼容包袱。

### 2.3 界面（`ArenaBoard.tsx` + 新 `GhostPanel.tsx`）

- **状态**：`const [ghost, setGhost] = useState<GhostData | null>(() => loadGhost(store, row.path))`；`ghostActive = ghost && ghost.show && ghost.marks.some(m => m.ac != null || (m.fails ?? 0) > 0)`。
  - `buildBoard(..., ghostActive ? ghost.marks : null)`；**minuteKey 追加幽灵签名**（show + marks 序列化）——不拼进去改数字不重建榜。
  - 每次输入：`setGhost` + `saveGhost`（清除 = `clearGhost` + 置 `{show:true, marks:[]}`、面板保持打开输入清空）。
- **入口（常驻）**：顶栏 `topbar__spacer`（`:346`）之后、`封榜视角` 开关之前，加图标按钮（live 与回顾同一份顶栏，自然两态都有）：
  `<button className="btn btn--ghost btn--sm" aria-label="我的成绩" title="我的成绩 · 录入 VP 成绩，看自己在榜上的位置"><Icon id="i-user" /></button>`
  - `i-user` symbol 补进 `packages/web/index.html` 的 sprite（照 mock v7 `:941` 原样抄）。
  - 点开走现有弹层框架：`Pop` 联合加 `{ kind:'ghost'; anchor }`；`Popover`（`pops.tsx:17`）加两个可选参 `width = 270, height = 260`（幽灵面板 `width={330} height={470}`，定位翻转按传入值算；默认值保证现有两弹层零变化）。
- **面板**（新文件 `GhostPanel.tsx`，内容照 mock v7 `ghostPanelHTML` 的语气）：
  - `PopShell` 头：「我的成绩」/「你 VP 时的成绩 · 罚时 = 过题分钟 + 20 × AC 前失败（与榜单同口径）」。
  - 按本场题目数生成行（一般 13 行 A–M；用 `model.problems[].alias`，别写死）：行 = 题号 + 两个数字输入（`.ghin`，`inputMode="numeric"`，留空 = 未过，placeholder「过题′」/「失败」），列头一行「过题′ 失败」小标签。
  - 底部：`展示我` 开关（`.switch`，默认开）＋ `清除本场成绩`（**两击确认**：第一击文案变「再点一次确认清除」，第二击真清；失焦/超时可复位）。
  - 小注一行：「留空 = 未过；段内成绩按时间轴与封榜视角自动同口径。」
  - 样式照 mock `:538-547` 的 `.ghgrid/.ghrow/.ghin/.ghlab/.ghfoot/.ghnote`（`.ghgrid` 要 `max-height:330px;overflow:auto`）。
- **榜体**：
  - 行：`board.rows.map` 里 `team = r.ghost ? board.ghostTeam! : model.teams[r.ti]!`；`BoardRowView` 行类加 ` is-ghost`；TEAM 列 `<span className={'c-team__n' + (row.ghost ? ' is-you' : '')}>`；其余（名次/S#空/奖牌底/星标无）自动成立。
  - 格子：`CellView` 的 `pen && t===0` 不渲染 `pcell__t`（只出 `−n`）；hover readout 与之对齐（pen 且 `t===0` 不显示「末次 0′」）。`frz` 格照现有 `t + ?n` 显示（t = 录入的过题分钟，属提交时刻、不泄判名）。
  - 榜脚（`:525-528`）：`榜上 {board.rows.length - (board.ghostTeam ? 1 : 0)} 队`；`ProblemHead` 的 `rows` 入参（`:508`）同口径扣掉幽灵；`solvedTotal` 已在引擎侧排除。
  - hover 行 tip（`teamTip`）：数字照常；sub 里不出现空机位（幽灵行显示「VP 手动录入 · 点击看明细」之类）。
  - **弹层照常可用**：`SubPop` / `TeamPop` 在 `ti === -1` 时走幽灵分支（数据从传入的 `ghost: GhostData` 拿，**不要**去查 `model.teams[-1]`）：
    - 格子弹层：一行结果（`AC {clockHMS(ac×60000)}` / `未过 −{fails}` / 「未录入此题」），加一行注「手动录入 · 无逐发时刻」。
    - 队伍弹层：头「你 / 我的成绩」，成员区一行「VP 成绩手动录入，点格子看每题明细」，Seat 显示 `—`，状态照 row.medal（奖牌名）否则「正式队」。
  - 样式（`styles.css`，`.brow` 块约 `:989` 起）：`.brow.is-ghost{background-color:rgba(245,165,36,.055)}`、`.brow.is-ghost .c-r::before{…accent 竖条，照 mock :636}`、`.c-team__n.is-you{color:var(--accent);font-weight:600}`（mock `:637`）。**注意摆放顺序**：`.brow.is-ghost .c-r::before` 要放在 `.brow.m-gold/.m-silver/.m-bronze .c-r::before`（`:1012-1017`）**之后**，否则同权重被奖牌色压住（is-ghost 底是 background-color、奖牌是 background-image，两层自然叠加，不用动奖牌规则）。

---

## 第三部分｜测试（单测禁真实网络，夹具自造）

- `arena-engine.test.ts`：
  - `ghostCell` 全态：无录入 / 仅 fails（`pen t=0`）/ `ac ≤ cap`（`n=fails+1`、罚时口径）/ 封榜段（`frz ?fails+1`）/ 未到时刻（`−fails`）/ `unsealed` 下 `post`。
  - `buildBoard` 注入：幽灵占 `place` 与奖牌、其下队伍名次下推；`srank===''`；`solvedTotal` 不含；`col[].ac/sub` 不含；`frzCells/frozenRows` 含；并列时 `ti:-1` 在前；`ghostTeam.name==='你'`；`onlyFormal` 开着也显示。
- `arena-catalog.test.ts`：`leafRowOf` 带 `cached`；ghost 存储三件套（roundtrip、坏 JSON → null、非法 marks 丢弃、稀疏写入）；预拉取不是纯函数、不入单测（server 侧见下）。
- `packages/server/test/arena.test.ts`：`catalog()` 两条路径（新鲜 / 读缓存文件）都要断言叶子 `cached` 正确（临时目录里放/不放一个镜像文件，各断言一次）。
- 现有 345 条保持全绿。

---

## 第四部分｜自证（真机 + 截图 + 数字）

起服务 `npm start`（先 `npm run build`），出图照旧 headless + 独立 profile；全部截图命名 `plus-*.png` 放 `design/_shots/`，逐屏对照 `_shot-v7-*.png`。

1. **预拉取三态**：目录搜一场未缓存的 → 行内「预拉取」→ 点击「拉取中…」→ 变「本地」；刷新页面该行仍「本地」（服务端 `cached` 生效）；截图 1–2 张。
2. **幽灵手算**（docs/20 §2.4）：上海站拖到 4:32，输入 mock v7 `GHOSTVAL` 的 13 行值（A–M：113 / 45+2f / 231 / 210 / 65 / 40 / 187+1f / 96 / 88 / 55 / K:2f / 250 / 30）——live 定格读数应 **11 过 / 罚时 1220**（L 题 250′ 在封榜段），落位在 11 题区间、罚时 1220 的位置（docs/20 记的两个邻居是「上海大学 1816」与「武汉大学 1242」，若实测邻居与记载不符，以实数为准并在报告里写清）；DOM 计数 + 截图。
3. **回顾两态**：同一场回顾，封榜视角**开** → L 格 `?1`；**关** → L 格 `250′ + 封榜后`，且总读数 12 过 / 1470；DOM 计数（两态 `frz` 格数对调）+ 截图（对照 `_shot-v7-review.png`）。
4. **占名额与三排除**：幽灵行名次/奖牌带正确、其下队伍下推一位；`S#` 列幽灵为空；榜脚「N 队」不含幽灵；开/关「展示我」时列头 `col.ac` 读数不变（幽灵不进列头）；数字对照 + 截图（对照 `_shot-v7-board.png`）。
5. **清除与二次录入**：清除（两击）→ 行消失、localStorage 键消失、入口仍在；再录两题 → 行回来。
6. 预拉取真机会按应用正常行为往 `vault/arena/` 落缓存（**预期**，不是违约）——报告里列出新增了哪些文件；**除应用自身缓存外 vault 一字不动**。
7. 面板截图对照 `_shot-v7-panel.png`（13 行输入 + 展示我 + 清除 + 小注）。

---

## 不做清单（照抄自查）

- **保存 VP 多场存档 / 历史曲线 / 每发 WA 时刻明细 / 批量预拉取 / 幽灵"打星式"开关**——全部不做（docs/20 §3）。
- 不加依赖；不改 `docs/`、`design/`（除新增 `plus-*.png`）、`AGENTS.md`、`vault/` 既有内容；不改 `design/mock-04-simboard.html`（只读基线）。
- 不做本提示词之外的"顺手"：榜单其它口径（罚时/五档/封榜/奖牌）一律不动；`load-errors` 等既有行为不动。
- **不合并、不 push、不删分支**；只提交到 `feat/arena-plus`（建议按 ①预拉取 ②幽灵引擎+存储 ③幽灵界面 ④测试 ⑤报告+截图 分段提交）。
- 临时脚本 / 浏览器 profile 放系统 temp；测完关服务（`stop.bat` 或关窗口）。

## 交付报告（`实现说明-榜单增强.md`，仓库根，随分支提交）

1. 对照表：docs/20 §1/§2 逐条（做没做、改在哪、数字/证据）。
2. 截图清单（`plus-*.png` 与五张 `_shot-v7-*.png` 的对照关系）。
3. `npm test` 新总数（只增不减）+ `typecheck` + `build` 全绿；提交清单。
4. 已知问题与偏差——如实列（含 §4.2 邻居若不一致的说明、vault 新增缓存清单）。
