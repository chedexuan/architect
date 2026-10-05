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
// A suite writes to the world it is talking about. See dev/suite-guard.js for why that is a hard stop.
require("./suite-guard.js").guardMain("solve_e2e");

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
  // What must hold on ANY world: the smallest whole unit is more than what was asked, and the answer
  // says so (a candidate carrying a positive `over_by`) rather than presenting the overshoot as the
  // request. The old form pinned `> 600`, which was a claim about this save's recipe graph, not about
  // the arithmetic: with `casting-iron` in the graph the unit is 8 furnaces at 291.6/min, and the
  // number went red the moment another suite unlocked a recipe. Suite order should not be an input.
  check("exact rationals mean the indivisible unit can overshoot, and must admit it",
    !!pn && pr.data.unit.output_per_min > 60
    && asArr(pr.data.candidates).some((c) => (c.over_by || 0) > 0),
    pn ? `unit produces ${pr.data.unit.output_per_min}/min against a 60/min request; candidates `
      + `${asArr(pr.data.candidates).map((c) => `${c.label}:${(c.over_by || 0).toFixed(2)}`).join(" ")}` : "");
}

// ---- 6. the catalyst part of a product is exempt from the productivity bonus ----
{
  // The engine's own rule, read off the engine rather than remembered: a product carrying
  // `ignored_by_productivity` comes back at exactly the size it went in, so one craft puts
  // `(amount - ignored) * (1 + bonus) + ignored` on the belt. Multiplying the whole `amount` is the same
  // fallacy task #18 fixed on the NET yield, arriving from the other side -- through the two figures that
  // describe the machine's output rather than the line's gain (`gross_per_machine_per_min`, and the
  // co-product rate) -- and it shows up on only six (recipe, product) pairs in this install, none of which
  // any earlier suite asked about. That is the whole reason this section exists: the rule was right and
  // nobody had ever looked.
  //
  // Kovarex is the case the engine lets anybody build: a centrifuge has module slots, the recipe runs in
  // it, and it hands 40 of its own seed back out of 41. Slots are read through the SAME field name the mod
  // reads (`module_inventory_size`; 2.0 has no `module_spec` on an entity prototype, and a pcall over the
  // missing key answers nil -- which is how a first draft of this probe "measured" zero slots on every
  // machine in the game and nearly wrote the rule off as unreachable).
  const eng = (() => {
    // Printed as delimited lines rather than as JSON: 2.0's LuaGameScript has no `json_encode`, and every
    // other table this project reads off the engine is read the same way (see dev/recipe_table_e2e.js).
    const lines = String(lua(`local r = prototypes.recipe["kovarex-enrichment-process"]
local out = {}
for _, p in ipairs(r.products) do
  out[#out+1] = string.format("P|%s|%s|%s", p.name, tostring(p.amount),
    tostring(p.ignored_by_productivity or 0))
end
local ok, ae = pcall(function() return r.allowed_effects end)
local amax, pm = 0, 0
pcall(function() amax = r.maximum_productivity or 0 end)
pcall(function() pm = prototypes.item["productivity-module"].module_effects.productivity or 0 end)
out[#out+1] = string.format("A|%s|%s|%s|%s",
  tostring((not ok) or (ae == nil) or (ae.productivity ~= false)), amax, pm, tostring(r.category))
for name, m in pairs(prototypes.entity) do
  local cc, slots
  pcall(function() cc = m.crafting_categories end)
  pcall(function() slots = m.module_inventory_size end)
  local takes = false
  if cc then for c in pairs(cc) do if c == r.category then takes = true end end end
  if takes and slots and slots > 0 then
    out[#out+1] = string.format("M|%s|%s", name, tostring(slots))
  end
end
table.sort(out)
rcon.print(table.concat(out, "\\n"))`)).split(/\r?\n/).filter((l) => l.indexOf("|") > 0);
    const o = { products: [], machines: {}, allowed: false, max: 0, per_module: 0, category: "" };
    for (const l of lines) {
      const p = l.split("|");
      if (p[0] === "P") o.products.push({ item: p[1], amount: Number(p[2]), ignored: Number(p[3]) });
      else if (p[0] === "M") o.machines[p[1]] = Number(p[2]);
      else if (p[0] === "A") {
        o.allowed = p[1] === "true"; o.max = Number(p[2]) || 0;
        o.per_module = Number(p[3]) || 0; o.category = p[4] || "";
      }
    }
    return o;
  })();
  const prods = asArr(eng.products);
  const u235 = prods.find((p) => p.item === "uranium-235") || {};
  const u238 = prods.find((p) => p.item === "uranium-238") || {};
  const withSlots = Object.keys(eng.machines || {});
  check("a machine that runs this recipe has module slots, so the bonus can actually be fitted here",
    prods.length > 1 && (u235.ignored || 0) > 0 && eng.allowed === true && withSlots.length > 0,
    JSON.stringify([eng.allowed, eng.max, withSlots, prods]).slice(0, 280));

  const plan = call("solve", {
    want: { item: "uranium-235", rate_per_min: 1 },
    routes: { "uranium-235": "kovarex-enrichment-process" },
    modules: [{ item: "productivity-module", count: 4 }],
  });
  const node = asArr(plan.data && plan.data.unit && plan.data.unit.nodes)
    .find((n) => n.recipe === "kovarex-enrichment-process") || {};
  const rec = node.recirculated || {};
  // The bonus is derived from the machine the PLAN chose, not from a name this file remembers: which
  // centrifuge-tier the solver runs is this save's unlocked list, and a hardcoded 2 would be a second
  // opinion about the world rather than about the rule. `maximum_productivity` caps the ADDED part.
  const slots = (eng.machines || {})[node.machine] || 0;
  const fitted = Math.min(4, slots);
  const added = Math.min((eng.per_module || 0) * fitted, (eng.max || 0) > 0 ? eng.max : Infinity);
  const bonus = 1 + added;
  check("the bonus actually fitted, so the guard below is not being read on a plan with no bonus",
    plan.ok === true && !!node.modules && slots > 0 && fitted > 0
      // 1e-6, not 1e-9: the engine stores the per-module bonus as a float that is not exactly 0.04
      // (`tostring` prints 0.0399999...), while the solver rationals it to 0.08 -- and the two rules this
      // section separates differ by whole items per craft, not by a tenth of one.
      && Math.abs(node.modules.productivity - bonus) < 1e-6
      && node.modules.slots_used === fitted,
    JSON.stringify([plan.code, plan.msg, node.machine, slots, node.modules]).slice(0, 280));

  const expected_out = (u235.amount - u235.ignored) * bonus + u235.ignored;
  const naive_out = u235.amount * bonus;
  check("what one craft puts on the belt is (amount - catalyst) x bonus + catalyst, not amount x bonus",
    Math.abs((rec.per_craft_out || 0) - expected_out) < 1e-6
      // The check has to be able to tell the two rules apart, or it is a description of one of them.
      && Math.abs((rec.per_craft_out || 0) - naive_out) > 1e-6,
    JSON.stringify([rec.per_craft_in, rec.per_craft_out, expected_out, naive_out]).slice(0, 260));

  // `gross_per_machine_per_min` is the belt figure the panel quotes beside the net one ("每分搬运 X"), and
  // it is built from the SAME clock: crafts per minute times what each craft leaves. crafts/min is read
  // back out of the node (net per machine / net per craft) so this is an identity between the node's own
  // four numbers, not a second copy of the answer.
  const crafts = rec.per_craft_net ? node.per_machine_per_min / rec.per_craft_net : 0;
  const wrong_gross = naive_out * crafts;
  check("...and the gross belt figure counts the catalyst once, not once per bonus",
    Math.abs((rec.gross_per_machine_per_min || 0) - expected_out * crafts) < 1e-6
      && Math.abs((rec.gross_per_machine_per_min || 0) - wrong_gross) > 1e-6
      && Math.abs(rec.gross_per_machine_per_min * rec.per_craft_net
        - rec.per_craft_out * node.per_machine_per_min) < 1e-6,
    JSON.stringify([rec.gross_per_machine_per_min, expected_out * crafts, wrong_gross, crafts]).slice(0, 260));

  // The co-product is the sharper case: uranium-238 is 2 out of which 2 are the returning catalyst, so
  // the whole product is exempt and the bonus must not touch it AT ALL.
  const expected_bp = ((u238.amount || 0) - (u238.ignored || 0)) * bonus + (u238.ignored || 0);
  const bp = asArr(node.by_products).find((b) => b.item === "uranium-238") || {};
  // Read as a rate PER MACHINE: what a plan row prints is the unit's whole figure (`per_min`), and the
  // clock it has to agree with is the one the node itself reports.
  const bp_per_machine = bp.per_machine_per_min != null ? bp.per_machine_per_min
    : (bp.per_min || 0) / (node.count || 1);
  check("...and a co-product that is entirely catalyst gains nothing from the bonus",
    (u238.ignored || 0) === (u238.amount || 0) && (bp.per_min || bp.per_machine_per_min) > 0
      && Math.abs(bp_per_machine - expected_bp * crafts) < 1e-6
      && Math.abs(bp_per_machine - expected_bp * bonus * crafts) > 1e-6,
    JSON.stringify([u238, bp, bp_per_machine, expected_bp * crafts,
      expected_bp * bonus * crafts, crafts]).slice(0, 300));
  console.log(`  催化剂这一条：${JSON.stringify(prods.map((p) => `${p.item} ${p.amount}/${p.ignored}免`))}`
    + `，机器 ${node.machine} 槽位 ${slots}，加成 ${bonus.toFixed(4)}，`
    + `每台搬运 ${rec.gross_per_machine_per_min}/分（旧算法会说 ${wrong_gross.toFixed(2)}）`);
}

