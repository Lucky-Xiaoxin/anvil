# 切片 3 · XCPC 实装 · 工作文档（实现契约）

> **交付对象：实现 agent**。本文件是**当前切片（切片 3）的唯一实现契约**；切片 2 契约 `docs/09-AT规格.md` 已交付，其 §9 是本文档的取数底稿 —— 冲突处以本文档为准（§2 含 2026-10-06 复账更正）。
> **视觉基线：`design/mock-03x-xcpc-explore.html`（v4x2 定稿，2026-10-06 冻结）**——平台色玫瑰 `#F0A0C4`；`#s1`（长卷）/ `#s2`（认领流）/ `#s3`（组件与状态）三屏直达，`#s1,medal` 演示决赛勋章，`#s1,pfx=a..f` 六色试穿，`#s1,rm` 直落终值态。`design/mock-03-xcpc.html` 是前一版（历史对照，不参照）；mock-01 / mock-02 为切片 1 / 2 基线（背景沿用）。
> 数据源 = heimaom.cn 静态导出（xcpcrating 社区快照，**非官方**）。"同步" = 拉最新快照，不是实时数据。

---

## 0. 一句话目标

把三端 tab 里的 XCPC 从占位屏升级为**完整选手档案屏**：认领（搜索 → 确认）→ 档案长卷（名衔 / 荣誉陈列 / 阶梯轨迹 / 队名墙 / 逐场编年）→ 快照刷新与源状态；平台色玫瑰进入色板（`is-strong` 加强版）。

## 1. 交付物（Definition of Done）

1. **XCPC tab 条**（改造 `SourceTabs`）：已认领 = rating 次行显示 `officialRating` 取整、颜色 `--pf-xcpc`（不走段位色）、状态点、tooltip 三行（档案 key / 数据版本+生成天数 / 上次同步+来源标注）；未认领 = rating `—`、idle 点、tooltip「未认领」。**移除「待接入」chip**。
2. **未认领空态（认领屏）**：就地搜索姓名 / 拼音 → 候选（≤8，`名@校 + N 场`）→ 选中 → 确认（`认出我的档案`）→ 完成（写入 vault + config，`看档案` 切长卷）。搜索失败 / 空结果 / 上游不可达均有态。
3. **档案长卷（已认领）**：五段全部实装——名衔、荣誉陈列（勋章）、阶梯轨迹（SVG 自绘）、队名墙、逐场编年（表格）+ 卷脚诚实标注。规格见 §5。
4. **设置页 XCPC 行**：当前档案 `key · N 场` + 行内搜索换人（同款搜索组件）；未认领时空态 + 认领入口。
5. **同步与状态**：顶栏「同步 XCPC」= `POST /api/xcpc/refresh`（拉快照：版本检查 + 变更时重拉）；四态点（ok / stale / down / idle）；快照过期与不可达的降级条。
6. **落库 schema v3**：新表 + 纯增量迁移（幂等、真实 `vault/` 无损，CF/AT 数据一根毛不动）。
7. `npm test` 全绿 + `npm run typecheck` 通过（新增单测见 §7）。

## 2. 数据源契约（2026-10-06 复账，照抄）

**Base**：`https://heimaom.cn/data/`（GitHub Pages 静态导出）。四个端点：

| 用途 | 路径 | 实测 |
|---|---|---|
| 版本号 | `meta.json` | 1096B：`{generatedAt:"2026-09-28T19:57:35.521003+00:00", counts:{players:68940,…}, …}`。**版本 = `generatedAt`**（展示取日期部分） |
| 选手详情 | `players/<shard>.json`，`shard = md5(key)[:2]`（UTF-8 十六进制小写） | `{key: PlayerDetail}` map；实测单片 1,815,727B / ~290 人 |
| 官方榜分母 | `leaderboards/official/meta.json` | 47KB：`{total:63120, pageSize:100, pageCount:632, schools:[…]}`。**分母 = `total`**（取不到 → 显示 `—`，不瞎编） |
| 搜索分片 | `search/players/<bucket>.json`（**256 桶**） | 紧凑行 `[key,name,org,contests][]`，如 46.json=4456 行/312KB |

