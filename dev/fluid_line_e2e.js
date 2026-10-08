// 液体那一侧的门禁：一条喝水的线铺得出来、喂得进去、量得到；铺不出来的那些按名拒，说清卡在哪儿。
//
// 为什么要有这一份：`dev/fluid_row_e2e.js` 已经在 0.61.0 那一删里没了，而 `dev/refusals.js` 里还有几行
// 注释指着它说"那一侧由它断言"。于是一条喝水的线在门禁里其实没人看 —— 而这一趟真查出了两件事：
//   * 台架不给带液体义务的线喂固料（`lane_feeds` 那一步被 `fluid_obligations == 0` 关掉了），机器
//     `no_ingredients`、一口水都不喝，证明水管那一趟于是报"管子没接到机器身上" —— 而实测管子明明接着，
//     机器那只箱体里 200 水满着。台架自己没喂料，却说人家管道画错了。
//   * 一条一直灌满的排管量不出"少了多少"（机器喝一口，下一拍就被补回去），所以证明要按机器自己的箱体读：
//     起点倒空，后面里面有这种流体，就只有这一排送得进去。
//
// 三条坑与全仓库一样：坐标是格子中心；站在 global-electric-network 上的件仍然要一只发电的接口；编译失败
// 的 /c 回答空字符串。科技是借来的，每条退出路径都要还回去（留着的话下一个套件看到的科技就不是它以为的）。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("fluid_line_e2e");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const call = (m, a) => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RAW: "1" } });
  } catch (e) { return { ok: false, code: "HARNESS", msg: String((e && e.stderr) || e).slice(0, 160) }; }
  try { return JSON.parse(out.trim()); } catch (e) { return { ok: false, code: "PARSE", msg: out.slice(0, 160) }; }
};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", maxBuffer: 1 << 26, env: ENV }).trim();
  } catch (e) { return "LUA_HARNESS: " + String((e && e.stderr) || e).slice(0, 120); }
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const asArr = (v) => (Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : []));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 400)}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------- 借科技
const WANTED_TECH = ["automation", "automation-2", "chemistry", "concrete", "circuit-network",
  "oil-processing", "sulfur-processing", "advanced-material-processing"];
const WANTED_RECIPES = ["assembling-machine-2", "chemical-plant", "pipe", "storage-tank",
  "concrete", "sulfur", "lubricant", "solid-fuel-from-light-oil", "display-panel"];
const techState = () => lua(`local f = game.forces.player
local on = {}
for _, n in ipairs({ "${WANTED_TECH.join('", "')}" }) do
  local t = f.technologies[n]
  if t and t.researched then on[#on+1] = n end
end
rcon.print(table.concat(on, ","))`).split("\n").map((l) => l.trim()).filter((l) => l && l !== "OK").pop() || "";
const wasOn = new Set(String(techState()).split(",").filter(Boolean));
lua(`local f = game.forces.player
for _, n in ipairs({ "${WANTED_TECH.join('", "')}" }) do
  local t = f.technologies[n]
  if t then t.researched = true end
end
for _, nm in ipairs({ "${WANTED_RECIPES.join('", "')}" }) do
  local r = f.recipes[nm]
  if r then r.enabled = true end
end
local t = f.technologies["concrete"]
rcon.print("concrete=" .. (t and tostring(t.researched) or "absent"))`);
const finish = (code) => {
  call("lab_reset", {});
  const back = Array.from(wasOn);
  // 还回去：只留原来就在的那几样
  lua(`local f = game.forces.player
local keep = {}
for _, n in ipairs({ "${back.join('", "')}" }) do keep[n] = true end
for _, n in ipairs({ "${WANTED_TECH.join('", "')}" }) do
  local t = f.technologies[n]
  if t then t.researched = keep[n] == true end
end
rcon.print("returned")`);
  process.exit(code);
};

// ---------------------------------------------------------------- 一台机器的喝水线
const one = call("card_example", { recipe: "concrete", machines: 1, style: "stacked", force: "player" });
check("一条喝水的单机器线铺得出来：牌上点名的流体、管子、接口都在卡上",
  one.ok && asArr(one.data.fluid_in).length === 1
    && one.data.fluid_in[0].fluid === "water" && one.data.fluid_in[0].pipe
    && (one.data.parts || {}).pipes >= 2 && (one.data.parts || {}).chests === 0,
  JSON.stringify([one.code, one.msg, one.data && one.data.fluid_in, one.data && one.data.parts]));

