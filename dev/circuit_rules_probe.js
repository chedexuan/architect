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
//   M -- one bus, five selectors at index 0..4, each driving its own machine: `select_max = false`
//      means ASCENDING by count, so index 0 is the scarcest thing on the bus (`copper-cable=1`), index 1
//      the next (`iron-gear-wheel=5`), index 2 the biggest (`steel-plate=9`, which the assembler refuses
//      by name: `no_recipe`), and index 3 and 4 -- past the end of the bus -- emit NOTHING, so those
//      machines hold no recipe and idle. No wrapping, no repeating: a short bus leaves machines empty
//      rather than doubling anyone up, which is what a group sized to a set of recipes has to plan for.
//      One more thing the same act makes usable, and then confirmed on the ground by dev/bus_line_e2e.js:
//      two selectors may ask for the SAME position, and both machines then build that recipe -- which is
//      the only form a mix can take here (2 machines on gear, 1 on cable is a 2:1 output ratio), as
//      against weighting a random pick by count, which nobody has measured.
//      The caution that cost a reading: a selector whose output has nothing attached answers `[]` from
//      `get_circuit_network`, so the first version of this act concluded "all five positions emit
//      nothing". The signals were on the wire the whole time; the reader was looking at an unconnected
//      port. Every selector here drives a machine of its own, and the machine's wire is what is read.
//      (And a third wrong reading of M's, now measured rather than argued: its ten `link` calls were
//      committed with the arguments interleaved -- (from, id, to, id) where the helper is
//      (from, to, id, id) -- so every wire in it was refused. Run as committed, the act's own line says
//      `0:'wire_connector_id': real number expected got userdata.` five times over, and the machine side
//      reads `[none] recipe=nil no_recipe` five times over: the numbers recorded above did NOT come from
//      this act, they came from act I and from dev/bus_line_e2e.js on a built line, and the error strings
//      were printed in the same run and read past. The argument order is fixed now, and with it this act
//      reproduces every one of those numbers itself -- which is the point of keeping it: a rule this file
//      states should be restated by the act named beside it, not by a neighbour.)
//   L -- and the same for the controller's own settings, measured both sides of the build so the two
//      questions cannot be confused: a `parameters` write on a GHOST decider is accepted and reads back
//      off that ghost (`first_output=copper-cable`), and after the ghost is built the entity standing on
//      the same cell reads `first_output=nil` with `circuit_set_recipe=false` on the machine beside it.
//      A ghost holds nothing that outlives it. So "this line is signal-controlled" is a statement about
//      what is written AFTER the build, and `card_place` applying intents to ghosts would be theatre --
//      a preview that looks configured and a factory that is not. This is the answer that put the
//      circuit intents into the same ledger as the wires rather than into the placement call.
//   N -- the answer that cost the most time, and it is not about signals: 2.0 RENAMED a combinator's
//      fields, and the table writer IGNORES a key it does not have. `first`, `first_input`,
//      `count_as_undefined` and `value_type` are 1.1's; the engine takes `first_signal`,
//      `first_signal_networks` (which colours the signal is read from), `compare_type` ("and"/"or", how a
//      row joins the one above it), `first_constant`/`second_signal` for arithmetic -- and has no
//      every_signal, value_type or count_as_undefined at all. Eleven translator lanes under the old
//      spelling each reported `written` and `wires=true,true`, and each emitted NOTHING: a refusal and a
//      no-op print the same answer here, so the only usable form of this measurement is a READ-BACK of
//      `cb.parameters` (printed as `cond{...}`/`arith{...}` in these acts). Note also that a chest really
//      does speak -- `N1 chest net=[nil:iron-gear-wheel=2]` -- and the `nil` type is truthful, because
//      `SignalID.type` reads back nil for an item and only carries a name for a recipe or a virtual.
//   O -- the number a shortage bus has to carry, and the hole in the obvious one. Putting the STORED
//      count on the wire and sorting ascending has a starvation bug in the representation: an item the
//      chest does not hold at all emits nothing, so the scarcest thing in the factory is the one signal
//      the bus never gets and the machine is never told to make it. What closes that hole is the
//      arithmetic box, which does the subtraction and the item-to-recipe translation in one write:
//      `first_constant = 50, second_signal = item iron-gear-wheel, operation = "-", output_signal =
//      recipe iron-gear-wheel` on a chest holding 2 put `recipe:iron-gear-wheel=48` on the wire, and the
//      machine beside it took that recipe (`status=item_ingredient_shortage`, i.e. it is trying). A chest
//      holding 60 gave `-10` -- negatives are carried, and there is no unsigned clamp in this API. A
//      signal the chest does not hold at all gave the WHOLE target, 50, which is the case the stored
//      count cannot say: an empty shelf is the biggest number on the bus, so the empty thing is the first
//      thing the line builds. And the retarget, which is the claim rather than the mechanism: after 49
//      copper-cable went into that same chest -- nothing re-wired, nothing reconfigured, no code of this
//      mod's running -- the bus read `gear=48, cable=1`, index 0 descending named gear, and the machine
//      changed its recipe to iron-gear-wheel.
//   P -- why N's deciders were mute, and it is a rule about copying rather than about chests:
//      `copy_count_from_input` copies the count of the signal the OUTPUT NAMES, as seen on its input
//      network -- not the count of the signal that satisfied the condition. Same signal in and out
//      (`item iron-gear-wheel` to `item iron-gear-wheel`) copies the chest's 2 faithfully, with both
//      colours or with green named alone; item in, recipe out copies a zero, and a zero is not carried on
//      a wire at all, so the lane says nothing. A plan therefore cannot rename a signal and keep its
//      number: the deficiency has to be COMPUTED, which is why a shortage bus is laid out of arithmetic
//      boxes and not out of deciders. P also settled what a machine does with a number that says it has
//      enough: `recipe:copper-cable=-5` on the wire and `recipe=nil` on the machine -- a line with
//      nothing short about it rests, with no gate to lay and no condition to write.
//   Q/R -- and the two readings this file got WRONG, kept because the reason is a rule. Q reported that
//      a selector at position 2 emitted nothing and R reported that both of two machines took the same
//      recipe; both were the READER, not the engine. Looking a part up by cell (`find_entities_filtered`
//      over a +-1 box around the position in the plan) cannot work when parts are 1x2 combinators and 3x3
//      assemblers: the box asked for one part contains its neighbour, so "selector 1" and "selector 2"
//      were the same entity, and a `nil` that looked like a refused position was the same answer as a
//      machine refusing a recipe it cannot run (`steel-plate` on an assembler, already measured in act I).
//      Read handles back from `_G` instead -- `game.get_entity_by_unit_number` answers nil for an entity
//      created in the same tick, so the handle itself has to be stashed -- and with that fixed, one bus
//      of `steel=50, gear=48, cable=41` and positions 0..2 handed out 50, then 48, then 41 DESCENDING and
//      1, then 3, then 10 ASCENDING: `select_max` picks the direction and `index_constant` is honoured in
//      both, which is the difference between a bus that can rank a group of machines and one that hands
//      every machine the same recipe. The consequence for the layout is that the deficiency bus runs
//      descending (biggest shortage at position 0) and gets away with it, because a machine ignores the
//      negative numbers at the bottom of that list.
//
// One more rule about this file rather than about Factorio: run ONE probe at a time. Two processes of
// this script on one server interleave their prints into one log, the second one finds the first one's
// entities already standing where its own lanes go (`create_entity` answers nil on an occupied cell),
// and the act that "did not run" did run and answered about somebody else's rig.//
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
for _, e in ipairs(s.find_entities_filtered{area = {{${X} - 2, ${Y} - 2}, {${X} + 20, ${Y} + 265}}}) do
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

