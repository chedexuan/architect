// 【这一把的状态（2026-10-11 夜）】#28 已经结案，真因不在"气 vs 水"也不在台架灌量，而在**牌把液体分到
// 哪只箱体**那一步按原型序号排错了（`dev/待办.md` 第十五条）。那条修好之后这一把三条断言里
// "水进了某只箱体"这一判的前提换了（现在它红、而石油气反倒进得去），所以它**不在全量名单里**，
// 理由写在 `dev/regress.sh` 的 `SKIP_E2E` 旁边；要重新登记，先得把它问的问题换成"分口按活体箱体"那一版。
//
// 同一发硫酸、同一手"一口一列"，机器从化工厂换成**低温厂**（5×5，同面三口在 -2/0/+2）之后，台架说
// "这一排石油气没送到机器嘴里"（`CARD_ROW_NOT_FED`，`held=200 box=0`），而**同面隔壁那一列的水送到了**
// （2026-10-11 用 `dev/lab_probe_dump.js` 点名两台各跑一遍：化工厂 state=done、347.6/分、0 条问题；
// 低温厂 state=supply_unproven、3 条问题**全是石油气**、水不在名单里）。
//
// 两种料在同一面、同样深、同样一格宽 —— 差别只剩"哪只箱体"与"哪种流体"。这两种猜测要做的东西完全不同
// （改牌的列 vs 改台架的灌量），所以这一把不问台架的结论，问引擎的现场：
//   ① 每只箱体此刻有哪种液体、多少，以及引擎认不认它连着东西（`get_connections(i)` 的条数与对面是谁）；
//   ② 绕开台架的灌法自己灌：把每只**进料**箱体所连的那根管子直接按上这股液体，时钟推几秒再读箱体。
//      水进、气不进 ⟹ 差在流体本身；200 不进而 4000 进 ⟹ 差在**灌量**（2.0 里气体在同一格数下的压力）；
//      都不进 ⟹ 那只箱体根本不收这股液体。
// 现场怎么来的：让**台架自己建**（`card_lab` 会按牌铺出全部件，且 `supply_unproven` 收场时不拆），
// 建完的地面就是我要读的那一发。自己摊 59 件 `create_entity` 那条路走过一次 —— 6KB 的一条 /c 让服务端
// 一个字都不回（`dev/stacked_line_probe.js` 开头写的就是这个坑），不该在铲子里重犯。
//
// 这一把是铲子，不是门禁：不注册进 `dev/quick.sh`/`regress.sh`，红了也把读数交给人看。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("cryo_feed_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "90000" };
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 300) }; }
};
const lua = (src) => {
  try {
    return execFileSync("node", [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 300); }
};
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const cut = (v, n) => JSON.stringify(v === undefined ? null : v).slice(0, n || 600);
const flat = (v, n) => String(v).replace(/\n/g, " ").slice(0, n || 1400);
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + flat(detail, 600)}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);

const MACHINE = process.env.CFP_MACHINE || "cryogenic-plant";
const RECIPE = process.env.CFP_RECIPE || "sulfur";
const N = Number(process.env.CFP_N || 3);
// 台架建完铺的那张图（`card_lab` 用它），读的是同一份地面。
const SURF = "arch-lab";

const RECIPES = [RECIPE, MACHINE, "chemical-plant", "oil-refinery", "foundry",
  "empty-water-barrel", "pipe", "storage-tank", "pump", "transport-belt", "fast-transport-belt",
  "fast-inserter", "long-handed-inserter", "display-panel"];
const asLuaList = (xs) => `{${xs.map((x) => `"${x}"`).join(",")}}`;
const neededTechs = () => lua(`local want = {}
for _, n in ipairs(${asLuaList(RECIPES)}) do want[n] = true end
local out = {}
for tname, t in pairs(prototypes.technology) do
  local ok, eff = pcall(function() return t.effects end)
  for _, e in ipairs((ok and eff) or {}) do
    if e.type == "unlock-recipe" and e.recipe and want[e.recipe] then out[tname] = true end
  end
end
local ks = {} for k in pairs(out) do ks[#ks + 1] = k end
table.sort(ks)
rcon.print(table.concat(ks, ","))`);
const TECHS = String(neededTechs()).split(/[,\s]+/).filter((x) => /^[a-z][a-z0-9_-]*$/.test(x));
const luaTable = (obj) => `{${Object.entries(obj).map(([k, v]) => `["${k}"]=${v ? "true" : "false"}`).join(",")}}`;
const readState = () => lua(`local f = game.forces.player
local out = {}
for _, n in ipairs(${asLuaList(TECHS)}) do
  local t = f.technologies[n]
  out[#out + 1] = "t:" .. n .. "=" .. tostring(t ~= nil and t.researched or false)
end
for _, n in ipairs(${asLuaList(RECIPES)}) do
  local r = f.recipes[n]
  out[#out + 1] = "r:" .. n .. "=" .. tostring(r ~= nil and r.enabled or false)
end
rcon.print(table.concat(out, " "))`);
const writeState = (pairs) => lua(`local f = game.forces.player
local set = ${luaTable(pairs)}
for key, val in pairs(set) do
  local kind, name = key:sub(1, 1), key:sub(3)
  if kind == "t" then
    local t = f.technologies[name] if t then t.researched = val end
  else
    local r = f.recipes[name] if r then r.enabled = val end
  end
end
f.rechart()
rcon.print("ok")`);
const parseState = (line) => {
  const out = {};
  for (const tok of String(line).trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1) === "true";
  }
  return out;
};
const before = parseState(readState());
console.log("  借的技术: " + TECHS.join(","));
const grant = (on) => {
  const next = {};
  for (const k of Object.keys(before)) next[k] = on ? true : before[k];
  return writeState(next);
};

