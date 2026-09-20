// M12: a region has to be powered by the rules, not by a human remembering poles.
//
// Four questions, in the order they used to break:
//   1. does a plan cover a bare card at all?
//   2. does it survive being APPLIED -- i.e. are the reported positions in the card's own
//      frame, so re-placing the card at a non-zero origin still lands the poles?
//   3. can one pass cover a 59-entity region and merge the islands into a single grid?
//   4. how many engine calls did that cost, now that coverage is arithmetic?
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : Object.keys(v).length ? Object.values(v) : []);
const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8" }).trim();
const wait = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ready = (m, a) => {
  for (let i = 0; i < 15; i++) {
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

const cell = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));
const poweredCell = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_power.json"), "utf8"));

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) fails++;
};

// ---- 1 + 2: plan, apply, re-judge, at an origin that is not the default ----
for (const origin of [undefined, { x: 30, y: 18 }]) {
  const tag = origin ? `origin ${origin.x},${origin.y}` : "default origin";
  const pres = ready("card_fix_power", { card: cell, origin });
  if (!pres.ok) { check(`plan for a cell (${tag})`, false, `${pres.code} ${pres.msg}`); continue; }
  const plan = pres.data;
  check(`plan covers every machine (${tag})`, plan.still_unserved === 0 && plan.uncovered_after === 0,
    `served ${plan.served}/${plan.powered}, ${plan.to_add} additions, ${plan.probes} probes, ` +
    `networks ${plan.networks_before}->${plan.networks_after}, wire=${plan.facts.wire_tiles} supply=${plan.facts.supply_tiles}`);

  const fixed = JSON.parse(JSON.stringify(cell));
  for (const s of arr(plan.suggestion)) fixed.entities.push(s);
  const fv = ready("card_verify", { card: fixed, origin, require_single_network: true });
  check(`applying the plan really powers it (${tag})`,
    fv.ok && fv.data.power.uncovered === 0 && fv.data.power.covered === fv.data.power.powered_entities,
    fv.ok ? `${fv.data.power.covered}/${fv.data.power.powered_entities} covered, ${arr(fv.data.warnings).map((w) => w.code).join(" ")}; ` +
      `demand ${fv.data.power.demand_kw}kW supply ${fv.data.power.in_card_supply_kw}kW` : `${fv.code} ${fv.msg}`);
}

// ---- 2b: a card that already carries its own grid should need (almost) nothing ----
{
  const pres = ready("card_fix_power", { card: poweredCell });
  check("a self-powered card is left alone", pres.ok && pres.data.to_add <= 1,
    pres.ok ? `${pres.data.to_add} additions for ${pres.data.powered} machines` : `${pres.code} ${pres.msg}`);
}

// ---- 3: the whole line, in one region-level pass ----
{
  const lane = call("card_example", {}).data;
  const bus = call("bus_example", { taps: 2 }).data;
  const lay = ready("region_layout", { entries: [{ card: lane }, { card: bus }, { card: cell, count: 2 }] });
  if (!lay.ok) { check("region laid out", false, `${lay.code} ${lay.msg}`); }
  else {
    const bare = lay.data;
    console.log(`     region: ${bare.entities} entities, ${bare.site ? `site ${bare.site.x},${bare.site.y}` : "no site"}`);
    const layP = ready("region_layout", {
      entries: [{ card: lane }, { card: bus }, { card: cell, count: 2 }], power: true,
    });
    if (!layP.ok) { check("region laid out with power", false, `${layP.code} ${layP.msg}`); }
    else {
      const d = layP.data;
      const p = d.power;
      check("one pass powers a whole region", p && p.ok === true,
        p ? `${p.added} poles/supplies added for ${p.powered} consumers, ${p.probes} probes, ` +
          `networks ${p.networks_before}->${p.networks_after} via ${p.chains} chains, ` +
          `supply_added=${p.supply_added}, demand ${p.demand_kw}kW / carry ${p.supply_kw}kW` : "no power block");
      const v = ready("card_verify", { card: d.card, require_single_network: true });
      check("the powered region verifies as one covered grid",
        v.ok && v.data.power.uncovered === 0 && v.data.networks.length === 1,
        v.ok ? `${v.data.power.covered}/${v.data.power.powered_entities} covered, networks=${v.data.networks.length}, ` +
          `warnings ${arr(v.data.warnings).map((w) => w.code).join(" ")}` : `${v.code} ${v.msg}`);
      // A frozen region is only useful if it still lints after the grid went in.
      check("powered region still lints clean", arr(d.lint.errors).length === 0,
        arr(d.lint.errors).map((e) => e.code).join(" ") || "ok");
      console.log(`     entities ${bare.entities} -> ${d.entities} with the grid folded in`);
    }
  }
}