### 2.1 搜索分桶（复账更正）

- **桶名 = `md5(小写后首字符)[:2]`**，首字符取查询串 trim 后第一个码点。
- **入桶规则（实测）**：每个选手按 **姓名首字符** 与 **学校（org）首字符**（都小写）**各入一桶**——`李鑫杰@佛山大学` 同时在 `46`（李）与 `20`（佛）；`chi him kuan@Lou Hau High School` 同时在 `4a`（c）与 `2d`（org 的 l）。查找时按查询首字符进主桶即可命中姓名或学校两种写法。
- 桶文件 404 = 空桶，按 `[]` 处理。

### 2.2 搜索算法（照抄站点两段式，服务端实现）

```
qn = q.trim().toLowerCase();   qn 为空 → []
主桶 = md5(qn 首字符)[:2] → 拉行
命中 = 行.filter(hay.includes(qn))，取前 8
若 命中为空 且 /^[a-z]{2,6}$/.test(qn)：
    兜底：扫全部 256 桶（16 并发、失败桶按空、按 key 去重）收集 ≤8 条
返回
```

- `hay = (name + "\x01" + org + "\x01" + 声母(name) + "\x01" + 声母(org)).toLowerCase()`。
- **声母算法**（复刻 xcpcrating `web/src/lib/pinyin.ts`）：23 个代表字（阿波擦搭鹅发嘎哈击喀垃妈拿哦啪期然撒塌挖昔压杂）+ `Intl.Collator('zh-Hans-u-co-pinyin',{sensitivity:'base'})` 二分求单字声母；码点 <19968 或 >40959 → 无；非中文的 `[a-z0-9]` 字符原样保留，其余丢弃；按字符 memoize。Node 直接可用。
- 只有 **纯拉丁 2–6 位**（拼音声母串，如 `lxj` / `fsdx`）走兜底全扫；中文查询和 >6 位不做（站点行为照抄）。全扫是**站点自身的常规行为**（前端只在短拼音查询时触发），对静态文件并发上限 16、失败容忍。
- **进程内缓存**：`Map<bucket, Promise<rows>>`（Promise 级去重）；检测到快照版本变化时清空。搜索请求不落库。
- 超时：搜索分片 20s、详情分片 60s（1.8MB 单请求）；失败重试 1 次，仍失败按不可达处理（主桶非 404 硬失败 → 502；兜底扫中的失败桶按空跳过）。

### 2.3 PlayerDetail 字段（typing 基准，全部实测）

`key / name / org / contests / rating / allRank / officialRank / officialRating / history[] / medals? / skillPanel?`；**五维 `panel` 全员缺席（不做）**；`skillPanel` 留切片 4。

`history[]` 逐场（升序）：`contestId / title / startAt`(+08:00 ISO)` / teamName / rank / teamCount / official / rated / perf / rating_after / mu_after / tier(final|regional|invitational|provincial) / solved / rankPercent / dirt / dirtWrong / dirtSolved / firstATime`(分钟)` / lastHourSolved` + 官方榜套装 `perfOfficial / ratingAfterOfficial / muAfterOfficial / rankOfficial / teamCountOfficial / rankPercentOfficial / ratedOfficial`。
打星场：`official:false`、官方套装全 null → 行照列、成绩列渲染 `—`（`solved` 不是官方榜单字段，保留真实值）。

`medals`：`{[tier]: {gold, silver, bronze}}`——零奖牌 tier 省略、无奖牌者整字段省略（**读时 defensive**）。

### 2.4 诚实标注（一处不改）

来源非官方（xcpcrating 社区快照）· official 单口径 · **数据版本日期必须露出**（卷脚 / tooltip / 顶栏）。两钟口径：`数据版本`（上游 `generatedAt` 日）与 `上次同步`（本地拉取时刻）分开记、分开显。

## 3. 落库（schema v3）

