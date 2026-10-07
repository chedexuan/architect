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

const CONFIGS = [
  { machines: 1 }, { machines: 2, spacing: "standard" }, { machines: 3, spacing: "loose", outlets: 2 },
  { machines: 4, inserter: "long-handed-inserter", furnace: "steel-furnace" },
  // A second style, on the same part list, because the point of the registry is the comparison: two
  // rows of the same four machines, one per belt line and one per spine. The long-handed pair is the
  // interesting one -- every row offset in that style is a multiple of the reach, so a wrong R shows
  // up as an overlap rather than as a slightly wide box.
  { machines: 2, style: "row-belts" }, { machines: 4, style: "row-belts", spacing: "standard" },
  { machines: 2, style: "sandwich-2" },
  { machines: 5, style: "sandwich-2", spacing: "standard" },
  { machines: 4, style: "sandwich-2", inserter: "long-handed-inserter", furnace: "steel-furnace" },
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
  const asked = (l.cfg.machines || 1) * (((l.cfg.style || "row-chest") === "sandwich-2") ? 1 : 1);
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
  { machines: 4, style: "row-belts" }, { machines: 2, style: "sandwich-2" },
  { machines: 6, style: "row-chest", inserter: "long-handed-inserter" },
  { machines: 4, style: "sandwich-2", orientation: "vertical" },
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
const rb2 = call("card_example", { machines: 2, style: "row-belts" }).data;
const sw4 = call("card_example", { machines: 4, style: "sandwich-2" }).data;
check("a row of machines between two belt lines lays exactly two",
  lines(rb2) === 2, JSON.stringify([lines(rb2), (rb2 || {}).lane_lines]));
check("two such rows sharing their product line lay three, not four",
  lines(sw4) === 3 && (sw4.parts || {}).machines === 4,
  JSON.stringify([lines(sw4), sw4.parts]));
check("and the shared spine pays fewer belts and fewer chests than the two rows that do not share",
  (sw4.parts || {}).belts < 2 * (rb2.parts || {}).belts
  && (sw4.parts || {}).chests < 2 * (rb2.parts || {}).chests,
  JSON.stringify([rb2.parts, sw4.parts]));



// A gear press is a grid load exactly like a furnace, and the lattice does not care which recipe a
// machine is running -- so the same shape with a different machine on it has to come back just as
// covered. Asserted rather than assumed, because the needle list is built from `is_grid_load` on the
// prototype and an assembling machine is a different prototype with a different box.
const gearedPoled = call("card_example", { machines: 4, style: "row-belts", recipe: "iron-gear-wheel",
  poles: true, force: "player" }).data || {};
check("the pole lattice wires a gear lane exactly like a smelting one",
  !!gearedPoled.belt_ceiling && (gearedPoled.power_grid || {}).uncovered === 0
  && ((gearedPoled.power_grid || {}).poles || 0) >= 1
  && (gearedPoled.parts || {}).machines === 4 && gearedPoled.recipe === "iron-gear-wheel",
  JSON.stringify([gearedPoled.power_grid, gearedPoled.recipe, gearedPoled.parts, gearedPoled.belt_ceiling,
    gearedPoled.contract]));

// ---------------------------------------------------------------- the road under the claim
//
// A shape that lifts its product into a chest (`row-chest`) has no product line at all, and one that
// runs the plates out on a belt has exactly as many as the style lays. That count is the difference
// between "this row makes 60 a minute" and "this row can MOVE 60 a minute", and it is the number a
// plan needs before it stacks another row behind the same spine.
const ceiled = (cfg) => call("card_example", { ...cfg, force: "player" }).data || {};
const rcCeil = ceiled({ machines: 4, style: "row-chest" });
const rbCeil = ceiled({ machines: 4, style: "row-belts" });
const swCeil = ceiled({ machines: 4, style: "sandwich-2" });
check("a row that lifts into chests lays no product line, and says so by having no ceiling",
  !rcCeil.belt_ceiling && (((rcCeil.lane_lines || {}).total) || 0) > 0,
  JSON.stringify([rcCeil.belt_ceiling, rcCeil.lane_lines]));
check("one row between two belt lines has exactly one product line, of the tier named",
  ((rbCeil.belt_ceiling || {}).lines || 0) === 1 && rbCeil.belt_ceiling.belt === rbCeil.components.belt,
  JSON.stringify([rbCeil.belt_ceiling, rbCeil.components]));
check("two rows sharing a spine still have ONE product line between them",
  ((swCeil.belt_ceiling || {}).lines || 0) === 1 && (((swCeil.lane_lines || {}).total) || 0) === 3,
  JSON.stringify([swCeil.belt_ceiling, swCeil.lane_lines]));
// The claim and the road are one number read two ways: `contract` is what the shape makes, and the
// ceiling's own figure for it must not be a second number invented beside it.
check("the ceiling is stated against the very rate the card's contract carries",
  !!rbCeil.belt_ceiling && Math.abs(rbCeil.belt_ceiling.claimed_per_min
    - Object.values(rbCeil.contract.outputs)[0]) < 1e-6 && rbCeil.belt_ceiling.headroom > 0,
  JSON.stringify([rbCeil.belt_ceiling, rbCeil.contract]));
// The over-claim branch, forced: twenty machines dumping onto the slowest belt in the game. Refusing
// here would be wrong -- a product line is shared with whatever else runs into it, and the box packs
// N templates side by side -- so the answer says both numbers and names the ways out, with a key on it.
// The over-claim branch, forced. Measured rather than guessed at: a row of these machines makes
// 18.75 plates a minute each and the slowest belt in the game moves 900, so it takes 48 of them to
// out-run the line they dump onto -- which is itself the fact worth knowing about a smelting row, and
// the reason this is advice rather than a refusal.
const crowded = ceiled({ machines: 60, style: "row-belts", belt: "transport-belt" });
check("a row whose machines outrun its own belt says so, with the two numbers beside it",
  !!crowded.belt_ceiling && crowded.belt_ceiling.over_claimed === true
  && crowded.belt_ceiling.claimed_per_min > crowded.belt_ceiling.per_min
  && crowded.belt_ceiling.next_key === "n-belt-over"
  && asArr(crowded.belt_ceiling.next_params).length === 4,
  JSON.stringify(crowded.belt_ceiling));
check("and the shape still comes back -- a narrow road is advice, not a refusal",
  !!crowded.belt_ceiling && (crowded.parts || {}).machines === 60 && (crowded.footprint || {}).width > 0,
  JSON.stringify([crowded.parts, crowded.footprint]));

// A recipe that yields more than one item per craft is contracted in ITEMS, not in crafts, and the
// figure has to agree with the one the SOLVER computes for the same machine and recipe -- two
// separate pieces of arithmetic that must not drift. `row-belts` so the lane has a product line at all:
// `row-chest` lifts into a chest and reports no ceiling, which is itself asserted above.
const cable = ceiled({ machines: 2, style: "row-belts", recipe: "copper-cable" });
const geared = ceiled({ machines: 2, style: "row-belts", recipe: "iron-gear-wheel" });
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
// The first is the one a player found on a real client: `sandwich-2` measures its spine outward from the
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
for (const style of ["row-chest", "row-belts", "sandwich-2"]) {
  for (const orientation of ["horizontal", "vertical"]) {
    for (const machines of [2, 4]) {
      const d = call("card_example", { machines, style, orientation, force: "player" }).data;
      if (d && !d.fail) every_shape.push({ style, orientation, machines, d });
    }
  }
}
check(`every style and axis came back (${every_shape.length} shapes)`,
  every_shape.length >= 10, JSON.stringify(every_shape.map((s) => [s.style, s.orientation, s.machines, (s.d || {}).code])));
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
const slow = call("card_example", { machines: 2, belt: "transport-belt", inserter: "inserter",
  chest: "wooden-chest", force: "player" }).data;
const auto = call("card_example", { machines: 2, force: "player" }).data;
check("a named belt, arm and chest are the parts the lane is made of",
  !!slow && !slow.fail && slow.components.belt === "transport-belt" && slow.components.inserter === "inserter"
  && slow.components.chest === "wooden-chest",
  JSON.stringify((slow || {}).components || slow));
check("...and they are really in the entity list, not just claimed",
  ["transport-belt", "inserter", "wooden-chest"].every((n) => slow.entities.some((e) => e.name === n)),
  JSON.stringify([...new Set(slow.entities.map((e) => e.name))]));
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
// of its hands, so it is legal to place, legal to verify, and starves every machine on the row. Both
// belt-row styles were laid that way for as long as they existed, and no check in this file went red --
// the 53 `card_lab` calls across dev/ all ran the default `row-chest` shape, because none of them ever
// passed a `style`. This is the one instrument that can answer it: build the lane, feed it, and see
// whether anything came out the other end.
const sleep = (ms) => { try { execFileSync("sleep", [String(ms / 1000)], { stdio: "ignore" }); } catch (e) { /* nothing to do */ } };
const run_lab = (card) => {
  let started = call("card_lab", { card, seconds: 60, speed: 40, force: "player" });
  // The clock belongs to everybody when a player is connected, so the same window is asked for at 1x
  // rather than skipped: the claim under test is "this lane produces", and it must be checkable by
  // whoever runs this suite after the next person logs in.
  if (started && started.code === "PLAYER_ONLINE") started = call("card_lab", { card, seconds: 60, force: "player" });
  if (!started || started.ok === false) return { refused: started };
  for (let i = 0; i < 90; i++) {
    const st = call("lab_status").data || {};
    if (st.state && st.state !== "running") return st;
    sleep(1000);
  }
  return { refused: { code: "SUITE_TIMEOUT" } };
};

for (const cfg of [{ machines: 2, style: "row-belts" }, { machines: 2, style: "sandwich-2" }]) {
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
  style: "row-belts" }).data || {};
