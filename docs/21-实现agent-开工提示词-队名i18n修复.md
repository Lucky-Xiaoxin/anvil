# 实现 agent · 开工提示词 · 队名 i18n 修复（双语对象归一）

> **交付对象：实现 agent**。单点修复批次：srk.json 里部分场次的队名/校名/成员名是双语对象（`{"zh-CN":…,"fallback":…}`），引擎只认字符串 → 榜上队名空白。本文件 = 本批次唯一工作清单。开工基线 = `main` @ `c4cc086`（`npm test` **342/342 全绿**）。
> 影响面已由架构侧扫描确认（§1 的清单直接照抄，不需要重新扫全库）；改动极小，重在**别扩大**。

---

## 0. 开工三件事（先做）

1. `git status` —— 工作树应干净（有个别预期外文件先报告再动）。
2. `git branch --show-current` 应为 `main`；新建并切到本批分支：**`git switch -c fix/team-name-i18n`**。
3. `npm test` 基线 **342/342 全绿**；`npm run typecheck` 干净。

---

## 1. 问题（已定位，证据在案）

现场：`buildModel`（`packages/web/src/components/arena/engine.ts`）解析 srk 行时——

- `:334` `const str = (v) => typeof v === 'string' ? v : ''` —— **非字符串一律变空串**；
- `:357-359` 用 `str()` 提 `user.name` / `user.organization` / `teamMembers[].name`。

但实测（架构侧扫过 `vault/arena/official` 全部 75 个缓存 srk.json）**部分场次这三个字段是双语对象**，真实形状（2026 南昌首行）：

```json
"user": {
  "name": {"zh-CN":"打赢邱神就算成功","fallback":"Nanani will win"},
  "organization": {"zh-CN":"江西师范大学","fallback":"Jiangxi Normal University"},
  "teamMembers":[{"name":"严子轩"},{"name":"陶钧"},{"name":"陈哲"}]
}
```

`en` 键可有可无（2018 ecfinal 的 name = `{"zh-CN":"中二之力","en":"Power of Two","fallback":"Power of Two"}`）。

受影响清单（缓存文件都在 `vault/…`，**只读**）：

| 字段形状 | 后果 | 场次 |
|---|---|---|
| `name` 是对象 | **榜上队名全空**（用户实报） | `icpc/icpc2018/icpc2018ecfinal`、`icpc/icpc2019/icpc2019nanchang`、`icpc/icpc2025/icpc2025xi_an`、`icpc/icpc2026/icpc2026invitational-nanchang`、`icpc/icpc2026/icpc2026invitational-xi_an` |
| `organization` 是对象 | 连带 **S# 塌陷**：`engine.ts:483-486` 的 `seenOrg` 全撞空串——除总榜第一支正式队外，无人拿到 S# 号 | `icpc/icpc2026/icpc2026invitational-nanchang`、`provincial/fj/fjcpc13th` |
| `teamMembers[].name` 是对象 | **队伍弹层成员列表空**（`ArenaBoard.tsx:830`） | `provincial/fj/fjcpc13th`、`provincial/ha/haicpc15th` |

对照：`contest.title` 已在 `:376` 正确处理双语对象（`zh-CN → fallback`），队名字段没跟上。参考项目 vp-board 输出的是对象原文（`{zh:… en:…}`）——它也没归一，不是我们要的行为。

下游（榜体、弹层、搜索、榜脚）全部读 `TeamModel` 的字符串字段，所以**修复点只在 `buildModel` 一处**，UI 不加二级兜底。

---

## 2. 改法（单文件：`packages/web/src/components/arena/engine.ts`）

1. 新增类型（放 `SrkUser` 上方）：

```ts
/** srk 双语文本：多数场次是纯字符串；少数（2018 ecfinal / 2026 南昌·西安等）是 { 'zh-CN', en?, fallback } 对象 */
export type SrkText = string | { 'zh-CN'?: string; en?: string; fallback?: string };
```

2. 类型放宽：`SrkUser.name` / `SrkUser.organization` / `SrkUser.teamMembers[].name` 改用 `SrkText`；`SrkContest.title` 的内联对象字面量也换成 `SrkText`。
3. 加归一函数（放 `str` 旁边）：