// M: the rule #61 is built on, in one act. One bus with three recipe signals at unequal counts, and
// five selectors each asking for a different position, every selector driving its OWN machine --
// because a selector's output network reads `[]` when nothing is attached to it, which is how the first
// version of this act "measured" that all five positions emit nothing. The question is what a group of
// machines does when they share one bus: does position i land on a different recipe each, and what
// happens to the machines whose position the bus cannot fill.
const ACT_M = HEAD + `
local feed = put("decider-combinator", 0, 102)
feed.get_or_create_control_behavior().parameters = {
  conditions = {{comparator = "<", constant = 1}},
  outputs = {{signal = {type = "recipe", name = "copper-cable"}, constant = 1, copy_count_from_input = false},
             {signal = {type = "recipe", name = "iron-gear-wheel"}, constant = 5, copy_count_from_input = false},
             {signal = {type = "recipe", name = "steel-plate"}, constant = 9, copy_count_from_input = false}}}
local wires = {}
for i = 0, 4 do
  local sel = put("selector-combinator", 4 + i * 2, 102)
  sel.get_or_create_control_behavior().parameters = {operation = "select", select_max = false, index_constant = i}
  local m = put("assembling-machine-2", 4 + i * 2, 105)
  m.get_or_create_control_behavior().circuit_set_recipe = true
  wires[#wires + 1] = tostring(i) .. ":" .. tostring(link(feed, sel, W.combinator_output_green, W.combinator_input_green))
    .. "/" .. tostring(link(sel, m, W.combinator_output_green, W.circuit_green))
end
rcon.print("M bus of 3 signals, selector wires by index= " .. table.concat(wires, " "))
`;
const READ_M = `
local s = game.surfaces["arch-lab"]
local W = defines.wire_connector_id
local out = {}
local ms = s.find_entities_filtered{area = {{${X}, ${Y} + 104}, {${X} + 16, ${Y} + 106}}, type = "assembling-machine"}
table.sort(ms, function(a, b) return a.position.x < b.position.x end)
for _, m in ipairs(ms) do
  local n = m.get_circuit_network(W.circuit_green)
  local sig = "none"
  if n then
    sig = "empty"
    local q = (n.signals or {})[1]
    if q then local g = q[1] or q.signal sig = tostring(g and g.name) .. "=" .. tostring(q[2] or q.count) end
  end
  local st; pcall(function() st = m.status end)
  local named = tostring(st)
  for k, v in pairs(defines.entity_status) do if v == st then named = k end end
  out[#out + 1] = "[" .. sig .. "] recipe=" .. tostring((m.get_recipe() or {}).name) .. " " .. named
end
rcon.print("M machine side, index 0..4: " .. table.concat(out, " | "))
`;

