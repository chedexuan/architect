// The layout ledger, as a suite.
//
// Why it is invariant-shaped rather than a golden blob: the geometry a lane gets also depends on which
// parts this force has unlocked (a stone furnace where a steel one was asked for changes the footprint),
// and a golden file of entity lists fails for reasons that have nothing to do with layout. What is
// checked instead are properties that hold whatever the parts are, plus one claim that only the styles
// layer can answer: that turning a lane turns the shape, and that the engine agrees both shapes can
// stand on real ground.
//
// The refactor this was written for moved the lane geometry from `lane_units` into `styles.lua`. The
// parity question was answered there and then -- 83 cases of before/after compared with part names
// folded to roles, zero unexplained drift -- and this file is what keeps the answer from going stale.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("layout_ledger");

const PORT = process.env.RCON_PORT || "27015";
const ENV = { ...process.env, RCON_PORT: PORT, RCON_PW: process.env.RCON_PW || "m0pw" };
// `RAW=1`, because without it the harness prints the answer's DATA and the envelope -- `ok`, `code`,
// `detail` -- is what a refusal test has to read. Every other suite in this directory passes it; a
// helper that forgot it sees `ok: undefined` on a call that answered perfectly.
const call = (method, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 });
    return JSON.parse(out.trim());
  } catch (e) {
    return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 200) };
  }
};
const asArr = (v) => (Array.isArray(v) ? v : []);

// 问引擎的那只手，放在最上面：借科技那几格（`electric-furnace` 的配方、`circuit-network`）在文件里好几处，
// 而它们都必须在第一次调用之前就把状态摆好 —— 一个定义在下面两百行的 const，上面的代码一碰就是
// "Cannot access before initialization"，整个套件红在一行 JavaScript 上而不是红在事实上。
const luaLine = (src) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV }).trim();
    return out.split("\n").map((l) => l.trim()).filter((l) => l && l !== "OK").pop() || "";
  } catch (e) { return ""; }
};

// 研究这一格：这一套**不**整体打开研究。试过 grant-all，结果是它把机器选择整体换掉
// （`electric-furnace` 那种"最快那一台"变成 `electromagnetic-plant`），一批按机器挑法写的断言反过来红，
// 而三跑的失败名单彼此完全不重叠 —— 那不是几何，是世界状态。真正的问题在别处：`.factorio-test/saves/
// m0-test.zip` 没了，起服脚本会从主存档重新播一份干净世界（`dev/server-test.sh`），所以基线该是"播出来
// 的那份"，而不是某个套件借完研究没还的那份。要借研究的是**单条断言**，像这文件里 electric-furnace /
// circuit-network / steel-furnace 那三处：点名、记下原值、跑完照原值还。
// 这套件要的是「**带子与机组有整条梯子**的世界」：同一份计划在最慢的带上叠不起进料面时，比较两档形状 /
// 数头牌 / 数带行号那几条就读到空表 —— 本存档播出来的那一层只到 `fast-transport-belt` 与
// `assembling-machine-2`（实测），8 台电子线路那种计划当场撞在 `LINES_BEYOND_SHAPE`。
// 只借这两层，**臂不借**：臂是好几条断言的题目本身（点名为臂、按档换臂、`belt_too_slow` 那条也看臂），
// 把 `stack-inserter` 顶上去之后那条"点名那只用在它正好够得着的那一档"就读不到它写的形状了。
// 全开也不行：express 带一进，"带子太慢才提个醒"与"成品带自己涨到 2"那两条的前提就没了。
// 借法照 §0 两条坑：科技置真不跑引擎的解锁那一步 ⟹ 配方也得点名开；科技名按 `prototypes.technology`
// 的 effects 读回来（不硬写）；两份都先读回原值，`exit` 时照原值还。
const LADDER_RECIPES = ["express-transport-belt", "turbo-transport-belt",
  "assembling-machine-3", "assembling-machine-4"];
