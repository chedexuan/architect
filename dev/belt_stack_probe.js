// 叠带那面墙的量法：一台机器同一面能不能吃下两条贴隔壁的进料带 —— 这决定 3 种料以上的线能不能没有箱子。
//
// 玩家要的是"箱子一只不留"（2026-10-05 说死）。箱子一删，料和成品就只能靠带子的两半股分开，而蓝图这条路
// 只能带几何、带不了每只臂的设置（set_blueprint_entities 回读只有 entity_number/name/position，
// dev/lane_split_probe.js 末尾当场证过 pickup_from_left_lane 进不了蓝图）。于是剩下唯一能靠的规矩是几何。
//
// 本轮量到的几何（1-3 已经量到手，4 是这一版要证的）：
//
//   1. 一只臂只喂**一条**带行，且它在"伸到的那一格"取、也在同样距离那一格放。四相对照：
//      reach 1 的臂 + 落点 M0（距离 1）→ 送进 30 件铁板（近带的料）；
//      reach 2 的臂 + 落点 M0 与 M0+1 → 只往 M0+1（距离 2）送，M0 那只箱全程空；
//      近带铜线 / 远带铁板对调后，它照旧送"远带那种"（59 件铁板）→ 挑的是**距离**，不是物品。
//      所以"每面只有一条带"的旧假设错了，"每面能叠 R 条、一条臂够得着全部"也错了：
//      一个面能服务的带行数 = 这个安装里**互不相同的臂 reach 档数**（reach 1 一档、reach 2 一档）。
//   2. 于是混档臂（同一格里 reach 1 占一列、reach 2 占另一列）才是叠带的正确形状 —— 代价是每条带
//      自己那一档的臂，好处是 4 种料可以完全没有箱子。
//   3. 带行的距离不能超过机器的深度：机器从臂带往南占 fh 格，臂要在同样的距离里放下，
//      fh=3 时距离 1、2 都落在机器里 ✓；距离 3 需要 reach 3 的臂（香草没有，mod 可能有，从引擎量）。
//   4. 【这一版要证】同一台机器同一面两只混档臂，各自喂一条叠带，机器真造得出红板。
//      上一版这条"没成"是我的台架错了：相 E 只把落点箱放在距离 1，reach 2 的臂往距离 2 放，
//      料掉到空地上，读数看起来像"臂没干活"。"一只死臂和一条空带子长得一模一样"（lane_split 开头那句）。
//   5. 【这一版要证】成品带放在进料那一面会不会被进臂抓走喂机器 —— 决定"成品独占另一面"是引擎逼的
//      还是可以放宽。
//
// 量出来的 2.0 API 事实，都是花了一次失败换来的，写在这儿免得下一个人再花一次：
//   * 带子不能用脚本装料：belt.insert{name,count} 回 0 且不报错，两半股 get_item_count 全空 —— 静默空操作。
//     喂法只能是"源头箱 + 头部臂推上带子"（和 lane_split_probe 一样）。
//   * inserter 上没有 can_reach（LuaEntity doesn't contain key can_reach），所以"够不够得着"只能靠
//     真放东西、数它送出去什么来量。
//   * 默认 pickup_from_left_lane / pickup_from_right_lane 都是 true（当场读过）—— 半股不是可配置的隔离，
//     能靠的只有"哪一面的哪一格"这种几何。
//   * 组装机：`entity.recipe` 这个键不存在（读要 get_recipe()），没有 `queue`（读到就 raise，整块
//     chunk 当场报错、那一相什么都没量到），写配方是 set_recipe(名字) —— **第二个参数是 by_product**，
//     传 true 会静默设不上配方，机器空转，看着像"臂喂不进去"。三条都是本轮各花一次失败换来的。
//
// 沿用 lane_split_probe 开头那几个坑：位置是格中心（按 prototype 尺寸算）、全局电网本身不发电（要另摆
// electric-energy-interface）、快进时钟饿死 RCON（1x 等、轮询）、/c 编译不过回"什么都没有"（数花括号，
// 别在 JS 模板字符串里写反引号）。台架在 arch-lab 的 7500 角（lane_split 用 7000、underground_pair 用 7300），
// 每相建之前先扫同一片地。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("belt_stack_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 200); }
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ask = (src, tries) => {
  let out = lua(src);
  for (let n = 1; n <= (tries || 5) && (!out.trim() || /PROBE-FAIL|TRUNCATED|no output/.test(out)); n++) {
    console.log(`  (服务器没回话，4 秒后再问一次 -- 第 ${n} 次)`);
    sleep(4000);
    out = lua(src);
  }
  return out;
};

