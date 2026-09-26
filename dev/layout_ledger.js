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

// Both shapes have to stand on real ground. This is the refusal the styles layer cannot make on its
// own: an arm whose pickup face ended up on the wrong side is legal JSON and an impossibility to build.
for (const l of lanes) {
  const r = call("card_verify", { card: { name: `ledger-${l.facing}`, entities: entities(l.data),
    ports: (l.data || {}).ports, contract: (l.data || {}).contract }, require_single_network: true });
  check(`${JSON.stringify(l.cfg)} ${l.facing}: the engine accepts the shape it was given`,
    (r || {}).ok === true, JSON.stringify([(r || {}).code, asArr((r || {}).data || {}).errors].slice(0, 2)));
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

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
