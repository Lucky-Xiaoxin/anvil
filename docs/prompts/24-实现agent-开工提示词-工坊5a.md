# 实现 agent · 开工提示词 · 工坊 5a（受管工作区）

> **交付对象：实现 agent。** 契约 = `docs/contracts/23-工坊-代码管辖契约.md`，**逐条服从**；本提示词只给落点、陷阱与验收口径，与契约冲突时以契约为准。
> **开工基线** = `main` @ `b50d722`；本批分支 **`feat/workbench-5a` 已由架构侧切出并提交契约**（首提交 `ebbf6fc`）。基线 **18 个测试文件 / 387 条全绿**（契约 §13.3 写的 384 是旧数字，以 387 为准）；`npm run typecheck` 干净。
> **视觉稿未出**：契约 §11 只钉行为级。沿用现有 token / 栅格 / 字体与壳，不引 UI 库；截图交架构侧复核后再冻结。

---

## 0. 开工三件事（先做）

1. `git status` 应干净；`git branch --show-current` 应为 `feat/workbench-5a`。不在就 `git switch feat/workbench-5a`。
2. `npm test` 先跑一遍，确认 **387/387** 绿；`npm run typecheck` 干净。
3. 全文读契约与 `AGENTS.md`；再动代码。

## 硬纪律（违反即返工）

- 不加依赖；**不新增 SQLite 表、不改 DB schema**；不引 chokidar / UI 库 / Markdown 编辑器。
- 不改 `docs/` 与 `design/` 既有文件；只允许**新增** `docs/reports/实现说明-工坊-代码管辖.md` 与 `design/_shots/work-*.png`。契约与本提示词属架构侧，别改。
- 所有元数据写入走 `writeFileAtomic`（`packages/server/src/atomic.ts:10`）；所有 `spawn` 用参数数组 + `shell:false`，禁止拼命令行字符串。
- 单测禁真实网络、禁真实编辑器、禁写真实 `vault/`；临时根一律 `os.tmpdir()`，用例结束清理。
- 临时脚本 / 浏览器 profile / 截图草稿放**系统 temp**，仓库里不留临时产物。
- 起服务就自己收：记 PID，只收自己起的进程；**绝不按端口或进程名批量扫杀**（本机可能跑着用户的其它任务）。
- **不合并、不 push、不删分支**；只提交到 `feat/workbench-5a`。

## 两轮跑（agent 轮数有限，别混）

- **第一轮：实现 + 单测 + 分段 commit**；禁起服务、禁截图。做完停下，报「实现段完成 + 测试数字 + 改动文件」。
- **第二轮：自证 + 截图 + 报告**（§5 / §6）；仍只提交到本分支。

---

## 1. shared（`packages/shared/src/`）

### 1.1 新文件 `work.ts`（在 `index.ts` 导出）

- DTO 照契约 §9.1 **原样**：`WorkKind` … `WorkTreeDto`。
- zod：`vaultConfigSchema`（`schemas.ts:34`）加 `workspaceRoot: z.string().default('')`；`vault.example/config.json` 补 `"workspaceRoot": ""`。
  - **会破的断言**：`packages/server/test/config.test.ts` 有 3 处 `toEqual` 精确对象断言，补 `workspaceRoot: ''`，并加一条「老配置缺该键也能读」用例。
- 纯函数：
  - `slugify(title)`：小写、去变音（`normalize('NFKD')` 去组合符）、非 `[a-z0-9]` 折 `-`、压缩/去首尾 `-`。
  - `pathFor(kind, { title, problemKey, arenaPath, parentRel, topId, date })`：照契约 §5.1；日期取**服务端本地日期**（与全站时区口径一致，不是比赛日期）。
  - slug 回退优先级：`title` → `links.problemKey` → `links.arenaPath` 末段 → `<kind>-<YYYY-MM-DD>`；`CF2184F` 应得到 `cf-2184-f`；纯中文标题回退后标题仍完整保留。
  - 保留名（`CON/PRN/AUX/NUL/COM1-9/LPT1-9`）加 `-obj`、结尾点/空格剔除；冲突 `<slug>-2`…`-50`，再冲突 `<slug>-<4hex>`；`slug ≤ 40`、对象相对路径 ≤ 160、层级 ≤ 4。
  - meta 解析/校验（§4.2/§4.5）：只认 `schema=1`（>1 进 errors，不改写）；`id ^obj_[0-9a-f]{10}$`；`title` trim 1–120；ISO 时间；`parentId` 只有 problem 可非空且父为 contest；`tags.related` 去重且不含 primary；`labels` 0–20 个、每个 1–24、去重、剥前导 `#`；**未知顶层字段保留**（解析返回 raw + known，更新时 `{...raw, ...known}` 写回）。
  - 词表：最多两级、节点 ID `^[a-z0-9-]+(/[a-z0-9-]+)?$`、全局唯一、`name` 1–24、`children` 只许一级、`aliases` 映射；不合法 → `taxonomy` 为 `null` + `taxonomyError`，对象照常列出。种子词表照附录 A（13 轴 + 二级 + 10 条别名，`version: 1`）。