// Read straight off the engine, through the same probe every other suite uses: the amounts belong to
// the recipe, and this file is not the place to restate them.
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
// The same probe without the array assumption: a query that answers an object, or nothing at all, is
// still worth running, and `rpLua` above deliberately reads anything that is not a JSON array as "no
// ingredients" -- which is right for a recipe and wrong for everything else.
const luaLine = (src) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV }).trim();
    return out.split("\n").map((l) => l.trim()).filter((l) => l && l !== "OK").pop() || "";
  } catch (e) { return ""; }
};
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
check("...and the share/split verdict is the arithmetic of LANES: each material rounds up to whole lanes",
  !!twoMat.feed_plan && twoMat.feed_plan.per_lane > 0
    && twoMat.feed_plan.inbound_lanes === 2
    && Math.abs(twoMat.feed_plan.per_lane * 2 - twoMat.feed_plan.per_line) < 1e-6
    && twoMat.feed_plan.lanes_wanted === asArr(twoMat.feed_plan.needs).reduce(
      (s, k) => s + Math.ceil(k.per_min / twoMat.feed_plan.per_lane), 0)
    && twoMat.feed_plan.share_one_line === (twoMat.feed_plan.lanes_wanted <= 2)
    // The number of lines is the LARGER of the two ways a line runs out: the lanes the materials want over
    // what the shape lays, and the machines over what one row of this belt keeps fed. Both are computed
    // from the figures the card itself reports, so this is the rule and not a second copy of the answer.
    && twoMat.feed_plan.lines_needed === Math.max(1,
      Math.ceil(twoMat.feed_plan.lanes_wanted / twoMat.feed_plan.inbound_lanes),
      Math.ceil((twoMat.lane_count || 1) / (twoMat.feed_plan.machines_per_line || twoMat.lane_count || 1))),
  JSON.stringify([twoMat.feed_plan.lanes_wanted, twoMat.feed_plan.share_one_line,
    twoMat.feed_plan.per_lane, twoMat.feed_plan.lines_needed,
    twoMat.feed_plan.machines_per_line]).slice(0, 260));
