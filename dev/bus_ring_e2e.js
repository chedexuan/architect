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
check("地上不留半个：三按撤完之后栈是空的，而它**按名说**没东西可撤（不是悄悄回成功）",
  leftover.ok === false && leftover.code === "NOTHING_TO_UNDO",
  String(JSON.stringify(leftover.ok ? leftover.data : [leftover.code, leftover.data])).slice(0, 200));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
