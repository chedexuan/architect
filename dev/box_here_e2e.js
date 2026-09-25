// End-to-end gate: a box the player can actually make.
//
// The bug this was written for is not in the solver -- it is that the panel's ONLY way to get a box was
// the vanilla left-drag, which 2.0 asks for an empty hand and a mouse rectangle to perform. A player who
// cannot make that gesture gets `NO_SELECTION` out of 能否放下 no matter what they chose in the form,
// which reads as "every line I ask for is refused". So the window now takes a box from two numbers and a
// position; this gate proves the box it writes is the shape the readers want, that the guard rails are
// guards, and that the click path exists at all.
//
// What this file CANNOT prove headless: the panel label and the chat line that follow a box, because both
// need a real LuaPlayer and 2.0 gives a server none until a client joins. `remember_box` is the single
// writer for the drag and the button alike, so the one half nobody checks is "a connected player's window
// notices by itself" -- the same sentence gui.lua already says about every caption in the mod.
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
require("./suite-guard.js").guardMain("box_here_e2e");
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
const asArr = (v) => (Array.isArray(v) ? v : []);
const or_0 = (v) => (typeof v === "number" ? v : 0);
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV }).trim();
  } catch (e) { return "HARNESS"; }
};

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log("  ok  " + name + (detail ? "  " + detail : "")); }
  else { fail++; console.log("  FAIL " + name + "  " + (detail || "")); }
};

console.log("box_here_e2e: the window's own box, end to end");

// A place with room for a 41x31 box, asked of the server rather than invented: 400,-400 is a perfectly
// good rectangle on ground that has not been generated, and nothing can be stood on it to prove the box
// was read. `at` is passed explicitly because a headless server has no player -- the box is a fact about
// the save, not about a window, and the method has to work for a caller with no client at all.
const HERE = (() => {
  const picks = [[0, 0], [64, 0], [0, 64], [-64, -64], [128, 64], [-128, -128], [200, -200]];
  const got = lua('local s=game.surfaces["nauvis"] local out={} '
    + 'for _, p in ipairs({' + picks.map((q) => `{${q[0]},${q[1]}}`).join(",") + '}) do '
    // chunk units, not tile units -- the same conversion control.lua spells as CHUNK
    + '  if s.is_chunk_generated({math.floor(p[1]/32), math.floor(p[2]/32)}) then '
    + '    out[#out+1]=p[1]..","..p[2] end '
    + 'end rcon.print(#out>0 and out[1] or "none")');
  // lua.js frames its answer with a trailing `OK`, so the FIRST line matching the shape is the answer --
  // `pop()` reads the framing and every candidate looks ungenerated, which is how this gate once failed
  // its own setup on a world that had generated ground right at the origin.
  const m = /^(-?\d+),(-?\d+)$/.exec(String(got).split("\n").map((l) => l.trim()).find((l) => /^-?\d+,-?\d+$/.test(l)) || "");
  if (!m) { console.log("SETUP: no generated ground to take a box on"); process.exit(2); }
  return { x: Number(m[1]), y: Number(m[2]) };
})();
const W = 41, H = 31;
const taken = call("box_here", { player_index: 1, w: W, h: H, at: HERE, surface: "nauvis" });
const t = data(taken);
check("a box can be taken with no mouse and no player at all",
  taken.ok === true && t.w === W && t.h === H && t.counted === true && typeof t.entities === "number",
  JSON.stringify({ ok: taken.ok, code: taken.code, w: t.w, h: t.h, entities: t.entities }));
// Corners are the whole contract: `plan_fit` fills from left_top and `region_scan` walks to right_bottom,
// so an off-by-one here is a lane laid one tile off where the player is standing.
check("and the box is centred on the position, in whole tiles",
  !!t.left_top && t.left_top.x === HERE.x - Math.floor(W / 2) && t.left_top.y === HERE.y - Math.floor(H / 2)
  && !!t.right_bottom && t.right_bottom.x === t.left_top.x + W - 1
  && t.right_bottom.y === t.left_top.y + H - 1,
  JSON.stringify({ lt: t.left_top, rb: t.right_bottom }));

// Ground the game has not generated: counting there either raises or finds nothing, and "0 entities"
// would be a claim about dirt that is not there yet.
const far = call("box_here", { player_index: 1, w: 21, h: 21, at: { x: 900000, y: 900000 }, surface: "nauvis" });
check("a box on ungenerated ground says it could not count, instead of counting zero",
  far.ok === true && far.data.counted === false && far.data.entities === undefined,
  JSON.stringify({ counted: far.data && far.data.counted, entities: far.data && far.data.entities }));

