// One-off check that the new fluid-port rules actually fire, and that a correct fluid card passes
// them. Not a regression case -- the fluid suite is being written separately; this exists only to
// prove the rules are reachable rather than dead code that always agrees.
const { execFileSync } = require("child_process");
const call = (m, a) => JSON.parse(execFileSync(process.execPath, ["dev/call.js", m, JSON.stringify(a)], { encoding: "utf8", maxBuffer: 1 << 29 }).trim());
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));

const lua = (src) => execFileSync(process.execPath, ["dev/lua.js", src], { encoding: "utf8", maxBuffer: 1 << 29 });

// the availability gate in card_check is the force's real recipe state, so the probe has to
// research what it draws -- otherwise every fluid card dies on LOCKED_ENTITY first
const TECHS = ["oil-processing", "fluid-handling", "plastics", "advanced-oil-processing", "sulfur-processing", "electronics", "automation"];
const RECIPES = ["pumpjack", "storage-tank", "pipe", "oil-refinery", "chemical-plant", "plastics", "sulfur-processing", "boiler", "steam-engine"];

const card = (entities, ports, recipes) => ({ name: "fluid-probe", entities, ports, contract: { outputs: {} }, machine_recipes: recipes });
const e = (name, x, y, direction) => ({ name, position: { x, y }, direction });

// 1x1 things sit on tile centres (.5); 3x3 things sit on tile centres too, so every centre below
// is a .5 and the spacing comes from the footprint rather than from eyeballing
// a 3x3 centred at 2.5 covers cells 1..3, so the tile touching its east edge is cell 4 (centre
// 4.5) and a 3x3 tank beyond that column is centred at 6.5. The first version of this probe left
// a one-tile gap and "a correct card" failed the reachability rule -- which is the rule working.
const ring = [
  e("pumpjack", 2.5, 2.5, "north"),
  e("pipe", 4.5, 2.5), e("pipe", 4.5, 3.5), e("pipe", 4.5, 1.5),
  e("storage-tank", 6.5, 2.5),
];

const cases = [
  ["A correct fluid card (pump -> pipes -> tank, out port on the tank)",
    card(ring, { in: [], out: [{ fluid: "crude-oil", entity: 5 }] }), []],
  ["B the tank moved away (nothing reaches an output port)",
    card([ring[0], ring[1], ring[2], ring[3], e("storage-tank", 30.5, 30.5)],
      { in: [], out: [{ fluid: "crude-oil", entity: 5 }] }), []],
  ["C a fluid port on a transport belt (a belt has no fluid box)",
    card([e("pumpjack", 2.5, 2.5, "north"), e("transport-belt", 4.5, 2.5, "east"), e("pipe", 5.5, 2.5)],
      { in: [], out: [{ fluid: "crude-oil", entity: 2 }] }), []],
  ["D a belt pointing into a pipe (items cannot enter a pipe)",
    card([e("transport-belt", 2.5, 2.5, "east"), e("pipe", 3.5, 2.5), e("steel-chest", 4.5, 2.5)],
      { in: [{ item: "iron-plate", entity: 3 }], out: [] }), []],
  ["E an oil refinery fed by pipes, no inserter anywhere (must NOT ask for an arm)",
    // a 5x5 refinery centred at 6.5 covers cells 4..8, so the pipes that touch it sit at cells
    // 3.5 and 9.5, and the tank beyond the eastern pipe at 11.5
    card([e("oil-refinery", 6.5, 6.5, "north"), e("pipe", 3.5, 6.5), e("pipe", 9.5, 6.5),
          e("storage-tank", 1.5, 6.5), e("storage-tank", 11.5, 6.5)],
      { in: [{ fluid: "crude-oil", entity: 2 }],
        out: [{ fluid: "petroleum-gas", entity: 3 }] },
      { 1: "basic-oil-processing" }), []],
];

(async () => {
  lua(`local f=game.forces.player
for _,n in ipairs({${TECHS.map((t) => `"${t}"`).join(",")}}) do local r=f.technologies[n] if r then r.researched=true end end
-- researching by script leaves the unlocked recipes disabled on this save, and card_check's
-- availability gate reads the recipe, so grant both halves or the probe reports LOCKED_ENTITY
-- for reasons that have nothing to do with the rule under test
for _,n in ipairs({${RECIPES.map((x) => `"${x}"`).join(",")}}) do local r=f.recipes[n] if r then r.enabled=true end end
rcon.print("techs ok")`);
  for (const [title, c] of cases) {
    const r = call("card_check", { card: c });
    const data = r.data || r;
    console.log("\n" + title);
    if (!r.ok && !data.errors) { console.log("  call failed: " + (r.code || "?") + " " + (r.msg || "").slice(0, 140)); continue; }
    const errs = asArr(data.errors);
    console.log("  errors  : " + (errs.length ? errs.map((x) => x.code + (x.at ? "#" + x.at : "")).join(", ") : "none"));
    for (const x of errs.slice(0, 5)) console.log("      " + x.code + ": " + (x.msg || "").slice(0, 150));
    const ws = asArr(data.warnings);
    if (ws.length) console.log("  warnings: " + [...new Set(ws.map((x) => x.code))].join(", "));
  }
})();
