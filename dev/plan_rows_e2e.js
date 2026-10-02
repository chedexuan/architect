// End-to-end gate: the plan as something a player works in.
//
// The window used to answer a plan with sentences. That is fine to read once and useless to follow,
// because a plan is a tree: the row that says "16 electric furnaces make iron-plate" implies a next
// question -- what does iron-plate cost -- and asking it meant reading a machine name off a line and
// typing it into the form at the top. This gate covers the three things that have to hold for the rows
// to be pressable instead of readable:
//
//   * the table is rendered from a REAL solver answer, not a fixture this file agrees with;
//   * pressing a row's product retargets through the real api and comes back as a new plan;
//   * pressing something that is not a row refuses with a sentence about the plan on screen.
//
// What it cannot prove headless: what the table looks like. `gui_selftest` builds the frame against a
// stand-in player, so element names, parents and answers are all checkable here -- and pixels are not.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("plan_rows_e2e");
const { enLine } = require("./lines.js");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016" };
const call = (m, a) => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RAW: "1" } });
  } catch (e) { return { ok: false, code: "HARNESS", msg: String((e && e.stderr) || e).slice(0, 160) }; }
  try { return JSON.parse(out.trim()); } catch (e) { return { ok: false, code: "PARSE", msg: out.slice(0, 160) }; }
};
const data = (r) => (r && r.data) || {};
const asArr = (v) => (Array.isArray(v) ? v : []);
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", maxBuffer: 1 << 28, env: ENV }).trim();
  } catch (e) { return "LUA_HARNESS"; }
};
const lines = (v) => asArr(v).map(enLine);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log("  ok   " + name); }
  else { fail += 1; console.log("  FAIL " + name + " -- " + detail); }
};

// The plan on its own, before the window is involved: the rows this gate expects to see rendered are
// taken from here, so a renderer that draws a table out of its own head fails instead of agreeing.
const solved = call("plan_form", { item: "iron-plate", rate: 45, unit: "per_minute" });
const want = asArr(data(solved).how_many);
check("the solver answers a plan with rows to walk",
  solved.ok === true && want.length > 0 && want.every((r) => r.item && r.machine && r.count),
  JSON.stringify({ ok: solved.ok, code: solved.code, rows: want.length }));

// ---- #41: every ingredient the rows eat is either made by a row or named as coming from outside ----
// The invariant the row demands exist to hold: the plan's demand for an item must match what its rows
// make, or the answer is a promise of two machines that cannot both run. Compared against the answer's
// own numbers rather than against a re-derivation, because a re-derived figure is a second truth free to
// be internally consistent and still not what the code said.
const makes = {};
for (const r of want) makes[r.item] = (makes[r.item] || 0) + (r.per_machine_per_min || 0) * (r.count || 0);
const needsOf = (r) => [...asArr(r.needs), ...asArr(r.needs_fluids)];
const needs = want.flatMap((r) => needsOf(r).map((nd) => ({ ...nd, row: r })));
// A row that runs a recipe has to price what that recipe eats; a row that digs or pumps something out
// of the world has no ingredients to price, and says so by carrying no `recipe` at all. The exemption is
// keyed on that field rather than on the machine's name: a name is a hint, and the first version of this
// line tested `/drill/` against "big-mining-drill" and would have exempted a row for a coincidence of
// vocabulary while a modded digger named `excavator` failed the check for having a sensible name.
check(`every row that runs a recipe prices what it eats (${needs.length} ingredient lines over ${want.length} rows)`,
  needs.length > 0 && want.filter((r) => r.recipe).every((r) => needsOf(r).length > 0)
  && want.filter((r) => !r.recipe).every((r) => needsOf(r).length === 0),
  JSON.stringify(want.map((r) => [r.machine, r.count, r.recipe || null, needsOf(r).length])));
check("and an item the plan both makes and eats closes: no leftover gap on that edge",
  needs.filter((nd) => nd.supplied_by_plan === "plan").length > 0
  && needs.filter((nd) => nd.supplied_by_plan === "plan")
    .every((nd) => (nd.gap_per_min || 0) <= 0.5 && (nd.supplied_per_min || 0) >= nd.per_min - 0.5),
  JSON.stringify(needs.filter((nd) => nd.supplied_by_plan === "plan")
    .map((nd) => [nd.item, nd.per_min, nd.supplied_per_min, nd.gap_per_min]).slice(0, 4)));