// The row limit, checked the same way it was computed: the quoted count fits two lanes, the count one
// larger does not. A yellow belt under smelting is the case where splitting is the right medicine -- one
// machine fits, forty do not -- so the limit is a real number rather than a floor of 1.
const rowLimit = call("card_example", { recipe: "iron-plate", furnace: "electric-furnace", machines: 40,
  belt: "transport-belt", force: "player", style: "row-belts" }).data || {};
const rl = rowLimit.feed_plan || {};
const lanesAt = (m) => asArr(rl.needs).reduce(
  (sum, k) => sum + Math.ceil((k.per_min / rowLimit.lane_count) * m / rl.per_lane), 0);
check("...and the row limit it quotes is one you can check: that count fits two lanes, one more does not",
  // The limit is asserted as a BOUNDARY, not as a number: which furnace wins this pick depends on what
  // the sweep left researched, and a hardcoded 15 would be a second opinion about the state of the
  // save rather than about the arithmetic. What must hold either way: the quoted count fits, one more
  // does not -- unless the whole plan already fits, in which case there is nothing to split.
  rl.machines_per_line >= 2 && lanesAt(rl.machines_per_line) <= 2
    && (rl.machines_per_line >= (rowLimit.lane_count || 40)
      || lanesAt(rl.machines_per_line + 1) > 2),
  JSON.stringify([rl.machines_per_line, lanesAt(rl.machines_per_line),
    lanesAt(rl.machines_per_line + 1), rl.per_lane]).slice(0, 240));
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
  const recipe = trio[0], machine = trio[1], belt = trio[2];
  const d = call("card_example", { recipe: recipe, machine: machine, furnace: machine, machines: 6,
    belt: belt, force: "player", style: "row-belts" }).data || {};
  const fp = d.feed_plan || {};
  if (!fp.per_lane) continue;
  const forOne = asArr(fp.needs).reduce(
    (sum, k) => sum + Math.ceil((k.per_min / (d.lane_count || 6)) / fp.per_lane), 0);
  ruleSeen.push([recipe, belt, forOne, !!fp.belt_too_slow, fp.machines_per_line]);
  if (!!fp.belt_too_slow !== (forOne > 2)) ruleOk = false;
  if (fp.belt_too_slow && fp.machines_per_line !== d.lane_count) ruleOk = false;
}
check("belt_too_slow is present exactly when one machine wants more lanes than a row has -- never when"
  + " splitting would help", ruleOk && ruleSeen.length >= 4, JSON.stringify(ruleSeen).slice(0, 400));
// A belt row has two lanes, so a THREE-material recipe cannot share one row even when the belt is fast
// enough for the sum. That limit is the geometry's, and it has to be said by name rather than absorbed
// into a throughput figure that would happily allow it.
const threeMat = call("card_example", { recipe: "low-density-structure", machines: 3, force: "player",
  style: "row-belts" }).data || {};
const threeNeeds = asArr((threeMat.feed_plan || {}).needs);
check("...and three materials is two lanes short, whatever the belt could carry",
  threeNeeds.length === 3 && threeMat.feed_plan.share_one_line === false
    && threeMat.feed_plan.lines_needed >= 2,
  JSON.stringify([threeNeeds.map((k) => [k.item, Math.round(k.per_min)]),
    threeMat.feed_plan && threeMat.feed_plan.share_one_line,
    threeMat.feed_plan && threeMat.feed_plan.lines_needed]).slice(0, 300));
// The gap this file pinned is now closed in the place the comment said to upgrade, and the claim got
// harder rather than softer: a recipe that eats two items is fed BOTH on one line. The head lays one
// chest per material with its arm on the OPPOSITE face of the row from the other, which is measured
// (`dev/lane_split_probe.js`: north arm and south arm fill different lanes, 60/60 with nothing crossing;
// two arms on one face fill one lane) and which an ordinary feed arm then reads from either lane -- so
// the machine gets both materials from one belt. What is asserted here is not the drawing: it is the
// bench running the lane and something coming out of it, because every part of this arrangement is legal
// to place whether or not the materials ever arrive.
const share = call("card_example", { recipe: "electronic-circuit", machines: 4, force: "player",
  style: "row-belts" }).data || {};
const inItems = asArr((share.ports || {}).in).map((p) => p.item).filter(Boolean);
check("a shared feed row declares an in-port for EVERY material the recipe eats",
  !!share.feed_plan && ecIng.length === 2 && inItems.length === ecIng.length
    && ecIng.every((i) => inItems.indexOf(i.item) >= 0),
  JSON.stringify([inItems, ecIng, share.ingredient]).slice(0, 300));
const ranShare = run_lab(share);
const madeShare = asArr(ranShare.verdicts).reduce((s, v) => s + (v.produced || 0), 0);
check("...and the bench feeds both materials and the lane really crafts",
    madeShare > 0,
  JSON.stringify([ranShare.refused, ranShare.state, (ranShare.verdicts || []).map((v) => [v.item, v.produced])])
    .slice(0, 300));
// A shape that cannot share the row must not pretend: `row-chest` lifts the product into a chest beside
// each machine and lays one feed line with one material, so the second material of the recipe is left
// out -- and `unfed` on the lane is what says so. Asserting the difference between the two shapes is the
// point: without it "shared_row" could quietly become "everybody gets one material" again.
const plain = call("card_example", { recipe: "electronic-circuit", machines: 4, force: "player",
  style: "row-chest" }).data || {};
const plainIn = new Set(asArr((plain.ports || {}).in || []).map((p) => p.item).filter(Boolean));
check("...while a shape that lays no shared row still leaves one material out, and says so",
  asArr((twoMat.feed_plan || {}).needs).length > 1 && plainIn.size === 1,
  JSON.stringify([Array.from(plainIn), twoMat.feed_plan && twoMat.feed_plan.needs]).slice(0, 240));

