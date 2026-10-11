// #25 的第一铲：同一发硫酸（3 台、`fluid-through`、一口一列），厚世界里台架量到 347.6/分，
// 现在这份"薄"存档里四条台架读数全空。这一把不管断言，只管把**两张东西**摊开对着看：
//   ① 牌自己：机器是哪台、带子哪一档、几行、两口各在哪一面第几格、整张卡多高 ——
//      从前那一趟读的是 `side:"north"`、`row:22/24/26`；这一趟是 `face:"south"`、`row:49..57`。
//      这两份只要有一份对不上，问题就在牌那侧，不在台架。
//   ② 台架：`lab_stop` 交回来的**每一格**（不是平时被挑出来打印的那几格）。空读数到底空在哪一步：
//      `state`、`clock`、`supply_problems`、`probed`、`drain`、`missing_entities`、`verdicts`。
// 研究照读回来的原值借、照原值还（§0 第五条与第六条那两个坑都在这里面）。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("lab_probe_dump");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "60000" };
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
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 200); }
};
const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

// 名单**照 `multi_fluid_probe` 那一份**（23 项）：这一把要问的是"多借几件机器之后，`sulfur` 还是不是
// 那台化工厂"。红的那几发里 `probed` 报的是 face=south、行 49..57、卡里 40 多件 —— 那不是化工厂的
// 3×3 与北面两口，那是**另一台机器**（南面两口的候选：foundry / oil-refinery / cryogenic-plant）。
const RECIPES = ["sulfur", "heavy-oil-cracking", "solid-fuel-from-ammonia", "lithium",
  "ammonia-rocket-fuel", "concrete-from-molten-iron", "fluoroketone",
  "casting-low-density-structure", "chemical-plant", "oil-refinery", "foundry", "biochamber",
  "assembling-machine-3", "assembling-machine-4",
  "empty-water-barrel", "lubricant", "display-panel",
  "pipe", "storage-tank", "pump", "fast-transport-belt", "transport-belt",
  "fast-inserter", "long-handed-inserter", "bulk-inserter", "loader"];
const asLuaList = (xs) => `{${xs.map((x) => `"${x}"`).join(",")}}`;
const techsFor = lua(`local want = {}
for _, n in ipairs(${asLuaList(RECIPES)}) do want[n] = true end
local out = {}
for tname, t in pairs(prototypes.technology) do
  local ok, eff = pcall(function() return t.effects end)
  for _, e in ipairs((ok and eff) or {}) do
    if e.type == "unlock-recipe" and e.recipe and want[e.recipe] then out[tname] = true end
  end
end
local ks = {} for k in pairs(out) do ks[#ks + 1] = k end
table.sort(ks) rcon.print(table.concat(ks, ","))`);
const TECHS = String(techsFor).split(/[,\s]+/).filter((x) => /^[a-z][a-z0-9_-]*$/.test(x));
console.log("  要借的科技（按原型读回来）: " + TECHS.join(","));
const read = lua(`local f = game.forces.player
local out = {}
for _, n in ipairs(${asLuaList(TECHS)}) do
  local t = f.technologies[n] out[#out + 1] = "t:" .. n .. "=" .. tostring(t ~= nil and t.researched or false)
end
for _, n in ipairs(${asLuaList(RECIPES)}) do
  local r = f.recipes[n] out[#out + 1] = "r:" .. n .. "=" .. tostring(r ~= nil and r.enabled or false)
end
rcon.print(table.concat(out, " "))`);
const before = {};
for (const tok of String(read).trim().split(/\s+/)) {
  const i = tok.indexOf("="); if (i > 0) before[tok.slice(0, i)] = tok.slice(i + 1) === "true";
}
console.log("  原值读到 " + Object.keys(before).length + " 项（期望 " + (TECHS.length + RECIPES.length) + "）");
// 表字面量先在 JS 里拼成一个变量再递进去：dev/lua_templates.py 那个解析器不收嵌在插值里的模板串
// （§0 那批仪器坑里记着这一手：嵌层就把整条命令判成不合法）。
const luaSet = (on) => "{" + Object.keys(before).map((k) =>
  `["${k}"]=${on ? "true" : (before[k] ? "true" : "false")}`).join(",") + "}";
const write = (on) => lua(`local f = game.forces.player
local set = ${luaSet(on)}
for key, val in pairs(set) do
  local kind, name = key:sub(1, 1), key:sub(3)
  if kind == "t" then local t = f.technologies[name] if t then t.researched = val end
  else local r = f.recipes[name] if r then r.enabled = val end end
end
rcon.print("ok")`);
const cut = (v, n) => JSON.stringify(v === undefined ? null : v).slice(0, n || 900);

