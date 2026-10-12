# 实现 agent · 开工提示词 · 修复批次（审查结果落地）

> **交付对象：实现 agent**。本文件 = 本批次唯一工作清单。条目依据 = 仓库根目录 **`审查结果-2026-10-12.md`**（未跟踪文件，**只读**；全文不必看，只做本提示词列出的条目）。视觉基线 = `design/mock-04-simboard.html`（本轮按 §2.2 小幅修订到 v6.2）。开工基线 = `main` @ `b47751f`。
> 三部分：**① 数据正确性 → ② 契约落地 + 前端脆性（含一个小新特性：回顾「封榜视角」开关）→ ③ 工程卫生**。逐部分提交。

---

## 0. 开工三件事（先做）

1. `git status` —— 应该只有两条未跟踪：`?? .qoder/` 与 `?? 审查结果-2026-10-12.md`。**两条都是预期的，别动、别提交**（`.qoder/` 会在第三部分进 .gitignore）。
2. `git branch --show-current` 应为 `main`；新建并切到本批分支：**`git switch -c fix/audit-round1`**。
3. `npm install`（如需）；`npm test` 基线 **334 / 334 全绿**；`npm run typecheck` 干净。

---

## 第一部分｜数据正确性（逐项有测试要求）

### 1.1 A1 · 评测中提交的订正谓词太窄（`db.ts` + `sync/at.ts`）

- 现场：`db.ts:214-217` 的 `ON CONFLICT … DO UPDATE … WHERE` 只放行旧值 `NULL / 'TESTING'`；而实际会落库的"非最终判定"还包括：AT 的空串（`at.ts:246` 的 `s.result ?? null` 拦不住 `''`）、CF 的 `IN_QUEUE / FROZEN / WAITING`（`cf.ts:167` 原样透传）。后果：这些行后来订正成 `'OK'` 会被拦掉，**那条 AC 永久从格子图/总过题里缺席**。
- 改法：
  ① `at.ts:246`：`s.result === 'AC' ? 'OK' : (s.result || null)`（空串归 NULL；WJ 等仍原样—不要在 UI 侧发明枚举）；
  ② `db.ts` 谓词的旧值集合扩为：`submissions.verdict IS NULL OR submissions.verdict IN ('TESTING','IN_QUEUE','FROZEN','WAITING','')`（`excluded` 的两条守卫保持不动）；
  ③ `db.ts:200-206` 注释里「AT 的游标含当天」是错的（实际 `at.ts:313` 游标 = `max(created_ts)`）——把这句改对，并把注释与谓词对齐。
- **测试**：同一 `id` 先落 `verdict=''` 再落 `'OK'` → `insertSubmissions` 返回 1、`countDistinctOkProblems` +1；CF 的 `IN_QUEUE → OK` 同理。

### 1.2 目录缓存先解析后落盘（`arena.ts` 的 `catalog()`，约 365-382 行）

- 现场：现在是**先 `writeFileAtomic` 再 `toCatalogDto`（解析）**——一个 200 的垃圾响应会把好缓存覆盖掉，且 `parseCatalogYaml` 吃垃圾**不抛错**（返回 `total:0` 空树），降级分支永远走不到。`contest()` 恰好相反（先 `JSON.parse` 再落盘），两套纪律。
- 改法：`res` 校验后**先解析**：`const parsed = parseCatalogYaml(res.text)`；**空树视为无效**（`parsed.tree.length === 0` → 抛 `new ArenaError('unavailable', '目录内容不合法')`）；**通过校验才** `writeFileAtomic`，返回解析结果。降级路径（有旧缓存回旧缓存）保持不变。
- **测试**：垃圾 200（如 `<html>503</html>`）→ 请求报 `unavailable`/回退旧缓存、**磁盘上旧缓存内容一字未变**；正常 YAML 照常落盘。

### 1.3 `config.json` 原子写 + 坏文件留底（`config.ts`）

- 现场：`config.ts:17-19` 直接 `writeFileSync`（`arena.ts:82-88` 有现成的 tmp+rename 原子写，**同仓两套纪律**）；读不懂时 `:23-29` 整份退回默认、下一次保存（`:44` / `:51` 的 `{...loadConfig(), ...patch}`）把默认值整包写回 → **两个 handle 和认领 key 静默丢失**。
- 改法：① 把原子写抽成共享模块 `packages/server/src/atomic.ts`（`writeFileAtomic`），`arena.ts` 与 `config.ts` 都改用它；② `parseConfig` 失败时（仅"文件存在但读不了"这条路径）先把原文件**另存** `config.json.bad-<时间戳>`，再退默认；保留现有 console 警告。

