// The circuit rules a "signal-rotated line" has to be built on, measured rather than assumed.
//
// `dev/circuit_emit_probe.js` proved two things and left three open. Proved: a script-built decider
// combinator emits a signal onto a wire, a script-drawn wire carries it, and an assembler with
// `circuit_set_recipe` takes the recipe that wire names -- ignoring the recipe it was told to watch.
// Also proved: `circuit_read_ingredients` puts the running recipe's ingredient list on the wire, which
// is the recursion the game does for us at runtime (an electromagnetic plant running `supercapacitor`
// emits battery=1, electronic-circuit=4, holmium-plate=2, superconductor=2, electrolyte=10).
//
// Open, and each one changes what a layout may look like:
//   A. one wire, TWO recipe signals on it -- which one does the machine take, and does it stay taken?
//      If it picks deterministically, rotation needs a device that changes the wire over time; if it
//      flips, a bus is already a round-robin and the design is much smaller than I assumed.
//   B. can a selector combinator arbitrate on purpose (index out of a set of signals), so a plan can
//      name "the item we run short of first" instead of guessing at A?
//   C. does `recipe_locked` survive a wire? A locked machine that ignores the wire would silently
//      break every plan that lays one, so the answer belongs in the layout, not in a README.
//   D. what does a machine with `circuit_set_recipe` and an EMPTY wire say about itself? The status is
//      a number in this API; decoded here against `defines.entity_status`, because "waiting for a
//      signal" and "no power" look identical to anything that only counts output.
//   E. can a wire exist between GHOSTS? This mod lays ghosts, not buildings -- a wire that can only be
//      drawn between two real entities cannot ship with a plan, and the answer decides whether #59 puts
//      wiring in the ghost layer or tells the player to draw it.
//   F. (added after A came back ambiguous) which of several recipe signals does a machine take, when the
//      one it was hand-set to is none of them?
//   G. what does a selector combinator actually do in 2.0 -- `select` and `random` both drive a machine?
//   H. does that choice depend on the COUNTS, or on the order the engine lists the signals?
//   I. can two machines on ONE bus be given two DIFFERENT recipes by asking each selector for a
//      different position -- which is the whole "one group makes everything" design in one question.
//
// ANSWERS, as the engine said them on 2.0.77 (this run's output, kept here because the next reader
// should not have to start a server to learn what the layout is allowed to assume):
//
//   A/F/H -- a machine takes exactly ONE recipe off a wire that carries several, and it is stable:
//      three reads, same answer. It is not the recipe the machine was told (`F before=nil`: connecting
//      the wire clears the hand-set recipe outright), it is not the first entry of `n.signals` (H listed
//      `steel-plate=9, iron-gear-wheel=5, copper-cable=1` and the machine ran iron-gear-wheel), and it is
//      not the biggest or smallest count. Which rule it follows was not found, and that is the answer:
//      a plan may not put two recipe signals on one machine's wire and claim to know what it will build.
//   B -- the 1.1 selector shape is gone: `mode`/`sort_mode`/`input_source`/`output` raise
//      ("attempt to index field 'combinator_mode' (a nil value)"). Also from B: a controlled machine
//      whose wire carries item signals and no recipe signal ends up with NO recipe.
//   C -- `recipe_locked` wins and the wire is dead: locked, given `iron-gear-wheel`, fed `copper-cable`
//      over a wire, still `iron-gear-wheel` after 60 ticks. So a plan that lays a controller must NOT
//      lock the recipe, and a plan that locks it must not claim the controller does anything.
//   D -- `circuit_set_recipe` with no wire at all keeps the hand-set recipe and tries to run it
//      (`status=item_ingredient_shortage`, not a "waiting for signal" state). An unpowered controller
//      is reported as such: the ad-hoc version of act I, run without the grid source, read
//      `no_power` on the machines and an empty selector output. A controller is an electrical consumer
//      of the layout, not a sticker on the machine.
//   E -- a wire CAN exist between two ghosts. `connect_to` on two ghost connectors returned true;
//      ~60 ticks later the assembler ghost's green connector reads `connection_count=1`,
//      `real_connection_count=0`, `is_ghost=true`, and `get_circuit_network` on the ghost is `nil`.
//      So the wiring ships with the ghosts and the player sees it before building, and it carries
//      nothing until the entities are real -- which is exactly right, since a ghost has no recipe.
//   G/I -- the selector works, and its rule is readable: `operation = "select"` sorts the input signals
//      by count (`select_max = false` ascending, `true` descending -- the name is the direction it
//      compares *from*, not what it hands back) and `index_constant` is a ZERO-BASED position in that
//      list. Three data points agree: {cable=1, gear=7} at index 1 ascending gave `iron-gear-wheel=7`;
//      the same at index 1 descending gave `copper-cable=1`; and on a bus of {cable=1, gear=5,
//      steel=9}, index 1 gave `iron-gear-wheel=5` while index 2 gave `steel-plate=9`. That is the
//      arbitration #61 wanted -- "the shortest of these" is index 0 ascending, and N machines on one bus
//      each take a different recipe by asking for a different index, no script running.
//   G -- `operation = "random"` with `random_update_interval = 20` moved one machine between two
//      recipes across five reads without anything driving it. A rotating line is therefore a static
//      design the engine runs by itself, which is the difference between a plan that ships and a plan
//      that needs the mod loaded forever.
//   I -- and when a wire names a recipe the machine cannot do (`steel-plate` is a furnace recipe, put on
//      an assembler), the machine holds no recipe and says `status=no_recipe`. The engine names the
//      failure, so a plan that assigns wrong recipes to wrong hardware can be caught rather than
//      explained after the fact.
//   J -- which entities can hold a wire, asked with `or_create = true`: belts, chests, poles,
//      accumulators, assemblers, furnaces, centrifuges, pumpjacks, offshore pumps, radars, inserters and
//      the three combinators that think all offer circuit terminals (`[1/2]`, combinators also `[3/4]`),
//      while a pipe, an underground belt, a boiler, a steam engine and a LAB offer none -- so a plan that
//      wanted to gate a lab by signal would be refused, and the refusal is the engine's, quoted per wire.
//      A constant combinator is `[1/2]` only: it has no input face, which is the same fact that makes it
//      the one emitter script cannot drive, seen from the connector side.
//   J -- and a script-drawn wire has NO reach limit: `connect_to` returned true and the connector's
//      `connection_count` climbed at every centre distance from 3 to 14 tiles. That is the engine not
//      applying a player's drag range to a script, and it cuts against this file's usual hope -- a
//      layout cannot rely on the engine to refuse an absurd span, so the span is the mod's own judgement
//      and the plan has to say what it drew.
//   K -- and the one that changed the design: **a wire drawn between two ghosts does not survive being
//      built.** Drawn (act E), then the two ghosts replaced by real entities on their own cells the way
//      a blueprint does it, and the real machine's connectors read `connection_count=0`,
//      `real_connection_count=0`, `get_circuit_network = nil`. A ghost is not edited into an entity, it
//      is discarded and a new one arrives, and the wire goes with it. So shipping a plan with its
//      circuit drawn is two jobs: draw it on the ghosts so the preview is honest, and draw it AGAIN on
//      the real entities. `card_place` cannot do the second half, because it returns before the player
//      builds anything -- which is where the deployment ledger and a build event come in.
//   L -- and the same for the controller's own settings, measured both sides of the build so the two
//      questions cannot be confused: a `parameters` write on a GHOST decider is accepted and reads back
//      off that ghost (`first_output=copper-cable`), and after the ghost is built the entity standing on
//      the same cell reads `first_output=nil` with `circuit_set_recipe=false` on the machine beside it.
//      A ghost holds nothing that outlives it. So "this line is signal-controlled" is a statement about
//      what is written AFTER the build, and `card_place` applying intents to ghosts would be theatre --
//      a preview that looks configured and a factory that is not. This is the answer that put the
//      circuit intents into the same ledger as the wires rather than into the placement call.
//
// A probe, not a gate: it prints what the engine said and exits 0 either way. Cleanup unmakes exactly
// what was placed, by unit number -- a rectangle sweep here once destroyed 277 entities belonging to
// other rigs' synthetic ore fields, which is a worse outcome than leaving a mess.
const { execFileSync } = require("child_process");
require("./suite-guard.js").guardMain("circuit_rules_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016", RCON_PW: process.env.RCON_PW || "testpw" };
const run = (src) => execFileSync(process.execPath, ["dev/lua.js", src],
  { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RCON_IDLE_MS: process.env.RCON_IDLE_MS || "25000" } }).trim();
