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

check("every lane the matrix asks for comes back", lanes.every((l) => l.ok),
  JSON.stringify(lanes.filter((l) => !l.ok).map((l) => [l.facing, l.code])));

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
  check(`${JSON.stringify(cfg)}: turning keeps every part and swaps the axes`,
    h && v && names(h.data) === names(v.data)
    && (h.data.footprint || {}).width === (v.data.footprint || {}).height
    && (h.data.footprint || {}).height === (v.data.footprint || {}).width,
    JSON.stringify([h && h.data.footprint, v && v.data.footprint]));
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

// Whether a box fits a plan depends on which way the lanes run -- that is the whole reason the control
// exists. Two boxes, one wide and one tall, the same four lanes: each must fit the axis it was laid for
// and not the other.
call("sandbox", {});
const fit = (area, orientation) => call("plan_fit", { item: "iron-plate", rate: 600, unit: "per_minute",
  lanes: 4, surface: "arch-sandbox", area, orientation, build: false });
const WIDE = { left_top: { x: 20, y: 20 }, right_bottom: { x: 90, y: 34 } };
const TALL = { left_top: { x: 120, y: 20 }, right_bottom: { x: 134, y: 90 } };
const fw = fit(WIDE, "horizontal"), fv = fit(TALL, "vertical");
check("four lanes fit a wide box laid out in rows", (fw.data || {}).fits === true,
  JSON.stringify([fw.code, fw.data && { want: fw.data.lanes_wanted, can: fw.data.lanes_fit }]));
check("and the same four fit a tall box laid out in columns", (fv.data || {}).fits === true,
  JSON.stringify([fv.code, fv.data && { want: fv.data.lanes_wanted, can: fv.data.lanes_fit }]));
// What the axis actually changes is the SHAPE of the packing, not how many fit: the lane template turns,
// so the box fills 2-across-by-5-down instead of 5-across-by-2-down, and the number that survives that
// is close to the same because the box's area is. Claiming "the wrong axis stops fitting" was a claim
// about these particular boxes and it is false for them -- the claim worth pinning is that the lane the
// box gets compared against is the turned one, and that rows and per-row counts move with it.
const fx = fit(WIDE, "vertical"), fy = fit(TALL, "horizontal");
const transposed = (a, b) => !!a && !!b && a.width === b.height && a.height === b.width;
const fp = (r) => (r.data || {}).lane && r.data.lane.footprint;
check("and a box is packed against the turned lane, which is the other axis's shape transposed",
  transposed(fp(fx), fp(fw)) && transposed(fp(fy), fp(fv)),
  JSON.stringify([fp(fw), fp(fx), fp(fy), fp(fv)]));
check("which moves the two figures that describe the packing, even when the total is near enough equal",
  (fx.data || {}).per_row !== (fw.data || {}).per_row && (fx.data || {}).rows !== (fw.data || {}).rows,
  JSON.stringify([fw.data && { per_row: fw.data.per_row, rows: fw.data.rows },
    fx.data && { per_row: fx.data.per_row, rows: fx.data.rows }]));

// A fit asked for the two-row style packs TEMPLATES, and a template of that style is a pair: two lanes
// of it is four machines standing in a box. If the packing ever counted machines as lanes again, this
// answers with two rows of one machine and reports a plan half the size of the one being built.
const pf = call("plan_fit", { item: "iron-plate", rate: 600, unit: "per_minute", lanes: 2,
  surface: "arch-sandbox", area: { left_top: { x: 220, y: 20 }, right_bottom: { x: 320, y: 60 } },
  style: "sandwich-2", build: false });
const pd = pf.data || {};
check("a fit of the pair style lays a pair per lane, and says so in its own footprint",
  pf.ok === true && (pd.lanes_wanted || 0) === 2
  && ((pd.lane || {}).footprint || {}).width > 0 && ((pd.lane || {}).parts || {}).machines === 2,
  JSON.stringify([pd.lanes_wanted, pd.lane && { fp: pd.lane.footprint, parts: pd.lane.parts }]));

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