// N and O: the two ways a bus could carry "which item is the factory actually short of" -- and the
// reason these two acts are as long as they are is that the engine's vocabulary for a combinator
// changed under the 1.1 field names this project had been using.
//
// The first version of both acts wrote `first` in a condition, `first_input` in an arithmetic box, and
// asked for `count_as_undefined` and `value_type`. Every one of those writes was ACCEPTED, every wire
// connected, and every lane emitted nothing -- the most misleading answer a probe can give, because it
// reads as "the chain does not work". It is not the chain. `doc-html/runtime-api.json` (via
// `node dev/api_query.js class ...`) says 2.0 renamed the fields, and the table writer IGNORES a key it
// does not have rather than raising, so a wrong spelling is indistinguishable from a refusal:
//   condition   first_signal, first_signal_networks {green, red}, second_signal, second_signal_networks,
//               constant, comparator, compare_type ("and" | "or" -- how it joins the condition above it)
//   output      signal (REQUIRED), constant, copy_count_from_input (default TRUE), networks
//   arithmetic  first_signal, first_constant, second_signal, second_constant, operation, output_signal
//               and NOTHING else: no every_signal, no value_type, no count_as_undefined
//   SignalID    {type, name, quality}; `type` reads back nil for an item, which is why a chest's own bus
//               prints "nil:iron-gear-wheel=2" below -- that is the reader being told the truth, not a bug
//               in it.
// Two consequences for a layout, both measured here rather than inferred: `each` is a condition with no
// signal named (there is no flag for it), and an arithmetic box has no per-signal mode at all -- so a
// deficiency bus is one combinator per item, which is a footprint the plan has to say out loud.
//
// The questions, one lane each:
//   N1  cross-type copy: an item on the wire, a recipe off it, the count carried across. A chest holds
//       items and a machine obeys recipes, and act B showed item signals alone leave a controlled machine
//       with no recipe at all, so this translation is not optional.
//   N2  the same translator fed by a chest instead of a scripted emitter -- does the chest really talk?
//   N3  a signal that is not on the wire at all, with no `count_as_undefined` available: can an item with
//       ZERO in the box be asked for? This is the hole in the stored-count design -- the scarcest thing is
//       the one that goes quiet, and a machine that is never told to make it never makes it.
//   N4  two translators merged onto one selector at index 0 ascending: does the machine take the scarcest?
//   N5  the retarget: the same machine read again after the chest changed.
//   N6  one decider, two conditions joined with "or", two copying outputs: does each output copy the count
//       of ITS OWN matched signal? One combinator per item versus one per line is paid for in tiles.
//   O1  target minus stored, with the target as `first_constant` and the chest's item as `second_signal`,
//       written out under a RECIPE signal -- the arithmetic and the translation in one box.
//   O2  stored above the target: a negative on the wire, or nothing? (No unsigned clamp exists.)
//   O3  stored zero: does the box read as 0 and hand out the whole target? That is the case N3 cannot.
//   O4  the whole chain: two deficiencies merged, one selector at index 0 DESCENDING (the biggest
//       deficiency is the most urgent), one machine.
//   O5  and the retarget, which is the claim: one item moved in the chest, a different recipe on the same
//       machine, nothing re-wired and nothing reconfigured, and no code of this mod's running.
const NB = 110;
const ACT_N = HEAD + `
local NB = ${NB}
local function at(nm, dx, dy) return put(nm, dx, NB + dy) end
local function stock(e, nm, cnt)
  if not e then return "no chest" end
  return tostring(e.insert{name = nm, count = cnt})
end
local function write(e, params)
  if not e then return "no entity" end
  local ok, err = pcall(function() e.get_or_create_control_behavior().parameters = params end)
  return ok and "written" or ("RAISED " .. tostring(err):sub(1, 150))
end
local function controlled(e)
  if not e then return "no entity" end
  local ok, err = pcall(function() e.get_or_create_control_behavior().circuit_set_recipe = true end)
  return ok and "set" or ("RAISED " .. tostring(err):sub(1, 60))
end
-- The read-back, because "the write did not raise" is NOT the answer "the write stored what it was
-- given" -- that is exactly the pair of facts the 1.1 field names fooled this file with.
local function stored(e)
  local ok, p = pcall(function() return e.get_or_create_control_behavior().parameters end)
  if not ok or type(p) ~= "table" then return "unreadable" end
  local c = (p.conditions or {})[1]
  if c then
    local fs = c.first_signal
    return "cond{first_signal=" .. tostring(fs and fs.type) .. ":" .. tostring(fs and fs.name)
      .. " cmp=" .. tostring(c.comparator) .. " constant=" .. tostring(c.constant)
      .. " compare_type=" .. tostring(c.compare_type) .. "}"
  end
  local ss = p.second_signal
  return "arith{first_constant=" .. tostring(p.first_constant) .. " second_signal="
    .. tostring(ss and ss.type) .. ":" .. tostring(ss and ss.name) .. " op=" .. tostring(p.operation)
    .. " out=" .. tostring((p.output_signal or {}).type) .. ":" .. tostring((p.output_signal or {}).name) .. "}"
end
-- Every signal on one connector, with its TYPE, since an item and a recipe can share a name here.
local function wire(e, cid)
  local n = e.get_circuit_network(cid)
  if not n then return "NIL" end
  local out = {}
  for _, p in ipairs(n.signals or {}) do
    local g = p[1] or p.signal
    out[#out + 1] = tostring(g and g.type) .. ":" .. tostring(g and g.name) .. "=" .. tostring(p[2] or p.count)
  end
  return "[" .. table.concat(out, ", ") .. "]"
end

rcon.print("-- N1 the translator written the way 2.0 names it")
local c1, t1, m1 = at("iron-chest", 0, 0), at("decider-combinator", 5, 0), at("assembling-machine-2", 10, 0)
rcon.print("N1 chest=" .. stock(c1, "iron-gear-wheel", 2)
  .. " decider=" .. write(t1, {
    conditions = {{first_signal = {type = "item", name = "iron-gear-wheel"}, comparator = "<", constant = 50}},
    outputs = {{signal = {type = "recipe", name = "iron-gear-wheel"}, copy_count_from_input = true}}})
  .. " " .. stored(t1))

rcon.print("-- N2 the same translator fed by a chest, and one fed by a scripted emitter")
local c2, t2, m2 = at("iron-chest", 0, 4), at("decider-combinator", 5, 4), at("assembling-machine-2", 10, 4)
rcon.print("N2 chest=" .. stock(c2, "iron-gear-wheel", 2) .. "," .. stock(c2, "copper-cable", 9)
  .. " decider=" .. write(t2, {
    conditions = {{first_signal = {type = "item", name = "iron-gear-wheel"}, comparator = "<", constant = 50}},
    outputs = {{signal = {type = "recipe", name = "iron-gear-wheel"}, copy_count_from_input = true}}})
  .. " wires=" .. tostring(link(c2, t2, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(t2, m2, W.combinator_output_green, W.circuit_green))
  .. " machine=" .. controlled(m2))
local f3, t3, m3 = at("decider-combinator", 0, 8), at("decider-combinator", 5, 8), at("assembling-machine-2", 10, 8)
rcon.print("N2 feed=" .. write(f3, {
  conditions = {{comparator = "<", constant = 1}},
  outputs = {{signal = {type = "item", name = "iron-gear-wheel"}, constant = 2, copy_count_from_input = false}}})
  .. " translator=" .. write(t3, {
    conditions = {{first_signal = {type = "item", name = "iron-gear-wheel"}, comparator = "<", constant = 50}},
    outputs = {{signal = {type = "recipe", name = "iron-gear-wheel"}, copy_count_from_input = true}}})
  .. " wires=" .. tostring(link(f3, t3, W.combinator_output_green, W.combinator_input_green))
  .. "," .. tostring(link(t3, m3, W.combinator_output_green, W.circuit_green))
  .. " machine=" .. controlled(m3))

rcon.print("-- N3 an item the chest does not hold, and the each-form of a condition")
local c4 = at("iron-chest", 0, 12)
local t4, m4 = at("decider-combinator", 5, 12), at("assembling-machine-2", 10, 12)
stock(c4, "iron-gear-wheel", 2)
rcon.print("N3 absent=" .. write(t4, {
  conditions = {{first_signal = {type = "item", name = "copper-cable"}, comparator = "<", constant = 50}},
  outputs = {{signal = {type = "recipe", name = "copper-cable"}, copy_count_from_input = true}}})
  .. " wires=" .. tostring(link(c4, t4, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(t4, m4, W.combinator_output_green, W.circuit_green))
  .. " machine=" .. controlled(m4))
local t5, m5 = at("decider-combinator", 5, 15), at("assembling-machine-2", 10, 15)
rcon.print("N3 each=" .. write(t5, {
  conditions = {{comparator = "<", constant = 50}},
  outputs = {{signal = {type = "recipe", name = "iron-gear-wheel"}, copy_count_from_input = true}}})
  .. " " .. stored(t5) .. " wires=" .. tostring(link(c4, t5, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(t5, m5, W.combinator_output_green, W.circuit_green))
  .. " machine=" .. controlled(m5))

rcon.print("-- N4 two translators merged, one selector at index 0 ascending, one machine")
local c6, tA, tB = at("iron-chest", 0, 19), at("decider-combinator", 5, 19), at("decider-combinator", 5, 21)
local s6, m6 = at("selector-combinator", 10, 20), at("assembling-machine-2", 14, 20)
rcon.print("N4 chest=" .. stock(c6, "iron-gear-wheel", 2) .. "," .. stock(c6, "copper-cable", 9)
  .. " gearT=" .. write(tA, {
    conditions = {{first_signal = {type = "item", name = "iron-gear-wheel"}, comparator = "<", constant = 50}},
    outputs = {{signal = {type = "recipe", name = "iron-gear-wheel"}, copy_count_from_input = true}}})
  .. " cableT=" .. write(tB, {
    conditions = {{first_signal = {type = "item", name = "copper-cable"}, comparator = "<", constant = 50}},
    outputs = {{signal = {type = "recipe", name = "copper-cable"}, copy_count_from_input = true}}})
  .. " sel=" .. write(s6, {operation = "select", select_max = false, index_constant = 0}))
rcon.print("N4 wires c->tA=" .. tostring(link(c6, tA, W.circuit_green, W.combinator_input_green))
  .. " c->tB=" .. tostring(link(c6, tB, W.circuit_green, W.combinator_input_green))
  .. " tA->sel=" .. tostring(link(tA, s6, W.combinator_output_green, W.combinator_input_green))
  .. " tB->sel=" .. tostring(link(tB, s6, W.combinator_output_green, W.combinator_input_green))
  .. " sel->m=" .. tostring(link(s6, m6, W.combinator_output_green, W.circuit_green))
  .. " machine=" .. controlled(m6))

rcon.print("-- N6 one decider, two conditions joined with or, two copying outputs")
local c7, t7, m7 = at("iron-chest", 0, 24), at("decider-combinator", 5, 24), at("assembling-machine-2", 10, 24)
rcon.print("N6 chest=" .. stock(c7, "iron-gear-wheel", 2) .. "," .. stock(c7, "copper-cable", 9)
  .. " decider=" .. write(t7, {
    conditions = {{first_signal = {type = "item", name = "iron-gear-wheel"}, comparator = "<", constant = 50,
                   compare_type = "or"},
                  {first_signal = {type = "item", name = "copper-cable"}, comparator = "<", constant = 50,
                   compare_type = "or"}},
    outputs = {{signal = {type = "recipe", name = "iron-gear-wheel"}, copy_count_from_input = true},
               {signal = {type = "recipe", name = "copper-cable"}, copy_count_from_input = true}}})
  .. " wires=" .. tostring(link(c7, t7, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(t7, m7, W.combinator_output_green, W.circuit_green))
  .. " machine=" .. controlled(m7))
`;
const READ_N = `
local s = game.surfaces["arch-lab"]
local W = defines.wire_connector_id
local X, Y, NB = ${X}, ${Y}, ${NB}
-- "NIL" and "[]" printed apart: a nil network is no wire at that connector, an empty one is a wire
-- carrying nothing. Collapsing them is how "the chest never speaks" and "the wire was refused" came to
-- look like one finding.
local function net(e, cid)
  if not e then return "no entity" end
  local n = e.get_circuit_network(cid)
  if not n then return "NIL" end
  local out = {}
  for _, p in ipairs(n.signals or {}) do
    local g = p[1] or p.signal
    out[#out + 1] = tostring(g and g.type) .. ":" .. tostring(g and g.name) .. "=" .. tostring(p[2] or p.count)
  end
  return "[" .. table.concat(out, ", ") .. "]"
end
local function at(nm, dx, dy)
  return (s.find_entities_filtered{name = nm,
    area = {{X + dx - 1, Y + NB + dy - 1}, {X + dx + 1, Y + NB + dy + 1}}})[1]
end
local function machine(nm, dx, dy)
  local e = at("assembling-machine-2", dx, dy)
  if not e then return "machine missing" end
  local st; pcall(function() st = e.status end)
  local named = tostring(st)
  for k, v in pairs(defines.entity_status) do if v == st then named = k end end
  local rec
  pcall(function() if e.get_recipe then rec = e.get_recipe() end end)
  return nm .. " wire=" .. net(e, W.circuit_green) .. " recipe=" .. tostring(rec and rec.name) .. " " .. named
end
rcon.print("N2 " .. machine("chest-fed", 10, 4))
rcon.print("N2 emitter-fed " .. machine("feed", 10, 8))
rcon.print("N2 emitter-fed translator out " .. net(at("decider-combinator", 5, 8), W.combinator_output_green))
rcon.print("N3 " .. machine("absent-item", 10, 12))
rcon.print("N3 translator out " .. net(at("decider-combinator", 5, 12), W.combinator_output_green))
rcon.print("N3 " .. machine("each-form", 10, 15))
rcon.print("N3 each translator out " .. net(at("decider-combinator", 5, 15), W.combinator_output_green))
rcon.print("N4 chest bus " .. net(at("iron-chest", 0, 19), W.circuit_green))
rcon.print("N4 gearT out " .. net(at("decider-combinator", 5, 19), W.combinator_output_green))
rcon.print("N4 cableT out " .. net(at("decider-combinator", 5, 21), W.combinator_output_green))
rcon.print("N4 sel out " .. net(at("selector-combinator", 10, 20), W.combinator_output_green))
rcon.print("N4 " .. machine("two translators", 14, 20))
rcon.print("N6 " .. machine("one decider two items", 10, 24))
rcon.print("N6 translator out " .. net(at("decider-combinator", 5, 24), W.combinator_output_green))
`;