const ladderTechs = (() => {
  const raw = luaLine(`local want = {}
for _, n in ipairs({${LADDER_RECIPES.map((n) => '"' + n + '"').join(",")}}) do want[n] = true end
local out = {}
for tname, t in pairs(prototypes.technology) do
  local ok, eff = pcall(function() return t.effects end)
  for _, e in ipairs((ok and eff) or {}) do
    if e.type == "unlock-recipe" and e.recipe and want[e.recipe] then out[tname] = true end
  end
end
local ks = {} for k in pairs(out) do ks[#ks + 1] = k end
table.sort(ks) rcon.print(table.concat(ks, ","))`);
  // 按逗号或空白切、只认合法名字（回话末尾那行 `OK` 会粘在最后一个名字上，§0 第六条坑）。
  return String(raw || "").split(/[,\s]+/).filter((x) => /^[a-z][a-z0-9_-]*$/.test(x));
})();
const ladderWas = (() => {
  const raw = luaLine(`local f = game.forces.player
local out = {}
for _, n in ipairs({${[...ladderTechs].map((n) => '"' + n + '"').join(",")}}) do
  local t = f.technologies[n] out[#out+1] = "t:" .. n .. "=" .. tostring(t ~= nil and t.researched or false)
end
for _, n in ipairs({${LADDER_RECIPES.map((n) => '"' + n + '"').join(",")}}) do
  local r = f.recipes[n] out[#out+1] = "r:" .. n .. "=" .. tostring(r ~= nil and r.enabled or false)
end
rcon.print(table.concat(out, " "))`);
  const out = {};
  for (const tok of String(raw || "").trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1) === "true";
  }
  return out;
})();
if (Object.keys(ladderWas).length > 0) {
  luaLine(`local f = game.forces.player
for _, n in ipairs({${[...ladderTechs].map((n) => '"' + n + '"').join(",")}}) do
  local t = f.technologies[n] if t then t.researched = true end
end
for _, n in ipairs({${LADDER_RECIPES.map((n) => '"' + n + '"').join(",")}}) do
  local r = f.recipes[n] if r then r.enabled = true end
end
rcon.print("ladder on")`);
  process.on("exit", () => {
    const setTable = "{" + Object.entries(ladderWas)
      .map(([k, v]) => '["' + k + '"]=' + (v ? "true" : "false")).join(",") + "}";
    luaLine(`local f = game.forces.player
local set = ${setTable}
for key, val in pairs(set) do
  local kind, name = key:sub(1, 1), key:sub(3)
  if kind == "t" then
    local t = f.technologies[name] if t then t.researched = val end
  else
    local r = f.recipes[name] if r then r.enabled = val end
  end
end
rcon.print("ladder off")`);
  });
  console.log(`  借来的梯子：科技 ${[...ladderTechs].join(",")} + 配方 ${LADDER_RECIPES.join(",")}`
    + "（臂不借；退出时照读回来的原值还）");
}
let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  ${String(detail).slice(0, 220)}`); }
};

// Belt, arm, machine, chest: the roles a lane is made of, so a count can be read without knowing which
// tier of each this save happens to have unlocked.
// By NAME rather than by entity type, on purpose: the answer's entity list carries no `type`, and the
// mod counts its parts out of the prototype's type. Reading the same 14 objects a second way -- by what
// the entity is called -- is the cross-check; a second use of the first way would only agree with itself.
const kindOf = (e) => {
  const n = String((e || {}).name || "");
  if (/belt|splitter/.test(n)) return "belt";
  if (/inserter/.test(n)) return "arm";
  if (/chest/.test(n)) return "chest";
  if (/furnace|assembling|mill|crusher|foundry/.test(n)) return "machine";
  if (/pole|substation/.test(n)) return "pole";
  return "other";
};
const entities = (d) => asArr((d || {}).entities);

// 0.82.0 起点名的机器不再被背着换：`furnace:"steel-furnace"` 在这一档力量上没开放时，那一发现在**按名拒**，
// 而不是静默铺一台石炉 —— 从前这三条配置一直在"钉钢炉"的名义下量石炉的线（长机械臂配钢炉深度，两者
// 恰好不同，所以那句断言其实没测到它以为的东西）。所以照老规矩借**配方那一格**，扫完照原样还。
const steelWasOn = /^true$/.test(luaLine(`local r = game.forces.player.recipes["steel-furnace"]
  rcon.print(r and tostring(r.enabled) or "absent")`));
if (!steelWasOn) luaLine(`local r = game.forces.player.recipes["steel-furnace"]
if r then r.enabled = true end rcon.print("borrowed")`);

const CONFIGS = [
  { machines: 1 }, { machines: 2, spacing: "standard" }, { machines: 3, spacing: "loose", outlets: 2 },
  { machines: 4, inserter: "long-handed-inserter", furnace: "steel-furnace" },
  // A second style, on the same part list, because the point of the registry is the comparison: two
  // rows of the same four machines, one per belt line and one per spine. The long-handed pair is the
  // interesting one -- every row offset in that style is a multiple of the reach, so a wrong R shows
  // up as an overlap rather than as a slightly wide box.
  { machines: 2, style: "stacked" }, { machines: 4, style: "stacked", spacing: "standard" },
  { machines: 3, style: "stacked", inserter: "long-handed-inserter", furnace: "steel-furnace" },
  // 双排：玩家定的第二种排法（"两排机器共用中间那条成品带"）。它和单排跑同一套逐配置断言 —— 机器数、
  // 零件表、占地、转 90° 换轴 —— 因为形状注册表的意义就是"同一份清单，另一种排法也站得住"。
  { machines: 2, style: "two-row" }, { machines: 7, style: "two-row" },
  { machines: 8, style: "two-row", spacing: "standard" },
  { machines: 6, style: "two-row", inserter: "long-handed-inserter", furnace: "steel-furnace" },
];

const lanes = [];
for (const cfg of CONFIGS) {
  for (const facing of ["horizontal", "vertical"]) {
    const r = call("card_example", { ...cfg, orientation: facing });
    lanes.push({ cfg, facing, data: (r || {}).data, ok: (r || {}).ok, code: (r || {}).code });
  }
}

for (const l of lanes) {
  const d = l.data || {};
  const parts = d.parts || {};
  const summed = (parts.belts || 0) + (parts.arms || 0) + (parts.machines || 0) + (parts.chests || 0)
    + (parts.poles || 0) + (parts.others || 0);
  const kind = {};
  for (const e of entities(d)) kind[kindOf(e)] = (kind[kindOf(e)] || 0) + 1;
  // The bill of materials is counted from the parts that were laid, so it has nothing to disagree with:
  // a hand-written manifest is where a moved chest turns into a wrong number of belts.
  // The claim a style exists to keep: it lays the machines the plan counted, no more and no fewer. The
  // first version of the two-row style laid six for an order of four -- ceil for one half and the whole
  // count for the other -- and every self-consistency check above passed, because the ledger agreed with
  // a geometry that was simply the wrong size.
  const asked = l.cfg.machines || 1;
  check(`${JSON.stringify(l.cfg)} ${l.facing}: the style lays exactly the machines the plan counted`,
    parts.machines === asked, `asked ${asked}, laid ${parts.machines} (fp ${JSON.stringify(d.footprint)})`);
  check(`${JSON.stringify(l.cfg)} ${l.facing}: the parts list is the entities, counted`,
    summed === entities(d).length && summed > 0 && (kind.belt || 0) > 0 && (kind.arm || 0) > 0,
    `sum=${summed} ents=${entities(d).length} kinds=${JSON.stringify(kind)}`);
  check(`${JSON.stringify(l.cfg)} ${l.facing}: a footprint exists, and is bigger than one tile`,
    (d.footprint || {}).width > 1 && (d.footprint || {}).height > 1, JSON.stringify(d.footprint));
}

// The one claim `orientation` exists to earn: the same parts turned 90° are the same shape on the other
// axis. Counted rather than eyeballed, because a lane that "looked" vertical and kept its width would
// still fit the wrong box.
for (const cfg of CONFIGS) {
  const h = lanes.find((l) => JSON.stringify(l.cfg) === JSON.stringify(cfg) && l.facing === "horizontal");
  const v = lanes.find((l) => JSON.stringify(l.cfg) === JSON.stringify(cfg) && l.facing === "vertical");
  const names = (d) => entities(d).map((e) => e.name).sort().join(",");
  // A refused call is a FAIL with the code in it, not a crash: this suite reads the same world the
  // suites before it handed over, and a `card_example` that says no has every right to say it. A gate
  // that throws on the answer takes the whole sweep down with it and prints a stack where a refusal
  // should have printed a code.
  const both = h && v && h.data && v.data;
  check(`${JSON.stringify(cfg)}: turning keeps every part and swaps the axes`,
    both && names(h.data) === names(v.data)
    && (h.data.footprint || {}).width === (v.data.footprint || {}).height
    && (h.data.footprint || {}).height === (v.data.footprint || {}).width,
    both ? JSON.stringify([h.data.footprint, v.data.footprint])
      : JSON.stringify([h && h.code, h && h.msg, v && v.code, v && v.msg]));
}

// ---------------------------------------------------------------- 双排买的是什么
//
// "共用出料传送带"是一句关于代价的话，所以它得能被量出来：同一份计划、同样的流量，双排应该
//   * 列数减半（两排各站一半），
//   * 成品带格数明显少（两排共用同一行），进料带格数不变（每一面都要吃到全部料），
//   * 一只箱子都不多。
// 这几条不成立的话，"双排"就只是另一种把线铺长的说法，那它不该存在。
const twoRowSame = { recipe: "electronic-circuit", machines: 8 };
const oneRow = call("card_example", Object.assign({ style: "stacked" }, twoRowSame));
const twoRow = call("card_example", Object.assign({ style: "two-row" }, twoRowSame));
const tr1 = (oneRow.data || {}).parts || {}, tr2 = (twoRow.data || {}).parts || {};
const fp1 = (oneRow.data || {}).footprint || {}, fp2 = (twoRow.data || {}).footprint || {};
check("双排把同样的 8 台折成两排：列数减半、带子格数减半、机器一台不少",
  oneRow.ok && twoRow.ok && tr1.machines === 8 && tr2.machines === 8
  && tr2.belts < tr1.belts && fp2.width <= Math.ceil(fp1.width / 2) + 2
  && tr2.chests === tr1.chests && tr2.chests === 0,
  JSON.stringify([fp1, fp2, { a: tr1, b: tr2 }]).slice(0, 260));
// 引擎是唯一能说"这张卡站得住"的一方：几何 lint 只看模自己的规矩，verify 才把 61 件真放到地上。
const trVerify = call("card_verify", { card: twoRow.data || twoRow, surface: "arch-sandbox" });
const trvd = trVerify.data || {};
check("双排整张卡被引擎收下：该放的都放下了，没有 refused、没有 blind",
  trVerify.ok === true && Number(trvd.placed) > 0 && trvd.placed === trvd.requested
  && asArr(trvd.errors).length === 0,
  JSON.stringify([trvd.placed, trvd.requested, asArr(trvd.errors).slice(0, 2)]).slice(0, 260));
// 共用行的两股各归一侧，这条是 `lane_side_probe` 量出来的规矩在形状那一侧的落点：两排的成品臂必须
// 站在共用带的**两面**，否则它们会挤进同一股，"共用"就变成"只有一排出货"。
const trSides = {};
for (const e of entities(twoRow.data || twoRow)) {
  const nm = String((e || {}).name || "");
  if (nm.indexOf("inserter") < 0) continue;
  const p = e.position || {};
  const y = typeof p.y === "number" ? p.y : (p[1] || 0);
  trSides[Math.floor(y)] = (trSides[Math.floor(y)] || 0) + 1;
}
const trRows = Object.keys(trSides).map(Number).sort((a, b) => a - b);
check("双排有两排成品臂，分别站在共用成品带的两面（不是挤在同一侧）",
  trRows.length >= 4, JSON.stringify([trSides, trRows]).slice(0, 260));

// ---------------------------------------------------------------- poles inside the shape
//
// A row of furnaces is not finished when the furnaces are placed: something has to carry the power, and
// until now the plan said "14 machines" and the pole answer arrived afterwards as a repair -- bunched on
// whichever edge a coverage search reached first. What a player draws is a line of poles at a regular
// spacing, dropped into the aisles and nudged aside only where a furnace stands.
//
// Four things are asserted, and the fourth is the only one that matters:
//   * the poles are IN the shape (counted from the entities, not claimed beside them);
//   * they stay inside the footprint, because a part outside the box is the bug that made `normalize`
//     exist, seen from the other side;
//   * the spacing obeys both reaches, so the row is a grid rather than a scattering;
//   * and the engine, which is the only party that can say what a network is, calls it ONE.
const POLLED = [
  { machines: 4, style: "stacked" }, { machines: 2, style: "two-row" },
  { machines: 6, style: "stacked", inserter: "long-handed-inserter" },
  { machines: 4, style: "two-row", orientation: "vertical" },
];
const unpoled = (cfg) => call("card_example", { ...cfg, force: "player" }).data || {};
for (const cfg of POLLED) {
  const r = call("card_example", { ...cfg, poles: true, force: "player" });
  const d = (r || {}).data || {};
  const bare = unpoled(cfg);
  const pg = d.power_grid || {};
  const poles = entities(d).filter((e) => kindOf(e) === "pole");
  check(`${JSON.stringify(cfg)}: 电线杆是排布的一部分，不是事后的补丁`,
    r.ok === true && pg.ok === true && (pg.needed || 0) > 0 && (pg.poles || 0) >= 1 && pg.uncovered === 0,
    JSON.stringify([r.code, r.msg, pg]));
  check(`${JSON.stringify(cfg)}: the bill of materials counts the poles it laid`,
    ((d.parts || {}).poles || 0) === (pg.poles || -1) && poles.length === (pg.poles || -1),
    JSON.stringify([pg.poles, (d.parts || {}).poles, poles.length]));
  check(`${JSON.stringify(cfg)}: every pole stands inside the footprint the box is packed with`,
    poles.every((e) => e.position.x >= 0.5 - 1e-9 && e.position.y >= 0.5 - 1e-9
      && e.position.x <= ((d.footprint || {}).width || 0) + 0.5
      && e.position.y <= ((d.footprint || {}).height || 0) + 0.5),
    JSON.stringify([d.footprint, poles.map((e) => [e.position.x, e.position.y])]));
  // The spacing is arithmetic, so it is checked as arithmetic: no wider than twice the reach plus one
  // (a mesh that wide has a tile in it that no pole covers) and no wider than the wire distance
  // `plan_power` chains with (a row whose members cannot reach each other is a row of islands).
  check(`${JSON.stringify(cfg)}: the spacing honours both reaches -- wide enough to cover, close enough to chain`,
    (pg.step || 0) >= 1 && (pg.step || 99) <= 2 * (pg.supply || 0) + 1 && (pg.step || 99) <= (pg.wire || 0),
    JSON.stringify([pg.step, pg.supply, pg.wire]));
  // A grid is a lattice, and the lattice is the claim: every pole lies within one mesh of an ideal
  // lattice point (`drift` < `step`), and no two poles stand on the same cell. `islands` is reported
  // rather than asserted to be 1 -- repeating one template across a box leaves islands by
  // construction, and bridging them is the power pass's job, with an engine to check itself against.
  check(`${JSON.stringify(cfg)}: every pole sits within one mesh of the lattice, on a cell of its own`,
    (() => {
      const seen = new Set(poles.map((p) => `${p.position.x},${p.position.y}`));
      return seen.size === poles.length && poles.length === (pg.poles || -1)
        && (pg.drift || 0) < (pg.step || 0) && (pg.islands || 0) >= 1;
    })(),
    JSON.stringify([pg.drift, pg.step, pg.islands, poles.length, pg.poles]));
  check(`${JSON.stringify(cfg)}: poles are ground, so the box only ever grows`,
    (d.footprint || {}).width >= (bare.footprint || {}).width
    && (d.footprint || {}).height >= (bare.footprint || {}).height
    && ((bare.parts || {}).poles || 0) === 0,
    JSON.stringify([bare.footprint, d.footprint]));
  // The engine's own answer to the arithmetic, and the reason both live in one file. The lattice says
  // how many loads it reached; `card_verify` places the lane on real ground and says how many landed on
  // a network. Those two numbers being equal is the whole claim that the coverage rule in `styles` is
  // the coverage rule the engine applies -- and where a dense row leaves loads dark, that is reported
  // rather than papered over, because the power search closes them next and says which tier it used.
  const v = call("card_verify", { card: { name: "ledger-poled", entities: entities(d),
    ports: d.ports, contract: d.contract }, force: "player" });
  const vd = (v || {}).data || {};
  const codes = (k) => asArr(vd[k]).map((w) => String(w.code || ""));
  const pw = vd.power || {};
  check(`${JSON.stringify(cfg)}: the lattice's count and the engine's count of dark loads are one number`,
    v.ok === true && codes("errors").length === 0 && pw.uncovered === pg.uncovered
    && (pw.covered || 0) + (pw.uncovered || 0) === pg.needed,
    JSON.stringify([(v || {}).code, codes("errors").slice(0, 3), pg.uncovered, pw]));
  check(`${JSON.stringify(cfg)}: a row that cannot be covered from the gaps says so, and names what it left`,
    (pg.uncovered || 0) === 0 ? asArr(pg.dark_at).length === 0
      : asArr(pg.dark_at).length === pg.uncovered && pg.uncovered < pg.needed,
    JSON.stringify([pg.uncovered, pg.dark_at]));
}
check("and a caller that asks for no poles gets exactly the shape it got before poles existed",
  !!unpoled && !(unpoled || {}).power_grid && ((unpoled.parts || {}).poles || 0) === 0,
  JSON.stringify([unpoled && unpoled.power_grid, unpoled && unpoled.parts]));

// Both shapes have to stand on real ground. This is the refusal the styles layer cannot make on its
// own: an arm whose pickup face ended up on the wrong side is legal JSON and an impossibility to build.
// The read-back is the claim, not the placement: `card_verify` answers ok to "I put it down and looked
// at it", and an arm reaching an empty cell lives inside that answer rather than in its status.
for (const l of lanes) {
  const r = call("card_verify", { card: { name: `ledger-${l.facing}`, entities: entities(l.data),
    ports: (l.data || {}).ports, contract: (l.data || {}).contract }, require_single_network: true });
  const errs = asArr(((r || {}).data || {}).errors).map((e) => String(e.code || e));
  check(`${JSON.stringify(l.cfg)} ${l.facing}: the engine accepts the shape it was given`,
    (r || {}).ok === true && errs.length === 0, JSON.stringify([(r || {}).code, errs.slice(0, 3)]));
}


// The claim these two styles exist to earn, in the unit a player picks with: LINES. Four machines as two
// separate rows pay two lines per row; the same four as one shared pair pay three in total. Compared at
// the same machine count and the same row count, because "one long row of four" is cheaper still on
// lines and pretending otherwise would be selling the wrong shape.
const lines = (d) => ((d || {}).lane_lines || {}).total;
// 单排：一行机器，上面一条进料带、下面一条成品带 —— 两条线。
const rb2 = call("card_example", { machines: 2, style: "stacked" }).data;
// 双排：两排机器共用中间那条成品带 —— 三条线（两面各一条进料 + 中间一条成品），不是四条。
// 这一条正是玩家那句"双排就是共用出料传送带"的可查形式。
const sw4 = call("card_example", { machines: 4, style: "two-row" }).data;
check("单排：成品要么独占一条带子（两行），要么并进进料行那股（只剩一行）—— 卡自己要说清是哪一种",
  (lines(rb2) === 2 && (((rb2 || {}).lane_plan || {}).product_rows_laid || 0) === 1)
  || (lines(rb2) === 1 && ((((rb2 || {}).lane_plan || {}).share || {}).laid === true)
      && (((rb2 || {}).lane_plan || {}).product_lanes_shared || 0) >= 1),
  JSON.stringify([lines(rb2), (rb2 || {}).lane_lines,
    ((rb2 || {}).lane_plan || {}).share, ((rb2 || {}).lane_plan || {}).product_lanes_shared]));
check("双排：两排共用中间那条成品带，铺出来是三条线而不是四条",
  lines(sw4) === 3 && (sw4.parts || {}).machines === 4,
  JSON.stringify([lines(sw4), sw4.parts]));
// 从前这一条比的是"双排的带子比两条单排少"。单排现在也会把成品并进入料行那一股（`share.laid`），
// 那句比较就不是它想说的了 —— 钉的改成两件各自的事实：两边都不铺箱子，而共用那一股的那一发
// **一条成品带都不多铺**（成品行走带子的件数为 0），双排仍然是两排共用一根成品线。
check("而这两种排法都不铺箱子；共用那一股那一发不再为成品铺带子，双排仍然两排共用一根成品线",
  (sw4.parts || {}).chests === 0 && (rb2.parts || {}).chests === 0
  && !!((rb2.lane_plan || {}).share) && (rb2.lane_plan.share.laid === true
    ? asArr(rb2.entities).every((e) => e.role !== "product_line")
    : true)
  && ((sw4.belt_ceiling || {}).lines || 0) === 1,
  JSON.stringify([rb2.parts, sw4.parts, rb2.lane_plan && rb2.lane_plan.share, sw4.belt_ceiling]));



// A gear press is a grid load exactly like a furnace, and the lattice does not care which recipe a
// machine is running -- so the same shape with a different machine on it has to come back just as
// covered. Asserted rather than assumed, because the needle list is built from `is_grid_load` on the
// prototype and an assembling machine is a different prototype with a different box.
const gearedPoled = call("card_example", { machines: 4, style: "stacked", recipe: "iron-gear-wheel",
  poles: true, force: "player" }).data || {};
check("the pole lattice wires a gear lane exactly like a smelting one",
  !!gearedPoled.belt_ceiling && (gearedPoled.power_grid || {}).uncovered === 0
  && ((gearedPoled.power_grid || {}).poles || 0) >= 1
  && (gearedPoled.parts || {}).machines === 4 && gearedPoled.recipe === "iron-gear-wheel",
  JSON.stringify([gearedPoled.power_grid, gearedPoled.recipe, gearedPoled.parts, gearedPoled.belt_ceiling,
    gearedPoled.contract]));

// ---------------------------------------------------------------- the road under the claim
//
// 两种形状都把成品走在带子上，所以"这一排做多少"和"这一排能搬走多少"是两个数，而它们之间差的正是带子
// 条数：单排一条成品线，双排两排机器共用那一条。plan 往同一根主脊后面叠第二排之前，要看的就是这个数。
const ceiled = (cfg) => call("card_example", { ...cfg, force: "player" }).data || {};
const rcCeil = ceiled({ machines: 4, style: "stacked" });
const swCeil = ceiled({ machines: 4, style: "two-row" });
check("单排：成品走在带子上（独占的一条线，或并进进料行的那几股），上限按点名的那一档说出来",
  !!rcCeil.belt_ceiling && (((rcCeil.belt_ceiling.lines || 0) >= 1
    || (rcCeil.belt_ceiling.shared_lanes || 0) >= 1))
  && rcCeil.belt_ceiling.belt === rcCeil.components.belt && rcCeil.belt_ceiling.per_min > 0,
  JSON.stringify([rcCeil.belt_ceiling, rcCeil.components]));
check("双排：两排之间仍然只有一条成品线",
  ((swCeil.belt_ceiling || {}).lines || 0) === 1 && (((swCeil.lane_lines || {}).total) || 0) === 3,
  JSON.stringify([swCeil.belt_ceiling, swCeil.lane_lines]));
// The claim and the road are one number read two ways: `contract` is what the shape makes, and the
// ceiling's own figure for it must not be a second number invented beside it.
check("the ceiling is stated against the very rate the card's contract carries",
  !!rcCeil.belt_ceiling && Math.abs(rcCeil.belt_ceiling.claimed_per_min
    - Object.values(rcCeil.contract.outputs)[0]) < 1e-6 && rcCeil.belt_ceiling.headroom > 0,
  JSON.stringify([rcCeil.belt_ceiling, rcCeil.contract]));
// THE ROAD AND THE CLAIM ARE NOW ONE NUMBER, NOT TWO.
//
// 从前这一格钉的是"带子太窄就说出来、但照铺"：形状只管铺一条成品带，流量归流量，两个数各报各的，
// 于是答案可以一边写"这排产 1800/分"、一边写"这条带走 900/分"。带行数改成由流量算之后（0.62 那一串），
// 成品带条数是 ceil(claim / 每股流量) 出来的 —— 一条线铺得下就多铺一条，铺不进一个面（`rows_per_face`）
// 就按名拒。所以 `belt_ceiling.over_claimed` 这一格从这扇门再也走不到：能回来的卡必然带得走自己产的东西。
// 钉边界而不是钉那个旗：点名最慢那一档带子时，能铺的最大台数恰好把这几条线填满（headroom = 1），
// 再多一台是 `LINES_BEYOND_SHAPE` —— 说得出缺哪一行数字。
//
// 边界是压线找出来的，不是写死的：一条成品线能被几个面装满，这件事是量出来的（同面两只臂装同一股 →
// 单排一根线只走一股，见 dev/lane_side_probe.js rig 4），那个数一动，"黄带上最多塞几台"就跟着动。
// 从前这里写死 96，改了运力律之后它不是失败而是**悄悄换了含义** —— 所以让它自己找。
const slowLane = (n) => call("card_example", { machines: n, style: "stacked", belt: "transport-belt",
  force: "player" }).data || {};
let fitLo = 1, fitHi = 200;
while (fitLo < fitHi) {
  const mid = Math.ceil((fitLo + fitHi) / 2);
  if (slowLane(mid).belt_ceiling) fitLo = mid; else fitHi = mid - 1;
}
const crowded = slowLane(fitLo);
check("一条被点名按最慢那一档铺的线，铺得下的最大台数正好把它填满（带不走就铺不下，不是铺完再劝）",
  !!crowded.belt_ceiling && fitLo > 1
  && crowded.belt_ceiling.over_claimed === undefined
  && Math.abs(crowded.belt_ceiling.headroom - 1) < 1e-6
  && crowded.belt_ceiling.claimed_per_min === crowded.belt_ceiling.per_min
  && crowded.belt_ceiling.lines === (crowded.lane_plan || {}).product_rows_needed
  && crowded.belt_ceiling.lines <= (crowded.lane_plan || {}).rows_per_face,
  JSON.stringify([fitLo, crowded.belt_ceiling, crowded.lane_plan &&
    [crowded.lane_plan.product_rows_needed, crowded.lane_plan.rows_per_face]]));
const tooCrowded = call("card_example", { machines: fitLo + 1, style: "stacked", belt: "transport-belt",
  force: "player" });
check("...而多一台就是多一台：按名拒，并把两个数（要几条带、一个面叠得起几条）交出来",
  tooCrowded.ok === false && tooCrowded.code === "LINES_BEYOND_SHAPE"
    && (tooCrowded.detail || {}).product_rows > (tooCrowded.detail || {}).rows_per_face,
  JSON.stringify([tooCrowded.code, tooCrowded.detail]).slice(0, 240));
check("and the shape that fits still comes back with its parts and footprint",
  !!crowded.belt_ceiling && (crowded.parts || {}).machines === fitLo && (crowded.footprint || {}).width > 0,
  JSON.stringify([fitLo, crowded.parts, crowded.footprint]));

// A recipe that yields more than one item per craft is contracted in ITEMS, not in crafts, and the
// figure has to agree with the one the SOLVER computes for the same machine and recipe -- two
// separate pieces of arithmetic that must not drift. `stacked` so the lane has a product line at all:
// every shape on this install lays one now, which is the point of the block above.
const cable = ceiled({ machines: 2, style: "stacked", recipe: "copper-cable" });
const geared = ceiled({ machines: 2, style: "stacked", recipe: "iron-gear-wheel" });
const laneRate = (d) => Object.values((d.contract || {}).outputs || {})[0];
check("and the ceiling is quoted against that same figure, not a second one",
  (cable.belt_ceiling || {}).claimed_per_min === laneRate(cable)
  && (geared.belt_ceiling || {}).claimed_per_min === laneRate(geared)
  && (cable.ingredient || "") === "copper-plate" && (geared.ingredient || "") === "iron-plate",
  JSON.stringify([cable.belt_ceiling, geared.belt_ceiling, cable.ingredient, geared.ingredient]));

// ---------------------------------------------------------------- the hardware row, and where a shape starts
//
// Two claims, because two bugs lived here.
//
// The first is the one a player found on a real client: a shape that measures its spine outward from the
// middle, so its upper row landed at cell y=-3. Nothing complained -- the shape lints perfectly on its
// own -- but the footprint is measured as "how far right and down the parts go", which cannot see a part
// that went UP and LEFT, so an 8-row shape reported 6 and `plan_fit` stacked lanes 2 rows apart. The
// engine answered BELT_INTO_SOLID on every lane but the first. The invariant that catches it costs one
// line and does not need to know anybody's tile size: a part's centre is never closer than half a tile
// to the origin, because cell {0,0} is the top-left of what it occupies.
//
// The second is the hardware row: naming a belt has to actually lay that belt. `roles.pick` takes a
// preference and falls back to the best unlocked part when it gets none, which is the right default and
// also exactly how a picker silently wired to nothing would keep looking filled.
const every_shape = [];
for (const style of ["stacked", "two-row"]) {
  for (const orientation of ["horizontal", "vertical"]) {
    for (const machines of [2, 4]) {
      const d = call("card_example", { machines, style, orientation, force: "player" }).data;
      if (d && !d.fail) every_shape.push({ style, orientation, machines, d });
    }
  }
}
check(`every style and axis came back (${every_shape.length} shapes)`,
  every_shape.length === 2 * 2 * 2, JSON.stringify(every_shape.map((s) => [s.style, s.orientation, s.machines, (s.d || {}).code])));
check("no part of any shape sticks out past its own origin -- the number a box is packed with",
  every_shape.every((s) => s.d.entities.every((e) => e.position.x >= 0.5 - 1e-9 && e.position.y >= 0.5 - 1e-9)),
  JSON.stringify(every_shape.map((s) => [s.style, s.orientation,
    Math.min(...s.d.entities.map((e) => Math.min(e.position.x, e.position.y)))]).slice(0, 6)));
check("...and the footprint it reports reaches at least as far as the parts do",
  every_shape.every((s) => {
    const far = (k) => Math.max(...s.d.entities.map((e) => e.position[k]));
    return s.d.footprint.width >= far("x") + 0.5 && s.d.footprint.height >= far("y") + 0.5;
  }),
  JSON.stringify(every_shape.map((s) => [s.style, s.orientation, s.d.footprint])));


// Naming a part: the row the player picked has to be the part that gets laid, in the answer AND in the
// entity list. Both, because `components` is what the answer claims and `entities` is what would be built.
// `chest` is the one named part that is NOT in the list any more, and the answer has to say that rather
// than let `pick`'s own sentence claim a box that was never laid.
const slow = call("card_example", { machines: 2, belt: "transport-belt", inserter: "inserter",
  chest: "wooden-chest", force: "player" }).data;
const auto = call("card_example", { machines: 2, force: "player" }).data;
check("a named belt and arm are the parts the lane is made of",
  !!slow && !slow.fail && slow.components.belt === "transport-belt" && slow.components.inserter === "inserter",
  JSON.stringify((slow || {}).components || slow));
check("...and they are really in the entity list, not just claimed",
  ["transport-belt", "inserter"].every((n) => slow.entities.some((e) => e.name === n)),
  JSON.stringify([...new Set(slow.entities.map((e) => e.name))]));
// 上面那一格不是形式：实体表里那只臂从前**真的不是点名的那一只**。参数化那一档逐档取臂时直接走了
// `arm_ladder_for_need`（"够用就好"永远落在高速机械臂），而 `components.inserter` 与 `arm_choice` 是
// 另一处按点名算的 —— 于是同一张卡上，句子说 inserter、地上铺 fast-inserter。
// 改法：点名的那只只在"它正好够这一档"时用。硬用它够不着的档也不行 —— 机械臂取货在**正好 reach 那一格**，
// 长一格的越过带子取不到、放货那一格又落在机器外（同一批断言在这台安装上量到过 ARM_PICKS_NOTHING /
// ARM_DROPS_ON_GROUND）。所以用不上的那些档取梯子里对应长度的臂，并把"哪一档换了谁、为什么"写进
// `arm_tiers[d].how`。
const armsOf = (d) => [...new Set(entities(d).filter((e) => /inserter/.test(e.name)).map((e) => e.name))];
const tiersOf = (d) => asArr((d || {}).arm_tiers);
// 这一对钉的是"两档臂的线里，点名的那只只用在它正好够得着的那一档"。要出两档，那条线的流量得超过一股
// —— 而这要看赢的那台熔炉是 speed 几：石炉 speed 1 时 20 台只有 375/分，一股就走完了，形状自己就只铺
// 一面，两档那一句根本无从检查。`electric-furnace` 在这一存档里**不一定开着**（实测：它的解锁科技在这台
// 安装上是 `advanced-material-processing-2`，而谁在前头把科技树收进它自己那份名单，这里就会静默换成石炉
// —— 同一份文件在"advanced-circuit 那格"的注释里就在说这件事）。
// 所以按本文件的老规矩：借来，用完照原样还。借的是**配方那一格**而不是整条科技 —— 不动别人的研究表，
// 只让这一发挑机器时看得见它；`refresh_availability` 每发都重读，所以下一次调用就生效。
const furnaceRecipeWasOn = /^true$/.test(luaLine(`local r = game.forces.player.recipes["electric-furnace"]
  rcon.print(r and tostring(r.enabled) or "absent")`));
if (!furnaceRecipeWasOn) luaLine(`local r = game.forces.player.recipes["electric-furnace"]
if r then r.enabled = true end rcon.print("borrowed")`);
const pinnedOne = call("card_example", { machines: 2, style: "stacked", belt: "transport-belt",
  inserter: "inserter", force: "player", recipe: "iron-plate", furnace: "electric-furnace" });
check("...而只有一档的线，点名那只就是铺下去那只（句子与实体表不再是两个数）",
  pinnedOne.ok === true && (pinnedOne.data.components || {}).inserter === "inserter"
    && armsOf(pinnedOne.data).length === 1 && armsOf(pinnedOne.data)[0] === "inserter",
  JSON.stringify([pinnedOne.code, pinnedOne.data && pinnedOne.data.components,
    armsOf(pinnedOne.data || {})]).slice(0, 240));
const pinnedTwo = call("card_example", { machines: 20, style: "stacked", belt: "transport-belt",
  inserter: "inserter", force: "player", recipe: "iron-plate", furnace: "electric-furnace" });
check("...而两档的线里点名那只用在它正好够得着的那一档，其余档说清换了谁、为什么",
  pinnedTwo.ok === true && (pinnedTwo.data.components || {}).furnace === "electric-furnace"
    && tiersOf(pinnedTwo.data).length >= 2
    && tiersOf(pinnedTwo.data).some((t) => t.arm === "inserter" && t.tier === 1 && t.reach === 1)
    && tiersOf(pinnedTwo.data).filter((t) => t.arm !== "inserter")
      .every((t) => /your inserter reaches 1, this row needs exactly/.test(String(t.how))),
  JSON.stringify([pinnedTwo.code, pinnedTwo.msg,
    (pinnedTwo.data || {}).components && (pinnedTwo.data || {}).components.furnace,
    tiersOf(pinnedTwo.data)]).slice(0, 320));
check("...而实体表里每一只臂都对得上它那一档（不再有两种臂各说各话）",
  pinnedTwo.ok === true && entities(pinnedTwo.data).filter((e) => /inserter/.test(e.name))
    .every((e) => tiersOf(pinnedTwo.data).some((t) => t.arm === e.name)),
  JSON.stringify([armsOf(pinnedTwo.data || {}), tiersOf(pinnedTwo.data)]).slice(0, 260));
if (!furnaceRecipeWasOn) luaLine(`local r = game.forces.player.recipes["electric-furnace"]
if r then r.enabled = false end rcon.print("returned")`);
check("...而点名的那只箱子被说出来，不是被悄悄当成没点名：卡上零只箱子，句子讲零只箱子",
  (slow.parts || {}).chests === 0 && !slow.entities.some((e) => e.name === "wooden-chest")
    && /no shape on this install lays a chest/.test(String((slow.components_how || {}).chest || "")),
  JSON.stringify([slow.parts.chests, (slow.components_how || {}).chest]).slice(0, 240));
// 点了一台做不了这个配方的机器，答案该怎么长？2.0 的 `set_recipe` 是照单接受的（给它点一个做不出来的
// 配方它不报错，然后整排待机等一个永远不来的活），所以这一问必须在**挑机器**那一层问掉。它其实早就在那儿
// —— 只是从来没人钉：换成了什么、有没有把"你点的那台为什么不行"说出来。两种不行的样子分开钉：
// 类别不对（炼油厂做不了电路板那一类）与根本是另一种东西（采矿机不属于熔炉/组装机那一类）。
const wrongCat = call("card_example", { recipe: "electronic-circuit", machines: 2, force: "player",
  machine: "oil-refinery" }).data || {};
const wrongKind = call("card_example", { recipe: "iron-plate", machines: 2, force: "player",
  machine: "electric-mining-drill" }).data || {};
// 卡上"这台机器"永远住在 `components.furnace` 里（历史名字），而说那句"你点的那台为什么不行"的行**跟着
// 梯子走**：铁板走熔炉梯子 → 写在 `components_how.furnace`，其余配方走带类别的那条 → 写在 `machine`。
// 两边不同名这件事本身就值得留一句：读答案的人只按 `machine` 找，会在铁板那一发上拿到空（实测就是这样
// 挂过一次门禁），所以这里两行都读，而钉的是"总有一行说出了被点的那个名字"。
const laidMachine = (d) => (d.components || {}).furnace;
const saysSo = (d, asked) => {
  const h = d.components_how || {};
  const how = String(h.machine || "") + " " + String(h.furnace || "");
  return { how: how.trim(), swapped: !!laidMachine(d) && laidMachine(d) !== asked,
    named: how.indexOf(asked) >= 0 };
};
// 0.82.0 起，点名分两种，四种情形各钉一条：
//   硬点名（`machine:` / `furnace:`）—— 那一台跑不了这一类就**按名拒**，绝不换一台上去；
//   偏好（`machine_hint:`，压线走的那一条）—— 可以换，但答案必须说清换了谁、为什么。
const wrongCatRefused = call("card_example", { recipe: "electronic-circuit", machines: 2,
  force: "player", machine: "oil-refinery" });
const wrongKindRefused = call("card_example", { recipe: "iron-plate", machines: 2, force: "player",
  machine: "electric-mining-drill" });
check("硬点一台类别不对的机器：按名拒，并把“你点的那台跑不了这一类”与梯子里会用谁一起交出来",
  wrongCatRefused.ok === false && wrongCatRefused.code === "MACHINE_ASKED_UNUSABLE"
    && (wrongCatRefused.detail || {}).asked_for === "oil-refinery"
    && /category|cannot run/i.test(String((wrongCatRefused.detail || {}).why))
    && String((wrongCatRefused.detail || {}).would_have_used || "").length > 0,
  JSON.stringify([wrongCatRefused.code, wrongCatRefused.detail]).slice(0, 260));
check("...硬点一台根本是另一类东西的机器（采矿机）时同一条路：拒，并说清它的类型不在这一角色里",
  wrongKindRefused.ok === false && wrongKindRefused.code === "MACHINE_ASKED_UNUSABLE"
    && /mining-drill|not one of|type/i.test(String((wrongKindRefused.detail || {}).why)),
  JSON.stringify([wrongKindRefused.code, (wrongKindRefused.detail || {}).why]).slice(0, 240));
// 换成偏好那一格：同一次点名不再是拒，而是"换上能跑的那台 + 答案自己报这一换"。
const wrongCatHint = call("card_example", { recipe: "electronic-circuit", machines: 2, force: "player",
  machine_hint: "oil-refinery" }).data || {};
const wrongKindHint = call("card_example", { recipe: "iron-plate", machines: 2, force: "player",
  machine_hint: "electric-mining-drill" }).data || {};
check("偏好一台跑不了的机器时铺得出线，而 `machine_swapped` 说清点的是谁、铺的是谁、为什么",
  !!wrongCatHint.name && !!wrongCatHint.machine_swapped
    && wrongCatHint.machine_swapped.asked === "oil-refinery"
    && wrongCatHint.machine_swapped.laid === laidMachine(wrongCatHint)
    && /category|cannot run/i.test(String(wrongCatHint.machine_swapped.why)),
  JSON.stringify([laidMachine(wrongCatHint), wrongCatHint.machine_swapped]).slice(0, 260));
check("...偏好另一类东西（采矿机）时同一条路：换掉 + 说清它不是熔炉/组装机那一类",
  !!wrongKindHint.name && !!wrongKindHint.machine_swapped
    && wrongKindHint.machine_swapped.asked === "electric-mining-drill"
    && /mining-drill|not one of|type/i.test(String(wrongKindHint.machine_swapped.why))
    && /furnace/.test(String(laidMachine(wrongKindHint))),
  JSON.stringify([laidMachine(wrongKindHint), wrongKindHint.machine_swapped]).slice(0, 260));
// 被换上的那台必须真能做这件事 —— 玩家要的后果不是"它说了句话"，而是"铺出来那排会生产"。
// 石炉 + 铁板这条要能在台架上出件（`belt_line_produces` 走同一条路，但那是默认挑选，这里钉的是换过之后那台）。
check("...而被换上的那台确实跑得动这一类：卡上的机器与配方类别不是两条各说各话",
  /furnace/.test(String(laidMachine(wrongKindHint)))
    && /assembling-machine|chemical-plant|fabricator/.test(String(laidMachine(wrongCatHint))),
  JSON.stringify([laidMachine(wrongKindHint), laidMachine(wrongCatHint)]));

// 这一条从前钉的是相反的事："不表态就拿这一发能造的最快那一档，所以它不等于点名的 transport-belt"。
// 带子改成"够用就好"之后（玩家 2026-10-07），两炉铁板这条线落在黄带子上，而**这正是**它点名的那一档 ——
// 于是这条断言必须换成人话：不表态时拿的是"装得下的最慢那一档"，并且答案自己说得出试过哪几档、为什么停。
// 箱子那一半没变：不表态时不该拿到 wooden-chest（那是造价最低，不是这条线要的）。
check("while a caller that names nothing gets the slowest tier that carries the line, and says so",
  !!auto && !auto.fail && auto.components.belt === "transport-belt"
  && auto.components.chest !== "wooden-chest"
  && (auto.belt_choice || {}).adequate === true
  && (auto.belt_choice || {}).chosen === "transport-belt"
  && asArr((auto.belt_choice || {}).tried)[0] === "transport-belt",
  JSON.stringify([auto && auto.components, auto && auto.belt_choice]));

// ---------------------------------------------------------------- the lane has to actually RUN
//
// Everything above is geometry the mod can check against itself, and `card_verify` only asks the engine
// whether the parts may STAND there. Neither of them can see a feed arm facing the wrong way: an arm
// that picks the machine's output and drops it back onto the raw-material belt has a solid entity on both
// of its hands, so it is legal to place, legal to verify, and starves every machine on the row. The one
// instrument that can answer it is the bench: build the lane, feed it, and see whether anything came out
// the other end.
//
// 而喂这件事现在只有一条路：牌。裸带线头没有 in-port，`card_lab` 读的是每块头牌自己发的那份信号表
// （"这种料走第几股"），照号把料插进那根带子的尾巴。所以这一段要先把 circuit-network 借来 —— 没有面
// 板与发射器就没有那份清单，台架会按名拒（CARD_NO_FEEDS），那是世界状态，不是形状的问题。借了照原样还，
// 和 dev/belt_head_e2e.js、dev/belt_line_produces.js 同一条规矩。
// 和量到东西那一句之前，先要有能问引擎的那只手。
const rpLua = (src) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV }).trim();
    // The probe answers with the printed line and then a bare OK. Anything that is not a JSON array (a
    // Lua error, an empty reply) reads as "no ingredients", so the checks below fail on it instead of
    // passing on a parsed guess.
    const line = out.split("\n").map((l) => l.trim()).filter((l) => l && l !== "OK").pop() || "[]";
    return line.startsWith("[") ? line : "[]";
  } catch (e) { return "[]"; }
};
// The same probe without the array assumption lives at the top of this file as `luaLine` -- several
// suites-after-this-one need to borrow a recipe before they can ask a shape for two arm tiers.
const sleep = (ms) => { try { execFileSync("sleep", [String(ms / 1000)], { stdio: "ignore" }); } catch (e) { /* nothing to do */ } };
const techWasOn = /^true$/.test(luaLine(`local t = game.forces.player.technologies["circuit-network"]
  rcon.print(t and tostring(t.researched) or "absent")`));
if (!techWasOn) luaLine(`local t = game.forces.player.technologies["circuit-network"]
local r = game.forces.player.recipes["display-panel"]
if t then t.researched = true end
if r then r.enabled = true end rcon.print("borrowed")`);
const run_lab = (card, secs) => {
  const window = secs || 60;   // 默认的 60 秒窗口对"绝对产率"够用；比两档形状时要更长（见下面那节）
  let started = call("card_lab", { card, seconds: window, speed: 40, force: "player" });
  // The clock belongs to everybody when a player is connected, so the same window is asked for at 1x
  // rather than skipped: the claim under test is "this lane produces", and it must be checkable by
  // whoever runs this suite after the next person logs in.
  if (started && started.code === "PLAYER_ONLINE") started = call("card_lab", { card, seconds: window, force: "player" });
  if (!started || started.ok === false) return { refused: started };
  for (let i = 0; i < 90; i++) {
    const st = call("lab_status").data || {};
    if (st.state && st.state !== "running") return st;
    sleep(1000);
  }
  return { refused: { code: "SUITE_TIMEOUT" } };
};

for (const cfg of [{ machines: 2, style: "stacked" }, { machines: 2, style: "two-row" }]) {
  const lane = call("card_example", { ...cfg, recipe: "iron-plate", force: "player" }).data;
  const st = lane && !lane.fail ? run_lab(lane) : { refused: { code: "NO_LANE" } };
  const verdicts = asArr(st.verdicts);
  const produced = verdicts.reduce((s, v) => s + (v.produced || 0), 0);
  check(`${JSON.stringify(cfg)}: the lane the style lays moves items when the engine feeds it`,
    produced > 0, JSON.stringify([st.refused, st.state, st.reason, verdicts.map((v) => [v.item, v.produced, v.measured_per_min])]));
}

// ---------------------------------------------------------------- the compactness arithmetic
// "尽量紧凑" has to be a number before it is a shape: whether the materials can ride ONE belt line is
// decided by the line's throughput against what each material wants per minute. Asserted off the
// engine's own recipe, because a table of numbers copied into this file would be a second opinion
// about the same recipe, free to drift the day a mod changes one amount.
const oneMat = call("card_example", { recipe: "iron-plate", machines: 6, force: "player" }).data || {};
const twoMat = call("card_example", { recipe: "electronic-circuit", machines: 6, force: "player",
  style: "stacked" }).data || {};
// Read straight off the engine, through the same probe every other suite uses: the amounts belong to
// the recipe, and this file is not the place to restate them.
const rp = (name) => JSON.parse(rpLua(`local r = prototypes.recipe["${name}"]
local out = {}
for _, i in ipairs(r.ingredients) do
  out[#out+1] = string.format('{"item":"%s","amount":%s,"type":"%s"}', tostring(i.name),
    tostring(i.amount or 1), tostring(i.type or "item"))