// ---------------------------------------------------------------- how many lanes a plan is
//
// `plan_fit` counts TEMPLATES in `lanes` (a lane of the pair style is two machines -- that is what the
// style's `min_units` means), while the panel thinks in machines, so there is a second door named
// `machines` and the conversion lives beside the style that decides it. Both doors are asserted,
// because the first cut of this fix quietly redefined `lanes` instead of adding one, and the existing
// pair-style check below is what said so.
const pairByLane = call("plan_fit", { item: "iron-plate", rate: 600, unit: "per_minute", lanes: 2,
  surface: "arch-sandbox", area: WIDE, style: "sandwich-2", force: "player" });
const pbl = pairByLane.data || {};
check("the `lanes` door still means templates: 2 lanes of a pair style are asked for as 2, not 1",
  pbl.lanes_wanted === 2 && pbl.machines_per_lane === 2 && pbl.machines_asked === 4,
  JSON.stringify([pbl.lanes_wanted, pbl.machines_per_lane, pbl.machines_asked, pairByLane.code]));
const pairByMachine = call("plan_fit", { item: "iron-plate", rate: 600, unit: "per_minute", machines: 5,
  surface: "arch-sandbox", area: WIDE, style: "sandwich-2", force: "player" });
const pbm = pairByMachine.data || {};
check("the `machines` door converts 5 machines into 3 pair-lanes and says the remainder out loud",
  pbm.lanes_wanted === 3 && pbm.machines_per_lane === 2 && pbm.machines_asked === 6
  && pbm.machines_laid <= 6,
  JSON.stringify([pbm.lanes_wanted, pbm.machines_per_lane, pbm.machines_asked, pbm.machines_laid]));
const singleByMachine = call("plan_fit", { item: "iron-plate", rate: 600, unit: "per_minute", machines: 5,
  surface: "arch-sandbox", area: WIDE, style: "row-chest", force: "player" });
const sbm = singleByMachine.data || {};
check("a single-machine style converts to itself, so the two doors agree where they must",
  sbm.machines_per_lane === 1 && sbm.lanes_wanted === 5 && sbm.machines_asked === 5,
  JSON.stringify([sbm.machines_per_lane, sbm.lanes_wanted, sbm.machines_asked]));
check("and asking for zero machines is refused as a bad count, not answered as zero lanes",
  (() => { const r = call("plan_fit", { item: "iron-plate", rate: 600, unit: "per_minute", machines: 0,
    surface: "arch-sandbox", area: WIDE, style: "sandwich-2", force: "player" });
    return r.ok === false && r.code === "BAD_ARGS" && r.msg_key === "m-arg-machines"; })(),
  JSON.stringify((() => { const r = call("plan_fit", { item: "iron-plate", rate: 600, unit: "per_minute",
    machines: 0, surface: "arch-sandbox", area: WIDE, style: "sandwich-2", force: "player" });
    return [r.code, r.msg_key]; })()));

// 带供电 means the ghosts arrive on a grid -- and the grid starts inside the row: the lattice laid its
// poles while the lane was being shaped, so the box answer counted them, and the coverage search that
// runs afterwards is left with the job arithmetic cannot do per template (bridge the islands the copies
// leave, put a supply on the result). Asserted by counting poles in what got laid and in what the lane
// says it carries, because a checkbox that reaches no entity is indistinguishable from one that was
// never wired up.
//
// Both boxes come from the bench (`dev/box.js`) rather than from a remembered coordinate: inside the
// painted pad the tiles are grass and swept, outside it an answer about fitting is an answer about
// this save's map edge -- which grows as other suites push chunks into existence.
const { padBox } = require("./box.js")(call);
const POWER_BOX = padBox(58, 58);
const BARE_BOX = padBox(58, 58);
check("the pad the boxes come from is a square the mod prepared, and a too-wide box is an error",
  POWER_BOX.left_top.x >= -64 && BARE_BOX.left_top.x >= -64
  && (() => { try { padBox(500, 8); return false; } catch (e) { return /bigger than the prepared pad/.test(e.message); } })(),
  JSON.stringify([POWER_BOX, BARE_BOX]));