// N5: the retarget, one write to the chest and the same read again. Nothing is re-wired or
// reconfigured: iron-gear-wheel simply stopped being the scarce thing, so index 0 ascending now names
// copper-cable. A chain that ranks and never moves a machine is decoration, so this is the claim.
const ACT_N5 = `
local s = game.surfaces["arch-lab"]
local X, Y, NB = ${X}, ${Y}, ${NB}
local c = (s.find_entities_filtered{name = "iron-chest",
  area = {{X - 1, Y + NB + 18}, {X + 1, Y + NB + 20}}})[1]
if not c then rcon.print("N5 no chest") return end
local put_in = c.insert{name = "iron-gear-wheel", count = 500}
local inv = c.get_inventory(1)
local q = {}
for _, n in ipairs({"iron-gear-wheel", "copper-cable"}) do
  q[#q + 1] = n .. "=" .. tostring(inv.get_item_count(n))
end
rcon.print("N5 inserted iron-gear-wheel=" .. tostring(put_in) .. " chest now holds " .. table.concat(q, ", "))
`;

const ACT_O = HEAD + `
local OB = ${150}
local function at(nm, dx, dy) return put(nm, dx, OB + dy) end
local function stock(e, nm, cnt)
  if not e then return "no chest" end
  return tostring(e.insert{name = nm, count = cnt})
end
local function write(e, params)
  if not e then return "no entity" end
  local ok, err = pcall(function() e.get_or_create_control_behavior().parameters = params end)
  return ok and "written" or ("RAISED " .. tostring(err):sub(1, 150))
end
local function stored(e)
  local ok, p = pcall(function() return e.get_or_create_control_behavior().parameters end)
  if not ok or type(p) ~= "table" then return "unreadable" end
  local ss, fs = p.second_signal, p.first_signal
  return "{first_constant=" .. tostring(p.first_constant) .. " first_signal=" .. tostring(fs and fs.name)
    .. " second_signal=" .. tostring(ss and ss.type) .. ":" .. tostring(ss and ss.name)
    .. " op=" .. tostring(p.operation) .. " out=" .. tostring((p.output_signal or {}).type)
    .. ":" .. tostring((p.output_signal or {}).name) .. "}"
end
local function net(e, cid)
  if not e then return "no entity" end
  local n = e.get_circuit_network(cid)
  if not n then return "NIL" end
  local out = {}
  for _, p in ipairs(n.signals or {}) do
    local g = p[1] or p.signal
    out[#out + 1] = tostring(g and g.type) .. ":" .. tostring(g and g.name) .. "=" .. tostring(p[2] or p.count)
  end
  return "[" .. table.concat(out, ", ") .. "]"
end
local TARGET = 50
-- The deficiency box: target minus what the box holds, written out under the recipe of the same name.
local function want(item, rec)
  return {first_constant = TARGET, second_signal = {type = "item", name = item}, operation = "-",
          output_signal = {type = "recipe", name = rec}}
end

rcon.print("-- O1 and O2: one box, and the same box against a chest that has enough")
local ca, aa = at("iron-chest", 0, 0), at("arithmetic-combinator", 5, 0)
local ma = at("assembling-machine-2", 10, 0)
rcon.print("O1 chest=" .. stock(ca, "iron-gear-wheel", 2) .. " want " .. stored(
  aa) .. " -> " .. write(aa, want("iron-gear-wheel", "iron-gear-wheel")) .. " " .. stored(aa)
  .. " wires=" .. tostring(link(ca, aa, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(aa, ma, W.combinator_output_green, W.circuit_green)))
local cb, ab, mb = at("iron-chest", 0, 4), at("arithmetic-combinator", 5, 4), at("assembling-machine-2", 10, 4)
rcon.print("O2 chest=" .. stock(cb, "iron-gear-wheel", 60) .. " -> " .. write(ab, want("iron-gear-wheel", "iron-gear-wheel"))
  .. " wires=" .. tostring(link(cb, ab, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(ab, mb, W.combinator_output_green, W.circuit_green)))

rcon.print("-- O3 the item that is not in the box at all")
local cc, ac, mc = at("iron-chest", 0, 8), at("arithmetic-combinator", 5, 8), at("assembling-machine-2", 10, 8)
stock(cc, "iron-gear-wheel", 2)
rcon.print("O3 -> " .. write(ac, want("copper-cable", "copper-cable"))
  .. " wires=" .. tostring(link(cc, ac, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(ac, mc, W.combinator_output_green, W.circuit_green)))

rcon.print("-- O4 the whole chain: two deficiencies, one selector descending, one machine")
local cd, ad1, ad2 = at("iron-chest", 0, 12), at("arithmetic-combinator", 5, 12),
  at("arithmetic-combinator", 5, 14)
local sd, md = at("selector-combinator", 10, 13), at("assembling-machine-2", 14, 13)
stock(cd, "iron-gear-wheel", 2)
rcon.print("O4 gear=" .. write(ad1, want("iron-gear-wheel", "iron-gear-wheel"))
  .. " cable=" .. write(ad2, want("copper-cable", "copper-cable"))
  .. " sel=" .. write(sd, {operation = "select", select_max = true, index_constant = 0}))
rcon.print("O4 wires c->a1=" .. tostring(link(cd, ad1, W.circuit_green, W.combinator_input_green))
  .. " c->a2=" .. tostring(link(cd, ad2, W.circuit_green, W.combinator_input_green))
  .. " a1->sel=" .. tostring(link(ad1, sd, W.combinator_output_green, W.combinator_input_green))
  .. " a2->sel=" .. tostring(link(ad2, sd, W.combinator_output_green, W.combinator_input_green))
  .. " sel->m=" .. tostring(link(sd, md, W.combinator_output_green, W.circuit_green)))
local okm = pcall(function() md.get_or_create_control_behavior().circuit_set_recipe = true end)
rcon.print("O4 machine controlled=" .. tostring(okm) .. " -- gear deficiency 48, cable 50 (absent), so index 0 wants cable")

rcon.print("-- O6 the same box writing out under an ITEM signal, for the two-stage layout")
local cf, af, gf, mf = at("iron-chest", 0, 18), at("arithmetic-combinator", 5, 18),
  at("decider-combinator", 10, 18), at("assembling-machine-2", 14, 18)
stock(cf, "iron-gear-wheel", 2)
local pf = want("iron-gear-wheel", "iron-gear-wheel")
pf.output_signal = {type = "item", name = "iron-gear-wheel"}
rcon.print("O6 arith=" .. write(af, pf)
  .. " gate=" .. write(gf, {
    conditions = {{first_signal = {type = "item", name = "iron-gear-wheel"}, comparator = ">", constant = 0}},
    outputs = {{signal = {type = "recipe", name = "iron-gear-wheel"}, copy_count_from_input = true}}})
  .. " wires=" .. tostring(link(cf, af, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(af, gf, W.combinator_output_green, W.combinator_input_green))
  .. "," .. tostring(link(gf, mf, W.combinator_output_green, W.circuit_green)))
pcall(function() mf.get_or_create_control_behavior().circuit_set_recipe = true end)
`;
const READ_O = `
local s = game.surfaces["arch-lab"]
local W = defines.wire_connector_id
local X, Y, OB = ${X}, ${Y}, ${150}
local function net(e, cid)
  if not e then return "no entity" end
  local n = e.get_circuit_network(cid)
  if not n then return "NIL" end
  local out = {}
  for _, p in ipairs(n.signals or {}) do
    local g = p[1] or p.signal
    out[#out + 1] = tostring(g and g.type) .. ":" .. tostring(g and g.name) .. "=" .. tostring(p[2] or p.count)
  end
  return "[" .. table.concat(out, ", ") .. "]"
end
local function at(nm, dx, dy)
  return (s.find_entities_filtered{name = nm,
    area = {{X + dx - 1, Y + OB + dy - 1}, {X + dx + 1, Y + OB + dy + 1}}})[1]
end
local function machine(dx, dy)
  local e = at("assembling-machine-2", dx, dy)
  if not e then return "machine missing" end
  local st; pcall(function() st = e.status end)
  local named = tostring(st)
  for k, v in pairs(defines.entity_status) do if v == st then named = k end end
  local rec
  pcall(function() if e.get_recipe then rec = e.get_recipe() end end)
  return "wire=" .. net(e, W.circuit_green) .. " recipe=" .. tostring(rec and rec.name) .. " " .. named
end
rcon.print("O1 chest " .. net(at("iron-chest", 0, 0), W.circuit_green))
rcon.print("O1 box out " .. net(at("arithmetic-combinator", 5, 0), W.combinator_output_green) .. " | " .. machine(10, 0))
rcon.print("O2 box out " .. net(at("arithmetic-combinator", 5, 4), W.combinator_output_green) .. " | " .. machine(10, 4))
rcon.print("O3 box out " .. net(at("arithmetic-combinator", 5, 8), W.combinator_output_green) .. " | " .. machine(10, 8))
rcon.print("O4 chest " .. net(at("iron-chest", 0, 12), W.circuit_green))
rcon.print("O4 gear out " .. net(at("arithmetic-combinator", 5, 12), W.combinator_output_green))
rcon.print("O4 cable out " .. net(at("arithmetic-combinator", 5, 14), W.combinator_output_green))
rcon.print("O4 sel out " .. net(at("selector-combinator", 10, 13), W.combinator_output_green) .. " | " .. machine(14, 13))
rcon.print("O6 arith out " .. net(at("arithmetic-combinator", 5, 18), W.combinator_output_green))
rcon.print("O6 gate out " .. net(at("decider-combinator", 10, 18), W.combinator_output_green) .. " | " .. machine(14, 18))
`;

