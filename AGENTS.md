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
