// Laying a controller is not one act, it is two, and this suite is the proof of the second one.
//
// A card may name a wire (`wires = { {from, to, color} }`), and `card_place` draws it -- measured in
// dev/circuit_rules_probe.js act E: `connect_to` between two GHOST connectors succeeds and the connector
// counts the wire, so the player's preview arrives with the circuit already drawn. Act K then measured
// the part that undoes the trick: those wires are GONE once the ghosts are built, because a ghost is
// discarded and a new entity arrives in its place, and the connection went with the ghost. Every
// connector on the real machine reads zero.
//
// So the promise this mod makes -- "this line is signal-controlled" -- can only be kept by redrawing
// after the build, from a ledger keyed by the CELL (a build changes the unit number; the cell is the one
// name the ghost and the entity share). Four things are asserted here and none of them is decoration:
//
//   1. a card with a combinator and a wire freezes, lints and verifies -- the schema is accepted by
//      every gate a normal card goes through, not a special path;
//   2. placing it as ghosts draws the wire ONCE, and the answer says so, with the job it registered;
//   3. building the pair out from under the mod -- the way a player's hand or a construction robot
//      would -- leaves a real machine with a real network, because the build event reached the ledger;
//      and the same is proven again through `card_wire`, which is the same code with a player asking
//      instead of the engine telling;
//   4. the wire carries what it was strung for: a recipe signal on the controller becomes the machine's
//      recipe, with no client anywhere in the loop.
//
// Plus the two refusals worth having in a gate: a wire that points at an entity the card does not have
// is named before anything is placed, and a card with no wires says nothing at all about wiring rather
// than reporting a job that was never needed.
//
// Cleanup is by the deployment the mod recorded (`place_undo`) and then `card_forget`, and the bench is
// checked before and after like every other suite: this file revives entities on nauvis, which is the
// one kind of write a mis-tidy run would leave in a world other suites read.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("circuit_wire_e2e");

const PORT = process.env.RCON_PORT || "27015";
const call = (method, args) => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
    { encoding: "utf8", env: { ...process.env, RAW: "1" } });
  return JSON.parse(out.trim());
};
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: { ...process.env } }).trim();
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

const fails = [];
const check = (name, ok, detail) => {
  console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " :: " + String(detail).slice(0, 300)));
  if (!ok) fails.push(name);
};

// A combinator is gated behind `circuit-network` and an assembler-2 behind automation, and `card_freeze`
// lints against what the force can actually build -- so this suite's first act is research, and its last
// is putting that research back. Nothing else on this save should learn that a combinator exists because
// a wiring test needed one: every technology touched here is recorded as it was found and restored in
// `finish` below, including the ones that were already on (which must stay on).
const NEEDS = ["automation", "automation-2", "electronics", "circuit-network", "logistics", "logistics-2",
  "steel-processing"];
const wasResearched = lua(`local f=game.forces.player
local out={}
for _,t in ipairs{${NEEDS.map((n) => `"${n}"`).join(",")}} do
  local x=f.technologies[t]
  out[#out+1]=t.."="..(x and tostring(x.researched) or "absent")
end
rcon.print(table.concat(out," "))`);
console.log("research before:", wasResearched);
check("the technologies this suite needs exist in the save", !/absent/.test(wasResearched), wasResearched);
lua(`local f=game.forces.player
for _,t in ipairs{${NEEDS.map((n) => `"${n}"`).join(",")}} do
  local x=f.technologies[t]; if x then x.researched=true end
end
rcon.print("on")`);

// What a suite leaves behind is part of what it tests, so both exits run the same restore.
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  lua(`local f=game.forces.player
  local want={${wasResearched.split(" ").filter(Boolean).map((pair) => {
    const [k, v] = pair.split("=");
    return v === "true" ? `[${JSON.stringify(k)}]=true` : "";
  }).filter((s) => s).join(",")}}
  for _,t in ipairs{${NEEDS.map((n) => `"${n}"`).join(",")}} do
    local x=f.technologies[t]
    if x and not want[t] then x.researched=false end
  end
  rcon.print("restored")`);
  console.log(fails.length ? "FAILURES: " + fails.join(", ") : "all checks passed");
  process.exit(code || (fails.length ? 1 : 0));
};