```sql
CREATE TABLE IF NOT EXISTS xcpc_players (
  key TEXT PRIMARY KEY,
  payload TEXT NOT NULL,        -- PlayerDetail 原样 JSON 文本（整存，读时映射 DTO）
  snapshot_at TEXT,             -- meta.json generatedAt（ISO 串）
  rank_total INTEGER,           -- leaderboards/official/meta.json 的 total；取不到 NULL
  fetched_at INTEGER NOT NULL   -- epoch 秒
);
```

- `SCHEMA_VERSION = 3`；迁移 = 纯增量（`CREATE TABLE IF NOT EXISTS`），幂等，v2 库直接补表，真实 vault 不重建、CF/AT 数据不动；`initSchema` 现有 v1→v2 分支保持不变。
- **单档案语义**：claim 时先 `DELETE FROM xcpc_players` 再插入（表按 key 建成，便于未来扩展；当前只保一份）。
- 不写 `submissions` / `rating_history`（无提交粒度、无跨选手查询）。
- `vault/config.json` 增 `xcpcPlayerKey`（schema 加 `z.string().default('')`）；`vault.example/config.json` 补 `"xcpcPlayerKey": ""`。

## 4. 服务端模块与 API

**模块**：新文件 `packages/server/src/sync/xcpc.ts`（取数 + 搜索 + claim/refresh 逻辑；fetch/解析/映射都在这），路由挂 `api.ts`。**不走 `/api/sync` runner**（无进度上报需求、单请求往返），`/api/dashboard?source=xcpc` 保持 501 不动（前端不消费；501 消息文案可顺手改指向 `docs/14`）。

```
GET  /api/status            → 顶层新增 xcpc: { claimed, key, officialRating, snapshotAt, fetchedAt, status, error }
GET  /api/xcpc              → 200 { player: XcpcPlayerDto, snapshotAt, fetchedAt, rankTotal }
                              404 { error:{kind:'unclaimed'} }（未认领）
GET  /api/xcpc/search?q=    → { results: [{key,name,org,contests}] }（≤8；上游不可达 → 502）
POST /api/xcpc/claim {key}  → 200 { player, snapshotAt, fetchedAt, rankTotal }
                              404 not-found（分片里无此 key）/ 502 unavailable / 409 busy
POST /api/xcpc/refresh      → 200 { updated: boolean, player?, status } / 502 / 409
```

- **claim 原子序**：拉详情分片 + meta.json + 官方榜 meta（3 请求）全部成功 → 事务：清 xcpc 域 + 写新行 → 写 config → 返回。任一失败 = 现状不动、报对应的错。换人 = 再认领一次（旧档案整域清掉）。
- **refresh**：先拉 meta.json；`generatedAt` 与库中 `snapshot_at` 相同 → 只更新 `xcpc:last_sync_at`（`updated:false`）；不同 → 重拉详情分片与分母，事务更新（`updated:true`，并清搜索缓存）。**新版快照里找不到该 key** → 保留旧数据 + `xcpc:last_error = "档案在新版快照中未找到 · 保留本地数据"`（状态转 down）。成功（无论 updated）写 `xcpc:last_sync_at`。
- **状态**：`idle` = 未认领；`down` = `xcpc:last_error` 非空；`stale` = **快照日期距今 > 10 天**（常量 `XCPC_STALE_AFTER_DAYS = 10`，基于"数据版本"而非本地同步时刻——这是 XCPC 与 CF/AT「3 天没同步算过期」的差别：社区快照周期本来就慢，按同步时间判会常年飘黄）；`ok` = 其余。
- 互斥：refresh / claim 进程内串行（进行中再来 → 409）。
- **DTO 映射（服务端唯一做的一层，之后前端不再碰口径）**：官方单口径 = `rank ← rankOfficial / teams ← teamCountOfficial / rankPercent ← rankPercentOfficial / perf ← perfOfficial / ratingAfter ← ratingAfterOfficial`；`star = official === false`；数值原样给（显示取整在前端统一）；`bestRank / 跨度 / delta / 年份分组 / 百分位的数字格式` 全部前端算。

## 5. UI 契约（以 mock-03x 为准，逐条对照实现）