// O5: the retarget on the deficiency bus. O4's machine was told to build copper-cable because the chest
// held none -- deficiency 50, the biggest number on the wire. Putting 49 copper-cable into that chest
// makes its deficiency 1 and leaves iron-gear-wheel at 48, so index 0 descending names a different
// recipe. Same wires, same settings, one item moved.
const ACT_O5 = `
local s = game.surfaces["arch-lab"]
local X, Y, OB = ${X}, ${Y}, ${150}
local c = (s.find_entities_filtered{name = "iron-chest",
  area = {{X - 1, Y + OB + 11}, {X + 1, Y + OB + 13}}})[1]
if not c then rcon.print("O5 no chest") return end
local got = c.insert{name = "copper-cable", count = 49}
local inv = c.get_inventory(1)
local q = {}
for _, n in ipairs({"iron-gear-wheel", "copper-cable"}) do
  q[#q + 1] = n .. "=" .. tostring(inv.get_item_count(n))
end
rcon.print("O5 inserted copper-cable=" .. tostring(got) .. " chest now holds " .. table.concat(q, ", "))
`;

// P: why act N's deciders all answered empty, and the two-machine form the layout is going to ship.
//
// N's eleven translator lanes all wrote, all wired, and all emitted nothing -- including the one fed by
// a scripted emitter, which is the input this API can guarantee. The explanation this act tests is that
// `copy_count_from_input` copies the count of the OUTPUT signal as seen on the input network, not the
// count of the signal that satisfied the condition: N asked for `recipe iron-gear-wheel` off a wire
// carrying `item iron-gear-wheel`, the two are different signals, the copy was 0, and a zero is not
// carried on a wire at all. If that is right, the same translator naming its output as the ITEM signal it
// matched will speak. It matters because it is the difference between "2.0 cannot copy" and "2.0 copies
// only from the signal you name" -- and the second one is a rule a layout can be written around, while
// the first would have to be rediscovered by the next reader.
//
//   P1  the copy, with the output naming the same item signal the condition matched.
//   P2  the same with `networks` named explicitly, in case the colour selection is what was missing.
//   P3  nothing is short: a chest above the target on both items, so both deficiencies are negative and
//       the descending selector is being asked to rank numbers below zero. Which one a machine takes here
//       is what a lane does when the factory is finished, and the report has to say it rather than be
//       surprised by it.
//   P4  two machines on one deficiency bus at index 0 and index 1 -- the actual shape a shortage lane is
//       laid in. Index 0 should take the bigger deficiency and index 1 the other, which is the whole
//       claim of "the scarcest thing gets the most hands" in one read.
const PB = 195;
const ACT_P = HEAD + `
local PB = ${PB}
local function at(nm, dx, dy) return put(nm, dx, PB + dy) end
local function stock(e, nm, cnt)
  if not e then return "no chest" end
  return tostring(e.insert{name = nm, count = cnt})
end
local function write(e, params)
  if not e then return "no entity" end
  local ok, err = pcall(function() e.get_or_create_control_behavior().parameters = params end)
  return ok and "written" or ("RAISED " .. tostring(err):sub(1, 150))
end
local function controlled(e)
  if not e then return "no entity" end
  local ok, err = pcall(function() e.get_or_create_control_behavior().circuit_set_recipe = true end)
  return ok and "set" or ("RAISED " .. tostring(err):sub(1, 60))
end
local TARGET = 50
local function want(item, rec)
  return {first_constant = TARGET, second_signal = {type = "item", name = item}, operation = "-",
          output_signal = {type = "recipe", name = rec}}
end

rcon.print("-- P1 and P2: a decider copying the signal it actually matched")
local c1, t1, m1 = at("iron-chest", 0, 0), at("decider-combinator", 5, 0), at("assembling-machine-2", 10, 0)
rcon.print("P1 chest=" .. stock(c1, "iron-gear-wheel", 2)
  .. " copy_item=" .. write(t1, {
    conditions = {{first_signal = {type = "item", name = "iron-gear-wheel"}, comparator = ">", constant = 0}},
    outputs = {{signal = {type = "item", name = "iron-gear-wheel"}, copy_count_from_input = true}}})
  .. " wires=" .. tostring(link(c1, t1, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(t1, m1, W.combinator_output_green, W.circuit_green))
  .. " machine=" .. controlled(m1))
local c2, t2, m2 = at("iron-chest", 0, 4), at("decider-combinator", 5, 4), at("assembling-machine-2", 10, 4)
rcon.print("P2 chest=" .. stock(c2, "iron-gear-wheel", 2)
  .. " copy_networks=" .. write(t2, {
    conditions = {{first_signal = {type = "item", name = "iron-gear-wheel"},
                   first_signal_networks = {green = true, red = false}, comparator = ">", constant = 0}},
    outputs = {{signal = {type = "item", name = "iron-gear-wheel"}, copy_count_from_input = true,
                networks = {green = true, red = false}}}})
  .. " wires=" .. tostring(link(c2, t2, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(t2, m2, W.combinator_output_green, W.circuit_green))
  .. " machine=" .. controlled(m2))

rcon.print("-- P3 nothing is short: both deficiencies negative")
local c3, a3a, a3b = at("iron-chest", 0, 8), at("arithmetic-combinator", 5, 8),
  at("arithmetic-combinator", 5, 10)
local s3, m3 = at("selector-combinator", 10, 9), at("assembling-machine-2", 14, 9)
rcon.print("P3 chest=" .. stock(c3, "iron-gear-wheel", 60) .. "," .. stock(c3, "copper-cable", 55)
  .. " gear=" .. write(a3a, want("iron-gear-wheel", "iron-gear-wheel"))
  .. " cable=" .. write(a3b, want("copper-cable", "copper-cable"))
  .. " sel=" .. write(s3, {operation = "select", select_max = true, index_constant = 0}))
rcon.print("P3 wires=" .. tostring(link(c3, a3a, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(c3, a3b, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(a3a, s3, W.combinator_output_green, W.combinator_input_green))
  .. "," .. tostring(link(a3b, s3, W.combinator_output_green, W.combinator_input_green))
  .. "," .. tostring(link(s3, m3, W.combinator_output_green, W.circuit_green))
  .. " machine=" .. controlled(m3) .. " -- gear -10, cable -5: descending index 0 is the bigger number, cable")

rcon.print("-- P4 two machines, index 0 and index 1 on one deficiency bus")
local c4, a4a, a4b = at("iron-chest", 0, 13), at("arithmetic-combinator", 5, 13),
  at("arithmetic-combinator", 5, 15)
local s4a, s4b = at("selector-combinator", 10, 13), at("selector-combinator", 10, 15)
local m4a, m4b = at("assembling-machine-2", 14, 13), at("assembling-machine-2", 14, 15)
rcon.print("P4 chest=" .. stock(c4, "iron-gear-wheel", 2) .. "," .. stock(c4, "copper-cable", 9)
  .. " gear=" .. write(a4a, want("iron-gear-wheel", "iron-gear-wheel"))
  .. " cable=" .. write(a4b, want("copper-cable", "copper-cable"))
  .. " sel0=" .. write(s4a, {operation = "select", select_max = true, index_constant = 0})
  .. " sel1=" .. write(s4b, {operation = "select", select_max = true, index_constant = 1}))
rcon.print("P4 wires=" .. tostring(link(c4, a4a, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(c4, a4b, W.circuit_green, W.combinator_input_green))
  .. "," .. tostring(link(a4a, s4a, W.combinator_output_green, W.combinator_input_green))
  .. "," .. tostring(link(a4b, s4a, W.combinator_output_green, W.combinator_input_green))
  .. "," .. tostring(link(a4a, s4b, W.combinator_output_green, W.combinator_input_green))
  .. "," .. tostring(link(a4b, s4b, W.combinator_output_green, W.combinator_input_green))
  .. "," .. tostring(link(s4a, m4a, W.combinator_output_green, W.circuit_green))
  .. "," .. tostring(link(s4b, m4b, W.combinator_output_green, W.circuit_green))
  .. " machines=" .. controlled(m4a) .. "," .. controlled(m4b)
  .. " -- gear 48, cable 41: machine at 0 should take gear, machine at 1 cable")
`;
const READ_P = `
local s = game.surfaces["arch-lab"]
local W = defines.wire_connector_id
local X, Y, PB = ${X}, ${Y}, ${PB}
local function net(e, cid)
  if not e then return "no entity" end
  local n = e.get_circuit_network(cid)
  if not n then return "NIL" end
  local out = {}
  for _, p in ipairs(n.signals or {}) do
    local g = p[1] or p.signal
    out[#out + 1] = tostring(g and g.type) .. ":" .. tostring(g and g.name) .. "=" .. tostring(p[2] or p.count)
  end
  return "[" .. table.concat(out, ", ") .. "]"
end
local function at(nm, dx, dy)
  return (s.find_entities_filtered{name = nm,
    area = {{X + dx - 1, Y + PB + dy - 1}, {X + dx + 1, Y + PB + dy + 1}}})[1]
end
local function machine(dx, dy)
  local e = at("assembling-machine-2", dx, dy)
  if not e then return "machine missing" end
  local rec
  pcall(function() if e.get_recipe then rec = e.get_recipe() end end)
  return "wire=" .. net(e, W.circuit_green) .. " recipe=" .. tostring(rec and rec.name)
end
rcon.print("P1 translator out " .. net(at("decider-combinator", 5, 0), W.combinator_output_green)
  .. " | " .. machine(10, 0))
rcon.print("P2 translator out " .. net(at("decider-combinator", 5, 4), W.combinator_output_green)
  .. " | " .. machine(10, 4))
rcon.print("P3 bus " .. net(at("selector-combinator", 10, 9), W.combinator_input_green))
rcon.print("P3 " .. machine(14, 9))
rcon.print("P4 sel0 out " .. net(at("selector-combinator", 10, 13), W.combinator_output_green) .. " | " .. machine(14, 13))
rcon.print("P4 sel1 out " .. net(at("selector-combinator", 10, 15), W.combinator_output_green) .. " | " .. machine(14, 15))
`;

