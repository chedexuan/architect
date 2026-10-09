// 总线那一圈**落地**的那一路：控制带画在卡上（`layout_ledger` 钉的是几何），这里钉的是两件只有引擎
// 能回答的事 —— 配置写没写进件里，线带没带得出去。
//
// 为什么这一套必须存在：0.61.0 那一刀删掉了这一圈连同它的两套门禁（`bus_line_e2e`、
// `shortage_line_e2e`），剩下的答案只能说 `laid_controllers = 0`。今天它铺得出去了，而"铺得出去"在这台
// 2.0 上有三种完全不同的结局，一种都不能靠注释假定：
//
//   * 虚影那一扇：`cb.parameters` 与 `cb.circuit_set_recipe` 都吃得、都读得回来（量的），所以地上的
//     那一页每件都配置好了 —— 但**线连不了**：`circuit_connect`、`open_ground_connection` 在这台构建上
//     根本不存在，虚影本来也不在电路网络里。所以那一扇交出来的是"配置齐了、线要你自己拉"。
//   * 蓝图那一扇：线带得住（record 上的 `wires` 是四元组的表，导出的 JSON 根上就是它），组合器的配置
//     也带得住，但**字段名与 Lua 那一路不一样**：判定盒要包进 `decider_conditions`、算术盒要包进
//     `arithmetic_conditions`，选择器反倒要平铺。
//   * 唯一确定带不住的是机器那一格「从电路网络读配方」：七种拼法实测全部回读为空。所以粘出去的一页
//     每台机器要自己勾一次 —— 这一句必须由答案自己说，而不是等玩家粘完发现机器都不动。
//
// 这里不信任何一格自报数：蓝图文本**重新导入一次**，由引擎回读件表；虚影那一路直接扫那一块地，读
// 每个 `entity-ghost` 身上的 control behaviour。科技（`advanced-combinators`）按老规矩借、用完还。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("bus_ring_e2e");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27015",
  RCON_PW: process.env.RCON_PW || "m0pw" };
const call = (method, args) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), method,
      JSON.stringify(args || {})], { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) {
    return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 200) };
  }
};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 28 }).trim();
  } catch (e) { return "LUA_FAIL " + String(e.stdout || e.message).slice(0, 200); }
};
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 320)}`);
  ok ? pass++ : fail++;
};
const asArr = (v) => (Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : []));

const TECHS = ["advanced-combinators", "circuit-network", "automation", "logistics"];
const wasOn = {};
for (const t of TECHS) {
  wasOn[t] = /^true$/.test(lua(`local x = game.forces.player.technologies["${t}"]
    rcon.print(x and tostring(x.researched) or "absent")`));
}
const setTech = (on) => lua(`local f = game.forces.player
for _, t in ipairs{"${TECHS.join('","')}"} do
  local x = f.technologies[t]
  if x then x.researched = ${on ? "true" : "false"} end