// 地上那几只箱体的读数（灌之前灌之后都用同一把尺）。三处工具的坑都在这一把上踩过，写在这点：
// 过滤要用 `name = {...}`（`names=` 会被引擎静默忽略，等于没过滤）；搜索盒按**整格**给且要盖住被读
// 那一格本身（边界写差半格就把被读对象关在框外，"少读回一件"永远先怀疑尺子）；`#fb` 而不是
// `fb.count()`（后者不存在，写了整条命令编译不过，看着像"机器没摆上"）。
const READ = `local surf = game.surfaces["${SURF}"]
if not surf then rcon.print("NO_SURFACE") return end
local ms = surf.find_entities_filtered({ name = { "${MACHINE}" },
    area = { { -300, -300 }, { 300, 300 } } })
local out = {}
for idx = 1, #ms do
  local m = ms[idx]
  local fb = m.fluidbox
  local one = { "M" .. idx .. "@" .. m.position.x .. "," .. m.position.y .. " d" .. tostring(m.direction) }
  for i = 1, #fb do
    local b = fb[i]
    local n = 0
    pcall(function() n = #(fb.get_connections(i) or {}) end)
    local who = {}
    -- get_connections(i) 交回来的是**别人的 fluidbox**（LuaFluidBox），它没有 name 这个键：
    -- 问 c.name 会炸整条命令（"LuaFluidBox doesn't contain key name"），要对面那件东西得走 c.owner。
    pcall(function()
      for _, c in ipairs(fb.get_connections(i) or {}) do
        local o = c.owner
        who[#who + 1] = tostring(o and o.name) .. "@" .. tostring(o and o.position.x) .. ","
          .. tostring(o and o.position.y)
      end
    end)
    local cap = "?"
    pcall(function() cap = tostring(fb.get_capacity(i)) end)
    -- 最权威的一格：**引擎自己认为这只箱体接在哪几格地面上**（get_pipe_connections(i) 的
    -- target_position，ports.lua 算面与格号用的就是它）。get_connections 只说"此刻连着谁"，
    -- 而这一发要问的是"这只箱体本应站在哪一格" —— 牌的列是按原型第一只接口的格号排的，
    -- 如果一台机器的一只箱体其实覆盖好几格（或该覆盖的那一格不是我以为的那一格），
    -- 错的就是"哪种液体分到哪个口"这一步，不是台架的灌量。
    local cells = {}
    pcall(function()
      for _, pc in ipairs(fb.get_pipe_connections(i) or {}) do
        local t = pc.target_position
        cells[#cells + 1] = string.format("%.1f,%.1f/d%s", t.x, t.y, tostring(pc.flow_direction))
      end
    end)
    one[#one + 1] = "b" .. i .. "=" .. tostring(b and b.name or "空") .. "/"
      .. tostring(b and b.amount or 0) .. " 容" .. cap .. " 连" .. n
      .. " 本箱该站的格[" .. table.concat(cells, " ") .. "]"
      .. (#who > 0 and (" {" .. table.concat(who, " ") .. "}") or "")
  end
  local rp, st = "?", "?"
  pcall(function() rp = tostring((m.get_recipe() or {}).name) end)
  pcall(function() st = tostring(m.get_status().status) end)
  one[#one + 1] = "配方=" .. rp .. " 状态=" .. st
  out[#out + 1] = table.concat(one, "  ")
end
rcon.print(table.concat(out, " | "))`;