### 1.4 A5 尾巴 · 配置读坏要告诉界面（`configWarning`）

- `loadConfig()` 读坏时记一条模块级警告（含"原文件已另存 config.json.bad-…"一句人话）；`/api/status` 带上可选字段 **`configWarning?: string`**（`StatusDto` 加可选字段，不破坏兼容）；设置页（`Settings.tsx`）顶部若收到该字段，用现成的 `alert--warn` 样式显示一条即可（不新造组件）。

### 1.5 AT rating 两条写操作并进一个事务（`db.ts` + `sync/at.ts`）

- 现场：`at.ts:343-344` 先 `clearRatingHistory` 再 `upsertRatingHistory`——后者自带事务，但两条**不在同一事务**：中途抛错会把 AT 整条 rating 曲线清空且不恢复。
- 改法：`db.ts` 新增 `replaceRatingHistory(db, source, rows)`（一个 `withTransaction` 内：先 DELETE 本源行、再逐行 INSERT，语义同 AT 现状）；`at.ts` 改用它。**CF 路径（`job.ts:110` 只 upsert、不清空）不动。**
- 现有相关测试保持绿。

---

## 第二部分｜契约落地 + 前端脆性（含一个小新特性）

### 2.1 A4 · 钟走到终点自动落回顾

- 现场：`engine.ts:582-586` 的 `tick` 在到点时已经把会话 `finish`（注释也写着"到 duration 自动落回顾"），但 `ArenaBoard.tsx:128-146` 的走钟 effect 只 `setElapsed/setSession`，**从不切回顾屏**——榜冻在回放屏、滑条不出现，提前离开的话目录那行还会挂着「回放中 · 5:00:00」。
- 改法：走钟 effect 里，"会话刚刚变成 ended"那一拍（`next.session !== session` 且 `next.session.ended`）照**「结束」按钮（`end()`，约 177-183 行）的落点**走：`setReview(true)` + `clearSession(store, row.path)`（`at`/`scrubMs` 已经是 duration，无需再摆）。
- 自证：把某场会话时间平移（改 localStorage 里该场的 `started`，让钟只剩 ~3 秒）→ 回放屏等到点 → **自动落到回顾屏**（截图）；目录那一行回落为普通行。

### 2.2 新特性 · 回顾模式「封榜视角」开关（定格 / 解封两态）

背景：契约里"回顾一律解封"与基线稿的"回顾中途仍定格回看"互相矛盾（详见审查结果 A3）。用户拍板：**两个都要，做成开关**。

- **引擎**（`engine.ts`）：`buildBoard(model, elapsed, onlyFormal, unsealed = false)`，`const cap = unsealed ? elapsed : capAt(elapsed, duration, freezeStart)`。默认参数保证所有旧调用行为不变。
- **界面**（`ArenaBoard.tsx`）：
  - 新状态 `const [frozenView, setFrozenView] = useState(false)`（**默认关 = 解封视界：去回顾先给结果**；开 = 定格回看，即现状行为）。
  - 回顾顶栏（`仅正式队` 左侧）加一枚开关，**复用现有 `.switch` 组件**：文案「**封榜视角**」，开=定格回看。**只在 `review` 态渲染**（live 回放屏不加——实时定格是"跟榜"的本体）。
  - `buildBoard` 调用改为 `review && !frozenView` 时传 `unsealed=true`；把开关状态并进 `minuteKey`（翻开关立即重建榜）。
  - **定格态把封榜带显示出来**（现在回顾里隐藏）：`inFrz` 判据改为——live 照旧；review 且 `frozenView` 且 `viewMs` 在封榜段内 → 显示，带子文案改为「**定格视角 · 名次定格在 4:00**」（live 文案不动）。「结果未知 N 格」读数用现有 `board.frzCells`。
  - 解封态下一切自动跟随（封榜段格子显示结果 + 已有「封榜后」两态样式；排名/罚时/列头五档/榜脚读数都挂在 cap 上）。
- **mock 小修订**（`design/mock-04-simboard.html`，版本注记升 **v6.2**）：s3 顶栏加同款开关并**真可切换**（mock 自己的 `capAt`/`buildBoard` 也吃 `unsealed` 参数）；定格态带子文案同步；s4 组件区加一行两态对照说明。
- **自证**（必须带数字）：app 端在 `t3≈4:30`（封榜段内）两态各截一张图，并给 DOM 计数——定格态 `frzCells>0 / postCells=0`、解封态 `frzCells=0 / postCells>0`（数字对调过来才算数）；mock 端同位置两态截图。
- **测试**：engine 补纯函数用例——`buildBoard(..., unsealed=true)` 在 `elapsed∈(freezeStart,duration)` 时 `cap===elapsed`、封榜段内的 AC 格 `st` 为 `ac/fb` 且 `post===true`；`unsealed=false` 时维持现状断言。