// The two readers of the box, asked the question the buttons ask. A box the panel wrote but the scan or
// the fit cannot read is the same bug with a different symptom.
const box = { left_top: t.left_top, right_bottom: t.right_bottom };
// Empty generated ground answers NOTHING_SCANNED, which is correct and proves nothing about the box. One
// wall is laid first so the scan has something to find, and taken back afterwards: this is the round trip
// the panel's 读框 button actually runs, not a shape handed to it.
const laid = lua(`local s=game.surfaces["nauvis"]
local e=s.create_entity{name="stone-wall", force="player", position={x=${HERE.x}, y=${HERE.y}}}
rcon.print(e and tostring(e.unit_number) or "failed")`);
const scan = call("region_scan", { surface: t.surface, area: box });
check("读框 accepts the box and finds what stands in it",
  /^\d+$/.test(String(laid).split("\n")[0].trim()) && scan.ok === true
  && data(scan).surface === t.surface && or_0(data(scan).entities_kept) >= 1,
  JSON.stringify({ laid: String(laid).split("\n")[0], here: HERE, ok: scan.ok, code: scan.code,
    kept: data(scan).entities_kept }));
lua(`local s=game.surfaces["nauvis"]
for _,e in ipairs(s.find_entities_filtered{area={{${HERE.x - 1},${HERE.y - 1}},{${HERE.x + 1},${HERE.y + 1}}},name="stone-wall"}) do e.destroy() end
rcon.print("cleaned")`);

// Both spellings of the same box, because the panel stores one and a caller writes the other. `plan_fit`
// used to read only the [[x,y],[x,y]] form, and the window handed it the shape the drag event gave it --
// so 能否放下 was refused with BAD_ARGS even with a box drawn, which is the second half of the complaint
// this gate exists for.
const fit = call("plan_fit", { item: "iron-plate", rate: 60, unit: "per_minute", lanes: 1,
  surface: t.surface, area: box, spacing: "compact" });
const fit_array = call("plan_fit", { item: "iron-plate", rate: 60, unit: "per_minute", lanes: 1,
  surface: t.surface, spacing: "compact",
  area: [[t.left_top.x, t.left_top.y], [t.right_bottom.x, t.right_bottom.y]] });
check("and the same fit answers the same question for either spelling of the box",
  fit.code !== "BAD_ARGS" && fit_array.code !== "BAD_ARGS"
  && String(fit.code || "ok") === String(fit_array.code || "ok")
  && or_0(data(fit).lanes_fit) === or_0(data(fit_array).lanes_fit),
  JSON.stringify({ corners: fit.code, array: fit_array.code,
    a: { fit: data(fit).lanes_fit, want: data(fit).lanes_wanted },
    b: { fit: data(fit_array).lanes_fit, want: data(fit_array).lanes_wanted } }));
// Not asserted as "it fits" -- whether 60 plates a minute fits in 41x31 of THIS ground depends on the ore
// under it. Asserted as "the box was understood", which is the thing that was broken.
check("能否放下 answers about the box instead of refusing for want of one",
  fit.code !== "NO_SELECTION" && fit.code !== "BAD_ARGS" && fit.code !== "NO_SURFACE",
  JSON.stringify({ ok: fit.ok, code: fit.code, msg: String(fit.msg || "").slice(0, 60) }));

// Guard rails, in both directions: a box nothing can be laid in, and one so wide the walk over it is the
// slow part rather than the answer.
const small = call("box_here", { player_index: 1, w: 2, h: 2, at: HERE, surface: "nauvis" });
check("a box smaller than 3x3 is refused, with a key and the numbers it was given",
  small.ok === false && small.code === "BAD_ARGS" && small.msg_key === "m-box-too-small"
  && /at least 3x3/.test(String(small.msg)) && String(small.msg).indexOf("2x2") > 0
  && asArr(small.msg_params).join("x") === "2x2",
  JSON.stringify({ code: small.code, key: small.msg_key, msg: small.msg, params: small.msg_params }));
const anchorless = call("box_here", { player_index: 7, w: 21, h: 21 });
check("a box nobody can centre on says so, and says what to pass instead",
  anchorless.ok === false && anchorless.code === "NO_ANCHOR" && anchorless.msg_key === "m-box-no-anchor"
  && /at = \{x=,y=\}/.test(String(anchorless.msg)) && asArr(anchorless.msg_params)[0] === 7,
  JSON.stringify({ code: anchorless.code, key: anchorless.msg_key, msg: anchorless.msg }));
const big = call("box_here", { player_index: 1, w: 999, h: 21, at: HERE, surface: "nauvis" });
check("an absurd width is clamped, and says which one it clamped",
  big.ok === true && big.data.w === 200 && big.data.clamped === "w",
  JSON.stringify({ w: big.data && big.data.w, clamped: big.data && big.data.clamped }));