end
rcon.print("[" .. table.concat(out, ",") .. "]")`) || "[]");
const ironIng = rp("iron-plate").filter((x) => x.type !== "fluid");
const ecIng = rp("electronic-circuit").filter((x) => x.type !== "fluid");
check("a one-material lane's feed plan names exactly that material, and no more",
  !!oneMat.feed_plan && (oneMat.feed_plan.needs || []).length === ironIng.length
    && (oneMat.feed_plan.needs || []).every((n) => n.item === "iron-ore" && n.per_min > 0),
  JSON.stringify([oneMat.feed_plan, ironIng]).slice(0, 260));
check("...and a two-material recipe is reported with BOTH materials and what each wants per minute",
  !!twoMat.feed_plan && (twoMat.feed_plan.needs || []).length === ecIng.length
    && twoMat.feed_plan.needs.every((n) => n.per_min > 0 && n.per_craft > 0)
    && Math.abs(twoMat.feed_plan.per_min_total
      - twoMat.feed_plan.needs.reduce((a, b) => a + b.per_min, 0)) < 1e-6,
  JSON.stringify(twoMat.feed_plan).slice(0, 300));
check("...and the share/split verdict is the arithmetic of LANES: each material takes 1 lane or whole belts",
  !!twoMat.feed_plan && twoMat.feed_plan.per_lane > 0
    && twoMat.feed_plan.inbound_lanes >= 2
    // 借给成品那一股之后，"一台机器够着的料股"可以是奇数（这一发 2 行 4 股减 1 股 = 3）—— 不再是老律的偶数。
    && Math.abs(twoMat.feed_plan.per_lane * 2 - twoMat.feed_plan.per_line) < 1e-6
    // 新取整律（≤0.5 条 = 一股；>0.5 = 整条向上）：need = 件数 / 整条运力，所以除的是 2×per_lane。
    && twoMat.feed_plan.lanes_wanted === asArr(twoMat.feed_plan.needs).reduce(
      (s, k) => s + (k.per_min <= twoMat.feed_plan.per_lane ? 1
        : 2 * Math.ceil(k.per_min / (2 * twoMat.feed_plan.per_lane) - 1e-9)), 0)
    // "一根带子装得下所有料吗" 问的是那一根带的两个半股，不是整条线铺了几股 —— 名字说什么，算术就得比什么。
    && twoMat.feed_plan.share_one_line === (twoMat.feed_plan.lanes_wanted <= 2)
    // The number of lines is the LARGER of the two ways a line runs out: the lanes the materials want over
    // the lanes THIS shape lays, and the machines over what one row of this belt keeps fed. Both are
    // computed from the figures the card itself reports, so this is the rule and not a second copy of it.
    && twoMat.feed_plan.lines_needed === Math.max(1,
      Math.ceil(twoMat.feed_plan.lanes_wanted
        / (twoMat.feed_plan.feed_lanes_laid || twoMat.feed_plan.inbound_lanes)),
      Math.ceil((twoMat.lane_count || 1) / (twoMat.feed_plan.machines_per_line || twoMat.lane_count || 1))),
  JSON.stringify([twoMat.feed_plan.lanes_wanted, twoMat.feed_plan.share_one_line,
    twoMat.feed_plan.per_lane, twoMat.feed_plan.lines_needed,
    twoMat.feed_plan.machines_per_line, twoMat.feed_plan.feed_lanes_laid]).slice(0, 260));
// The row limit, checked the same way it was computed: the quoted count fits the lanes one machine
// reaches, the count one larger does not. A yellow belt under smelting is the case where splitting is the
// right medicine -- one machine fits, forty do not -- so the limit is a real number rather than a floor of 1.
//
// 这一发有两种合法结局，两种说的都是同一件事（行上限）：电炉在这台存档上研究没研究，决定 40 台是产
// 750/分还是 1500/分。
//   * 铺得出来 —— 按它自己引用的数核对边界：`machines_per_line` 台装得下，多一台装不下；
//   * 装不下（1500/分按"一根成品带走一股"要 4 条成品带，一个面叠不起 4 条）—— 那它必须**按名拒**，
//     并把两个数都交出来（要几条成品带、一个面能叠几条），而那两个数要能对得上同一台安装量到的臂档数
//     与机器深度。
// 只钉第一种的话，这条检查就变成对存档研究状态的第二次意见，而不是对算术的意见。
const rowLimitRaw = call("card_example", { recipe: "iron-plate", machine_hint: "electric-furnace", machines: 40,
  belt: "transport-belt", force: "player", style: "stacked" });
const rowLimit = rowLimitRaw.data || {};
const rl = rowLimit.feed_plan || {};
const reachLanes = rl.inbound_lanes || 2;
const lanesAt = (m) => asArr(rl.needs).reduce(
  (sum, k) => sum + Math.ceil((k.per_min / rowLimit.lane_count) * m / rl.per_lane), 0);
const rowDetail = rowLimitRaw.detail || {};
const refusedRows = rowLimitRaw.code === "LINES_BEYOND_SHAPE" || rowDetail.why === "LINES_BEYOND_SHAPE";
check("...而它引用的行上限是能核对的：铺得出来就多一台装不下，装不下就按名拒并交出那两个数",
  refusedRows
    ? (rowDetail.product_rows || 0) > (rowDetail.rows_per_face || 0)
      // 一个面能叠几条 = 量到的臂档数与机器深度的交集，这是答案自己给的，不是这条检查另记的一份
      && (rowDetail.rows_per_face || 0) === Math.min(asArr(rowDetail.arm_reach_tiers).length,
        rowDetail.machine_height || 0)
      && (rowDetail.feed_rows || 1) <= (rowDetail.rows_per_face || 0)
    : rl.machines_per_line >= 2 && lanesAt(rl.machines_per_line) <= reachLanes
      && (rl.machines_per_line >= (rowLimit.lane_count || 40)
        || lanesAt(rl.machines_per_line + 1) > reachLanes),
  JSON.stringify([refusedRows ? rowDetail : null, rl.machines_per_line,
    lanesAt(rl.machines_per_line), lanesAt((rl.machines_per_line || 0) + 1),
    rl.per_lane, reachLanes]).slice(0, 260));
// The case splitting cannot cure: one machine whose own appetite is larger than both lanes. Every row
// would be over its belt the same way, so the answer names the belt tier instead of laying one row per
// machine and calling each of them handled. Vanilla data does not reach that state -- a belt lane is
// generous against a crafter -- so what is pinned here is the RULE at every point this install can
// build: the flag is present exactly when one machine's lanes exceed the row's two, and the row limit is
// left at the whole plan only then. A gate that only ever sees the flag absent would be a gate on nothing.
const ruleRows = [
  ["iron-gear-wheel", "assembling-machine-3", "transport-belt"],
  ["electronic-circuit", "assembling-machine-1", "transport-belt"],
  ["electronic-circuit", "assembling-machine-3", "fast-transport-belt"],
  ["iron-plate", "electric-furnace", "transport-belt"],
  ["copper-cable", "assembling-machine-1", "fast-transport-belt"],
];
const ruleSeen = [];
let ruleOk = true;
for (const trio of ruleRows) {
  const recipe = trio[0], machine = trio[1]; let belt = trio[2];
  // 偏好而不是硬点名：这一发钉的是 `belt_too_slow` 那条律在三档机器 × 三种带子上的形状，
  // 而不是"点名的机器一定铺" —— 硬点名会让某一行在某些存档上变成一句拒，样本就少了。
  const ask = (pin) => call("card_example", Object.assign({ recipe: recipe, machine_hint: machine,
    machines: 6, force: "player", style: "stacked" }, pin ? { belt: pin } : {})).data || {};
  let d = ask(belt);
  let fp = d.feed_plan || {};
  if (!fp.per_lane) {
    // 这一发钉的是律，不是"这条带子一定铺得出"：点名的那一档在这一档机器上把计划顶到叠不起面时，
    // 样本会整行消失（`ruleSeen.length >= 4` 就红在样本数上，而不是红在律上）。退一步用自动挑带再问，
    // 律还在同样的数上测。
    d = ask(null); fp = d.feed_plan || {};
    if (fp.per_lane) belt = "auto(" + String((d.belt_choice || {}).belt || "?") + ")";
  }
  if (!fp.per_lane) continue;
  const reach = fp.inbound_lanes || 2;
  const forOne = asArr(fp.needs).reduce(
    (sum, k) => sum + Math.ceil((k.per_min / (d.lane_count || 6)) / fp.per_lane), 0);
  ruleSeen.push([recipe, belt, forOne, reach, !!fp.belt_too_slow, fp.machines_per_line]);
  if (!!fp.belt_too_slow !== (forOne > reach)) ruleOk = false;
  if (fp.belt_too_slow && fp.machines_per_line !== d.lane_count) ruleOk = false;
}
if (!ruleOk) console.log("  (rule 表逐行: " + JSON.stringify(ruleSeen) + ")");
check("belt_too_slow is present exactly when one machine wants more lanes than its own arms reach -- never when"
  + " splitting would help", ruleOk && ruleSeen.length >= 4, JSON.stringify(ruleSeen).slice(0, 400));
// 一根带子只有两半股，所以"三种料"必然要两根带子 —— 这是几何的限制，不能被"这条带子够快"吞掉。
// 数出来的那一句是：牌上每个料恰好上一次，而它写了几道就至少要有那么几根带子（道数 ÷ 2 向上取整）。
const threeMat = call("card_example", { recipe: "low-density-structure", machines: 3, force: "player",
  style: "stacked" }).data || {};
const threeNeeds = asArr((threeMat.feed_plan || {}).needs);
check("...and three materials want more than the two half-lanes of one line, whatever the belt could carry",
  threeNeeds.length === 3 && threeMat.feed_plan.share_one_line === false
    && asArr((threeMat.head || {}).lanes).length === 3
    && Math.ceil(asArr((threeMat.head || {}).lanes).length / 2)
      <= ((threeMat.lane_plan || {}).feed_rows_laid || 0),
  JSON.stringify([threeNeeds.map((k) => [k.item, Math.round(k.per_min)]),
    threeMat.feed_plan && threeMat.feed_plan.share_one_line,
    asArr((threeMat.head || {}).lanes).map((l) => l.item + "#" + l.lane),
    threeMat.lane_plan && threeMat.lane_plan.feed_rows_laid]).slice(0, 300));
// 两种料落在同一根带子的两半股上：站在带子一侧的取货臂两股都取得走，这件事由 dev/lane_side_probe.js
// 量（两样料分别由南北两只臂装上同一行，下游那只臂两样都取到了），这里钉的是形状按这个事实铺出来的
// 结果 —— 牌上两种料各一道、台架喂得进去、真的造出了东西。
const share = call("card_example", { recipe: "electronic-circuit", machines: 4, force: "player",
  style: "stacked" }).data || {};
const shareLanes = asArr((share.head || {}).lanes);
const headItems = shareLanes.map((l) => l.item).filter(Boolean);
// 一种料写几道，是它的流量除上一股的运力（4 台组装机这一条要吃 3 种料里的两种各多少：铜线要 2 股、
// 铁板 1 股），所以"每种恰好一道"是错的钉法 —— 它会把"一种料占两股"这件事钉成回归。钉的是这三句：
// 配方吃的每种都在、道数 = `lanes_wanted`、号不重复且都落在铺下的那些半股里。
check("一条共用的进料带把配方吃的每一种料都写上牌：一种不落地都在，道数按流量、号按铺下的半股",
  !!share.feed_plan && ecIng.length === 2 && new Set(headItems).size === ecIng.length
    && ecIng.every((i) => headItems.includes(i.item))
    && shareLanes.length === (share.feed_plan || {}).lanes_wanted
    && shareLanes.length <= 2 * ((share.lane_plan || {}).feed_rows_laid || 0)
    && new Set(shareLanes.map((l) => l.lane)).size === shareLanes.length
    && shareLanes.every((l) => l.lane >= 1 && l.lane <= 2 * ((share.lane_plan || {}).feed_rows_laid || 0))
    && asArr(share.unfed).length === 0,
  JSON.stringify([headItems, (share.feed_plan || {}).lanes_wanted,
    (share.lane_plan || {}).feed_rows_laid, share.unfed]).slice(0, 300));
const ranShare = run_lab(share);
const madeShare = asArr(ranShare.verdicts).reduce((s, v) => s + (v.produced || 0), 0);
check("...and the bench feeds both materials and the lane really crafts",
    madeShare > 0,
  JSON.stringify([ranShare.refused, ranShare.state, (ranShare.verdicts || []).map((v) => [v.item, v.produced])])
    .slice(0, 300));
// 装不下的那种写法已经从"铺一条有洞的线"改成"按名拒并把两个数交出来"：五种料的配方要 7 道，一个面叠
// 得起 2 根（4 道），于是它不会带着一个洞回来 —— 因为带洞的线在牌上看着是齐的，量出来的 0 会被读成
// "这条线太慢"，而不是"这一发压根铺不出来的形状"。
const fiveMat = call("card_example", { recipe: "rocket-silo", machines: 1, force: "player",
  style: "stacked" });
check("...而料多到任何形状都铺不下时是按名拒，不是铺一条带洞的线回来",
  fiveMat.ok === false && fiveMat.code === "LINES_BEYOND_SHAPE"
    && (fiveMat.detail || {}).feed_rows > (fiveMat.detail || {}).rows_per_face
    && (fiveMat.detail || {}).lanes_wanted >= 5,
  JSON.stringify([fiveMat.code, fiveMat.detail]).slice(0, 260));
// 同一条"一个面叠几条"的上限有两种，它们给的下一步**相反**，所以两种各钉一发：
//   `feed_count` —— 光是配方吃几种料就顶到上限（一种至少一股、一条带两股，所以 `ceil(种数/2)` 是任何
//     一条线都躲不掉的下限）。这时"切成几条线"与"换更快的带子"都是假建议，拒因必须说不解决；
//   `feed_flow` —— 种数装得下，是流量把某一种顶到两股以上，这时切线与换带子都真的解决。
// 香草这一台只有 reach 1/2 两档臂，所以一个面 2 条带 = 4 股；五种料的配方（`loader`）从第五种起过不去，
// 而这一条从前也报同一句"只能切线"。
const countWall = call("card_example", { recipe: "loader", machines: 4, style: "stacked",
  heads: "belt", force: "player" });
const cw = countWall.detail || {};
check("五种料顶到上限时说的是**种数**那一件事：floor = ceil(种数/2)，而切线与换带子都被明说不解决",
  countWall.ok === false && countWall.code === "LINES_BEYOND_SHAPE" && cw.blocked_by === "feed_count"
    && cw.materials === 5 && cw.feed_rows_floor === 3 && cw.rows_per_face === 2
    && cw.splitting_helps === false && cw.faster_belt_helps === false,
  String(JSON.stringify([countWall.code, cw])).slice(0, 320));
check("...那句给人读的话里不再出现「只能把计划切成几条线」，而点名了要几档臂、缺哪一档",
  !/只能把计划切成几条线/.test(String(countWall.msg)) && /切成几条线都不解决/.test(String(countWall.msg))
    && JSON.stringify(cw.arm_reach_missing) === "[3]",
  String(JSON.stringify([String(countWall.msg).slice(-120), cw.arm_reach_missing])));
const flowWall = call("card_example", { recipe: "iron-plate", machines: 120, belt: "transport-belt",
  style: "stacked", heads: "belt", force: "player" });
const fl = flowWall.detail || {};
check("流量顶到上限那一发仍然说切线与换带子（blocked_by = feed_flow，两个 helps 都是 true）",
  flowWall.ok === false && flowWall.code === "LINES_BEYOND_SHAPE" && fl.blocked_by === "feed_flow"
    && fl.splitting_helps === true && fl.faster_belt_helps === true
    && fl.feed_rows_floor <= fl.rows_per_face,
  String(JSON.stringify([flowWall.code, fl])).slice(0, 320));
// 同一条律也写在**铺成的**卡上（`lane_plan`），两处必须同源：`advanced-circuit` 两种料 → 下限 1 条。
const manyRows = call("card_example", { recipe: "advanced-circuit", machines: 4, style: "stacked",
  heads: "belt", force: "player" });
const lpRows = (manyRows.data || {}).lane_plan || {};
// 料种数不写在门禁里（这台存档的配方是引擎的那一份）：直接问原型有几种固体料。
const protoMats = Number(luaLine(`local r = prototypes.recipe["advanced-circuit"]
local n = 0
for _, i in ipairs(r and r.ingredients or {}) do
  if (i.type or "item") ~= "fluid" then n = n + 1 end
