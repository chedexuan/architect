// Does a pipe chain really close a fluid seam, and does a broken one really not?
//
// Compose is the only thing allowed to decide that two machines are connected, so this exercises
// it directly with hand-made cards: the geometry is the claim under test, not a layout that
// happened to produce one. Positions are half-tile centres the way Factorio places them -- a 3x3
// tank at (0.5,0.5) covers cells -0.5, 0.5, 1.5, its right border is x=2, so the first pipe that
// can touch it sits at 2.5.
const { execFileSync } = require("child_process");
const path = require("path");

const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 28 }).trim());

const tank = (x, y, kind) => ({
  name: `tank@${x},${y}`,
  entities: [{ name: "storage-tank", position: { x, y } }],
  ports: kind === "out"
    ? { in: [], out: [{ fluid: "crude-oil", entity: 1 }] }
    : { in: [{ fluid: "crude-oil", entity: 1 }], out: [] },
});
const pipes = (list) => ({
  name: "pipes",
  entities: list.map((p) => ({ name: "pipe", position: { x: p[0], y: p[1] } })),
  ports: { in: [], out: [] },
});

let fails = 0;
const run = (label, slots, expect) => {
  // a slot names either a frozen card or an inline one; the inline form has to be under `card`,
  // otherwise the resolver looks the card's own name up in the frozen store and rejects it
  const r = call("card_compose", { slots: slots.map((s) => ({ card: s })) });
  if (!r.ok) {
    console.log(`FAIL  ${label}: ${r.code} ${r.msg} ${JSON.stringify(r.detail || "").slice(0, 200)}`);
    fails++;
    return;
  }
  const seams = (r.data.report || {}).seams || [];
  const seam = seams[0];
  const got = seam ? { fluid: seam.fluid, via_pipes: seam.via_pipes || 0 } : null;
  const ok = expect === null ? got === null
    : !!got && got.fluid === expect.fluid && got.via_pipes === expect.via_pipes;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  console.log(`        seams=${JSON.stringify(seams)} ports=${JSON.stringify(r.data.ports)}`
    + ` lint=${((r.data.lint || {}).errors || []).map((e) => e.code).join(",") || "clean"}`);
  if (!ok) fails++;
};

run("tanks sharing an edge seal with no pipes",
  [tank(0.5, 0.5, "out"), tank(3.5, 0.5, "in")],
  { fluid: "crude-oil", via_pipes: 0 });

run("one pipe between them seals",
  [tank(0.5, 0.5, "out"), tank(4.5, 0.5, "in"), pipes([[2.5, 0.5]])],
  { fluid: "crude-oil", via_pipes: 1 });

run("a two-pipe run seals",
  [tank(0.5, 0.5, "out"), tank(5.5, 0.5, "in"), pipes([[2.5, 0.5], [3.5, 0.5]])],
  { fluid: "crude-oil", via_pipes: 2 });

// the same gap with the far tank moved out of reach of the run: a claim of connection is not one
run("a broken chain seals nothing",
  [tank(0.5, 0.5, "out"), tank(5.5, 0.5, "in"), pipes([[2.5, 0.5]])],
  null);

run("an L-shaped chain seals",
  [tank(0.5, 0.5, "out"), tank(5.5, -3.5, "in"),
   pipes([[2.5, 0.5], [3.5, 0.5], [3.5, -0.5], [3.5, -1.5], [4.5, -1.5]])],
  { fluid: "crude-oil", via_pipes: 5 });

// a pipe one cell clear of a machine carries nothing to it -- the pump rig learned that by
// measurement, and the same rule has to hold here or a hole in the middle would seal by accident
run("a chain with a gap in it seals nothing",
  [tank(0.5, 0.5, "out"), tank(9.5, 0.5, "in"),
   pipes([[2.5, 0.5], [3.5, 0.5], [6.5, 0.5], [7.5, 0.5]])],
  null);

console.log(fails === 0 ? "\nthe pipe-chain rule holds in both directions" : `\n${fails} check(s) failed`);
process.exit(fails ? 1 : 0);