### 5.1 平台色（定稿）

- `--pf-xcpc: #F0A0C4`（rgb `240,160,196`）——玫瑰，2026-10-06 定稿（六支试穿对照后选定）。
- 加强版 `is-strong` 只作用于 XCPC 屏根节点：卡片色晕（radial 5%）+ 同色描边（17%）——照 mock `.dash.is-strong`。
- 使用点：卷首光带 / 卡头 label / 分数与读数线 / 阶梯浅染 / 旗杆 / tab 指示条 / 选中描边。**除此之外的一切色（段位色、热力阶、品牌琥珀 `--accent`、涨跌蓝/琥珀）一律不动**；主按钮 `btn--primary` 保持品牌琥珀（mock 同）。

### 5.2 认领屏（未认领）

- 单卡 hero：label `XCPC` + 标题「还没有认领 **XCPC** 选手档案。」+ 副句「输入姓名或拼音 —— 从快照名单里认出你自己。」+ 搜索框（placeholder「姓名或拼音，如 李 / lxj」）+ hint「拼音声母也行（lxj）· 重名请对照学校」。
- 流程态：输入 ≥1 字符 → **260ms 防抖** → 服务端搜索（骨架「正在搜索「q」…」）→ 候选行（头像字 / `名 @校` / `N 场`；选中带平台色描边 + 对勾）→ 确认块（`已选中 key` + 「认出我的档案」+「换一个」）→ 完成 alert（「已认领 `key` · N 场 · 数据版本 `date`」+「看档案」）。
- 空结果：「没有匹配的档案 · 换一种写法试试」；上游不可达：降级条（bad）「XCPC 快照暂不可达（`code`）· 请稍后重试」+「重试」。**不进 mock 屏 2 的 Step 02–05 演示卡**（那是流程示意）。

### 5.3 档案长卷（已认领）