// A controller and the machine it drives, one tile row apart, on a card with no chests and no belts:
// every part of this card exists to be wired, and nothing else can get in the way of the assertion.
// The positions are the engine's own alignment rules -- `card.lint` refuses a part whose centre is
// off-grid for its footprint, and a decider combinator is 1x2 on this build (measured, act J).
const CTRL_CARD = {
  name: "wired-lane-e2e",
  entities: [
    // The two halves of a controller pair, each carrying its own intent: this machine obeys a wire, and
    // this decider is the thing that speaks on it. Nothing about either is written by this suite -- the
    // claim under test is that a plan states its circuit and the mod applies it when the entities exist.
    { name: "assembling-machine-2", position: { x: 2.5, y: 2.5 }, direction: 0,
      circuit: { recipe_control: true } },
    { name: "decider-combinator", position: { x: 6.5, y: 3 }, direction: 0,
      circuit: { emitter: [{ type: "recipe", name: "copper-cable" }] } },
    // A combinator with no electricity transmits nothing -- measured, in the act where a selector's
    // output came back empty until the grid source was added -- so the card carries its own pole, and
    // sits between its two parts' cells. This is also the fact the panel has to say about a controller
    // lane: it is an electrical consumer of the layout, not a sticker on the machine.
    { name: "small-electric-pole", position: { x: 4.5, y: 5.5 }, direction: 0 },
  ],
  ports: {}, contract: { outputs: {} },
  wires: [{ from: 2, to: 1, color: "green" }],
};

const open0 = (call("card_wire", {}).data || {}).jobs_open;
console.log("open wiring jobs before:", open0);

// `card_verify` answers a card that does not lint with a refusal whose `detail.errors` are the lint
// errors, and with `data.errors` when it does -- one helper reading both, so a check cannot pass by
// looking in the wrong place and finding nothing.
const asList = (v) => (Array.isArray(v) ? v : []);
// A card that does not lint comes back as a refusal whose errors sit in `detail`; one that does comes
// back as data with `errors` empty -- and an empty Lua table arrives over JSON as `{}`, not `[]`, which
// is not something to call `.map` on. Both shapes, and neither trusted.
const verifyErrors = (r) => {
  const src = (r.data && r.data.errors) || (r.detail && r.detail.errors) || [];
  return asList(src).map((e) => e.code || String(e));
};

const fz = call("card_freeze", { card: CTRL_CARD, allow_unmeasured: true });
check("a card whose parts carry circuit intents freezes", fz.ok,
  fz.ok ? fz.data.name : fz.code + " " + JSON.stringify(verifyErrors(fz).slice(0, 4)));
if (!fz.ok) { console.log("STOP: nothing downstream can be proven without the card"); finish(1); }

const vf = call("card_verify", { card: CTRL_CARD });
check("and passes lint and verify with its wire", vf.ok && verifyErrors(vf).length === 0,
  JSON.stringify(verifyErrors(vf).slice(0, 3)) + " ok=" + vf.ok);
// The verifier already knows the thing a controller costs: it draws power and the card has none of its
// own. Asserted rather than assumed because it is the fact the next style has to plan around -- a lane
// that lays a combinator is a lane that needs a pole, and `NEEDS_EXTERNAL_GRID` is where that is said.
const warns = asList((vf.data || {}).warnings).map((e) => e.code);
const vpower = (vf.data || {}).power || {};
// Which of the two words the verifier uses depends on whether the sandbox happens to have a grid
// nearby; that the card supplies NONE of its own power does not. Asserted on the number, with the
// warning named as the sentence the player reads.
check("and says out loud that a controller needs the grid",
  (vpower.in_card_supply_kw || 0) === 0 && (vpower.demand_kw || 0) > 0
    && (warns.indexOf("NEEDS_EXTERNAL_GRID") >= 0 || warns.indexOf("GRID_WITHOUT_SUPPLY") >= 0),
  JSON.stringify(warns) + " power=" + JSON.stringify(vpower));