// ---------------------------------------------------------------- the shape with TWO feed rows
//
// `row-belts` can put two materials on its one line, which is the whole reason it has a `shared_row`
// head at all -- and one line has two lanes, so the recipe that eats three (92 of them on this install,
// `dev/recipe_table_e2e.js`) still arrives short, and 绿板 is the example the user caught: the answer
// said "built" with copper cable in no box. `two-feed` is the shape that takes the third and fourth
// material onto a second feed line on the machine's other face.
//
// What is asserted here is not that the drawing is pretty. Three things that only the engine can answer:
//   * the parts can STAND, at both arm reaches and turned -- the aisle this shape pays is `reach + 1`
//     columns, and a pitch of `fw + 2` lints clean with a long-handed arm and fails with an ordinary
//     inserter, because the box lands under the next machine (`OVERLAP`) and, before that, because the
//     tail arm stood in the cell its own belt points at (`BELT_INTO_SOLID`, an error at reach 1 only);
//   * every box is on the cell its own arm actually drops to -- the arithmetic that both of those bugs
//     hid from, and the one claim a shape makes that a player pays for in crafted inserters;
//   * the lane CRAFTS, which no amount of geometry proves: an arm facing the wrong way is legal to place
//     and starves the row, and a three-material recipe is the first case where one face of the machines
//     is not enough to bring everything.
const STEP_CELL = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] };
const cellFloor = (e) => [Math.floor(e.position.x), Math.floor(e.position.y)];
const armServes = (arm, chest, reach) => {
  const step = STEP_CELL[arm.direction];
  if (!step) return false;
  const [ax, ay] = cellFloor(arm);
  const [cx, cy] = cellFloor(chest);
  // The arm stands one reach along its PICKUP face from the box it drops into: facing west means it
  // reaches west for the item and releases it a reach to the east (styles.lua's `S.product_lines` walks
  // the same two steps to find a shape's product line).
  return ax - step[0] * reach === cx && ay - step[1] * reach === cy;
};
const outletBoxesServed = (lane) => {
  const ents = asArr(lane.entities), reach = lane.arm_reach || 1;
  const byIdx = {};
  ents.forEach((e, i) => { byIdx[i + 1] = e; });
  const orphans = [];
  for (const p of asArr((lane.ports || {}).out)) {
    const chest = byIdx[p.entity];
    if (!chest) { orphans.push(["no-chest", p.entity]); continue; }
    const served = ents.filter((e) => (protosArm(e.name)) && armServes(e, chest, reach));
    if (!served.length) orphans.push([Math.floor(chest.position.x), Math.floor(chest.position.y)]);
  }
  return orphans;
};
// Which part names are inserters on THIS save, read from the engine rather than remembered: the gate has
// to find the arm beside a box by its type, and a list of tier names copied into a suite goes stale the
// day a mod adds one.
const protoTypes = JSON.parse(luaLine(`local out = {}
for _, n in ipairs({"inserter","long-handed-inserter","stack-inserter","fast-inserter","bulk-inserter",
    "filter-inserter","wooden-chest","steel-chest","iron-chest","transport-belt","fast-transport-belt",
    "assembling-machine-1","assembling-machine-3","stone-furnace","steel-plant"}) do
  local p = prototypes.entity[n]
  if p then out[#out+1] = string.format('"%s":{"type":"%s"}', n, tostring(p.type)) end
end
rcon.print("{" .. table.concat(out, ",") .. "}")`) || "{}");
const protosArm = (name) => !!(protoTypes[name] && protoTypes[name].type === "inserter");

for (const style of ["row-chest", "row-belts", "sandwich-2", "two-feed"]) {
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
    const orphans = outletBoxesServed(lane);
    check(`...and every product box of ${style}/${inserter} stands on the cell its own arm drops to`,
      orphans.length === 0, JSON.stringify(orphans.slice(0, 3)).slice(0, 220));
  }
}

// The lane arithmetic is a fact about the SHAPE: two feed rows lay four lanes, one row lays two, and the
// reason string has to say "this shape lays 4" rather than "a row has 4" -- a belt row has two lanes,
// always, and a card that claims otherwise teaches the reader the wrong physics.
const advTwo = call("card_example", { recipe: "advanced-circuit", machines: 4, force: "player",
  style: "two-feed" }).data || {};
const advRow = call("card_example", { recipe: "advanced-circuit", machines: 4, force: "player",
  style: "row-belts" }).data || {};
check("the number of inbound lanes comes from the rows the shape laid: two-feed 4 across 2 rows, row-belts 2 across 1",
  (advTwo.feed_plan || {}).inbound_lanes === 4 && (advTwo.feed_plan || {}).lane_rows === 2
  && (advRow.feed_plan || {}).inbound_lanes === 2 && (advRow.feed_plan || {}).lane_rows === 1,
  JSON.stringify([(advTwo.feed_plan || {}).inbound_lanes, (advTwo.feed_plan || {}).lane_rows,
    (advRow.feed_plan || {}).inbound_lanes, (advRow.feed_plan || {}).lane_rows]));
check("...and the reason never says a single ROW has more than the two lanes a belt row has",
  !!advTwo.feed_plan && /row has [3-9]/.test(advTwo.feed_plan.reason || "") === false
  // The sentence is about what ONE MACHINE arms itself with, not about how many lines the shape crosses
  // the ground with: those two numbers differ as soon as a shape has more than one machine row, and a
  // reason that names the second one while sizing the first has taught the reader the wrong physics.
  && (advTwo.feed_plan.reason || "").indexOf("one machine reaches") >= 0,
  JSON.stringify(advTwo.feed_plan && advTwo.feed_plan.reason).slice(0, 260));