// 管子站的那一格，必须真的贴在机器那只箱体在它**点名那一面**的外沿上（否则就是"铺得出但不生产"那一类
// 老错）。这里按原型尺寸算箱体：一台 3×3 的组装机，牌上说的位置是格中心，把它当 1×1 数邻格会算错。
const sizeOf = (name) => {
  const got = lua(`local p = prototypes.entity["${name}"]
rcon.print(p and (tostring(p.tile_width) .. "x" .. tostring(p.tile_height)) or "1x1")`)
    .split("\n").map((l) => l.trim()).filter((l) => l && l !== "OK").pop() || "";
  const m = String(got).match(/^(\d+)x(\d+)$/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1, h: 1 };
};
const rawCells = (d) => asArr(d.entities).map((e) => ({ name: e.name, x: e.position.x, y: e.position.y }));
const laid = one.ok ? rawCells(one.data) : [];
const machine = laid.filter((c) => /assembling-machine|chemical-plant|furnace/.test(c.name))[0];
const pipes = laid.filter((c) => /^pipe$/.test(c.name));
const boxOf = (c) => {
  const sz = sizeOf(c.name);
  const left = Math.floor(c.x - sz.w / 2), top = Math.floor(c.y - sz.h / 2);
  return { left, top, right: left + sz.w - 1, bottom: top + sz.h - 1 };
};
const face = one.ok ? (asArr(one.data.fluid_in)[0] || {}).face : null;
const onFace = (pipeCell, mb) => {
  const px = Math.floor(pipeCell.x), py = Math.floor(pipeCell.y);
  const inX = px >= mb.left && px <= mb.right, inY = py >= mb.top && py <= mb.bottom;
  if (face === "north") return inX && py === mb.top - 1;
  if (face === "south") return inX && py === mb.bottom + 1;
  if (face === "west") return inY && px === mb.left - 1;
  if (face === "east") return inY && px === mb.right + 1;
  return false;
};
check("...而那一排管子的一头确实贴在机器点名那一面的外沿上（不是隔空画线）",
  !!machine && !!face && pipes.length >= 2 && pipes.some((p) => onFace(p, boxOf(machine))),
  JSON.stringify([face, machine && boxOf(machine), pipes]));

// ---------------------------------------------------------------- 台架量它
const bench = (card, seconds) => {
  call("lab_reset", {});
  let started = call("card_lab", { card, seconds: seconds || 900, speed: 20, force: "player" });
  if (started && started.code === "PLAYER_ONLINE") {
    started = call("card_lab", { card, seconds: seconds || 900, force: "player" });
  }
  if (!started.ok) return { refused: started };
  let st = {};
  for (let i = 0; i < 100; i++) {
    sleep(1500);
    st = call("lab_status", {}).data || {};
    if (st.state && st.state !== "running") return st;
  }
  return { refused: { code: "SUITE_TIMEOUT" } };
};
const ran = one.ok ? bench(one.data) : { refused: { code: "NO_CARD" } };
check("...而它在台架上真的被喂进了固料（不是“这条线没有料”）",
  !ran.refused && (ran.fed || 0) > 0 && (ran.fed_blocked || 0) === 0,
  JSON.stringify([ran.refused && ran.refused.code, ran.fed, ran.fed_blocked, ran.state]));
check("...喝水那一路被证明（没有 supply_problems），并且真的造出了成品",
  !ran.refused && asArr(ran.supply_problems).length === 0 && (ran.produced || 0) > 0
    && (ran.measured_per_min || 0) > 0 && ran.state === "done",
  JSON.stringify([ran.state, ran.produced, ran.measured_per_min, ran.supply_problems,
    ran.refused && ran.refused.code]));
const claim = one.ok ? Object.values((one.data.contract || {}).outputs || {})[0] || 0 : 0;
check("...量到的产率贴着牌上那个数（一半以上，且不是零）",
  (ran.measured_per_min || 0) >= 0.5 * claim && claim > 0,
  JSON.stringify([claim, ran.measured_per_min]));

// ---------------------------------------------------------------- 铺不出来的那些，按名拒
const two = call("card_example", { recipe: "concrete", machines: 2, style: "stacked", force: "player" });
check("两台机器的喝水线按名拒，并点名是哪一件站在管子要走的那一格上",
  !two.ok && two.code === "LANE_FEED_ROW_UNREACHABLE"
    && (two.detail || {}).blocked && (two.detail.blocked || {}).taken_by
    && (two.detail.blocked || {}).cell && (two.detail || {}).face,
  JSON.stringify([two.code, two.detail]).slice(0, 300));