- `contestPathOk` 复用：把 `CONTEST_PATH_RE` + `contestPathOk` 搬到 shared（建议 `packages/shared/src/arena-path.ts`），`packages/server/src/arena.ts:56` 改为 import 并 **re-export**（现有 `arena.test.ts` 的导入不用改）；`work.ts` 用同一份，**不许复制两份正则**。

## 2. server（`packages/server/src/work/`）

### 2.1 `paths.ts`

- `resolveInside(root, rel)`：`path.resolve` 后 `path.relative(root, abs)` 必须是相对且不以 `..` 开头，**禁止 `startsWith`**；已存在路径取 `realpath` 再查一次。
- 根校验（§3.1）：必须是绝对路径；不是盘符根 / `C:/Windows` / `C:/Program Files*`；不在 `repoRoot` / `vaultDir` 内；存在时必须是目录；不存在时按**最近存在祖先**的 realpath 比较。
- Windows 大小写与盘符交给 `path.relative`（win32 本身不区分大小写），别自己转小写后拼字符串；保留名 / 结尾点空格在 slug 层处理。
- 忽略表（§8.2）与符号链接判定（`lstat`）集中在这里；**不跟随链接**。测试造目录链接用 `fs.symlinkSync(target, link, 'junction')`（Windows 不必管理员权限；创建失败 `EPERM` 的用例可跳过并注明）。

### 2.2 `store.ts`（`WorkService`）

- 依赖注入，别直接抓模块单例（否则没法测）：

  ```ts
  new WorkService({ db, getRoot, setRoot, spawn?, now? })
  ```

  `getRoot/setRoot` 包 `loadConfig()/saveWorkspaceRoot()`；`spawn` 给 open 注入；`now` 便于测时间戳。
- 全部写操作走**单 Promise 队列**；`rescan` 先等队列。索引只在内存（§8.1），**不建表**。
- 扫描：从根下一层开始，根与 `.anvil/` 不是对象；带 `.anvil.json` 的目录（任意层级）都索引（外部移动容错）；同一 `id` 出现在多目录 → 全部进 errors（不猜哪个真）；`parentId` 找不到 → `parent-missing`；`primary/related` 词表缺失 → `tag-missing`（对象保留）；坏 meta → `meta-invalid`；对象目录是链接 → `symlink`；其它读错 → `scan`。错误只影响对应对象，扫描继续。
- `effectiveArchived`：父 contest 归档 → 子 problem 隐式归档；列表默认剔除，`?archived=1` 才给；**计数永远剔除**（§7.3）。
- 未登记只认 §8.3 四类位置；对象内部的子目录是附件，不报未登记。
- 文件列表：跳过忽略项与子对象目录、相对对象目录的 POSIX 路径、size、mtime（epoch 秒）、ext、按路径升序；**`fileCount` 记真实总数**，列表最多 500 条 + `filesTruncated`。
- 生命周期按 §6：
  - `create`：先分配路径（冲突要查**磁盘已存在目录**，含未登记）→ 建目录 → 写 meta；meta 失败只删**本次新建且仍为空**的目录。`note` 写 `note.md`（`# <title>\n`）；`problem + templateId` 复制 `template.cpp`（没有则第一个 `.cpp`）为 `solution.cpp`、`test.cpp` 为 `test.cpp`，其它不复制；`title` 空且 `problemKey` 有值 → 查 `submissions.problem_name`（按 `problem_key` 取第一条非空），查不到用 key 本身。父对象必须存在、`kind=contest`、未归档、未在回收站。
  - `adopt`：最近祖先有对象时，仅「祖先 contest + 本次 problem」写 `parentId`，其余组合 400；不移动、不改名。
  - `update`：只认 `title / tags / labels / archived`；改标签时更新 `updatedAt`。
  - `trash/restore`：整目录移到 `.anvil/trash/<YYYYMMDD-HHmmss>_<id>/` + `trash.json`（§6.6）；恢复照 `originalRelPath`，目标被占 → `path-occupied`，父不存在 → `parent-missing`；`trash.json` 是用户可手改文件，**恢复前重新走根内路径校验**。v1 无硬删。
