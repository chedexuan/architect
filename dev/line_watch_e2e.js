// End-to-end gate: measuring a line the player already built, without touching the world.
//
// The feature exists because the two rigs cannot answer the question a player inside a factory has.
// They need an ore patch to stand on, an entity to place and a world clock fast enough to fill a
// window, and all three of those are wrong the moment somebody is playing. So this reads one thing
// instead: the contents of every inventory inside the box, twice, with real seconds in between.
//
// What this file therefore insists on is not the size of the number but where it came from. The
// obvious instrument -- the force's production tally -- was tried first and measured to be useless
// here (a furnace smelted 20 plates and the count did not move), so every check below is against a
// quantity that is visible in the world from the same window: items in the result slot, items gone
// from the source slot, and the machine's own reason for being idle.
//
// What it cannot prove headless: the panel's own rendering of a finished record. The click path is
// checked as far as `gui_selftest` can reach it -- the button exists, the verb dispatches, the report
// is built -- and the words themselves are the locale gate's business.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("line_watch_e2e");
const { enLine } = require("./lines.js");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016" };
const call = (m, a) => {
  let out = "";
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RAW: "1" } });
  } catch (e) { return { ok: false, code: "HARNESS", msg: String((e && e.stderr) || e).slice(0, 160) }; }
  try { return JSON.parse(out.trim()); } catch (e) { return { ok: false, code: "PARSE", msg: out.slice(0, 160) }; }
};
const data = (r) => (r && r.data) || {};
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", maxBuffer: 1 << 28, env: ENV }).trim();
  } catch (e) { return "LUA_HARNESS"; }
};
const asArr = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (typeof v === "number" ? v : Number.NaN);
// `lua.js` prints the value and then a sentinel line, so a number is found by scanning rather than by
// taking the last line -- which is how this helper's first draft read `NaN` for a world speed of 1.
const numlua = (src) => {
  const m = String(lua(src)).match(/^-?\d+(?:\.\d+)?/m);
  return m ? Number(m[0]) : Number.NaN;
};

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log("  ok   " + name); }
  else { fail += 1; console.log("  FAIL " + name + " -- " + detail); }
};
const sleep = (ms) => {
  try { execFileSync("sleep", [String(ms / 1000)], { encoding: "utf8" }); } catch (e) { /* waited anyway */ }
};

// The fixture is a furnace rather than an assembler because a furnace needs no grid: it is the one
// crafter that can be made to demonstrably run on a server with no power network in it, which keeps
// this gate from depending on anything the mod's other suites left standing.
const SURF = "arch-lab";
const P = { x: 215.5, y: 215.5 };
const BOX = { left_top: { x: 214, y: 214 }, right_bottom: { x: 217, y: 217 } };
const wipe = () => lua(`local s = game.surfaces["${SURF}"]
  for _, e in ipairs(s.find_entities_filtered{area = {{${BOX.left_top.x}, ${BOX.left_top.y}}, {${BOX.right_bottom.x}, ${BOX.right_bottom.y}}}, force = "player"}) do e.destroy() end
  rcon.print("wiped")`);
const prime = (extra) => lua(`local s = game.surfaces["${SURF}"]
  local e = s.create_entity{name = "steel-furnace", position = {x = ${P.x}, y = ${P.y}}, force = "player"}
  if not e then rcon.print("NOFURNACE") return end
  local src = e.get_inventory(defines.inventory.furnace_source)
  local fu = e.get_inventory(defines.inventory.fuel)
  src.insert{name = "iron-ore", count = 40}
  fu.insert{name = "coal", count = ${extra && extra.coal || 30}}
  rcon.print("primed " .. src.get_item_count("iron-ore") .. "/" .. fu.get_item_count("coal"))`);
// Empty the result slot between two looks: the box's output is then unchanged while its input falls,
// which is the one state that can only be described as "the product left the box".
const drain = () => lua(`local s = game.surfaces["${SURF}"]
  local e = s.find_entities_filtered{name = "steel-furnace", position = {x = ${P.x}, y = ${P.y}}, radius = 2}[1]
  if not e then rcon.print("NOFURNACE") return end
  e.get_inventory(defines.inventory.furnace_result).clear()
  rcon.print("drained")`);

wipe();