### 2.3 A6 · 同步失败的提示被自己的 refresh 抹掉（`App.tsx`）

- 现场：`runSync` 在 `:166/:171` `setNotice(kind:'err')`，紧接着 `finally` 里 `await refresh()`（`:172-174`）——refresh 成功分支有 `setNotice(null)`（`:93`）→ 提示刚立就被擦。`runXcpcRefresh`（`:109-124`）的写法是对的（提示放在 refresh **之后**落）。
- 改法：把 `runSync` 的失败提示改成 `runXcpcRefresh` 同款——先算好 `next: Notice | null`，`finally` 里 `await refresh()` 之后再 `setNotice(next)`。

### 2.4 A7 · `refresh()` 全有或全无（`App.tsx`）

- 现场：`:85-97` 把 `getStatus + Promise.all([cf, at, xcpc])` 绑成一次成败，任一失败一行 setState 都不执行；首次加载失败时 `status===null`，各屏全跳过、永久停在「正在读 vault/anvil.db…」占位，无自动重试。
- 改法：① 改 `Promise.allSettled`，**逐项赋 fulfilled 的值**（CF 挂了不该把 XCPC 档案一起拖掉）；② 失败的源汇总成一条 notice（"部分数据读取失败 · 已在读到的照样显示"之类，不覆盖已有数据）；③ 占位屏（`status===null` 时的各处）加一个「**重试**」按钮调 `refresh`。
- 自证：停掉服务 → 打开页面 → 占位屏出现且带「重试」→ 起服务 → 点重试 → 恢复正常（截图/描述）。

### 2.5 A8 · 全局 ErrorBoundary + `localStorage` 懒取

- `main.tsx` 现在只有 `createRoot(...).render(<App/>)`——任何渲染期抛错整棵树变白屏。
- 改法：① 新增 `packages/web/src/ErrorBoundary.tsx`（class 组件），`main.tsx` 包住 `<App/>`；兜底 UI 给一句人话 + 「重新加载」按钮（`location.reload()`）+ 一句「数据在 vault 里，不受影响」；② `Arena.tsx:12` 模块顶层 `window.localStorage` 挪进函数内懒取 + try（照 `AppShell.tsx:47` 的写法）。

### 2.6 弹层高度封顶（`pops.tsx` / `styles.css`）

- 提交明细弹层高度不封顶、定位按写死的 260px 估算——发数多的格子会被视口裁掉。
- 最小改法：给弹层容器加 `max-height:60vh; overflow:auto` 之类（`.pop` 一带的样式，按稿内既有语言）；**定位翻转逻辑本轮不做**。

### 2.7 服务端健壮性三小件（各一行级）

- `sync/runner.ts:35-50`：起跑的同步 Promise 加 `.catch`（现在 try 之外抛错 = unhandledRejection，Node 24 直接退进程）→ 收敛成一条 error 状态。
- `xcpc.ts:347` `const detail = shard[key]`：`key='__proto__'` 会命中原型链 → 用 `Object.prototype.hasOwnProperty.call(shard, key)` 判（或 `Object.create(null)`），查无此档照旧返回 null。
- `arena.ts:82-88` `writeFileAtomic` 失败路径：尽力 `unlink` 掉 `.tmp` 再抛。

---

## 第三部分｜工程卫生（一批清）

### 3.1 `start.bat` / `stop.bat`

- **无条件构建**：`start.bat` 现在只在 `dist` 缺失时构建 → 改完前端再双击会拿到旧 bundle。改为**每次启动都 `call npm run build`**（Vite 增量 10s 级；构建失败走 fail 分支 pause）。
- **端口读法统一**：`start.bat` / `stop.bat` 的 `set "PORT=7788"` 改为 `if not defined PORT set "PORT=7788"`（继承 `ANVIL_PORT` 可覆写）；`packages/web/vite.config.ts` 的 proxy 与 `scripts/dev.mjs` 的打印同样读 `process.env.ANVIL_PORT ?? '7788'`——**四处同源**。
- **端口匹配收紧**：`findstr ":%PORT%"` 会误命中 77880–77889 → 改精确匹配（如 `findstr /c:":%PORT% "`）。
- 自证：三分支（空闲起 / 占用三选一 / stop）各走一遍；`git ls-files --eol start.bat stop.bat` 输出贴进报告。

### 3.2 `scripts/dev.mjs` 子进程登记