- `init`：幂等；建根（不存在时）/ `.anvil/`；写 `root.json`（schema 1）；`taxonomy.json` 不存在才写种子；保存根到 config；根已有内容且未初始化必须 `confirmExisting`（entries 按忽略规则计数）；`schema > 1` → `root-version`；**读取时绝不自动建目录**。
- `update` / `trash` / `restore` 的 `id` 只用来查索引；用户输入路径只出现在 `adopt.relPath`、`open.relPath`、`trash.json.originalRelPath`。

### 2.3 `open.ts`

- 目标解析后必须在**对象文件夹内**（不只是根内）；链接拒绝。
- 编辑器解析：先找 `Code.exe`（`where.exe Code.exe`）；没有则 `where.exe code`，若是 `…\bin\code.cmd` 推 `…\Code.exe` 再校验存在；Windows 上绝不 `shell:true`。
- `explorer.exe`：文件夹直接传路径；文件用 `/select,<path>`。explorer 常回退出码 1，**别把退出码当失败**，按能否 spawn 判。
- 顺序 `code` → explorer；都不可用 → 502 `editor-unavailable`。测试注入 spawn/解析器，不启真编辑器。

### 2.4 `routes.ts` + `api.ts` / `index.ts`

- `ApiContext`（`api.ts:29`）加 `work: WorkService`；`registerApi` 里调 `registerWorkRoutes(app, ctx.work)`（或直接在 api.ts 注册）。
- 路由照 §9.2；错误 → 状态码：`workspace-unconfigured` 409、`workspace-uninitialized` 409、`root-invalid` 400、`root-missing` 409、`root-not-empty` 409、`root-version` 409、`invalid` 400、`not-found` 404、`conflict` 409、`unsafe-path` 400、`path-occupied` 409、`parent-missing` 409、`editor-unavailable` 502、`internal` 500。统一 `{ error: { kind, message } }`。
- `GET /api/work/tree`：`?archived=0|1&rescan=0|1`；**首次访问自动建索引**。
- `index.ts:69` 构造 `WorkService` 注入 `db` 与 config 读写。**现有 `api.test.ts` 的 `boot()` 必须补 `work`**，否则 typecheck 挂。
- 成功 DTO 不带绝对路径；`root` 只给设置页展示。`/api/config` 现有语义不动（它只管 handle）；`saveWorkspaceRoot` 用 `{...loadConfig(), workspaceRoot}` 浅合并后 `writeFileAtomic`。

## 3. web（`packages/web/src/components/work/`）

- 新建 `Workbench.tsx / WorkList.tsx / WorkDetail.tsx / TagTree.tsx / WorkCreate.tsx`；`web/src/api.ts` 加 `getWorkTree / initWork / createWork / adoptWork / updateWork / trashWork / restoreWork / openWork / rescanWork`。
- 路由沿用 `#/master`：`App.tsx:365` 的 `LockedMaster` 分支换成 `<Workbench />`，删对应 import。
- 壳收口：`AppShell.tsx:79-87` 去掉 `navitem--locked`、`i-lock` 与「切片 5 · 未解锁」；`Dashboard.tsx:15` 删 `LockedMaster` 组件定义；`Dashboard.tsx:323` ColdStart 里那张卡删掉（连同 `grid-4` 包裹）。
- 状态机（§11）：未配置 / 未初始化 / 根不存在 → 同一块「设置根」面板（路径输入 + 初始化 + 风险说明；`root-not-empty` 时二次确认并把 entries 计数说清）；词表坏 → 标签编辑禁用但列表照常；空列表 / 未登记 / errors / 回收站 / `filesTruncated` / `tag-missing` 都要显式呈现。
- 三栏：
  - 左：kind 筛选（全部 / 比赛 / 题目 / 模板 / 笔记）+ 标签树（一级含子计数，`related` 不计）+ 回收站入口。
  - 中：搜索（标题 / labels / 标签名）+ 列表（标题、kind、日期、primary、文件数）+ 未登记区 + 错误区。
  - 右：详情（标题、relPath、标签编辑、自由标签、关联信息、文件列表、打开 / 归档 / 回收站）。