// ...and the clamp is not a lie about the answer: the remembered box is 200 wide, corners included.
check("the clamped box is the box that was remembered",
  big.ok === true && big.data.right_bottom.x - big.data.left_top.x === 199,
  JSON.stringify({ lt: big.data && big.data.left_top, rb: big.data && big.data.right_bottom }));

// The click path: the button has to be rendered, dispatched, and leave ITS OWN answer in the report --
// the class of bug the self-test exists for, since a button the dispatcher does not know returns nil in
// silence and the player sees a window that ignores them.
const st = data(call("gui_selftest", {}));
const tree = asArr(st.tree).join("\n");
check("the panel builds the box row", /arch-boxhere-row/.test(tree) && /arch-box-w/.test(tree)
  && /arch-box-h/.test(tree) && /arch-boxhere/.test(tree),
  asArr(st.tree).filter((l) => /boxhere|box-w|box-h/.test(String(l))).length + " widgets");
// The self-test records both halves of a click: the api call the mock answered ("boxhere") and the
// dispatcher's own line ("arch-boxhere -> boxhere"). Either alone would pass for the wrong reason -- a
// widget that exists but is never dispatched still shows up in the tree, and a mock the dispatcher never
// reaches shows up nowhere.
check("and clicking it runs the method rather than falling through the dispatcher",
  asArr(st.clicks).filter((c) => c === "boxhere").length === 1
  && asArr(st.clicks).some((c) => /^arch-boxhere -> boxhere$/.test(String(c))),
  JSON.stringify(asArr(st.clicks).filter((c) => /boxhere/.test(String(c)))));
const lines = asArr(((st.report_after || {})["arch-boxhere"] || {}).lines).map(enLine);
check("the answer that lands in the report area names the box it took",
  lines.some((l) => /box taken: 21x21 on /.test(l))
  && lines.some((l) => /next: Read box/.test(l)),
  JSON.stringify(lines));
// The click path through the REAL api -- the one thing the mock can never show, because the mock hands
// back a fit verdict it wrote itself. The box the model carries to a click is a label's box (no corners),
// and `fit` answering BAD_ARGS to that is exactly what a player with a drawn box saw.
const fr = st.fit_real || {};
check("the panel's own fit click reaches a verdict about the ground, not about its arguments",
  fr.setup === true && fr.ok === true && fr.view_carries_corners === false
  && fr.box_w === 41 && or_0(fr.lanes_wanted) > 0 && or_0(fr.lanes_fit) > 0,
  JSON.stringify(fr));
check("no button the panel rendered comes back undispached",
  asArr(st.unhandled).length === 0, JSON.stringify(asArr(st.unhandled)));

// One writer for both doors, checked where it is written: the drag handler has to go through
// `remember_box` and must not keep its own copy of the shape -- a second writer is how `entities` comes to
// mean "what the mouse selected" on one path and "what is standing here" on the other.
{
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "architect", "control.lua"), "utf8");
  const from = src.indexOf("script.on_event(defines.events.on_player_selected_area");
  const handler = src.slice(from, src.indexOf("script.on_event", from + 20));
  check("the vanilla drag writes the box through the same function the button does",
    from > 0 && /remember_box\(/.test(handler) && !/storage\.scan\[[^\]]+\]\s*=/.test(handler),
    handler.split("\n").filter((l) => /remember_box|storage\.scan/.test(l)).join(" | ").slice(0, 140));
}

// The refusal the whole complaint started with, rendered by the window's own formatter: it has to say
// WHAT is missing (a box) and HOW to make one, in a sentence the panel can put in the player's language.
const nogeom = call("gui_selftest", { render_refusal: { cmd: "fit", name: "iron-plate",
  code: "NO_SELECTION",
  msg: "no box is drawn -- hold nothing in your hand, drag a rectangle over the ground, then press this "
    + "again: lanes are laid INSIDE that rectangle",
  msg_key: "m-no-box-fit", msg_params: [], detail: null } });
const nl = asArr(data(nogeom).refuse_live && data(nogeom).refuse_live.render).map(enLine);
check("the no-box refusal is a sentence about the box, not about the line they asked for",
  nl.length > 0 && /no box is drawn/.test(String(nl[0])) && /drag a rectangle/.test(String(nl[0]))
  && /INSIDE that rectangle/.test(String(nl[0])),
  JSON.stringify(nl.slice(0, 2)));

console.log(`${pass}/${pass + fail} box_here_e2e checks passed`);
process.exit(fail ? 1 : 0);
