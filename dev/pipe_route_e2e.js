// Region layout has to route fluid, not only butt two cards together.
//
// Compose walks a pipe chain and seals only what it can prove is connected (dev/pipe_seam_probe.js
// pins that rule). This exercises the other half: the layout is allowed to PROPOSE a run of pipes
// as part of a placement, and a placement without a verified chain is rejected -- the same split
// the touching seam has always honoured, where region guesses geometry and compose decides.
//
// What is NOT claimed here: no layout case in this suite yet *needs* a straight run, because a
// blocked first cell blocks every longer run along the same axis too. Routing that bends around a
// blocked cell is the next piece; compose already verifies bends, which is why the chain rule is
// pinned at that level (dev/pipe_seam_probe.js) rather than pretending the layout exercises it.
//
// Run after `bash dev/cycle.sh`; it grants its own oil techs because card_check reads recipes.
const { execFileSync } = require("child_process");
const path = require("path");

const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "ignore"] }).trim());
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8", maxBuffer: 1 << 29 });

lua(`local f=game.forces.player
for _,n in ipairs({"oil-processing","fluid-handling"}) do local t=f.technologies[n] if t then t.researched=true end end
for _,n in ipairs({"pumpjack","pipe","storage-tank","oil-refinery"}) do local r=f.recipes[n] if r then r.enabled=true end end
rcon.print("granted")`);

const source = () => ({
  name: "pump-card",
  entities: [
    { name: "pumpjack", position: { x: 2.5, y: 2.5 }, direction: 0 },
    { name: "pipe", position: { x: 4.5, y: 2.5 } },
    { name: "storage-tank", position: { x: 6.5, y: 2.5 } },
  ],
  ports: { in: [], out: [{ fluid: "crude-oil", entity: 3 }] }, contract: { outputs: {} },
});
const user = (tag) => ({
  name: "refine-" + tag,
  entities: [
    { name: "pipe", position: { x: 0.5, y: 2.5 } },
    { name: "oil-refinery", position: { x: 3.5, y: 2.5 }, direction: 0 },
    { name: "pipe", position: { x: 6.5, y: 2.5 } },
  ],
  ports: { in: [{ fluid: "crude-oil", entity: 1 }], out: [{ fluid: "petroleum-gas", entity: 3 }] },
  contract: { outputs: {} },
});

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) fails++;
};

// region_layout reports `entities` as a count and hands the card itself under `card`
const pipesOf = (payload) => asArr((payload.card || {}).entities).filter((e) => e.name === "pipe").length;

// ---- one consumer: touching still wins, and no pipe is invented ----
{
  const r = call("region_layout", { entries: [{ card: source() }, { card: user("a") }] });
  const d = r.data || {};
  const p = asArr(d.placements)[1] || {};
  check("a touching seam is preferred over any pipe run",
    r.ok && p.fused === "crude-oil" && !p.pipes,
    `${p.fused} pipes=${p.pipes}`);
  check("the closed seam leaves only the product at the boundary",
    asArr(d.ports && d.ports.in).length === 0
    && asArr(d.ports && d.ports.out).map((x) => x.fluid).join(",") === "petroleum-gas",
    JSON.stringify(d.ports));
  check("the composed card invented no pipes",
    pipesOf(d) === 3, `${pipesOf(d)} pipe entities (2 belong to the refinery card, 1 to the pump card)`);
}

// ---- two consumers on one buffer: the second cannot be reached without standing on the first ----
// Every straight run from the tank's border starts in a cell the first refinery already owns, so
// the honest answer is "this consumer still needs crude from outside" -- and the boundary has to
// survive to say so. Before this ran, the merged card exported two petroleum-gas boundaries and
// admitted no crude input at all, because internalisation was keyed per fluid rather than per
// entity: one sealed consumer marked the fluid internal for everyone.
{
  const r = call("region_layout", { entries: [{ card: source() }, { card: user("a") }, { card: user("b") }] });
  const d = r.data || {};
  const places = asArr(d.placements);
  console.log("     placements:", JSON.stringify(places.map((p) => ({ ref: p.ref, at: p.at, fused: p.fused, pipes: p.pipes, packed: !!p.packed }))));
  console.log("     ports:", JSON.stringify(d.ports), " anchors:", JSON.stringify(asArr((d.card || {}).anchors)));

  check("the reached consumer's seam is closed", asArr(d.ports && d.ports.in).length === 1
    && asArr((d.card || {}).report || {}).length === 0, JSON.stringify(d.ports));
  check("an unreached consumer keeps its own crude-oil boundary",
    asArr(d.ports && d.ports.in).some((x) => x.fluid === "crude-oil"),
    JSON.stringify(asArr(d.ports && d.ports.in)));
  check("ports and anchors tell the same story",
    asArr(d.ports && d.ports.in).length === asArr((d.card || {}).anchors).filter((a) => a.kind === "in").length,
    `ports=${asArr(d.ports && d.ports.in).length} anchors=${asArr((d.card || {}).anchors).filter((a) => a.kind === "in").length}`);
  // every straight run from the tank's border starts in a cell the first refinery already owns,
  // so a route exists only in the search's imagination here: nothing may be added to the card
  check("no pipe was invented for a run that does not fit",
    pipesOf(d) === 5, `${pipesOf(d)} pipes = the 5 the three cards own, none added`);
}

console.log(fails === 0 ? "\nrouted seams behave" : `\n${fails} check(s) failed`);
process.exit(fails ? 1 : 0);