write(true);
// 三把可调的旋钮（默认就是最初那一铲：3 台硫酸）。**钉机器**那一格是要紧的：机器梯子在借开的窗口里
// 会换一台（`cryogenic-plant` 一开，sulfur 就从化工厂换到 5×5 的低温厂），换机器 ⟹ 换卡片几何 ⟹ 换读数。
// 想问"同一发换机器会怎样"，就点着名各跑一遍，而不是让梯子悄悄换。
const RECIPE = process.env.LPD_RECIPE || "sulfur";
const MACHINES = Number(process.env.LPD_N || 3);
const PIN = process.env.LPD_MACHINE || null;
try {
  let s = call("card_example", Object.assign(
    { recipe: RECIPE, machines: MACHINES, force: "player" }, PIN ? { machine: PIN } : {}));
  let d = s.data || {};
  const ents = asArr(d.entities);
  const ys = (re) => {
    const v = [...new Set(ents.filter((e) => re.test(String(e.name)))
      .map((e) => Math.floor(e.position.y)))].sort((a, b) => a - b);
    return v;
  };
  console.log("\n== 牌这一侧（" + RECIPE + " ×" + MACHINES + (PIN ? "，点名 " + PIN : "，让梯子自己挑") + "）");
  console.log("  ok=" + s.ok + " code=" + s.code + " style=" + d.style
    + " 牌上点的机器=" + cut(d.machine || (d.components || {}).machine)
    + " belt=" + cut(d.belt || (d.components || {}).belt));
  console.log("  件名清单=" + cut(Object.keys(ents.reduce((a, e) => { a[e.name] = (a[e.name] || 0) + 1; return a; }, {}))));
  const ACCESS = /^(pipe|pipe-to-ground|.*transport-belt|.*inserter|.*combinator|.*chest|display-panel|.*lamp)$/;
  console.log("  机器件名=" + cut([...new Set(ents.filter((e) => !ACCESS.test(String(e.name))).map((e) => e.name))]));
  console.log("  件数=" + ents.length + " | 机器 y=" + cut(ys(/chemical-plant|assembling-machine|furnace|cryogenic|refinery|foundry/))
    + " 带子 y=" + cut(ys(/transport-belt/)) + " 管子 y=" + cut(ys(/^pipe$/)));
  console.log("  管子 x=" + cut([...new Set(ents.filter((e) => e.name === "pipe").map((e) => Math.floor(e.position.x)))].sort((a, b) => a - b)));
  console.log("  fluid_in=" + cut(asArr(d.fluid_in).map((e) => [e.fluid, e.face, e.off, asArr(e.ports).length])));
  console.log("  fluid_out=" + cut(asArr(d.fluid_out).map((e) => [e.fluid, e.face, e.off])));
  console.log("  lane_plan=" + cut(d.lane_plan, 700));
  console.log("  about=" + cut(d.about) + " | 尺寸=" + cut(d.size || d.extent || d.footprint, 200));

  console.log("\n== 台架这一侧（lab_stop 交回的每一格）");
  call("lab_reset", {});
  // `LPD_ARMS=1`：**复位之后**再量一遍臂，然后用新的一份卡跑台架。为什么要有这一步（§0 第十六条）：
  // `lab_reset` 按设计把 `drills/pumps/farm/arms` 一起忘掉，所以"复位前量过的臂速"在这一趟里根本不存在，
  // 而 `drain.card_outlet` 与 `over_card_outlet` 那两格全靠它 —— 不在复位后重量，就只能读到
  // `measured=false`，那正是我今晚把 #30 误判成 bug 的同一个顺序错。
  if (process.env.LPD_ARMS) {
    const prod = Object.keys((d.contract || {}).outputs || {})[0]
      || Object.keys((d.contract || {}).fluid_outputs || {})[0];
    if (prod) {
      console.log("  量臂（复位之后）: 产物=" + prod);
      call("arm_rate", { item: prod, seconds: 25, speed: 20 });
      let filed = false;
      for (let i = 0; i < 10 && !filed; i++) {
        sleep(10000);
        const again = call("arm_rate", { item: prod });
        filed = again.ok === true && (again.data || {}).cached === true;
      }
      const fresh = call("card_example", Object.assign(
        { recipe: RECIPE, machines: MACHINES, force: "player" }, PIN ? { machine: PIN } : {}));
      const fd = fresh.data || {};
      console.log("  量臂 filed=" + filed + " → 牌的 arm_ceiling: "
        + JSON.stringify((fd.arm_ceiling || {})).slice(0, 220));
      if (filed && fresh.ok && (fd.entities || []).length) d = fd;
    } else {
      console.log("  量臂：这张卡没有产物名可问（contract 是空的），跳过");
    }
  }
  const started = call("card_lab", { card: d, seconds: 150, speed: 20 });
  console.log("  card_lab ok=" + started.ok + " code=" + started.code + " msg=" + cut(started.msg, 240));
  let status = {};
  for (let i = 0; i < 24; i++) { sleep(2000); status = call("lab_status", {}).data || {}; if (status.state !== "running") break; }
  const stopped = call("lab_stop", {});
  const done = (stopped.ok && stopped.data) ? stopped.data : status;
  for (const k of Object.keys(done).sort()) {
    if (k === "entities" || k === "card") continue;
    console.log("  " + k + " = " + cut(done[k], 620));
  }
  // `supply_problems` 是这一铲真正要看的表：一条一份"这一排的液体没少过"。哪几种流体、各站第几排、
  // 蓄水池里多少、机器那只箱体里多少 —— 全列出来才能分"气体压不动"与"管子没接上"。
  const probs = asArr(done.supply_problems);
  console.log("  --- supply_problems 逐条（共 " + probs.length + "）");
  for (const p of probs) {
    console.log("    " + [p.fluid, p.why, "held=" + p.held, "box=" + p.box, "row=" + p.row,
      "side=" + p.side, "serves=" + cut(p.serves, 80), "header=" + cut(p.header, 60)].join(" "));
  }
  console.log("  --- 一句话：state=" + done.state + " reason=" + cut(done.reason, 120)
    + " produced=" + cut(done.produced, 200) + " verdicts=" + cut(done.verdicts, 300));
} finally {
  console.log("\n  还回去: " + write(false));
}
console.log("  " + lua('local f=game.forces.player rcon.print("sulfur-recipe=" .. tostring((f.recipes["sulfur"] or {}).enabled) .. " paused=" .. tostring(game.tick_paused))'));
