# 审查轮证据（2026-10-03 深夜 · 分支 fix/handle-scoped-data）

整体审查与 debug 过程中产生的截图与数据都留在这个目录，`shots/*.png` 是切片 1 的交付截图，不动。

| 文件 | 是什么 |
| --- | --- |
| `handles.json` | 三个参照 handle 的接口原始返回（tourist / phoniextree），用来对数字 |
| `jywlq-1440.png` | jywlq 仪表盘 1440×900（修复后） |
| `jywlq-1280.png` | jywlq 仪表盘 1280×800 |
| `locked-master.png` | 未解锁占位页（`#/master`） |
| `wizard.png` | 设置向导 Step 1（`#/settings`） |

## 与参照图对数字

| handle | 参照（CF 页面 / 训练统计） | ANVIL 实测 |
| --- | --- | --- |
| `jywlq` | 101 题 · 9 月 12 题 · 最长 5 天 · 1278 Pupil · 11 场 | 101 · 12 · 5 天（26-05-12 → 26-05-16） · 1278 Pupil · 11 场 ✅ |
| `phoniextree` | 32 题 · 近月 0 · 最长 3 天 · 801 Newbie | 32 · 0 · **2 天** · 801 Newbie（口径差异，见下） |
| `tourist` | 3039 题 · 近月 12 · 最长 6 天（近一年 3 天） · 3384 LGM（max 4009） | 3039 · 9 月 13 / 10 月 0 · 2 天 · 3384 Legendary Grandmaster · max 4009 |

**最长连续的口径差异（不是 bug）**：参照控件的 "in a row" 数的是**有提交的连续天**，`docs/04` §4.3 定义的是**有 AC 的连续自然日**。对 `phoniextree` 直接查库两套口径：AC 日最长 2 天（2026-05-09 → 05-10），任意提交日最长 3 天（2026-04-26 → 04-28）——后者正是参照图上的 3。我们按规格走 AC 口径；`tourist` 的 2 天同因，未在 tourist 上单独复算。

**"近月" 的口径差异**：参照是滚动 30 天，我们是本地日历月（§4.3），月初会短暂对不上，属规格内口径。

## 断网 / 服务不可达（headless 截不了，留 DOM 证据）

页面已加载、服务随后挂掉时点同步：

```json
{"busy":false,"disabled":false,
 "alertClass":"alert alert--err",
 "alertText":"连不上本地服务，ANVIL 可能没在跑 · 本地缓存的数据照旧显示",
 "stillShowingData":true,"total":"101 题"}
```

按钮复位、红条说明到位、缓存数字仍在屏上 —— §1.6「断网可打开：展示已缓存数据 + 明确提示，不崩」。

## 交互回归（浏览器实测）

- 顶栏点同步 → `busy=true`、按钮文案「拉取中…」、disabled ✓
- 同步途中切到设置页 → 面板显示「正在拉取历史」并跟随到「炉子点着了」✓（修复前会退回 Step 1 看不到进度）
- 同步结束后再进设置页 → 落回 Step 1，仍可换 handle ✓（避免状态粘住没有出口）
- 三种 tooltip、hash 直达、未解锁页、控制台零报错 ✓