const BX = 7500, BY = 7500;
// y 向南增大。机器 3 格高占 M0..M0+2，同一面的臂只能站 M0-1 那一格带；于是"距离 d 的那一行带"
// 就是 M0-1-d。d=1 是 NEAR、d=2 是 FAR。成品走另一面：臂带 M0+3，带行距离同样是 1、2。
const M0 = BY, ARMB = BY - 1, NEAR = BY - 2, FAR = BY - 3, RUN = 16;
let pass = 0, fail = 0, step = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 500)}`);
  ok ? pass++ : fail++;
};
// 每一步都印出来：玩家要的是出问题他能指到哪一步的逻辑。mod 那边同一套序号会写进 trace 日志。
const LOG = (what, detail) => {
  step++;
  console.log(`  [step ${step}] ${what}${detail
    ? " :: " + String(detail).replace(/\n/g, " ").slice(0, 460) : ""}`);
};

// 每次 /c 是独立的一块 chunk：上一块 local 出来的机器，下一块读不到。跨相的读数一律按格子找实体。
const PRELUDE = `
local s = game.surfaces["arch-lab"]
if not s then rcon.print("NO_LAB_SURFACE run dev/cycle.sh first") return end
local BX, BY, M0, ARMB, NEAR, FAR, RUN = ${BX}, ${BY}, ${M0}, ${ARMB}, ${NEAR}, ${FAR}, ${RUN}
local AREA = {{BX - 12, FAR - 6}, {BX + RUN + 8, M0 + 10}}
local function cell(name, cx, cy, dir)
  local p = prototypes.entity[name]
  local w, h = (p and p.tile_width) or 1, (p and p.tile_height) or 1
  return s.create_entity({name = name, position = {x = cx + w / 2, y = cy + h / 2},
    direction = dir or 0, force = "player", raise_built = true})
end
local function belt_at(cx, cy)
  return s.find_entities_filtered{name = "transport-belt",
    position = {x = cx + 0.5, y = cy + 0.5}, radius = 0.45, force = "player"}[1]
end
local function sweep()
  for _, e in ipairs(s.find_entities_filtered{type = "container", area = AREA}) do
    pcall(function() e.get_inventory(defines.inventory.chest).clear() end) end
  pcall(function() s.destroy_items({area = AREA, inset = 0}) end)
  local n = 0
  for _, e in ipairs(s.find_entities_filtered{area = AREA}) do e.destroy(); n = n + 1 end
  return n
end
local function remaining()
  local n = 0
  for _ in ipairs(s.find_entities_filtered{area = AREA}) do n = n + 1 end
  return n
end
local function row(cy, from, to)
  for i = (from or 0), (to or RUN - 1) do
    if not belt_at(BX + i, cy) then cell("transport-belt", BX + i, cy, defines.direction.east) end
  end
end
local function power()
  pcall(function() s.create_global_electric_network() end)
  cell("electric-energy-interface", BX + RUN + 3, M0, defines.direction.north)
end
-- 一条带子的头：西边一只源箱 + 一只快臂往东推。头部臂只能站在机器列以外的列 —— 这条也正是
-- "线头必须是裸带尾、玩家自己接总线"（heads = belt）的几何原因。
local function head(which, item, count)
  if which == "FAR" then
    local c = cell("steel-chest", BX - 2, FAR - 2, 0)
    local a = cell("fast-inserter", BX - 2, FAR - 1, defines.direction.north)
    if c then c.insert{name = item, count = count} end
    return tostring(c ~= nil) .. "," .. tostring(a ~= nil)
  else
    local c = cell("steel-chest", BX - 1, M0, 0)
    local a = cell("fast-inserter", BX - 1, ARMB, defines.direction.south)
    if c then c.insert{name = item, count = count} end
    return tostring(c ~= nil) .. "," .. tostring(a ~= nil)
  end
end
local function on_row(cy, item)
  if item == "" then return 0 end
  local total = 0
  for i = -2, RUN - 1 do
    local e = belt_at(BX + i, cy)
    if e then for lane = 1, 2 do
      local ok, line = pcall(function() return e.get_transport_line(lane) end)
      if ok and line then total = total + (line.get_item_count(item) or 0) end
    end end
  end
  return total