end
rcon.print(n)`));
check("铺成的卡上那两个数也是「种数除两股」，种数与原型一致（不是两处各写一遍的表）",
  manyRows.ok === true && protoMats >= 2 && lpRows.materials === protoMats
    && lpRows.feed_rows_floor === Math.ceil(lpRows.materials / 2)
    && lpRows.blocked_kind === undefined && lpRows.beyond_any_shape === false,
  String(JSON.stringify([manyRows.code, lpRows.materials, protoMats, lpRows.feed_rows_floor,
    lpRows.blocked_kind, lpRows.beyond_any_shape])));
// 压线那一侧：三种排法共用同一条律，所以种数那种上限不该再走完整条阶梯、也不该折半试台数。
const countPress = call("helmod_ghosts", { into: "string", surface: "nauvis",
  origin: { x: 700, y: 700 }, force: "player",
  plan: [{ name: "assembling-machine-3", count: 6, recipe: "loader" }] });
const cp = countPress.data || {};
const cpFall = asArr(cp.lane_fallback)[0] || {};
const triedShapes = asArr(cp.steps).filter((x) => /  试 /.test(String(x))).length;
check("...而压线在这一行只试一档形状就断（阶梯与折半都不为种数那种上限重跑），散件的理由写全",
  countPress.ok === true && asArr(cp.lanes).length === 0 && asArr(cp.lane_fallback).length === 1
    && cpFall.why === "LINES_BEYOND_SHAPE" && triedShapes === 1
    && /都不解决/.test(String(cpFall.msg)),
  String(JSON.stringify([countPress.code, triedShapes, asArr(cp.lanes).length,
    String(cpFall.msg).slice(0, 70)])).slice(0, 300));
// ---------------------------------------------------------------- arms, boxes and the ground under them
//
// 这一段钉的是"臂站在哪一面"。从前它比的是每只成品箱站在不在自己那只臂的放货格上，而带箱子的四种排法
// 删掉之后卡上没有箱子了 —— 那句话没有了对象，读起来仍然像一条断言，实际数的是零只箱子（零只箱子里
// 每只都站对了地方，永远为真）。它的位置上站的是一条一样硬、但只有引擎能回答的话：
//   * the parts can STAND, at both arm reaches and turned -- `card_verify` puts the whole card down;
//   * every arm has a belt under one hand and a machine under the other, in the right order -- which is
//     the only thing in this file that catches an arm laid facing the wrong way: legal to place, legal to
//     verify, and it starves every machine on the row;
//   * the signs are the parts the bill counts: one emitter + one panel per head (one head per machine
//     row) plus one at the tail, and nothing extra standing where a box used to.
//
// Which part names are inserters / belts / machines on THIS save, read from the engine rather than
// remembered: the gate has to find what stands under an arm's hand by the part's TYPE, and a list of tier
// names copied into a suite goes stale the day a mod adds one. Sizes come from the same query, because a
// 2x2 machine's cells are not its centre.
const protoParts = JSON.parse(luaLine(`local out = {}
for _, n in ipairs({"inserter","long-handed-inserter","stack-inserter","fast-inserter","bulk-inserter",
    "filter-inserter","wooden-chest","steel-chest","iron-chest","transport-belt","fast-transport-belt",
    "underground-belt","assembling-machine-1","assembling-machine-3","stone-furnace","steel-plant",
    "decider-combinator","display-panel","electric-furnace"}) do
  local p = prototypes.entity[n]
  if p then out[#out+1] = string.format('"%s":{"type":"%s","w":%d,"h":%d}', n, tostring(p.type),
    (p.tile_width) or 1, (p.tile_height) or 1) end