// ---- replicas are integers, and modules cost kW the plan pays for ----
{
  // A request that IS an exact number of indivisible units must not buy one more unit. The division was
  // done in floats and ceilinged: on this save the uranium-235 unit delivers 0.105/min, and 51 units of it
  // asked for at 5.355/min divided to 51.000000000000014, so the plan billed 52 replicas -- three extra
  // centrifuges, two extra drills, and an `over_by` saying the plan had over-produced when it had hit the
  // number exactly. Stated as a property (N units requested, N delivered) rather than as this save's
  // machine names, so a modpack answers the same question.
  const probe = call("solve", { want: { item: "uranium-235", rate_per_min: 1 } });
  const unit = probe.ok && probe.data.unit;
  const N = 51;
  if (unit) {
    const exact = unit.output_per_min * N;
    const ask = call("solve", { want: { item: "uranium-235", rate_per_min: exact } });
    const ceil = ask.ok && asArr(ask.data.candidates).find((c) => c.label === "ceil");
    const unitMachines = asArr(unit.nodes).reduce((s, n) => s + (n.count || 0), 0);
    const gotMachines = ceil ? asArr(ceil.nodes).reduce((s, n) => s + (n.count || 0), 0) : -1;
    check("an exact number of indivisible units buys exactly that many",
      !!ceil && ceil.replicas === N && (ceil.over_by || 0) < 1e-9
      && gotMachines === unitMachines * N && Math.abs(ceil.output_per_min - exact) < 1e-6,
      ceil ? `replicas ${ceil.replicas}, machines ${gotMachines} vs ${unitMachines * N}, over_by ${ceil.over_by}` : "");
  } else {
    check("an exact number of indivisible units buys exactly that many", false, `${probe.code} ${probe.msg}`);
  }
}
{
  // The same rounding, pushed up the scale where DOUBLES stop being integers. `rat` stores numerator and
  // denominator as Lua numbers, which are doubles: every whole number up to 2^53 (9,007,199,254,740,992)
  // is exact and the next one is a coin toss. That is not a guard that "never raises" -- there is no raise
  // in `rat` at all -- it is a storage fact, so what this pins is the boundary and the rule on the correct
  // side of it: `replicas = ceil(rate / unit)` computed in BigInt from the unit's own rational (the answer
  // prints it as `7/4000`), against what the solver reports, at three sizes spanning nine orders of
  // magnitude. A float division creeping back in shows up here as an off-by-one replica at 1e12/min --
  // the same bug the block above documents at 5.355/min, just wider.
  const probe = call("solve", { want: { item: "uranium-235", rate_per_min: 1 } });
  const unitRat = String(((probe.data || {}).unit || {}).output_per_sec || "");
  const mm = unitRat.match(/^(\d+)\/(\d+)$/);
  if (!mm) {
    check("the answer prints its unit as a rational this gate can check against", false,
      `output_per_sec = ${JSON.stringify(unitRat)}`);
  } else {
    // Per MINUTE the unit delivers 60 * num/den, and the mirror of the mod's own boundary conversion
    // (`floor(rate * 1e6 + 0.5) / 1e6`) makes the expected count a ceiling of two integers.
    const num = BigInt(mm[1]), den = BigInt(mm[2]);
    const bad = [];
    for (const rate of [1e6, 1e9, 1e12]) {
      const scaled = BigInt(Math.floor(rate * 1e6 + 0.5));
      const n = scaled * den;
      const d = 1000000n * 60n * num;
      const expected = (n + d - 1n) / d;
      const ask = call("solve", { want: { item: "uranium-235", rate_per_min: rate } });
      const ceil = asArr((ask.data || {}).candidates).find((c) => c.label === "ceil") || {};
      const got = BigInt(Math.round(Number(ceil.replicas) || -1));
      if (got !== expected) bad.push([rate, String(expected), String(ceil.replicas)]);
    }
    check("the replica count is the exact ceiling of rate/unit at 1e6, 1e9 and 1e12 per minute",
      bad.length === 0, JSON.stringify([unitRat, bad]).slice(0, 300));
    // And the boundary itself, SAID rather than asserted as a pass: at 1e15/min the count needs 9.5e15,
    // past 2^53, so the double cannot hold it. The honest sentence is "this is where exact integers end".
    const huge = call("solve", { want: { item: "uranium-235", rate_per_min: 1e15 } });
    const hceil = asArr((huge.data || {}).candidates).find((c) => c.label === "ceil") || {};
    const exactHuge = (1000000000000000000000n * den + (1000000n * 60n * num) - 1n) / (1000000n * 60n * num);
    const reported = BigInt(Math.round(Number(hceil.replicas) || 0));
    console.log(`  2^53 这一档：整数精确到 9007199254740992；1e15/分要 ${exactHuge} 份，答案报 ${reported}`
      + `（差 ${exactHuge - reported}），over_by ${hceil.over_by === undefined ? "没有报" : hceil.over_by}`);
  }
}
{
  // Efficiency modules change the DRAW and nothing else -- same speed, same yield, so the same machine
  // count -- which makes them the only clean way to ask "does the plan price the modules it planned?".
  // It did not: the projection renames `module_factors` to `modules` and the kW loop kept reading the old
  // name, so the factor resolved to nil and every plan with modules quoted bare-machine power. Two
  // efficiency modules in an electric furnace are 1 - 0.3 - 0.3 = 0.4 of the draw.
  lua(`local f=game.forces.player local t=f.technologies["efficiency-module"] if t then t.researched=true t.enabled=false end`);
  const req = { want: { item: "iron-plate", rate_per_min: 600 }, machines: { smelting: "electric-furnace" } };
  const bare = call("solve", req);
  const modd = call("solve", { ...req, modules: [{ item: "efficiency-module", count: 2 }] });
  const kwOf = (r) => r.ok && r.data.unit && r.data.unit.power && r.data.unit.power.machine_grid_kw;
  const countOf = (r) => asArr(r.ok && r.data.unit.nodes)
    .filter((n) => n.machine === "electric-furnace").reduce((s, n) => s + (n.count || 0), 0);
  // A BOUND, not a ratio, and the reason is in the plan itself: the row that digs the ore has no module
  // slots, so its draw is untouched by a bonus meant for the furnace -- 0.4 × total would be wrong. What
  // is exact is that the two must DIFFER: the kW loop used to read the factor off a field the projection
  // had already renamed, so `bare` and `modd` came back identical to the watt, and that equality is the
  // bug. The upper/lower bounds keep the direction honest (efficiency modules cut the draw, they cannot
  // double it, and they cannot leave it whole).
  check("the plan's grid kW carries the module consumption factor, not the bare machine's",
    bare.ok && modd.ok && countOf(bare) === countOf(modd) && kwOf(bare) > 0
    && kwOf(modd) < kwOf(bare) && kwOf(modd) > 0.4 * kwOf(bare),
    [bare, modd].map((r) => `${countOf(r)} furnaces at ${kwOf(r)} kW`).join(" vs "));
}

console.log(fails === 0 ? "\nall solver checks passed" : `\n${fails} check(s) failed`);
process.exit(fails ? 1 : 0);