// ---------------------------------------------------------------- the refusals come first
const nosurf = call("line_watch", { area: BOX });
check("a watch with no surface says which fact is missing, and does not guess nauvis",
  nosurf.ok === false && nosurf.code === "NO_SURFACE" && nosurf.msg_key === "m-surface-required",
  JSON.stringify({ code: nosurf.code, key: nosurf.msg_key }));

const badsurf = call("line_watch", { surface: "nauvis-nowhere", area: BOX });
check("a surface that is not in the save is refused by name, not defaulted",
  badsurf.ok === false && badsurf.code === "NO_SURFACE" && badsurf.msg_key === "m-watch-no-surface"
  && asArr(badsurf.msg_params)[0] === "nauvis-nowhere",
  JSON.stringify({ code: badsurf.code, key: badsurf.msg_key, params: badsurf.msg_params }));

const noarea = call("line_watch", { surface: SURF });
check("a watch with no box refuses with the shape to pass",
  noarea.ok === false && noarea.code === "BAD_ARGS" && noarea.msg_key === "m-arg-area-scan",
  JSON.stringify({ code: noarea.code, key: noarea.msg_key }));

// The same box, in both spellings, to three readers. This is the shape that the panel once passed as a
// display string and every fit came home refused for; one parser now answers all of them.

const shortwin = call("line_watch", { surface: SURF, area: BOX, seconds: 0 });
check("a window of no seconds is refused with the number it was given",
  shortwin.ok === false && shortwin.code === "BAD_ARGS" && shortwin.msg_key === "m-watch-window"
  && asArr(shortwin.msg_params)[0] === "0",
  JSON.stringify({ code: shortwin.code, key: shortwin.msg_key, params: shortwin.msg_params }));
const longwin = call("line_watch", { surface: SURF, area: BOX, seconds: 9999 });
check("and so is one long enough to hang the run",
  longwin.ok === false && longwin.code === "BAD_ARGS" && asArr(longwin.msg_params)[0] === "9999",
  JSON.stringify({ code: longwin.code, params: longwin.msg_params }));

const empty = call("line_watch", { surface: SURF, area: { left_top: { x: -400, y: -400 }, right_bottom: { x: -392, y: -392 } }, refresh: true });
check("a box with nothing to watch says there is no machine in it, not that the rate is zero",
  empty.ok === false && empty.code === "NOTHING_TO_WATCH" && empty.msg_key === "m-watch-no-machines"
  && typeof (empty.detail || {}).entities === "number",
  JSON.stringify({ code: empty.code, key: empty.msg_key, detail: empty.detail }));

// ---------------------------------------------------------------- the window itself
const primed_line = prime();
check("the fixture furnace is standing and fuelled", /primed 40\/30/.test(String(primed_line)), String(primed_line));
const started = call("line_watch", { surface: SURF, area: BOX, seconds: 14, refresh: true });
check("starting a watch names the machines it will look at and the recipe it found",
  started.ok === true && started.data.state === "started" && started.data.machine_count === 1
  && started.data.recipes && started.data.recipes["iron-plate"] === 1 && started.data.seconds === 14,
  JSON.stringify(started.data));

const pair = call("line_watch", { surface: SURF, area: [[214, 214], [217, 217]] });
check("the pair spelling of a box reaches the window the corner spelling opened: one parser, two shapes",
  pair.ok === true && pair.data.state === "running" && pair.data.key === started.data.key,
  JSON.stringify({ state: pair.data.state, key: pair.data.key, was: started.data.key }));

const speed_before = numlua("rcon.print(game.speed)");
const running = call("line_watch", { surface: SURF, area: BOX, seconds: 14 });
check("asking again while it runs answers with time left rather than with a zero",
  running.ok === true && running.data.state === "running"
  && num(running.data.seconds_left) > 0 && running.data.machine_count === 1,
  JSON.stringify(running.data));
check("the world clock is exactly where it was: a watch does not raise it",
  speed_before === 1 && numlua("rcon.print(game.speed)") === speed_before,
  "before " + speed_before + " after " + numlua("rcon.print(game.speed)"));

