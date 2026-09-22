// Region layout has to route fluid, not only butt two cards together.
//
// Compose walks a pipe chain and seals only what it can prove is connected (dev/pipe_seam_probe.js
// pins that rule). This exercises the other half: the layout is allowed to PROPOSE a run of pipes
// as part of a placement, and a placement without a verified chain is rejected -- the same split
// the touching seam has always honoured, where region guesses geometry and compose decides.
//
// What is NOT claimed here: a layout case that needs a run to BEND around occupied ground. The
// three-consumer block below does need a straight run, and gets one -- the tank's free face became
// visible only once composition stopped erasing fluid anchors. Routing through a corner is
// deliberately not the layout's job -- the rig proposes a corridor and verifies what a hand laid
// (dev/seam_ask_e2e.js), because a bend through ground someone else built on is the part a rule
// gets wrong quietly. compose still verifies the chain either way, which is why the chain rule is
// pinned at that level (dev/pipe_seam_probe.js).
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
  // An anchor is, by compose's own definition, "a boundary that stopped being a port but is still a
  // real supply point". So external ports are a SUBSET of anchors, and a sealed consumer's inlet has
  // to show up as an anchor and nothing else. Fluid anchors used to be erased on composition, which
  // made the two lists trivially equal -- and, one level down, erased the tank's crude outlet the
  // moment one consumer was bolted to it, so no second consumer could ever be reached.
  const portsIn = asArr(d.ports && d.ports.in);
  const anchorsIn = asArr((d.card || {}).anchors).filter((a) => a.kind === "in");
  check("external ports are a subset of the anchors, and a sealed inlet is an anchor only",
    portsIn.every((p) => anchorsIn.some((a) => a.entity === p.entity && a.fluid === p.fluid))
    && anchorsIn.length > portsIn.length,
    `ports=${portsIn.length} anchors=${anchorsIn.length}`);
  // The run this suite used to call imaginary: the tank's north face is free ground, so pipes reach
  // the second consumer. The claim worth pinning is the one the layout actually makes -- every
  // consumer in the region is connected to the tank THROUGH PIPES, edge to edge with no gap -- plus
  // the cost of it: three pipes, no more, because the gap is three tiles and an invented or longer
  // route is the quiet wrong answer this suite exists to catch.
  check("every consumer is connected to the tank through a gapless pipe path",
    (() => {
      const HALF = { pipe: 0.5, "storage-tank": 1.5, pumpjack: 1.5, "oil-refinery": 2.5 };
      const ents = asArr((d.card || {}).entities);
      const box = (e) => ({ x0: e.position.x - HALF[e.name], x1: e.position.x + HALF[e.name],
                            y0: e.position.y - HALF[e.name], y1: e.position.y + HALF[e.name] });
      // edge to edge: zero gap on one axis, real overlap on the other
      const touch = (a, b) => {
        const A = box(a), B = box(b);
        const over = (lo1, hi1, lo2, hi2) => lo1 < hi2 && lo2 < hi1;
        return (Math.abs(Math.max(A.x0 - B.x1, B.x0 - A.x1)) < 1e-9 && over(A.y0, A.y1, B.y0, B.y1))
            || (Math.abs(Math.max(A.y0 - B.y1, B.y0 - A.y1)) < 1e-9 && over(A.x0, A.x1, B.x0, B.x1));
      };
      const pipes = ents.filter((e) => e.name === "pipe");
      const tank = ents.find((e) => e.name === "storage-tank");
      if (!tank || pipes.length !== 8) return false; // the three cards own 5 of them
      const seen = new Set(pipes.filter((p) => touch(tank, p)));
      for (let grew = true; grew;) {
        grew = false;
        for (const p of pipes) {
          if (seen.has(p)) continue;
          for (const q of seen) if (touch(p, q)) { seen.add(p); grew = true; break; }
        }
      }
      const refineries = ents.filter((e) => e.name === "oil-refinery");
      return refineries.length === 2
        && refineries.every((r) => pipes.some((p) => seen.has(p) && touch(p, r)));
    })(),
    `${pipesOf(d)} pipes: the 5 the three cards own, plus the 3 that close the second seam`);
}

console.log(fails === 0 ? "\nrouted seams behave" : `\n${fails} check(s) failed`);
process.exit(fails ? 1 : 0);