- **不做**：拖拽、文件内容预览、内置编辑器、编译运行、批量打标、多选、词表编辑 UI、git 操作、文件监视、CLion 启动、从榜单批量建题。
- 创建表单：kind + title；problem 可选 parent（contest 下拉）+ problemKey；template 可选 topId（一级词表下拉，缺省 `_unsorted`）；contest 的 `arenaPath` 可先不做 UI（API 支持即可，报告注明）；note 只建 `note.md`，不提供 Markdown 编辑器。
- 样式手写：复用 `styles.css` 现有 token / `.card` / `.btn` / `.input` / `.field` / `.alert`；1280 不破版；键盘可达；reduced-motion 无异常。新图标加 `index.html` sprite，别引图标库。
- API 错误照现有 `ApiError`（`web/src/api.ts:15`）：`kind` 用来分状态，`message` 给人看；失败不整屏白掉。

## 4. 测试（第一轮交付）

- 新增（文件名可微调，覆盖必须齐）：
  - `packages/shared/test/work.test.ts`：slugify 中文回退 / `CF2184F` / 保留名 / 结尾点空格 / 冲突 `-2` `-3` / 长度；meta 必备缺失、类型错、`schema=2`、未知字段保留、parent 非 contest、related 含 primary、labels 清洗；taxonomy 两级上限、重复/非法 ID、别名、悬空引用。
  - `packages/server/test/work-paths.test.ts`：路径安全（`..`、绝对路径、盘符、UNC、大小写、越界链接、`realpath` 逃逸）与根校验（盘符根 / Windows / Program Files / 仓内 / vault 内）。
  - `packages/server/test/work-store.test.ts`：临时根 fixture —— 四类对象、contest→problem 嵌套、未登记、坏 meta、忽略目录、junction 链接、文件列表 500 条截断、外部改名按 id 认回、删 `.anvil.json` 变未登记、trash/restore（占用与父缺失）、切换根。
  - `packages/server/test/work-api.test.ts`：Fastify inject —— 未配置/未初始化/非空根需确认；四类 create；adopt；update；rescan；trash/restore；open（注入 spawn：code 成功、code ENOENT 回退 explorer、两者失败 502）；路径越界拒绝。
- **现存 387 条一条不能少**；`npm test` 只增不减。

## 5. 第二轮自证（真机 + 截图）

1. 先备份 `vault/config.json`（不存在就记下）；截图用的受管根放系统 temp（如 `%TEMP%\anvil-5a-root`），**验证完恢复/删除**，别把 temp 路径留在用户配置里。
2. `npm run build` → `npm start`（记 PID）。用 headless Edge/Chromium + 独立 `--user-data-dir`（temp）+ CDP 驱动；**不要用 browser-use 取页面宽高**（本机 `innerWidth=0`）。窗口 1280×900，`--force-prefers-reduced-motion`。
3. 手测 §13.2 全 10 条，至少覆盖：四类各建一个；primary + related + label 计数正确（related 不计）；改标题目录不动；外部新建文件 rescan 可见；重启对象/标签/归档仍在；外部改名按 id 认回；删 `.anvil.json` → 未登记 → adopt；归档父比赛隐式隐藏子题；回收站/恢复与原路径占用 409；`../` / `C:\Windows` / 链接全拒。
4. 截图（`design/_shots/work-*.png`，6 张起）：设置根 / 列表 / 详情 / 标签树 / 未登记 / 回收站；1280 不破版；中文标题正常。旧截图别动。
5. 收工：关掉**自己起的**服务（PID 或窗口），temp 根与 profile 清掉，`git status` 干净。

## 6. 交付报告（`docs/reports/实现说明-工坊-代码管辖.md`，随分支提交）

1. 完成度对照表：契约 §1 / §3–§13 逐条（做没做、落在哪、证据）。
2. 测试：`npm run verify` 三项结果、`npm test` 新总数（基线 387）、新增用例清单。
3. 截图清单与对照说明。
4. 已知问题与偏差：契约歧义处的 `// TODO(切片5a)`、未做 UI 的 `arenaPath`、词表别名未进 `WorkTreeDto` 因而 v1 检索只覆盖标题/labels/节点名等，如实列。
5. 提交清单。

## 提交建议（分段）

① shared 纯函数 + schema/config + 单测 → ② server paths/store/open/routes + 单测 → ③ web 三栏 + 壳解锁 + 样式 → ④ 截图 + 报告。

每段一个 commit；别把全部塞一个提交。**不合并、不 push、不删分支。**