const other = call("line_watch", { surface: "nauvis", area: { left_top: { x: 2000, y: 2000 }, right_bottom: { x: 2008, y: 2008 } }, seconds: 4 });
check("a second box while the first is open is refused, and told which watch is in the way",
  other.ok === false && other.code === "MEASUREMENT_BUSY" && other.msg_key === "m-watch-busy"
  && String((other.detail || {}).running || "").indexOf(started.data.key) === 0,
  JSON.stringify({ code: other.code, detail: other.detail }));

sleep(17000);
const done = call("line_watch", { surface: SURF, area: BOX, seconds: 14 });
const d = data(done);
const plates = asArr(d.per_item).find((e) => e.item === "iron-plate") || {};
const ore = asArr(d.per_item).find((e) => e.item === "iron-ore") || {};
check("the finished record is a measurement, of this box, on this surface",
  done.ok === true && d.state === "measured" && d.scope === "box" && d.surface === SURF,
  JSON.stringify({ ok: done.ok, code: done.code, state: d.state, scope: d.scope }));
// `before` and `after` are both numbers on every row, including for an item that only appeared
// during the window -- a missing field would leave a reader asking whether the zero was seen or never
// looked for, which is the question this check exists to close.
check("plates appeared in the result slot, and the record says how many and how fast",
  num(plates.gained) > 0 && num(plates.per_min) > 0 && num(plates.after) > num(plates.before)
  && typeof plates.before === "number" && typeof plates.after === "number",
  JSON.stringify(plates));
check("ore vanished from the source slot, and that is reported as a separate number",
  num(ore.spent) > 0 && ore.gained === 0 && ore.per_min === undefined,
  JSON.stringify(ore));
check("a rate is only ever attached to a gain: consumption is never divided into minutes",
  asArr(d.per_item).every((e) => !(e.spent > 0 && e.per_min)),
  JSON.stringify(asArr(d.per_item).map((e) => [e.item, e.per_min, e.spent])));
check("the machine is reported by what it is doing, not assumed to be running",
  num(d.machine_count) === 1 && d.status_census && Object.keys(d.status_census).length > 0
  && (num(d.running) || 0) + (num(d.stalled) || 0) + (num(d.gone) || 0) === num(d.machine_count)
  && num(d.machine_count) === 1,
  JSON.stringify({ census: d.status_census, running: d.running, stalled: d.stalled, gone: d.gone }));
check("the window says what it cost the world: no warp, real seconds, clock untouched",
  d.clock && d.clock.warps_world === false && num(d.clock.speed) === 1 && d.clock_untouched === true
  && d.clock_moved === false && num(d.elapsed_game_seconds) >= 12,
  JSON.stringify({ clock: d.clock, untouched: d.clock_untouched, moved: d.clock_moved, e: d.elapsed_game_seconds }));
check("a line that both gained and spent is neither 'shipped out' nor 'idle'",
  d.shipped_out === undefined && d.idle === undefined && num(d.gained_total) > 0 && num(d.spent_total) > 0,
  JSON.stringify({ shipped: d.shipped_out, idle: d.idle, g: d.gained_total, s: d.spent_total }));

const again = call("line_watch", { surface: SURF, area: BOX });
check("asking once more without refresh returns the SAME window, marked as cached",
  again.ok === true && again.data.cached === true && again.data.gained_total === d.gained_total
  && again.data.measured_tick === d.measured_tick,
  JSON.stringify({ cached: again.data.cached, g: again.data.gained_total, was: d.gained_total }));
const fresh = call("line_watch", { surface: SURF, area: BOX, seconds: 14, refresh: true });
check("and refresh means refresh: a new window opens instead of the old record",
  fresh.ok === true && fresh.data.state === "started" && !fresh.data.cached,
  JSON.stringify(fresh.data));

// ---------------------------------------------------------------- the two zeros, told apart
sleep(16000);
check("the record of the second window is there to be read",
  call("line_watch", { surface: SURF, area: BOX }).data.state === "measured", "state");
// Now drain the result slot from outside, so nothing accumulates while ore is still eaten: the only
// honest reading of that is "the output left the box", and the field exists so a player is not left to
// infer it from a zero.
const shipping = call("line_watch", { surface: SURF, area: BOX, seconds: 12, refresh: true });
check("a third window opens over the same box", shipping.data.state === "started", JSON.stringify(shipping.data));
for (let i = 0; i < 6; i += 1) { sleep(1800); drain(); }
const shipped = data(call("line_watch", { surface: SURF, area: BOX, seconds: 12 }));
check("spent-but-not-gained is reported as shipped_out, with the amount that vanished named",
  shipped.state === "measured" && shipped.shipped_out === true && num(shipped.gained_total) === 0
  && num(shipped.spent_total) > 0,
  JSON.stringify({ state: shipped.state, shipped: shipped.shipped_out, g: shipped.gained_total, s: shipped.spent_total }));