grant(true);
try {
  const s = call("card_example", { recipe: RECIPE, machines: N, force: "player", machine: MACHINE });
  const d = s.data || {};
  check("点名这一台铺得出（一口一列那一档）",
    s.ok && d.style === "fluid-through", cut([s.code, s.msg], 240));
  const ins = asArr(d.fluid_in);
  console.log("  fluid_in=" + cut(ins.map((e) => [e.fluid, e.face, e.off, asArr(e.ports).length]), 300));

  const proto = lua(`local p = prototypes.entity["${MACHINE}"]
local out = {}
for i = 1, #p.fluidbox_prototypes do
  local fp = p.fluidbox_prototypes[i]
  local one = { "P" .. i .. "=" .. tostring(fp.production_type) }
  for _, c in ipairs(fp.pipe_connections or {}) do
    -- 运行时原型上是 positions（按方向 0/4/8/12 排的四条尖点），不是 data 阶段的 position：
    -- 问错字段只会看到空表，然后误判成"这台机器没有地面接口"。
    for k = 1, #(c.positions or {}) do
      local q = c.positions[k]
      if q then one[#one + 1] = "d" .. ((k - 1) * 4) .. "@" .. q.x .. "," .. q.y end
    end
  end
  out[#out + 1] = table.concat(one, " ")
end
rcon.print(table.concat(out, " | "))`);
  console.log("  原型箱体: " + flat(proto, 1200));

  call("lab_reset", {});
  const started = call("card_lab", { card: d, seconds: 60, speed: 10 });
  check("台架把这张牌建起来了（下面读的是它建出来的那片地面）",
    started.ok === true, cut([started.code, started.msg], 240));
  let st = {};
  for (let i = 0; i < 20; i++) { sleep(2000); st = call("lab_status", {}).data || {}; if (st.state !== "running") break; }
  console.log("  台架收到: state=" + st.state + " reason=" + cut(st.reason, 120)
    + " produced=" + cut(st.produced, 200) + " problems="
    + asArr(st.supply_problems).map((p) => [p.fluid, p.why, p.held, p.box].join(":")).join(" "));
  console.log("  地面(建完): " + flat(lua(READ), 1500));

  // 灌三轮，一轮一个读数。倒空箱体在灌之前做：上一轮留在箱里的液体会被读成"这一轮也进来了"。
  for (const [fluid, amount] of [["water", 200], ["petroleum-gas", 200], ["petroleum-gas", 4000]]) {
    const wrote = lua(`local surf = game.surfaces["${SURF}"]
if not surf then rcon.print("NO_SURFACE") return end
local ms = surf.find_entities_filtered({ name = { "${MACHINE}" },
    area = { { -300, -300 }, { 300, 300 } } })
local wrote = {}
for idx = 1, #ms do
  local m = ms[idx]
  local fb = m.fluidbox
  for i = 1, #fb do pcall(function() fb[i] = nil end) end
  for i = 1, #fb do
    local conns = {}
    pcall(function() conns = fb.get_connections(i) or {} end)
    for _, c in ipairs(conns) do
      -- get_connections(i) 交回来的 c **本身就是对面那只 fluidbox**（不是实体）：
      -- 所以灌它是 c[1] = {...}，
      -- 写 c.fluidbox 会炸（LuaFluidBox 没有 fluidbox 这个键），要实体得走 c.owner。
      local ok = pcall(function() c[1] = { name = "${fluid}", amount = ${amount} } return true end)
      local now = "?"
      pcall(function() local q = c[1]
        now = tostring(q and q.name) .. "/" .. tostring(q and q.amount) end)
      local cn = "?"
      pcall(function() cn = tostring(c.owner and c.owner.name) end)
      wrote[#wrote + 1] = "M" .. idx .. "b" .. i .. "→" .. cn .. "=" .. tostring(ok) .. " 读回" .. now
    end
  end
end
game.speed = 10
game.tick_paused = false
rcon.print(table.concat(wrote, " | "))`);
    console.log("  [" + fluid + "@" + amount + "] 灌: " + flat(wrote, 700));
    sleep(3000);
    const after = lua("game.speed = 1\n" + READ);
    console.log("  [" + fluid + "@" + amount + "] 之后: " + flat(after, 1500));
    if (fluid === "water") {
      check("水进了某只箱体（同面同深的那一列灌得动 ⟹ 牌的列没站错格）",
        /=water\/[1-9]/.test(String(after)), String(after).slice(0, 500));
    }
  }
  console.log("  读法：气在 200 不进而 4000 进 ⟹ 差在台架的灌量；200/4000 都不进 ⟹ 与量无关；"
    + "水进得去而气进不去 ⟹ 差在流体本身（2.0 里同一格数下气体的压力）。");
  console.log("  " + lua('rcon.print("paused=" .. tostring(game.tick_paused) .. " speed=" .. tostring(game.speed))'));
} finally {
  console.log("  收尾: " + lua(`game.speed = 1
game.tick_paused = false
rcon.print("speed=" .. tostring(game.speed) .. " paused=" .. tostring(game.tick_paused))`));
  console.log("  台架清场: " + cut(call("lab_reset", {}).ok, 60));
  console.log("  还回去: " + grant(false));
}
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
