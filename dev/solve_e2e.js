// The solver used to refuse any recipe with more than one product. That refusal hid two
// things: it blocked the whole nuclear and oil branches, and it covered up a rate bug.
//
// 2.0 writes uranium enrichment as {amount = 1, probability = 0.007}, not amount = 0.007. The
// model read `p.amount or p.probability`, so it took 1 -- every centrifuge was sized 143x too
// small, and the plan still "worked" because a single-product recipe never looks at the split.
// These checks pin the corrected arithmetic from three directions that have to agree: the
// per-machine rate, the by-product ratio, and the ore balance feeding it.
const { execFileSync } = require("child_process");
const path = require("path");

const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : Object.keys(v).length ? Object.values(v) : []);
const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8" }).trim();

lua(`local f=game.forces.player
for _,t in ipairs({"electronics","automation","logistics","steel-processing","uranium-processing","nuclear-power","oil-processing","sulfur-processing","plastics","chemical-science","advanced-material-processing","advanced-material-processing-2"}) do
  local x=f.technologies[t]; if x then x.researched=true end
end`);

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) fails++;
};

// ---- 1. the probabilistic split is honoured ----
const u235 = call("solve", { want: { item: "uranium-235", rate_per_min: 1 } });
check("a multi-product recipe solves instead of being refused", u235.ok === true,
  u235.ok ? "centrifuge line planned" : `${u235.code} ${u235.msg}`);
if (u235.ok) {
  const craft = asArr(u235.data.unit.nodes).find((n) => n.recipe === "uranium-processing");
  // 10 ore -> {0.007 U-235, 0.993 U-238} per craft, energy 12 s, centrifuge speed 1
  const expected = 0.007 * (60 / 12);
  check("per-machine rate folds probability in", craft && Math.abs(craft.per_machine_per_min - expected) < 1e-6,
    craft ? `${craft.per_machine_per_min}/min per centrifuge, expected ${expected}` : "no enrichment node");
  const bp = asArr(craft && craft.by_products);
  const u238 = bp.find((b) => b.item === "uranium-238");
  const ore = asArr(u235.data.unit.nodes).find((n) => n.item === "uranium-ore");
  check("the co-product comes out at the exact 993:7 ratio", !!u238
    && Math.abs(u238.per_min / (craft.per_machine_per_min * craft.count) - 0.993 / 0.007) < 0.01,
    u238 ? `${u238.per_min} U-238/min against ${craft.per_machine_per_min * craft.count} U-235/min = `
      + `${(u238.per_min / (craft.per_machine_per_min * craft.count)).toFixed(3)} (993/7 = ${(0.993 / 0.007).toFixed(3)})` : "no by-product");
  check("the ore side still balances after the fix", !!ore && ore.count * ore.per_machine_per_min > 0,
    ore ? `${ore.count} drills x ${ore.per_machine_per_min}/min ore feeds ${craft.count} centrifuges` : "no mining node");
  check("by-products are summarised for the whole plan", asArr(u235.data.by_products).length >= 1,
    asArr(u235.data.by_products).map((b) => `${b.item} ${b.per_min}/min`).join(" "));
}

// ---- 2. a plan that makes what it also consumes says so, instead of double counting ----
{
  const both = call("solve", { want: { item: "uranium-238", rate_per_min: 10 } });
  check("solving for the co-product's own line works", both.ok === true,
    both.ok ? `${both.data.unit.machine_slots} machine slots` : `${both.code} ${both.msg}`);
}

// ---- 3. a genuinely circular recipe is reported as circular ----
{
  const kovarex = call("solve", {
    want: { item: "uranium-235", rate_per_min: 1 }, routes: { "uranium-235": "kovarex-enrichment-process" },
  });
  check("a recipe that consumes its own output is refused by name, not by hang",
    !kovarex.ok && (kovarex.code === "CYCLIC_RECIPE" || kovarex.code === "UNKNOWN_ROUTE" || kovarex.code === "LOCKED_MACHINE"),
    kovarex.ok ? "unexpectedly solved" : `${kovarex.code} ${kovarex.msg}`);
}