// Q: which way a selector counts, and the box shape that survives an empty shelf.
//
// P's second answer is the one a layout has to be built on or not at all: with `select_max = true` and
// two machines asking for position 0 and position 1, BOTH got the same signal (gear=48). Either the
// descending sort ignores the position it is given -- in which case a group of machines can only be
// driven by an ASCENDING bus, and the numbers on it have to be arranged so the most urgent thing is the
// SMALLEST -- or P4 wired the two selectors onto networks that were not what the read claimed. This act
// separates those two, on one bus of three counts, with eight selectors each driving its own machine:
// four ascending and four descending, positions 0..3. Act M already did the ascending half of this and
// found 1st/2nd/3rd/nothing; the descending half has never been read.
//
// The other thing here is the box the layout ships with. `target - stored` is a positive number exactly
// when the shelf is short, which the machine needs (O4: a recipe signal whose count is negative does not
// set a recipe at all -- P3 read `recipe:copper-cable=-5` on the wire and `recipe=nil` on the machine).
// But if the ranking has to be ascending, the number on the wire has to GROW with the shelf instead, and
// the cheapest such figure is `stored + 1`: one more than what is there. The `+ 1` is not decoration --
// an item the shelves do not hold at all reads as zero, and a zero is not carried on a wire, so without
// it the scarcest thing in the factory is the one signal the bus never gets. Both box shapes are written
// side by side against the same chest so the two columns can be compared in one read.
const QB = 230;
const ACT_Q = HEAD + `
local QB = ${QB}
local function at(nm, dx, dy) return put(nm, dx, QB + dy) end
local function stock(e, nm, cnt)
  if not e then return "no chest" end
  return tostring(e.insert{name = nm, count = cnt})
end
local function write(e, params)
  if not e then return "no entity" end
  local ok, err = pcall(function() e.get_or_create_control_behavior().parameters = params end)
  return ok and "written" or ("RAISED " .. tostring(err):sub(1, 150))
end
local TARGET = 50

rcon.print("-- Q1: one bus of three counts, eight selectors, positions 0..3 each way")
local feed = at("decider-combinator", 0, 0)
rcon.print("Q1 feed=" .. write(feed, {
  conditions = {{comparator = "<", constant = 1}},
  outputs = {{signal = {type = "recipe", name = "copper-cable"}, constant = 1, copy_count_from_input = false},
             {signal = {type = "recipe", name = "iron-gear-wheel"}, constant = 5, copy_count_from_input = false},
             {signal = {type = "recipe", name = "steel-plate"}, constant = 9, copy_count_from_input = false}}}))
for row, up in ipairs({ false, true }) do
  for i = 0, 3 do
    local sel = at("selector-combinator", 4 + i * 3, row * 6)
    local m = at("assembling-machine-2", 4 + i * 3, row * 6 + 3)
    rcon.print("Q1 row" .. tostring(up and " desc" or " asc") .. " i" .. i .. " sel="
      .. write(sel, { operation = "select", select_max = up, index_constant = i })
      .. " wires=" .. tostring(link(feed, sel, W.combinator_output_green, W.combinator_input_green))
      .. "," .. tostring(link(sel, m, W.combinator_output_green, W.circuit_green))
      .. " machine=" .. (pcall(function() m.get_or_create_control_behavior().circuit_set_recipe = true end)
          and "set" or "no"))
  end
end

rcon.print("-- Q2: the two box shapes against one chest holding 2 gear and 9 cable")
local chest = at("iron-chest", 0, 20)
stock(chest, "iron-gear-wheel", 2) stock(chest, "copper-cable", 9)
-- steel-plate is deliberately NOT in the chest: the whole question is what its absence looks like.
for k, shape in ipairs({ "deficiency", "fullness" }) do
  for j, item in ipairs({ "iron-gear-wheel", "copper-cable", "steel-plate" }) do
    local box = at("arithmetic-combinator", 4 + (k - 1) * 6, 20 + (j - 1) * 2)
    local p
    if shape == "deficiency" then
      p = { first_constant = TARGET, second_signal = { type = "item", name = item }, operation = "-",
            output_signal = { type = "recipe", name = item } }
    else
      p = { first_signal = { type = "item", name = item }, second_constant = 1, operation = "+",
            output_signal = { type = "recipe", name = item } }
    end
    rcon.print("Q2 " .. shape .. " " .. item .. "=" .. write(box, p)
      .. " wire=" .. tostring(link(chest, box, W.circuit_green, W.combinator_input_green)))
  end
end
-- The two boxes of one shape share an output network, so the read that matters is which numbers appear
-- per shape rather than per box: three items, two shapes, and the absence in the middle of each column.
local m1 = at("assembling-machine-2", 4, 27)
local m2 = at("assembling-machine-2", 10, 27)
rcon.print("Q2 to the machines=" .. tostring(link(at("arithmetic-combinator", 4, 20), m1,
    W.combinator_output_green, W.circuit_green))
  .. "," .. tostring(link(at("arithmetic-combinator", 10, 20), m2, W.combinator_output_green, W.circuit_green)))
`;
const READ_Q = `
local s = game.surfaces["arch-lab"]
local W = defines.wire_connector_id
local X, Y, QB = ${X}, ${Y}, ${QB}
local function net(e, cid)
  if not e then return "no entity" end
  local n = e.get_circuit_network(cid)
  if not n then return "NIL" end
  local out = {}
  for _, p in ipairs(n.signals or {}) do
    local g = p[1] or p.signal
    out[#out + 1] = tostring(g and g.name) .. "=" .. tostring(p[2] or p.count)
  end
  return "[" .. table.concat(out, ", ") .. "]"
end
local function at(nm, dx, dy)
  return (s.find_entities_filtered{name = nm,
    area = {{X + dx - 1, Y + QB + dy - 1}, {X + dx + 1, Y + QB + dy + 1}}})[1]
end
local function recipe(e)
  if not e then return "missing" end
  local rec
  pcall(function() if e.get_recipe then rec = e.get_recipe() end end)
  return tostring(rec and rec.name)
end
for row, up in ipairs({ false, true }) do
  local out = {}
  for i = 0, 3 do
    local m = at("assembling-machine-2", 4 + i * 3, row * 6 + 3)
    out[#out + 1] = "i" .. i .. "=" .. recipe(m)
  end
  rcon.print("Q1 " .. (up and "desc" or "asc") .. " by position: " .. table.concat(out, " "))
end
rcon.print("Q2 deficiency boxes out " .. net(at("arithmetic-combinator", 4, 20), W.combinator_output_green))
rcon.print("Q2 fullness boxes out " .. net(at("arithmetic-combinator", 10, 20), W.combinator_output_green))
rcon.print("Q2 machine on deficiency bus recipe=" .. recipe(at("assembling-machine-2", 4, 27)))
rcon.print("Q2 machine on fullness bus recipe=" .. recipe(at("assembling-machine-2", 10, 27)))
`;

