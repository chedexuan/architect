// 「把模块装上」那扇门的门禁：`machine_modules`。
//
// 这扇门为什么单独存在：压线交出去的是**虚影与蓝图**，而虚影身上装不了模块（2026-10-09 实测：
// `ghost.get_inventory(defines.inventory.crafter_modules)` 是 nil，2.0 也没有 `set_module_info`；
// 建成真机器之后可以 —— 模块库存的 `insert` 收东西）。0.74.0 只能把"这一页欠哪些模块"说出来，
// 这一扇是他建完之后把那份账兑现的地方。
//
// 它钉的四件事：
//   1. 装得上去，而且**是从箱子里拿出来的**（前后一减要对得上，一个模块都不会凭空多或凭空少）；
//   2. 再按一次不动手（幂等：已经装了的不重复装，也不"补齐到上限"）；
//   3. 装不上时要分清两种"没装上"：拿不到（去补货）与机器不收（槽位/上限），两者修法相反；
//   4. 虚影那一半如实数出来并说清为什么装不了，而不是安静地少装几台。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("modules_e2e");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016" };
const call = (m, a) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RAW: "1" } });
    return JSON.parse(out.slice(out.indexOf("{")));
  } catch (e) { return { ok: false, code: "HARNESS", msg: String((e && e.stderr) || e).slice(0, 200) }; }
};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 28 }).trim();
  } catch (e) { return "probe failed: " + String((e && e.stderr) || e).slice(0, 160); }
};
const unwrap = (r) => (r && r.data ? r.data : r || {});
const asArr = (v) => (Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : []));
const num = (v) => (typeof v === "number" ? v : NaN);
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log("  ok   " + name); }
  else { fail += 1; console.log("  FAIL " + name + " -- " + String(detail).slice(0, 340)); }
};

const SURF = "nauvis";
// 自己的一片地，离出生点和其它套件的夹具都远：这一套要真放机器、真搬东西。
const AT = { x: 1192, y: 1192 };
const AREA = { x1: 1188, y1: 1188, x2: 1216, y2: 1206 };
const AREA_STR = `{{${AREA.x1},${AREA.y1}},${"{" + AREA.x2 + "," + AREA.y2 + "}"}}`;
const box = (a) => JSON.stringify({ x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2 });

const clear = () => lua(`local s = game.surfaces["${SURF}"]
local n = 0
for _, e in ipairs(s.find_entities_filtered{ area = ${AREA_STR} }) do
  if e.valid then e.destroy(); n = n + 1 end
end
rcon.print("cleared=" .. n)`);

// 一台空机器 + 一只装了模块的箱子。模块数量给得**比计划多**：这样"拿不到"那条路要单独造，
// 不会和这一条混在一起过。
const fixture = (speed, prod) => lua(`local s = game.surfaces["${SURF}"]
local a1 = s.create_entity{name = "assembling-machine-3", position = { x = ${AT.x}, y = ${AT.y} }, force = "player"}
local a2 = s.create_entity{name = "assembling-machine-3", position = { x = ${AT.x + 4}, y = ${AT.y} }, force = "player"}
local ch = s.create_entity{name = "steel-chest", position = { x = ${AT.x + 8}, y = ${AT.y + 8} }, force = "player"}
if a1 then pcall(function() a1.set_recipe("electronic-circuit") end) end
if a2 then pcall(function() a2.set_recipe("electronic-circuit") end) end
if ch then
  ch.insert({ name = "speed-module", count = ${speed} })
  ch.insert({ name = "productivity-module", count = ${prod} })
end
rcon.print("built " .. tostring(a1 and a1.unit_number) .. "," .. tostring(a2 and a2.unit_number)
  .. " chest " .. tostring(ch and ch.unit_number))`);
const unitOf = (text) => (String(text).match(/built (\d+),(\d+)/) || []).slice(1, 3).map(Number);
const readModules = (unit) => lua(`local s = game.surfaces["${SURF}"]
local got = nil
for _, e in ipairs(s.find_entities_filtered{ area = ${AREA_STR}, name = "assembling-machine-3" }) do
  if e.unit_number == ${unit} then got = e end
end
if not got then rcon.print("no machine") return end
local inv = got.get_inventory(defines.inventory.assembling_machine_modules)
rcon.print("speed=" .. inv.get_item_count("speed-module") .. " prod=" .. inv.get_item_count("productivity-module"))`);
const readChest = () => lua(`local s = game.surfaces["${SURF}"]
local ch = nil
for _, e in ipairs(s.find_entities_filtered{ area = ${AREA_STR}, type = "container" }) do ch = e end
if not ch then rcon.print("none") return end
local inv = ch.get_inventory(defines.inventory.chest)
rcon.print("speed=" .. inv.get_item_count("speed-module") .. " prod=" .. inv.get_item_count("productivity-module"))`);
const counts = (text) => {
  const m = String(text).match(/speed=(\d+) prod=(\d+)/);
  return m ? { speed: Number(m[1]), prod: Number(m[2]) } : { speed: NaN, prod: NaN };
};

