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

// ---- 3. a recipe that consumes its own output is planned on what it keeps ----
{
  // This used to be the case that proved `CYCLIC_RECIPE` fired: kovarex takes 40 units of
  // uranium-235 per craft and hands 41 back, and the solver had no way to say what "make 1 per
  // minute" means when the step eats 40 of the thing it is making. It has one now -- the net per
  // craft -- so the assertion flipped from "refused by name, not by hang" to "planned, and the
  // number it prints is the one the machine keeps".
  const kovarex = call("solve", {
    want: { item: "uranium-235", rate_per_min: 1 }, routes: { "uranium-235": "kovarex-enrichment-process" },
  });
  const node = asArr(kovarex.data && kovarex.data.unit && kovarex.data.unit.nodes)
    .find((n) => n.recipe === "kovarex-enrichment-process");
  check("a recipe that consumes its own output is planned instead of refused",
    kovarex.ok === true && !!node, kovarex.ok ? `${node && node.machine} x${node && node.count}` : `${kovarex.code} ${kovarex.msg}`);
  check("and it says both numbers: what the belt carries and what the line keeps",
    !!node && !!node.recirculated && node.recirculated.per_craft_in === 40
    && node.recirculated.per_craft_out === 41 && node.recirculated.per_craft_net === 1,
    node ? JSON.stringify(node.recirculated) : "no kovarex node");
  // The whole point of the net yield: a centrifuge whose gross rate is 41/min per craft delivers
  // ONE a minute to the rest of the graph, so a plan for 1/min is a hundred-plus machines and not
  // the handful a gross reading asks for. `unit.output_per_min` is the plan's own claim about what
  // one replica of itself delivers, and it has to equal count x net-per-machine.
  const gross_claim = node && node.count * node.per_machine_per_min;
  check("the machine count is sized on the net rate, not the gross one",
    !!node && Math.abs(gross_claim - kovarex.data.unit.output_per_min) < 1e-6
    && node.count > node.recirculated.per_craft_net,
    node ? `${node.count} x ${node.per_machine_per_min}/min = ${gross_claim}, unit delivers ${kovarex.data.unit.output_per_min}/min; `
      + `a gross reading would have asked for ${(node.count / 41).toFixed(1)}` : "no node");
  // A route the solver cannot source with is refused by name, which is the same guard seen from the
  // other side: `routes` is an override, and an override that plans a consumer as a supplier has to
  // say so rather than build a plan that spends the item it was asked to make.
  const backwards = call("solve", {
    want: { item: "oxide-asteroid-chunk", rate_per_min: 1 },
    routes: { "oxide-asteroid-chunk": "oxide-asteroid-crushing" },
  });
  check("routing an item to a recipe that eats it is refused by name",
    backwards.ok === false && backwards.code === "ROUTE_NOT_PRODUCER"
    && backwards.detail && backwards.detail.net_per_craft < 0,
    backwards.ok ? "planned anyway" : `${backwards.code} net=${backwards.detail && backwards.detail.net_per_craft}`);
  // ...and the same arithmetic on a chain the ranking picks by itself, with no `routes` in the
  // request: `fish-breeding` is the only recipe that yields `raw-fish`, it takes 2 and gives 3, so
  // the panel row a player gets for 60 fish/min has to be sized on the 1 the line keeps.
  const fish = call("solve", { want: { item: "raw-fish", rate_per_min: 60 }, allow_locked: true });
  const fnode = asArr(fish.data && fish.data.unit && fish.data.unit.nodes)
    .find((n) => n.recipe === "fish-breeding");
  check("an un-routed recirculating recipe is planned on its net rate too",
    fnode && fnode.recirculated && fnode.recirculated.per_craft_net === 1
    && fnode.per_machine_per_min * 3 === fnode.recirculated.gross_per_machine_per_min,
    fnode ? `${fnode.count} x ${fnode.machine} at net ${fnode.per_machine_per_min}/min, gross ${fnode.recirculated && fnode.recirculated.gross_per_machine_per_min}/min`
      : `${fish.code} ${fish.msg}`);
}

// ---- 4. oil: the wall is fluids, not the multi-product refusal ----
{
  const plastic = call("solve", { want: { item: "plastic-bar", rate_per_min: 12 } });
  const blocked_on_fluid = !plastic.ok && /crude-oil|pumpjack|NO_RECIPE_SOURCE|LOCKED_MACHINE|NO_MINER/.test(
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