// R: the two box shapes, read by unit number, after two acts answered themselves wrongly.
//
// Q's rows said `i2=nil` and `fullness boxes out []`, and both readings were artefacts of LOOKING UP
// PARTS BY CELL: an assembler is 3x3 and a selector is 1x2, so the area I searched for the part at row
// 15 also contained the part at row 13, and the `nil` was "the machine refused steel-plate because it is
// a furnace recipe" -- which M had already measured, and which is a real answer about the machine rather
// than about the bus. P4 fell to the same thing: two selectors read the same signal because they were
// the same selector. So this act keeps every handle it created in `_G.RP.keep` and reads it back with
// `game.get_entity_by_unit_number`, which cannot be ambiguous.
//
// The question it settles, in one pass: what does each box shape put on the wire, for an item the shelf
// holds and for one it does not. `target - stored` is a positive number exactly when the factory is short
// (and P showed a machine ignoring the signal when that number goes negative, which is the "already
// enough" suppression for free, with no gate to lay). `stored + 1` is the same ranking upside down. Both
// are written against the same chest, one holding 2 iron-gear-wheel and 9 copper-cable and NO steel, so
// the four answers come off one measurement.
const RB = 230;
const ACT_R = HEAD + `
local RB = ${RB}
local TARGET = 50
-- The handles themselves, not their unit numbers: 'game.get_entity_by_unit_number' answers nil for an
-- entity created in the same tick it asks about (measured), so a probe that numbers its parts and looks
-- them up in the next console call finds nothing and reports "no entity" about parts that are standing
-- right there. A Lua handle in '_G' survives between console calls, which is what the act needs.
_G.RP.keep = {}
local function keep(e, tag)
  if e then _G.RP.keep[tag] = e end
  return e
end
local function at(nm, dx, dy, tag) return keep(put(nm, dx, RB + dy), tag) end
local function stock(e, nm, cnt)
  if not e then return "no chest" end
  return tostring(e.insert{name = nm, count = cnt})
end
local function write(e, params)
  if not e then return "no entity" end
  local ok, err = pcall(function() e.get_or_create_control_behavior().parameters = params end)
  return ok and "written" or ("RAISED " .. tostring(err):sub(1, 150))
end
local function arith(item, shape)
  if shape == "short" then
    return { first_constant = TARGET, second_signal = { type = "item", name = item }, operation = "-",
             output_signal = { type = "recipe", name = item } }
  end
  return { first_signal = { type = "item", name = item }, second_constant = 1, operation = "+",
           output_signal = { type = "recipe", name = item } }
end

local chest = at("iron-chest", 0, 0, "chest")
stock(chest, "iron-gear-wheel", 2) stock(chest, "copper-cable", 9)
local items = { "iron-gear-wheel", "copper-cable", "steel-plate" }
for j, item in ipairs(items) do
  local b = at("arithmetic-combinator", 4 + (j - 1) * 4, 0, "short" .. j)
  rcon.print("R short box " .. item .. "=" .. write(b, arith(item, "short"))
    .. " wire=" .. tostring(link(chest, b, W.circuit_green, W.combinator_input_green)))
end
for j, item in ipairs(items) do
  local b = at("arithmetic-combinator", 4 + (j - 1) * 4, 6, "full" .. j)
  rcon.print("R full box " .. item .. "=" .. write(b, arith(item, "fullness"))
    .. " wire=" .. tostring(link(chest, b, W.circuit_green, W.combinator_input_green)))
end
-- One machine per sort direction per position, so the two shapes can be compared on the same bus. Each
-- selector reads the merged output network of its own column, and every machine has a wire of its own.
for _, col in ipairs({ "short", "full" }) do
  for i = 0, 2 do
    local sel = at("selector-combinator", 16, (col == "short") and i * 2 or (12 + i * 2), col .. "sel" .. i)
    local m = at("assembling-machine-2", 20, (col == "short") and i * 2 or (12 + i * 2), col .. "m" .. i)
    local ws = {}
    for j = 1, 3 do
      ws[#ws + 1] = tostring(link(_G.RP.keep[col .. j], sel, W.combinator_output_green,
        W.combinator_input_green))
    end
    local okw = pcall(function() m.get_or_create_control_behavior().circuit_set_recipe = true end)
    rcon.print("R " .. col .. " sel i" .. i .. "="
      .. write(sel, { operation = "select", select_max = col == "short", index_constant = i })
      .. " bus wires=" .. table.concat(ws, ",")
      .. " to machine=" .. tostring(link(sel, m, W.combinator_output_green, W.circuit_green))
      .. " controlled=" .. tostring(okw))
  end
end
rcon.print("R chest holds 2 gear, 9 cable, no steel -- short: gear 48 cable 41 steel 50 (index 0 desc = steel)"
  .. " | full: gear 3 cable 10 steel 1 (index 0 asc = steel)")
`;
const READ_R = `
local W = defines.wire_connector_id
local keep = _G.RP and _G.RP.keep or {}
local function get(tag) return keep[tag] end
local function net(e, cid)
  if not e then return "no entity" end
  local n = e.get_circuit_network(cid)
  if not n then return "NIL" end
  local out = {}
  for _, p in ipairs(n.signals or {}) do
    local g = p[1] or p.signal
    out[#out + 1] = tostring(g and g.name) .. "=" .. tostring(p[2] or p.count)
  end
  return "[" .. table.concat(out, ", ") .. "]"
end
local function rec(e)
  if not e then return "missing" end
  local r
  pcall(function() if e.get_recipe then r = e.get_recipe() end end)
  return tostring(r and r.name)
end
rcon.print("R chest bus " .. net(get("chest"), W.circuit_green))
for _, col in ipairs({ "short", "full" }) do
  for j = 1, 3 do
    rcon.print("R " .. col .. " box" .. j .. " out " .. net(get(col .. j), W.combinator_output_green))
  end
  for i = 0, 2 do
    local m = get(col .. "m" .. i)
    rcon.print("R " .. col .. " i" .. i .. " sel out " .. net(get(col .. "sel" .. i), W.combinator_output_green)
      .. " machine recipe=" .. rec(m))
  end
end
`;