check("...而它说的是形状的事，不是“这存档没管子”：点名带子/臂站在哪、机器喝哪一面",
  !two.ok && /stacked|two-row/.test(String((two.detail || {}).style))
    && !!two.detail.machine && String(two.msg).length > 20,
  JSON.stringify([two.detail && two.detail.style, two.detail && two.detail.machine, two.msg]));

// 三个拒因在**这一台安装**上都有样本（从前 DEFENSIVE/TODO 里写着"这存档造不出来"，那是指着已删的套件
// 说的）：管子内行被形状自己的臂占了、机器箱体那一格被占了、双排那种"两排机器各在一行"。它们都藏在
// 同一个外层码里，所以钉的是 `detail.blocked.why` —— 外层码只说"这排管子铺不下去"，那句是给玩家的。
for (const [ask, why] of [[{ recipe: "concrete", machines: 2, style: "stacked" }, "FEED_ROW_TAKEN"],
  [{ recipe: "solid-fuel-from-light-oil", machines: 1, style: "stacked" }, "FEED_CELL_TAKEN"],
  [{ recipe: "concrete", machines: 2, style: "two-row" }, "FEED_SPAN_MULTIPLE_LINES"]]) {
  const r = call("card_example", { ...ask, force: "player" });
  check(`...而它点名的是哪一种：${ask.recipe} / ${ask.machines} 台 / ${ask.style} 落在 ${why}`,
    !r.ok && r.code === "LANE_FEED_ROW_UNREACHABLE" && (r.detail || {}).blocked
      && r.detail.blocked.why === why && !!r.detail.blocked.face
      && (!!r.detail.blocked.taken_by || !!r.detail.blocked.other_line),
    JSON.stringify([r.code, r.detail && r.detail.blocked]).slice(0, 240));
}

// ---------------------------------------------------------------- 蓝图那一路（压线 → 字符串）
// 玩家问的是"有液体的配方能不能出蓝图"，所以这里钉的是压线那一扇门，不是卡片自己。
const press = (count) => call("helmod_ghosts", {
  plan: [{ name: "assembling-machine-2", count, recipe: "concrete" }],
  into: "string", style: "stacked", force: "player" });
const bp1 = press(1);
const p1 = (bp1.data || {}).parts || {};
// 压线那一路的 `parts` 是"名字→件数"，不是卡片那种按角色分的表（同一个答案在两个门里长两样，
// 这里就按它自己的样子数）。
check("一台组装机做混凝土：压线出得来蓝图字符串，里面真的带管道（那一格是留给玩家自己水管接的口子）",
  bp1.ok && (bp1.data.bytes || 0) > 0 && (p1.pipe || 0) >= 2 && (bp1.data.held || 0) >= 10
    && asArr(bp1.data.lanes).length === 1
    && Object.keys(p1).every((k) => !/chest/.test(k)) && (p1["transport-belt"] || 0) >= 4,
  JSON.stringify([bp1.code, bp1.msg, bp1.data && bp1.data.bytes, p1]).slice(0, 240));
const bp2 = press(2);
const p2 = (bp2.data || {}).parts || {};
check("两台组装机做混凝土：交回来的是散件加拒因，不是一张空蓝图",
  (bp2.ok && asArr(bp2.data.lane_fallback).length >= 1
      && bp2.data.lane_fallback[0].why === "LANE_FEED_ROW_UNREACHABLE"
      && (bp2.data.held || 0) >= 1 && (bp2.data.bytes || 0) > 0
      && (p2["transport-belt"] || 0) === 0)
    || (!bp2.ok && /LANE_FEED_ROW_UNREACHABLE/.test(JSON.stringify(bp2.detail || bp2.msg))),
  JSON.stringify([bp2.code, p2, bp2.data && bp2.data.lane_fallback
    && bp2.data.lane_fallback[0] && bp2.data.lane_fallback[0].why]).slice(0, 240));

const out = call("card_example", { recipe: "lubricant", machines: 1, style: "stacked", force: "player" });
check("吐流体的配方按名拒，并说清是“产出”那一侧没路",
  !out.ok && out.code === "LANE_CARRIES_NO_FLUIDS" && (out.detail || {}).kind === "out"
    && (out.detail || {}).fluid === "lubricant",
  JSON.stringify([out.code, out.detail]).slice(0, 260));

const many = call("card_example", { recipe: "sulfur", machines: 1, style: "stacked", force: "player" });
check("一种以上的进料流体按名拒（两条互不相碰的管子这一档铺不出来）",
  !many.ok && many.code === "LANE_FEEDS_ONE_FLUID" && asArr((many.detail || {}).fluids).length >= 2,
  JSON.stringify([many.code, many.detail, many.msg]).slice(0, 260));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
finish(fail ? 1 : 0);