// What a shape brings, said as a number the reader can check against the boxes: `unfed` is the recipe's
// materials minus the ones that got a chest, and the two shapes differ -- that difference is the whole
// reason `two-feed` exists, so it is asserted rather than admired.
const distinctIn = (lane) => new Set(asArr((lane.ports || {}).in).map((p) => p.item).filter(Boolean));
const unfedSet = (lane) => new Set(asArr(lane.unfed).map((u) => u.name));
for (const [style, wantShort] of [["two-feed", false], ["row-belts", true], ["row-chest", true]]) {
  const lane = call("card_example", { recipe: "advanced-circuit", machines: 3, force: "player",
    style }).data || {};
  const needs = asArr((lane.feed_plan || {}).needs);
  const got = distinctIn(lane), miss = unfedSet(lane);
  check(`${style}: every material is either in a box or named in unfed, and never both`,
    needs.length === 3 && got.size + miss.size === needs.length
    && needs.every((k) => (got.has(k.item) ? 1 : 0) + (miss.has(k.item) ? 1 : 0) === 1)
    && (wantShort ? miss.size > 0 : miss.size === 0),
    JSON.stringify([style, needs.map((k) => k.item), Array.from(got), Array.from(miss)]).slice(0, 300));
}
check("...and an unfed row names the amount per craft, so the reader can tell 4 cables from 1",
  asArr(advRow.unfed).every((u) => u.name && typeof u.amount === "number" && u.amount > 0),
  JSON.stringify(advRow.unfed).slice(0, 220));

// The bench, and only the bench, can answer "did the third material ever arrive". `advanced-circuit` is
// not in the fixture list the cycles grant, so the tech is researched for this one run and put back
// afterwards: leaving it on would hand every later suite a recipe it never asked for, and the answers
// that depend on which recipes are unlocked would drift for a reason no one wrote down.
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
check("...and the two-feed lane of a THREE-material recipe really crafts on the bench",
  madeTf > 0, JSON.stringify([ranTf.refused, ranTf.state,
    asArr(ranTf.verdicts).map((v) => [v.item, v.produced])]).slice(0, 300));
check("...while the same recipe on the one-row shape crafts NOTHING, because a machine with two of its "
  + "three materials in hand does not start",
  madeRb === 0 && madeTf > 0,
  JSON.stringify([madeRb, madeTf, asArr(ranRb.verdicts).map((v) => [v.item, v.produced])]).slice(0, 300));
check("...and the card says which material the one-row shape brings no box for",
  asArr(advTwo.unfed).length === 0 && asArr(advRow.unfed).length >= 1
  && asArr(advRow.unfed).every((u) => !!u.name && typeof u.amount === "number" && u.amount > 0),
  JSON.stringify([advTwo.unfed, advRow.unfed]).slice(0, 260));

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
for (const style of ["row-belts", "sandwich-2", "two-feed", "row-chest"]) {
  const lane = call("card_example", { recipe: "electronic-circuit", machines: 6, force: "player",
    style }).data || {};
  const c = lane.arm_choice || {};
  armByStyle[style] = c;
  check(`${style}: reaches what the shape needs, not a remembered tier (need ${c.need})`,
    c.need === 1 && (c.reach || 0) >= 1 && !!c.arm && c.arm !== "burner-inserter"
      && !/long-handed|stack/.test(String(c.arm)) && (lane.parts || {}).arms > 0,
    JSON.stringify([c, lane.parts, (lane.footprint || {})]));
}
check("...so every belt-row shape on this save is armed with a one-tile arm, and says how it decided",
  Object.keys(armByStyle).length === 4
    && Object.values(armByStyle).every((c) => c.need === 1 && !!c.how),
  JSON.stringify(armByStyle));
check("...and the pair of rows still costs LESS ground per machine than the single row it competes with",
  (armByStyle["sandwich-2"].reach || 0) === (armByStyle["row-belts"].reach || 0),
  JSON.stringify([armByStyle["sandwich-2"], armByStyle["row-belts"]]));

// ---------------------------------------------------------------- the lanes a machine can spend//
// `feed_plan.inbound_lanes` decides how long a line may be before its far end cannot be fed, so it has to
// count the lanes ONE MACHINE reaches -- not the lanes the shape happens to cross it with. A belt row is
// two lanes and an inserter stands in the single row between its belt and its machine, so one face = one
// line = two lanes, and a two-row shape lays two feed lines while each of its machines can arm only one of
// them. The first version of this number counted the lines, which promised a `sandwich-2` row of iron
// plates twice the length that actually eats.
//
// Asserted three ways, because a single equality would be a table: what each shape reports for one
// machine, what it reports in total when the two differ, and the per-ROW equivalence with the shape whose
// rows are the same width -- `sandwich-2` stands its machines behind the same two-lane line `row-belts`
// does, so it should carry exactly twice as many machines per line and pay one product belt for them.
const laneFacts = {};
for (const [style, reach, laid] of [["row-belts", 2, 2], ["row-chest", 2, 2],
  ["two-feed", 4, 4], ["sandwich-2", 2, 4]]) {
  const lane = call("card_example", { recipe: "electronic-circuit", machines: 40, force: "player",
    style, belt: "transport-belt" }).data || {};
  const f = lane.feed_plan || {};
  laneFacts[style] = f.machines_per_line || 0;
  check(`${style}: one machine reaches ${reach} lanes and the shape lays ${laid}`,
    f.inbound_lanes === reach && (f.feed_lanes_laid || f.inbound_lanes) === laid,
    JSON.stringify([f.inbound_lanes, f.feed_lanes_laid, f.lane_rows, f.machines_per_line]));
  // The whole plan's demand is measured against the lines the template actually crosses it with. A
  // four-lane pair of rows asked for 40 machines of a two-material recipe wants four lanes and lays four:
  // calling that "2 lines, each with its own head" is the same scale error one row up, and it sends the
  // helmod split to build twice as many lanes as the plan needs.
  check(`...and ${style} counts its lines against the lanes it lays, not against one machine's reach`,
    !f.per_lane || (f.lanes_wanted == null
      || (f.lines_needed === Math.max(1, Math.ceil(f.lanes_wanted / laid),
        Math.ceil((lane.lane_count || 40) / (f.machines_per_line || lane.lane_count || 40)))
        && (f.lanes_wanted <= laid) === !!f.share_one_line)),
    JSON.stringify([f.lanes_wanted, laid, f.share_one_line, f.lines_needed, f.machines_per_line]));
  // No row is sized past what its own machines can reach: the lanes every material wants, rounded up per
  // lane the way the answer itself rounds them, must fit inside `inbound_lanes` -- counted for the machines
  // that stand in ONE row. The row count is read off the two reported numbers (a shape lays this many times
  // what one machine spends), not from the style's name, so a third two-row shape is checked the same way.
  const laid2 = f.feed_lanes_laid || f.inbound_lanes;
  const rowsPerTemplate = Math.max(1, Math.round(laid2 / (f.inbound_lanes || 1)));
  const machinesPerRow = Math.max(1, Math.round((f.machines_per_line || 1) / rowsPerTemplate));
  const need = asArr(f.needs).reduce((s, k) => s
    + Math.ceil((k.per_min || 0) / 40 * machinesPerRow / (f.per_lane || 1)), 0);
  check(`...and ${style}'s own row length fits inside the lanes one machine reaches`,
    f.inbound_lanes > 0 && need <= f.inbound_lanes,
    JSON.stringify([machinesPerRow, need, f.inbound_lanes, f.machines_per_line,
      asArr(f.needs).map((k) => k.per_min)]));
}
check("...so a two-row shape carries exactly twice a single row's machines and pays ONE product line for them",
  laneFacts["sandwich-2"] === 2 * laneFacts["row-belts"] && laneFacts["sandwich-2"] > 0,
  JSON.stringify([laneFacts["row-belts"], laneFacts["sandwich-2"], laneFacts["two-feed"]]));