check("...and what no row supplies is said to come from outside, rather than looking supplied",
  needs.every((nd) => nd.supplied_by_plan === "plan"
    ? (nd.gap_per_min || 0) <= 0.5
    : (nd.gap_per_min || 0) > 0 && !nd.supplied_per_min),
  JSON.stringify(needs.map((nd) => [nd.item, nd.supplied_by_plan, nd.gap_per_min]).slice(0, 4)));
// What is deliberately NOT checked here, and why: the per-craft ratio the demand was priced with
// (ingredient amount over net yield, which is where a gross-for-net swap would show up as a 41x error)
// is not re-derived in this file, because the only door to the recipe's plain numbers is
// `capabilities`, and its answer is 64 KB of every recipe the force can see -- a fixture that parses
// that per row is slow and brittle, and a fixture that hardcodes `2 iron-ore per copper plate` is a
// second truth about the recipe that this suite would then be agreeing with rather than checking.
// What is pinned instead is the consequence that a player acts on, two checks above: an edge the plan
// both makes and eats has to close to zero, so a demand priced off the gross instead of the net stops
// matching its supplier and fails there -- for kovarex, forty-one times off.
// A fluid is priced by the recipe and delivered by a pipe; the answer says which of the two it knows.
const fluids = needs.filter((nd) => nd.delivered === "unsized");
check("a fluid ingredient carries an amount AND the word that the line is not sized",
  fluids.every((nd) => nd.per_min > 0 && nd.delivered === "unsized"),
  JSON.stringify(fluids.map((nd) => [nd.item, nd.per_min, nd.delivered]).slice(0, 3)));

// ---- #60: the plan gathered back into one bill per item ----
// `totals` sums the same rows rather than re-pricing them, and what is asserted here is that the sum and
// the rows cannot disagree -- the failure this field exists to avoid is a plan whose per-item bill
// belongs to a different scaling than the machines it lists. Compared against `rounding`, because that
// pairing is what a player reads as one object: the table on screen and the numbers under it.
// Asked with a rounding direction, because that is the pairing the window shows: the table on screen
// and the bill under it belong to one scaling, and a bill from the unit plan next to rounded rows is
// exactly the mismatch this check exists to catch.
const rounded = call("plan_form", { item: "iron-plate", rate: 45, unit: "per_minute", round: "up" });
const shown = data(rounded).rounding || {};
const billRows = asArr(data(rounded).how_many);
const totals = shown.totals || {};
const tMakes = asArr(totals.makes), tSupplies = asArr(totals.supplies), tLeaves = asArr(totals.leaves);
// A plan that walks to the ground has a row for everything it eats, so `supplies` is legitimately EMPTY
// for it and `leaves` is the informative half: the items this factory can only dig up, suck out or
// grow. Asserted that way round on purpose -- a check demanding a non-empty `supplies` would be
// demanding a plan with a hole in it.
check("the plan carries a bill of what it makes and what it can only dig up",
  tMakes.length > 0 && tLeaves.length > 0,
  JSON.stringify({ makes: tMakes.length, supplies: tSupplies.length, leaves: tLeaves.length,
    rounding: shown.label }));
check("the ore behind that plan is named as a leaf, not as something arriving by itself",
  tLeaves.some((l) => l.item === "iron-ore" && l.kind === "mining"),
  JSON.stringify(tLeaves.slice(0, 3)));
const rowSum = billRows.reduce((a, r) => a + (r.per_machine_per_min || 0) * (r.count || 0), 0);
check("what it makes adds up to the rows it stands on",
  Math.abs(tMakes.reduce((a, m) => a + m.per_min, 0) - rowSum) < 0.02 * Math.max(1, rowSum),
  JSON.stringify({ bill: tMakes.reduce((a, m) => a + m.per_min, 0), rows: rowSum }));
check("the item asked for is on the bill at the rate the plan claims to output",
  tMakes.some((m) => m.item === "iron-plate" && m.per_min > 0)
    && Math.abs((((tMakes.find((m) => m.item === "iron-plate") || {}).per_min) || 0)
      - (shown.output_per_min || 0)) < 0.02 * Math.max(1, shown.output_per_min || 0),
  JSON.stringify({ bill: tMakes.find((m) => m.item === "iron-plate"), claims: shown.output_per_min }));