end
rcon.print("{" .. table.concat(out, ",") .. "}")`) || "{}");
const protosArm = (name) => !!(protoParts[name] && protoParts[name].type === "inserter");
const KIND_TYPE = { "transport-belt": "B", "inserter": "A", "assembling-machine": "M", furnace: "M",
  "furnace-with-flame": "M", "electric-pole": "P", "pipe-to-ground": "B", pipe: "PIPE" };
const kindName = (name) => {
  const t = (protoParts[name] || {}).type;
  return KIND_TYPE[t] || "-";
};
// 每一只臂的两只手：取货面（它朝向的那一侧，reach 格远）与放货面（反方向那一格）。
// 这句话是整段里唯一能抓住"臂装反了"的：装反的臂合法、站得住、card_verify 全绿，然后把整排机器饿死。
// 进料臂的取货面必须是带子，放货面必须是机器；成品臂反过来。任何一只两头都不是这两样的臂，就是画错了。
const STEP_DIR = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };
const armHands = (lane) => {
  const occ = {};
  for (const e of asArr(lane.entities)) {
    const p = protoParts[e.name] || { w: 1, h: 1 };
    const cx = Math.floor(e.position.x - p.w / 2), cy = Math.floor(e.position.y - p.h / 2);
    for (let x = cx; x < cx + p.w; x++) for (let y = cy; y < cy + p.h; y++) occ[x + "," + y] = kindName(e.name);
  }
  const bad = [];
  let feed = 0, product = 0;
  for (const e of asArr(lane.entities)) {
    if (!protosArm(e.name)) continue;
    const step = STEP_DIR[e.direction];
    if (!step) continue;
    const ax = Math.floor(e.position.x), ay = Math.floor(e.position.y);
    // 放货手永远在身后那一格；取货手按"顺着朝向走出去，第一个碰到的是带子还是机器"来判。
    // 从前这里用 `lane.arm_reach` —— 那是**整张卡一个数**，而一张卡可以混档臂（普通臂 + 长手臂，
    // 力量研究多了就会混），于是每只臂都被按错的那一档距离读成"两头都不是"。臂自己的 reach 在这个
    // 引擎里没有原型字段（mod 是从活臂上量的），所以这一格改成不需要 reach 的判法：射线走 1..3，
    // 第一个撞到的 Either 就是它取的东西。
    const behind = occ[(ax - step[0]) + "," + (ay - step[1])];
    let ahead = null;
    for (let d = 1; d <= 3 && !ahead; d++) {
      const k = occ[(ax + step[0] * d) + "," + (ay + step[1] * d)];
      if (k === "B" || k === "M") ahead = k;
    }
    const isProduct = e.product_lane !== undefined || e.product_item !== undefined;
    const isFeed = e.feed_line !== undefined || e.feed_item !== undefined
      || (typeof e.filter === "string" && !isProduct);
    // `two-row` 的臂身上什么标记都没有（实测：那一档铺出来的臂只有 name/position/direction，而它一台机器
    // 两只臂 —— 一只普通一只长手，共用中间那条成品带）。所以"哪一头该是带子"这件事**只有形状知道**的
    // 那几条线才用方向判；没标记的那些只要求"一头带子、一头机器"这一对成立，并按身后那格是机器还是带子
    // 归类计数。判据不假装认得它读不到的东西：一只彻底装反（两头都是带子 / 两头都是机器 / 一头是空地）
    // 照样抓得住，而"方向反但两样齐全"那一型由台架（`belt_line_produces` / `arm_rate_e2e`）去抓 ——
    // 那一型真正的症状是线不产，而它已经在那两套里付费量过。
    if (isProduct) {
      if (behind === "B" && ahead === "M") product = product + 1;
      else bad.push([ax, ay, e.direction, behind || "?", ahead || "?", "P"]);
    } else if (isFeed) {
      if (behind === "M" && ahead === "B") feed = feed + 1;
      else bad.push([ax, ay, e.direction, behind || "?", ahead || "?", "F"]);
    } else if (behind === "M" && ahead === "B") feed = feed + 1;
    else if (behind === "B" && ahead === "M") product = product + 1;
    else bad.push([ax, ay, e.direction, behind || "?", ahead || "?", "-"]);
  }
  return { bad, feed, product };
};

for (const style of ["stacked", "two-row"]) {
  for (const inserter of ["inserter", "long-handed-inserter"]) {
    const lane = call("card_example", { recipe: "advanced-circuit", machines: 3, force: "player",
      style, inserter, orientation: inserter === "inserter" ? "vertical" : "horizontal" }).data;
    if (!lane || lane.fail) {
      check(`${style}/${inserter}: the lane the shape lays exists at all`, false,
        JSON.stringify(lane && (lane.code || lane.fail)).slice(0, 160));
      continue;
    }
    const v = call("card_verify", { card: { name: "aisle", entities: lane.entities,
      surface: "arch-sandbox", force: "player" } });
    // A refusal keeps its list under `detail`, an acceptance under `data` -- reading one of them and
    // printing an empty array is how a suite reports "it failed" with nothing to show for it.
    const errs = asArr((v.data || {}).errors || (v.detail || {}).errors);
    check(`${style}/${inserter}/${lane.orientation}: it STANDS on real ground at this reach`,
      v.ok !== false && errs.length === 0,
      JSON.stringify([v.code, errs.slice(0, 2), lane.arm_reach]).slice(0, 260));
    // 成品不再收进箱子，所以"每只成品箱站在自己那只臂的放货格上"这句话没有了对象。它的位置上站的是牌，
    // 而臂的那两只手仍在：每只臂要么一头带子一头机器（进料），要么一头机器一头带子（成品）。
    const hands = armHands(lane);
    check(`...而 ${style}/${inserter} 的每一只臂都站在它该站的一面：一头带子、一头机器，没有一只是反的`,
      hands.bad.length === 0 && hands.feed > 0 && hands.product > 0
        && hands.feed + hands.product === (lane.parts || {}).arms,
      JSON.stringify([hands.feed, hands.product, (lane.parts || {}).arms,
        hands.bad.slice(0, 3)]).slice(0, 260));
    // 牌的件数 = (头牌数 + 尾牌数) × 2（一块牌是一件发射器加一件面板），头牌数等于机器排数。
    const signParts = asArr(lane.entities).filter((e) => /combinator|display-panel/.test(e.name || ""));
    const heads = Math.max(1, asArr((lane.head || {}).signs || []).length);
    check(`...而 ${style}/${inserter} 的牌都真的在卡上：${heads} 块头牌 + 1 块尾牌，一件不多一件不少`,
      signParts.length === 2 * (heads + 1) && asArr((lane.head || {}).lanes).length >= 1
        && signParts.length === (lane.parts || {}).others,
      JSON.stringify([heads, signParts.map((e) => e.name), (lane.parts || {}).others,
        asArr((lane.head || {}).lanes).length]).slice(0, 220));
  }
}

// The lane arithmetic is a fact about the SHAPE: one machine reaches the two half-lanes of the ONE line
// its own arms stand beside, while the shape may cross the ground with several such lines. The card has to
// say both numbers and never blur one into the other -- a card that says "a row has 4" teaches the reader
// physics that no belt has.
const advTwo = call("card_example", { recipe: "advanced-circuit", machines: 4, force: "player",
  style: "two-row" }).data || {};
const advRow = call("card_example", { recipe: "advanced-circuit", machines: 4, force: "player",
  style: "stacked" }).data || {};
// 一台机器够着的股数 × 这形状有几排机器 = 全卡铺的股数。`MACHINE_ROWS` 是两种排法的**定义**（单排一排、
// 双排两排），不是从答案里抄的数；其余三个数全部读自这张卡自己报的股数与行数。
const MACHINE_ROWS = { stacked: 1, "two-row": 2, "fluid-back": 1 };
// `feed_lanes_laid` is only written when the shape lays MORE lanes than one machine reaches -- for a
// single row the two are the same number. Read it as "the lanes this shape crosses the ground with",
// whichever way the answer chose to say it.
const laidLanes = (f, style) => (f.feed_lanes_laid || (f.inbound_lanes || 0) * MACHINE_ROWS[style]);
check("牌上写的股数 = 进料行数 × 2 减掉借给成品的那几股；一台机器够着的股数是它自己那一排的行数 × 2 同样减",
  [advRow, advTwo].every((d, i) => {
    const f = d.feed_plan || {};
    const style = i === 0 ? "stacked" : "two-row";
    // 借给成品的那几股仍然在带子上、机器也摸得着，但它送的是成品而不是料 —— 所以"这台机器够几条料股"
    // 这个数要把它扣掉（`belt_too_slow` 与 `machines_per_line` 除的就是这个数）。
    const lp = d.lane_plan || {};
    const borrowed = lp.share && lp.share.laid ? (lp.product_lanes_shared || 0) : 0;
    return ((f.inbound_lanes || 0) * MACHINE_ROWS[style]) + borrowed === 2 * (f.lane_rows || 0);
  }) && (advTwo.feed_plan || {}).lane_rows === 2 * ((advRow.feed_plan || {}).lane_rows || 0)
    // "一台机器够着的股数"在两种排法里该是一回事 —— 除的是同一块地面，只是单排那一发把几股让给了成品。
    // 所以比的是"让出去之前"那个数：让出去的那几股不算两种排法的差别，算这一发的 geometry。
    && (advTwo.feed_plan || {}).inbound_lanes
      === ((advRow.feed_plan || {}).inbound_lanes || 0)
        + (((advRow.lane_plan || {}).share || {}).laid
          ? ((advRow.lane_plan || {}).product_lanes_shared || 0) : 0)
    && (advTwo.feed_plan || {}).belt_too_slow !== true && (advRow.feed_plan || {}).belt_too_slow !== true,
  JSON.stringify([(advTwo.feed_plan || {}).lane_rows, (advRow.feed_plan || {}).lane_rows,
    (advTwo.feed_plan || {}).inbound_lanes, (advRow.feed_plan || {}).inbound_lanes,
    (advTwo.feed_plan || {}).belt_too_slow]));
check("...and the reason names both numbers it distinguishes: how many rows the shape lays, and how many lanes one machine reaches",
  !!advTwo.feed_plan && /\d+ feed rows/.test(advTwo.feed_plan.reason || "")
    && /one machine reaches \d+/.test(advTwo.feed_plan.reason || "")
    && (advTwo.feed_plan.reason || "").indexOf("row has") < 0,
  JSON.stringify(advTwo.feed_plan && advTwo.feed_plan.reason).slice(0, 260));

// "带上了"这件事现在由牌说：发射器点了名的料就是这条线带得到的料。所以这一格比的是"牌上那份清单
// 与 unfed 那份，正好把配方的料分完，不重不漏" —— 从前它比的是箱子。
const distinctIn = (lane) => new Set(asArr((lane.head || {}).lanes).map((l) => l.item).filter(Boolean));
const unfedSet = (lane) => new Set(asArr(lane.unfed).map((u) => u.name));
for (const [style, wantShort] of [["stacked", false], ["two-row", false]]) {
  const lane = call("card_example", { recipe: "advanced-circuit", machines: 3, force: "player",
    style }).data || {};
  const needs = asArr((lane.feed_plan || {}).needs);
  const got = distinctIn(lane), miss = unfedSet(lane);
  check(`${style}: 每一种料要么在牌上、要么在 unfed 里，而且不能两边都在`,
    needs.length === 3 && got.size + miss.size === needs.length
    && needs.every((k) => (got.has(k.item) ? 1 : 0) + (miss.has(k.item) ? 1 : 0) === 1)
    && (wantShort ? miss.size > 0 : miss.size === 0),
    JSON.stringify([style, needs.map((k) => k.item), Array.from(got), Array.from(miss)]).slice(0, 300));
}

// The bench, and only the bench, can answer "did the third material ever arrive". `advanced-circuit` is
// not in the fixture list the cycles grant, so the tech is researched for this one run and put back
// afterwards: leaving it on would hand every later suite a recipe it never asked for, and the answers
// that depend on which recipes are unlocked would drift for a reason no one wrote down.
//
// 从前这一格钉的是"三种料的线在单排上什么都不造"，那是那时唯一的一条进料带（2 股 < 3 种料）的几何。
// 现在单排自己就铺两面（4 股），两种形状都带得齐三种料 —— 于是这句话换成了它现在能钉的：**两种都造得出
// 东西**，并且双排不是只造半排（那一半由上面 pair 那几条钉）。
const grant = (on) => luaLine(`local f = game.forces.player
local t = f.technologies["advanced-circuit"]
local r = f.recipes["advanced-circuit"]
if t then t.researched = ${on ? "true" : "false"} end
if r then r.enabled = ${on ? "true" : "false"} end
rcon.print("granted=" .. tostring(${on ? "true" : "false"}))`);
grant(true);
let ranTf, ranRb;
try {
  ranTf = run_lab(advTwo);
  ranRb = run_lab(advRow);
} finally {
  grant(false);
}
const madeTf = asArr(ranTf.verdicts).reduce((s, v) => s + (v.produced || 0), 0);
const madeRb = asArr(ranRb.verdicts).reduce((s, v) => s + (v.produced || 0), 0);
check("...and a THREE-material recipe crafts on the bench in both shapes",
  madeTf > 0 && madeRb > 0 && (ranTf.fed_blocked || 0) === 0 && (ranRb.fed_blocked || 0) === 0,
  JSON.stringify([ranTf.refused, ranRb.refused, madeTf, madeRb,
    (ranTf.diagnostics || {}).starved_furnaces, (ranRb.diagnostics || {}).starved_furnaces]).slice(0, 300));
check("...而两种形状的牌都没有把哪一种料落在外面（unfed 这一格在铺得出的线上是空的）",
  asArr(advTwo.unfed).length === 0 && asArr(advRow.unfed).length === 0
    && asArr((advTwo.head || {}).lanes).length === 3 * MACHINE_ROWS["two-row"]
    && asArr((advRow.head || {}).lanes).length === 3 * MACHINE_ROWS["stacked"],
  JSON.stringify([advTwo.unfed, advRow.unfed,
    asArr((advTwo.head || {}).lanes).length, asArr((advRow.head || {}).lanes).length]).slice(0, 260));

// The lint's own list of what a belt may empty INTO is a claim about the engine, and it had `container`
// in it: a belt pointing at a chest linted clean and, measured in `dev/underground_pair_probe.js` (W3),
// delivered nothing for 35 seconds while the source box kept its items. The refusal is gated here because
// this file is where the shapes are checked against the ground -- and a shape that ends a belt on a box is
// a shape someone will try to draw the day they want one fewer inserter.
const beltAtChest = call("card_verify", { card: { name: "belt-at-box", force: "player",
  surface: "arch-sandbox", entities: [
    { name: "fast-transport-belt", position: { x: 0.5, y: 0.5 }, direction: 4 },
    { name: "steel-chest", position: { x: 1.5, y: 0.5 }, direction: 0 },
  ] } });
const beltErrs = asArr((beltAtChest.detail || {}).errors || (beltAtChest.data || {}).errors);
check("a belt that points into a chest is refused, not linted green",
  beltAtChest.ok === false && beltErrs.some((e) => e.code === "BELT_INTO_SOLID"),
  JSON.stringify([beltAtChest.code, beltErrs.slice(0, 2)]).slice(0, 260));
const beltAtBelt = call("card_verify", { card: { name: "belt-arm-box", force: "player",
  surface: "arch-sandbox", entities: [
    { name: "fast-transport-belt", position: { x: 0.5, y: 0.5 }, direction: 4 },
    { name: "fast-transport-belt", position: { x: 1.5, y: 0.5 }, direction: 4 },
    // the arm `take_tail` lays: beside the line's last cell, reaching for it from the flank, and the box on
    // the far side of the arm. Nobody stands in the cell a belt points at. `inserter` because the fixture
    // save has not researched the speed tiers, and a card_verify refusal for a LOCKED part is not a fact
    // about geometry.
    { name: "inserter", position: { x: 1.5, y: 1.5 }, direction: 0 },
    { name: "steel-chest", position: { x: 1.5, y: 2.5 }, direction: 0 },
  ] } });
check("...while the same line with an arm between the belt and the box is accepted -- the box is filled by "
  + "the arm, which is the only thing that fills boxes",
  beltAtBelt.ok !== false,
  JSON.stringify([beltAtBelt.code, asArr((beltAtBelt.detail || {}).errors).slice(0, 2)]).slice(0, 260));

// ------------------------------------------------------ which arm each shape arms itself with
//
// The arm used to be a hint written in the code next to the belt hint, and on this save it said
// `long-handed-inserter` -- a tier that reaches one tile further and swings at half the rate. Measured on
// the bench, one lane of 6 电路板 machines laid with long arms came out 21x19 and delivered 33 items in a
// 90-second window; the same lane with a short arm is 20x11 and delivers 69. So the arm is now chosen by
// what the SHAPE has to reach (`min_reach` on the style, against measured reach), and this is where the
// two shapes of that rule get pinned: the shapes that only ever reach one tile, and the exception.
const armByStyle = {};
for (const style of ["stacked", "two-row"]) {
  const lane = call("card_example", { recipe: "electronic-circuit", machines: 6, force: "player",
    style }).data || {};
  const c = lane.arm_choice || {};
  armByStyle[style] = c;
  check(`${style}: reaches what the shape needs, not a remembered tier (need ${c.need})`,
    c.need === 1 && (c.reach || 0) >= 1 && !!c.arm && c.arm !== "burner-inserter"
      && !/long-handed|stack/.test(String(c.arm)) && (lane.parts || {}).arms > 0,
    JSON.stringify([c, lane.parts, (lane.footprint || {})]));
}
check("...so every shape on this save is armed with a one-tile arm, and says how it decided",
  Object.keys(armByStyle).length === 2
    && Object.values(armByStyle).every((c) => c.need === 1 && !!c.how),
  JSON.stringify(armByStyle));

// ---------------------------------------------------------------- the lanes a machine can spend//
// `feed_plan.inbound_lanes` decides how long a line may be before its far end cannot be fed, so it has to
// count the lanes ONE MACHINE reaches -- not the lanes the shape happens to cross it with. A belt row is
// two lanes and an inserter stands in the single row between its belt and its machine, so one face = one
// line = two lanes, and a two-row shape lays two feed lines while each of its machines can arm only one of
// them. The first version of this number counted the lines, which promised a row of iron plates twice the
// length that actually eats.
//
// Asserted as a PAIR rather than as a table of per-style numbers: the same recipe, the same machine count,
// 单排 与 双排 各问一次，然后钉两者之间必须成立的关系 —— 一台机器够着的股数是一样的（都是它自己那一面
// 那条带子的两半），双排铺的股数是单排的两倍（因为它有两排机器各一条进料线），于是它一排能喂到的台数也
// 是两倍，而成品带只有一条。写死每个形状的数字，就是又在旁边多记一份没人核对的数。
const laneFacts = {};
for (const style of ["stacked", "two-row"]) {
  // 4 台 + 自动挑带子：两种排法都铺得出（6 台 + 点名黄带在新取整律下要 3 行进料带、按名拒 ——
  // 那一条单独钉在下面，不混进"两排之间的算术"这一节）。
  const res = call("card_example", { recipe: "electronic-circuit", machines: 4, force: "player",
    style });
  const lane = res.data || {};
  const f = lane.feed_plan || {};
  const laid = laidLanes(f, style);
  const lp = lane.lane_plan || {};
  const borrowed = lp.share && lp.share.laid ? (lp.product_lanes_shared || 0) : 0;
  laneFacts[style] = { ok: res.ok === true, mpl: f.machines_per_line || 0, laid, in: f.inbound_lanes || 0,
    rows: f.lane_rows || 0, want: f.lanes_wanted, lines: f.lines_needed, per_lane: f.per_lane,
    borrowed, ceiling: ((lane.belt_ceiling || {}).lines || 0) };
  check(`${style}: 一台机器够着的股数不超过这形状铺的股数（行数 × 2 减借给成品的那几股），且两数对得上`,
    f.inbound_lanes >= 2 && laid + borrowed === 2 * (f.lane_rows || 0)
      && f.inbound_lanes <= laid + borrowed && f.per_lane > 0,
    JSON.stringify([f.inbound_lanes, laid, borrowed, f.lane_rows, f.machines_per_line]));
  // The whole plan's demand is measured against the lines the template actually crosses it with, and a
  // line runs out two ways (materials over lanes, machines over what one row keeps fed) -- so the number of
  // lines is the LARGER of the two. Recomputed from the card's own figures, never copied from its prose.
  check(`...and ${style} counts its lines against the lanes it lays, not against one machine's reach`,
    !f.per_lane || (f.lanes_wanted == null
      || (f.lines_needed === Math.max(1, Math.ceil(f.lanes_wanted / laid),
        Math.ceil((lane.lane_count || 6) / (f.machines_per_line || lane.lane_count || 6)))
        && (f.lanes_wanted <= 2) === !!f.share_one_line)),
    JSON.stringify([f.lanes_wanted, laid, f.share_one_line, f.lines_needed, f.machines_per_line]));
  // No row is sized past what its own machines can reach: the lanes every material wants, rounded the way
  // the answer itself rounds them (≤0.5 条 = 一股，>0.5 = 整条向上), must fit inside `inbound_lanes` --
  // counted for the machines that stand in ONE row.
  const machinesPerRow = Math.max(1, Math.round((f.machines_per_line || 1) / MACHINE_ROWS[style]));
  const need = asArr(f.needs).reduce((s, k) => {
    const count = (k.per_min || 0) / 6 * machinesPerRow;
    return s + (count <= (f.per_lane || 1) ? 1
      : 2 * Math.ceil(count / (2 * (f.per_lane || 1)) - 1e-9));
  }, 0);
  check(`...and ${style}'s own row length fits inside the lanes one machine reaches`,
    f.inbound_lanes > 0 && need <= f.inbound_lanes,
    JSON.stringify([machinesPerRow, need, f.inbound_lanes, f.machines_per_line,
      asArr(f.needs).map((k) => k.per_min)]));
}
check("...so 同一份配方两种排法都铺得出，而双排仍然两排共用 ONE product line",
  // 旧的"双排铺的股数/每线台数 = 单排的两倍"按新取整律不成立了：两种排法在同一发里喂一台机器的
  // 行数可能不一样（4 台 ec 这一发：单排每台 3 股料、双排每排 2 股）。钉的改成两件仍真的：都铺得出、
  // 双排的成品带仍是两排共用那一根（belt_ceiling.lines = 1）。
  laneFacts["stacked"].ok === true && laneFacts["two-row"].ok === true
  && laneFacts["stacked"].mpl > 0 && laneFacts["two-row"].mpl > 0
  && laneFacts["two-row"].ceiling === 1,
  JSON.stringify([laneFacts["stacked"], laneFacts["two-row"]]));