const call = (m, a) => JSON.parse(execFileSync(process.execPath, ["dev/call.js", m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms || 4000})`], { env: ENV });

const X = 200, Y = 200;   // far from every rig's fixed coordinates, so nothing else is in the box
const HEAD = `
local s = game.surfaces["arch-lab"]
local f = game.forces.player
local W = defines.wire_connector_id
local X, Y = ${X}, ${Y}
-- Idempotent, because every act prepends this and the state the cleanup reads has to be the whole
-- run's: a table rebuilt per act would forget the entities the earlier acts placed.
_G.RP = _G.RP or {units = {}}
local function put(n, dx, dy)
  local e = s.create_entity{name = n, position = {x = X + dx + 0.5, y = Y + dy + 0.5}, force = f.name}
  if e then _G.RP.units[e.unit_number] = n end
  return e
end
local function link(from, to, from_id, to_id)
  local ok, err = pcall(function()
    from.get_wire_connector(from_id, true).connect_to(to.get_wire_connector(to_id, true), false,
      defines.wire_origin.script)
  end)
  return ok and true or tostring(err):sub(1, 60)
end
local function wire_of(e)
  local n = e.get_circuit_network(W.circuit_green)
  local out = {}
  if n and n.signals then
    for _, p in ipairs(n.signals) do
      local g = p[1] or p.signal
      out[#out + 1] = tostring(g and g.name) .. "=" .. tostring(p[2] or p.count)
    end
  end
  local r = e.get_recipe and e.get_recipe()
  return "recipe=" .. tostring(r and r.name) .. " wire=[" .. table.concat(out, ", ") .. "]"
end
local function status(e)
  local st
  pcall(function() st = e.status end)
  local name = tostring(st)
  for k, v in pairs(defines.entity_status) do if v == st then name = k end end
  return name
end
-- The grid, and the record of whether it was already merged so the cleanup can put it back. Recorded
-- once: read a second time it would see the first act's merge and report the surface as global before
-- we made it so, leaving it that way.
if _RP_WAS_GLOBAL == nil then _RP_WAS_GLOBAL = s.has_global_electric_network end
if not s.has_global_electric_network then s.create_global_electric_network() end
if not _G.RP.source then _G.RP.source = put("electric-energy-interface", 14, 0) end
`;

// A: one machine, one wire, two recipe signals -- read it three times with real ticks in between.
const ACT_A = HEAD + `
local m = put("assembling-machine-2", 0, 0)
local d = put("decider-combinator", 4, 0)
d.get_or_create_control_behavior().parameters = {
  conditions = {{comparator = "<", constant = 1}},
  outputs = {{signal = {type = "recipe", name = "iron-gear-wheel"}, constant = 1, copy_count_from_input = false},
             {signal = {type = "recipe", name = "copper-cable"}, constant = 1, copy_count_from_input = false}}}
local cb = m.get_or_create_control_behavior()
cb.circuit_set_recipe = true
m.set_recipe("iron-gear-wheel")
rcon.print("A link=" .. tostring(link(d, m, W.combinator_output_green, W.circuit_green)))
`;
const READ_A = `
local s = game.surfaces["arch-lab"]
local m = nil
for _, e in ipairs(s.find_entities_filtered{area = {{${X} - 1, ${Y} - 1}, {${X} + 1, ${Y} + 1}}, type = "assembling-machine"}) do m = e end
if not m then rcon.print("A machine missing") return end
local n = m.get_circuit_network(defines.wire_connector_id.circuit_green)
local cnt = n and #((n.signals) or {}) or -1
rcon.print("A read: " .. "wire_size=" .. cnt .. " recipe=" .. tostring((m.get_recipe() or {}).name)
  .. " status=" .. (function()
      local st; pcall(function() st = m.status end)
      for k, v in pairs(defines.entity_status) do if v == st then return k end end
      return tostring(st)
    end)())
`;

// B: the 1.1 selector shape, kept because two answers came out of writing it. One is the shape:
// `mode`/`sort_mode`/`input_source`/`output` raise on 2.0.77 ("attempt to index field
// 'combinator_mode' (a nil value)"), and what the engine does have is `operation` -- act G. The other
// is the machine's side, and it was not known before this: a controlled assembler whose wire carries
// item signals and no recipe signal ends up with NO recipe at all (`recipe=nil` five tiles from a wire
// holding `iron-plate=5`). A rotation group therefore has to be fed recipe signals or its machines
// stand idle, and "the bus has counts on it" is not the same as "the bus is telling machines what to
// build".
const ACT_B = HEAD + `
local m = put("assembling-machine-2", 0, 6)
local sel = put("selector-combinator", 4, 6)
local feed = put("decider-combinator", 0, 9)
feed.get_or_create_control_behavior().parameters = {
  conditions = {{comparator = "<", constant = 1}},
  outputs = {{signal = {type = "item", name = "iron-plate"}, constant = 5, copy_count_from_input = false},
             {signal = {type = "item", name = "copper-plate"}, constant = 2, copy_count_from_input = false}}}
local okp, errp = pcall(function()
  sel.get_or_create_control_behavior().parameters = {
    mode = defines.combinator_mode.min, sort_mode = defines.combinator_sort_mode.count_by_signals,
    input_source = {type = "item", name = nil}, output = "index"}
end)
link(feed, sel, W.combinator_output_green, W.combinator_input_green)
link(sel, m, W.combinator_output_green, W.circuit_green)
local cb = m.get_or_create_control_behavior()
cb.circuit_set_recipe = true
rcon.print("B parameters=" .. tostring(okp) .. (okp and "" or (" RAISED " .. tostring(errp):sub(1, 90)))
  .. " link=" .. tostring(link))
`;
const READ_B = `
local s = game.surfaces["arch-lab"]
local out = {}
for _, e in ipairs(s.find_entities_filtered{area = {{${X} - 1, ${Y} + 5}, {${X} + 6, ${Y} + 7}}}) do
  out[#out + 1] = e.name
end
local m = (s.find_entities_filtered{area = {{${X} - 1, ${Y} + 5}, {${X} + 1, ${Y} + 7}}, type = "assembling-machine"})[1]
local n = m and m.get_circuit_network(defines.wire_connector_id.circuit_green)
local sig = {}
if n and n.signals then for _, p in ipairs(n.signals) do
  local g = p[1] or p.signal sig[#sig + 1] = tostring(g and g.name) .. "=" .. tostring(p[2] or p.count) end end
rcon.print("B entities=[" .. table.concat(out, ",") .. "] wire=[" .. table.concat(sig, ", ") .. "]"
  .. " recipe=" .. tostring(m and m.get_recipe() and m.get_recipe().name))
`;

// C: a locked recipe against a wire that names another one.
const ACT_C = HEAD + `
local m = put("assembling-machine-2", 0, 12)
local d = put("decider-combinator", 4, 12)
d.get_or_create_control_behavior().parameters = {
  conditions = {{comparator = "<", constant = 1}},
  outputs = {{signal = {type = "recipe", name = "copper-cable"}, constant = 1, copy_count_from_input = false}}}
local cb = m.get_or_create_control_behavior()
cb.circuit_set_recipe = true
m.set_recipe("iron-gear-wheel")
m.recipe_locked = true
link(d, m, W.combinator_output_green, W.circuit_green)
rcon.print("C locked=" .. tostring(m.recipe_locked))
`;
const READ_C = `
local s = game.surfaces["arch-lab"]
local m = (s.find_entities_filtered{area = {{${X} - 1, ${Y} + 11}, {${X} + 1, ${Y} + 13}}, type = "assembling-machine"})[1]
rcon.print("C recipe=" .. tostring(m and m.get_recipe() and m.get_recipe().name)
  .. " locked=" .. tostring(m and m.recipe_locked))
`;

// D: circuit_set_recipe with nothing on the wire -- the name of that status, not its number.
const ACT_D = HEAD + `
local m = put("assembling-machine-2", 0, 18)
local cb = m.get_or_create_control_behavior()
cb.circuit_set_recipe = true
m.set_recipe("iron-gear-wheel")
rcon.print("D before: recipe=" .. tostring((m.get_recipe() or {}).name))
`;
const READ_D = `
local s = game.surfaces["arch-lab"]
local m = (s.find_entities_filtered{area = {{${X} - 1, ${Y} + 17}, {${X} + 1, ${Y} + 19}}, type = "assembling-machine"})[1]
if not m then rcon.print("D missing") return end
local st; pcall(function() st = m.status end)
local named = tostring(st)
for k, v in pairs(defines.entity_status) do if v == st then named = k end end
rcon.print("D after: recipe=" .. tostring((m.get_recipe() or {}).name) .. " status=" .. named)
`;

// E: the question this mod actually has to answer, because it lays ghosts and not buildings. The API
// says a wire connector's owner "may return entity ghost instead", and counts ghost wires separately
// from real ones -- so a wire between two ghosts is a thing the engine knows about. If a script can draw
// one, a plan can ship with its wiring; if it cannot, #59 has to tell the player to draw the last line
// themselves, and that belongs in the answer, not in a README.
//
// The ghosts are made by the same `create_entity{name = "entity-ghost", inner_name = ...}` call
// `card_place` makes (control.lua:4889), so the answer is about a plan's ghosts and not about a
// hand-built pair.
const CLEAN = `
local s = game.surfaces["arch-lab"]
local n = 0
for _, e in ipairs(s.find_entities_filtered{area = {{${X} - 2, ${Y} - 2}, {${X} + 20, ${Y} + 97}}}) do
  if e.valid and _G.RP and _G.RP.units[e.unit_number] then e.destroy(); n = n + 1 end
end
local note = "grid was already global, left alone"
if _RP_WAS_GLOBAL == false then
  local ok = pcall(function() s.destroy_global_electric_network() end)
  note = "grid unmerged=" .. tostring(ok)
end
_G.RP = nil _RP_WAS_GLOBAL = nil
rcon.print("cleaned " .. n .. " placed entities; " .. note .. " now_global="
  .. tostring(s.has_global_electric_network))
`;

// F: which of two recipe signals a machine takes, told apart from "it kept what it was given" by
// handing it a recipe that is on neither. A's answer was ambiguous -- iron-gear-wheel was both the
// hand-set recipe and the first signal listed -- and the difference matters: if the engine picks by
// order, a plan can put its preferred recipe first and a bus is a priority chain; if it picks by
// count, or flips, a bus is a lottery and one wire per machine is the only honest layout.
const ACT_F = HEAD + `
local m = put("assembling-machine-2", 0, 36)
local d = put("decider-combinator", 4, 36)
d.get_or_create_control_behavior().parameters = {
  conditions = {{comparator = "<", constant = 1}},
  outputs = {{signal = {type = "recipe", name = "copper-cable"}, constant = 1, copy_count_from_input = false},
             {signal = {type = "recipe", name = "iron-gear-wheel"}, constant = 1, copy_count_from_input = false}}}
local cb = m.get_or_create_control_behavior()
cb.circuit_set_recipe = true
m.set_recipe("iron-plate")     -- on neither signal, so any recipe seen after this came off the wire
rcon.print("F link=" .. tostring(link(d, m, W.combinator_output_green, W.circuit_green))
  .. " before=" .. tostring((m.get_recipe() or {}).name))
`;
const READ_F = `
local s = game.surfaces["arch-lab"]
local m = (s.find_entities_filtered{area = {{${X} - 1, ${Y} + 35}, {${X} + 1, ${Y} + 37}}, type = "assembling-machine"})[1]
if not m then rcon.print("F missing") return end
local n = m.get_circuit_network(defines.wire_connector_id.circuit_green)
local sig = {}
if n and n.signals then for _, p in ipairs(n.signals) do
  local g = p[1] or p.signal sig[#sig + 1] = tostring(g and g.name) .. "=" .. tostring(p[2] or p.count) end end
rcon.print("F read: wire=[" .. table.concat(sig, ", ") .. "] recipe=" .. tostring((m.get_recipe() or {}).name))
`;

// G: the selector operations a rotation would be built out of, written in the shape this engine
// actually has -- `operation = "select" | "random"`, not 1.1's `mode`/`sort_mode`, which raised in
// act B and is what `dev/api_query.js class`-style lookup of `SelectorCombinatorParameters` says.
// If `random` + `random_update_interval` moves a machine's recipe by itself, a multi-recipe line needs
// no script driving it tick after tick -- the difference between a plan that ships and a plan that
// needs the mod to stay running beside it.
//
// Every link's answer is printed and every selector is read on BOTH sides, because the first version
// of this act discarded `link` and read only the machine: it reported "the selector emits nothing",
// which was indistinguishable from "the wire to the selector was refused". Those are different answers
// and only one of them is about selectors.
const ACT_G = HEAD + `
local function feed(dx, dy)
  local d = put("decider-combinator", dx, dy)
  d.get_or_create_control_behavior().parameters = {
    conditions = {{comparator = "<", constant = 1}},
    outputs = {{signal = {type = "recipe", name = "copper-cable"}, constant = 1, copy_count_from_input = false},
               {signal = {type = "recipe", name = "iron-gear-wheel"}, constant = 7, copy_count_from_input = false}}}
  return d
end
local function pair(dy, params)
  local m = put("assembling-machine-2", 0, dy)
  local sel = put("selector-combinator", 2, dy)
  local src = feed(2, dy + 3)
  local okp, errp = pcall(function() sel.get_or_create_control_behavior().parameters = params end)
  local in_wire = link(src, sel, W.combinator_output_green, W.combinator_input_green)
  local out_wire = link(sel, m, W.combinator_output_green, W.circuit_green)
  m.get_or_create_control_behavior().circuit_set_recipe = true
  rcon.print("G pair y=" .. dy .. " params=" .. (okp and "ok" or ("RAISED " .. tostring(errp):sub(1, 90)))
    .. " feed->sel=" .. tostring(in_wire) .. " sel->machine=" .. tostring(out_wire)
    .. " sel.units=" .. tostring(sel.unit_number) .. " m.units=" .. tostring(m.unit_number))
  return { machine = m, selector = sel }
end
pair(42, {operation = "select", select_max = false, index_constant = 1})
pair(46, {operation = "select", select_max = true, index_constant = 1})
pair(50, {operation = "random", random_update_interval = 20})
`;
const READ_G = `
local s = game.surfaces["arch-lab"]
local W = defines.wire_connector_id
local function net(e, id)
  local n = e.get_circuit_network(id)
  local out = {}
  if n and n.signals then for _, p in ipairs(n.signals) do
    local g = p[1] or p.signal
    out[#out + 1] = tostring((g and (g.type or "?") .. ":" .. (g.name or "?"))) .. "=" .. tostring(p[2] or p.count)
  end end
  return "[" .. table.concat(out, ", ") .. "]"
end
local out = {}
for _, dy in ipairs({42, 46, 50}) do
  local m = (s.find_entities_filtered{area = {{${X} - 1, ${Y} + dy - 1}, {${X} + 1, ${Y} + dy + 1}},
    type = "assembling-machine"})[1]
  local sel = (s.find_entities_filtered{area = {{${X} + 1, ${Y} + dy - 1}, {${X} + 3, ${Y} + dy + 1}},
    name = "selector-combinator"})[1]
  if m and sel then
    out[#out + 1] = "y" .. dy .. " in" .. net(sel, W.combinator_input_green) .. " out"
      .. net(sel, W.combinator_output_green) .. " machine" .. net(m, W.circuit_green)
      .. " recipe=" .. tostring((m.get_recipe() or {}).name)
  else
    out[#out + 1] = "y" .. dy .. " missing(m=" .. tostring(m ~= nil) .. " sel=" .. tostring(sel ~= nil) .. ")"
  end
end
rcon.print("G read: " .. table.concat(out, " | "))
`;

// H: three recipe signals on one wire, deliberately unequal -- 1, 5 and 9. F showed the machine takes
// exactly one of two and never flips, but both counts were 1, so "by count" and "by signal identity"
// were still the same answer. Which of them it is decides whether a wire is a priority chain a plan
// can write, or a list the engine sorts its own way.
const ACT_H = HEAD + `
local m = put("assembling-machine-2", 0, 56)
local d = put("decider-combinator", 2, 56)
d.get_or_create_control_behavior().parameters = {
  conditions = {{comparator = "<", constant = 1}},
  outputs = {{signal = {type = "recipe", name = "copper-cable"}, constant = 1, copy_count_from_input = false},
             {signal = {type = "recipe", name = "iron-gear-wheel"}, constant = 5, copy_count_from_input = false},
             {signal = {type = "recipe", name = "steel-plate"}, constant = 9, copy_count_from_input = false}}}
m.get_or_create_control_behavior().circuit_set_recipe = true
rcon.print("H wire=" .. tostring(link(d, m, W.combinator_output_green, W.circuit_green))
  .. " has_recipe=" .. tostring(m.get_recipe() ~= nil))
`;
const READ_H = `
local s = game.surfaces["arch-lab"]
local m = (s.find_entities_filtered{area = {{${X} - 1, ${Y} + 55}, {${X} + 1, ${Y} + 57}}, type = "assembling-machine"})[1]
if not m then rcon.print("H missing") return end
local n = m.get_circuit_network(defines.wire_connector_id.circuit_green)
local order = {}
if n and n.signals then for _, p in ipairs(n.signals) do
  local g = p[1] or p.signal order[#order + 1] = tostring(g and g.name) .. "=" .. tostring(p[2] or p.count) end end
rcon.print("H list=[" .. table.concat(order, ", ") .. "] first=" .. tostring(order[1])
  .. " recipe=" .. tostring((m.get_recipe() or {}).name))
`;

// I: one bus, two machines, two positions. `index_constant` is asked for 1 and 2 with the same
// ascending sort, so if the positions are real the two machines must land on different recipes -- and
// that is the whole "a group of assemblers covers a set of items" design measured in one act. Written
// into this file because the first time it was run by hand it read `no_power` everywhere: the ad-hoc
// version had skipped HEAD's grid source, and a selector with no electricity emits nothing at all.
const ACT_I = HEAD + `
local m1 = put("assembling-machine-2", 0, 60)
local s1 = put("selector-combinator", 2, 60)
local feed = put("decider-combinator", 2, 63)
local m2 = put("assembling-machine-2", 0, 66)
local s2 = put("selector-combinator", 2, 66)
feed.get_or_create_control_behavior().parameters = {
  conditions = {{comparator = "<", constant = 1}},
  outputs = {{signal = {type = "recipe", name = "copper-cable"}, constant = 1, copy_count_from_input = false},
             {signal = {type = "recipe", name = "iron-gear-wheel"}, constant = 5, copy_count_from_input = false},
             {signal = {type = "recipe", name = "steel-plate"}, constant = 9, copy_count_from_input = false}}}
s1.get_or_create_control_behavior().parameters = {operation = "select", select_max = false, index_constant = 1}
s2.get_or_create_control_behavior().parameters = {operation = "select", select_max = false, index_constant = 2}
-- Both machines are switched to network control BEFORE the wires are reported: the first version of
-- this act printed the link results by joining 'link' booleans with table.concat, which raised, and the
-- raise stopped the command before these two lines ran. The read then reported 'no_recipe' on machines
-- that had never been told to watch a wire -- a wrong answer about the engine, caused by a string join.
-- Wrap every link in tostring, and never let the report be the last thing in the act.
m1.get_or_create_control_behavior().circuit_set_recipe = true
m2.get_or_create_control_behavior().circuit_set_recipe = true
rcon.print("I wires=" .. table.concat({
  tostring(link(feed, s1, W.combinator_output_green, W.combinator_input_green)),
  tostring(link(feed, s2, W.combinator_output_green, W.combinator_input_green)),
  tostring(link(s1, m1, W.combinator_output_green, W.circuit_green)),
  tostring(link(s2, m2, W.combinator_output_green, W.circuit_green)),
}, ","))
`;
const READ_I = `
local s = game.surfaces["arch-lab"]
local W = defines.wire_connector_id
local function net(e, id)
  local n = e.get_circuit_network(id)
  local out = {}
  if n and n.signals then for _, p in ipairs(n.signals) do
    local g = p[1] or p.signal out[#out + 1] = tostring(g and g.name) .. "=" .. tostring(p[2] or p.count) end end
  return "[" .. table.concat(out, ", ") .. "]"
end
local function status(e)
  local st; pcall(function() st = e.status end)
  for k, v in pairs(defines.entity_status) do if v == st then return k end end
  return tostring(st)
end
local out = {}
for _, dy in ipairs({60, 66}) do
  local m = (s.find_entities_filtered{area = {{${X}, ${Y} + dy}, {${X} + 1, ${Y} + dy + 1}},
    type = "assembling-machine"})[1]
  local sel = (s.find_entities_filtered{area = {{${X} + 2, ${Y} + dy}, {${X} + 3, ${Y} + dy + 1}},
    name = "selector-combinator"})[1]
  if m and sel then
    out[#out + 1] = "y" .. dy .. " selIn" .. net(sel, W.combinator_input_green) .. " selOut"
      .. net(sel, W.combinator_output_green) .. " machineWire" .. net(m, W.circuit_green)
      .. " recipe=" .. tostring((m.get_recipe() or {}).name) .. " status=" .. status(m)
  else
    out[#out + 1] = "y" .. dy .. " missing"
  end
end
rcon.print("I read: " .. table.concat(out, " | "))
`;

// J: the two facts a layout needs before it can promise a wire, and neither is guessable. Which entity
// TYPES carry a circuit terminal decides whether a refusal is correct or a false alarm; how far a
// script-drawn wire reaches decides how far a controller may stand from the machine it drives.
//
// The connector census asks with `or_create = true`. Asked with `false` the same call answers `[]` for
// every machine, belt and chest in the game and a list of ids for the combinators, which is a true
// statement about which control behaviours happen to exist already and would have been recorded here as
// "only combinators can hold a wire" -- wrong in the direction that breaks every plan.
//
// The gap loop reads `connect_to`'s RETURN and the connectors' counts, not just whether the call
// raised: the first version of this act printed `ok=true` for twelve distances because pcall's first
// value says "no error", and the engine's own answer was thrown away. Same bug, one act earlier, in I.
const ACT_J = HEAD + `
local NAMES = {"transport-belt", "underground-belt", "splitter", "pipe", "wooden-chest", "iron-chest",
  "small-electric-pole", "medium-electric-pole", "accumulator", "boiler", "steam-engine", "solar-panel",
  "assembling-machine-1", "electric-furnace", "centrifuge", "lab", "pumpjack", "offshore-pump", "radar",
  "fast-inserter", "arithmetic-combinator", "decider-combinator", "selector-combinator",
  "constant-combinator"}
local XJ, YJ = ${X}, ${Y} + 72
local seen = {}
for i, nm in ipairs(NAMES) do
  local ok, e = pcall(function()
    return s.create_entity{name = nm, position = {x = XJ + (i % 14) * 3, y = YJ + math.floor(i / 14) * 4}, force = f.name}
  end)
  if not ok or not e then
    seen[#seen + 1] = nm .. "=no(" .. (ok and "nil" or tostring(e):sub(1, 34)) .. ")"
  else
    _G.RP.units[e.unit_number] = nm
    local ids = {}
    local ok2, cs = pcall(function() return e.get_wire_connectors(true) end)
    if ok2 then for _, c in ipairs(cs) do ids[#ids + 1] = tostring(c.wire_connector_id) end end
    seen[#seen + 1] = nm .. "=" .. (ok2 and ("[" .. table.concat(ids, "/") .. "]") or ("RAISED " .. tostring(cs):sub(1, 34)))
    e.destroy()
  end
end
rcon.print("J connectors(or_create): " .. table.concat(seen, " "))
-- The gap: one decider held still, the other walked east, wiring attempted at each centre distance and
-- the answer read back off both connectors -- "did the engine say yes" and "is there now a connection"
-- are two questions and only the second one is about wires.
local box = prototypes.entity["decider-combinator"]
local base = put("decider-combinator", 0, 82)
local cb = base.get_wire_connector(W.combinator_output_green, true)
local gaps = {}
for gap = 1, 12 do
  local far = put("decider-combinator", 1 + gap, 82)
  local cf = far.get_wire_connector(W.combinator_input_green, true)
  local ok, ret = pcall(function() return cb.connect_to(cf, false, defines.wire_origin.script) end)
  gaps[#gaps + 1] = (2 + gap) .. ":" .. tostring(ok and ret or ("raised " .. tostring(ret):sub(1, 30)))
    .. "/n" .. tostring(cb.connection_count)
end
rcon.print("J gap: decider is " .. tostring(box and box.tile_width) .. "x" .. tostring(box and box.tile_height)
  .. ", centre distance -> " .. table.concat(gaps, " "))
`;

// K: the question that decides where the wiring lives. A wire between two ghosts is drawn (act E) and
// the player can see it in the preview -- but a ghost is replaced by a new entity when it is built, not
// edited, so the connection may well go with it. If it does, shipping a plan with its circuit drawn is
// only half the job: something has to draw it a second time on the real entities, and that is a feature
// with its own answer, not a detail of this one.
const ACT_K = HEAD + `
local function ghost(inner, dx, dy)
  local e = s.create_entity{name = "entity-ghost", inner_name = inner,
    position = {x = ${X} + dx + 0.5, y = ${Y} + dy + 0.5}, force = f.name}
  if e then _G.RP.units[e.unit_number] = "ghost:" .. inner end
  return e
end
local gm = ghost("assembling-machine-2", 0, 88)
local gd = ghost("decider-combinator", 4, 88)
if not (gm and gd) then rcon.print("K no ghosts (m=" .. tostring(gm ~= nil) .. " d=" .. tostring(gd ~= nil) .. ")") return end
local cm = gm.get_wire_connector(W.circuit_green, true)
local cd = gd.get_wire_connector(W.combinator_output_green, true)
local wired = cd.connect_to(cm, false, defines.wire_origin.script)
rcon.print("K drawn=" .. tostring(wired) .. " ghost machine n=" .. tostring(cm.connection_count)
  .. " real=" .. tostring(cm.real_connection_count))
-- Build them the way a blueprint does: the new entity arrives on the ghost's own cell.
local rm = s.create_entity{name = "assembling-machine-2", position = gm.position, force = f.name}
local rd = s.create_entity{name = "decider-combinator", position = gd.position, force = f.name}
if rm then _G.RP.units[rm.unit_number] = "assembling-machine-2" end
if rd then _G.RP.units[rd.unit_number] = "decider-combinator" end
local kept, net = {}, "nil"
if rm then
  for _, c in ipairs(rm.get_wire_connectors(true)) do
    kept[#kept + 1] = tostring(c.wire_connector_id) .. "{n=" .. tostring(c.connection_count)
      .. ",real=" .. tostring(c.real_connection_count) .. "}"
  end
  net = tostring(rm.get_circuit_network(W.circuit_green) ~= nil)
end
rcon.print("K after building: ghosts_left="
  .. #s.find_entities_filtered{name = "entity-ghost", area = {{${X}, ${Y} + 87}, {${X} + 7, ${Y} + 90}}}
  .. " built=" .. tostring(rm ~= nil) .. "," .. tostring(rd ~= nil)
  .. " machine connectors=" .. table.concat(kept, " ") .. " has_network=" .. net)
`;

// L: the same question act K asked about wires, asked about the other half of a signal-controlled line.
// A plan that lays a controller has to say what the controller does -- a decider's `parameters`, a
// machine's `circuit_set_recipe` -- and it says it at placement time, when everything on the ground is
// still a ghost. If a ghost holds no control behaviour, or holds one that does not survive being built,
// then the behaviour belongs in the ledger beside the wire and has to be written after the build, and
// that is a different feature with its own answer.
const ACT_L = HEAD + `
local function gh(inner, dx)
  local e = s.create_entity { name = "entity-ghost", inner_name = inner,
    position = { x = ${X} + dx + 0.5, y = ${Y} + 94.5 }, force = f.name }
  if e then _G.RP.units[e.unit_number] = "ghost:" .. inner end
  return e
end
local gd, gm = gh("decider-combinator", 0), gh("assembling-machine-2", 5)
if not (gd and gm) then rcon.print("L no ghosts") return end
local EMIT = {conditions = {{comparator = "<", constant = 1}},
  outputs = {{signal = {type = "recipe", name = "copper-cable"}, constant = 1,
              copy_count_from_input = false}}}
local function try(fn)
  local ok, err = pcall(fn)
  return ok and "written" or ("RAISED " .. tostring(err):sub(1, 90))
end
rcon.print("L on the ghosts: decider " .. try(function()
    gd.get_or_create_control_behavior().parameters = EMIT end)
  .. " | machine " .. try(function()
    gm.get_or_create_control_behavior().circuit_set_recipe = true end))
-- Read the same fields back off the GHOSTS before anything is built. Without this second look the
-- question "did the write take?" and the question "did it survive the build?" collapse into one
-- answer, and only the second one is about placement.
local function ghost_read(e, field)
  local ok, v = pcall(function() return e.get_or_create_control_behavior()[field] end)
  if not ok then return "raise" end
  if field == "circuit_set_recipe" then return tostring(v) end
  return tostring(v and v.outputs and ((v.outputs[1] or {}).signal or {}).name)
end
rcon.print("L read back on ghosts: decider first_output=" .. ghost_read(gd, "parameters")
  .. " machine circuit_set_recipe=" .. ghost_read(gm, "circuit_set_recipe"))
-- Build them: destroy the ghost, then create the entity it stood for at the same position. The other
-- way round -- calling create_entity on a cell a ghost still holds -- answers nil on 2.0.77, which is how
-- the first version of this act reported "built=false,false" and learned nothing.
local pd, pm = gd.position, gm.position
gd.destroy() gm.destroy()
local rd = s.create_entity { name = "decider-combinator", position = pd, force = f.name }
local rm = s.create_entity { name = "assembling-machine-2", position = pm, force = f.name }
if rd then _G.RP.units[rd.unit_number] = "decider-combinator" end
if rm then _G.RP.units[rm.unit_number] = "assembling-machine-2" end
rcon.print("L built=" .. tostring(rd ~= nil) .. "," .. tostring(rm ~= nil)
  .. " | decider first_output=" .. (rd and ghost_read(rd, "parameters") or "nil")
  .. " | machine circuit_set_recipe=" .. (rm and ghost_read(rm, "circuit_set_recipe") or "nil"))
`;

console.log("== A: one wire, two recipe signals");
console.log(run(ACT_A));
for (let i = 1; i <= 3; i++) { sleep(2500); console.log(run(READ_A)); }

console.log("== B: selector arbitration");
console.log(run(ACT_B));
sleep(3000);
console.log(run(READ_B));

console.log("== C: recipe_locked against a wire");
console.log(run(ACT_C));
sleep(3000);
console.log(run(READ_C));

console.log("== D: set-recipe with an empty wire");
console.log(run(ACT_D));
sleep(3000);
console.log(run(READ_D));

console.log("== F: which of two recipe signals a machine takes");
console.log(run(ACT_F));
for (let i = 1; i <= 3; i++) { sleep(2500); console.log(run(READ_F)); }

console.log("== G: selector `select` and `random` driving a machine");
console.log(run(ACT_G));
// Sampled five times over ~15s: `random_update_interval = 20` is 20 ticks, so a rotation shows up as
// different recipes in different reads, and a fixed output shows up as the same one five times.
for (let i = 1; i <= 5; i++) { sleep(3000); console.log(run(READ_G)); }

console.log("== H: does a machine pick a recipe signal by count?");
console.log(run(ACT_H));
for (let i = 1; i <= 3; i++) { sleep(2500); console.log(run(READ_H)); }

console.log("== I: one bus, two machines, two selector positions");
console.log(run(ACT_I));
for (let i = 1; i <= 2; i++) { sleep(3000); console.log(run(READ_I)); }

console.log("== J: which entities can hold a wire, and how far one reaches");
console.log(run(ACT_J));

console.log("== K: does a wire drawn between ghosts survive being built?");
console.log(run(ACT_K));

console.log("== L: does a control behaviour written on a ghost survive being built?");
console.log(run(ACT_L));

console.log("== E: can a wire exist between two ghosts?");
console.log(run(`
local s = game.surfaces["arch-lab"]
local W = defines.wire_connector_id
local YE = ${Y} + 30
local function ghost(inner, dx)
  local e = s.create_entity { name = "entity-ghost", inner_name = inner,
    position = { x = ${X} + dx + 0.5, y = YE + 0.5 }, force = "player" }
  if e then _G.RP.units[e.unit_number] = "ghost:" .. inner end
  return e
end
local a, d = ghost("assembling-machine-2", 0), ghost("decider-combinator", 5)
if not (a and d) then rcon.print("E no ghosts (a=" .. tostring(a ~= nil) .. " d=" .. tostring(d ~= nil) .. ")") return end
local function connector(e, id)
  for _, c in ipairs(e.get_wire_connectors(true)) do if c.wire_connector_id == id then return c end end
end
local ca, cd = connector(a, W.circuit_green), connector(d, W.combinator_output_green)
rcon.print("E ghosts: " .. a.ghost_name .. " connectors=" .. #a.get_wire_connectors(true)
  .. ", " .. d.ghost_name .. " connectors=" .. #d.get_wire_connectors(true)
  .. "; wanted green=" .. tostring(ca ~= nil) .. " out=" .. tostring(cd ~= nil))
if not (ca and cd) then rcon.print("E nothing to join") return end
local ok, err = pcall(function() return ca.connect_to(cd, false, defines.wire_origin.script) end)
rcon.print("E connect_to(ghost -> ghost)=" .. tostring(ok) .. (ok and "" or (" " .. tostring(err):sub(1, 140)))
  .. " | from.is_ghost=" .. tostring(ca.is_ghost) .. " to.is_ghost=" .. tostring(cd.is_ghost))
`));
sleep(3000);
console.log(run(`
local s = game.surfaces["arch-lab"]
local W = defines.wire_connector_id
local out = {}
for _, e in ipairs(s.find_entities_filtered{name = "entity-ghost",
    area = {{${X} - 1, ${Y} + 29}, {${X} + 7, ${Y} + 31}}}) do
  local cs = {}
  for _, c in ipairs(e.get_wire_connectors(true)) do
    if c.connection_count > 0 then
      cs[#cs + 1] = tostring(c.wire_connector_id) .. "{n=" .. tostring(c.connection_count)
        .. ", real=" .. tostring(c.real_connection_count) .. ", is_ghost=" .. tostring(c.is_ghost)
        .. ", network_id=" .. tostring(c.network_id) .. "}"
    end
  end
  local ok, net = pcall(function() return e.get_circuit_network(W.circuit_green) end)
  out[#out + 1] = tostring(e.ghost_name) .. " wires=[" .. table.concat(cs, ",") .. "] net="
    .. tostring(ok and ((net and #((net.signals) or {})) or "nil") or ("RAISED " .. tostring(net):sub(1, 60)))
end
rcon.print("E after ~60 ticks: " .. table.concat(out, " | "))
`));
console.log("// " + run(CLEAN));