- **名衔**：label `XCPC · 官方榜`；姓名（tooltip「档案 key / …@… / 重名请对照学校区分」）；学校；`key … · official 单口径`；右侧「当前分」大数字（**count-up**，玫瑰）+「官方榜 `R` / `T` · 前 `x.x%`」（R/T 取整，百分比 = R/T×100 一位小数）；三格：参赛场次 `N 场`（`contests`）、最佳名次「第 `R` 名」（min rankOfficial；无 → `—`；tooltip 带场次与队数）、生涯跨度 `YYYY-MM → YYYY-MM`（首末场；tooltip 带整天数与月数）。
- **荣誉陈列**：tier 行序 final→regional→invitational→provincial，零奖牌 tier 整行省略；行权重按出现序递减（第 1 行常规 / 第 2 行 `--dim` / 第 3+ 行 `--dim2`）；行尾「N 枚」；**勋章一枚 = 一块奖牌**（金属 gold→silver→bronze 序），决赛 tier 勋章带虹彩丝带 + 紫晕（reduced-motion 静止）；**折叠规则：单 tier >12 枚 → 渲染前 12 枚 + 「+N」计数 chip（tooltip 注明另有 N 枚）**；无奖牌整段 `—`（不画空网格）。卡头「共 N 枚 · 按层级分桶」。tier 徽章材质四档：决赛=虹彩箔（8s 缓慢流光，rm 静止）/ 区域赛=琥珀金 / 邀请赛=翡翠 / 省赛=冷钢 / 打星=星尘虚线。
- **阶梯轨迹**（SVG 手绘）：x = 全场次序号（含打星位）、y = official 分；**步进台阶线**（横到下一场、再竖直落阶；打星点**不入线**，前后两个 rated 点直接跨接）；打星场 = 虚线钉 + 「打星」小字；落点菱形刻痕涨蓝/跌琥珀（delta 相对上一 rated 点，首点按涨）；末点琥珀 + 光晕；线下 `--pf-xcpc` 浅染渐变；y 网格 100 步进（rated min/max ±40 后 50 取整）、x 刻度 4 枚（第 1 / ⌈N/3⌉ / ⌈2N/3⌉ / N 场）；悬停命中区一场一列（含打星列），tooltip：rated =「title · date / `rating  ±delta` / 第 R 名 / T 队 · 前 x% / Perf … · 队名 …」，star =「title · date / 打星场 · 官方榜无成绩 / 过 N 题 · 队名」。卡头读数「首 → 末 · ±总差」；卡脚「横轴 = 场次序号 · 打星 N 场虚钉不入线 · 悬停看日期与名次」。**边界：rated 场 = 0 → 整卡空态；= 1 → 单点直显（不除零）**。
- **队名墙**：**连续同名场次为一段**（换名开启新段），按出现序；旗 = 队名 + `N 场` + `YYYY-MM → YYYY-MM`；悬停亮旗杆 + tooltip「番号 · name / N 场 · 起 → 止 / 最佳 第 R 名 / T 队 · date」（取段内非打星最小 rankOfficial；全打星 → 「全部场次打星 · 无官方榜名次」）。卡头「N 支 · M 场 · 按番号时代排列」。
- **逐场编年**：全宽表格，**最新在上**；年份分隔行（`YYYY` + `N 场` + 该年 rated 首末分，无 rated 省略分段）；列：日期（+`#序号`）| 比赛（tier 徽章 + 打星 tag + 标题）| 队名 | 名次 ÷ 队数（`R / T` + 「前 x%」副行；打星 `—`）| 过题 | Perf（打星 `—`）| 赛后分 ±（`值` + `±delta` 涨/跌色；打星 `—`）。行悬停（整行命中）tooltip：rated =「title · date / `rating  ±delta` / 第 R 名 / T 队 · 前 x% / Perf … · 队名 / 罚时比 d.dd · 首 A n′ · 末小时 n 题」，star =「… / 打星场 · 官方榜无成绩 / 过 N 题 · 队名 / 罚时比 d.dd · 首 A n′」。卡头「N 场 · 最新在上」。
- **卷脚**：「来源 xcpcrating 社区数据（非官方）· 官方榜单口径 · 数据版本 `date`」。
- 数字格式：分 / Perf / rating 一律取整显示；百分比一位小数；日期取 `startAt` 前 10 位（原文即 +08:00）。
- mock 的 **卷内 `rise` 交错入场不进产品**（换源动效即入场）；mock 的调参台 / 试穿开关 / mockbar / mockfoot 全是稿内工具，不进产品。

### 5.4 换源动效与数读秒

- **整卷（长卷）/ 认领卡各作为一个飞行单元**接进现有编排：`fly.ts` 的 `FLY_SELECTOR` 扩 `:scope > .dossier, :scope > .stack > .card`（或等效），参数、方向、时序不变量全部不动（`docs/09` §7 定稿）。
- 数读秒沿 `Num` 模式：换源进入跑一次、重复进入直落终值（与 CF/AT 一致）。

### 5.5 顶栏 / 侧栏 / 设置

- 顶栏：chip = 姓名（tooltip = 档案 key 三行）；meta =「数据版本 `date` · 生成 `N` 天前 | 上次同步 `rel`」；同步按钮已认领可用、未认领 `disabled` + title「认领后才能拉快照」；busy 文案「拉取 XCPC…」。
- 侧栏 navfoot：已认领 =「`N` 场参赛 · `M` 枚奖牌 / 源 heimaom 社区快照 / 数据版本 `date`」；未认领 =「未认领档案 / 源 heimaom 社区快照 / 口径 official」。
- 设置页 XCPC 行：复用 `srcrow` 外壳（点 / 名 / 分数 / 同步按钮）；字段区 = 当前档案 `key · N 场` + 展开搜索换人（选中 → 确认 → claim 替换）；未认领 = 「未认领」+ 展开搜索。换人提示「重名不特殊处理 · 候选里对照学校」。
- 降级条：快照过期（warn）「快照已 N 天未更新 · 社区版本仍是 `date` · 新档期以生成方时间为准」+「立即同步」；不可达（bad）「XCPC 快照暂不可达（`code`）· 下面是本地缓存（`date`）· 取不到的槽位显示 —」+「重试」。