const bad = call("card_verify", { card: Object.assign({}, CTRL_CARD, {
  name: "bad-wire-e2e", wires: [{ from: 9, to: 1, color: "green" }] }) });
const badCodes = verifyErrors(bad);
check("a wire pointing outside the card is named", !bad.ok && badCodes.indexOf("WIRE_UNKNOWN_ENTITY") >= 0,
  "code=" + String(bad.code) + " errors=" + JSON.stringify(badCodes.slice(0, 4)));

const self = call("card_verify", { card: Object.assign({}, CTRL_CARD, {
  name: "self-wire-e2e", wires: [{ from: 1, to: 1, color: "green" }] }) });
check("and so is a machine wired to itself", !self.ok && verifyErrors(self).indexOf("WIRE_SELF") >= 0,
  "code=" + String(self.code) + " errors=" + JSON.stringify(verifyErrors(self).slice(0, 4)));

// The circuit vocabulary, refused by name. Each of these is one hand-written card away, so each is
// asserted rather than listed: a shape the mod cannot apply is caught before a player pays for a
// placement, and the code says which part of the intent was wrong.
const circuitCases = [
  ["an intent that is not one of the four", { circuit: { glow: true } }, "CIRCUIT_UNKNOWN_KIND"],
  ["an emitter that names nothing", { circuit: { emitter: [] } }, "CIRCUIT_EMITTER_EMPTY"],
  ["a selector with no position to take", { circuit: { select: { max: true } } }, "CIRCUIT_SELECT_INDEX"],
  ["a rotation without an interval", { circuit: { rotate: "often" } }, "CIRCUIT_ROTATE_TICKS"],
  ["one entity on both ends of the wire at once",
    { circuit: { emitter: [{ type: "recipe", name: "copper-cable" }], recipe_control: true } },
    "CIRCUIT_BOTH_SIDES"],
];
for (const [label, patch, code] of circuitCases) {
  const bad = call("card_verify", { card: Object.assign({}, CTRL_CARD, {
    name: "circuit-bad-e2e",
    entities: CTRL_CARD.entities.map((e, i) => (i === 1 ? Object.assign({}, e, patch) : e)),
  }) });
  check(`a card with ${label} is refused`,
    !bad.ok && verifyErrors(bad).indexOf(code) >= 0, `${bad.code} ${JSON.stringify(verifyErrors(bad).slice(0, 3))}`);
}

const pl = call("card_place", { name: "wired-lane-e2e", surface: "nauvis" });
const pd = pl.data || {};
check("placed as ghosts", pl.ok && pd.ghosts === 3, pl.ok ? pd.ghosts + " ghosts at " + JSON.stringify(pd.origin) : pl.code);
const w = pd.wires || {};
check("the preview wire was drawn once", w.drawn === 1, JSON.stringify(w));
check("and the answer says it still has to be drawn again", w.redraw_pending === true && !!w.job,
  "job=" + String(w.job) + " note=" + String(w.note));

const origin = pd.origin || { x: 0, y: 0 };
const surf = pd.surface || "nauvis";
console.log("placed on surface:", surf, "-- a placement that names no surface lands on the player's main one");
const area = `{{${origin.x - 1},${origin.y - 1}},{${origin.x + 9},${origin.y + 6}}}`;

