// The fluid seam, end to end, with the numbers this path was built to produce.
//
// Run after `node dev/cycle.sh && node dev/oilfield.js`. Requires the oil techs, which it grants
// itself: researching by script leaves the unlocked recipes disabled, and card_check's availability
// gate reads the recipe.
//
// What it establishes, in order:
//   - two cards that each carry `fluid` ports lint clean;
//   - card_compose at the touching offset reports the seam
//         seams = [{ fluid: "crude-oil", from: "storage-tank(slot 1#3)", into: "pipe(slot 2#1)" }]
//     and the merged card then exports only petroleum-gas -- a closed seam is not a boundary;
//   - region_layout derives the same offset itself (at x:7,y:-1) and reports fused: "crude-oil";
//   - the same two cards one tile apart seal nothing: both crude-oil ports stay open, and lint
//     stays silent, because two sound networks that do not meet are a design gap, not a broken
//     card. That case is what a pipe router has to close.
const { execFileSync } = require("child_process");
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const lua = (src) => execFileSync(process.execPath, ["dev/lua.js", src], { encoding: "utf8", maxBuffer: 1 << 29 });
const call = (m, a) => JSON.parse(execFileSync(process.execPath, ["dev/call.js", m, JSON.stringify(a || {})], { encoding: "utf8", maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "ignore"] }).trim());

lua(`local f=game.forces.player
for _,n in ipairs({"oil-processing","fluid-handling"}) do local t=f.technologies[n] if t then t.researched=true end end
for _,n in ipairs({"pumpjack","pipe","storage-tank","oil-refinery"}) do local r=f.recipes[n] if r then r.enabled=true end end
rcon.print("granted")`);

const source = { name: "pump-card", entities: [
    { name: "pumpjack", position: { x: 2.5, y: 2.5 }, direction: 0 },
    { name: "pipe", position: { x: 4.5, y: 2.5 } },
    { name: "storage-tank", position: { x: 6.5, y: 2.5 } }],
  ports: { in: [], out: [{ fluid: "crude-oil", entity: 3 }] }, contract: { outputs: {} } };
const user = { name: "refine-card", entities: [
    { name: "pipe", position: { x: 0.5, y: 2.5 } },
    { name: "oil-refinery", position: { x: 3.5, y: 2.5 }, direction: 0 },
    { name: "pipe", position: { x: 6.5, y: 2.5 } }],
  ports: { in: [{ fluid: "crude-oil", entity: 1 }], out: [{ fluid: "petroleum-gas", entity: 3 }] }, contract: { outputs: {} } };

const chk = (t, c) => { const r = call("card_check", { card: c }); const e = asArr((r.data || r).errors || []); console.log(t, JSON.stringify(e.map((x) => x.code))); };
chk("source         ", source);
chk("user           ", user);

const cmp = call("card_compose", { slots: [{ card: source, at: { x: 0, y: 0 } }, { card: user, at: { x: 8, y: 0 } }] });
const C = cmp.data || cmp;
console.log("compose seams:", JSON.stringify(asArr((C.report || {}).seams || [])));
console.log("compose ports:", JSON.stringify({ in: asArr(C.ports && C.ports.in), out: asArr(C.ports && C.ports.out) }), "internal_fluids:", JSON.stringify(asArr(C.internal_fluids || [])));
chk("merged lint    ", { name: "m", entities: C.entities, ports: C.ports, anchors: C.anchors, contract: { outputs: {} }, machine_recipes: C.machine_recipes });

const lay = call("region_layout", { entries: [{ card: source }, { card: user }] });
const L = lay.data || lay;
if (!lay.ok && lay.code) console.log("layout failed:", lay.code, JSON.stringify(lay.detail || lay.msg).slice(0, 160));
else {
  console.log("layout place :", JSON.stringify(asArr(L.placements).map((p) => ({ fused: p.fused, sealed: p.sealed, at: p.at }))));
  console.log("layout ports :", JSON.stringify({ in: asArr(L.ports && L.ports.in), out: asArr(L.ports && L.ports.out) }));
  console.log("layout lint  :", JSON.stringify(asArr(((L.lint || {}).errors) || []).map((e) => e.code)));
}

// the negative: the same two cards, but the seam is forced one tile apart. A gap must not be
// accepted as connected, and the reason has to name the offset that failed.
const gap = call("card_compose", { slots: [{ card: source, at: { x: 0, y: 0 } }, { card: user, at: { x: 9, y: 0 } }] });
const G = gap.data || gap;
if (gap.ok === false && !G.ports) console.log("gap compose  : refused", gap.code);
else console.log("gap seams    :", JSON.stringify(asArr((G.report || {}).seams || [])), "ports.out:", JSON.stringify(asArr(G.ports && G.ports.out)));
const gl = call("card_check", { card: { name: "g", entities: G.entities, ports: G.ports, anchors: G.anchors, contract: { outputs: {} } } });
console.log("gap lint     :", JSON.stringify(asArr((gl.data || gl).errors || []).map((e) => e.code)));