// ---- M13: covered is not the same as affordable ----
{
  const pp = ready("power_plan", { demand_kw: 360 });
  if (!pp.ok) { check("power_plan sizes a load", false, `${pp.code} ${pp.msg}`); }
  else {
    const d = pp.data;
    // The constants carry the answer, so pin them: 60 kW per panel nameplate (the raw getter
    // would say 1000), a 5 MJ accumulator that can only push 300 kW.
    check("sizing reads engine constants, in kW", d.generator.kw_each === 60 && d.storage.buffer_kj === 5000
      && d.storage.out_kw === 300,
      `panel ${d.generator.kw_each}kW day_only=${d.generator.day_only}; accumulator ${d.storage.buffer_kj}kJ ` +
      `out ${d.storage.out_kw}kW in ${d.storage.in_kw}`);
    check("an unlimited flow limit is reported as absent, not as infinity",
      d.generator.in_kw === undefined, JSON.stringify(d.generator).slice(0, 120));
    const s = d.sizing;
    check("a sized grid survives a day, and says what it cost",
      s.ok === true && s.brownout_seconds === 0 && s.daily_generation_mj >= s.daily_demand_mj,
      `${s.panels_total} panels + ${s.accumulators_total} accumulators for ${d.demand_kw}kW; ` +
      `gen ${s.daily_generation_mj.toFixed(0)}MJ vs demand ${s.daily_demand_mj.toFixed(0)}MJ, ` +
      `spill ${s.spill_mj.toFixed(1)}MJ, storage ${s.storage_mj}MJ, night ${d.day.night_seconds}s, duty ${d.day.duty.toFixed(2)}`);
    check("the panel minimum is really the floor: fewer panels cannot be saved with storage",
      s.search[0] && s.search[0].panels === s.panels_total,
      s.search.map((x) => `${x.panels}p/${x.accumulators || "-"}a${x.feasible ? "" : " infeasible"}`).join("  "));
    check("the day model declares itself as modelled, not measured",
      d.day.model.indexOf("piecewise_linear") === 0 && typeof d.day.duty === "number", d.day.model);
  }

  // A refusal that names the research is a different tool than a refusal that says "no".
  // The precondition belongs to the check: another suite may have researched nuclear power
  // already, and then "unbuildable" would simply be false.
  lua(`local r=game.forces.player.recipes["nuclear-reactor"] if r then r.enabled=false end rcon.print("locked")`);
  const locked = call("power_plan", { demand_kw: 360, generator: "nuclear-reactor" });
  const detail = locked.ok ? "" : JSON.stringify(locked.detail || {});
  check("an unbuildable generator is refused by name, with the research that fixes it",
    !locked.ok && locked.code === "NO_BUILDABLE_GENERATOR" && /nuclear-power/.test(detail),
    `${locked.code} ${detail.slice(0, 140)}`);
  lua(`local r=game.forces.player.recipes["nuclear-reactor"] if r then r.enabled=true end rcon.print("restored")`);
}

// ---- M13 end to end: a region that comes back able to run ----
{
  const lane = call("card_example", {}).data;
  const bus = call("bus_example", { taps: 2 }).data;
  const lay = ready("region_layout", {
    entries: [{ card: lane }, { card: bus }, { card: cell, count: 2 }], power: true,
  });
  if (!lay.ok) { check("sized region laid out", false, `${lay.code} ${lay.msg}`); }
  else {
    const d = lay.data, p = d.power;
    check("the sized grid is folded into the region card",
      !!p && !!p.sizing && !!p.sizing.ok,
      p && p.sizing ? `+${p.added} entities for ${p.demand_kw}kW: panels ${p.sizing.panels_total}, ` +
        `accumulators ${p.sizing.accumulators_total}, placed ${JSON.stringify(p.placed_units)}` +
        (p.unit_shortfall ? ` SHORTFALL ${JSON.stringify(p.unit_shortfall)}` : "") : "no sizing block");
    const kinds = {};
    for (const e of d.card.entities) kinds[e.name] = (kinds[e.name] || 0) + 1;
    console.log(`     region now carries: ${Object.keys(kinds).filter((k) => /pole|solar|accumulator/.test(k)).map((k) => `${k}×${kinds[k]}`).join(" ")}`);
    const v = ready("card_verify", { card: d.card, require_single_network: true });
    check("a sized region is no longer under-provisioned",
      v.ok && !arr(v.data.warnings).some((w) => w.code === "GRID_UNDER_PROVISIONED"),
      v.ok ? `demand ${v.data.power.demand_kw}kW vs ${v.data.power.in_card_supply_kw}kW in-card, ` +
        `${v.data.power.covered}/${v.data.power.powered_entities} covered, warnings ${arr(v.data.warnings).map((w) => w.code).join(" ")}`
        : `${v.code} ${v.msg}`);
  }
}

console.log(fails === 0 ? "\nall M12/M13 checks passed" : `\n${fails} check(s) failed`);
process.exit(fails ? 1 : 0);

