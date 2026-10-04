# 切片 2 前期调研 · AtCoder 复刻差异汇报

> 2026-10-04 实测报告 · 面向架构决策，**不是实现契约**（定案后另出 `09-AT规格.md`）。
>
> ⚠️ **架构侧复验注记（2026-10-04）**：本文 **§0 与 §1.3 的核心结论「kenkoooo 全系下线」经本机复验不成立**——错误链：探了旧子域 `atcoder-api.kenkoooo.com`（NXDOMAIN 属实，但非现役端点）、请求路径缺 `/atcoder/` 段（`kenkoooo.com/atcoder-api/…` → 404）、仓库名查错（真名 `kenkoooo/AtCoderProblems`，2026-09-28 仍有更新）、把 2.5KB 的 SPA 壳误读为"后端已没"。复验证据：核心端点 `kenkoooo.com/atcoder/atcoder-api/v3/user/submissions` 200（chokudai 最近 2026-09-13）、`resources/problem-models.json` 24h 内体积增长、`contests.json` 200。**§0/§1.3 的"复刻不了"结论作废；本文其余发现与 §2/§4/§5/§6 的分析继续有效并被采纳**（robots 灰色、history/json 语义陷阱、无 VP、段位色名、`IsRated` 混入、2016 起、时区口径、基建清单）。定案进展见 `docs/02-设计讨论记录.md` 第 13 轮。
> 本轮只调研，未改代码、未改 `03/04`；`03` 需更正的条目见 §1.4。
> 全部结论来自当天真实请求（本机出口 + AliDNS 权威应答 + GitHub API），不是文档推断。

---

## 0. 一句话结论

**AtCoder 能复刻的是「rating 卡」，复刻不了「活跃格子图 + 过题统计」。**
官方只有一个匿名 JSON（参赛/rating 史），提交明细已被登录墙封住，而唯一的社区提交源（kenkoooo AtCoder Problems）**已整体下线**。切片 1 的聚合层一行不用改，但它缺输入数据。

---

## 1. 数据源现状（证据）

### 1.1 官方唯一可用 JSON：参赛史

`GET https://atcoder.jp/users/{h}/history/json` → **200 application/json**，单请求返回**全量**、按 `EndTime` 升序、**无分页**（`?page / pageSize / pagetableName / from / to / talent / rated / languages / status` 全部被忽略，返回字节数一致）。

样本（chokudai 首条）：

```json
{"IsRated":true,"Place":59,"OldRating":0,"NewRating":1255,"Performance":2455,
 "InnerPerformance":2455,"ContestScreenName":"arc061.contest.atcoder.jp",
 "ContestName":"AtCoder Regular Contest 061","ContestNameEn":"","EndTime":"2016-09-11T22:40:00+09:00"}
```

只有这 10 个键：**没有提交 id、没有题号、没有 verdict、没有语言**。深度无上限观测：chokudai 42 条（2016-09→2026-03）、kenkoooo 258 条、yosupo 314 条、hitonanode 484 条（139 KB）。

**陷阱（实测撞到的）**：不存在 / 已改名的 handle 也回 **200 + `[]`**（`nonexistenthandle_zzz9x8`、`E869103` 都是空数组，而 `/users/E869103` 页面是 404）→ handle 存在性**不能**用这个端点判。

### 1.2 官方提交史 = 登录墙

| 请求 | 结果 |
|---|---|
| `/contests/abc300/submissions?user=chokudai` | **302 → /login** |
| `/contests/abc300/submissions/all?…` | 404 |
| `/users/chokudai/submissions` | 404 |
| `/contests/abc300/standings`、`/standings/json`、`/standings/csv` | **302 → /login** |
| `/api/*`（version / contests/list / tasks/list / user/history / rating） | 全 404 —— **AtCoder 无公开 API** |

### 1.3 社区源已消失（这是决定性的一条）