// ---------------------------------------------------------------- the pair of rows, fed on both sides
//
// `sandwich-2` is the densest shape in the file -- two rows of machines behind ONE product belt -- and it
// was also the one that lied the most quietly: each outer line was armed with a single chest, so a
// two-ingredient recipe laid as a sandwich brought ONE of its two materials to both rows and the answer
// still reported a built lane. Fixing that (both materials on both lines, one arm per face, the same
// measured split `row-belts` uses) costs one reach of width at each end of the two lines and nothing in
// pitch, so the density claim has to be asserted next to the feeding claim: same recipe, both boxes,
// still narrower than the single-row shape that also brings both.
const sw2 = call("card_example", { recipe: "electronic-circuit", machines: 8, force: "player",
  style: "sandwich-2" }).data || {};
const rbSame = call("card_example", { recipe: "electronic-circuit", machines: 8, force: "player",
  style: "row-belts" }).data || {};
check("a two-ingredient recipe laid as a PAIR of rows brings BOTH materials to both rows",
  asArr((sw2.ports || {}).in).length === 4 && asArr(sw2.unfed).length === 0
    && asArr((sw2.feed_plan || {}).needs).length === 2,
  JSON.stringify([sw2.parts, asArr((sw2.ports || {}).in).map((p) => p.item),
    sw2.unfed]).slice(0, 300));
const sw2v = call("card_verify", { card: { name: "sw2", entities: sw2.entities,
  surface: "arch-sandbox", force: "player" } });
check("...and the shape with heads on both outer lines still STANDS",
  sw2v.ok !== false && asArr((sw2v.detail || {}).errors).length === 0,
  JSON.stringify([sw2v.code, asArr((sw2v.detail || {}).errors).slice(0, 2)]).slice(0, 260));
const ranSw2 = run_lab(sw2);
check("...and it stays the denser shape: same recipe, same machines, narrower than the single row",
  (sw2.footprint || {}).width < (rbSame.footprint || {}).width
    && (sw2.footprint || {}).height > (rbSame.footprint || {}).height
    && (sw2.parts || {}).chests <= (rbSame.parts || {}).chests + 2,
  JSON.stringify([[sw2.footprint, sw2.parts], [rbSame.footprint, rbSame.parts]]).slice(0, 300));

// ---- 形状是按料的数量选的，不是按历史 ----
// 红板吃三种料。一条进料带只有两半股、每半装一种，所以三种料必须落在"机器两面各有一条进料带"的形状上
// —— 而从前这个判断只在 helmod 压线那一头做，`card_example` 的默认写死 `row-chest`，于是同一个配方从
// 别的门问进来就得到一条带子加两行 `unfed`：一条永远造不出东西的线，被当成一条线报出去。现在默认会
// 先看铺下来的形状到底把几种料送到了线上，送不齐就按阶梯重画一次，并把"为什么换"写在答案里。
const three = call("card_example", { recipe: "advanced-circuit", machines: 3 });
const threeBig = call("card_example", { recipe: "advanced-circuit", machines: 15 });
const oneMaterial = call("card_example", { recipe: "iron-plate", machines: 6 });
const pinned = call("card_example", { recipe: "advanced-circuit", machines: 3, style: "row-chest" });
check("三种料的配方不再被默认排到一条进料带上",
  three.ok && three.data.unfed === undefined
    && asArr((three.data.feed_plan || {}).needs).length >= 3,
  three.ok ? JSON.stringify([three.data.style, three.data.unfed,
    asArr((three.data.feed_plan || {}).needs).map((n) => n.item)]) : `${three.code} ${three.msg}`);
check("换形状这件事写在答案里：从哪个形状搬到哪个、为什么",
  three.ok && (three.data.shape_moved || {}).from === "row-chest"
    && three.data.shape_moved.to === three.data.style
    && /nowhere to arrive/.test(three.data.shape_moved.because || ""),
  JSON.stringify((three.data || {}).shape_moved));