### 5.6 实现口径备忘

- CSS 全部手写、组件全部自绘（阶梯是 SVG、勋章是 CSS，无图表库 / 图片资产）；不引入任何新依赖。
- 文案从简：不写解释性注释；口径进 tooltip / 脚注一行；开发细节不进 UI。

## 6. 前端模块落点（建议，可微调）

- `packages/shared`：`XcpcSearchRow / XcpcHistoryRow / XcpcPlayerDto / XcpcStatusDto` 类型 + status 扩展。
- `packages/web/src/components/xcpc/`：`XcpcClaim.tsx`（认领屏）、`XcpcDossier.tsx`（长卷 + 五段子组件）、`XcpcRow.tsx`（设置行）。
- 改动：`App.tsx`（xcpc 数据加载 / busy / 路由到两个屏）、`AppShell.tsx`（chip / meta / navfoot / 同步按钮）、`SourceTabs.tsx`、`fly.ts`、`api.ts`、`styles.css`（玫瑰 tokens + 长卷全套 + 勋章/徽章材质）。

## 7. 测试与验收

**单测（禁真实网络，一律 mock fetch）**：搜索（桶名 md5、hay 含声母、主桶命中不发兜底、纯拉丁 2–6 无命中触发全扫、>6 不扫、404 桶容忍、跨桶 key 去重）；声母（李→l、陈→c、佛→f、非 CJK → null、字母数字保留）；claim（成功落库 + config 写入 / 404 / 502 / 409 / 旧档案清除）；refresh（同版本仅更 lastSync / 新版本重拉 / 新版缺 key 保留旧数据 + error）；迁移 v2→v3 幂等 + CF/AT 数据完好；status 的 stale 规则（快照 10 天）；DTO 映射（打星行 null 化、official 套装选择）；折叠规则（14 枚 → 12 + `+2`）。
**测试夹具**：由真实 `李鑫杰@佛山大学` payload 裁剪的小样本（用户已授权；勿把完整 1.8MB 分片进仓库）。

**手测**：认领全流程（真实网络，用户点击触发）；长卷逐段对照 mock-03x（1440×900 基准 + 1280×800 不破版）；CF↔XCPC 换源动效双向；设置换人；断网 / 502 降级不崩；重复认领同人幂等。
**reviewer 验收**：真实冒烟 `李鑫杰@佛山大学`（预期：officialRating 1353.13→显示 1353、officialRank 41867、3 场、省赛铜 1），对照 heimaom.cn 页面抽查 2–3 个数；交付截图（长卷 / 认领流 / 设置 / 切换中 / 降级态）。

## 8. Out of Scope 与搁置记录

- **逐场奖牌（编年表挂牌）不做**：导出里没有可精确复刻的逐场奖牌字段（`medals` 只有聚合桶）；用 `contests-index.json` 的 medalCutoffs 反推实测 133 人有奖牌样本仅 44% 全对（误差 = 漏挂 + 颜色错档，根因在 marker 过滤 / 复合场 / 并列 / ICPC 回退等上下文缺失，值在原始 srk 管线里才有）。**备选数据集 `github.com/xcpcio/board-data`（MIT）已记录**——其与 heimaom 的**同一赛站命名未对齐**，接入前需先做两库赛站名归一；搁置复查，不进本切片。
- 掌握图 / skillPanel（切片 4）；多人档案；学校 / 比赛搜索；leaderboards 浏览页；VP；洛谷；SSE；多用户 / 云。
- `docs/09` §10 之外的一切"顺手扩展 / 顺手重构"都不做。

## 9. 给实现 agent 的约束

单 agent、单分支（从 `main` 切出）；歧义 → 最小实现 + `// TODO(切片4)` 注释；**不改 `docs/` 与 `design/`**；不引入规格外依赖（禁止需编译的原生模块）；`vault/` 含真实数据（迁移幂等无损、不当测试夹具）；完成后交付报告 = `§1 交付物` 逐条完成度对照表 + 测试结果（`npm test` / `typecheck` / 手测清单打勾）+ 截图 + 已知问题清单。