// The ghosts, read straight off the engine: the wire is there, and it is a ghost wire.
const ghostRead = lua(`local s=game.surfaces["${surf}"]
local W=defines.wire_connector_id
local out={}
for _,e in ipairs(s.find_entities_filtered{area=${area},type="entity-ghost"}) do
  for _,c in ipairs(e.get_wire_connectors(true)) do
    if c.connection_count > 0 then
      out[#out+1]=tostring(e.ghost_name).."#"..tostring(c.wire_connector_id).."{n="..tostring(c.connection_count)
        ..",real="..tostring(c.real_connection_count)..",ghost="..tostring(c.is_ghost).."}"
    end
  end
end
rcon.print("ghosts="..#s.find_entities_filtered{area=${area},type="entity-ghost"}.." wired="..table.concat(out," "))`);
console.log("ghost side:", ghostRead);
check("the wire hangs off the ghosts and is counted as a ghost wire",
  /wired=.*"?\{n=1,real=0,ghost=true/.test(ghostRead.replace(/"/g, "")) || /n=1,real=0,ghost=true/.test(ghostRead),
  ghostRead);

// Build the pair the way a player does, out from under this mod, and let the build event do the rest.
// This is the whole reason the ledger exists: after this, the mod has drawn nothing and the wire is
// still expected to be there.
//
// Everything this creates is remembered by handle in `_G.WW` and destroyed by handle at the end. A
// name-and-rectangle sweep is how another probe here once destroyed 277 entities belonging to someone
// else's rig, and "it was in the area" is not a claim this suite needs to make.
const revived = lua(`local s=game.surfaces["${surf}"]
_G.WW = {}
local n=0
for _,g in ipairs(s.find_entities_filtered{area=${area},type="entity-ghost"}) do
  local ok,e=pcall(function() return g.silent_revive{raise_revive=true} end)
  if ok and e then n=n+1; _G.WW[#_G.WW+1]={ent=e, name=e.name, at=e.position}
  else rcon.print("revive failed: "..tostring(e)) end
end
rcon.print("revived="..n)`);
console.log("built:", revived);
check("every ghost was built by the engine, not by this mod", /revived=3/.test(revived), revived);
sleep(2500);

const live = lua(`local s=game.surfaces["${surf}"]
local W=defines.wire_connector_id
local m=(s.find_entities_filtered{area=${area},type="assembling-machine"})[1]
if not m then rcon.print("NO MACHINE") return end
local cs={}
for _,c in ipairs(m.get_wire_connectors(true)) do
  cs[#cs+1]=tostring(c.wire_connector_id).."{n="..tostring(c.connection_count)..",real="..tostring(c.real_connection_count).."}"
end
local n=m.get_circuit_network(W.circuit_green)
rcon.print("machine connectors="..table.concat(cs," ").." network="..tostring(n~=nil))`);
// A combinator with no electricity says nothing: measured in dev/circuit_rules_probe.js, where the
// same selector's output read empty until a supply existed on the grid. The card's own pole wires the
// pair into a network; this is what puts a generation in it. Deliberately NOT part of the card -- the
// subject here is the wire, and a fixture that also changes the shape under test proves the wrong thing.
const supply = lua(`local s=game.surfaces["${surf}"]
local e = s.create_entity{name="electric-energy-interface", position={x=${origin.x + 0.5}, y=${origin.y + 5.5}}, force="player"}
if not e then rcon.print("no supply") return end
_G.WW[#_G.WW+1]={ent=e, name=e.name, at=e.position}
local m=(s.find_entities_filtered{area=${area},type="assembling-machine"})[1]
rcon.print("supply="..tostring(e.electric_network_id).." machine="..tostring(m and m.electric_network_id))`);
console.log("grid:", supply);
check("the machine and the supply are on one network", /^supply=(\d+) machine=\1$/.test(supply.replace("OK", "").trim()), supply);
sleep(1500);
console.log("real side:", live);
check("and the built machine still holds the wire", /network=true/.test(live) && /real=[1-9]/.test(live), live);

