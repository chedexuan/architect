// Does the plan escalate the pole tier when the cheap one cannot bridge the gap?
//
// region_layout{power} retries the whole plan with the next pole tier, using the MEASURED
// reach of each type rather than a guessed radius. Until the poles beyond `small` are
// researched that branch has never once executed -- so this grants the distribution techs,
// builds deliberately crowded layouts, and reads back which tier won and at what cost.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : Object.keys(v).length ? Object.values(v) : []);
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

lua(`local f=game.forces.player
for _,t in ipairs({"electronics","automation","logistics","steel-processing","logistics-2","solar-energy","electric-energy-accumulators"}) do
  local x=f.technologies[t]; if x then x.researched=true end
end`);

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) fails++;
};

// ---- with only small poles available, escalation has nothing to escalate to ----
const cell = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));
const lane = call("card_example", {}).data;
const bus = call("bus_example", { taps: 2 }).data;
const cor = call("corridor_example", { taps: 2 }).data;

const short = ready("region_layout", { entries: [{ card: lane }, { card: cor }, { card: cell, count: 2 }], power: true, size: false });
check("planning works with only the shortest pole", short.ok, short.ok ? "" : `${short.code} ${short.msg}`);
if (short.ok) {
  const p = short.data.power;
  console.log(`     locked-tier run: pole=${p.pole} nets ${p.networks_before}->${p.networks_after} added=${p.added} probes=${p.probes} unserved=${p.still_unserved}`);
}

lua(`local f=game.forces.player
for _,t in ipairs({"electric-energy-distribution-1","electric-energy-distribution-2"}) do
  local x=f.technologies[t]; if x then x.researched=true end
end`);

// ---- now the escalation branch has somewhere to go ----
const wide = ready("region_layout", {
  entries: [{ card: lane }, { card: cor }, { card: cell, count: 2 }, { card: bus }], power: true, size: false,
});
if (!wide.ok) { check("escalated region planned", false, `${wide.code} ${wide.msg}`); }
else {
  const p = wide.data.power;
  const tiers = asArr(p.poles_tried);
  check("the plan reaches one grid once a longer-reach pole is buildable",
    p.still_unserved === 0 && p.networks_after === 1,
    `pole=${p.pole}, nets ${p.networks_before}->${p.networks_after} via ${p.chains} chains, ${p.added} added, ${p.probes} probes`);
  check("the retry ladder is reported, tier by tier, with measured reach",
    tiers.length >= 1 && tiers.every((x) => x.wires > 0 && x.pole),
    tiers.map((x) => `${x.pole}(wire ${x.wires}) -> ${x.networks} nets, ${x.added} added`).join(" | "));
  check("the cheapest sufficient pole wins",
    tiers.length === 0 || tiers[tiers.length - 1].pole === p.pole,
    `chosen ${p.pole} after ${tiers.length} tier attempt(s)`);
  // The ladder it ranked on, carried in the answer. "Cheapest sufficient" is only checkable if the
  // measured figures travel with the plan -- and a tier whose measurement raised sorts to the back
  // while still leaving the plan looking fine, so every tier has to have produced a number.
  const lad = asArr(p.pole_ladder);
  const distinct = new Set(lad.map((e) => e.wire_tiles)).size;
  check("the region's ladder is measured, ascending, and the winner is the first unlocked tier",
    lad.length >= 4 && lad.every((e) => typeof e.wire_tiles === "number")
    && lad.every((e, i) => i === 0 || lad[i - 1].wire_tiles <= e.wire_tiles)
    && p.pole === (lad.find((e) => e.unlocked !== false) || {}).name,
    lad.map((e) => `${e.name}:${e.wire_tiles}${e.unlocked ? "" : "(locked)"}`).join(" "));
  // ...and the figures have to be four different numbers. Every pole measured on a surface that
  // already carries a global electric network joins every other pole, so the probe runs to its loop
  // ceiling and reports 44 tiles for the smallest pole in the game -- an ascending ladder of four
  // identical values, which the check above cannot see. `power.planned_on` says which surface this
  // was measured on, because a plan is only worth as much as the ground it was sized against.
  check("the four reaches are four different measurements, on a surface that can answer",
    distinct === lad.length && p.planned_on === "arch-sandbox",
    `${distinct} distinct figure(s) of ${lad.length}; measured on ${p.planned_on}`);
  const v = ready("card_verify", { card: wide.data.card, require_single_network: true });
  check("applying the escalated plan gives one fully covered grid",
    v.ok && v.data.power.uncovered === 0 && v.data.networks.length === 1,
    v.ok ? `${v.data.power.covered}/${v.data.power.powered_entities} covered, networks=${v.data.networks.length}, warnings ${asArr(v.data.warnings).map((w) => w.code).join(" ")}` : `${v.code} ${v.msg}`);
}

console.log(fails === 0 ? "\nall pole-tier checks passed" : `\n${fails} check(s) failed`);
process.exit(fails ? 1 : 0);
