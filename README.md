# ANVIL（铁砧）

个人 ICPC 训练工作台 · 本地 Web 应用：把 Codeforces / AtCoder 的训练数据、XCPC 选手档案与赛事回放榜收进一块本地仪表盘。数据只在本机，不出门。

## 四个模块

- **个人数据** —— CF / AT / XCPC 三源读数：热力图、rating 曲线、XCPC 档案长卷。
- **工坊** —— 未解锁（下一片）。
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

`start.bat` / `stop.bat` 是双击便捷入口（start 会自动构建并在独立窗口起服务、遇端口占用弹三选一）。注意：Windows 资源管理器双击 `.bat` 可能弹「无法验证发布者」提示——那是 Explorer 的外壳检查，与脚本无关（同一文件在命令行里运行不会弹），可忽略或直接用上面的命令行方式。

`vault/` 是你的本地数据目录（库、配置、榜单缓存），**不入库**；换机器时把它一并拷走即可。

## 数据来源与许可

- **Codeforces** —— 官方 API（codeforces.com/api）。
- **AtCoder** —— 官方参赛史（atcoder.jp）+ AtCoder Problems 社区数据（kenkoooo.com）。
- **XCPC** —— heimaom.cn 静态导出（xcpcrating 社区快照，非官方）。
- **赛事榜单快照** —— [algoux/srk-collection](https://github.com/algoux/srk-collection)（AGPL-3.0）：**仅在运行时拉取、不打包其代码或数据**，界面与页脚已署名。

免责：个人自用的本地工具，只监听 127.0.0.1；上游数据的准确性以生成方为准。

## 文档

- `docs/16-模拟榜单规格.md` —— 当前已交付的最新契约（切片 4），从它读起。
- `docs/04` / `docs/09` / `docs/14` —— 切片 1–3 契约（骨架 / AT / XCPC）。
- `docs/03-数据源可行性.md` —— 外部接口实测细节。
- `docs/02-设计讨论记录.md` —— 设计决策背景（选读）。
- `docs/00`–`docs/19` —— 完整的设计与实现过程文档。