// Which acts to run: no arguments runs the whole file, and naming letters
// (`node dev/circuit_rules_probe.js P`) runs those alone. A rule measured once is worth keeping in
// the file; a rule being chased is worth minutes per attempt, and seven minutes of sleep between two
// prints is an invitation to go and do something else while a wrong guess sits unconfirmed.
const ONLY = process.argv.slice(2).map((a) => a.toUpperCase());
const want = (k) => ONLY.length === 0 || ONLY.indexOf(k) >= 0;

if (want("A")) {
  console.log("== A: one wire, two recipe signals");
  console.log(run(ACT_A));
  for (let i = 1; i <= 3; i++) { sleep(2500); console.log(run(READ_A)); }
}

if (want("B")) {
  console.log("== B: selector arbitration");
  console.log(run(ACT_B));
  sleep(3000);
  console.log(run(READ_B));
}

if (want("C")) {
  console.log("== C: recipe_locked against a wire");
  console.log(run(ACT_C));
  sleep(3000);
  console.log(run(READ_C));
}

if (want("D")) {
  console.log("== D: set-recipe with an empty wire");
  console.log(run(ACT_D));
  sleep(3000);
  console.log(run(READ_D));
}

if (want("F")) {
  console.log("== F: which of two recipe signals a machine takes");
  console.log(run(ACT_F));
  for (let i = 1; i <= 3; i++) { sleep(2500); console.log(run(READ_F)); }
}

if (want("G")) {
  console.log("== G: selector `select` and `random` driving a machine");
  console.log(run(ACT_G));
  // Sampled five times over ~15s: `random_update_interval = 20` is 20 ticks, so a rotation shows up as
  // different recipes in different reads, and a fixed output shows up as the same one five times.
  for (let i = 1; i <= 5; i++) { sleep(3000); console.log(run(READ_G)); }
}

if (want("H")) {
  console.log("== H: does a machine pick a recipe signal by count?");
  console.log(run(ACT_H));
  for (let i = 1; i <= 3; i++) { sleep(2500); console.log(run(READ_H)); }
}

if (want("I")) {
  console.log("== I: one bus, two machines, two selector positions");
  console.log(run(ACT_I));
  for (let i = 1; i <= 2; i++) { sleep(3000); console.log(run(READ_I)); }
}

if (want("J")) {
  console.log("== J: which entities can hold a wire, and how far one reaches");
  console.log(run(ACT_J));
}

if (want("K")) {
  console.log("== K: does a wire drawn between ghosts survive being built?");
  console.log(run(ACT_K));
}

if (want("L")) {
  console.log("== L: does a control behaviour written on a ghost survive being built?");
  console.log(run(ACT_L));
}

if (want("M")) {
  console.log("== M: one bus, five positions, five machines");
  console.log(run(ACT_M));
  sleep(3500);
  console.log(run(READ_M));
}

if (want("N")) {
  console.log("== N: does a chest on a wire put real deficiencies on the bus?");
  console.log(run(ACT_N));
  sleep(3500);
  console.log(run(READ_N));
  console.log(run(ACT_N5));
  sleep(3500);
  console.log("after the chest changed: " + run(READ_N));
}

if (want("O")) {
  console.log("== O: is the number on the bus target-minus-stored, and can one box do the arithmetic and the translation?");
  console.log(run(ACT_O));
  sleep(3500);
  console.log(run(READ_O));
  console.log(run(ACT_O5));
  sleep(3500);
  console.log("after the chest changed: " + run(READ_O));
}

if (want("P")) {
  console.log("== P: the copy rule, and two machines reading one deficiency bus");
  console.log(run(ACT_P));
  sleep(3500);
  console.log(run(READ_P));
}
if (want("Q")) {
  console.log("== Q: which way a selector counts, and the box shape that survives an empty shelf");
  console.log(run(ACT_Q));
  sleep(4000);
  console.log(run(READ_Q));
}
if (want("R")) {
  console.log("== R: the two box shapes, read by unit number");
  console.log(run(ACT_R));
  sleep(4000);
  console.log(run(READ_R));
}

if (want("E")) {
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
}

console.log("// " + run(CLEAN));