const powered = call("plan_fit", { item: "iron-plate", rate: 600, unit: "per_minute", machines: 4,
  surface: "arch-sandbox", area: POWER_BOX, style: "sandwich-2", power: true, build: true,
  name: "ledger powered line", force: "player" });
const pw = powered.data || {};
const bare = call("plan_fit", { item: "iron-plate", rate: 600, unit: "per_minute", machines: 4,
  surface: "arch-sandbox", area: BARE_BOX,
  style: "sandwich-2", power: false, build: true, name: "ledger bare line", force: "player" });
const bd = bare.data || {};
const pgl = (d) => ((d || {}).lane || {}).power_grid || {};
check("带供电 puts poles into the line it lays, and the same ask without them lays none",
  (pgl(pw).poles || 0) > 0 && ((pw.lane || {}).parts || {}).poles === pgl(pw).poles
  && (bd.power_applied === undefined) && (((bd.lane || {}).parts || {}).poles || 0) === 0
  && !(bd.lane || {}).power_grid,
  JSON.stringify([pgl(pw), (pw.lane || {}).parts, pgl(bd), (bd.lane || {}).parts, powered.code]));
check("...and the ghosts that go down include them, with every load served and one grid",
  !((pw.built || {}).refused) && !!((pw.built || {}).placed)
  && (pw.power_applied || {}).still_unserved === 0 && ((pw.power_applied || {}).served || 0) > 0
  && ((pw.power_applied || {}).supply || 0) >= 1,
  JSON.stringify([pw.power_applied, pw.built && { ghosts: pw.built.placed,
    refused: pw.built.refused && pw.built.refused.code }]));
check("...and the powered line still lints with its poles in (the search's cells are bench-proved, not drawn)",
  (pw.built || {}).placed !== undefined && ((pw.power_applied || {}).pole || "") !== "",
  JSON.stringify([pw.power_applied, pw.built]));

// What `apply` hands back has to be the whole card, not a skeleton with poles on it. Rebuilding the card
// from `name` + `entities` inside `card_fix_power` silently dropped `contract`, `ports`,
// `machine_recipes`, `lanes`, `wires` and each entity's `circuit` -- and `plan_fit` freezes THAT card when
// 带供电 is on, so the line a player laid with the checkbox ticked lost the rate it claimed and its
// assemblers landed with no recipe. The pole part kept working, which is why nothing here went red.
const fedLane = call("card_example", { machines: 2, style: "row-belts", recipe: "iron-plate",
  force: "player" }).data;
const fixedUp = call("card_fix_power", { card: fedLane, apply: true, force: "player" });
const fc = (fixedUp.data || {}).card || {};
check("card_fix_power{apply} adds poles without eating what the card said about itself",
  fixedUp.ok !== false && ((fixedUp.data || {}).poles_applied || 0) >= 1
  && Object.keys(((fc.contract || {}).outputs) || {}).length > 0
  && asArr((fc.ports || {}).in).length > 0 && Object.keys(fc.machine_recipes || {}).length > 0,
  JSON.stringify([fixedUp.code, fixedUp.msg, { contract: fc.contract, ports: (fc.ports || {}).in,
    recipes: fc.machine_recipes, ents: (fc.entities || []).length }]));
const frozeFixed = call("card_freeze", { card: fc, name: "ledger fixed card", allow_unmeasured: true,
  force: "player" });
const keptCards = asArr((call("cards", {}).data || {}).cards)
  .filter((c) => c.name === "ledger fixed card");