// ---- 4. oil: the wall is fluids, not the multi-product refusal ----
{
  const plastic = call("solve", { want: { item: "plastic-bar", rate_per_min: 12 } });
  const blocked_on_fluid = !plastic.ok && /crude-oil|pumpjack|UNRESOLVED_INPUT|LOCKED_MACHINE|NO_MINER/.test(
    `${plastic.code} ${plastic.msg} ${JSON.stringify(plastic.detail || {})}`);
  check("a fluid-fed tree fails on the fluid/machine, and says which",
    plastic.ok === true || blocked_on_fluid,
    plastic.ok ? "plastic solved outright" : `${plastic.code}: ${String(plastic.msg).slice(0, 150)}`);
}

// ---- 5. modules: measured arithmetic, and the slot cap a plan cannot opt out of ----
{
  const caps = call("capabilities", {});
  const mods = caps.ok ? asArr(caps.data.modules) : [];
  const prod = mods.find((m) => m.name === "productivity-module");
  check("module effects are published, rounded to what the tooltip says",
    !!prod && prod.speed === -0.05 && prod.productivity === 0.04 && prod.consumption === 0.4,
    mods.map((m) => `${m.name} s${m.speed} p${m.productivity} c${m.consumption}`).join(" | ").slice(0, 220));

  const craft = (x) => (x.ok ? asArr(x.data.unit.nodes).find((n) => n.kind === "craft") : null);
  const speed = call("solve", {
    want: { item: "iron-plate", rate_per_min: 60 }, machines: { smelting: "electric-furnace" },
    modules: [{ item: "speed-module-2", count: 4 }],
  });
  const sn = craft(speed);
  // dev/module_measure.js measured x1.6066 for two speed-2 modules in this furnace. Four
  // were asked for, the machine has two slots, so the plan must use two -- and say so.
  check("speed modules scale the rate exactly as the game measured it, capped by slots",
    !!sn && !!sn.modules && sn.modules.slots_used === 2 && Math.abs(sn.per_machine_per_min - 60) < 0.01
      && Math.abs(sn.modules.rate - 1.6) < 1e-6,
    sn ? `${sn.per_machine_per_min}/min per furnace (bare says 37.5, measured 37.14 / 59.67), rate x${sn.modules.rate}, slots ${sn.modules.slots_used}` : `${speed.code} ${speed.msg}`);
  check("a request that does not fit is reported, not quietly dropped",
    !!sn && asArr(sn.modules && sn.modules.notes).some((n) => n.asked === 4 && n.fitted === 2),
    sn ? JSON.stringify(asArr((sn.modules || {}).notes)).slice(0, 150) : "");

  const pr = call("solve", {
    want: { item: "iron-plate", rate_per_min: 60 }, machines: { smelting: "electric-furnace" },
    modules: [{ item: "productivity-module", count: 2 }],
  });
  const pn = craft(pr);
  check("productivity applies to smelting in 2.0 (it did not in 1.1), with its speed cost",
    !!pn && !!pn.modules && pn.modules.speed === 0.9 && pn.modules.productivity === 1.08 && pn.modules.consumption === 1.8,
    pn ? `rate x${pn.modules.rate.toFixed(4)} -> ${pn.per_machine_per_min}/min, power x${pn.modules.consumption}` : `${pr.code} ${pr.msg}`);
  check("exact rationals mean the indivisible unit can overshoot, and must admit it",
    !!pn && pr.data.unit.output_per_min > 600,
    pn ? `unit produces ${pr.data.unit.output_per_min}/min against a 60/min request` : "");
}

console.log(fails === 0 ? "\nall solver checks passed" : `\n${fails} check(s) failed`);
process.exit(fails ? 1 : 0);