wipe();
const starved = lua(`local s = game.surfaces["${SURF}"]
  local e = s.create_entity{name = "steel-furnace", position = {x = ${P.x}, y = ${P.y}}, force = "player"}
  rcon.print(e and "placed" or "NOFURNACE")`);
check("a furnace with nothing in it can be placed for the idle case", /placed/.test(String(starved)), String(starved));
const idleStart = call("line_watch", { surface: SURF, area: BOX, seconds: 6, refresh: true });
sleep(8000);
const idle = data(call("line_watch", { surface: SURF, area: BOX, seconds: 6 }));
check("a box where nothing moves is called idle, and names the machine's own reason",
  idle.state === "measured" && idle.idle === true && num(idle.gained_total) === 0
  && num(idle.spent_total) === 0 && idle.status_census && Object.keys(idle.status_census).length > 0,
  JSON.stringify({ state: idle.state, idle: idle.idle, census: idle.status_census }));
wipe();

// ---------------------------------------------------------------- the click path
const st = data(call("gui_selftest", {}));
const tree = asArr(st.tree).map(String).join("\n");
const after = asArr(((st.report_after || {})["arch-watch"] || {}).lines).map(enLine).join(" | ");
check("the button is in the window and the dispatcher answers it rather than falling through",
  /arch-watch/.test(tree) && after !== "",
  JSON.stringify({ in_tree: /arch-watch/.test(tree), after: after.slice(0, 120) }));
check("the watch sits on the box's own row, with the other things that spend a box",
  asArr(st.named_rows || []).some((r) => r.name === "arch-watch" && r.parent === "arch-box-row"),
  JSON.stringify(asArr(st.named_rows || []).filter((r) => /watch/.test(String(r.name)))));
// The click either opened a window, found one already open, or said there was no box; all three are
// sentences about the box. What it must never be is the dispatcher's own vocabulary leaking into the
// player's report area, and never a raw locale key either -- which is what an untranslated caption
// looks like from the inside.
check("the report the click leaves behind is a watch sentence, not an unknown-verb message",
  /started: looking|second\(s\) left|another watch is already running|nothing is boxed/.test(after)
  && !/NO_HANDLER|architect\.|table: 0x/.test(after),
  after.slice(0, 200));

check("no button the panel rendered comes back undispached, including the new one",
  asArr(st.unhandled).length === 0, JSON.stringify(asArr(st.unhandled)));

// A key that takes parameters gets its words from a Lua expression, so the static locale gate cannot
// compare them: it checks the no-parameter sentences and these two check the parameterised ones live.
// Both refusals below were measured from real calls above rather than typed out here, which is the
// difference between proving the formatter matches the method and proving it matches the author.
for (const [label, refusal] of [["a window of no seconds", shortwin], ["a surface that is not in the save", badsurf]]) {
  const shown = data(call("gui_selftest", { render_refusal: { cmd: "watch", name: "",
    code: refusal.code, msg: refusal.msg, msg_key: refusal.msg_key,
    msg_params: asArr(refusal.msg_params), detail: refusal.detail || null } }));
  const line = enLine(asArr((shown.refuse_live || {}).render)[0] || "");
  // The panel's head line is `refused: CODE -- <sentence>`, so the sentence is the TAIL of it. What is
  // being proven is the tail: the keyed rendering carries the caller's own words and its own numbers,
  // byte for byte, which is the half a hand-written fixture could never prove.
  check(`the window says ${label} in the very words the protocol used`,
    (shown.refuse_live || {}).code === refusal.code
    && line === "refused: " + refusal.code + " -- " + refusal.msg
    && !/architect\.|__\d+__/.test(line),
    JSON.stringify({ line: line, msg: refusal.msg }));
}

const verdict = fail === 0 ? "ALL PASS" : "FAILURES";
console.log(`${verdict}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