const PLAN = [{
  machine: "assembling-machine-3", recipe: "electronic-circuit",
  modules: [{ item: "speed-module", count: 2 }, { item: "productivity-module", count: 1 }],
}];
const press = (extra) => call("machine_modules", Object.assign({
  surface: SURF, force: "player", area: AREA, modules: PLAN,
}, extra || {}));

// ------------------------------------------------------------------ 0. 门在不在
clear();
const hello = press({ from: "none" });
check("这一扇门锁得住没有计划的情况：一片空地上没有机器也不报错，只是什么都不装",
  hello.ok === true && num(unwrap(hello).machines) === 0,
  JSON.stringify([hello.code, hello.msg, unwrap(hello).machines]).slice(0, 240));

// ------------------------------------------------------------------ 1. 装得上去，且东西是从箱子里来的
const built = fixture(10, 4);
const [u1, u2] = unitOf(built);
const before = counts(readChest());
const put = press({ from: "chests" });
const pd = unwrap(put);
const rows = asArr(pd.by_machine);
check("两台真机器各装上计划里那一份：2 个速度 + 1 个 productivity，共 6 个",
  put.ok === true && num(pd.machines) === 2 && num(pd.with_module_slots) === 2
    && num(pd.installed) === 6 && rows.length === 2
    && rows.every((r) => asArr(r.put).reduce((a, e) => a + e.count, 0) === 3
      && asArr(r.missing).length === 0),
  JSON.stringify([put.code, pd.machines, pd.installed, rows.map((r) => [r.put, r.missing])]).slice(0, 340));
const after = counts(readChest());
const m1 = counts(readModules(u1)), m2 = counts(readModules(u2));
check("东西不是凭空造的：箱子里少的 6 个正好等于机器身上多的 6 个",
  before.speed - after.speed === 4 && before.prod - after.prod === 2
    && m1.speed === 2 && m1.prod === 1 && m2.speed === 2 && m2.prod === 1,
  JSON.stringify([before, after, m1, m2]).slice(0, 260));
check("答案说清了这一趟从哪些手拿的（箱子按 unit_number 排，不靠现场猜）",
  asArr(pd.sources).length === 1 && /chest \d+/.test(String((pd.sources || [])[0])),
  JSON.stringify([pd.sources, pd.from]).slice(0, 200));

// ------------------------------------------------------------------ 2. 再按一次不动手
const again = unwrap(press({ from: "chests" }));
const afterAgain = counts(readChest());
check("幂等：已经装了的不重复装，也不去把它塞满到上限",
  again.installed === undefined && again.missing === undefined
    && asArr(again.by_machine).every((r) => asArr(r.already).length === 2 && asArr(r.put).length === 0)
    && afterAgain.speed === after.speed && afterAgain.prod === after.prod,
  JSON.stringify([again.installed, again.missing, asArr(again.by_machine).map((r) => [r.already, r.put]),
    afterAgain]).slice(0, 320));

// ------------------------------------------------------------------ 3. 两种"没装上"分开说
// 缺口有两种，修法正好相反：箱子里没有（去补货）与机器不收（槽位/模块上限，少装几个）。
// 合成一个数字就是让玩家自己猜该去补哪一头 —— 所以两条各造一次现场，各自断言。
clear();
const shortFixture = fixture(2, 0);           // 箱子里只有 2 个速度模块，prod 一个都没有
const [s1] = unitOf(shortFixture);
const shorty = unwrap(press({ from: "chests",
  modules: [{ machine: "assembling-machine-3", recipe: "electronic-circuit",
    modules: [{ item: "speed-module", count: 2 }, { item: "productivity-module", count: 2 }] }] }));
const shortRows = asArr(shorty.by_machine);
check("拿不到就说拿不到：把箱子里那点货全装上，缺口只算『箱子里没有』，不混进『机器不收』",
  shortRows.length === 2 && shortRows.every((r) =>
    asArr(r.missing).every((e) => !e.refused)
    && asArr(r.missing).reduce((a, e) => a + e.count, 0) > 0)
    && num(shorty.missing) === 6 && num(shorty.installed) === 2
    // 箱子里只有 2 个速度模块：第一台拿到，第二台空手 —— 这是"补货"问题，不是"少装几个"问题，
    // 所以两台都不许出现 `refused`。
    && asArr(shortRows[0].put).length === 1 && asArr(shortRows[1].put).length === 0,
  JSON.stringify([shorty.installed, shorty.missing, shortRows.map((r) => [r.put, r.missing])]).slice(0, 340));
