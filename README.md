# ANVIL（铁砧）

个人 ICPC 训练工作台 · 本地 Web 应用：把 Codeforces / AtCoder 的训练数据、XCPC 选手档案与赛事回放榜收进一块本地仪表盘。数据只在本机，不出门。

## 四个模块

- **个人数据** —— CF / AT / XCPC 三源读数：热力图、rating 曲线、XCPC 档案长卷。
- **工坊** —— 受管工作区：比赛 / 题目 / 模板 / 笔记四类对象 + 两级标签 + VP 成绩存档；旧代码批量导入后置。
- **模拟榜单** —— 按官方快照重建赛事目录与逐秒回放榜：计时 / 封榜定格 / 终局解封 / 回顾时间轴。
- **设置** —— handle 校验与保存、单源同步、XCPC 认领。

## 快速开始

1. Node ≥ 24（需要内置 `node:sqlite`）。
2. `npm install`
3. 启动（**命令行为主入口**）：
   - 开发：`npm run dev`（vite 5173 + 服务 7788，前端热更新）
   - 正式：`npm run build` 后 `npm start`（只起 7788 服务构建产物），浏览器打开 http://localhost:7788
   - 首次运行会读 `vault.example/` 初始化 `vault/`。
4. 端口 7788（`ANVIL_PORT` 可覆写）。

`start.bat` / `stop.bat` 是双击便捷入口（start 会自动构建并在独立窗口起服务、遇端口占用弹三选一；stop 先认 `vault/server.pid`，端口与 PID 不一致时会先确认）。注意：Windows 资源管理器双击 `.bat` 可能弹「无法验证发布者」提示——那是 Explorer 的外壳检查，与脚本无关（同一文件在命令行里运行不会弹），可忽略或直接用上面的命令行方式。

`vault/` 是你的本地数据目录（库、配置、榜单缓存），**不入库**；换机器时把它一并拷走即可。

## 数据来源与许可

- **Codeforces** —— 官方 API（codeforces.com/api）。
- **AtCoder** —— 官方参赛史（atcoder.jp）+ AtCoder Problems 社区数据（kenkoooo.com）。
- **XCPC** —— heimaom.cn 静态导出（xcpcrating 社区快照，非官方）。
- **赛事榜单快照** —— [algoux/srk-collection](https://github.com/algoux/srk-collection)（AGPL-3.0）：**仅在运行时拉取、不打包其代码或数据**，界面与页脚已署名。

免责：个人自用的本地工具，只监听 127.0.0.1；上游数据的准确性以生成方为准。

## 文档

- `docs/README.md` —— **文档总索引**：现行契约、历史提示词、交付报告、归档各在哪。
- `docs/contracts/23-工坊-代码管辖契约.md` —— 切片 5a 契约（受管工作区 / 四类对象 / 两级标签；已交付 main）。
- `docs/contracts/20-榜单增强规格.md` —— 最新已交付契约（榜单增强 v8：预拉取 + 「我的成绩」逐发录入）。
- `docs/contracts/16-模拟榜单规格.md` —— 切片 4「模拟榜单」基础契约，从它读起；srk 数据源与许可证纪律仍以它 §2 为准。
- `docs/contracts/04` / `docs/contracts/09` / `docs/contracts/14` —— 切片 1–3 契约（骨架 / AT / XCPC）。
- `docs/reference/03-数据源可行性.md` —— 外部接口实测细节。
- `docs/reports/` —— 各批次交付报告与历史审计；`docs/archive/02-设计讨论记录.md` —— 设计决策背景（选读）。