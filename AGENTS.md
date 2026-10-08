# 这个仓库里跟用户打交道的方式

## 用户用手机操作 CLI（2026-10-01 明确说过）

- **不要发选项题**（AskUserQuestion、"选 A 还是 B" 那一类）。他手机上点不了，流程就死在那儿。
- 遇到分叉：自己选一个最合理的，在回复里写清**为什么这么选**，并留一句可逆路径（"要换回来只要……"）。
- 真的必须他确认的事，用普通文字问一句，别发工具化的选择题。
- 不可逆的操作（删存档数据、force push、动 27015 那台他连客户端的服务器）仍然要先说清楚再做。

## 两个 Factorio 实例（别搞混）

- 项目这套（`mods/` + `.factorio-data` 27015 / `.factorio-test` 27016）是开发与测试用的，实验一律加
  `bash dev/test.sh` 前缀。
- `/home/admin/factorioFile/` 是他自己玩的那一套（`mods/` 里有 helmod 2.2.13 + mineore，存档是
  k2Common0306 / spaceAgeSD0524 等）。2026-10-01 起 helmod 也拷进了项目的 `mods/`，这样开发实例能
  直接和它通话（`remote.call("helmod_interface", ...)`）并跑门禁。

## 开发期不要开着 27015（2026-10-08 定）

这台机一共 1.9G 内存，两个 Factorio 服务一起吃内存。**正常开发阶段他不需要连服务器**，所以 27015 默认
**关着**，只跑 27016：

- 他要说"我要亲手测"时才起：`bash dev/server.sh`；测完关掉：`bash dev/stop.sh`。
- ⚠ `dev/stop.sh` 是 `kill -9`，**不写档**：关掉之前先想清楚他有没有连着在玩（回滚到上一次自动存档）。
- ⚠ 漏了 `bash dev/test.sh` 前缀的 `dev/cycle.sh` / `dev/stop.sh` 直接作用在 27015 上（2026-10-08 就这么
  把他那台重启过一次）。`dev/one-server.sh` 还规定同时只跑一个服务：起测试实例会把 27015 停掉。

## 别每改一次就跑全量门禁（2026-10-08 定）

功能还不多、也不复杂，全量一趟约 25 分钟，攒在最后一趟集中测更划算：

- 日常只走秒级静态门：`bash dev/test.sh bash dev/cycle.sh`（lint、Lua 模板、locale、gui_api、重打包、
  重启 27016）。
- 真需要信号时点名跑一两套：`bash dev/test.sh bash dev/quick.sh`（按 git 改动推套件）或
  `bash dev/test.sh node dev/layout_ledger.js` 这种单套。
- **提交不等全量**：改完就提交；等一批功能都落地后再跑一次 `dev/regress.sh` 集中调整。
- **全量只在他说"跑全量/测一下/交出去"时才跑**（2026-10-08 又明确过一次："以后尽量不跑全量测试"）。
  版本号变了**不是**理由 —— 收口靠点名跑的那几套，不靠一趟 25 分钟的 `regress.sh`。