check("and any supply line there is, is a shortfall naming what the plan already makes of it",
  tSupplies.every((x) => x.per_min > 0 && typeof x.made_in_plan === "number" && !!x.kind),
  JSON.stringify(tSupplies.slice(0, 4)));
check("and every leaf is a row this plan cannot craft, named by how it really arrives",
  tLeaves.every((l) => l.item && l.kind && l.kind !== "craft" && (l.per_min || 0) > 0),
  JSON.stringify(tLeaves.slice(0, 3)));
const unitTotals = ((data(solved).plan || {}).unit || {}).totals || {};
check("the unit plan carries the same bill, so round = unit is not the one view with no totals",
  asArr(unitTotals.makes).length > 0 && asArr(unitTotals.leaves).length > 0,
  JSON.stringify({ makes: asArr(unitTotals.makes).length, leaves: asArr(unitTotals.leaves).length }));

const st = data(call("gui_selftest", {}));
const tree = asArr(st.tree).map(String).join("\n");
const named = asArr(st.named_rows);
const picks = named.filter((r) => String(r.name).indexOf("arch-pick:") === 0);
const targetRow = want[0] || {};

check("the window drew a plan table, from a real answer, with one button per row",
  /arch-plan-rows/.test(tree) && /arch-plan-target/.test(tree)
  && st.real_plan && st.real_plan.ok === true && st.real_plan.rows > 0
  && picks.length === st.real_plan.rows,
  JSON.stringify({ real_plan: st.real_plan, picks: picks.map((r) => r.name) }));

check("every row's button lives in the table, not loose in the frame",
  picks.length > 0 && picks.every((r) => r.parent === "arch-plan-rows"),
  JSON.stringify(picks.map((r) => ({ n: r.name, p: r.parent }))));

// The FEED rows, drawn from a real box answer rather than described. The selftest presses 能否放下 for
// `electronic-circuit` with a shape that lays one input box per machine, so the answer owes two sentences
// and this is the only place either of them is checked: how many materials ride the belt (`b-feed`), and
// the one that arrives in no box (`b-feed-unfed`). Both were invisible to the panel until the box answer's
// lane summary started carrying `feed_plan` and `unfed` at all -- the renderer had the rows, the data it
// reads had been whitelisted away, and no suite could tell, because the only plan the walk ran was iron
// plate, which eats one thing and so renders neither row.
const feedLines = asArr((st.report_feed || {}).lines).map(String);
check("the box answer says out loud how many materials ride this shape's belt line",
  feedLines.some((l) => /architect\.b-feed,/.test(l))
    && feedLines.some((l) => /architect\.b-feed,2,/.test(l)),
  JSON.stringify(feedLines.filter((l) => /b-feed|b-lane|b-fits/.test(l))).slice(0, 300));
check("...and it names the material the shape brings no box for, with its amount per craft",
  feedLines.some((l) => /architect\.b-feed-unfed,item-name\.copper-cable,3,/.test(l)),
  JSON.stringify(feedLines.filter((l) => /b-feed-unfed/.test(l))).slice(0, 300));

check("the target the header names is the plan the table came from",
  /plan-target/.test(tree) && new RegExp("architect\\.plan-target\\|").test(tree),
  asArr(st.tree).filter((l) => /plan-target/.test(String(l))).join(" / ").slice(0, 160));

// The two scale buttons are the other half of "without reaching for the keyboard"; `0.5` has to
// survive the round trip through a button NAME, which is a string, into a factor, which is not.
const scaled = named.filter((r) => String(r.name).indexOf("arch-scale:") === 0);
check("×2 and ÷2 are both there, and the factor travels in the button's own name",
  scaled.some((r) => r.name === "arch-scale:2") && scaled.some((r) => r.name === "arch-scale:0.5"),
  JSON.stringify(scaled.map((r) => r.name)));

const after = st.report_after || {};
check("pressing a row or a scale answers instead of falling through the dispatcher",
  Object.keys(after).filter((k) => /^arch-(pick|scale):/.test(k)).length >= 3
  && !Object.keys(after).some((k) => /NO_HANDLER/.test(lines(after[k].lines).join(" "))),
  JSON.stringify({ pressed: Object.keys(after).filter((k) => /^arch-(pick|scale):/.test(k)) }));

