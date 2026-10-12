#!/usr/bin/env bash
# 手动 kill 掉一把套件之后的收尾：停作业 → 拆台 → 报台架状态。
#
# 为什么要这么一把独立脚本（0.94.0，2026-10-12，用 kill 亲测出来的）：套件挂在 `suite-guard.js` 的
# `onExit` 钩子上**并不能兜住手动 kill** —— 套件几乎所有时间都卡在 `execFileSync` 那条同步 RCON 往返里，
# 同步调用期间事件循环不转，JS 的信号处理器跑不到。那一段时间里被 SIGTERM 打死，世界就留在
# `game.speed = 20` 与台上一堆残件（`bench_check` 会各报一条红），下一趟读回来的 0/分是仪器不是功能。
#
#   bash dev/test.sh bash dev/after_kill.sh
#
# 只作用在环境已经指向的那台实例上（`dev/test.sh` 把 RCON 指到 27016）；不带前缀跑就等于在动 27015。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

node dev/call.js lab_stop '{}' 2>&1 | head -2
node dev/call.js lab_reset '{}' 2>&1 | head -2
# 时钟只在这一步自己确认一次：残件由 `lab_reset` 拆，倍速由作业自己带进来、也该由它带回去。
node dev/lua.js 'if game.speed ~= 1 then game.speed = 1 end
if game.tick_paused then game.tick_paused = false end
rcon.print("clock speed=" .. tostring(game.speed) .. " paused=" .. tostring(game.tick_paused))' 2>&1 | tail -1
node dev/bench_check.js
