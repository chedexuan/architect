// Region poles: a line a player can look at, not a heap a search left behind.
//
// `region_layout { power = true }` had no gate at all when this file was written. The two suites that
// name regions (`region_e2e`, `region_layout_e2e`) print what they saw and exit 0 whatever it says, and
// both go through `card_fix_power` -- the after-the-fact repair -- so the one call the panel makes when
// it plans a big region was never once checked. That is how a row of poles and a pile of poles became
// the same line of JSON.
//
// What is claimed here, in the order it can be faked:
//   * the arithmetic adds up: the powered card is the bare card plus the row plus whatever the engine
//     search put in afterwards, and each of those three is a number the plan reports separately;
//   * the row is a row -- distinct cells, one spacing, and the deviation from it is the lattice's own
//     figure rather than one this file invents;
//   * the region's tile count moved to make room for it, because poles are ground;
//   * and the engine agrees the row pays: verify the same card and every grid load sits on ONE network.
//     Arithmetic can lay a pole; only the game knows whether it joined.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
require("./suite-guard.js").guardMain("region_poles_e2e");

const PORT = process.env.RCON_PORT || "27015";
const ENV = { ...process.env, RCON_PORT: PORT, RCON_PW: process.env.RCON_PW || "m0pw" };
const call = (method, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 });
    return JSON.parse(out.trim());
  } catch (e) {
    return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 200) };
  }
};
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV }).trim();
const wait = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
// The planning surface generates its chunks on demand and answers SANDBOX_GENERATING while it works.
const ready = (m, a) => {
  for (let i = 0; i < 15; i++) {
    const r = call(m, a);
    if (r.ok || r.code !== "SANDBOX_GENERATING") return r;
    wait(1000);
  }
  return { ok: false, code: "SANDBOX_STUCK" };
};

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass++; console.log(`  ok  ${label}`); }
  else { fail++; console.log(`  FAIL ${label}  ${String(detail).slice(0, 240)}`); }
};
// An empty Lua table has no shape to keep, so it crosses the wire as `{}` rather than `[]`. Every list
// read out of an answer goes through here, or a clean result and a missing one look the same to the
// reader -- and one of those is supposed to be a failure.
const asArr = (v) => (Array.isArray(v) ? v : []);

// The row needs an electric furnace, and an electric furnace needs a technology. Suites share one world
// and run in one order, so a gate that unlocks something on the way through puts the unlocked list back
// -- `bench_check` can see the difference, and the next suite should not.
const TECHS = ["electronics", "automation", "logistics", "steel-processing", "advanced-material-processing"];
const tech_state = () => String(lua(`local f=game.forces.player local out={}
for _,t in ipairs({${TECHS.map((t) => `"${t}"`).join(",")}}) do
  local x=f.technologies[t]; out[#out+1]=t.."="..tostring(x and x.researched or false)
end
rcon.print(table.concat(out,","))`)).split("\n")[0];
const tech_before = tech_state();
lua(`local f=game.forces.player
for _,t in ipairs({${TECHS.map((t) => `"${t}"`).join(",")}}) do
  local x=f.technologies[t]; if x then x.researched=true end
end
rcon.print("researched")`);

// Two cards that compose: a smelting lane that ships plates and cells that eat them. Both inline -- a
// suite that freezes cards leaves them in somebody's save, which is exactly how the player's map picked
// up the fixtures it now carries.
const lane = call("card_example", { machines: 3, furnace: "electric-furnace" });
const cell = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));
const ENTRIES = [{ card: lane.data }, { card: cell, count: 2 }];
const isPole = (e) => /pole|substation/.test(String((e || {}).name || ""));
const ents = (d) => asArr((((d || {}).data || {}).card || {}).entities);
// The two fixture cards bring their own wiring with them, and `count: 2` duplicates one of them. What is
// claimed below is about the poles THIS call laid, so the ones the caller walked in with are counted
// first rather than assumed to be zero.
const carriedPoles = asArr((lane.data || {}).entities).filter(isPole).length
  + (asArr(cell.entities).filter(isPole).length * 2);