// Through the REAL api: the item comes out of the plan the window itself rendered, and the answer has
// to be a new plan for that item rather than a refusal about a row that is not there.
const pr = st.pick_real || {};
check("pressing a real row's product retargets and answers a new plan",
  pr.handler_ran === true && pr.answer === true && !pr.code
  && lines(pr.render).join(" ").length > 20,
  JSON.stringify({ ran: pr.handler_ran, answer: pr.answer, code: pr.code, render: lines(pr.render).slice(0, 2) }));

const pn = st.pick_none || {};
const pnHead = lines(pn.render)[0] || "";
check("pressing something that is not a row refuses with a sentence about the plan on screen",
  pn.code === "NO_SUCH_ROW" && /no row making/.test(pnHead) && !/architect\.|nil/.test(pnHead),
  JSON.stringify({ code: pn.code, head: pnHead.slice(0, 120) }));

// The retarget has to arrive at the same numbers the row shows: count x each-one-makes, in per-minute.
const retarget = call("plan_form", {
  item: targetRow.item, rate: (targetRow.count || 0) * (targetRow.per_machine_per_min || 0),
  unit: "per_minute",
});
check("the rate a row implies is a rate the solver accepts, and answers for that product",
  retarget.ok === true && retarget.data.item === targetRow.item
  && asArr(retarget.data.how_many).length > 0,
  JSON.stringify({ ok: retarget.ok, code: retarget.code, item: retarget.data && retarget.data.item }));

check("no button the panel rendered comes back undispached",
  asArr(st.unhandled).length === 0, JSON.stringify(asArr(st.unhandled)));

// ---- icons: the part that can be proven from here, and the part that cannot ----
//
// A GUI `SpritePath` cannot name a file, so the panel can only draw what the mod's data stage
// registered. `helpers.is_valid_sprite_path` is the runtime's own answer to "will this draw", which
// makes the plumbing checkable headless. What the picture looks like -- size, alignment, whether the
// base layer of a multi-layer icon reads as broken next to the inventory -- is not checkable here at
// all, and nothing below claims it.
const pic = st.icons || {};
const planRows = (st.real_plan || {}).rows || 0;
check("the plan rows resolved icons, and the table drew exactly one picture per resolved row",
  pic.with > 0 && pic.cells === pic.with && pic.with + asArr(pic.without).length === planRows,
  JSON.stringify({ with: pic.with, cells: pic.cells, without: pic.without, rows: planRows }));
check("the target line carries the product's own picture",
  typeof pic.target === "string" && pic.target.indexOf("arch-icon-item-") === 0,
  JSON.stringify(pic.target));

// `lua.js` prints the value and then a sentinel line, so an answer is found by scanning lines -- not by
// trimming or popping, both of which have cost this project a check that passed on the wrong text.
const one = (src) => String(lua(src)).split("\n").map((l) => l.trim()).filter(Boolean)[0] || "";
const probe = lua(`local names = { "item-iron-plate", "item-iron-gear-wheel", "fluid-crude-oil",
  "entity-electric-furnace", "tech-automation" }
local out = {}
for _, n in ipairs(names) do
  out[#out+1] = n .. "=" .. tostring(helpers.is_valid_sprite_path("arch-icon-" .. n))
end
rcon.print(table.concat(out, " "))`);
check("the sprite names the panel builds are the ones the data stage registered",
  /item-iron-plate=true/.test(probe) && /entity-electric-furnace=true/.test(probe)
  && /fluid-crude-oil=true/.test(probe),
  String(probe).slice(0, 200));
// The check that makes the one above mean anything: if an unregistered name also answered "valid",
// then `is_valid_sprite_path` would be proving nothing and the false case would never be seen.
const unregistered = one('rcon.print(tostring(helpers.is_valid_sprite_path("arch-icon-item-not-a-thing")))');
// The check that gives the two above their meaning: were an unregistered name also answered "true",
// the helper would be proving nothing and every row would claim a picture it cannot draw.
check("and a name nobody registered answers false rather than lying about drawing",
  unregistered === "false", JSON.stringify(unregistered));