```ts
const pickText = (v: SrkText | undefined): string => {
  if (typeof v === 'string') return v;
  if (v === null || typeof v !== 'object') return '';
  return str(v['zh-CN']) || str(v.fallback) || str(v.en);
};
```

4. 四处换用：`name: pickText(user.name)`、`org: pickText(user.organization)`、members 的 `.map((m) => pickText(m?.name))`、`title: pickText(contest.title)`（从 `str(title?.['zh-CN']) || str(title?.fallback)` 换过来——行为等价，多一层 `en` 末位兜底）。
5. 文件头注释（第 5 行「数据换成 srk.json 的真实形状（2026-10-09 实测）」附近）补半句：部分场次队名/校名/成员名是 `{ 'zh-CN', en?, fallback }` 双语对象。

**明确不动**：`user.id`、`location`（抽查 750 行样本 id 全是字符串）、引擎排序/罚时/S# 逻辑本身、任何 UI 组件。

---

## 3. 测试（`packages/web/test/arena-engine.test.ts` · `模型解析` describe 内新增；夹具自造，勿抄真实数据）

1. **对象名三态**（一律经 `buildModel` 断言 `teams[i].name / org / members`，不手搓 TeamModel）：
   - `{'zh-CN':'自造甲队', en:'Team Alpha', fallback:'Team Alpha'}` → `'自造甲队'`；
   - 仅 `{fallback:'仅回退名'}` → `'仅回退名'`；`{en:'English Only'}` → `'English Only'`；
   - `{'zh-CN':'', fallback:'非空回退'}` → `'非空回退'`（空串不吃掉回退）；
   - 对象 org + 成员数组「对象名与字符串名混合」各取对，`members` 等于预期数组。
2. **S# 回归断言**（必加，防倒退）：三支正式队——两队同一**对象** org、一队另一对象 org（可让同校两队过题数不同，确保头队明确），`buildBoard` 后断言：同校头队 `srank='1'`、同校次队 `srank=''`、另一校 `srank='2'`。修复前此断言必红（空串全撞组），修复后必绿。
3. 现有 342 个测试保持全绿（尤其既有的字符串 org S# 用例 `:323-334`，不许改断言）。

---

## 4. 自证（真机冒烟 + 前后对照截图，必须）

1. **修复前先复现**：起服务开 **2026 南昌邀请赛** 榜 → 队名空白（截图 `fix-i18n-before.png`）。
2. **修复后同位置对照**：队名渲染（首行应为「打赢邱神就算成功」）+ **S# 列正常**（南昌 2026 带 S# 系列；修复前只有总榜第一支正式队有号）→ 截图 `fix-i18n-after.png`。
3. 再开一场「name 对象、org 字符串」的（**2018 ecfinal** 或 **2026 西安邀请赛**）看队名正常，可并入 after 或单独一张。
4. `fjcpc13th` 的队员弹层（members 对象）：目录翻得到就顺手截图验证，翻不到以单测为准、报告里写明。
5. 截图命名 `fix-i18n-*.png` 放 `design/_shots/`；**vault 只读**；测完关服务（`stop.bat` 或关窗口）。

---

## 不做清单（照抄自查）

- 不加依赖；不改 `docs/`、`design/`（除新增 `fix-i18n-*.png`）、`AGENTS.md`、`vault/`。
- 不做本提示词之外的"顺手"：不发明 UI 兜底、不重构引擎、不碰 `user.id`。
- **不合并、不 push、不删分支**；只提交到 `fix/team-name-i18n`。
- 临时脚本/浏览器 profile 放系统 temp，仓库里不留临时产物。

## 交付报告（`实现说明-队名i18n修复.md`，仓库根，随分支提交）

1. 改动对照表（做没做、改在 `文件:行`、证据）。
2. 截图清单（before/after 各截了什么）。
3. `npm test` 新总数（只增不减）+ `typecheck` + `build` 全绿；提交清单。
4. 已知问题与偏差——如实列。