// What the wire was for, with nothing written by this suite: the emitter's signal has to reach the
// machine and become its recipe, because the CARD said so and the mod configured both entities when
// they arrived. Act L is the reason this cannot be proven any earlier -- a `parameters` write taken by
// a ghost is gone from the entity that replaces it -- so "the plan is signal-controlled" is only ever a
// statement about what happens after the build.
sleep(3000);
const driven = lua(`local s=game.surfaces["${surf}"]
local m=(s.find_entities_filtered{area=${area},type="assembling-machine"})[1]
local d=(s.find_entities_filtered{area=${area},name="decider-combinator"})[1]
if not (m and d) then rcon.print("missing") return end
local p = (function() local ok,v=pcall(function() return d.get_or_create_control_behavior().parameters end) return ok and v end)()
local n=m.get_circuit_network(defines.wire_connector_id.circuit_green)
local sig={}
if n and n.signals then for _,q in ipairs(n.signals) do
  local g=q[1] or q.signal sig[#sig+1]=tostring(g and g.name).."="..tostring(q[2] or q.count) end end
rcon.print("emitter first_output=" .. tostring(p and p.outputs and ((p.outputs[1] or {}).signal or {}).name)
  .. " recipe_control=" .. tostring((function() local ok,v=pcall(function() return m.get_or_create_control_behavior().circuit_set_recipe end) return ok and v end)())
  .. " wire=["..table.concat(sig,",").."] recipe="..tostring((m.get_recipe() or {}).name))`);
console.log("driven:", driven);
check("the plan's own emitter was configured on the built controller",
  /emitter first_output=copper-cable/.test(driven), driven);
check("the machine was left obedient to the wire, not to a hand-set recipe",
  /recipe_control=true/.test(driven), driven);
check("and the recipe it runs is the one the card named",
  /wire=\[copper-cable=1\] recipe=copper-cable/.test(driven), driven);

// A placement built by the mod itself has no build to wait for, so it configures as it goes. Same two
// entities, one assertion: the answer says what it wrote, and the engine agrees.
const real = call("card_place", { name: "wired-lane-e2e", surface: "nauvis", ghosts: false });
const rd = real.data || {};
check("a placement of real entities reports what it configured",
  real.ok && ((rd.wires || {}).circuit || {}).written === 2,
  JSON.stringify({ built: rd.built, circuit: (rd.wires || {}).circuit, code: real.code }));
sleep(3000);
const o3 = rd.origin || { x: 0, y: 0 };
const area3 = `{{${o3.x - 1},${o3.y - 1}},{${o3.x + 9},${o3.y + 6}}}`;
const running = lua(`local s=game.surfaces["${surf}"]
local m=(s.find_entities_filtered{area=${area3},type="assembling-machine"})[1]
rcon.print("recipe="..tostring(m and (m.get_recipe() or {}).name))`);
check("and that machine is running the card's recipe", /recipe=copper-cable/.test(running), running);
const undo3 = call("place_undo", { count: 1 });
check("the real placement is taken back as cleanly as a ghosted one", undo3.ok, undo3.code);

// `card_wire` is the same redraw with a player asking, and it only means something on a build no event
// announced: `create_entity` raises nothing, so the ledger is still open there and the wire is genuinely
// missing. That is the case the command exists for -- and the honest read of the first version of this
// check, which passed by asking about a ledger the build events had already emptied.
const second = call("card_place", { name: "wired-lane-e2e", surface: "nauvis" });
const sd = second.data || {};
check("a second placement arrives", second.ok && sd.ghosts === 3, second.ok ? JSON.stringify(sd.origin) : second.code);
const o2 = sd.origin || { x: 0, y: 0 };
const area2 = `{{${o2.x - 1},${o2.y - 1}},{${o2.x + 9},${o2.y + 6}}}`;
const quiet = lua(`local s=game.surfaces["${surf}"]
local W=defines.wire_connector_id
local made=0
for _,g in ipairs(s.find_entities_filtered{area=${area2},type="entity-ghost"}) do
  local nm, pos = g.ghost_name, g.position
  g.destroy()
  local e = s.create_entity{name=nm, position=pos, force="player"}
  if e then made=made+1; _G.WW[#_G.WW+1]={ent=e, name=e.name, at=e.position} end
end
local m=(s.find_entities_filtered{area=${area2},type="assembling-machine"})[1]
rcon.print("quietly built="..made.." network="..tostring(m and m.get_circuit_network(W.circuit_green) ~= nil))`);
console.log("second side:", quiet);
check("a build no event announced leaves the wire undrawn", /quietly built=3 network=false/.test(quiet), quiet);