| 主机 | 实测（2026-10-04） |
|---|---|
| `atcoder-api.kenkoooo.com` | **NXDOMAIN**（AliDNS 权威 `Status:3`） |
| `atcoder-prod-api.kenkoooo.com` | **NXDOMAIN** |
| `atcoderproblems.me` / `.us` / `.com`、`progcap.io`、`atcoder-stats.com`、`ac-api.io` | **NXDOMAIN** |
| `api.github.com/repos/kenkoooo/atcoder-problems` | **404**（主仓库已删）；kenkoooo 名下只剩 `atcoder-problems-bandit` 等子项目 |
| 社区 fork（`key-moon/atcoder-problems-api`、`kmyk/AtCoderProblemsStatic`） | 最后提交 2019–2022，无人托管 |
| `kenkoooo.com` 本体 | 仍解析（CloudFront 13.32.x），`/atcoder/` 只剩 2.5 KB 的 SPA 壳，后端已没 |

连带失效的还有 **`problem-models.json`（唯一的题目数值难度源）** 和全部 streak / rating-summary 端点。

### 1.4 `docs/03` 需要更正

- §1 AT 行「官方 `users/{u}/history/json` 拉**提交明细**」→ 错。它是**参赛史**，不是提交史；「`atcoder-api/v3/user/submissions`」→ **已下线**。
- §2 需求矩阵 AT 列：提交明细 ✅ → **❌**；题目难度 ✅ → **❌（无源）**；题目标签 ⚠️ → **❌（官方从无机器可读 tag）**。
- §3「标签自动覆盖率比预想高」这句里 AT 的部分不成立。

### 1.5 官方难度 / 标签：从来就没有

- `/contests/abc300/tasks/abc300_c`（200，23 KB）里 `★` / `Difficulty` / `難易度` 命中 **0 次**；contest 页任务表只有「問題 / 点数」。
- 有的是 **Rated Range**（`/contests/abc300` 显示 `Rated Range: 0 - 1999`）→ 只能判"这场算不算分"，给不了题目难度。
- 题集（curated）倒是原生可读 HTML：`/contests/typical90/tasks`、`/contests/dp/tasks`、`/contests/abl/tasks` 全 200 —— 这是"竞赛经典题归属"，不是知识点标签。
- 社区 tag 只有个人 repo（`vlalit834/atcoder_ai_tagged_problem` 2026-08、`null-null-programming/AtCoderTags` 2025-06 等）：非规范、无 SLA、要逐个爬 raw 文件。
- 比赛/题目**目录只能爬 HTML**：`/contests/archive?lang=en&page=N`（200，~73 条/页）；`/contests/archive/json?pagetableName=contest-list` → 404。

### 1.6 运行环境约束

- **无 CORS**：`history/json` 带 `Origin` 请求，响应不含 `Access-Control-Allow-Origin` → 前端不能直连，**必须 server 端抓**（本项目架构天然满足）。
- **并发即限流**：串行 12 次 @100ms 全 200（0.61–1.05 s/次，一次 TTFB 抖到 3.06 s）；**15 并发 → 7 个 429**。UA 无关（curl / 空 UA / Googlebot 都 200），`?lang=en` 可切英文，无 JS 挑战、无 WAF。
- **robots.txt**（Last-Modified 2026-09-18）`Disallow: /users/*/history/` —— 通配前缀**覆盖 `/history/json`**；另 `Disallow: /contests/*/submissions/`、`/contests/*/standings/`。
- **ToS**（`/tos?lang=en|ja` 实测 200）禁止条款里**没有**爬虫/自动化/API 条款，只有"对第三方造成显著损害""损害服务"两条兜底。
- → 定性：`history/json` 属"技术上通、站点政策上禁爬"，个人低频（赛后点一次、1 请求）由用户认这个口径。

---

## 2. CF → AT 逐项差异

