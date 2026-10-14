// 挑机器按"铺得出"，不按"最快"（他 2026-10-14 裁的那一句："硫酸就按铺的出吧"）。
//
// 为什么这一趟必须存在：`card_example` 挑机器从前只按 `crafting_speed desc` 拿最快那一台，而**快的那台
// 脚程深**。硫酸那一发量的就是它：`cryogenic-plant` 深 5 格、进料面与成品面各被管道占掉一格 ⟹ 一个面
// 只叠得起一条带，而两种料各要一股就要两条 ⟹ 2 台就报 `LINES_BEYOND_SHAPE`，拒因写的是形状的话，
// 而真正铺不出的是那台机器的脚。同一张配方跑得动的 `chemical-plant` 浅一点，2 台、3 台都铺得出。
//
// 这套钉四件事，每件都要从**答案自己**读回来，不许我替它宣布：
//   1. 不点名时这条线铺得出，落地的机器是浅的那台，并且答案带着"从哪台换到哪台、为什么、试过哪几台"；
//   2. 换过去的这台**确实比原来那台慢**（原型上量 `crafting_speed`）—— 不然这一改什么都没换；
//   3. 点名的旋钮还在：点名浅的那台照样铺得出；点名深的那台**仍按名拒**，而且不许留下换机器的痕迹
//      （"点名不许被背着换"是这一档 mod 的底线，比"铺得出"更高）；
//   4. 最快那台本来就铺得出时**不许换**（这一改是"铺不出才换下一台"，不是把快的那条规则废掉）。
//
// 借的研究全部点名，进来先读原值、出去按原值还（被 kill 也还，`suite-guard` 那一道钩子）。
// 2026-10-11 那次全量就是因为有套件靠"存档碰巧开着化工厂"过关，还研究的人一还就把下一套的地基抽走了。
//
// 用法：bash dev/test.sh node dev/machine_lays_probe.js
const { execFileSync } = require("child_process");
const path = require("path");
const { onExit } = require("./suite-guard.js");
require("./suite-guard.js").guardMain("machine_lays_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "30000" };
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 300) }; }
};
const lua = (src) => execFileSync("node", [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV }).trim();
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 500)}`);
  ok ? pass++ : fail++;
};

// 深的那台、浅的那台、以及它们各自的科技；名字写死是故意的 —— 这一套量的就是"这一台比那一台慢但铺得出"
// 这一对具体关系，换一个安装上换一对机器就该由这套自己红出来，而不是悄悄量别的。
const DEEP = "cryogenic-plant";      // 快、深 5、两面各被管道占一格
const SHALLOW = "chemical-plant";    // 慢一点、浅，同一张硫酸配方跑得动
const BORROW = [DEEP, SHALLOW, "oil-processing", "sulfur-processing", "sulfuric-acid",
  "fluid-handling", "automation-2", "automation-3", "long-handed-inserter",
  "circuit-network", "display-panel"];

const snap = lua(`local f = game.forces.player
local out = {}
for _, n in ipairs{${BORROW.map((n) => '"' + n + '"').join(",")}} do
  local t = f.technologies[n] local r = f.recipes[n]
  out[#out + 1] = n .. "=" .. tostring(t and t.researched or false) .. "," .. tostring(r and r.enabled or false)
end
rcon.print(table.concat(out, " "))`);
const state = (line) => {
  const o = {};
  for (const tok of String(line || "").trim().split(/\s+/)) {
    const i = tok.indexOf("="); if (i < 0) continue;
    const bits = tok.slice(i + 1).split(",");
    o[tok.slice(0, i)] = { t: bits[0] === "true", r: bits[1] === "true" };
  }
  return o;
};
const BEFORE = state(snap);
const TABLE = "{" + Object.entries(BEFORE).map(([k, v]) =>
  `["${k}"]={t=${v.t ? "true" : "false"},r=${v.r ? "true" : "false"}}`).join(",") + "}";
const restore = () => lua(`local f = game.forces.player
local set = ${TABLE}
for n, v in pairs(set) do
  local t = f.technologies[n] if t then t.researched = v.t end
  local r = f.recipes[n] if r then r.enabled = v.r end
end
rcon.print("restored " .. tostring(next(set) ~= nil))`);

check("借的每一项都读回了原值（读不到就不许动这个世界）",
  Object.keys(BEFORE).length === BORROW.length,
  JSON.stringify([BORROW.length, Object.keys(BEFORE), String(snap).slice(0, 200)]));

lua(`local f = game.forces.player
for _, n in ipairs{${BORROW.map((n) => '"' + n + '"').join(",")}} do
  local t = f.technologies[n] if t then t.researched = true end
  local r = f.recipes[n] if r then r.enabled = true end
end
rcon.print("granted")`);
onExit(restore);

// 借来的东西必须真的在：这一套的全部断言都靠"深的那台在这儿、而且是阶梯里最快那台"。
// 借不到就红在这一格，而不是让后面每一条都读成"没换机器"。
// 速度这一格要按这台构建上的读法来：`LuaEntityPrototype.crafting_speed` **不存在**（实测 raise
// "doesn't contain key crafting_speed"），能读的是那个 getter，而且它得**点号调用、不传 self**
// （`a:get_crafting_speed()` 报 "Invalid QualityID"，`getter(p, "get_crafting_speed")` 那种写法才回数）——
// 与本 mod `build_model` 用的是同一只手。
const both = lua(`local a=prototypes.entity["${DEEP}"] local b=prototypes.entity["${SHALLOW}"]
if not a or not b then rcon.print("absent") return end
local function speed(p)
  local fn = p.get_crafting_speed
  if type(fn) ~= "function" then return -1 end
  local ok, v = pcall(fn)
  return ok and tonumber(v) or -1
end
local f=game.forces.player
rcon.print(table.concat({
  tostring(speed(a)), tostring(speed(b)),
  tostring(a.tile_width) .. "x" .. tostring(a.tile_height),
  tostring(b.tile_width) .. "x" .. tostring(b.tile_height),
  tostring(f.recipes["${DEEP}"] and f.recipes["${DEEP}"].enabled),
  tostring(f.recipes["${SHALLOW}"] and f.recipes["${SHALLOW}"].enabled) }, " "))`);
// `dev/lua.js` 的回话尾巴带一行 `OK`（那是哨兵，不是读数）—— 不摘掉它，这里就是六个数变七个，
// 而这套自己会因为一个标点红（本项目在别的套件上为这一行摔过一次：最后一块牌的 JSON 被 `OK` 粘住）。
const fig = String(both).trim().split(/\s+/).filter((x) => x !== "OK");
check(`${DEEP} 与 ${SHALLOW} 都在这台安装上、都开着，而前者的的确比后者快`,
  both !== "absent" && fig.length === 6 && fig[4] === "true" && fig[5] === "true"
    && Number(fig[0]) > Number(fig[1]),
  both);
console.log(`  读数：${DEEP} speed=${fig[0]} 占地 ${fig[2]}；${SHALLOW} speed=${fig[1]} 占地 ${fig[3]}`);

// ---------------------------------------------------------------- 1. 不点名：换成铺得出的那台
const auto = call("card_example", { recipe: "sulfuric-acid", machines: 2, heads: "belt", force: "player" });
const ad = auto.data || {};
check("硫酸 2 台不点名时铺得出（从前这一发是 LINES_BEYOND_SHAPE，他裁的就是这一格）",
  auto.ok === true && (ad.parts || {}).machines === 2,
  JSON.stringify([auto.code, auto.msg, ad.style, ad.parts]).slice(0, 400));
const laid = (ad.components || {}).furnace;
const swap = ad.machine_by_laying || null;
check("...而落地的机器是那台**浅的**（跑得动同一张配方、脚程叠得起两条带）",
  laid === SHALLOW, JSON.stringify([laid, ad.components]).slice(0, 260));
check("...换机器这件事写在答案里：从哪台、换到哪台、为什么、试过哪几台，四样都在",
  !!swap && swap.first === DEEP && swap.used === SHALLOW
    && asArr(swap.tried).length >= 2 && String(swap.because || "").length > 20
    && swap.code === "LINES_BEYOND_SHAPE",
  JSON.stringify(swap).slice(0, 420));
// 那句"这台机器是怎么挑出来的"（`components_how.machine`）以前在落回之后还是内层那次调用写的
// "preferred name, and it is placeable here" —— 玩家没点过任何东西，那句就是假话。
check("...而那句「怎么挑的机器」说的是按铺得出，不是「你点名的那台」",
  /铺得出/.test(String((ad.components_how || {}).machine || ""))
    && !/preferred name/.test(String((ad.components_how || {}).machine || "")),
  String((ad.components_how || {}).machine || "").slice(0, 300));

// -------------------------------------------------------------------- 2. 点名的旋钮还在
const pinnedShallow = call("card_example", { recipe: "sulfuric-acid", machines: 2, heads: "belt",
  machine: SHALLOW, force: "player" });
check("点名要那台浅的：照样铺得出，而且不写换机器（他没换任何东西）",
  pinnedShallow.ok === true && !(pinnedShallow.data || {}).machine_by_laying
    && (pinnedShallow.data || {}).components && ((pinnedShallow.data || {}).components || {}).furnace === SHALLOW,
  JSON.stringify([pinnedShallow.code, (pinnedShallow.data || {}).machine_by_laying,
    ((pinnedShallow.data || {}).components || {})]).slice(0, 300));

const pinnedDeep = call("card_example", { recipe: "sulfuric-acid", machines: 2, heads: "belt",
  machine: DEEP, force: "player" });
check("点名要那台深的：**仍按名拒**，而且不许留下换机器的痕迹（点名不许被背着换，这条排在铺得出前面）",
  pinnedDeep.ok === false && pinnedDeep.code === "LINES_BEYOND_SHAPE"
    && !(pinnedDeep.detail || {}).machine_by_laying
    && !(pinnedDeep.detail || {}).machines_tried,
  JSON.stringify([pinnedDeep.code, pinnedDeep.msg,
    (pinnedDeep.detail || {}).machines_tried]).slice(0, 400));

// ---------------------------------------------------------- 3. 最快那台铺得出时不许动它
const easy = call("card_example", { recipe: "electronic-circuit", machines: 2, heads: "belt",
  force: "player" });
const ed = easy.data || {};
check("...而最快那台本来就铺得出的配方，一台机器都不换（这一改是「铺不出才换」，不是废掉快的那条）",
  easy.ok === true && !ed.machine_by_laying && !/铺得出/.test(String((ed.components_how || {}).machine || "")),
  JSON.stringify([easy.code, ed.machine_by_laying, (ed.components || {}),
    (ed.components_how || {}).machine]).slice(0, 340));

// 换机器这件事不能只在这发硫酸上成立一次：把台数往上加，答案要么铺得出、要么按名拒，
// 不许出现"换了机器却没说"的那一格。
// 台数扫一遍：1 台时深的那台本来铺得出（不该换），2 台起它铺不出（该换并且要说）。
// 这一格钉的是**换与说必须同时**：换了不说，玩家看到的是一台他没挑过的机器；说了但没换，答案是虚话。
let mismatched = [];
for (const n of [1, 2, 3]) {
  const r = call("card_example", { recipe: "sulfuric-acid", machines: n, heads: "belt", force: "player" });
  const d = r.data || {};
  const landed = ((d.components || {}).furnace) || null;
  const said = !!d.machine_by_laying;
  if (!r.ok) { mismatched.push(n + " 台没铺出：" + String(r.code)); continue; }
  if (said && (d.machine_by_laying.used || "") !== landed) mismatched.push(n + " 说了换到 " + d.machine_by_laying.used + " 落地的是 " + landed);
  if (!said && landed === SHALLOW) mismatched.push(n + " 落地的是浅的那台却没说为什么（第 1 台本可以是深的那台）");
}
check("台数 1..3 各要一发：换没换机器与答案里那句话每次都对得上",
  mismatched.length === 0, JSON.stringify(mismatched).slice(0, 300));

const back = restore();
check("借的研究按读回来的那一份还回去了", /restored true/.test(String(back)), back);
const after = state(lua(`local f = game.forces.player
local out = {}
for _, n in ipairs{${BORROW.map((n) => '"' + n + '"').join(",")}} do
  local t = f.technologies[n] local r = f.recipes[n]
  out[#out + 1] = n .. "=" .. tostring(t and t.researched or false) .. "," .. tostring(r and r.enabled or false)
end
rcon.print(table.concat(out, " "))`));
const drift = Object.keys(BEFORE).filter((k) =>
  !after[k] || after[k].t !== BEFORE[k].t || after[k].r !== BEFORE[k].r);
check("...而且是**照原值**还的（每一项与进来前那条读数一模一样，不清零）",
  drift.length === 0, JSON.stringify([drift, BEFORE[DEEP], after[DEEP]]));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