// 新取整律 + 点名慢带子：玩家 2026-10-09 拍的板 —— 带子速度不够就换更快的带子。点名黄带的 6 台 ec
// 要 3 行进料带、一个面只有 2 行 → 按名拒（"点名不许被背着换"）；同一发不点名，挑带子那一遍自动升到
// 装得下的那一档，照样铺得出。两个都是该有的行为，各钉一次。
const pinned6 = call("card_example", { recipe: "electronic-circuit", machines: 6, force: "player",
  style: "stacked", belt: "transport-belt" });
const auto6 = call("card_example", { recipe: "electronic-circuit", machines: 6, force: "player",
  style: "stacked" });
check("新取整律下点名黄带装不下（要 3 行进料带 > 一面 2 行）：按名拒、不背着换；不点名自动升档照样铺得出",
  pinned6.ok === false && pinned6.code === "LINES_BEYOND_SHAPE"
  && auto6.ok === true
  && ((auto6.data || {}).belt_choice || {}).chosen !== "transport-belt"
  && (auto6.data || {}).style === "stacked",
  JSON.stringify([pinned6.code, (pinned6.detail || {}).feed_rows,
    ((auto6.data || {}).belt_choice || {}).chosen, auto6.code]));

// ---------------------------------------------------------------- the pair of rows, fed on both sides
//
// 双排 is the densest shape left -- two rows of machines behind ONE product belt -- and it is also the one
// that can lie most quietly: its two rows are fed by TWO different physical lines, so a single head sign
// cannot describe both. With one sign on the card, the lane numbers repeat (both rows counted their lines
// 1..F), and the bench fed only the row whose belts it happened to find first -- half the machines starved
// while the answer still reported a built lane and a rate for all of them. What only the ground can answer:
//   * the card carries one head per machine row, and each lists EVERY material its own row eats;
//   * the belt lines' numbers are unique across the card, so a lane number names one half of one belt;
//   * the whole thing STANDS, and the whole thing CRAFTS -- both rows, not just the near one.
// 两发各让它自己挑带（钉不得：fast 与 express 都让单排那一发铺不出，见下面那条断言的改法）。
// 这条断言问的是"**第二排在不在造**"，那是每台机器自己的状态能答的事，不是两档形状的产率能对比的事 ——
// 自动挑带时两发走的是不同的路（单排一条成品带喂 8 台，带子自己是它的上限），拿产率对比就会把
// "两条路的容量不同"读成"有一排没在造"（实测双排 319/分、单排 195/分，稳定，与窗口无关）。
const pair4 = call("card_example", { recipe: "electronic-circuit", machines: 8, force: "player",
  style: "two-row" }).data || {};
const single4 = call("card_example", { recipe: "electronic-circuit", machines: 8, force: "player",
  style: "stacked" }).data || {};
check("双排给每一排机器各立一块头牌，两块牌都点齐这一排要吃的每一种料",
  asArr((pair4.head || {}).signs || []).length === 2
    && asArr((pair4.head || {}).signs || []).every((sg) => asArr(sg.lanes).length === 2)
    && asArr((pair4.head || {}).lanes).length === 4 && asArr(pair4.unfed).length === 0,
  JSON.stringify([asArr((pair4.head || {}).signs || []).map((sg) => asArr(sg.lanes)),
    asArr((pair4.head || {}).lanes), pair4.unfed]).slice(0, 300));
// 股道编号是整张卡一套：两根进料行的号不重复，牌上每一个号都指到一根具体的带子。
const lineIds = (d, role) => Object.values((d.entities || [])).filter((e) => e.role === role)
  .map((e) => e.line);
// 一根带子由十几格铺成，所以"行号不重复"问的不是每格，而是**这张卡上的行号集合**：几根进料行就该有
// 几个不同的号，从 1 连续数上去。号少了就是两排各数一遍（台架会把两排的料插进同一根带子，另一排饿死），
// 号不连续就是有一行没被打上标记。
const lineSet = (d, role) => {
  const ids = [...new Set(lineIds(d, role))].sort((a, b) => a - b);
  return { ids, n: ids.length, contiguous: ids.every((v, i) => v === i + 1) };
};
const allLineIds = (d) => [...new Set(lineIds(d, "feed_line").concat(lineIds(d, "product_line")))];
check("...而带子行号是整张卡一套连续的号：进料在前、成品接在后面（牌上的号因此指得着一根具体的带子）",
  lineSet(pair4, "feed_line").contiguous
    && lineSet(single4, "feed_line").contiguous
    && lineSet(pair4, "feed_line").n === (pair4.lane_plan || {}).feed_rows_laid
    && lineSet(single4, "feed_line").n === (single4.lane_plan || {}).feed_rows_laid
    && lineSet(pair4, "product_line").ids
      .every((v, i) => v === (pair4.lane_plan || {}).feed_rows_laid + 1 + i)
    && allLineIds(pair4).length === (pair4.lane_plan || {}).feed_rows_laid
      + (pair4.lane_plan || {}).product_rows_laid
    && allLineIds(single4).length === (single4.lane_plan || {}).feed_rows_laid
      + (single4.lane_plan || {}).product_rows_laid,
  JSON.stringify([lineSet(pair4, "feed_line"), lineSet(pair4, "product_line"),
    lineSet(single4, "feed_line"), (pair4.lane_plan || {}).feed_rows_laid,
    (pair4.lane_plan || {}).product_rows_laid]).slice(0, 300));
const pairV = call("card_verify", { card: { name: "pair4", entities: pair4.entities,
  surface: "arch-sandbox", force: "player" } });
check("...and the shape with a head on each outer line still STANDS",
  pairV.ok !== false && asArr((pairV.detail || {}).errors).length === 0,
  JSON.stringify([pairV.code, asArr((pairV.detail || {}).errors).slice(0, 2)]).slice(0, 260));
const ranPair = run_lab(pair4, 240);
const ranSingle = run_lab(single4, 240);
const madePair = asArr(ranPair.verdicts).reduce((s, v) => s + (v.produced || 0), 0);
const madeSingle = asArr(ranSingle.verdicts).reduce((s, v) => s + (v.produced || 0), 0);
// 两排都在生产的证据是**对照**出来的，不是绝对数字：同样四台机器、同一个配方，双排只喂到一排的话，
// 产量就是单排的一半（那一半机器不会造东西），而臂的摆动速度这类限制对两种形状是一样的 —— 所以这里
// 钉"两排的量对得上"，不钉"量到了牌上那个数"（后者由 dev/belt_line_produces.js 那一条带宽范围钉）。
check("...而且两排机器都在生产：双排那 8 台的机器状态里，在造的不止一半",
  // 直接读每台机器的 `status`（作业末尾读回来的，不是从产率反推）：只有一排在造的话，
  // 另一半会报没料 / 空转。同时留着"两发都有产出、没有饿着的炉子"这两条。
  (() => {
    const st = asArr(ranPair.machine_status);
    const busy = st.filter((m) => m && (m.status === "working" || m.status === "crafting")).length;
    return madePair > 0 && st.length >= 6 && busy >= Math.ceil(st.length / 2)
      && (ranPair.fed_blocked || 0) === 0 && (ranPair.diagnostics || {}).starved_furnaces === 0;
  })(),
  JSON.stringify([ranPair.refused, ranSingle.refused, madePair, madeSingle,
    asArr(ranPair.machine_status).map((m) => m.status),
    (ranPair.diagnostics || {}).starved_furnaces, ranPair.fed_blocked]).slice(0, 320));

// ----------------------------------------------------------- 头牌能写几道，线就有几股
//
// 一块头牌说的是"这条线的哪一股走哪种料"，而一根带子只有两半股：所以牌能写的道数上限就是这一排机器
// 铺的进料行数 × 2。这条之所以要有门禁，是因为形状"把几种料送到了机器边上"这件事读自牌上那份清单 ——
// 牌一旦多写一道，多出来的那种料就不再算缺料，于是"送不齐就换一档重画"永远不触发，一条永远造不出东西
// 的线会被当成一条线报出去。（换形那一半在 dev/belt_head_e2e.js 钉，这里钉牌本身。）
const rbBelt = call("card_example", { recipe: "advanced-circuit", machines: 4, style: "stacked",
  heads: "belt" });
const tfBelt = call("card_example", { recipe: "advanced-circuit", machines: 4, style: "two-row",
  heads: "belt" });
const tfAutoBelt = call("card_example", { recipe: "advanced-circuit", machines: 4, heads: "belt" });
const lanesOf = (d) => asArr((d.head || {}).lanes).length;
const laneNums = (d) => asArr((d.head || {}).lanes).map((l) => l.lane);
check("一块牌每排最多写它自己那几根带的股数，三种料就写三道，不重复也不漏",
  rbBelt.ok && lanesOf(rbBelt.data) === 3
    && new Set(laneNums(rbBelt.data)).size === 3
    && asArr((rbBelt.data.feed_plan || {}).needs).length === 3
    && Math.max(...laneNums(rbBelt.data)) <= 2 * ((rbBelt.data.lane_plan || {}).feed_rows_laid || 0)
    && asArr(rbBelt.data.unfed).length === 0,
  rbBelt.ok ? JSON.stringify([laneNums(rbBelt.data), rbBelt.data.lane_plan.feed_rows_laid,
    asArr(rbBelt.data.unfed)]) : `${rbBelt.code} ${rbBelt.msg}`);
check("...双排每排一块牌，两块牌各写自己那排的三种料，号不重叠",
  tfBelt.ok && asArr((tfBelt.data.head || {}).signs || []).length === 2
    && asArr((tfBelt.data.head || {}).signs || []).every((sg) => asArr(sg.lanes).length === 3)
    && new Set(laneNums(tfBelt.data)).size === 6 && lanesOf(tfBelt.data) === 6
    && asArr(tfBelt.data.unfed).length === 0,
  tfBelt.ok ? JSON.stringify([laneNums(tfBelt.data),
    asArr((tfBelt.data.head || {}).signs || []).map((sg) => asArr(sg.lanes))]) : tfBelt.code);
// 头那块牌写进料、尾那块写成品（玩家 2026-10-07："头尾都放"）。单排是 1 + 1 = 2 块牌（发射器 + 面板
// 各两件），双排多一块头牌 —— 数量从卡上的牌件数数出来，不在句子旁边另记一份。
const tailLanesOf = (d) => asArr((d.tail || {}).lanes).length;
const signParts = (d) => Object.values(d.entities || [])
  .filter((e) => /combinator|display-panel/.test(String(e.name || ""))).length;