| 维度 | CF 切片 1 现状 | AT 现实 | 影响 |
|---|---|---|---|
| 接口形态 | 官方 REST，信封 `{status,comment,result}`，非 OK 带可读原因 | 裸 JSON 数组，**无信封、无错误语义**（不存在也 200+`[]`） | `cfEnvelopeSchema` / `CfError` 三分法不能复用，需 AT 侧自己的"响应不认识"判定 + 存在性走页面状态码 |
| 分页与增量 | `user.status` count≤10000 分页；增量靠"新→旧，遇已存 id 停" | 单请求全量，无分页 | `job.ts` 的 for 循环 / `pages` / `fetched` 语义对 AT 无意义 → 同步状态机要按 source 分派 |
| handle 校验 | `user.status?handle=X&count=1`，404 comment 可辨 | 页面 `/users/{h}` 的 200/404 | 新增一次页面请求；`cfHandleSchema` 的 `^[A-Za-z0-9_]+$` 会误杀含 `-` `.` 的 AT handle |
| 主键 | `submissions.id`（CF 数字 id）、`rating_history.contest_id INTEGER PK` | AT 无数字 contest id，只有 `arc061.contest.atcoder.jp`（带 `.contest.atcoder.jp` 尾巴） | **schema v2 必改**：`rating_history` PK → `(source, contest_key)`，`screenName` 清洗成 `arc061` |
| 时间 | `creationTimeSeconds` / `ratingUpdateTimeSeconds` = epoch 秒 | `EndTime` = `"…+09:00"` ISO 串（epoch 要 `Date.parse`） | 入库统一转 epoch 秒即与 CF 同构；分桶口径见 §5 |
| 段位语义 | 官方英文段位名（Newbie…Legendary GM），名字色即段位色 | **官方只有颜色，没有段位名**（实测 class：2006→`user-yellow`、2708→`user-orange`、2958/2987/3628→`user-red`） | `rankLabelFor / rankColorFor` 要按 source 分派；AT 的 rankLabel 只能是色名（Gray/Brown/Green/Cyan/Blue/Yellow/Orange/Red） |
| 比赛名缩略 | `shortContestName()` 靠字符串规则硬猜（"Codeforces Round "→"CF "） | `ContestScreenName` 直接给 `abc300`/`arc061` | AT 更干净，`shortContestName` 不复用 |
| 是否 rated | `user.rating` 天然只含 rated 场 | history **混着 `IsRated:false`**（kenkoooo 258 条中 65 条是官方非 rated 赛） | 曲线口径要定（建议：主曲线只收 rated，非 rated 单独计"参赛 N 场"） |
| 提交属性 | `verdict` / `programmingLanguage` / `problem.rating` / `problem.tags` | **全部拿不到** | 过题类统计、难度带、标签热力图在 AT 侧无源 |
| VP 语义 | `author.participantType`（VIRTUAL 可辨）+ `relativeTimeSeconds`（哨兵 2147483647→NULL） | AtCoder **无虚拟参赛概念**，两个字段都不存在；standings 登录墙 → 连参赛人数都拿不到（只有 `Place`） | AT 不进 VP 切片，属平台性质而非实现问题 |
| 历史完整度 | 官方全史（Benq 实测 8585 条含 870 gym） | rating 史最早只到 **2016**（chokudai 2016-09、kenkoooo 2016-07），2019 系统改算前的老成绩未回填 | AT 曲线起点 ≠ 生涯起点，卡面要如实标注 |
| 限流 | 官方口径 ~1 req/2s | 无公开限速；并发敏感（15 并发→7×429），单源只需 1–2 请求 | 串行 + 429 退避即可，比 CF 更轻 |
| 依赖形态 | 官方接口，风险低 | 官方页面（政策禁爬）+ 无第三方兜底 | 单源失效 = AT 卡整块空，需要"源状态"提示 |

---

## 3. 三段清单

### 3.1 能一比一复刻（口径不变）

