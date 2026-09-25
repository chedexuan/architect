// End-to-end proof of 撤銷放置: the panel can take back what the panel laid -- and only that.
//
// What this is really guarding is the difference between "undo" and "delete". A deployment record that
// names the exact objects the mod created can be replayed in any order, by any player, against a world
// that has moved on; one that scans an area for things that look like the card will eat a machine the
// player built themselves. So the interesting cases are the ones where the world DID move on: a ghost
// that has been filled in, a stack of two placements where only the newest is asked for, and a save
// that was quit and loaded by another process in between.
const { brief } = require("./lines.js");
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("undo_e2e");
const restart = require("./restart.js")({
  root: path.join(__dirname, ".."), rconPort: Number(process.env.RCON_PORT || 27016),
  save: process.env.TEST_SAVE || "m0-test",
  log: path.join(__dirname, "..", ".factorio-test/server.out"),
  stdout: path.join(__dirname, "..", ".factorio-test/server.out"),
});

const ROOT = path.join(__dirname, "..");
const ENV = { ...process.env };
const call = (m, a) => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RAW: "1" } });
  } catch (e) { return { ok: false, code: "NO_SERVER", msg: String((e && e.stderr) || e).slice(0, 160) }; }
  try { return JSON.parse(out.trim()); } catch (e) { return { ok: false, code: "PARSE", msg: out.slice(0, 160) }; }
};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8", env: ENV }).trim();
  } catch (e) { return "probe failed: " + String((e && e.stderr) || e).slice(0, 120); }
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

let pass = 0, fail = 0;
const check = (what, ok, detail) => {
  if (ok) { pass++; console.log("  ok  " + what); }
  else { fail++; console.log("  FAIL " + what + (detail === undefined ? "" : "   " + String(detail).slice(0, 260))); }
};

// Non-resource entities on the pad: that is what a placement adds, and the only honest census for
// "did it go back to how it was".
const CENSUS = `local s=game.surfaces["arch-sandbox"] if not s then rcon.print("no pad") return end
local n, kinds = 0, {}
for _, e in ipairs(s.find_entities_filtered{}) do
  if e.type ~= "resource" and e.type ~= "tile" then n = n + 1 kinds[e.name] = (kinds[e.name] or 0) + 1 end
end
local p = {} for k, v in pairs(kinds) do p[#p+1] = k .. "=" .. v end table.sort(p)
rcon.print("pad=" .. n .. " " .. table.concat(p, " "))`;

// Fill one ghost the way a player does: the ghost goes away and a real machine of the same name takes
// its place, under a NEW unit number. Undo must leave that machine standing.
const FILL_ONE = `local s = game.surfaces["arch-sandbox"]
for _, g in ipairs(s.find_entities_filtered{type="entity-ghost"}) do
  local inner = g.ghost_prototype
  local pos, dir = g.position, g.direction
  g.destroy()
  local e = s.create_entity{name = inner and inner.name or "assembling-machine-1", position = pos,
    direction = dir, force = "player"}
  rcon.print("filled " .. tostring(inner and inner.name) .. " at " .. pos.x .. "," .. pos.y
    .. " -> " .. (e and ("unit " .. e.unit_number) or "nothing"))
  return
end
rcon.print("no ghost to fill")`;