check("...而这条线现在的默认那一档把头写成三种料、尾写成品，一只箱子也不要",
  tfAutoBelt.ok && tfAutoBelt.data.style === "stacked" && lanesOf(tfAutoBelt.data) === 3
    && tailLanesOf(tfAutoBelt.data) === 1
    && tfAutoBelt.data.unfed === undefined && (tfAutoBelt.data.parts || {}).chests === 0
    && signParts(tfAutoBelt.data) === (tfAutoBelt.data.parts || {}).others
    && signParts(tfAutoBelt.data) === 4,
  tfAutoBelt.ok ? JSON.stringify([tfAutoBelt.data.style, lanesOf(tfAutoBelt.data),
    tailLanesOf(tfAutoBelt.data), tfAutoBelt.data.unfed, tfAutoBelt.data.parts.chests,
    tfAutoBelt.data.parts.others, signParts(tfAutoBelt.data)]) : tfAutoBelt.code);
check("...双排的牌件数就是它牌数：三块头尾牌，六件硬件，箱子仍然零只",
  tfBelt.ok && signParts(tfBelt.data) === 6 && (tfBelt.data.parts || {}).chests === 0
    && signParts(tfBelt.data) === (tfBelt.data.parts || {}).others,
  JSON.stringify([signParts(tfBelt.data), tfBelt.data.parts]));
// 一条成品带能被几股装满 = 有几个面往它上面放料，这件事是量的（dev/lane_side_probe.js：北臂一股、南臂
// 另一股；**同面两只臂装的是同一股**）。所以同一句流量在两种排法里落到不同的带行数上：
//   * 单排一排机器 → 每根成品带只用上半股 → 900/分要两根带子，牌上每根各写一道；
//   * 双排两排共用 → 每根带子两半都有臂装 → 同样 900/分只要一根，牌上两根号。
// 这一对比就是"运力律"本身：形状说几股就用几股，多写的那一半是向玩家许诺一条永远空着的股道。
const lineOfLane = (n) => Math.max(1, Math.ceil(n / 2));
const halfOfLane = (n) => ((n - 1) % 2) + 1;
const tailByLine = (d) => {
  const m = {};
  for (const l of asArr((d.tail || {}).lanes)) {
    const k = lineOfLane(l.lane);
    if (!m[k]) m[k] = new Set();
    m[k].add(halfOfLane(l.lane));
  }
  return m;
};
const crowdedPair = ceiled({ machines: fitLo, style: "two-row", belt: "transport-belt" });
const crowdedNow = slowLane(fitLo);
const singleByLine = tailByLine(crowdedNow), pairByLine = tailByLine(crowdedPair);
check("同样多的台数：单排一根成品带只写一股（所以它要两根才带走得完），牌上的号不指到空的半股里去",
  !!crowdedNow.belt_ceiling && Object.keys(singleByLine).length === (crowdedNow.lane_plan || {}).product_rows_laid
    && Object.keys(singleByLine).length > 1
    && Object.values(singleByLine).every((s) => s.size === 1)
    && tailLanesOf(crowdedNow) === Object.keys(singleByLine).length
    && Math.abs(crowdedNow.belt_ceiling.per_min - crowdedNow.belt_ceiling.claimed_per_min) < 1e-6,
  JSON.stringify([Object.keys(singleByLine).map((k) => [k, [...singleByLine[k]]]),
    (crowdedNow.lane_plan || {}).product_rows_laid, crowdedNow.belt_ceiling]));
check("...而双排把两半都写上：同一句流量落在一根共用带上（" + fitLo + " 台，两半各有自己的面）",
  !!crowdedPair.belt_ceiling
    && Object.keys(pairByLine).length === (crowdedPair.lane_plan || {}).product_rows_laid
    && Object.values(pairByLine).every((s) => s.size === 2)
    && tailLanesOf(crowdedPair) === 2 * Object.keys(pairByLine).length
    && (crowdedPair.lane_plan || {}).product_rows_laid
      < (crowdedNow.lane_plan || {}).product_rows_laid,
  JSON.stringify([Object.keys(pairByLine).map((k) => [k, [...pairByLine[k]]]),
    (crowdedPair.lane_plan || {}).product_rows_laid, crowdedPair.belt_ceiling]));
// 两面的进料臂：一台机器上下各一根，这才是"两面各一条带子"的意思。
//
// 这一条从前数的是"臂站在第几行"（写死 3 和 8），而 8 其实是**带子那一行**，第二面的臂站在 7 ——
// 断言就是这么记的旁边一份数字，正是 styles.lua 文件头禁的那类东西（"数量从铺下来的 parts 数出来，
// 不在旁边另记一份"）。现在从实体自己扫：一只臂算进料臂，当且仅当沿它朝向那一侧最多 3 格内找到带子
// （它的取货面），且沿反方向最多 3 格内找到机器（它的放货面）。reach 用扫的范围兜住，不读臂档。
// 这条不读 feed_plan.inbound_lanes —— 那个数就是被测的 styles 层自己算的，用它断言自己等于没断言。
const DIRS = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };
const SIZES = {};
const sizeOf = (name) => {
  if (SIZES[name] !== undefined) return SIZES[name];
  const got = luaLine(`local p = prototypes.entity["${name}"]
    rcon.print(p and (tostring(p.tile_width) .. "x" .. tostring(p.tile_height)) or "1x1")`);
  const m = String(got).match(/^(\d+)x(\d+)$/);
  SIZES[name] = m ? [Number(m[1]), Number(m[2])] : [1, 1];
  return SIZES[name];
};
// 分类问原型，不问名字。`electromagnetic-plant` 是一台装配机器，但它的名字里没有 "assembling"，
// 于是从前那份按名字写的正则把它算成 "-"，站在它旁边的臂就被当成"没人喂的臂"整排漏数 —— 门禁绿着，
// 因为漏的是同一侧的分子和分母。名字是文案，`type` 才是引擎的说法。
const TYPES = {};
const typeOf = (name) => {
  if (TYPES[name] !== undefined) return TYPES[name];
  const got = luaLine(`local p = prototypes.entity["${name}"]
    rcon.print(p and tostring(p.type) or "?")`);
  TYPES[name] = String(got).trim();
  return TYPES[name];
};
const BELT_TYPES = { "transport-belt": true, "underground-belt": true };
const MACHINE_TYPES = { "assembling-machine": true, furnace: true, boiler: true, reactor: true,
  centrifuge: true, lab: true, "furnace-with-flame": true };
const partKind = (name) => (BELT_TYPES[typeOf(name)] ? "B"
  : typeOf(name) === "inserter" ? "A" : (MACHINE_TYPES[typeOf(name)] ? "M" : "-"));
const gridOf = (d) => {
  const g = new Map();
  for (const e of asArr(d.entities)) {
    const p = e.position || {};
    const cx = typeof p.x === "number" ? p.x : p[0];
    const cy = typeof p.y === "number" ? p.y : p[1];
    if (typeof cx !== "number" || typeof cy !== "number") continue;
    const [w, h] = sizeOf(e.name);
    const k = partKind(e.name || "");
    if (k === "-") continue;
    for (let x = Math.floor(cx - w / 2); x < Math.floor(cx - w / 2) + w; x++)
      for (let y = Math.floor(cy - h / 2); y < Math.floor(cy - h / 2) + h; y++) g.set(x + "," + y, k);
  }
  return g;
};
// → { rows: {y: 几根}, faces: 几个不同的行 }
const intakeArms = (d) => {
  const g = gridOf(d), rows = {};
  for (const e of asArr(d.entities)) {
    if (!/inserter/.test(e.name || "")) continue;
    const p = e.position || {};
    const cx = typeof p.x === "number" ? p.x : p[0];
    const cy = typeof p.y === "number" ? p.y : p[1];
    const [w, h] = sizeOf(e.name);
    const x = Math.floor(cx - w / 2), y = Math.floor(cy - h / 2);
    const dir = DIRS[e.direction];
    if (!dir) continue;
    let seesBelt = false, seesMachine = false;
    for (let t = 1; t <= 3; t++) {
      if (g.get((x + dir[0] * t) + "," + (y + dir[1] * t)) === "B") seesBelt = true;
      if (g.get((x - dir[0] * t) + "," + (y - dir[1] * t)) === "M") seesMachine = true;
    }
    if (seesBelt && seesMachine) rows[y] = (rows[y] || 0) + 1;
  }
  return { rows, faces: Object.keys(rows).length };
};
const tfArms = tfBelt.ok ? intakeArms(tfBelt.data) : { rows: {}, faces: 0 };
const rbArms = rbBelt.ok ? intakeArms(rbBelt.data) : { rows: {}, faces: 0 };
// 每一排的进料臂数 = 这排的台数 × 这排读的进料线条数。台数与行数都不写在句子旁边：`faces` 是扫出来的
// 排数，`feed_rows_laid` 是牌自己那套行号的条数，`parts.machines` 是数出来的台数。
const feedRowsPerFace = (d, faces) => ((d.lane_plan || {}).feed_rows_laid || 0) / Math.max(1, faces);
const armClaim = (d, arms) => {
  const total = Object.values(arms.rows).reduce((s, n) => s + n, 0);
  return { total, want: (d.parts || {}).machines * feedRowsPerFace(d, arms.faces),
    faces: arms.faces, rows: arms.rows, perFace: feedRowsPerFace(d, arms.faces) };
};
check("单排：一排在同一面上自取的进料臂 = 台数 × 这排读的带条数，并且只有一面",
  rbBelt.ok && rbArms.faces === 1 && armClaim(rbBelt.data, rbArms).total === armClaim(rbBelt.data, rbArms).want,
  JSON.stringify(armClaim(rbBelt.data, rbArms)));
check("...而双排两面各有自己的那一排进料臂，两面的臂数加起来正是台数 × 每面的带条数",
  tfBelt.ok && tfArms.faces === 2 && Object.values(tfArms.rows).every((n) => n > 0)
    && armClaim(tfBelt.data, tfArms).total === armClaim(tfBelt.data, tfArms).want,
  JSON.stringify(armClaim(tfBelt.data, tfArms)));


// ---- 线计划：要几条带是算出来的，不是形状的名字（2026-10-06 #6）
//
// 需求侧从流量来（料占几股 → 几条进料带；**每个**产物都算 → 几条成品带），供给侧从量到的臂档来
// （dev/belt_stack_probe.js：一只臂只喂"距离 = 它 reach"那一行）。这里断言的是这两个数对得上、
// 而且"这个形状没铺够"和"换形状也没救"是分开的两句话 —— 混成一句，下一步的建议就会说错。
const lpOf = (d) => d.lane_plan || {};
const red4 = call("card_example", { recipe: "advanced-circuit", machines: 4 });
const lpRed = lpOf(red4.data || {});
check("红板×4：进料要 2 条（3 种料 / 每带 2 股），成品要么独占 1 条、要么借进料行的远股走掉",
  red4.ok && lpRed.feed_rows_needed === 2
  && (lpRed.share && lpRed.share.laid
    // 共用那一行铺成了：成品不再独占一行，它走进料行里离机器远的那一股（2*(行-1)+1）。
    // 行的数是 0，股的数要 ≥1，而且那个号必须是**奇号**（远股）并且不落在任何进料号上。
    ? (lpRed.product_rows_needed === 0 && lpRed.product_lanes_shared >= 1
       && asArr(lpRed.share.product_lane_of).length === lpRed.product_lanes_shared
       && asArr(lpRed.share.product_lane_of).every((n) => n % 2 === 1)
       && !asArr(lpRed.share.feed_lane_of).some((n) => asArr(lpRed.share.product_lane_of).includes(n)))
    : lpRed.product_rows_needed === 1),
  JSON.stringify([lpRed.feed_rows_needed, lpRed.product_rows_needed, lpRed.share,
    lpRed.product_lanes_shared]));
// 铺下来的形状把这两条都铺到了，所以这一张卡上两个 shortfall 都是 0、`blocked_by` 根本不该出现：
// 一句"被什么绑住"在没绑住的时候是噪音，而把绑住的东西写成"还剩几只箱子"更是 —— 卡上一只箱子都没有。
check("...而默认那一档把 2 条进料带铺够了，成品也有一股可走（独占的行或借来的那股）：两个 shortfall 是 0，blocked_by 不出现",
  lpRed.feed_rows_laid === 2
  && ((lpRed.share && lpRed.share.laid && (lpRed.product_lanes_shared || 0) >= 1)
    || lpRed.product_rows_laid === 1)
  && lpRed.short_feed === 0 && lpRed.short_product === 0 && lpRed.blocked_by === undefined
  && lpRed.chest_total === 0 && lpRed.chest_free === true,
  JSON.stringify([lpRed.feed_rows_laid, lpRed.product_rows_laid, lpRed.product_lanes_shared,
    lpRed.short_feed, lpRed.short_product, lpRed.blocked_by, lpRed.chest_total, lpRed.chest_free]));
check("...箱子按种类数出来那一格在零箱子的卡上是空的（玩家指的第一种：机器级出料箱）",
  Object.keys(lpRed.chests_by_role || {}).length === 0 && (red4.data || {}).parts.chests === 0,
  JSON.stringify([lpRed.chests_by_role, (red4.data || {}).parts]));
// 绑住的是哪个数，`blocked_by` 就得说出哪个数 —— 这里钉的是规矩本身。要它真的绑住一次，就用一个比
// 一个面叠得起的行数更多的计划：最慢那一档带子 + 大量台数，缺的是**行数**，不是箱子。
const belts2 = call("card_example", { recipe: "electronic-circuit", machines: 40,
  belt: "transport-belt", force: "player" });
const lpBelts = lpOf(belts2.data || {});
const belts2Says = String((belts2.data || lpBelts) && lpBelts.blocked_by || "");
check("40 台绿板用最慢那档带子：铺不出来的那一发按名拒，并把「要几条」与「一个面叠得起几条」都交出来",
  belts2.ok === false && belts2.code === "LINES_BEYOND_SHAPE"
    && (belts2.detail || {}).feed_rows > (belts2.detail || {}).rows_per_face
    && (belts2.detail || {}).rows_per_face
      === Math.min(asArr((belts2.detail || {}).arm_reach_tiers).length,
        (belts2.detail || {}).machine_height)
    && belts2Says === "" && Object.keys(lpBelts).length === 0,
  JSON.stringify([belts2.code, belts2.detail, belts2Says]).slice(0, 220));
// 供给侧必须是量出来的数，不是写死的 2。
const tiers = lpRed.arm_reach_tiers || [];
check("一个面能叠几条带 = min(臂的互不相同 reach 档数, 机器深度)，两边都是读回来的",
  tiers.length >= 1 && lpRed.rows_per_face
    === Math.min(tiers.length, ((protoParts[(red4.data || {}).components && (red4.data.components.furnace)] || {}).h) || 2)
    && lpRed.rows_per_face >= 1 && lpRed.rows_per_face <= tiers.length,
  JSON.stringify([tiers, lpRed.rows_per_face, (red4.data || {}).components && (red4.data.components.furnace),
    protoParts && protoParts["stone-furnace"] && protoParts["stone-furnace"].h]));
// 多产物：铀处理同时出 U-235 与 U-238。从前成品只认第一个（0.105/分），于是这条线被当成
// 几乎不用带子 —— 现在两边都算，股数能独立核对。
//
// 科技只为这一跑借来，跑完照原样还，跟上面 advanced-circuit 的 `grant` 同一个道理：全套门禁里这条
// 排在 smoke 之后，而 smoke 把科技收成它自己那份名单（`uranium-processing` 那档被撤，它同时解锁
// 离心机与这条配方），于是卡按名拒、contract 拿回来是空的 —— 单跑全绿、连跑一条红，红的原因没人写下来。
// 留档：2026-10-06 那次 235/1 就是它，FAIL 的数是 ["NO_AVAILABLE_PART",[],null,0]。
const urWasOn = /^true$/.test(luaLine(`local t = game.forces.player.technologies["uranium-processing"]
  rcon.print(t and tostring(t.researched) or "absent")`));
const grantUr = (on) => luaLine(`local f = game.forces.player
local t = f.technologies["uranium-processing"]
local r = f.recipes["uranium-processing"]
local c = f.recipes["centrifuge"]
if t then t.researched = ${on ? "true" : "false"} end
if r then r.enabled = ${on ? "true" : "false"} end
if c then c.enabled = ${on ? "true" : "false"} end
rcon.print("ur_granted=" .. tostring(${on ? "true" : "false"}))`);
grantUr(true);
let ur;
try {
  ur = call("card_example", { recipe: "uranium-processing", machines: 3 });
} finally {
  grantUr(urWasOn);
}
const lpUr = lpOf(ur.data || {});
// 借到了科技还拒，那才是真话：说的是"这台跑不了这个配方"（#11 那条洞的表现），不是算成 0 股。
check("多产物那条要么量到数、要么按名拒并说出为什么（不静默算成 0 股）",
  ur.ok === false ? Boolean(ur.code) : true, JSON.stringify([ur.code, ur.msg]));
const outs = Object.values(((ur.data || {}).contract || {}).outputs || {});
const lanesFromContract = outs.reduce((a, rate) => a + Math.ceil(rate / (lpUr.per_lane_min || 900)), 0);
check("多产物配方的成品股数把每个产物都算进去（能按 contract 独立复算）",
  ur.ok && outs.length >= 2 && lpUr.product_lanes_wanted === lanesFromContract,
  JSON.stringify([ur.code, outs, lpUr.product_lanes_wanted, lanesFromContract]));
