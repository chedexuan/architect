// 进料那一行管子，每分钟究竟送得到几单位 —— 量出来，不是推出来。
// 用法：`bash dev/test.sh node dev/pipe_row_flow.js`（`PFR_CASES=1,3,6,10`、`PFR_RECIPE=battery` 可收窄）
//
// 为什么要这一把尺：一张卡的**声称**是配方给的（台数 × 速度），而它自己铺的那一行 1×1 的管子能不能
// 把那么多水送到每台机器嘴边，是另一件事。硫酸三台那发量到的是 1860/分对声称 9000/分（比率 0.207，
// 两次跑同一个数 —— 见 dev/待办.md §0 第十条），也就是说牌许诺了一个它自己的管道送不到的速率，
// 而现在既不拒也不打折。要把它写进答案，得先有一个量过的数。
//
// 量法：同一张卡、同一档带子，只改台数。配方给的需水量随台数线性涨，而"一行管子送得到多少"不涨 ——
// 于是 measured/min 会先贴着声称、然后**平**在某个数上；那个平台就是这一行（这个长度、这一个进水口）
// 的上限。两条卡各测一次是为了分开"进料行卡住"与"成品行卡住"：
//   battery          进：硫酸 + 3 种固体，出：固体 ⟹ 成品那一侧是带子，液体出口不构成瓶颈
//   sulfuric-acid    进：水，出：硫酸（走成品那一行管子）⟹ 两侧都是管子
// 平台出现在哪、多高，两列一起看就知道限制住在哪一侧。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("pipe_row_flow");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "30000" };
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 200) }; }
};
const lua = (src) => execFileSync("node", [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

// 与研究名单同一手：读回来、点名借、跑完照原值还（§0 那两条坑：科技置真不跑解锁；一刀清零会关掉
// 后面每套套件没关过的东西）。这里额外要的是 `battery` 那条链上的科技与配方。
const WANT_RECIPES = ["battery", "sulfuric-acid", "chemical-plant", "iron-plate", "copper-plate",
  "electronic-circuit", "plastic-bar", "copper-cable", "pipe", "storage-tank", "display-panel",
  "long-handed-inserter", "fast-inserter", "fast-transport-belt"];
const wantTechs = () => lua(`local want = {}
for _, n in ipairs({${WANT_RECIPES.map((n) => '"' + n + '"').join(",")}}) do want[n] = true end
local out = {}
for tname, t in pairs(prototypes.technology) do
  local ok, eff = pcall(function() return t.effects end)
  for _, e in ipairs((ok and eff) or {}) do
    if e.type == "unlock-recipe" and e.recipe and want[e.recipe] then out[tname] = true end
  end
end
local ks = {} for k in pairs(out) do ks[#ks + 1] = k end
table.sort(ks) rcon.print(table.concat(ks, ","))`);
const TECHS = String(wantTechs()).split(/[,\s]+/).filter((x) => /^[a-z][a-z0-9_-]*$/.test(x));
const read = () => lua(`local f = game.forces.player
local out = {}
for _, n in ipairs({${TECHS.map((n) => '"' + n + '"').join(",")}}) do
  local t = f.technologies[n] out[#out+1] = "t:" .. n .. "=" .. tostring(t ~= nil and t.researched or false)
end
for _, n in ipairs({${WANT_RECIPES.map((n) => '"' + n + '"').join(",")}}) do
  local r = f.recipes[n] out[#out+1] = "r:" .. n .. "=" .. tostring(r ~= nil and r.enabled or false)
end
rcon.print(table.concat(out, " "))`);
const parse = (line) => {
  const out = {};
  for (const tok of String(line).trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1) === "true";
  }
  return out;
};
const before = parse(read());
const write = (on) => {
  const next = {};
  for (const k of Object.keys(before)) next[k] = on ? true : before[k];
  const setTable = "{" + Object.entries(next)
    .map(([k, v]) => '["' + k + '"]=' + (v ? "true" : "false")).join(",") + "}";
  return lua(`local f = game.forces.player
local set = ${setTable}
for key, val in pairs(set) do
  local kind, name = key:sub(1, 1), key:sub(3)
  if kind == "t" then
    local t = f.technologies[name] if t then t.researched = val end
  else
    local r = f.recipes[name] if r then r.enabled = val end
  end
end
rcon.print("ok")`);
};

const bench = (card, seconds) => {
  call("lab_reset", {});
  const started = call("card_lab", { card, seconds: seconds || 120, speed: 20, force: "player" });
  if (!started.ok) return { refused: started.code, msg: started.msg };
  let st = {};
  for (let i = 0; i < 40; i++) {
    sleep(2000);
    st = call("lab_status", {}).data || {};
    if (st.state && st.state !== "running") break;
  }
  const stopped = call("lab_stop", {});
  return (stopped.ok && stopped.data) ? stopped.data : st;
};

const CASES = String(process.env.PFR_CASES || "1,3,6,10").split(",").map((x) => Number(x));
const rows = [];
write(true);
try {
  for (const recipe of ["battery", "sulfuric-acid"]) {
    if (process.env.PFR_RECIPE && process.env.PFR_RECIPE !== recipe) continue;
    for (const n of CASES) {
      const ex = call("card_example", { recipe, machines: n, force: "player" });
      if (!ex.ok) { console.log(`  ${recipe} x${n}: 铺不出 ${ex.code}`); continue; }
      const d = ex.data;
      const ran = bench(d, 120);
      const v = asArr(ran.verdicts);
      const first = v[0] || {};
      const pipes = ((d.parts || {}).pipes) || 0;
      console.log(`  ${recipe.padEnd(14)} x${String(n).padEnd(3)} 声称 ${String(first.claimed_per_min).padStart(6)}/分`
        + ` 量到 ${String(first.measured_per_min).padStart(7)}/分 比率 ${String(first.ratio).slice(0, 6)}`
        + ` 管子 ${pipes} 段 ${JSON.stringify(asArr((ran.fluid_drain_rows || [])[0] || {}).segments)}`
        + ` 状态 ${asArr(ran.machine_status).map((m) => m.status).join(",")}`);
      rows.push({ recipe, machines: n, claimed: Number(first.claimed_per_min) || 0,
        measured: Number(first.measured_per_min) || 0, ratio: Number(first.ratio) || 0,
        pipes, statuses: asArr(ran.machine_status).map((m) => m.status) });
    }
  }
} finally {
  write(false);
  console.log("  " + lua("rcon.print('paused=' .. tostring(game.tick_paused))"));
}

// 平台在哪里：把 measured 对 claimed 的比按行序画出来，肉眼找"不再跟着台数涨"的那一档。
// 只有 2 行以内时不下结论（那条曲线要至少一个"贴着声称"的段和一个"平了"的段才算量到）。
const byRecipe = {};
for (const r of rows) (byRecipe[r.recipe] = byRecipe[r.recipe] || []).push(r);
for (const [recipe, list] of Object.entries(byRecipe)) {
  const fit = list.filter((r) => r.ratio >= 0.9);
  const stuck = list.filter((r) => r.ratio < 0.9);
  console.log(`\n${recipe}: 贴着声称的最上台数 = ${fit.length ? Math.max(...fit.map((r) => r.machines)) : "无"}`
    + `，开始掉的第一档 = ${stuck.length ? Math.min(...stuck.map((r) => r.machines)) : "无"}`
    + (stuck.length ? `，掉下去之后 measured 稳定在 ${stuck.map((r) => Math.round(r.measured)).join("/")}/分` : ""));
}
console.log("\n（读法：如果「掉下去之后」的 measured 随台数继续涨，那不是这一行的上限，是别处的瓶颈；"
  + "如果它平了，那个平台就是这一行进料能送到的数 —— 拿它写 feed_row_ceiling。）");
