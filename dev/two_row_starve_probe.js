// 双排 8 台里机器报 `item_ingredient_shortage`：那是**形状**接不到料，还是**台架读的时刻**不对，
// 还是**牌声称了一个搬不动的数**？三种答案要做的东西完全不同，所以这一把只管读数。
//
// 2026-10-11 量到的那一份（三次独立跑，读数同一型）：
//   * 结束那一刻读到的 `machine_status` **不能当证据** —— 作业一停台架就不再插料，带子上那点件被吃光，
//     谁都会翻成"没料"。所以要看的是**跑的过程中**逐台读到的那几份。
//   * 过程中：双排的两排**都**有机器在造（不是只有靠头那一排），而且哪一台饿着会在两次读数之间换人 ——
//     换人 = 供不上；固定一排饿死 = 几何画错。这是这一把要分开的第一件事。
//   * 同一配方换单排（`stacked`）4 台，也读不到牌上声称的数（ratio 0.28）。所以"量不到声称值"这一半
//     **不是双排特有的**，它住在"臂一分钟搬几件"那一顶里 —— 而牌自己在那一发上写着
//     `arm_ceiling.measured=false / why=not-measured`：它声称的 720/分没有臂的根据。
//
// 于是这一把钉两条真能钉的：(1) 双排的**两排都上得了料**；(2) 臂那一顶**仍然没量过**（等实测补上，
// 这条会红，红对了才轮到改声称的那一处）。台架这一趟用低倍速（speed 4）：要的是过程中的读数，
// 20 倍下整个窗口只有十几秒 real time，中间插不进一次采样。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("two_row_starve_probe");
const { onExit } = require("./suite-guard.js");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "30000" };
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
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 500)}`);
  ok ? pass++ : fail++;
};

// 这一把**自己借前提**（2026-10-11 夜量到的）：裸带线头那一档的"第几条带子的哪一边装哪种料"写在一块
// 显示面板上，而按原型读回来 `display-panel <- circuit-network`、`inserter/electronic-circuit <- electronics`、
// `long-handed-inserter/assembling-machine-1 <- automation`、`fast-transport-belt <- logistics-2`。
// 这几项没研究时牌照样铺得出、头牌铺不出（`head.sign_missing`）⟹ 台架读不到股道 ⟹ `CARD_NO_FEEDS`。
// 从前这一套是绿的，因为隔壁套件恰好把这些研究留着 —— 那是 #30 那条"顺序"教训的另一个形状：
// 一把探针把自己的前提写在别人的存档状态里，重铺种子之后就读成回归。
const NEED = ["t:automation", "t:electronics", "t:circuit-network", "t:logistics-2", "t:fast-inserter"];
const asList = (xs) => `{${xs.map((x) => `"${x}"`).join(",")}}`;
const readLine = lua(`local f = game.forces.player
local out = {}
for _, key in ipairs(${asList(NEED)}) do
  local kind, name = key:sub(1, 1), key:sub(3)
  local v = nil
  if kind == "t" then local t = f.technologies[name] v = t and t.researched end
  out[#out + 1] = key .. "=" .. tostring(v == true)
end
rcon.print(table.concat(out, " "))`);
const before = {};
for (const tok of String(readLine).trim().split(/\s+/)) {
  const i = tok.indexOf("="); if (i > 0) before[tok.slice(0, i)] = tok.slice(i + 1) === "true";
}
// 表字面量先在 JS 里拼好再递进去：`dev/lua_templates.py` 不收嵌在插值里的模板串。
const luaSet = (on) => "{" + Object.keys(before).map((k) =>
  `["${k}"]=${on ? "true" : (before[k] ? "true" : "false")}`).join(",") + "}";
const writeState = (on) => lua(`local f = game.forces.player
local set = ${luaSet(on)}
for key, val in pairs(set) do
  local kind, name = key:sub(1, 1), key:sub(3)
  if kind == "t" then local t = f.technologies[name] if t then t.researched = val end end
end
rcon.print("ok")`);
console.log("  借来的研究: " + Object.keys(before).join(" ") + "（跑完还回去）");
writeState(true);
// 研究借来就要还，被 kill 也要还（这一套从前不借，是因为它假设面板已研究；借了就得负责）。
if (!process.env.TRS_KEEP) onExit(() => { writeState(false); });

// 过程中读一次：arch-lab 上每台组装机自己的状态，翻成名字。**逐台那份是这一把的全部意义** ——
// 整条线的产率答不了"哪一排没接到料"，逐台的 (x,y,状态) 才答得了。
const SAMPLE_LUA = `local s = game.surfaces["arch-lab"]
local rev = {}
for k, v in pairs(defines.entity_status) do rev[v] = k end
local n, busy = 0, 0
local one = {}
for _, e in ipairs(s.find_entities_filtered{type = "assembling-machine"}) do
  n = n + 1
  local st = rev[e.status] or tostring(e.status)
  if st == "working" or st == "crafting" then busy = busy + 1 end
  one[#one + 1] = string.format("%.0f,%.0f=%s", e.position.x, e.position.y, st)
end
local belts, onbelts = 0, 0
for _, e in ipairs(s.find_entities_filtered{type = "transport-belt"}) do
  belts = belts + 1
  local c = 0
  pcall(function() c = e.get_item_count() end)
  onbelts = onbelts + (tonumber(c) or 0)
end
-- 臂手里攥着没递出去的件：一只不筛东西的臂抓到这台机器暂时不收的件会一直攥着，从此不再取货 ——
-- 那是"带子上有料、机器喊没料"的头一种形状，所以要数一遍。
local arms, held, heldk = 0, 0, {}
for _, e in ipairs(s.find_entities_filtered{type = "inserter"}) do
  arms = arms + 1
  local h = nil
  pcall(function()
    local inv = e.get_inventory(defines.inventory.inserter_hand)
    if inv and inv[1] then h = inv[1].name end
  end)
  if h then held = held + 1; heldk[h] = (heldk[h] or 0) + 1 end
end
local hs = {}
for k, v in pairs(heldk) do hs[#hs + 1] = k .. ":" .. v end
table.sort(hs)
rcon.print(string.format("machines=%d busy=%d belts=%d on_belts=%d arms=%d 攥着件=%d[%s] 逐台[%s]",
  n, busy, belts, onbelts, arms, held, table.concat(hs, " "), table.concat(one, " ")))`;

// 逐台那份拆成 { 排(=y) : {n, working} }：双排的两排就是两个不同的 y。
const sample = (tag) => {
  const line = lua(SAMPLE_LUA);
  console.log(`  ${tag}: ` + line);
  const byRow = {};
  const tail = /逐台\[([^\]]*)\]/.exec(String(line));
  for (const tok of (tail ? tail[1] : "").split(/\s+/)) {
    const mm = /^(-?\d+),(-?\d+)=(\S+)$/.exec(tok);
    if (!mm) continue;
    const y = Number(mm[2]);
    byRow[y] = byRow[y] || { n: 0, working: 0 };
    byRow[y].n = byRow[y].n + 1;
    if (mm[3] === "working" || mm[3] === "crafting") byRow[y].working = byRow[y].working + 1;
  }
  const m = /busy=(\d+)/.exec(String(line));
  return { busy: m ? Number(m[1]) : null, byRow, line };
};

const runOne = (style, machines) => {
  const asked = call("card_example", { recipe: "electronic-circuit", machines, force: "player", style });
  const d = asked.data || {};
  console.log(`\n== ${style} × ${machines} 台 electronic-circuit`);
  if (!asked.ok) { console.log("  牌没铺出来 " + JSON.stringify([asked.code, asked.msg]).slice(0, 240)); return null; }
  const heads = asArr((d.head || {}).signs || []);
  console.log("  头牌 " + heads.length + " 块: "
    + heads.map((h) => asArr(h.lanes).map((l) => l.lane + ":" + l.item).join(" ")).join(" | ")
    + " 铺不出的原因=" + JSON.stringify((d.head || {}).sign_missing || null));
  console.log("  lane_plan=" + JSON.stringify(d.lane_plan || {}).slice(0, 240));
  console.log("  belt_ceiling=" + JSON.stringify(d.belt_ceiling || null).slice(0, 200)
    + " | arm_ceiling=" + JSON.stringify(d.arm_ceiling || null).slice(0, 220));
  call("lab_reset", {});
  const started = call("card_lab", { card: d, seconds: 240, speed: 4 });
  if (!started.ok) { console.log("  台架起不来 " + JSON.stringify([started.code, started.msg]).slice(0, 200)); return null; }
  sleep(14000); const mid = sample("中途");
  sleep(14000); const late = sample("后段");
  const stopped = call("lab_stop", {});
  const done = (stopped.ok && stopped.data) ? stopped.data : (call("lab_status", {}).data || {});
  const v = asArr(done.verdicts)[0] || {};
  console.log("  verdict: 量到 " + v.measured_per_min + "/分 对声称 " + v.claimed_per_min
    + "（ratio " + v.ratio + "） | fed=" + done.fed + " fed_blocked=" + done.fed_blocked);
  return { mid, late, d, v };
};

const P8 = runOne("two-row", 8);
const P4 = runOne("two-row", 4);
const S4 = runOne("stacked", 4);

// 每一排在两次读数里**至少各出现过一次**在造的机器 —— 只有一排接得到料的话，空手那一排两次都是 0，
// 而那正是这一簇从前那个"南半排永远等不到料"的形状 bug。
const rowsSeenWorking = (r) => {
  if (!r) return {};
  const seen = {};
  for (const s of [r.mid, r.late]) {
    for (const [y, v] of Object.entries(s.byRow || {})) {
      seen[y] = seen[y] || { n: 0, ever: 0 };
      seen[y].n = Math.max(seen[y].n, v.n);
      seen[y].ever = Math.max(seen[y].ever, v.working);
    }
  }
  return seen;
};
const p8rows = rowsSeenWorking(P8), p4rows = rowsSeenWorking(P4);
const bothRowsCrafted = (rows) => Object.keys(rows).length === 2
  && Object.values(rows).every((v) => v.n > 0 && v.ever > 0);
check("双排的两排都上得了料（4 台与 8 台：每一排都读到过在造的机器，不是只喂到靠头那一排）",
  !!P8 && !!P4 && bothRowsCrafted(p8rows) && bothRowsCrafted(p4rows),
  JSON.stringify({ p8: p8rows, p4: p4rows }).slice(0, 420));
// 这一条钉的是"**没量过臂**"这件事本身，不是"arm_ceiling 一定在"：两排这一档成品走的是带子，
// 一张一个出口臂都不铺的牌交回 `arm_ceiling = nil` 也是"没量过"。（2026-10-11 夜这一发就栽在这格：
// 断言写成取 `P8.d.arm_ceiling`，而那一发根本没有臂上限可报 ⟹ `JSON.stringify(undefined).slice` 崩，
// 一个仪器自己的洞把整条套件读成 FAIL。）
check("臂那一顶仍然没量过：8 台那一发要么不报 arm_ceiling，要么报的 measured ≠ true",
  !!P8 && (((P8.d || {}).arm_ceiling || {}).measured !== true),
  JSON.stringify(((P8 || {}).d || {}).arm_ceiling || "没有 arm_ceiling（这一档成品不经臂）").slice(0, 260));
// 这一条把"量不到声称值"从双排的账上摘掉：单排同配方同台数也一样不到 —— 所以它不是几何的事。
check("量不到声称值这一半是共有的（单排 4 台与双排 4 台都 < 0.9）",
  !!P4 && !!S4 && Number(P4.v.ratio) < 0.9 && Number(S4.v.ratio) < 0.9,
  JSON.stringify({ pair4: P4 && P4.v, single4: S4 && S4.v }).slice(0, 320));
console.log("  读数并排 busy：双排8 " + JSON.stringify(P8 && [P8.mid.busy, P8.late.busy])
  + " 双排4 " + JSON.stringify(P4 && [P4.mid.busy, P4.late.busy])
  + " 单排4 " + JSON.stringify(S4 && [S4.mid.busy, S4.late.busy]));
if (!process.env.TRS_KEEP) writeState(false);
console.log("  " + lua('rcon.print("paused=" .. tostring(game.tick_paused))'));
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