check("...而且按机器数搬家不是搬家一次算一次：15 台同样喂齐",
  threeBig.ok && threeBig.data.unfed === undefined
    && threeBig.data.style === three.data.style,
  threeBig.ok ? JSON.stringify([threeBig.data.style, threeBig.data.unfed]) : threeBig.code);
check("一种料的熔炼线一条没动：还是 row-chest，也没有搬家记录",
  oneMaterial.ok && oneMaterial.data.style === "row-chest"
    && oneMaterial.data.shape_moved === undefined,
  oneMaterial.ok ? JSON.stringify([oneMaterial.data.style, oneMaterial.data.shape_moved]) : oneMaterial.code);
check("点名了就不换：row-chest 还是 row-chest，缺的料照旧点名",
  pinned.ok && pinned.data.style === "row-chest" && pinned.data.shape_moved === undefined
    && asArr(pinned.data.unfed).length >= 2,
  pinned.ok ? JSON.stringify([pinned.data.style, asArr(pinned.data.unfed).map((u) => u.name)]) : pinned.code);
// 裸带线头必须由能接总线的形状来画。从前它先落在默认的 row-chest 上再拒，把 mod 自己的默认推给调用方
// 的头 —— 现在它直接从阶梯起步。测试存档没研究电路网时会拒在"放不下标牌"，那是对的，但不是这个理由。
// 这几条要牌真的铺得出来：显示器与判定组合器两件硬件都锁在 circuit-network 后面（实测），而排在前面的
// smoke 会把科技收成它自己那份名单 —— 那时候该读到的是 HEAD_SIGN_UNAVAILABLE，不是"形状不对"，
// 四条断言会一起红，把真正的形状信息埋掉。按 dev/belt_head_e2e.js 的同一条路借来、量完原样还：
// 留在"多研究了东西"的世界上，后面每套的臂档选择都会被这里带跑。
const techWasOn = /^true$/.test(luaLine(`local t = game.forces.player.technologies["circuit-network"]
  rcon.print(t and tostring(t.researched) or "absent")`));
if (!techWasOn) luaLine(`local t = game.forces.player.technologies["circuit-network"]
  if t then t.researched = true end rcon.print("borrowed")`);

const bareHead = call("card_example", { recipe: "advanced-circuit", machines: 3, heads: "belt" });
check("裸带线头不再因为默认形状而拒",
  !(bareHead.ok === false && bareHead.code === "HEADS_NEED_BELT_STYLE"),
  bareHead.ok ? bareHead.data.style : `${bareHead.code} ${String(bareHead.msg).slice(0, 90)}`);

// 牌上的道数不能超出一条带子实际能装的：一条带 = 两个半股。这条之所以要有门禁，是因为卡片把"这个形状
// 送到几种料"读自牌上那份清单 —— 牌一旦多写一道，第三种料就不再算缺料，"送不齐就重画"于是永远不触发，
// 红板会被留在只有一条进料带（下面那条是出料带，没有进料臂）的形状上。
const rbBelt = call("card_example", { recipe: "advanced-circuit", machines: 4, style: "row-belts", heads: "belt" });
// 这两条原来都用"裸带线头 + 不点名形状"拿两张卡：那时阶梯的第一个候选是 two-feed，所以断言写的就是
// two-feed 的几何。0.60.28 起裸带线头的阶梯从 `stacked`（零箱子那一档）起步，于是同一个调用现在回
// stacked —— 不是几何变了，是默认变了。两条各归各位：想断言 two-feed 的形状就点名它，想断言默认就
// 让它自己走出来（下面那条正是"默认落到了零箱子那一档，而且三道料一条不缺"）。
const tfBelt = call("card_example", { recipe: "advanced-circuit", machines: 4, style: "two-feed",
  heads: "belt" });
const tfAutoBelt = call("card_example", { recipe: "advanced-circuit", machines: 4, heads: "belt" });
const lanesOf = (d) => asArr((d.head || {}).lanes).length;
check("一块牌最多写两道，因为一行带子只有两个半股（第三种料照旧算缺）",
  rbBelt.ok && lanesOf(rbBelt.data) <= 2 && asArr(rbBelt.data.unfed).length >= 1,
  rbBelt.ok ? JSON.stringify([lanesOf(rbBelt.data), asArr(rbBelt.data.unfed).map((u) => u.name)]) : rbBelt.code);
check("...而三种料的线落在两面都有带子的形状上时，牌上三道、一条不缺",
  tfBelt.ok && tfBelt.data.style === "two-feed" && lanesOf(tfBelt.data) === 3
    && tfBelt.data.unfed === undefined,
  tfBelt.ok ? JSON.stringify([tfBelt.data.style, lanesOf(tfBelt.data), tfBelt.data.unfed]) : tfBelt.code);
// 头那块牌写三道料、尾那块写一种成品（玩家 2026-10-07："头尾都放"）。从前这两样挤在同一块牌上，所以
// 这条钉的是 4 —— 现在 4 件"其它"还在，只是分成了两头各说各的。
const tailLanesOf = (d) => asArr((d.tail || {}).lanes).length;
check("...而这条线现在的默认那一档把头写成三道料、尾写成品，一只箱子也不要",
  tfAutoBelt.ok && tfAutoBelt.data.style === "stacked" && lanesOf(tfAutoBelt.data) === 3
    && tailLanesOf(tfAutoBelt.data) === 1
    && tfAutoBelt.data.unfed === undefined && (tfAutoBelt.data.parts || {}).chests === 0
    && (tfAutoBelt.data.parts || {}).others === 4,
  tfAutoBelt.ok ? JSON.stringify([tfAutoBelt.data.style, lanesOf(tfAutoBelt.data),
    tailLanesOf(tfAutoBelt.data), tfAutoBelt.data.unfed, tfAutoBelt.data.parts.chests,
    tfAutoBelt.data.parts.others]) : tfAutoBelt.code);
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
check("two-feed 的两条进料带各自有一排进料臂（两面各一排，每排按机器数）",
  tfBelt.ok && tfArms.faces === 2 && Object.values(tfArms.rows).every((n) => n === 4),
  JSON.stringify([tfArms.rows, tfArms.faces]));