- spawn 的 API 子进程没进 `children` → 退出清理漏它（`Ctrl+C` 靠进程组侥幸）。把 server 也登记进 `children`（或 shutdown 里显式 kill）。

### 3.3 `.gitattributes`（新增）

- 内容：`*.bat text eol=crlf`（可再加 `* text=auto` 一行）；加完 `git add --renormalize .` 再提交（若无实际变化属正常）。
- 目的：换一台机器 checkout 也别把 `.bat` 变成纯 LF。

### 3.4 `.gitignore` 补两行

- `.qoder/` 与 `*.log`（按现有文件结构加，附一行注释）。

### 3.5 `README.md`（新增，中文）

- 内容要点：一句话介绍（个人 ICPC 训练工作台 · 本地 Web 应用）+ 四模块列表（个人数据 / 工坊(未解锁) / 模拟榜单 / 设置）+ 快速开始（Node ≥ 24；`npm install`；双击 `start.bat`／`stop.bat`；端口 7788；首次运行读 `vault.example/` 初始化 `vault/`，`vault/` 不入库）+ **数据来源与许可**（CF 官方 API、AtCoder 官方/社区数据、XCPC heimaom 社区快照、榜单快照 algoux/srk-collection（AGPL-3.0，仅运行时拉取、不打包数据，界面已署名））+ `docs/` 文档索引 + 免责（个人本地工具，数据只在本机）。
- 语气从简，不写开发细节。

### 3.6 `vitest` 把「禁真实网络」变成硬约束

- 新增根目录 `vitest.setup.ts`：`vi.stubGlobal('fetch', () => { throw new Error('单测禁止真实网络（技术锁）：请注入 fetchImpl'); })`；`vitest.config.ts` 加 `setupFiles: ['./vitest.setup.ts']`。
- 现有的 client 测试都靠注入 `fetchImpl`，不应受影响；**若有测试因此转红，说明它真的在打网络——连它一起修**。

### 3.7 视觉散件四小件（对齐 mock）

- `.tip__v.is-ok`：产品 CSS 缺（`ArenaBoard.tsx` 照常发这个类）→ 补 `color:var(--ok)`（抄 mock-04 同款）。
- `.skel--row`：`ArenaCatalog.tsx` 在用、CSS 没有 → 照 mock-04 抄。
- `.dot--big`：收起态页脚点应对齐稿内 9px → 补类并给 `AppShell` 收起态页脚的点加上。
- 回顾滑条时刻色：`ArenaBoard.tsx:370` 的 `? undefined : …` 空三元 → 过封榜点用 mock 同款灰 `#B4C0CF`。

### 3.8 验收截图清理（`design/_shots/`，删到只剩这些）

- **保留**：`ux-*.png`（12 张）、`_shot-v6-*.png`（8 张）、以及 slice4 组里这些**被 `实现说明-切片4.md` 明确引用的**：`slice4-r2-catalog-tree / slice4-r2-1280 / slice4-r2-error / slice4-r2-error-404 / slice4-r2-heads-frozen(-tip) / slice4-r2-heads-final(-tip) / slice4-r2-approx(-tip) / slice4-r3-heads-frozen(-tip) / slice4-r3-heads-final(-tip) / slice4-r3-tree-open(-reload/-back)`。
- **其余 `slice4-*.png` 全删**（首轮板面、rail/keyboard/reduced 等——都是 v6 前的旧 UI；git 历史可找回）。

---

## 不做清单（照抄自查）

- **不加任何依赖**（审计提到的 jsdom 明确不做——依赖锁要用户点头）；不改 `docs/`、不改 `AGENTS.md`、不改 `.qoder/`、不改 `审查结果-2026-10-12.md`、不碰 `vault/`。
- 不做本提示词之外的"顺手"：审查结果里的 §5 长尾 P3、文案收敛那几条（怕误伤已批准文案）、DOT 类名表重构、A2、A3 的原始建议、虚拟化、`--rail-dur` 调整。
- **不合并、不 push、不删分支**；只提交到 `fix/audit-round1`。
- 测完关掉自己起的服务（`stop.bat` 或关掉窗口）。

## 交付报告（`实现说明-修复批次.md`，仓库根，随分支提交）

1. 三部分**逐条对照表**（做没做、改在哪、实测数字/证据）。
2. 自证截图命名 `fix-*.png` 放 `design/_shots/`：回顾两态对比（app + mock）、到点自动落回顾、占位屏重试、start.bat 三分支、（其余以数字/输出文本为准）。
3. `npm test` 新总数（只增不减）+ `typecheck` + `build` 全绿；分组提交清单。
4. 已知问题与偏差——如实列。