end
local r = f.recipes["selector-combinator"]
if r then r.enabled = ${on ? "true" : "false"} end
rcon.print("sel=" .. tostring(${on ? "true" : "false"}))`);
check("借得到这一圈要的两件硬件（选择组合器与判定组合器）", /sel=true/.test(setTech(true)), setTech);

const BUS = ["iron-gear-wheel", "copper-cable"];
const PLAN = [{ name: "assembling-machine-1", count: 3, recipe: "electronic-circuit" }];
const ORIGIN = { x: 900, y: 900 };

// ---------------------------------------------------------------- 地那一扇门
const ground = call("helmod_ghosts", { into: "ground", surface: "nauvis", origin: ORIGIN,
  heads: "belt", style: "stacked", plan: PLAN, bus: BUS, force: "player" });
const gd = ground.data || {};
check("压到地上这一页：控制带写进了虚影身上，写的件数与要写的件数是同一个数",
  ground.ok === true && (gd.circuits || {}).asked >= 4
    && gd.circuits.written === gd.circuits.asked && !gd.circuits.problem,
  JSON.stringify([ground.code, ground.msg, gd.circuits]).slice(0, 300));
// 引擎自己那一侧的读数：扫那一块地，按 ghost 名字分堆，把 `parameters` 念回来。
const area = `{{${ORIGIN.x - 2},${ORIGIN.y - 2}},{${ORIGIN.x + 40},${ORIGIN.y + 40}}}`;
const readGhosts = lua(`local s = game.surfaces["nauvis"]
local sel, dec, asm, rand = {}, 0, 0, 0
local outs = 0
for _, g in ipairs(s.find_entities_filtered { area = ${area}, type = "entity-ghost" }) do
  local nm = g.ghost_name or ""
  local ok, cb = pcall(function() return g.get_or_create_control_behavior() end)
  if ok and cb then
    local p
    pcall(function() p = cb.parameters end)
    if nm == "selector-combinator" then
      if p and p.operation == "random" then rand = rand + 1 end
      sel[#sel + 1] = tostring(p and p.index_constant) .. "/" .. tostring(p and p.select_max)
    elseif nm == "decider-combinator" then
      dec = dec + 1
      -- 数的不是"有几行输出"而是"有几行输出是**配方**信号"：牌上那只盒子也带两行输出（那是股道清单，
      -- 料信号），拿行数当判据就会把两块牌算成总线盒。
      local n = 0
      pcall(function()
        if p and p.outputs then
          for _, row in pairs(p.outputs) do
            local sig = row and row.signal
            if sig and sig.type == "recipe" then n = n + 1 end
          end
        end
      end)
      if n >= ${BUS.length} then outs = outs + 1 end
    elseif nm == "assembling-machine-1" then
      local v; pcall(function() v = cb.circuit_set_recipe end)
      if v == true then asm = asm + 1 end
    end
  end
end
table.sort(sel)
rcon.print("sel[" .. table.concat(sel, ",") .. "] dec=" .. dec .. " bus_box=" .. outs
  .. " listening=" .. asm .. " random=" .. rand)`);
check("...读回来的是那一圈该有的样子：每位选择器一位号（0 起、升序），一只判定盒把整张清单发出去，每台机器都答应听话",
  /sel\[0\/false,1\/false,2\/false\]/.test(readGhosts)
    && /bus_box=1/.test(readGhosts) && /listening=3/.test(readGhosts),
  readGhosts);
check("...而这一扇门把自己的限界说出来：配置写好了，线要玩家自己拉",
  /circuit_connect/.test(String((gd.circuits || {}).wiring || "")),
  String((gd.circuits || {}).wiring || "").slice(0, 200));
const unGround = call("place_undo", { count: 1 });
check("一次撤回把这一整页带走（控制带也在账上）",
  unGround.ok === true && ((unGround.data || {}).removed || 0) >= 40,
  JSON.stringify([unGround.code, unGround.data]).slice(0, 220));

// rotate 那一档落在同一块地上：它写的不是位次而是间隔 —— 而间隔那个键名是量的。
const spun = call("helmod_ghosts", { into: "ground", surface: "nauvis", origin: ORIGIN,
  heads: "belt", style: "stacked", plan: PLAN, bus: BUS, bus_mode: "rotate", bus_every: 25,
  force: "player" });
const sd = spun.data || {};
const readSpin = lua(`local s = game.surfaces["nauvis"]
local n, iv = 0, "?"
for _, g in ipairs(s.find_entities_filtered { area = ${area}, type = "entity-ghost" }) do
  if (g.ghost_name or "") == "selector-combinator" then
    n = n + 1
    local ok, p = pcall(function() return g.get_or_create_control_behavior().parameters end)
    if ok and p and p.operation == "random" then iv = tostring(p.random_update_interval) end
  end
end
rcon.print("spin=" .. n .. " interval=" .. iv)`);
check("rotate 那一档：选择器换成随机模式，而间隔真的落进引擎那一格（`random_update_interval`，量到的键名）",
  spun.ok === true && /spin=3 interval=25/.test(readSpin), JSON.stringify([spun.code, readSpin]));
call("place_undo", { count: 1 });

// ---------------------------------------------------------------- 蓝图那一扇门
const bp = call("helmod_ghosts", { into: "string", surface: "nauvis", origin: ORIGIN,
  heads: "belt", style: "stacked", plan: PLAN, bus: BUS, force: "player" });
const bd = bp.data || {};
check("蓝图这一页：组合器配置带住了（asked 与引擎回读的 carried 同一个数），线也带住了",
  bp.ok === true && (bd.circuits || {}).asked >= 4 && bd.circuits.carried === bd.circuits.asked
    && (bd.wires || {}).asked >= 6 && bd.wires.carried === bd.wires.asked,
  JSON.stringify([bp.code, bp.msg, bd.circuits && { a: bd.circuits.asked, c: bd.circuits.carried },
    bd.wires]).slice(0, 300));
// 蓝图的文字自己核对一遍：`export_stack` 交出来的就是玩家要粘的那一份（base64 + zlib），解开它读的是
// 引擎写下的原件，而不是我们递给 `set_blueprint_entities` 的那一份。为什么不在 Lua 里读 record：
// `get_blueprint_entities` 把嵌套列表的**行**交回来是空表（实测：`decider_conditions` 在、`outputs` 有
// 1..N 行，行里的 `signal` 读不出），而平铺的选择器字段与根上的 `wires` 都读得出 —— 所以内容这一侧解
// 文本读，线在 Lua 里再数一遍（两头都对上才算数）。
const readBp = (() => {
  const text = String(bd.blueprint || "");
  if (!text) return { err: "no blueprint text" };
  try {
    const bp = JSON.parse(require("zlib").inflateSync(Buffer.from(text.slice(1), "base64")).toString("utf8")).blueprint || {};
    const ents = asArr(bp.entities);
    const rows = (cb) => asArr(cb && cb.decider_conditions && cb.decider_conditions.outputs);
    const busBox = ents.filter((e) => /decider/.test(e.name))
      .find((e) => rows(e.control_behavior).some((r) => r.signal && r.signal.type === "recipe"));
    return {
      ents: ents.length,
      wires: asArr(bp.wires).length,
      idx: ents.filter((e) => /selector/.test(e.name))
        .map((e) => (e.control_behavior || {}).index_constant).sort((a, b) => a - b),
      recipeSignals: rows(busBox && busBox.control_behavior)
        .filter((r) => r.signal && r.signal.type === "recipe")
        .map((r) => [r.signal.name, r.constant === undefined ? 1 : r.constant]),
      listening: ents.filter((e) => /assembling/.test(e.name))
        .filter((e) => (e.control_behavior || {}).circuit_set_recipe).length,
    };
  } catch (e) { return { err: String(e.message).slice(0, 140) }; }
})();
check("...蓝图的文字里：每位选择器带着自己的位次，判定盒把清单发在**配方**信号上（数就是位次）",
  !readBp.err && JSON.stringify(readBp.idx) === "[0,1,2]"
    && JSON.stringify(readBp.recipeSignals) === JSON.stringify([["iron-gear-wheel", 1], ["copper-cable", 2]]),
  String(JSON.stringify([readBp.err, readBp.idx, readBp.recipeSignals])).slice(0, 300));
// Lua 那一侧重导一次同一份文字，数引擎留下的线：玩家粘的是文本，而这条判据读的是引擎解析之后的件表。
const reImport = lua(`local inv = game.create_inventory(1)
inv.insert { name = "blueprint", count = 1 }
local st = inv[1]
local ok, err = pcall(function() return st.import_stack([[${String(bd.blueprint || "")}]]) end)
if not ok then inv.destroy() rcon.print("IMPORT-RAISES " .. tostring(err):sub(1, 120)) return end
local back = st.get_blueprint_entities() or {}
local seen, lines = {}, 0
for _, e in ipairs(back) do
  for _, w in ipairs(e.wires or {}) do
    local fwd = table.concat(w, "-")
    local rev = table.concat({ w[3], w[4], w[1], w[2] }, "-")
    if not seen[fwd] and not seen[rev] then seen[fwd] = true lines = lines + 1 end
  end
end
rcon.print("lines=" .. lines .. " ents=" .. #back)
inv.destroy()`);
const mLines = /lines=(\d+)/.exec(String(reImport));
check("...而线也在：把那份文字重导进引擎，去重数出来的条数与答案自报 `wires.carried` 一样",
  !!mLines && Number(mLines[1]) === (bd.wires || {}).carried && Number(mLines[1]) >= 6,
  String(JSON.stringify([reImport, bd.wires])).slice(0, 240));
check("...而机器那一格「从电路网络读配方」由答案自己说带不住（asked>0、carried=0，且给了为什么）",
  ((bd.circuits || {}).recipe_control || {}).asked === 3
    && bd.circuits.recipe_control.carried === 0
    && /circuit/i.test(String(bd.circuits.recipe_control.why))
    && readBp.listening === 0,
  String(JSON.stringify([bd.circuits, readBp.listening, readBp.err])).slice(0, 260));

// ---------------------------------------------------------------- 整计划那一按也带着这一圈走
// `helmod_blueprints` 是 `M.helmod_ghosts` 的循环，所以它过去不转 `bus` 那四个参数（0.83.0 补上），
// 而它的逐页答案也不报"这一页的组合器带住了几件"—— 一叠蓝图里某一页粘完不动，玩家只有一行行看才找得到。
const PAGE_FIXTURE = { model_9: { class: "Model", id: "model_9",
  block_root: {
    class: "Block", name: "gear and cable",
    children: { R1: { class: "Recipe", name: "electronic-circuit", count: 4,
      factory: { name: "assembling-machine-1", amount: 1, count: 4 } } },
    summary_global: { factories: { a: { name: "assembling-machine-1", type: "entity", count: 4 } } },
  } } };
const allPlan = call("helmod_blueprints", { force: "player", into: "string",
  models: PAGE_FIXTURE, bus: BUS, bus_mode: "split" });
const ap = allPlan.data || {};
const apPage = asArr(ap.blueprints)[0] || {};
check("整计划那一按把总线转到那一页的线卡上了：这一页有自己的控制带，配置与线都带得住",
  allPlan.ok === true && ap.count === 1 && (apPage.circuits || {}).asked >= 2
    && apPage.circuits.carried === apPage.circuits.asked
    && (apPage.wires || {}).asked >= 4 && apPage.wires.carried === apPage.wires.asked,
  String(JSON.stringify([allPlan.code, allPlan.msg, { c: apPage.circuits, w: apPage.wires }]))
    .slice(0, 300));
const allPlain = call("helmod_blueprints", { force: "player", into: "string", models: PAGE_FIXTURE });
const apPlain = asArr((allPlain.data || {}).blueprints)[0] || {};
// 没点总线的一页**不是**"一个组合器都没配置"：0.80.0 起线头那两块牌的盒子也真的被写了（从前只是站着）。
// 所以这里钉的是相对的那件事 —— 点了总线那一页比没点的多出**每台一只选择器 + 一只总线盒**的配置与线。
check("...而总线那一圈是加上去的：同一页点总线比不点，多出来的配置数与线数都在台数量级上",
  allPlain.ok === true && (apPlain.circuits || {}).asked >= 1
    && (apPage.circuits || {}).asked > apPlain.circuits.asked
    && (apPage.wires || {}).asked > (apPlain.wires || {}).asked,
  String(JSON.stringify([allPlain.code, { c: apPlain.circuits, w: apPlain.wires },
    { C: apPage.circuits, W: apPage.wires }])).slice(0, 300));

// ---------------------------------------------------------------- 「让这批机器听线」那一按
// 蓝图带不住机器那一格（上面刚钉过 carried=0），所以修法是做一颗按完之后按的按钮。这一节量的是
// 它真的动了**已建成的**机器，而不是只回了一句漂亮话 —— 注意这里不能拿虚影测：
// `silent_revive` / `revive()` 在脚本造的虚影上都"成功"但什么都不建（本轮实测：调完周围仍然是
// `entity-ghost`），所以"建完之后"这一步只能是玩家那一下，门禁直接摆真机器。
const LX = 1500, LY = 1500;
const builtMachines = lua(`local s = game.surfaces["nauvis"]
for _, e in ipairs(s.find_entities_filtered { area = { { ${LX - 2}, ${LY - 2 } }, { ${LX + 40}, ${LY + 40 } } } }) do e.destroy() end
local a = s.create_entity { name = "assembling-machine-1", position = { x = ${LX + 2.5}, y = ${LY + 2.5} }, force = "player" }
local b = s.create_entity { name = "assembling-machine-1", position = { x = ${LX + 8.5}, y = ${LY + 2.5} }, force = "player" }
local c = s.create_entity { name = "assembling-machine-3", position = { x = ${LX + 14.5}, y = ${LY + 2.5} }, force = "player" }
local f = s.create_entity { name = "stone-furnace", position = { x = ${LX + 2.5}, y = ${LY + 8.5} }, force = "player" }
local g2 = s.create_entity { name = "entity-ghost", inner_name = "assembling-machine-1",
  position = { x = ${LX + 20.5}, y = ${LY + 2.5} }, force = "player" }
if a then a.get_or_create_control_behavior().circuit_set_recipe = true end
rcon.print("built=" .. tostring(a ~= nil and b ~= nil and c ~= nil) .. " ghost=" .. tostring(g2 ~= nil))`);
const LAREA = { x1: LX, y1: LY, x2: LX + 30, y2: LY + 20 };
check("地上摆好三台真机器（一台已经开着）、一只熔炉、一只虚影", /built=true ghost=true/.test(builtMachines), builtMachines);
const listen1 = call("machine_recipe_control", { surface: "nauvis", force: "player", area: LAREA });
const ld = listen1.data || {};
check("按一次：开着的那台算 already、没开着的才动，熔炉不混进失败里而是单列（它压根没有这一格）",
  listen1.ok === true && ld.machines === 3 && ld.already === 1 && ld.set === 2 && !ld.failed
    && asArr(ld.not_settable).some((u) => u.name === "stone-furnace")
    && ld.ghosts === 1,
  String(JSON.stringify([listen1.code, listen1.msg, { m: ld.machines, s: ld.set, a: ld.already,
    f: ld.failed, ns: ld.not_settable, g: ld.ghosts }])).slice(0, 300));
const readBack = lua(`local s = game.surfaces["nauvis"]
local on, tot = 0, 0
for _, e in ipairs(s.find_entities_filtered { area = { { ${LX}, ${LY} }, { ${LX + 30}, ${LY + 20} } },
  type = "assembling-machine" }) do
  tot = tot + 1
  local ok, v = pcall(function() return e.get_or_create_control_behavior().circuit_set_recipe end)
  if ok and v == true then on = on + 1 end
end
rcon.print("asm=" .. tot .. " listening=" .. on)`);
check("...而引擎那边读回来是真的：三台组装机全都从电路读配方", /asm=3 listening=3/.test(readBack), readBack);
const listen2 = call("machine_recipe_control", { surface: "nauvis", force: "player", area: LAREA });
const l2 = listen2.data || {};
check("再按一次不动手（幂等：全进 already，一个都不再写）",
  listen2.ok === true && l2.already === 3 && (l2.set || 0) === 0,
  String(JSON.stringify([l2.machines, l2.set, l2.already])));
const listenOff = call("machine_recipe_control", { surface: "nauvis", force: "player", area: LAREA,
  off: true });
const readOff = lua(`local s = game.surfaces["nauvis"]
local off = 0
for _, e in ipairs(s.find_entities_filtered { area = { { ${LX}, ${LY} }, { ${LX + 30}, ${LY + 20} } },
  type = "assembling-machine" }) do
  local ok, v = pcall(function() return e.get_or_create_control_behavior().circuit_set_recipe end)
  if ok and v == false then off = off + 1 end
end
rcon.print("off=" .. off)`);
check("同一只手也能关（off = true 写 false 并读回来），因为取消听线在 2.0 也是这一格",
  listenOff.ok === true && listenOff.data.want === "off" && /off=3/.test(readOff),
  String(JSON.stringify([listenOff.data && listenOff.data.want, readOff])));
const listenEmpty = call("machine_recipe_control", { surface: "nauvis", force: "player",
  area: { x1: LX + 300, y1: LY + 300, x2: LX + 320, y2: LY + 320 } });
check("空的那片地按名拒，不把「零台机器」说成成功",
  listenEmpty.ok === false && listenEmpty.code === "NO_MACHINES_HERE",
  String(JSON.stringify([listenEmpty.code, listenEmpty.msg])));
lua(`local s = game.surfaces["nauvis"]
local n = 0
for _, e in ipairs(s.find_entities_filtered { area = { { ${LX - 2}, ${LY - 2 } }, { ${LX + 40}, ${LY + 40 } } } }) do
  e.destroy(); n = n + 1 end
rcon.print("cleaned=" .. n)`);

// 一条不吃总线的线，必须一件组合器都不带：否则"铺了控制带"这句话就没代价了。
const plain = call("card_example", { recipe: "electronic-circuit", machines: 3, force: "player",
  style: "stacked", heads: "belt" });
check("没点总线的线仍然一件控制器都不铺",
  plain.ok === true && asArr((plain.data || {}).entities).every((e) => e.role !== "control"
    && e.role !== "bus") && (plain.data || {}).bus === undefined,
  JSON.stringify(asArr((plain.data || {}).entities).filter((e) => e.role === "control")).slice(0, 160));

// `dev/lint.py` 的模板检查器把手里的 `${...}` 换成一个数，所以这里先把那张"本来就开着"的表在 JS 里拼好，
// 模板里只留一次插值 —— 嵌套的 `${}` 它读不动，读不动的表现形式是整个套件不按 Lua 算。
const keepTable = Object.keys(wasOn).map((k) => `[${JSON.stringify(k)}]=true`).join(",");
const restore = lua(`local f = game.forces.player
for _, t in ipairs{"${TECHS.join('","')}"} do
  local x = f.technologies[t]
  if x and not ({${keepTable}})[t] then x.researched = false end
end
rcon.print("restored")`);
check("科技照原样还（这一台本来就有的那几格留着）", /restored/.test(restore), restore);
const leftover = call("place_undo", { count: 1 });
const lo = leftover.data || {};
// 撤到"站着 0 件"就是干净的；栈里剩下的条目可能指向早已被建掉/拆掉的虚影，那要如实数成
// `already_gone` 而不是假装成功。真正不许出现的是 `standing_now > 0`（我们的东西还立在别人读得到的地上）。
check("地上不留半个：这一套按完之后站着的是 0 件，撤回把手上的记录也交出来了",
  (lo.standing_now || 0) === 0
    || (leftover.ok === false && leftover.code === "NOTHING_TO_UNDO"),
  String(JSON.stringify([leftover.ok, leftover.code,
    { u: lo.undone, r: lo.removed, gone: lo.already_gone, now: lo.standing_now, rest: lo.remaining }]))
    .slice(0, 220));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