check("...而 row-belts 只有一面有进料臂：另一面那排是出料臂，所以它接不住三种料",
  rbBelt.ok && rbArms.faces === 1 && Object.values(rbArms.rows).every((n) => n === 4)
    && lanesOf(rbBelt.data) === 2,
  JSON.stringify([rbArms.rows, rbArms.faces, lanesOf(rbBelt.data)]));


// ---- 线计划：要几条带是算出来的，不是形状的名字（2026-10-06 #6）
//
// 需求侧从流量来（料占几股 → 几条进料带；**每个**产物都算 → 几条成品带），供给侧从量到的臂档来
// （dev/belt_stack_probe.js：一只臂只喂"距离 = 它 reach"那一行）。这里断言的是这两个数对得上、
// 而且"这个形状没铺够"和"换形状也没救"是分开的两句话 —— 混成一句，下一步的建议就会说错。
const lpOf = (d) => d.lane_plan || {};
const red4 = call("card_example", { recipe: "advanced-circuit", machines: 4 });
const lpRed = lpOf(red4.data || {});
check("红板×4：进料要 2 条（3 种料 / 每带 2 股），成品要 1 条",
  red4.ok && lpRed.feed_rows_needed === 2 && lpRed.product_rows_needed === 1,
  JSON.stringify([lpRed.feed_rows_needed, lpRed.product_rows_needed]));
check("...而 two-feed 铺了 2 条进料带、0 条成品带 —— 差的那条成品带被点名，不含糊成「有箱子」",
  lpRed.feed_rows_laid === 2 && lpRed.product_rows_laid === 0 && lpRed.short_product === 1
    && /成品要 1 条带/.test(String(lpRed.blocked_by)),
  JSON.stringify([lpRed.feed_rows_laid, lpRed.product_rows_laid, lpRed.blocked_by]));
check("...箱子按种类数出来：机器级出料箱和线头箱、末端箱分开报（玩家指的是第一种）",
  (lpRed.chests_by_role || {}).out >= 1 && (lpRed.chests_by_role || {}).in >= 1
    && lpRed.chest_total === (lpRed.chest_total || 0) && lpRed.chest_free === false,
  JSON.stringify([lpRed.chests_by_role, lpRed.chest_total]));
// 这一条从前钉的是"带子都铺够了，绑住的只剩箱子"，因为那时带子默认拿最快那一档。改成"够用就好"之后
// 同一个请求可能先卡在进料行数上 —— 那是**另一件真事**，不该为了迁就旧断言去钉一档带子。所以这里钉的
// 是规矩本身：绑住的是哪个数，`blocked_by` 就得说出哪个数，不许含糊成"有箱子"。
const belts2 = call("card_example", { recipe: "electronic-circuit", machines: 4, style: "row-belts" });
const lpBelts = lpOf(belts2.data || {});
const belts2Says = String(lpBelts.blocked_by || "");
check("绿板×4 用 row-belts：绑住什么就说什么 —— 缺行说行、缺成品说成品、只剩箱子才说箱子",
  belts2.ok && (Number(lpBelts.short_feed) > 0
    ? /进料要 \d+ 条带/.test(belts2Says)
    : Number(lpBelts.short_product) > 0 ? /成品要 \d+ 条带/.test(belts2Says)
      : /还剩 \d+ 只箱子/.test(belts2Says)),
  JSON.stringify([lpBelts.short_feed, lpBelts.short_product, belts2Says]).slice(0, 200));
// 供给侧必须是量出来的数，不是写死的 2。
const tiers = lpRed.arm_reach_tiers || [];
check("一个面能叠几条带 = min(臂的互不相同 reach 档数, 机器深度)，两边都是读回来的",
  tiers.length >= 1 && lpRed.rows_per_face === Math.min(tiers.length, 3)
    && lpRed.rows_per_face >= 1 && lpRed.rows_per_face <= tiers.length,
  JSON.stringify([tiers, lpRed.rows_per_face]));
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
const cable30 = call("card_example", { recipe: "copper-cable", machines: 30 });
const lpCable = lpOf(cable30.data || {});
check("产量大到一条带装不下：成品带数自己涨到 2，而不是「加只箱子」",
  cable30.ok && lpCable.product_rows_needed === 2 && lpCable.beyond_any_shape === false,
  JSON.stringify([lpCable.product_rows_needed, lpCable.product_lanes_wanted, lpCable.beyond_any_shape]));
// #7 落地时说过这条要改掉，不是放宽：现在 `stacked` 真的无箱，四个旧形状仍然不是 —— 两半都要钉住，
// 否则"有救"会悄悄变成"都差不多"。
const stacked4 = call("card_example", { recipe: "advanced-circuit", machines: 4, style: "stacked" });
const lpStack = lpOf(stacked4.data || {});
check("stacked 真的无箱：零箱、进料带铺够、成品带也铺够",
  stacked4.ok && lpStack.chest_free === true && lpStack.chest_total === 0
    && lpStack.short_feed === 0 && lpStack.short_product === 0,
  JSON.stringify([stacked4.code, lpStack.chest_free, lpStack.chest_total,
    lpStack.short_feed, lpStack.short_product]));
check("而四个旧形状仍然没有一个无箱（拿救的余地要说清楚，不能悄悄混过去）",
  [red4, belts2, cable30].every((c) => c.ok && lpOf(c.data || {}).chest_free === false)
    && stacked4.ok,
  JSON.stringify([red4, belts2, cable30].map((c) => lpOf(c.data || {}).chest_free)));

if (!techWasOn) luaLine(`local t = game.forces.player.technologies["circuit-network"]
  if t then t.researched = false end rcon.print("returned")`);

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