end
local function box_at(cx, cy)
  local e = s.find_entities_filtered{type = "container",
    position = {x = cx + 0.5, y = cy + 0.5}, radius = 0.45, force = "player"}[1]
  if not e then return "none" end
  local parts = {}
  for _, it in ipairs(e.get_inventory(defines.inventory.chest).get_contents()) do
    parts[#parts + 1] = it.name .. "=" .. it.count
  end
  table.sort(parts)
  return table.concat(parts, "+")
end
local function mstat(cx, cy)
  local e = s.find_entities_filtered{type = "assembling-machine",
    position = {x = cx + 1.5, y = cy + 1.5}, radius = 1.6, force = "player"}[1]
  if not e then return "no_machine" end
  -- 三条都是这轮量出来的 2.0 形状：读配方要用 get_recipe()（'entity.recipe' 这个键根本不存在，
  -- 用它只会让 pcall 把"读不到"说成"recipe=nil"，看着像没设上其实是我读错）；
  -- 写配方是 set_recipe(名字)，**第二个参数是 by_product**，传 true 会把配方设不上（第一版就这么空的）。
  local rn, held = "nil", "?"
  pcall(function()
    local r = e.get_recipe()
    rn = r and r.name or "none"
  end)
  pcall(function()
    held = tostring(e.get_inventory(defines.inventory.assembling_machine_input).get_item_count())
  end)
  return "recipe=" .. tostring(rn) .. " in_hand=" .. tostring(held)
end
-- 落点箱按距离 1 与 2 各摆一只：上一版只摆距离 1，reach 2 的臂把料丢到空地上，读起来像"臂没干活"。
local function drops(col)
  local a = cell("steel-chest", col, M0, 0)
  local b = cell("steel-chest", col, M0 + 1, 0)
  return tostring(a ~= nil) .. "," .. tostring(b ~= nil)
end
local function read_drops(col)
  return "d1=" .. box_at(col, M0) .. " d2=" .. box_at(col, M0 + 1)
end
local function rig_two_rows(near_item, far_item, count)
  local n = sweep()
  power()
  row(FAR, -2, RUN - 1) row(NEAR, -1, RUN - 1)
  local hfar = far_item ~= "" and head("FAR", far_item, count) or "skip"
  local hnear = near_item ~= "" and head("NEAR", near_item, count) or "skip"
  return n, hfar, hnear
end
`;

// 反引号会提前结束上面这块 JS 模板字符串，而 `node --check` 抓不到：截断后剩下的 Lua 当 JS 读仍是合法
// 语法（BXBYM0ARMBNEARFARRUN.queue 那种"属性访问"要到运行时才炸）。所以按内容验一次 —— PRELUDE 必须
// 真的带上它最后一行那个 Lua 函数，没带上就是被截断了。本轮在这上面栽了两次。
if (!/local function rig_two_rows/.test(PRELUDE) || !/game\.surfaces/.test(PRELUDE)) {
  console.error("PRELUDE 被截断了：Lua 注释里不许出现反引号（见文件头那条教训）");
  process.exit(1);
}

// ---------------------------------------------------------------- 第 0 步：喂法可信吗
ask(PRELUDE + `
local n = rig_two_rows("iron-plate", "copper-cable", 200)
rcon.print("CAP swept=" .. n .. " game_tick=" .. tostring(game.tick))
game.tick_paused = false`);
let rows0 = "";
for (let i = 0; i < 4; i++) {
  sleep(5000);
  rows0 = ask(PRELUDE + `
rcon.print("ROWS near=" .. on_row(NEAR, "iron-plate") .. " far=" .. on_row(FAR, "copper-cable"))`);
}
LOG("第 0 步：源头箱 + 头部臂把料推上两条带子（20 秒后）", rows0);
const r0 = String(rows0).match(/near=(\d+) far=(\d+)/) || [, 0, 0];
check("台架能把料送上带子（近带和远带都有东西在走，否则每个空读数都是假的）",
  Number(r0[1]) > 0 && Number(r0[2]) > 0, rows0);

// ---------------------------------------------------------------- 相 A：一只臂喂几条带、往哪一格放
const oneArm = (label, arm, nearItem, farItem, rounds) => {
  const built = ask(PRELUDE + `
local n, hfar, hnear = rig_two_rows("${nearItem}", "${farItem}", 200)
local dr = drops(BX + 6)
local a = cell("${arm}", BX + 6, ARMB, defines.direction.north)
if not a then rcon.print("ARM_REFUSED ${arm}") return end
rcon.print("BUILT swept=" .. n .. " arm=${arm} near=${nearItem} far=${farItem} heads="
  .. hfar .. "/" .. hnear .. " drops=" .. dr)`);
  LOG(`${label}：建台架（臂站 M0-1，落点箱按距离 1、2 各一只）`, built);
  if (/ARM_REFUSED/.test(String(built))) { LOG(`${label}：${arm} 建不起来`); return { d1: new Set(), d2: new Set() }; }
  let last = "";
  for (let i = 0; i < rounds; i++) {
    sleep(5000);
    last = ask(PRELUDE + `
rcon.print("READ " .. read_drops(BX + 6) .. " onNear=" .. on_row(NEAR, "iron-plate")
  .. " onFar=" .. on_row(FAR, "copper-cable")
  .. " srcNear=" .. box_at(BX - 1, M0) .. " srcFar=" .. box_at(BX - 2, FAR - 2))`);
  }
  LOG(`${label}：${rounds * 5} 秒后`, last);
  const grab = (re) => {
    const m = String(last).match(re);
    return new Set(m ? m[1].split("+").filter((p) => p.includes("=")).map((p) => p.split("=")[0]) : []);
  };
  return { d1: grab(/d1=([^ ]+)/), d2: grab(/d2=([^ ]+)/), last, built };
};

// 对照与两个方向：reach 1 只能伸 1 格、reach 2 伸 2 格；料对调一次，证明它挑的是距离不是物品。
// 相 A/B 已经在 2026-10-06 量过并写成三条断言（见文件头第 1 条）；调试相 C/D 时用
// PROBE_SKIP_AB=1 跳过这两相，一次省两分钟。跳过时把上一次的读数当已知，不当"这次也这样"。
const SKIP_AB = process.env.PROBE_SKIP_AB === "1";
const A1 = SKIP_AB ? { d1: new Set(["iron-plate"]), d2: new Set() }
  : oneArm("相 A1：reach 1（普通臂），近带铁板 / 远带铜线", "inserter", "iron-plate", "copper-cable", 5);
const A2 = SKIP_AB ? { d1: new Set(), d2: new Set(["copper-cable"]) }
  : oneArm("相 A2：reach 2（长手），近带铁板 / 远带铜线", "long-handed-inserter", "iron-plate", "copper-cable", 5);
const B1 = SKIP_AB ? { d1: new Set(), d2: new Set(["iron-plate"]) }
  : oneArm("相 B：reach 2，料对调（近带铜线 / 远带铁板）", "long-handed-inserter", "copper-cable", "iron-plate", 5);
if (SKIP_AB) LOG("相 A/B 跳过（PROBE_SKIP_AB=1）：用 2026-10-06 量到的读数当已知",
  "reach1 送距离 1 的近带料 / reach2 送距离 2 的远带料 / 对调后跟距离不跟物品");

LOG("单臂的规律", JSON.stringify({
  reach1_d1: [...A1.d1], reach1_d2: [...A1.d2],
  reach2_d1: [...A2.d1], reach2_d2: [...A2.d2],
  swapped_d1: [...B1.d1], swapped_d2: [...B1.d2],
}));
if (!SKIP_AB) {
  check("reach 1 的臂只往距离 1 那一格放，送的是近带的料",
    A1.d1.has("iron-plate") && !A1.d2.has("copper-cable"), JSON.stringify([A1.d1, A1.d2]));
  check("reach 2 的臂只往距离 2 那一格放，送的是远带的料",
    A2.d2.has("copper-cable") && !A2.d1.has("iron-plate"), JSON.stringify([A2.d1, A2.d2]));
  check("...而它挑的是距离不是物品：料对调后它送的是另一种，仍然送到距离 2",
    B1.d2.has("iron-plate") && !B1.d1.has("copper-cable"), JSON.stringify([B1.d1, B1.d2]));
}

// ---------------------------------------------------------------- 相 C：一台机器同一面两只混档臂
//
// 这是整台架真正要的答案：一个面能服务 2 条进料带吗（reach 1 喂近带、reach 2 喂远带，各占机器 3 格里的一列）。
// 落点就是机器本身（占距离 1..fh），所以不存在上一版那种"箱子摆错距离"的伪证。
const builtC = ask(PRELUDE + `
local n, hfar, hnear = rig_two_rows("iron-plate", "copper-cable", 900)
row(M0 + 4, 0, RUN - 2)
local m = cell("assembling-machine-3", BX + 6, M0, 0)
if not m then rcon.print("NO_MACHINE") return end
pcall(function() m.set_recipe("electronic-circuit") end)
-- 两只进料臂用**不同档**：a1 是 reach 1（这里用 fast-inserter，因为要比的是"够不够得着"而不是"胳膊多快"），
-- a2 是 reach 2 的长手，它按量到的规矩只喂远带。
local a1 = cell("fast-inserter", BX + 6, ARMB, defines.direction.north)
local a2 = cell("long-handed-inserter", BX + 8, ARMB, defines.direction.north)
-- 出料这一段全用 reach 1：按刚量到的规矩，臂只往"距离 = 自己 reach"那一格放，而成品带铺在距离 1
-- （M0+4）。用长手的话它会往 M0+5 放，料掉空地上，读成"机器不出货"——那是台架的错，不是形状的错。
local oa = cell("inserter", BX + 7, M0 + 3, defines.direction.north)
local ca = cell("inserter", BX + RUN - 2, M0 + 5, defines.direction.north)
local sb = cell("steel-chest", BX + RUN - 2, M0 + 6, 0)
rcon.print("C swept=" .. n .. " heads=" .. hfar .. "/" .. hnear .. " " .. mstat(BX + 6, M0)
  .. " in_arms=" .. tostring(a1 ~= nil) .. "," .. tostring(a2 ~= nil)
  .. " out=" .. tostring(oa ~= nil) .. "," .. tostring(ca ~= nil) .. " sink=" .. tostring(sb ~= nil))`);
LOG("相 C：机器 + 同面两只混档臂（近带给 reach 1、远带给 reach 2），成品走另一面带到东头收箱", builtC);
let lastC = "";
for (let i = 0; i < 12; i++) {
  sleep(5000);
  lastC = ask(PRELUDE + `
rcon.print("CSTAT sink=" .. box_at(BX + RUN - 2, M0 + 6) .. " " .. mstat(BX + 6, M0)
  .. " onNear=" .. on_row(NEAR, "iron-plate") .. " onFar=" .. on_row(FAR, "copper-cable")
  .. " srcNear=" .. box_at(BX - 1, M0) .. " srcFar=" .. box_at(BX - 2, FAR - 2))`);
}
LOG("相 C：60 秒后（成品箱、机器、两条带各还剩多少）", lastC);
const sinkC = (String(lastC).match(/sink=([^ ]+)/) || [, ""])[1];
const MIXED_WORKS = /electronic-circuit/.test(String(sinkC));
check("相 C：一台机器同一面两只混档臂，两条叠带的料都进得去并且真造出红板（叠带成立）",
  MIXED_WORKS, JSON.stringify([sinkC, lastC, builtC]));
const srcC = String(lastC).match(/srcNear=(\S*) srcFar=(\S*)/);
LOG("相 C 的搬运量（源箱从 900 掉了多少 = 每种料真的在进机器）",
  srcC ? JSON.stringify({ near_chest: srcC[1], far_chest: srcC[2] }) : lastC);

// ---------------------------------------------------------------- 相 D：成品带放在进料那一面
//
// 混档成立之后这条才有意义：如果进料面上第 3 距离还能塞一条带（fh>3 或有 reach 3 的臂），成品和料同面
// 就会被进臂抓回机器。这里把"机器不吃的成品"摆在远带上，看机器还做不做东西、那条带会不会被抽干。
if (MIXED_WORKS) {
  const buildD = (farItem) => ask(PRELUDE + `
local n, hfar, hnear = rig_two_rows("iron-plate", "${farItem}", 900)
row(M0 + 4, 0, RUN - 2)
local m = cell("assembling-machine-3", BX + 6, M0, 0)
pcall(function() m.set_recipe("iron-gear-wheel") end)
local a1 = cell("inserter", BX + 6, ARMB, defines.direction.north)
-- 两相用同一对臂（近带给 reach 1、远带给 reach 2），唯一差别是远带上放的东西机器吃不吃。
-- 上一稿在这里换了臂档，于是"产出差"分不清是齿轮害的还是臂害的 —— 那正会把结论读反。
local a2 = cell("long-handed-inserter", BX + 8, ARMB, defines.direction.north)
cell("inserter", BX + 7, M0 + 3, defines.direction.north)
cell("inserter", BX + RUN - 2, M0 + 5, defines.direction.north)
cell("steel-chest", BX + RUN - 2, M0 + 6, 0)
rcon.print("D far=${farItem} heads=" .. hfar .. "/" .. hnear .. " " .. mstat(BX + 6, M0)
  .. " arms=" .. tostring(a1 ~= nil) .. "," .. tostring(a2 ~= nil))`);
  // 机器的进料仓里堆着什么，是"进臂把外带上的东西抓进机器"的直接证据
  // （defines.inventory.assembling_machine_input 这个项目已经在用，是有的）。
  const readD = (farItem) => ask(PRELUDE + `
local held = "n/a"
pcall(function()
  local e = s.find_entities_filtered{type = "assembling-machine",
    position = {x = ${BX + 7}, y = ${M0 + 1}}, radius = 1.6, force = "player"}[1]
  local inv = e.get_inventory(defines.inventory.assembling_machine_input)
  local parts = {}
  for _, it in ipairs(inv.get_contents()) do parts[#parts + 1] = it.name .. "=" .. it.count end
  table.sort(parts); held = table.concat(parts, "+")
end)
rcon.print("DSTAT sink=" .. box_at(BX + RUN - 2, M0 + 6) .. " onFar=" .. on_row(FAR, "${farItem}")
  .. " srcFar=" .. box_at(BX - 2, FAR - 2) .. " machine_holds=" .. held)`);
  const runD = (farItem, label) => {
    LOG(`${label}：建台架`, buildD(farItem));
    let last = "";
    for (let i = 0; i < 8; i++) { sleep(5000); last = readD(farItem); }
    LOG(`${label}：40 秒后`, last);
    return last;
  };
  const ctl = runD("", "相 D 对照：远带空着，只有近带进料");
  const haz = runD("iron-gear-wheel", "相 D 试验：远带走这台机器不吃的成品");
  const num = (str, re) => Number((String(str).match(re) || [0, 0])[1]);
  const CTL = num(ctl, /iron-gear-wheel=(\d+)/), HAZ = num(haz, /iron-gear-wheel=(\d+)/);
  // 被臂抓走的件数 = 从源箱推上远带的 - 还在远带上的。这才是"进臂会不会把外带的东西拖进机器"的直接读数；
  // 只看产出差分不清是齿轮害的还是臂饿的。
  const PUSHED = 900 - num(haz, /srcFar=iron-gear-wheel=(\d+)/);
  const ONFAR = num(haz, /onFar=(\d+)/);
  const STOLEN = PUSHED - ONFAR;
  LOG("相 D 读数：对照做出的齿轮 / 试验做出的齿轮 / 远带推上多少、还剩多少、差数=被臂抓走",
    JSON.stringify([CTL, HAZ, PUSHED, ONFAR, STOLEN]));
  check("相 D 的台架可信：对照组做出了东西",
    CTL > 0, JSON.stringify([ctl, haz]));
  LOG("相 D 抓料结论：" + (STOLEN > 0
    ? "远带上的成品被进臂抓走 " + STOLEN + " 件 —— 进料那一面不能出现机器不吃的东西，这条写进推导"
    : "没抓走（差数 " + STOLEN + "）：这条规矩不必硬写，可以放宽"));
  LOG("相 D 机器进料仓里堆着什么（出现成品=机器被塞了它不吃的）",
    (String(haz).match(/machine_holds=[^ ]+/) || ["n/a"])[0]);
} else {
  LOG("相 D 跳过：混档那对臂没让机器造出东西，先解决那个", "见相 C 的读数");
}

// ---------------------------------------------------------------- 收尾
const swept = ask(PRELUDE + `
for _, e in ipairs(s.find_entities_filtered{type = "container", area = AREA}) do
  pcall(function() e.get_inventory(defines.inventory.chest).clear() end) end
pcall(function() s.destroy_items({area = AREA, inset = 0}) end)
local gone = 0
for _, e in ipairs(s.find_entities_filtered{area = AREA}) do e.destroy(); gone = gone + 1 end
game.speed = 1
game.tick_paused = false
rcon.print("swept=" .. gone .. " left=" .. remaining())`);
check("台架收干净（不留电源、不留带子给下一套）", /left=0/.test(String(swept)), swept);

console.log(`\n== 这台架量到的答案 ==`);
console.log(`  一只臂喂几条带：1 条，取和放都在"伸到的那一格"（reach 1 → 距离 1；reach 2 → 距离 2）`);
console.log(`  一个面能服务的进料带条数：${MIXED_WORKS ? "2（混档臂：reach 1 一条 + reach 2 一条）" : "还没证成（见相 C）"}`);
console.log(`  无箱线一台机器能吃几种料：${MIXED_WORKS ? "4 股 = 4 种（每带 2 半股）" : "待量"}`);
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