// ---------------------------------------------------------------- when the plan is made whole
//
// 方向 (which way to round) has been a player's choice for a while; 时机 (what that way is applied to)
// is the other half, and the two do not agree about how many machines to buy. The unit plan for
// iron-plate is four furnaces and one drill at 150/min, so asking for 200/min is 1.33 units: rounded as
// ONE line that buys eight furnaces and two drills (300/min, twice what was asked); rounded row by row
// it buys six and two (225/min). Same ask, same direction, a different factory -- which is exactly why
// it has to be a choice the window can make rather than an opinion the solver holds.
// ---------------------------------------------------------------- when the plan is made whole
//
// 方向 (which way to round) has been a player's choice for a while; 时机 (what that way is applied to)
// is the other half, and the two disagree about how many machines to buy. Rounding a line of four
// furnaces and one drill by 1.33 buys two of everything as ONE line (8 + 2), and eleven-and-two as
// rows (11 + 2 is what the furnaces alone need) -- same ask, same direction, a different factory.
//
// The rate is derived from the unit plan the world actually answers with, not hardcoded: an electric
// furnace at this tech level and a stone one make different units for the same plate, and a fixture
// that pins a number is a fixture that goes red when another suite unlocks a recipe (see solve_e2e's
// overshoot check for the same lesson, learned the hard way an hour apart).
const unitOf = (d) => ((d.plan || {}).unit || {}).output_per_min || 0;
const base = data(call("plan_form", { item: "iron-plate", rate: 60, unit: "per_minute" }));
const ask = Math.ceil(unitOf(base) * 4 / 3);            // 1 < scale < 2, the only region that can split
const merged = data(call("plan_form", { item: "iron-plate", rate: ask, unit: "per_minute", round: "up" }));
const perLine = data(call("plan_form", { item: "iron-plate", rate: ask, unit: "per_minute",
  round: "up", round_when: "per_line" }));
const perLineDown = data(call("plan_form", { item: "iron-plate", rate: ask, unit: "per_minute",
  round: "down", round_when: "per_line" }));
const total = (d) => asArr(d.how_many).reduce((n, r) => n + (r.count || 0), 0);
check("the fixture asks where the two timings can disagree (1 < scale < 2), and both answered",
  unitOf(base) > 0 && (merged.rounding || {}).replicas >= 2 && total(perLine) > 0,
  JSON.stringify([unitOf(base), ask, (merged.rounding || {}).replicas, total(perLine)]));
check("a per-row plan says which of the two it is",
  (perLine.rounding || {}).mode === "per_line" && (perLine.rounding || {}).label === "line-up"
  && (merged.rounding || {}).mode === "merged",
  JSON.stringify([(perLine.rounding || {}).label, (merged.rounding || {}).label]));
check("the same ask rounded the same way buys FEWER machines row by row than line by line",
  total(perLine) < total(merged) && total(perLine) > 0,
  JSON.stringify([total(merged), total(perLine), asArr(merged.how_many).map((r) => [r.machine, r.count]),
    asArr(perLine.how_many).map((r) => [r.machine, r.count])]));
check("...and the replicas stay 1, because the scaling lives inside each row already",
  (perLine.rounding || {}).replicas === 1 && (merged.rounding || {}).replicas >= 2,
  JSON.stringify([(perLine.rounding || {}).replicas, (merged.rounding || {}).replicas]));
// Only the per-row plan states its own machine total; a merged one is unit count times replicas and
// `api.fit` does that multiplication, so a field there would be a second way to say one number.
check("the row total the fit packs with is the rows the table shows",
  (perLine.rounding || {}).machine_slots === total(perLine),
  JSON.stringify([(perLine.rounding || {}).machine_slots, total(perLine)]));
// The honest cost of rounding a row on its own, and the reason the check has to be made on the DOWN
// direction: rounding everything up over-supplies every edge, so no gap can appear -- the imbalance
// only shows when one row is rounded down below what another row eats. Asserting a gap on the `up`
// plan would be asserting something the arithmetic cannot produce.
const downGaps = asArr(perLineDown.how_many).flatMap((r) => asArr(r.needs)
  .map((nd) => [r.machine, nd.item, nd.per_min, nd.gap_per_min]));
check("rounded down row by row, a row eats more than its supplier was rounded down to give, and says so",
  downGaps.some((g) => (g[3] || 0) > 0),
  JSON.stringify([asArr(perLineDown.how_many).map((r) => [r.machine, r.count]), downGaps]));
check("naming no timing answers exactly as it did before the choice existed",
  !!merged.how_many && (merged.rounding || {}).label === "ceil" && !merged.rounding.machine_slots,
  JSON.stringify(merged.rounding));

const verdict = fail === 0 ? "ALL PASS" : "FAILURES";
console.log(`${verdict}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
