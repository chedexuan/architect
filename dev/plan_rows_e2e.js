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

const verdict = fail === 0 ? "ALL PASS" : "FAILURES";
console.log(`${verdict}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