check("而 `from = none` 只查不装：缺口一样报出来，箱子与机器身上的数一个都不动",
  (() => {
    const chestBefore = JSON.stringify(counts(readChest()));
    const machBefore = JSON.stringify(counts(readModules(s1)));
    const q = unwrap(press({ from: "none",
      modules: [{ machine: "assembling-machine-3", recipe: "electronic-circuit",
        modules: [{ item: "productivity-module", count: 3 }] }] }));
    return num(q.missing) === 6 && q.installed === undefined
      && chestBefore === JSON.stringify(counts(readChest()))
      && machBefore === JSON.stringify(counts(readModules(s1)));
  })(),
  JSON.stringify([counts(readChest()), counts(readModules(s1))]).slice(0, 200));
clear();
const overFixture = fixture(12, 0);            // 货够，机器的上限不够
const [o1] = unitOf(overFixture);
const over = unwrap(press({ from: "chests",
  modules: [{ machine: "assembling-machine-3", recipe: "electronic-circuit",
    modules: [{ item: "speed-module", count: 8 }] }] }));
const overRows = asArr(over.by_machine);
const overState = counts(readModules(o1));
const overChest = counts(readChest());
check("机器不收的那种缺口标 `refused`：装到它收得下的为止，剩下的不算成『箱子里没有』",
  overRows.every((r) => asArr(r.missing).every((e) => (e.refused || 0) > 0))
    && asArr(over.by_machine).some((r) => asArr(r.put).length > 0),
  JSON.stringify([over.missing, overRows.map((r) => [r.put, r.missing])]).slice(0, 340));
check("而『不收』的那些放回了箱子：箱子里剩的 + 机器装上的 = 一开始的 12，一个都没凭空消失",
  asArr(over.by_machine).reduce((a, r) =>
    a + asArr(r.put).reduce((x, e) => x + ((e.item === "speed-module") ? e.count : 0), 0), 0)
    + overChest.speed === 12 && asArr(over.by_machine).reduce((a, r) =>
      a + asArr(r.missing).reduce((x, e) => x + e.count, 0), 0) > 0,
  JSON.stringify([overChest, overState, asArr(over.by_machine).map((r) => r.put)]).slice(0, 300));

// ------------------------------------------------------------------ 4. 虚影装不了，如实数出来
clear();
const ghosts = unwrap(call("helmod_ghosts", { into: "ground", surface: SURF, origin: { x: AT.x, y: AT.y },
  width: 20, plan: [{ entity: "assembling-machine-3", recipe: "electronic-circuit", count: 2 }] }));
// 点名 am3 而这一发放得下的是 am1 —— 虚影是**换成的那台**的（`lanes[0].machine`），计划里点名的那台
// 在地上根本不存在。所以这一格要按地上真的有什么来问，否则就是在测一个不存在的场景。
const ghostMachine = (asArr(ghosts.lanes)[0] || {}).machine || "assembling-machine-3";
fixture(4, 0);
const gpress = unwrap(press({ from: "chests",
  modules: [{ machine: ghostMachine, recipe: "electronic-circuit",
    modules: [{ item: "speed-module", count: 2 }] }] }));
check("虚影身上装不了模块这一件事是数出来的，不是猜的：那一片里有几台计划里的虚影就说几台",
  ghosts.ghosts > 0 && num(gpress.ghosts) >= 2 && /ghost cannot hold a module/.test(String(gpress.note)),
  JSON.stringify([ghosts.ghosts, ghostMachine, gpress.ghosts, gpress.ghosts_other,
    gpress.note]).slice(0, 320));
// 这一片里同时有 2 台真机器（计划没点它们的名，走 `unplanned`）与 2 台虚影（点了名但装不了，走
// `ghosts`）。两条都不许被算成"装好了"：前者是"这台不在计划里"，后者是"你还没建"。
check("而它不把虚影混进『已装』：真机器没被计划点名就走 unplanned，虚影只报数与理由",
  gpress.installed === undefined && num(gpress.machines) === 2 && num(gpress.unplanned) === 2
    && num(gpress.ghosts) >= 2 && asArr(gpress.by_machine).every((r) => r.unplanned && !r.put),
  JSON.stringify([gpress.machines, gpress.unplanned, gpress.installed, gpress.ghosts,
    asArr(gpress.by_machine).map((r) => [r.unplanned, r.put])]).slice(0, 320));

// ------------------------------------------------------------------ 5. 一片地从哪来
const noArea = call("machine_modules", { surface: SURF, force: "player", modules: PLAN });
check("没给地时用上一次压线记下的那一块（手机上不该再让人框一次），并说是哪来的",
  noArea.ok === true ? ["last press", "args"].indexOf(unwrap(noArea).area_from) >= 0
    : noArea.code === "NO_AREA",
  JSON.stringify([noArea.code, unwrap(noArea).area_from, unwrap(noArea).area]).slice(0, 240));
const noPlan = call("machine_modules", { surface: SURF, force: "player", area: AREA, modules: [] });
check("计划里一个模块都没点，就按名拒，不替玩家猜一套",
  noPlan.ok === false && noPlan.code === "NO_MODULE_PLAN",
  JSON.stringify([noPlan.code, noPlan.msg]).slice(0, 220));

clear();
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