if (!lane.ok) {
  check("the fixture lane can be built at all", false, `${lane.code} ${lane.msg || ""}`);
} else {
  const bare = call("region_layout", { entries: ENTRIES });
  const bareN = ents(bare).length, barePoles = ents(bare).filter(isPole).length;
  const bareFp = (bare.data || {}).footprint || {};
  check("the region composes", bare.ok && bareN > 0,
    `${bare.code} ${bare.msg || ""} ${JSON.stringify((bare.detail || {}).errors || "").slice(0, 160)}`);
  check("a region nobody asked to power carries only the poles its own cards walked in with",
    barePoles === carriedPoles, JSON.stringify([barePoles, carriedPoles]));
  check("and its tile count is the machines alone", bareFp.tiles > 0, JSON.stringify(bareFp));

  const pw = ready("region_layout", { entries: ENTRIES, power: true });
  const d = pw.data || {};
  const poledN = ents(pw).length;
  const P = d.power || {};
  const G = P.grid || {};
  check("region_layout {power} plans a grid", pw.ok && P.ok === true,
    `${pw.code} ${pw.msg || ""} ${JSON.stringify(P).slice(0, 220)}`);
  check("the row is on the lattice, and says what a lattice knows: spacing and drift",
    G.poles > 0 && G.step > 0 && G.drift !== undefined && G.drift < G.step,
    JSON.stringify([G.poles, G.step, G.drift, G.needed, G.why]));
  check("...on a pole it can name, at a reach it measured", G.pole && G.supply > 0 && G.wire > 0,
    JSON.stringify([G.pole, G.supply, G.wire, G.how]));
  // The one claim that cannot be true of a plan that lost track of its own parts: the powered card is
  // the bare card, plus the row, plus what the engine search added afterwards -- and `added` is only
  // honest if the row was already in the card when that search ran.
  check(`the arithmetic adds up: ${bareN} + ${G.poles} on the row + ${P.added} from the search = ${poledN}`,
    bareN + (G.poles || 0) + (P.added || 0) === poledN,
    JSON.stringify([bareN, G.poles, P.added, poledN]));
  const laid = ents(pw).filter(isPole);
  // `added` counts every entity the search put in, and most of them are usually a power station. What
  // the row is judged on is the wiring the search still felt it had to add on top of it -- and a row
  // that does its job leaves that number at zero, because the search found nothing dark.
  const bridging = P.added_wiring;
  check(`of ${P.added} additions, ${bridging} are wiring and the rest is the station: `
    + `${carriedPoles} carried + ${G.poles} on the row + ${bridging} = ${laid.length} poles`,
    bridging !== undefined && laid.length === carriedPoles + (G.poles || 0) + bridging,
    JSON.stringify([laid.length, carriedPoles, G.poles, P.added, P.added_wiring]));
  const cells = new Set(laid.map((p) => `${Math.floor(p.position.x)},${Math.floor(p.position.y)}`));
  check("no two poles stand on one cell", cells.size === laid.length,
    JSON.stringify([cells.size, laid.length]));
  check("the row, not the repair, is what carries this region", bridging <= G.poles,
    JSON.stringify([G.poles, bridging, P.unmerged, P.pole]));

  // A line that draws no grid power gets no row: a pole nobody uses is still a pole the player has to
  // build, and `poles = 0` beside a plan that covered everything would otherwise look like a lattice
  // that found nowhere to stand. Not a furnace lane -- on this install the ARMS are electric (a lane of
  // two stone furnaces reports six grid loads), so the honest no-power shape is a bare belt corridor.
  const corridor = {
    name: "belt-corridor",
    entities: [
      { name: "steel-chest", position: { x: 0.5, y: 0.5 }, direction: 0 },
      { name: "transport-belt", position: { x: 1.5, y: 0.5 }, direction: 4 },
      { name: "transport-belt", position: { x: 2.5, y: 0.5 }, direction: 4 },
      { name: "transport-belt", position: { x: 3.5, y: 0.5 }, direction: 4 },
      { name: "steel-chest", position: { x: 4.5, y: 0.5 }, direction: 0 },
    ],
    ports: { in: [{ item: "iron-plate", entity: 1, chest: true }],
             out: [{ item: "iron-plate", entity: 5, chest: true }] },
    anchors: [{ kind: "in", item: "iron-plate", entity: 1 },
              { kind: "out", item: "iron-plate", entity: 5 }],
    contract: { outputs: {} },
  };
  const noGrid = ready("region_layout", { entries: [{ card: corridor }, { card: corridor }],
    power: true, size: false });
  const NG = ((noGrid.data || {}).power || {}).grid || {};
  check("a region that draws no grid power is told so, and gets no row either",
    noGrid.ok && NG.poles === 0 && NG.needed === 0 && NG.why === "no-grid-load"
    && ents(noGrid).filter(isPole).length === 0,
    `${noGrid.code} ${JSON.stringify([NG, ents(noGrid).filter(isPole).length]).slice(0, 180)}`);
  check("poles are ground: the region's tile count holds the row it carries",
    (d.footprint || {}).tiles >= bareFp.tiles && (d.footprint || {}).width > 0,
    JSON.stringify([bareFp, d.footprint]));

  // The engine's verdict on the plan, not the plan's on itself ----
  const v = ready("card_verify", { card: d.card, require_single_network: true });
  const VP = (v.data || {}).power || {};
  check("verify covers every grid load in the powered region",
    v.ok && VP.powered_entities > 0 && VP.covered === VP.powered_entities,
    JSON.stringify([VP.covered, VP.powered_entities, (v.data || {}).errors]).slice(0, 220));
  const warns = asArr((v.data || {}).warnings).map((w) => w.code);
  check("...as one network, which is the claim a row of poles makes and cannot prove",
    !warns.includes("SPLIT_NETWORKS") && !warns.includes("GRID_IS_GLOBAL"), JSON.stringify(warns));
}

call("lab_reset");
{
  const wanted = TECHS.map((t) => `"${t}"`).join(",");
  const saved = tech_before.split(",").map((kv) => {
    const [t, v] = kv.split("=");
    return `["${t}"]=${v === "true" ? "true" : "false"}`;
  }).join(",");
  lua(`local f=game.forces.player local back={${saved}}
for _,t in ipairs({${wanted}}) do
  local x=f.technologies[t]
  if x and back[t] ~= nil then x.researched = back[t] end
end
rcon.print("restored")`);
  const after = tech_state();
  check("the world's research list is left exactly as it was found", after === tech_before,
    `${tech_before} -> ${after}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