(async () => {
  console.log("undo_e2e: the panel takes back its own placements and nobody else's");
  call("sandbox", {}); sleep(2500); call("sandbox", {}); sleep(1000);
  const card = (call("card_example", {}) || {}).data;
  if (!card || !card.name) { console.log("SETUP FAIL no example card"); process.exit(1); }
  const frozen = call("card_freeze", { card, name: "undo-card", allow_unmeasured: true });
  if (!frozen.ok) { console.log("SETUP FAIL card_freeze: " + frozen.code + " " + frozen.msg); process.exit(1); }

  // Drain first. Every suite that places a card now leaves a record behind, and this file's whole
  // subject is the stack -- asserting "depth 1" on a stack another suite already filled would fail
  // for a fact about the run ORDER rather than about the feature. Draining is also the first time the
  // empty answer gets checked, which is the one refusal that cannot be provoked any other way.
  let drained = 0;
  for (let i = 0; i < 40; i++) {
    const r = call("place_undo", {});
    if (!r.ok) break;
    drained++;
  }
  const empty = call("place_undo", {});
  check("an empty stack is a refusal with a reason, not an empty answer",
    !empty.ok && empty.code === "NOTHING_TO_UNDO", `${empty.code} ${empty.msg}`);
  // Falsifiable on purpose: hitting the cap means `place_undo` kept answering "undone 1" without the
  // stack ever emptying, which is exactly what a record that removes nothing from the log would do.
  check("and the drain terminated instead of undoing the same record forever",
    drained < 40, `drained=${drained}`);

  // ---- 1. one placement, taken back whole ----
  const censusBefore = lua(CENSUS);
  const one = call("card_place", { name: "undo-card", surface: "arch-sandbox", ghosts: true, origin: { x: -50, y: -50 } });
  const laid = (one.data || {}).ghosts || 0;
  // The depth is the stack, which the drain just emptied, so it is a hard 1. The id is not: it keeps
  // counting for the life of the save (a reused id would let an old record look like a new one), so the
  // assertion is that it is a number at all.
  check("a placement reports itself as undoable, and how deep the stack now is",
    one.ok && laid > 3 && typeof (one.data || {}).deployment === "number" && (one.data || {}).undo_depth === 1,
    `${one.code || "ok"} ghosts=${laid} deployment=${(one.data || {}).deployment} depth=${(one.data || {}).undo_depth}`);
  check("and the ghosts really are in the world", lua(CENSUS) !== censusBefore, lua(CENSUS));

  const back = call("place_undo", {});
  check("undo takes the whole placement back", back.ok && (back.data || {}).undone === 1
    && (back.data || {}).removed === laid && (back.data || {}).remaining === 0,
    JSON.stringify(back.data || { code: back.code, msg: back.msg }));
  check("and the pad is exactly what it was before", lua(CENSUS) === censusBefore,
    `${censusBefore} || ${lua(CENSUS)}`);

  // ---- 2. two placements, newest first ----
  const a = call("card_place", { name: "undo-card", surface: "arch-sandbox", ghosts: true, origin: { x: -50, y: -50 } });
  const censusAfterA = lua(CENSUS);
  const b = call("card_place", { name: "undo-card", surface: "arch-sandbox", ghosts: true, origin: { x: -20, y: -50 } });
  check("two placements stack, oldest at the bottom", a.ok && b.ok && (b.data || {}).undo_depth === 2
    && (b.data || {}).deployment > (a.data || {}).deployment,
    `depth=${(b.data || {}).undo_depth} ids=${(a.data || {}).deployment}->${(b.data || {}).deployment}`);
  const newest = call("place_undo", { count: 1 });
  check("undoing once removes only the newest", newest.ok && (newest.data || {}).removed === (b.data || {}).ghosts
    && (newest.data || {}).remaining === 1 && lua(CENSUS) === censusAfterA,
    `removed=${(newest.data || {}).removed} left=${(newest.data || {}).remaining} || ${lua(CENSUS)} vs ${censusAfterA}`);
  call("place_undo", {});

  // ---- 3. a ghost the player filled in is theirs, not ours ----
  const preFill = lua(CENSUS);
  call("card_place", { name: "undo-card", surface: "arch-sandbox", ghosts: true, origin: { x: -50, y: -50 } });
  const filled = lua(FILL_ONE);
  check("the fixture filled one ghost with a real machine", /filled /.test(filled), filled);
  const risky = call("place_undo", {});
  const d = risky.data || {};
  check("undo reports that one of its objects is gone, and what stands there now",
    risky.ok && (d.already_gone || 0) === 1 && (d.standing_now || 0) === 1
    && Array.isArray(d.standing) && ((d.standing[0] || {}).unit !== undefined), brief(d, 240));
  // Count what the undo answer NAMED, not a machine this mod happens to use elsewhere: the example
  // card's ghost is a foundry, and an assertion written against a guess about that fails while the
  // behaviour it meant to check is fine.
  const named = ((d.standing || [])[0] || {}).now;
  const safe = typeof named === "string" && /^[A-Za-z0-9_-]+$/.test(named);
  const standing = safe
    ? lua(`local s=game.surfaces["arch-sandbox"] local n=0
for _,e in ipairs(s.find_entities_filtered{name="${named}"}) do n=n+1 end
rcon.print("standing=" .. n)`) : "no name to look for: " + JSON.stringify(named);
  check("and the machine the player built is still standing", /standing=1/.test(standing),
    `${named}: ${standing}`);
  call("place_undo", {});

  // ---- 4. the case that broke the release before this one: a second process loading the save ----
  call("sandbox", {}); sleep(2500); call("sandbox", {}); sleep(1000);
  const preReload = lua(CENSUS);
  const deep = call("card_place", { name: "undo-card", surface: "arch-sandbox", ghosts: true, origin: { x: -30, y: -30 } });
  check("a placement is laid for the reload", deep.ok && (deep.data || {}).ghosts > 3,
    `${deep.code || "ok"} ghosts=${(deep.data || {}).ghosts}`);
  const stopped = restart.stopAndSave();
  if (!stopped.saved) { console.log("SETUP FAIL the quit did not write a save: " + brief(stopped, 240)); process.exit(1); }
  if (!restart.startAndPing()) { console.log("SETUP FAIL the reloaded instance never answered"); process.exit(1); }
  // No `sandbox` call here, whatever the temptation: taking the bench sweeps its pad, which would
  // destroy the very ghosts this check exists to prove a reloaded process can still take back -- and
  // the census afterwards would then match for entirely the wrong reason.
  const after = call("place_undo", {});
  check("the process that LOADED the save can still take the placement back",
    after.ok && (after.data || {}).removed === (deep.data || {}).ghosts,
    `${after.code || "ok"} removed=${(after.data || {}).removed} of ${(deep.data || {}).ghosts}`);
  check("and the pad is back to what a fresh load found", lua(CENSUS) === preReload,
    `${preReload} || ${lua(CENSUS)}`);

  console.log(`${pass}/${pass + fail} undo_e2e checks passed`);
  process.exit(fail ? 1 : 0);
})();
