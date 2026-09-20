// Does the power trunk admit defeat?
//
// region_layout{power} escalates pole tiers until the region is one grid, and poletier_e2e
// proves the case where a longer pole wins. The branch that never ran is the one where nothing
// wins: `exhausted_search`. A plan that says "12 of 12 covered" when two grids never met is the
// failure mode this suite was built to prevent, so the exercise is to make the search fail and
// read what it says -- reason, remedy, probe count, and whether it still claims a single network.
//
// Phase 1 plans only. Nothing is frozen or placed, so the run is repeatable without a restore.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8" }).trim();
const wait = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ready = (m, a) => {
  for (let i = 0; i < 20; i++) {
    const r = call(m, a);
    if (r.ok || r.code !== "SANDBOX_GENERATING") return r;
    wait(1000);
  }
  return { ok: false, code: "SANDBOX_STUCK" };
};
const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : Object.keys(v).length ? Object.values(v) : []);

lua(`local f=game.forces.player
for _,t in ipairs({"electronics","automation","logistics","steel-processing","logistics-2","solar-energy","electric-energy-accumulators","electric-energy-distribution-1","electric-energy-distribution-2"}) do
  local x=f.technologies[t]; if x then x.researched=true end
end`);

const lane = call("card_example", {}).data;
const bus = call("bus_example", { taps: 2 }).data;
const cor = call("corridor_example", { taps: 2 }).data;
const cell = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));

const report = (label, r) => {
  if (!r.ok) { console.log(`${label}: ${r.code} ${r.msg} ${JSON.stringify(r.detail || "").slice(0, 300)}`); return null; }
  const d = r.data || {};
  const p = d.power || {};
  console.log(`${label}: keys=${Object.keys(d).join(",")}`);
  console.log(`  entities=${d.entities} site=${JSON.stringify(d.site)} plan_site=${JSON.stringify(d.plan_site)}`
    + ` rejections=${asArr(d.site_rejections).length} ${JSON.stringify(asArr(d.site_rejections)[0] || null).slice(0, 200)}`);
  console.log(`  lint_errors=${asArr(d.lint && d.lint.errors).length} ${asArr(d.lint && d.lint.errors).map((e) => e.code).join(" ")}`);
  console.log(`  pole=${p.pole} nets ${p.networks_before}->${p.networks_after} served=${p.served}/${p.powered}`
    + ` unserved=${p.still_unserved} added=${p.added} probes=${p.probes}/${p.probes_budget}`);
  console.log(`  exhausted_search=${JSON.stringify(p.exhausted_search)} blocked_cells=${JSON.stringify(p.blocked_cells)}`);
  console.log(`  poles_tried=${asArr(p.poles_tried).map((x) => `${x.pole}(wire ${x.wires}) nets=${x.networks} unserved=${x.unserved} exhausted=${x.exhausted}`).join(" | ")}`);
  console.log(`  unmerged=${JSON.stringify(p.unmerged)} unmerged_fix=${JSON.stringify(p.unmerged_fix)}`);
  console.log(`  sizing=${JSON.stringify(p.sizing)} placed=${JSON.stringify(p.placed_units)} short=${JSON.stringify(p.unit_shortfall)}`);
  return p;
};

// Three cards merge today; five are used to drive the add budget down; eight are wide enough to
// run out of ground, which is the other way a power plan can fail to exist.
const small = [{ card: lane }, { card: cor }, { card: bus }];
const mid = [{ card: lane }, { card: cor }, { card: bus }, { card: cell, count: 2 }];
const big = [{ card: lane }, { card: cor }, { card: bus }, { card: lane, count: 2 },
  { card: cor, count: 2 }, { card: bus, count: 2 }];

const trio = report("3 cards", ready("region_layout", { entries: small, power: true, size: false }));
const whole = report("5 cards, default budget", ready("region_layout", { entries: mid, power: true, size: false }));
const starved = report("5 cards, max_adds=1", ready("region_layout", { entries: mid, power: true, size: false, max_adds: 1 }));
const starved2 = report("5 cards, max_adds=2", ready("region_layout", { entries: mid, power: true, size: false, max_adds: 2 }));
const wide = report("8 cards", ready("region_layout", { entries: big, power: true, size: false }));

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) fails++;
};

if (trio && whole && starved) {
  check("a region that fits is planned and merges into one grid",
    whole.exhausted_search !== true && whole.still_unserved === 0 && whole.networks_after <= 1,
    `pole=${whole.pole} nets=${whole.networks_before}->${whole.networks_after} served=${whole.served}/${whole.powered} probes=${whole.probes}`);
  check("an add budget the search cannot finish with is reported, not hidden",
    starved.exhausted_search === true,
    `exhausted=${starved.exhausted_search} unserved=${starved.still_unserved} added=${starved.added} nets=${starved.networks_after}`);
  check("a starved plan does not claim one merged network",
    !(starved.networks_after <= 1 && starved.still_unserved === 0),
    `nets=${starved.networks_after} unserved=${starved.still_unserved}`);
  check("every tier that was tried is on the record",
    asArr(starved.poles_tried).length >= 1 && asArr(starved.poles_tried).every((x) => x.wires > 0),
    asArr(starved.poles_tried).map((x) => x.pole).join(","));
}
if (wide) {
  check("a region too wide for the ground says the grid was not planned, and how wide it is",
    wide.planned === false && wide.reason === "NO_CLEAR_SITE" && wide.region_tiles
    && asArr(wide.rejections).length > 0,
    `${wide.reason} tiles=${JSON.stringify(wide.region_tiles)} rejections=${asArr(wide.rejections).length}`);
}

console.log(fails === 0 ? "\ntrunk search verdicts are honest" : `\n${fails} check(s) failed`);
process.exit(fails ? 1 : 0);