const asked = call("card_wire", {});
const ad = asked.data || {};
check("and card_wire draws it when someone asks", asked.ok && ad.drawn >= 1,
  JSON.stringify({ drawn: ad.drawn, waiting: ad.waiting, written: ad.written, jobs_open: ad.jobs_open }));
const after_ask = lua(`local s=game.surfaces["${surf}"]
local m=(s.find_entities_filtered{area=${area2},type="assembling-machine"})[1]
rcon.print("network="..tostring(m and m.get_circuit_network(defines.wire_connector_id.circuit_green) ~= nil))`);
check("the asked-for redraw is the wire the machine is now standing in", /network=true/.test(after_ask), after_ask);
// The same act, controller side: the entities were built by `create_entity`, which raises no event, so
// nothing but this command would ever have written what the card asked for.
check("and the same ask configures the two circuit intents the card carried",
  (ad.written || 0) >= 2, JSON.stringify({ written: ad.written, refused: ad.refused }));
sleep(3000);
const asked_running = lua(`local s=game.surfaces["${surf}"]
local m=(s.find_entities_filtered{area=${area2},type="assembling-machine"})[1]
rcon.print("recipe="..tostring(m and (m.get_recipe() or {}).name))`);
check("so the machine this mod never got a build event for runs its card's recipe",
  /recipe=copper-cable/.test(asked_running), asked_running);

const empty = call("card_wire", {});
check("and the ledger then says there is nothing left to do", ((empty.data || {}).jobs_open) === open0,
  JSON.stringify({ before: open0, after: (empty.data || {}).jobs_open }));

const undo = call("place_undo", { count: 2 });
check("taking the placements back is allowed", undo.ok, undo.code + " " + (undo.msg || ""));
const standing = ((undo.data || {}).standing) || [];
check("and says which of them had already been built into real machines", standing.length > 0,
  standing.length + " standing");

const plain = call("card_freeze", { card: Object.assign({}, CTRL_CARD, { name: "unwired-lane-e2e", wires: {} }),
  allow_unmeasured: true });
const plain_pl = plain.ok ? call("card_place", { name: "unwired-lane-e2e", surface: "nauvis" }) : { ok: false, code: "no card" };
const pw = (plain_pl.data || {}).wires || {};
check("a card with no wires says nothing about wiring", plain_pl.ok && pw.drawn === 0 && !pw.job,
  JSON.stringify(pw));
if (plain_pl.ok) call("place_undo", { count: 1 });

// Every entity this suite made, destroyed by the handle it was made with -- including the ones
// `place_undo` correctly leaves alone, because a machine the player built is theirs and not ours.
const swept = lua(`local s=game.surfaces["${surf}"]
local gone, stale = 0, 0
for _, rec in ipairs(_G.WW or {}) do
  local e = rec.ent
  if e and e.valid then e.destroy(); gone = gone + 1 else stale = stale + 1 end
end
local left = 0
for _, rec in ipairs(_G.WW or {}) do
  local e = rec.ent
  if e and e.valid and e.name == rec.name then left = left + 1 end
end
_G.WW = nil
rcon.print("destroyed="..gone.." handles_already_gone="..stale.." still_standing="..left)`);
console.log("sweep:", swept);
check("the world this suite built is the world it leaves behind", /still_standing=0/.test(swept), swept);

finish();
