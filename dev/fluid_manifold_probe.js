// 同一种液体在一面**连成一段、每一种液体一个接口**（他 2026-10-11 亲手铺完提的第 2 条："含液体的配方
// 需要把同一种液体的管道连接起来，方便铺好蓝图后直接连接原料管道或者成品管道就能用了"）。
//
// 从前一台机器一根柱子：一条 3 台、两种液体的线铺完有 6 个自由端，玩家要接 6 次管。现在：
//   * 第一位（按牌上 `fluid_in` 的顺序数）在柱头往外补一格普通管子，横着连成一行，最外那一格是接口；
//   * 后面每一位把自己柱头往外那一格换成**穿地管**（入，朝机器），从上一位的行底下穿过去，在错开
//     3 格的那一行出来（出，朝外），再横着连到自己那一行 —— 于是每种液体只有一个接口。
// 三条几何律都是量的（写在 `styles.lua` 的 `fluid_manifold` 头上：穿地管只与面朝那一格通水、背对背一对
// 隔 2..6 成对且中间站着别人的管子也成对、普通管子挨着别人家的管子就是一张管网）。这一把钉四件事：
//   1. 答案里每一位一条 `fluid_manifolds`，并且**每一条口的 `row_port` 都指同一个件号**（接口真的只有一个）；
//   2. 地上把这两行管子与穿地管按件号铺出来，从两个接口各灌一种液体，跑一拍：三种读数的段号 ——
//      同一种液体的三个柱头必须同一个段号，两种液体必须两个不同段号（不混）；
//   3. 摆不出穿地管的那一发（这台机器没解锁它）不静默少做：每一位交回 `header_why`，线照铺；
//   4. 一件都不连的那种线（一台一口共用一行的 `pipe_row`）不被误报成"漏做了"。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("fluid_manifold_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "30000" };
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 300) }; }
};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 200); }
};
const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);
// 坐标表必须在 JS 里拼成 **Lua 字面量**再递进去（`{ {x=1,y=2}, ... }`）：塞 JSON 的 `[{"x":1}]` 进去
// 整条命令编译不过，而"编译不过"在 rcon 上长得跟"服务器没答案"一样（§0 那批仪器坑里记着这一手）。
const luaSpots = (rows) => "{" + rows.map((r) => {
  const parts = [];
  for (const [k, v] of Object.entries(r)) {
    parts.push(typeof v === "number" ? `${k}=${v}` : typeof v === "string" ? `${k}="${v}"` : `${k}=${luaSpots(v)}`);
  }
  return "{" + parts.join(",") + "}";
}).join(",") + "}";
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const xy = (p) => (!p ? null : Array.isArray(p)
  ? [Number(p[0]), Number(p[1])]
  : [Number(p.x !== undefined ? p.x : p[1]), Number(p.y !== undefined ? p.y : p[2])]);
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 500)}`);
  ok ? pass++ : fail++;
};

// 借窗口：读回原值、跑完照原值还（名单对不上就当场报差异，不静默少借一项）。
const TECHS = ["automation", "circuit-network", "logistics", "logistics-2", "oil-processing",
  "fluid-handling", "chemistry", "cryogenic-plant"];
const RECIPES = ["chemical-plant", "cryogenic-plant", "sulfur", "pipe", "pipe-to-ground",
  "display-panel", "inserter", "long-handed-inserter", "fast-inserter", "transport-belt",
  "fast-transport-belt"];
const asLuaList = (xs) => `{${xs.map((x) => `"${x}"`).join(",")}}`;
const readState = () => lua(`local f = game.forces.player
local out = {}
for _, n in ipairs(${asLuaList(TECHS)}) do
  local t = f.technologies[n] out[#out + 1] = "t:" .. n .. "=" .. tostring(t ~= nil and t.researched or false)
end
for _, n in ipairs(${asLuaList(RECIPES)}) do
  local r = f.recipes[n] out[#out + 1] = "r:" .. n .. "=" .. tostring(r ~= nil and r.enabled or false)
end
rcon.print(table.concat(out, " "))`);
const parse = (line) => {
  const o = {};
  for (const tok of String(line).trim().split(/\s+/)) {
    const i = tok.indexOf("="); if (i > 0) o[tok.slice(0, i)] = tok.slice(i + 1) === "true";
  }
  return o;
};
const before = parse(readState());
const KEYS = TECHS.map((t) => "t:" + t).concat(RECIPES.map((r) => "r:" + r));
const missingKeys = KEYS.filter((k) => !(k in before));
if (missingKeys.length) {
  console.log("FAIL  借窗口对不上：名单里没读到 " + missingKeys.join(","));
  process.exit(1);
}
const luaSet = (over) => "{" + KEYS.map((k) => {
  const off = over && over[k];
  const v = off ? false : (before[k] || KEYS.indexOf(k) >= 0);
  return `["${k}"]=${v ? "true" : "false"}`;
}).join(",") + "}";
const grant = (over) => lua(`local f = game.forces.player
local set = ${luaSet(over)}
for key, val in pairs(set) do
  local kind, name = key:sub(1, 1), key:sub(3)
  if kind == "t" then local t = f.technologies[name] if t then t.researched = val end
  else local r = f.recipes[name] if r then r.enabled = val end end
end
rcon.print("ok")`);
grant(null);

const SURF = "arch-lab";
let PAUSED_BEFORE = "false";   // 只有跑拍子那一发会改它，读一次记一次
function portsOf(d, which) {
  const rows = asArr((d.ports || {})[which]);
  return rows;
}
// 地上那一步：把答案里**这一发自己的**液体件（普通管子与穿地管）按坐标铺出来，从两个接口各灌一种料，
// 跑一拍，读回段号。读数只信引擎自己的 `get_fluid_segment_id`（模自己数的格数不算证据）。
// 三段各是一条命令：铺、灌、读 —— 中间用 `game.ticks_to_run` 让水走过去（一条命令里 while 等 tick
// 会把服务器吊住，§0 那批仪器坑里记着这一手）。
function liveProof(card, joins, heads) {
  // 朝向必须一起铺出来：穿地管的成对与"只与面朝那一格通水"都看朝向，丢了它就等于问引擎一件它没听懂的事
  // （`pipe_cross_probe.js` 的刻度注释说的是同一件事）。
  const pipes = asArr(card.entities)
    .map((e) => { const p = xy(e.position) || [];
      return { name: String(e.name || ""), x: p[0], y: p[1], d: Number(e.direction || 0) }; })
    .filter((e) => e.name === "pipe" || e.name === "pipe-to-ground");
  if (!pipes.length) return "没有管子可铺";
  const c0 = pipes[0];
  const joinSpots = luaSpots(joins.map((j) => ({ x: j.cell[0], y: j.cell[1], f: j.fluid })));
  const headSpots = luaSpots(heads.map((h) => ({ x: h.cell[0], y: h.cell[1], f: h.fluid })));
  const laid = lua(`local s = game.surfaces["${SURF}"]
s.request_to_generate_chunks({ ${Math.round(c0.x)}, ${Math.round(c0.y)} }, 2)
s.force_generate_chunk_requests()
local made = {}
for _, c in ipairs(${luaSpots(pipes)}) do
  local e = s.create_entity({ name = c.name, position = { c.x, c.y }, direction = c.d, force = "player" })
  if e then made[#made + 1] = e end
end
MF_PROBE = made
rcon.print("铺了=" .. #made)`);
  const filled = lua(`local made = MF_PROBE or {}
local function at(x, y)
  for _, e in ipairs(made) do
    if math.abs(e.position.x - x) < 0.6 and math.abs(e.position.y - y) < 0.6 then return e end
  end
end
local out = {}
for i, j in ipairs(${joinSpots}) do
  local e = at(j.x, j.y)
  local ok = false
  if e then ok = pcall(function() e.fluidbox[1] = { name = j.f, amount = 400 } end) end
  out[#out + 1] = string.format("灌%d=%s/%s", i, tostring(e ~= nil), tostring(ok))
end
rcon.print(table.concat(out, " "))`);
  // 跑拍子之前记下时钟原状，读完一定要还原：把世界留在暂停里，下一趟作业会量到 `elapsed_ticks=0`、
  // `produced=0` —— 我今天差点把这么一发读成"错行连把供料弄坏了"（其实是仪器留在暂停里）。
  const wasPaused = String(lua('rcon.print(tostring(game.tick_paused))')).trim();
  lua(`game.tick_paused = false; game.ticks_to_run = 600; rcon.print('ran')`);
  sleep(20000);
  PAUSED_BEFORE = wasPaused;
  const read = lua(`local made = MF_PROBE or {}
local out = {}
local function label(e)
  local b = nil
  pcall(function() b = e.fluidbox[1] end)
  local seg = "?"
  pcall(function() seg = tostring(e.fluidbox.get_fluid_segment_id(1)) end)
  return (b and tostring(b.name) or "干") .. "/" .. seg
end
local function at(x, y)
  for _, e in ipairs(made) do
    if math.abs(e.position.x - x) < 0.6 and math.abs(e.position.y - y) < 0.6 then return e end
  end
end
for i, j in ipairs(${joinSpots}) do
  local e = at(j.x, j.y)
  out[#out + 1] = "接口" .. i .. "=" .. (e and label(e) or "无")
end
for _, h in ipairs(${headSpots}) do
  local e = at(h.x, h.y)
  out[#out + 1] = "柱头[" .. h.f .. "]=" .. (e and label(e) or "无")
end
for _, e in ipairs(made) do if e.valid then e.destroy() end end
MF_PROBE = nil
rcon.print(table.concat(out, " | "))`);
  lua(`game.tick_paused = ${/true/.test(PAUSED_BEFORE || "") ? "true" : "false"}; rcon.print("时钟还原")`);
  console.log("  地上：" + String(laid).split("\n")[0] + " / " + String(filled).split("\n")[0]
    + " / 读：" + String(read).split("\n")[0].slice(0, 300));
  return String(read).split("\n")[0];
}
try {
  const one = call("card_example", { recipe: "sulfur", machines: 3, force: "player" });
  const d = one.data || {};
  check("硫酸这一发（3 台、同面两种液体）铺得出，而且形状是一口一列那一档",
    one.ok && d.style === "fluid-through" && portsOf(d, "in").length === 6,
    JSON.stringify([one.code || one.msg, d.style, portsOf(d, "in").length]).slice(0, 300));
  const mf = asArr(d.fluid_manifolds);
  check("每一位液体各连成一段：两条 `fluid_manifolds`，位序 1 与 2，位序 2 那一条用了穿地管",
    mf.length === 2 && mf.every((m) => Number(m.joined) === 3 && Number(m.added) >= 4)
      && mf.some((m) => m.hop === true) && mf.some((m) => !m.hop),
    JSON.stringify(mf).slice(0, 500));
  const byFluid = {};
  for (const p of portsOf(d, "in")) (byFluid[p.fluid] = byFluid[p.fluid] || []).push(p);
  let oneJoin = true, allJoin = true;
  for (const list of Object.values(byFluid)) {
    const joins = new Set(list.map((p) => JSON.stringify(xy(p.join))));
    const cells = new Set(list.map((p) => JSON.stringify(p.join_port)));
    // 同一种液体的三条口必须指**同一个**接口件号，而各自柱头的件号互不相同（台架仍一台一只蓄水池，
    // 那是仪器，不是玩家的活儿）。
    if (joins.size !== 1 || cells.size !== 1 || list.length !== new Set(list.map((p) => p.row_port)).size)
      oneJoin = false;
    if (list.some((p) => !p.join || !p.join_port)) allJoin = false;
  }
  check("接口真的只有一个：同一种液体的三条口 `join_port` 同一个号，而柱头各自还是三个号",
    oneJoin && allJoin && Object.keys(byFluid).length === 2,
    JSON.stringify(Object.entries(byFluid).map(([k, v]) => [k, v.map((p) => [p.row_port, p.join_port])]))
      .slice(0, 300));
  const segs = Object.values(byFluid).map((v) => v[0].join_port);
  check("而两种液体的接口不是同一个格子（并到一起就混料了）",
    new Set(segs).size === 2, JSON.stringify(segs));
  console.log("  读数：每位一段 " + JSON.stringify(mf.map((m) => [m.fluid, m.rank, m.hop, m.joined,
    m.added, m.join])));

  // 地上证：把这一发的管子与穿地管铺出来、两个接口各灌一种料，跑一拍读段号。
  // 柱头读的是**每台机器口外那一格**（接口之外它们仍各自在件表里，`join` 只是把它们连起来了），
  // 所以这里读的是件表里那些 `role = fluid_in/fluid_out` 之外的普通柱子格：按答案的件号取。
  const heads = [];
  for (const [fluid, list] of Object.entries(byFluid)) {
    for (const p of list) {
      const specs = asArr(d.entities);
      const ent = specs[(p.row_port || 0) - 1];   // 柱头那一格（台架灌料的地方）
      const pos = xy((ent || {}).position);
      if (pos) heads.push({ cell: [pos[0], pos[1]], fluid });
    }
  }
  const joinsList = Object.entries(byFluid).map(([fluid, v]) => ({ cell: xy(v[0].join), fluid }));
  const live = { read: liveProof(d, joinsList, heads) };
  const lines = String(live.read).split("|").map((x) => x.trim()).filter(Boolean);
  const segOf = (label, idx) => {
    const hit = lines.find((l) => l.startsWith(label + idx));
    const m = hit && /=([^/]+)\/(\S+)/.exec(hit);
    return m ? { fluid: m[1], seg: m[2] } : null;
  };
  const j1 = segOf("接口", 1), j2 = segOf("接口", 2);
  check("地上：两个接口各灌一种之后，跑一拍读回来还是两种料（没互相串）",
    !!j1 && !!j2 && j1.fluid !== "干" && j2.fluid !== "干" && j1.seg !== j2.seg,
    String(live.read).slice(0, 400));
  const headsRead = lines.filter((l) => l.startsWith("柱头"));
  const allWet = headsRead.length >= 6 && headsRead.every((l) => !/干/.test(l));
  check("地上：六个柱头个个都湿了（每一位液体真到了每一台机器那一根的柱头）",
    allWet && new Set(headsRead.map((l) => /=([^/]+)\//.exec(l)[1])).size === 2,
    String(headsRead.join(" | ")).slice(0, 400));

  // 摆不出穿地管那一发：不静默少做，也不报错 —— 位序 2 那一条交回为什么。
  lua('local f = game.forces.player local r = f.recipes["pipe-to-ground"] if r then r.enabled = false end rcon.print("off")');
  const noPtg = call("card_example", { recipe: "sulfur", machines: 3, force: "player" });
  const nd = noPtg.data || {};
  const why = portsOf(nd, "in").map((p) => p.header_why).filter(Boolean);
  check("没解锁穿地管的那一发：线照铺，第二种液体不连，并把为什么写在每一条口上（MANIFOLD_NO_PTG_PART）",
    noPtg.ok && asArr(nd.fluid_manifolds).length === 1
      && why.length >= 3 && why.every((w) => w === "MANIFOLD_NO_PTG_PART")
      && portsOf(nd, "in").filter((p) => !p.header_why).length === 3,
    JSON.stringify([noPtg.code, asArr(nd.fluid_manifolds).length, why.slice(0, 2)]).slice(0, 300));
  grant(null);

  // 不误报：一台一口共用一行的线（只有一种液体在一面）本来就是一个接口，这里不该冒出 manifold。
  const row = call("card_example", { recipe: "lubricant", machines: 3, force: "player" });
  const rd = row.data || {};
  const rowPorts = portsOf(rd, "in");
  check("只有一种液体在一面的那一发（润滑油）：已经是一行管子、一个接口，不重复报成一段",
    row.ok && asArr(rd.fluid_manifolds).length === 0
      && rowPorts.length === 3 && new Set(rowPorts.map((p) => p.row_port)).size === 1
      && rowPorts.every((p) => !p.join),
    JSON.stringify([row.code, asArr(rd.fluid_manifolds).length,
      rowPorts.map((p) => [p.row_port, p.join])]).slice(0, 300));
} finally {
  if (!process.env.FMP_KEEP) console.log("  还回去: " + String(grant(null)).slice(0, 40));
  console.log("  " + lua('rcon.print("paused=" .. tostring(game.tick_paused))'));
}
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