对照 `docs/04` §4.4 的 `rating` 块，**逐字段都有着落**：

| 字段 | AT 来源 |
|---|---|
| `count / current / first / max` | history 数组长度、末条 / 首条 `NewRating`、`max(NewRating)` |
| `rankLabel` | 由 rating 落色段（§2 已给实测样本） |
| `totalDelta(+Tone)` / `lastDelta(+Tone)` | `NewRating - first.NewRating`、末条 `NewRating - 前一条 NewRating`（AT 不给 Diff，自算，与 CF 侧 `buildRating` 同一做法） |
| `lastContest` / `lastContestShort` | `ContestName` / `ContestScreenName` |
| `series[]` | `EndTime→ts(YYYY-MM)`、`NewRating→newRating`、`ContestName→contestName`、自算 `delta` |
| 额外可得（CF 没有） | `Place`、`Performance`、`InnerPerformance`、`IsRated` → 可做折线 tooltip「第 59 名 · Perf 2455」 |

组件与纯函数侧：`RatingChart`、`Num`/`Delta` 动效、`buildRating()` 主体、向导、断网读缓存、`start.bat`、同步进度轮询框架 —— **原样可用**。

### 3.2 能做但要改口径（要拍板）

1. **AT 的"出勤"替代口径**：把 `EndTime` 当活跃信号画格子图 → 但 AT 只有 42–484 条记录，53 周窗口里一年最多 ~52 场（ABC 周赛 + ARC/AGC 月赛），格值上限≈1。这是"**参赛格子**"不是"过题格子"，文案与配色阶必须分开，且不能与 CF 的格子混在一张图里加总。
2. **`/api/dashboard` 的形状**：`rating` 从单对象变成分源。按 `02` 第 8 轮已定「三张独立卡、不做跨尺度合并总分」→ 建议 `{ rating: { cf, at | null } }`，前端各渲染各的，单源为 null 不牵连另一源。
3. **同步状态 DTO**：`pages / fetched / offsite` 对 AT 无意义 → 要么按 source 分块，要么 AT 侧留空并渲染 `—`（`04` §4.4 的"取不到值给 `—`"规则正好接得上）。
4. **换 handle 的归属逻辑**：`META_HANDLE` 目前单值；AT handle 独立配置后，"换人清空重建"要按 source 分域（换 AT handle 不该清 CF 数据）。
5. **段位色阶视觉**：AT 的 8 色与现有 token（`--accent-2:#4CC9F0` 数据蓝）会打架，需要一轮设计确认（低饱和化 or 只在 rankLabel 用原色）。
6. **限流/重试**：CF 客户端 `MIN_INTERVAL_MS=2000 / MAX_RETRIES=3` 对 AT 过慢也不必要 → AT 客户端单独定（串行 + 429 退避 + 1–2 请求）。
7. **难度/标签的"要么放弃要么自建"**：掌握热力图（切片 3）若要有 AT 半边，只剩"自建难度模型 + 社区 tag 爬取"两条重活；本轮建议**明确划出 AT 不参与切片 3**。

### 3.3 这一版做不到（硬缺口，别再规划）

1. **AT 活跃格子图（日 × 独立过题数）** —— 提交明细无公开源（§1.2、§1.3）。
2. **总过题数 / 当月过题 + 近 6 月柱 / 连续训练天数 / 最长连续 / 断档 ≥3 天 / 周末占比 / 空格数** —— 全是 `verdict='OK'` 的派生量，上游断则全断。`aggregate.ts` 的纯函数不用动，但**没有输入**。
3. **题目难度** —— 官方从不公开数值难度，唯一的 ML 难度模型随域名消失。
4. **题目标签** —— 官方无机器可读 tag。
5. **VP / 场内相对时间 / participantType / 名次百分位（参赛人数）** —— 平台无此概念 + standings 登录墙。
6. **"部分点"口径** —— AT 旧 ARC/AGC 有部分点；无提交粒度时连"AT 的过题怎么定义"都落不了地（将来若走登录抓取，这条必须先定）。
7. **2016 年前的 AT 生涯** —— 端点里就没有。

