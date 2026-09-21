// A seam the rig cannot close itself: propose the corridor, verify what a hand laid.
//
// Straight runs are settled (dev/pipe_route_e2e.js): region proposes a row of pipes along the axis
// two ports share and compose walks it. The part no rule can decide well is the run that has to
// TURN -- around a furnace someone else built, through ground whose obstacles only the player can
// see. So the rig now does the two halves that are decidable and leaves the middle to a hand:
// `seam_check` reads the ground and says whether the chain is closed, and when it is not, names the
// free cells that would close it. It never lays a bend itself.
//
// Each phase lays exactly the cells the rig proposed, which is the whole point: if the proposal is
// wrong, the verification afterwards says so.
//
// Run after `bash dev/cycle.sh`; it grants its own recipes because seam_check reads the ground, not
// the tech tree.
const { execFileSync } = require("child_process");
const path = require("path");

const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "ignore"] }).trim());
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8", maxBuffer: 1 << 29 });

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) fails++;
};

// the lab surface is created on demand and its chunks arrive a few ticks later; seam_check reads
// the ground, so there has to be ground
for (let i = 0; i < 10; i++) {
  const ready = call("sandbox", {});
  if (ready.ok) break;
  sleep(2000);
}

lua(`local f=game.forces.player
for _,n in ipairs({"fluid-handling"}) do local t=f.technologies[n] if t then t.researched=true end end
for _,n in ipairs({"pipe","storage-tank","oil-refinery"}) do
  local r=f.recipes[n]; if r then r.enabled=true end
end
local s=game.surfaces["arch-sandbox"]
if s then for _,e in ipairs(s.find_entities_filtered{area={{-40,-40},{40,40}}}) do e.destroy() end end
rcon.print("granted and cleared")`);

// a pumpjack and a refinery six tiles apart, with the straight corridor between them
const SRC = { x: 2.5, y: 2.5 };
const DST = { x: 12.5, y: 2.5 };

const build = (extra) => lua(`local s=game.surfaces["arch-sandbox"]
for _,e in ipairs(s.find_entities_filtered{area={{-40,-40},{40,40}}}) do e.destroy() end
s.create_entity{name="pumpjack",position={${SRC.x},${SRC.y}},force="player"}
s.create_entity{name="oil-refinery",position={${DST.x},${DST.y}},force="player"}
${extra || ""}
rcon.print("built")`);

const lay = (cells) => lua(`local s=game.surfaces["arch-sandbox"]
local n=0
for _,c in ipairs({ ${cells.map((c) => `{x=${c.x},y=${c.y}}`).join(",")} }) do
  if s.can_place_entity{name="pipe",position=c,force="player"} then
    if s.create_entity{name="pipe",position=c,force="player"} then n=n+1 end
  end
end
rcon.print("laid "..n.." of ${cells.length}")`);

const check_seam = () => call("seam_check", {
  surface: "arch-sandbox", fluid: "crude-oil", from: SRC, to: DST,
});

const collinear = (cells) => cells.every((c) => c.y === cells[0].y) || cells.every((c) => c.x === cells[0].x);

(async () => {
  // ---- an open gap: not connected, and the proposal is the straight row ----
  await build();
  let r = check_seam();
  let ask = r.data && r.data.ask;
  check("an empty gap reads as no chain, not as a short one",
    r.ok && r.data.connected === false && r.data.why === "NO_PIPE_CHAIN",
    r.ok ? `${r.data.connected} ${r.data.why}` : `${r.code} ${r.msg}`);
  // the gap is six tiles of open ground between the two footprints, and the row it picks is the
  // rig's business -- what matters is that the run touches both machines and nothing else
  check("the proposal is a straight row of free cells between them",
    ask && ask.kind === "lay_pipes" && ask.pipes >= 4 && asArr(ask.cells).length === ask.pipes
    && collinear(ask.cells),
    JSON.stringify(ask && { kind: ask.kind, pipes: ask.pipes }));

  // ---- the hand lays exactly what was proposed, and the seam verifies closed ----
  console.log(await lay(ask.cells));
  r = check_seam();
  check("laying exactly the proposed cells closes the seam, at the length the rig counted",
    r.ok && r.data.connected === true && r.data.pipes === ask.pipes,
    r.ok ? JSON.stringify({ connected: r.data.connected, pipes: r.data.pipes,
      asked: ask.pipes }) : r.code);

  // ---- a furnace in the line: the corridor has to turn, and the rig still names it ----
  // A wall has to be a wall: stone-furnace is 2x2, so three of them stacked leave rows open for the
  // corridor to slip through and the "bend" it reports is a straight line through a hole. 3x3 tanks
  // at half-tile centres cover every row between them.
  const wall = `for _,fy in ipairs({0.5, 3.5, 6.5}) do
  s.create_entity{name="storage-tank",position={7.5,fy},force="player"} end`;
  await build(wall);
  r = check_seam();
  ask = r.data && r.data.ask;
  const bent = ask && ask.kind === "lay_pipes" && !collinear(asArr(ask.cells));
  check("with the straight row blocked, the proposal bends instead of giving up",
    bent, JSON.stringify(ask && { kind: ask.kind, pipes: ask.pipes,
      cells: asArr(ask.cells).map((c) => `${c.x},${c.y}`) }));
  console.log(await lay(ask.cells));
  r = check_seam();
  check("the bent corridor the rig proposed really does carry fluid from end to end",
    r.ok && r.data.connected === true && r.data.pipes >= ask.pipes,
    r.ok ? JSON.stringify({ connected: r.data.connected, pipes: r.data.pipes }) : r.code);

  // ---- a partly built run comes back as what is missing, not as nothing ----
  const chain = asArr(ask.cells);
  await build(wall);
  console.log(await lay(chain.slice(0, chain.length - 1)));
  r = check_seam();
  ask = r.data && r.data.ask;
  check("one cell short is reported as one pipe to lay, with the rest marked already",
    r.ok && r.data.connected === false && ask && ask.kind === "lay_pipes" && ask.pipes === 1
    && asArr(ask.cells).filter((c) => c.already).length === chain.length - 1,
    JSON.stringify(ask && { kind: ask.kind, pipes: ask.pipes,
      already: asArr(ask.cells).filter((c) => c.already).length }));

  // ---- a chain holding the wrong fluid is not a closed seam ----
  console.log(await lay(chain));
  console.log(lua(`local s=game.surfaces["arch-sandbox"]
local p=s.find_entities_filtered{name="pipe",position={${chain[0].x},${chain[0].y}},radius=0.1}[1]
if not p then rcon.print("NO_PIPE") return end
local ok,err=pcall(function() return p.insert_fluid{name="water",amount=50} end)
rcon.print("water into the crude chain: "..tostring(ok).." "..tostring(err))`));
  r = check_seam();
  check("a chain with water inside it is refused as a crude-oil seam, and says what is in there",
    r.ok && r.data.connected === false && r.data.why === "SEAM_HOLDS_OTHER_FLUID"
    && r.data.foreign === "water",
    r.ok ? JSON.stringify({ why: r.data.why, foreign: r.data.foreign }) : r.code);

  await lua(`local s=game.surfaces["arch-sandbox"]
for _,e in ipairs(s.find_entities_filtered{area={{-40,-40},{40,40}}}) do e.destroy() end
rcon.print("cleared")`);

  console.log(`\n${fails === 0 ? "seam proposals and verifications behave" : fails + " FAILED"}`);
  process.exit(fails ? 1 : 0);
})();