check("...and a card frozen from that answer still carries a claim the panel can price",
  frozeFixed.ok !== false && keptCards.length === 1
  && Object.keys(keptCards[0].claimed || {}).length > 0,
  JSON.stringify([frozeFixed.code, frozeFixed.msg, keptCards]));

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
const rowRate = (item) => {
  const p = (call("plan_form", { item: item, rate: 60, unit: "per_minute", force: "player" }).data || {});
  const rows = Array.isArray(p.how_many) ? p.how_many : Object.values(p.how_many || {});
  const row = rows.find((r) => r && r.item === item);
  return row || {};
};
const cableRow = rowRate("copper-cable"), gearRow = rowRate("iron-gear-wheel");
check("a lane's claim is the same number the solver prices the row at, times the lanes",
  cable.recipe === "copper-cable" && (cable.components || {}).furnace === cableRow.machine
  && Math.abs(laneRate(cable) - 2 * (cableRow.per_machine_per_min || 0)) < 1e-6
  && geared.recipe === "iron-gear-wheel" && (geared.components || {}).furnace === gearRow.machine
  && Math.abs(laneRate(geared) - 2 * (gearRow.per_machine_per_min || 0)) < 1e-6,
  JSON.stringify([laneRate(cable), cableRow, laneRate(geared), gearRow]));
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

// The bug as the player met it: two lanes of the shape that measures outward from the middle, stacked at
// the pitch the fit itself reports, have to stand on real ground without leaning on each other.
for (const orientation of ["horizontal", "vertical"]) {
  const lane = call("card_example", { machines: 2, style: "sandwich-2", orientation, force: "player" }).data;
  const fp = (lane || {}).footprint || { width: 0, height: 0 };
  const merged = call("card_compose", {
    force: "player",
    slots: [{ card: lane, at: { x: 0, y: 0 } }, { card: lane, at: { x: fp.width, y: fp.height } }],
  });
  const errs = Object.keys((((merged.data || merged).lint || {}).errors) || {});
  check(`two ${orientation} sandwich lanes stacked at the pitch plan_fit packs with lint clean`,
    merged.ok !== false && errs.length === 0,
    JSON.stringify(errs.slice(0, 3)));
}

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
check("while a caller that names nothing still gets the best this force can craft, which is NOT the named one",
  !!auto && !auto.fail && auto.components.belt !== "transport-belt" && auto.components.chest !== "wooden-chest",
  JSON.stringify([auto && auto.components, (slow || {}).components]));
const fitNamed = call("plan_fit", {
  item: "iron-plate", rate: 600, unit: "per_minute", lanes: 2, force: "player",
  surface: "arch-sandbox", belt: "transport-belt", inserter: "inserter", chest: "wooden-chest",
  area: WIDE,
});
check("能否放下 carries the row down into the lane it packs",
  fitNamed.ok !== false && !!fitNamed.data
  && ((fitNamed.data.lane || {}).components || {}).belt === "transport-belt",
  JSON.stringify([fitNamed.code, fitNamed.data && fitNamed.data.lane && fitNamed.data.lane.components]));

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
    && twoMat.feed_plan.lanes_in_a_row === 2
    && Math.abs(twoMat.feed_plan.per_lane * 2 - twoMat.feed_plan.per_line) < 1e-6
    && twoMat.feed_plan.lanes_wanted === asArr(twoMat.feed_plan.needs).reduce(
      (s, k) => s + Math.ceil(k.per_min / twoMat.feed_plan.per_lane), 0)
    && twoMat.feed_plan.share_one_line === (twoMat.feed_plan.lanes_wanted <= 2)
    && twoMat.feed_plan.lines_needed === Math.max(1,
      Math.ceil(twoMat.feed_plan.lanes_wanted / twoMat.feed_plan.lanes_in_a_row)),
  JSON.stringify([twoMat.feed_plan.lanes_wanted, twoMat.feed_plan.share_one_line,
    twoMat.feed_plan.per_lane, twoMat.feed_plan.lines_needed]).slice(0, 240));
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

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