---

## 4. 架构改造点（切片 2 的净新增工作量）

1. `SCHEMA_VERSION 1 → 2`：`rating_history` PK 改 `(source, contest_key)`；新增 `at_contest_history` 或统一表 + `source` 列（建议后者，字段对齐 §3.1）；迁移幂等测试要补。
2. 同步层抽象：**先冻结 `SyncSource` 接口**（`checkHandle / fetchAll / toRows`），CF、AT 各一实现。按 `02` 第 9 轮的并行规则，这一步做完才具备"CF/AT 适配器双线"的条件。
3. `vault/config.json`：`{ cfHandle, atHandle, port }`；`configBodySchema` 按平台分 handle 校验规则；设置页加 AT handle 输入与"源状态"显示。
4. `shared`：`rankLabelFor/rankColorFor` 增加 source 分派 + AT 色表；`buildRating()` 主体不动；聚合纯函数**不动**。
5. web：第三张 rating 卡 + AT 参赛格子卡（复用 `ActivityGrid`，数据源与文案不同）+ 未解锁位调整。
6. 视觉稿：`design/mock-01-dashboard.html` 已冻结 → AT 卡是新组件，需要一轮 mock（不碰已冻结的 CF 三屏）。

---

## 5. 时区：现状与 AT 侧新增的坑

**现状（CF 版，读码结论）**：全项目只用 `Date` 的本地 getter（`days.ts` 的 `formatDay / formatMonth / localDayKey / dowMon / mondayOf / addDays`）与 `new Date(epoch*1000)`，**没有任何 `Intl` / `timeZone` / 固定偏移**（grep 证据：仅注释里写了 Asia/Shanghai）。即：

- **分桶看的是本机 OS 时区**，`docs/04` §4.3 那句「本机本地时区（Asia/Shanghai）」是对这台机器的假设，不是实现约束。
- 库里存的是 `created_ts` epoch 秒（绝对时间，与时区无关），日/月在**读时**现算（`db.ts` `loadAcEvents` → `localDayKey`）→ 换时区不会污染库，但历史格子会**整体静默平移**，streak / 月度柱 / 周末占比跟着变。
- 敏感点：CF 比赛多在 UTC 12:00–18:00 结束 = CST 20:00–次日 02:00，正好压跨日边界；本机若被设成 UTC+9（或在境外机器上跑），一部分题会挪到前一天，界面毫无提示 —— 与项目"诚实呈现"原则冲突。
- 单测不受影响：`aggregate.test.ts` 用 `new Date(y,m,d)` + day 字符串做纯日历算术，任何时区结果一致。只有 `epoch → day` 这一条链依赖运行环境。

**AT 侧新增**：`EndTime` 自带 `+09:00`（JST），`Date.parse` 后是绝对 epoch 秒，**与 CF 同构，不引入新问题**。但要定一条口径：AT 参赛日按 JST 还是按本地日历（ABC 常 JST 21:00–23:30 结束 = CST 20:00–22:30 同日，AGC 多在同一天的日间，实测影响接近 0；月末/月初场次的 `series.ts` 月份归属同理）。建议：**统一转本地分桶，与 CF 同口径**，不给 AT 单开特例。

---

## 6. 建议

1. **切片 2 的 AT 部分只承诺三件事**：AT handle 配置与校验 + **AT rating 卡**（§3.1 全字段）+ **AT 参赛格子（出勤，非过题）**，并加一句"2016 起 · 参赛史非过题史"的诚实标注。其余 AT 统计卡一律不做。
2. **AT 过题史如果确实要**，只有两条路，都不该伪装成"自动同步"：
   - (a) **浏览器辅助一次性导入**（在已登录的本机浏览器里读提交页，落库为本地数据）—— 不引入服务端登录态，工程量小，**推荐**；
   - (b) 存用户自己的登录 cookie 由 server 抓 `?user=me` —— 要处理 csrf / 会话过期 / robots 明令禁止，脆且责任重，不推荐。
   规格里应把它标成「手动 / 浏览器辅助导入」，与 CF 的自动同步分开写。
