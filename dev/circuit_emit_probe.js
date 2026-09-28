// Can a script put a signal on a wire, and can that signal pick an assembler's recipe?
//
// It can, and it does. Measured on this install (2.0.77, api_version 6) by the script below:
//
//   wired=true  emitter class=LuaDeciderCombinatorControlBehavior
//   machine behaviour=LuaAssemblingMachineControlBehavior  recipe_before=iron-gear-wheel
//   -- four real seconds later --
//   network signals=[copper-cable=1]  emitter last_tick=[copper-cable=1]
//   machine recipe=copper-cable  status=26  wires=1
//
// So a decider combinator BUILT AND CONFIGURED BY SCRIPT emits a recipe signal, a wire drawn by script
// carries it (LuaWireConnector.connect_to), and an assembling machine with `circuit_set_recipe` switches
// to the recipe the signal names -- from iron-gear-wheel to copper-cable with nobody touching a client.
// The candidate set needs no preloaded list either: no recipe filter was configured on that machine, so
// the signal names a recipe directly, over whatever that machine can craft.
//
// Why this file exists at all: the repo's own limitation text used to say the opposite -- that a plan
// cannot gate or retool anything by signal, "not a backlog item". That was wrong, and the wrong half was
// wrapped around a real boundary: what a script cannot do is make a CONSTANT combinator emit, because its
// `sections`/`sections_count` are read-only. A decider with an unsatisfiable input ("each < 1") is the
// constant source, and its `parameters` are writable, so the boundary is narrower than "no signals" and
// the consequence for planning is the opposite: a signal-gated line is buildable.
//
// Two traps this run paid for, written where the next reader will find them:
//   * Factorio's Lua API is called as `entity.method(args)` -- the binder supplies self. A colon call
//     (`entity:method(args)`) adds a second self, so every argument count lands one slot off and the
//     engine answers "Arguments count error for 'get_wire_connector': Expected 1 or 2 arguments but 3
//     were given". `dev/circuit_probe.js` read exactly that class of message and concluded the DOCUMENTATION
//     had reversed several signatures. The docs were right; the calls were colons.
//   * A combinator is electric and an unpowered one emits nothing at all, which looks identical to "the
//     API cannot do it". Hence the grid below, and `powered` in the readout.
//
// It is a probe, not a gate: it prints what the engine said and exits 0 either way, because the thing being
// collected is an answer and a pass/fail wrapper would make an honest "no" look like a broken harness.
// Run it with `bash dev/test.sh node dev/circuit_emit_probe.js`.
const { execFileSync } = require("child_process");
require("./suite-guard.js").guardMain("circuit_emit_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016", RCON_PW: process.env.RCON_PW || "testpw" };
const run = (src) => execFileSync(process.execPath, ["dev/lua.js", src],
  { encoding: "utf8", maxBuffer: 1 << 28, env: { ...ENV, RCON_IDLE_MS: process.env.RCON_IDLE_MS || "20000" } }).trim();
const sleep = () => execFileSync(process.execPath, ["-e", "setTimeout(()=>{},4000)"], { env: ENV });

// The signal the wire will carry, and the one the machine holds by hand before the network takes over.
// Different on purpose: "it switched" is the whole claim, and it is unobservable if both sides agree.
const LUA = `
local s = game.surfaces["arch-lab"]
local W = defines.wire_connector_id
local WANT = {type = "recipe", name = "copper-cable"}
local HAND = "iron-gear-wheel"
`;

// Place, wire, configure. A generator is part of the fixture: everything here is electric.
const SETUP = LUA + `
for _, e in ipairs(s.find_entities_filtered{area = {{68, 68}, {86, 74}}}) do
  if e.valid then e.destroy() end
end
if not s.has_global_electric_network then s.create_global_electric_network() end
local gen = s.create_entity{name = "electric-energy-interface", position = {x = 72.5, y = 73.5}, force = "player"}
local c = s.create_entity{name = "decider-combinator", position = {x = 70.5, y = 70.5}, force = "player"}
local m = s.create_entity{name = "assembling-machine-2", position = {x = 74.5, y = 70.5}, force = "player"}
if not (c and m) then rcon.print("SETUP FAILED to place") return end

-- "each < 1" on an input that carries nothing is true every tick, so the outputs fire: that is the
-- constant source a player builds when a constant combinator is not at hand. 'copy_count_from_input'
-- defaults to TRUE, and with nothing coming in that means an output of 0, which the network does not
-- carry at all -- the silent failure the old probe mistook for a boundary.
local cb = c.get_or_create_control_behavior()
cb.parameters = {conditions = {{comparator = "<", constant = 1}},
                 outputs = {{signal = WANT, constant = 1, copy_count_from_input = false}}}

local mb = m.get_or_create_control_behavior()
mb.circuit_set_recipe = true
mb.circuit_working_signal = WANT
m.set_recipe(HAND)

local wired = c.get_wire_connector(W.combinator_output_green, true)
  .connect_to(m.get_wire_connector(W.circuit_green, true), false, defines.wire_origin.script)
_G.CIRCUIT_PROBE = {gen = gen and gen.unit_number}
rcon.print("wired=" .. tostring(wired)
  .. "  emitter=" .. tostring(cb.object_name)
  .. "  machine_behaviour=" .. tostring(mb.object_name)
  .. "  recipe_before=" .. tostring((m.get_recipe() or {}).name))
`;

// Read, after real ticks have passed: `signals_last_tick` and a network's `signals` are both last-tick
// values, so a read in the same command as the write can only ever see silence.
const READ = LUA + `
local m = (s.find_entities_filtered{area = {{73, 69}, {76, 72}}, type = "assembling-machine"})[1]
local c = (s.find_entities_filtered{area = {{69, 69}, {72, 72}}})[1]
if not m then rcon.print("MACHINE GONE") return end
function fmt(list)
  local out = {}
  for _, pair in ipairs(list or {}) do
    local sg = pair[1] or pair.signal
    out[#out + 1] = tostring(sg and sg.name) .. "=" .. tostring(pair[2] or pair.count)
  end
  return table.concat(out, ", ")
end
local net = m.get_circuit_network(W.circuit_green)
local cb = c and c.get_control_behavior()
local rec = m.get_recipe()
local st
pcall(function() st = m.status end)
rcon.print("network signals=[" .. fmt(net and net.signals) .. "]"
  .. "  emitter last_tick=[" .. fmt(cb and cb.signals_last_tick) .. "]"
  .. "  machine recipe=" .. tostring((rec or {}).name)
  .. "  status=" .. tostring(st)
  .. "  powered=" .. tostring(m.is_connected_to_electric_network())
  .. "  wires=" .. tostring(net and net.connected_circuit_count))
`;

// Take it all back, including the merged grid if this file was the one that merged it.
const CLEAN = `
local s = game.surfaces["arch-lab"]
local n = 0
for _, e in ipairs(s.find_entities_filtered{area = {{66, 66}, {88, 76}}}) do
  if e.valid then e.destroy(); n = n + 1 end
end
local ok = pcall(function() s.destroy_global_electric_network() end)
_G.CIRCUIT_PROBE = nil
rcon.print("cleaned " .. n .. " entities; grid unmerged=" .. tostring(ok)
  .. " now_global=" .. tostring(s.has_global_electric_network))
`;

console.log(run(SETUP));
sleep();
console.log(run(READ));
console.log("// " + run(CLEAN));