// 带子点名钉死在这一档：这条断言说的是"产量大到一条带装不下 ⟹ 成品带自己涨到 2"，而那个前提本来就是
// 带子档位的函数 —— 借来 express/turbo 之后自动挑到快带，一条就装得下，前提没了；钉最慢那一档呢，30 台的
// **进料**又叠不起一个面（LINES_BEYOND_SHAPE）。fast 这一档是两边都成立的唯一那一档：成品要 2 行、进料
// 还装得下。钉住它，它测的才一直是"装不下会不会自己加分行"，而不是"这个存档今天开到第几档带子"。
// 这条的前提是"产量大到一条带装不下"，而那句话是**带子档位与台数的函数**：写死 30 台在旧的存档梯子下
// 恰好落到 2 行，借到 express/turbo 之后它要么一行装下、要么进料那头先叠不起（实测：30 台 fast 要 10 行 ⟹
// LINES_BEYOND_SHAPE）。所以这里不再写死台数：在台数梯子上找出**成品刚好要 2 行**的那一发，找不到就把
// 各档台数实际要几行交出去（红得看得见，而不是被我调一个数调到绿）。
let cable30 = null; const cableTried = [];
for (const m of [8, 12, 16, 20, 24, 30]) {
  const one = call("card_example", { recipe: "copper-cable", machines: m, force: "player" });
  const lp = lpOf(one.data || {});
  cableTried.push([m, one.ok === true, lp.product_rows_needed, lp.feed_rows_needed]);
  if (one.ok && lp.product_rows_needed === 2) { cable30 = one; break; }
}
if (!cable30) cable30 = { ok: false, code: "NO_SAMPLE", detail: cableTried };
const lpCable = lpOf((cable30 || {}).data || {});
check("产量大到一条带装不下：成品带数自己涨到 2，而不是「加只箱子」",
  cable30.ok && lpCable.product_rows_needed === 2 && lpCable.beyond_any_shape === false,
  JSON.stringify([lpCable.product_rows_needed, lpCable.product_lanes_wanted, lpCable.beyond_any_shape]));

// ---------------------------------------------------------------- helmod 那一句"要几条带子"（#35 ③）
// 今天钉的是 0.76.0 那一版"向上贴半条"：0.4→0.5、0.6→1、0.8→1、1.1→1.5、1.6→2。
// 玩家 2026-10-09 口述的那一条（"混用时 0.8 就单独占一整条即可，0.4 占半条，另外半股如果成品数量满足的
// 话，就可以给成品"= ≤0.5 占一股、>0.5 整条向上：1.1→2、1.6→2）**要连着"剩余那半股让给别人"一起做**：
// 单独换它，electronic-circuit 6 台在 stacked 从 4 股变 5 股 → 三行 > 一个面两行 → LINES_BEYOND_SHAPE，
// 是掉覆盖率。所以这张表跟着 `belt_need` 那一行一起换，不换半边。
// 这里钉的是那张表本身，不是它落到地上的样子 —— 行数仍由几何律决定（股数 ÷ 每行能装几股），最后一并钉。
// 分母不写死：先问一次"这一档带子一分钟过几件"（`belt_need_helmod.per_min`，里面已经折了这条力量
// `belt_stack_size_bonus` 那份加成），再按倍率造流量。这样加成是 0 级还是 2 级都跑得出同一张表。
const bnProbe = call("card_example", { recipe: "iron-plate", machines: 10,
  belt: "transport-belt", force: "player" });
const bn0 = (bnProbe.data || {}).belt_need_helmod || {};
const beltCap = Number(bn0.per_min);
// 换机器会让分子退回自算（3b4 那条规矩），所以这里用答案自己说的那台机器去造 flows，保证读到的
// `belt_need_helmod` 是"我们递给 helmod 那份数"算出来的，而不是按地上那台重算的那份。
const laidFurnace = ((bnProbe.data || {}).components || {}).furnace;
const FORCE_BONUS = luaLine(`rcon.print(tostring(game.forces.player.belt_stack_size_bonus or 0))`);
const BELT_TABLE = [[0.4, 0.5, 1], [0.6, 1, 2], [0.8, 1, 2], [1.1, 2, 4], [1.6, 2, 4]];
const bnRows = BELT_TABLE.map(([want, belts, lanes]) => {
  const perMin = want * beltCap;
  const r = call("card_example", { recipe: "iron-plate", machines: 10,
    belt: "transport-belt", force: "player",
    flows: { source: "helmod", machines: 10, crafts_per_min: perMin, base_time: 1,
      machine: laidFurnace,
      feed: [{ item: "iron-ore", per_min: perMin, per_craft: 1 }],
      products: [{ item: "iron-plate", per_min: perMin, per_craft: 1 }],
      fluids: [], product_fluids: [], fuel: [] } });
  const bn = (r.data || {}).belt_need_helmod || {};
  const one = asArr(bn.products)[0] || {};
  return { want, expect: belts, belts: Number(one.belts), lanes: Number(one.lanes),
    raw: Number(one.raw), tier: bn.belt, bonus: Number(bn.bonus),
    rows: lpOf(r.data || {}).product_rows_needed };
});
check("belt_need 的取整表：0.4→0.5、0.6→1、0.8→1、1.1→2、1.6→2（≤0.5 占一股，>0.5 整条向上；点名慢带子装不下会按名拒、不点名自动升档）",
  beltCap > 0 && bnRows.every((r) => Math.abs(r.belts - r.expect) < 1e-9),
  JSON.stringify([beltCap, laidFurnace, bnRows]).slice(0, 340));
check("...而股数就是条数的两倍（一条带两条股，实测在 dev/belt_rate_e2e.js 量的那条律）",
  bnRows.every((r) => Math.abs(r.lanes - r.belts * 2) < 1e-9 && r.tier === "transport-belt"),
  JSON.stringify(bnRows.map((r) => [r.belts, r.lanes, r.tier])).slice(0, 300));
check("...加成不是写死的：报出来的 bonus 就是这一发读到的 force.belt_stack_size_bonus",
  bnRows.every((r) => r.bonus === Number(FORCE_BONUS)),
  JSON.stringify([FORCE_BONUS, bnRows.map((r) => r.bonus)]).slice(0, 240));
// 加成不是常数 —— 玩家 2026-10-08 报的那件事（"helmod 选的带子偏好，它算的量和你算的不一样"）的另一半：
// 同一份件数在 0 级与 1 级 `(1 + belt_stack_size_bonus)` 上该差一倍。这里按本仓库的规矩借 force 上那一格，
// 跑完**必须照原样还** —— 不还原的话，下一套门禁看到的存档就不是它以为的那个（`dev/test.sh` 那一串里
// 已经为此小心过两次：`belt_head_e2e` 还科技、`helmod_ghosts_e2e` 还钢炉配方）。
const setBonus = (v) => luaLine(`local f = game.forces.player
f.belt_stack_size_bonus = ${v}
rcon.print(tostring(f.belt_stack_size_bonus))`);
const bonusBefore = Number(FORCE_BONUS);
let bnUp = {}, bonusRestored = false;
try {
  if (Number(setBonus(bonusBefore + 1)) !== bonusBefore + 1) throw new Error("did not stick");
  const sameFlow = 1.1 * beltCap;      // 与上面表里 1.1 那一行**同一份件数**
  const probeUp = call("card_example", { recipe: "iron-plate", machines: 10,
    belt: "transport-belt", force: "player",
    flows: { source: "helmod", machines: 10, crafts_per_min: sameFlow, base_time: 1,
      machine: laidFurnace,
      feed: [{ item: "iron-ore", per_min: sameFlow, per_craft: 1 }],
      products: [{ item: "iron-plate", per_min: sameFlow, per_craft: 1 }],
      fluids: [], product_fluids: [], fuel: [] } });
  bnUp = (probeUp.data || {}).belt_need_helmod || {};
} finally {
  bonusRestored = Number(setBonus(bonusBefore)) === bonusBefore;
}
const upOne = asArr(bnUp.products)[0] || {};
check("加成升一级：同一份件数的分母翻倍、raw 折半（1.1 条变 0.55 条 → 贴成 1 条），而且借的那一格照原样还了",
  Number(bnUp.bonus) === bonusBefore + 1
    && Math.abs(Number(bnUp.per_min) - beltCap * 2) < 1e-6
    && Math.abs(Number(upOne.raw) - 0.55) < 1e-9 && Math.abs(Number(upOne.belts) - 1) < 1e-9
    && bonusRestored,
  JSON.stringify([bonusBefore, bnUp.bonus, bnUp.per_min, beltCap, upOne, bonusRestored]).slice(0, 320));
// 两个口径并列的意义就在这里：helmod 那一侧说"1.6 条带（3.2 股→贴成 4 股）"，行数那一侧仍由"这根带子
// 能被几个面装满"除出来（单排一个面、双排两个面），谁也不许替换谁。
const twoRowRows = call("card_example", { recipe: "iron-plate", machines: 40, style: "two-row",
  belt: "transport-belt", force: "player" });
const trBn = (twoRowRows.data || {}).belt_need_helmod || {};
const trLp = lpOf(twoRowRows.data || {});
check("行数仍然是几何律（股数 ÷ 每行能装几股），不是把 helmod 那条数搬过去",
  trBn.product_belts !== undefined
    && Math.ceil(Number(trLp.product_lanes_wanted) / 2) === Number(trLp.product_rows_needed)
    && Number(trBn.product_belts) * 2 >= Number(trLp.product_lanes_wanted),
  JSON.stringify([trBn, trLp.product_lanes_wanted, trLp.product_rows_needed]).slice(0, 320));

// 无箱这一条现在说的是整张卡，不是某一个形状：留下的两种形状都无箱，`lane_plan` 那两个 shortfall 都是
// 0，而 `chests_by_role` 这份"按种类数出来的箱子"在零箱子的卡上必须是空的 —— 它从前是这条文件用来
// 区分"机器级出料箱"和"线头箱"的那格，今天它该是一个都没有。
for (const style of ["stacked", "two-row"]) {
  const d = call("card_example", { recipe: "advanced-circuit", machines: 4, force: "player",
    style }).data || {};
  const lp = lpOf(d);
  check(`${style} 真的无箱：零箱、进料带铺够、成品带也铺够，chests_by_role 是空的`,
    d.style === style && lp.chest_free === true && lp.chest_total === 0
      && Object.keys(lp.chests_by_role || {}).length === 0
      && lp.short_feed === 0 && lp.short_product === 0 && (d.parts || {}).chests === 0,
    JSON.stringify([d.code, style, lp.chest_free, lp.chest_total, lp.chests_by_role,
      lp.short_feed, lp.short_product, (d.parts || {}).chests]));
}

// 总线那一扇门现在**铺得出**控制器了：每台机器一只选择组合器，加一只发射器（split/rotate）或每种候选
// 一只算术盒（shortage）。这一节钉的是"圈真的在卡上"：件数、位次、谁接谁、以及这张卡站得住真地面。
// 0.61.0 那一刀把这一圈连同放置链删了，删完只剩 `laid_controllers = 0` 那句自报；今天它是数出来的。
// 而这一台的 2.0 把选择组合器锁在 `advanced-combinators` 后面 —— 一句"这个存档放不出选择器"如果不点名
// 欠哪个科技，调用者只能自己去翻原型。科技按老规矩借、用完还。
const selWasOn = /^true$/.test(luaLine(`local t = game.forces.player.technologies["advanced-combinators"]
  rcon.print(t and tostring(t.researched) or "absent")`));
const grantSel = (on) => luaLine(`local f = game.forces.player
local t = f.technologies["advanced-combinators"]
local r = f.recipes["selector-combinator"]
if t then t.researched = ${on ? "true" : "false"} end
if r then r.enabled = ${on ? "true" : "false"} end
rcon.print("sel=" .. tostring(${on ? "true" : "false"}))`);
let busCard = { ok: false }, busOff = { ok: false }, shortCard = { ok: false };
let busVerify = { ok: false };
grantSel(true);
const BUS = ["iron-gear-wheel", "copper-cable"];
try {
  busCard = call("card_example", { recipe: "electronic-circuit", machines: 3, force: "player",
    style: "stacked", heads: "belt", bus: BUS });
  shortCard = call("card_example", { recipe: "electronic-circuit", machines: 3, force: "player",
    style: "stacked", heads: "belt", bus: BUS, bus_mode: "shortage", bus_target: 40 });
  // 引擎那一路的核对必须在**科技还开着**的时候跑：卡里那三只选择器在研究关掉之后是
  // `LOCKED_ENTITY`，而那句话是对的（这一发放不出它们）—— 只是它不是这一发要问的事。
  busVerify = call("card_verify", { card: busCard.data });
  grantSel(false);
  // 还不回原状而是先关一下：下面那一发要的就是"这支力量没解锁选择器"那个样子。
  busOff = call("card_example", { recipe: "electronic-circuit", machines: 2, force: "player",
    style: "stacked", heads: "belt", bus: ["iron-gear-wheel"] });
} finally {
  if (selWasOn) grantSel(true);
}
const busEnts = ((busCard.data || {}).entities) || [];
const isCtrl = (e) => e.role === "control" || e.role === "bus";
const sels = busEnts.filter((e) => e.circuit && e.circuit.select);
const emit = busEnts.filter((e) => e.circuit && e.circuit.emitter && e.role === "bus");
const busWires = asArr((busCard.data || {}).wires);
check("总线那一圈铺在卡上：每台机器一只选择器，整卡一只发射器，卡自己数的数与件表一致",
  busCard.ok === true && sels.length === 3 && emit.length === 1
    && busEnts.filter(isCtrl).length === ((busCard.data.bus || {}).laid_controllers)
    && busCard.data.bus.laid_controllers === 4
    && busEnts.filter((e) => /assembling-machine/.test(e.name))
      .every((e) => !!(e.circuit || {}).recipe_control),
  JSON.stringify([busCard.code, busCard.data && busCard.data.bus,
    { sels: sels.length, emit: emit.length, ctrl: busEnts.filter(isCtrl).length }]).slice(0, 320));
check("每位选择器要的是**自己那一位**（0 起），而发射器把清单按位次发成不同的数 —— 并列时排序是引擎的事，计划说不出",
  JSON.stringify(sels.map((e) => e.circuit.select.index).sort((a, b) => a - b)) === "[0,1,2]"
    && JSON.stringify(asArr(emit[0] && emit[0].circuit.emitter).map((sg) => [sg.type, sg.name, sg.count]))
      === JSON.stringify([["recipe", BUS[0], 1], ["recipe", BUS[1], 2]]),
  JSON.stringify([sels.map((e) => e.circuit.select.index), emit[0] && emit[0].circuit.emitter]));
check("线在卡上说得出口：每台机器接到自己那只选择器，每只选择器接到总线盒",
  busWires.length >= 6 && sels.every((s) => {
      const si = busEnts.indexOf(s) + 1, ei = busEnts.indexOf(emit[0]) + 1;
      return busWires.some((w) => w.from === si && /assembling/.test((busEnts[w.to - 1] || {}).name || ""))
        && busWires.some((w) => w.from === ei && w.to === si);
    }),
  JSON.stringify([busWires.length, busWires.slice(0, 8)]));
check("带子长在整个形状之外：控制带那两行的每一件都站在成品行以南，压不到别人的格子",
  sels.every((s) => busEnts.filter((e) => /belt|inserter/.test(e.name))
    .every((b) => b.position.y < s.position.y))
    && new Set(sels.map((s) => `${s.position.x},${s.position.y}`)).size === sels.length,
  JSON.stringify(sels.map((s) => [s.position.x, s.position.y])));
// 引擎那一侧的凭据：这张卡真能在地上立起来（lint 的静态判据 + `verify` 的实测重叠/朝向）。
check("而这张带总线的卡站得住真地面：引擎那一侧没有 error（裸带出口与外电是 warning，不是拒）",
  busVerify.ok === true && asArr((busVerify.data || {}).errors).length === 0
    && !asArr((busVerify.data || {}).errors).some((x) => /CIRCUIT|OVERLAP|BELT_INTO_SOLID/.test(String(x.code))),
  JSON.stringify([busVerify.code, (busVerify.data || {}).errors]).slice(0, 300));
const shortSels = (((shortCard.data || {}).entities) || []).filter((e) => e.circuit && e.circuit.select);
const shortBoxes = (((shortCard.data || {}).entities) || []).filter((e) => e.circuit && e.circuit.deficiency);
check("shortage 那一档：每种候选一只算术盒（料减掉、写在配方名下），而每位选择器改成**从最缺的排起**",
  shortCard.ok === true && shortBoxes.length === BUS.length
    && shortBoxes.every((b) => b.circuit.deficiency.target === 40
      && b.circuit.deficiency.item && b.circuit.deficiency.recipe)
    && shortSels.length === 3 && shortSels.every((s) => s.circuit.select.max === true)
    && ((((shortCard.data || {}).bus || {}).controller_boxes) || 0) === BUS.length,
  JSON.stringify([shortCard.code, shortCard.data && shortCard.data.bus,
    shortBoxes.map((b) => b.circuit.deficiency)]).slice(0, 320));
const busSel = (((busOff.detail || {}).candidates) || {})["selector-combinator"] || {};
check("...而“这一发放不出选择器”那句点名欠的科技，并把引擎那三层读数一起交出来",
  busOff.ok === false && busOff.code === "NO_AVAILABLE_PART"
    && /advanced-combinators/.test(String(busOff.msg))
    && busSel.recipe_present === true && busSel.recipe_enabled === false,
  JSON.stringify([busOff.code, busOff.msg, busOff.detail && busOff.detail.candidates]).slice(0, 320));
if (!techWasOn) luaLine(`local t = game.forces.player.technologies["circuit-network"]
  if t then t.researched = false end rcon.print("returned")`);

// 钢炉那一格借到最后一发为止：下面「转 90°」那一节还要再点一次它。
if (!steelWasOn) luaLine(`local r = game.forces.player.recipes["steel-furnace"]
if r then r.enabled = false end rcon.print("returned")`);

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