3. **切片 3（掌握热力图）明确不含 AT**：没有难度轴数据源，也没有 tag。XCPC 侧仍可走 heimaom 技能分，CF 侧走内嵌 tags —— AT 空着，别为它自建难度模型。
4. **顺手把时区口径钉死**（本轮暴露的真问题，与 AT 无关但会影响多源对比）：二选一 —— 显式固定 `Asia/Shanghai`，或保留本机时区但在设置页 / tooltip 显示"当前生效时区"。建议前者（数据口径不该随机器漂移）。
5. **先更正 `docs/03`** 再写 `09-AT规格.md`：`03` 目前对 AT 的三条 ✅ 全部不成立，留着会误导实现 agent。

---

## 7. 待拍板（编号供回复用）

| # | 问题 | 我的推荐 |
|---|---|---|
| P1 | 接受"官方 `history/json` 被 robots.txt 禁爬、但个人低频 1 请求/次"这个口径吗？ | 接受，并在设置页写明源状态 |
| P2 | AT 曲线是否只收 `IsRated:true`？ | 是；非 rated 场次单独计"参赛 N 场" |
| P3 | 「AT 参赛格子图」要不要做（它不是过题口径）？ | 要，但独立卡片 + 独立文案，绝不与 CF 格子加总 |
| P4 | AT 过题史走 (a) 浏览器辅助导入 还是 (b) 登录态抓取 还是 (c) 本轮不做？ | (a)，或直接 (c) 留到切片之后再议 |
| P5 | rankLabel 用 AT 颜色名（Cyan/Yellow…）还是中译（水色/黄）？ | 沿用 CF「原始名不中译」精神：英文色名 + AT 原生色 |
| P6 | 时区钉死 Asia/Shanghai 还是跟本机？ | 钉死 `Asia/Shanghai`，并在设置页显示 |
| P7 | `/api/dashboard` 的 rating 分源形状（`{cf, at}`）确认？ | 确认，前端三张独立卡 |

---

## 附 · 实测证据台账

- 能用：`https://atcoder.jp/users/{chokudai|kenkoooo|yosupo|hitonanode|jiangly}/history/json` → 200；`/users/yosupo?graph=rating` → 200（内嵌 `var rating_history=[…]`，仅 rated，37 条 vs 42 条）；`/contests/` 与 `/contests/archive?lang=en&page=N` → 200 HTML；`/contests/{typical90,dp,abl}/tasks` → 200。
- 登录墙：`/contests/abc300/submissions?user=…` → 302 /login；`/contests/abc300/standings*` → 302 /login。
- 已死：`atcoder-api.kenkoooo.com`、`atcoder-prod-api.kenkoooo.com`、`atcoderproblems.me|.us|.com`、`progcap.io`、`atcoder-stats.com`、`ac-api.io`（DNS NXDOMAIN，AliDNS 权威 `Status:3`）；`api.github.com/repos/kenkoooo/atcoder-problems` → 404；`kenkoooo.com/atcoder-api/v3/...` → 404。
- 缺失字段：`abc300_c` 任务页 0 次 `★`/難易度；`/problems`、`/api/*`、`/ratings` → 404。
- 色段样本（2026-10-04）：2006 → `user-yellow`；2708 → `user-orange`；2958 / 2987 / 3628 → `user-red`。低段边界（400/800/1200/1600）实现时按同法校准。
- 不存在 handle 的空数组反例：`nonexistenthandle_zzz9x8`、`E869103`（后者页面 404，`history/json` 仍 200 + `[]`）。
