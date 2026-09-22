// Which control_behavior JSON does a 2.0 constant combinator actually accept?
//
// Background, all measured earlier today (see dev/circuit_signal_probe.js for the matrix):
//   * 2.0 removed LuaConstantCombinatorControlBehavior::set_signal/get_signal/signals_count/parameters,
//     and the runtime `sections` filters have no field for the emitted value: `count` is silently
//     dropped, `get_slot` reads back only {value, min, import_from}, and `set_slot(1, {value=, min=7,
//     max=7})` raises "Can't specify non zero request with non trivial item filter condition" -- which
//     is logistic-request wording, i.e. the runtime table I can write is not the table that emits.
//   * Six filter shapes, on both arch-sandbox and nauvis, left the shared circuit network at
//     members=2 with no signals, while the assembler on the same wire did flip to `no_recipe` from
//     circuit_set_recipe -- so the wire, the network and the machine side are all live.
//   * `helpers.encode_string` returns the body WITHOUT the leading "0" version char, and `decode_string`
//     needs that char stripped (`st.export_stack():sub(2)`).
//
// So the remaining question is the *blueprint* spelling of a combinator's signals, and the game's own
// export of a bare combinator only shows `control_behavior = {sections = {sections = [{index = 1}]}}`.
// Three candidate shapes are tried below, each judged without trusting my own read path: an assembler
// with circuit_set_recipe on has no recipe until a signal names one, so a recipe appearing is the
// engine's own verdict.
//
//   node dev/circuit_blueprint_emit.js            # every shape, side by side
//
// ⚠ RUNNING THIS CAN KILL THE SERVER, and it did once today in the sibling sweep that tried six shapes:
//   Error LogisticSection.cpp:94: this->filters.empty() || !output.savingBlueprint ||
//     this->filters.back() was not true      ← ItemStack::save ← Inventory::save
//     ← ExtraScriptData::saveInventories ← Map::save (an autosave tickled it)
// A hand-written control_behavior that the parser half-accepts is enough to trip that assertion at SAVE
// time, which no pcall can catch. Script inventories are part of the save, so `inv.destroy()` is not
// tidiness here -- it is the difference between a failed probe and a dead server. The on-disk m0.zip is
// never touched (autosaves go to _autosaveN.zip), and `bash dev/cycle.sh` restores a known state.
const { execFileSync } = require("child_process");
const run = (src) => execFileSync(process.execPath, ["dev/lua.js", src], { encoding: "utf8", maxBuffer: 1 << 28 });
const settle = () => execFileSync(process.platform === "win32" ? "ping" : "sleep",
  process.platform === "win32" ? ["-n", "3", "127.0.0.1"] : ["2.5"], { stdio: "ignore" });

const SURFACE = process.argv[2] || "arch-sandbox";
const MX = 0, MY = 0, CX = 6, CY = 0;

const HEAD = `local s = game.surfaces[${JSON.stringify(SURFACE)}]
local AREA = {{-40,-40},{40,40}}
local function pp(f, ...) rcon.print(string.format(f, ...)) end
local function comb() return s.find_entities_filtered{name = "constant-combinator", area = AREA} end
local function mach() return s.find_entities_filtered{name = "assembling-machine-3", area = AREA}[1] end
local function show(e, label)
  for _, w in ipairs(e.get_wire_connectors(true)) do
    local cn = e.get_circuit_network(w.wire_connector_id)
    local iter = {}
    if cn then for k, v in pairs(cn.signals or {}) do
      iter[#iter+1] = (type(k) == "table" and (k.name .. "/" .. tostring(k.type)) or tostring(k)) .. "=" .. tostring(v)
    end end
    pp("    %-9s id=%s wire=%s net=%s members=%s signals=[%s]", label, tostring(w.wire_connector_id),
      tostring(w.wire_type), tostring(cn and cn.network_id), tostring(cn and cn.connected_circuit_count),
      table.concat(iter, " "))
  end
end
local function judge(tag)
  pp("%s", tag)
  local m = mach()
  local rec = m and m.get_recipe()
  local gears = "?"
  if m then
    local ok, cnt = pcall(function() return m.get_inventory(defines.inventory.assembling_machine_output).get_item_count("iron-gear-wheel") end)
    if ok then gears = tostring(cnt) end
  end
  pp("  assembler recipe=%s status=%s gear_wheels_inside=%s", tostring(rec and rec.name), tostring(m and m.status), gears)
  for _, c in ipairs(comb()) do
    local cb = c.get_or_create_control_behavior()
    pp("  comb at %s,%s enabled=%s sections_count=%s", tostring(c.position.x), tostring(c.position.y),
       tostring(cb.enabled), tostring(cb.sections_count))
    for _, sec in ipairs(cb.sections or {}) do
      local f = {}
      for j, x in ipairs(sec.filters or {}) do
        local v = x.value
        f[#f+1] = string.format("[%d]%s/%s min=%s max=%s", j,
          tostring(type(v) == "table" and v.name or v), tostring(type(v) == "table" and v.type),
          tostring(x.min), tostring(x.max))
      end
      pp("    sec#%s active=%s mult=%s filters=[%s]", tostring(sec.index), tostring(sec.active),
        tostring(sec.multiplier), table.concat(f, " "))
    end
    show(c, "comb")
  end
  if m then show(m, "assembler") end
end`;

const SHAPES = [
  ["A {is_on, sections:[{index, filters:[{index, signal, count}]}]}",
   `{is_on = true, sections = {{index = 1, filters = {{index = 1, signal = SIG, count = 1}}}}}`],
  ["B {sections:{sections:[{index, active, filters:[{index, name, type, count}]}]}}",
   `{sections = {sections = {{index = 1, active = true, filters = {
     {index = 0, name = "iron-gear-wheel", type = "recipe", count = 1}}}}}}`],
  ["C {is_on, constants:[{index, signal, count}]} (the 1.1 spelling)",
   `{is_on = true, constants = {{index = 1, signal = SIG, count = 1}}}`],
  ["D {sections:{sections:[{index}]}} (what the game itself writes for a bare combinator)",
   `{sections = {sections = {{index = 1}}}}`],
  ["E {sections:{sections:[{index, filters:[{index, signal, count}]}]}} (nested + SignalID)",
   `{sections = {sections = {{index = 1, filters = {
     {index = 1, signal = SIG, count = 1}}}}}}`],
];

const CASE = (shape) => `${HEAD}
for _, e in ipairs(s.find_entities_filtered{area = AREA}) do e.destroy() end
s.create_global_electric_network()
s.create_entity{name = "electric-energy-interface", position = {x = -30.5, y = -30.5}, force = "player"}
local m = s.create_entity{name = "assembling-machine-3", position = {x = ${MX}.5, y = ${MY}.5}, force = "player"}
m.insert{name = "iron-plate", count = 400}
m.get_or_create_control_behavior().circuit_set_recipe = true
local SIG = {name = "iron-gear-wheel", type = "recipe"}
local cb = ${shape}
local t = {blueprint = {item = "blueprint", version = 562949958467584, entities = {
  {entity_number = 1, name = "constant-combinator", position = {x = 0.5, y = 0.5},
   direction = defines.direction.east, control_behavior = cb}}}}
local enc = helpers.encode_string(helpers.table_to_json(t))
-- import_stack wants the full clipboard form: "0" is the version byte and helpers.encode_string leaves it
-- off (measured: without it rc=1 and the item comes back empty; with it rc=0).
local inv = game.create_inventory(1)
inv.insert{name = "blueprint", count = 1}
local st = inv[1]
local rc = st.import_stack("0" .. enc)
local ents = st.get_blueprint_entities()
pp("import_stack rc=%s entities=%s", tostring(rc), ents and string.format("#%d", #ents) or "nil")
if tonumber(rc) == 0 and ents then
  -- A blueprint's entity positions are relative to the blueprint's own top-left, so the build position
  -- is where the combinator lands: (0,0) would have put it under the assembler.
  local built = st.build_blueprint{surface = s, position = {x = ${CX}, y = ${CY}}, force = "player"}
  local k = {}
  for _, v in ipairs(built) do k[#k+1] = tostring(v.name) .. "@" .. tostring(v.position.x) .. "," .. tostring(v.position.y) end
  pp("build returned %d: %s", #built, table.concat(k, " "))
  for _, g in ipairs(s.find_entities_filtered{type = "entity-ghost", area = AREA}) do
    local gname = g.ghost_name
    local ok, err = pcall(function() return g.silent_revive{raise_revive = true} end)
    pp("  revive %s -> %s %s", tostring(gname), tostring(ok), tostring(ok and "" or err))
  end
end
pp("combinators on the ground: %d", #comb())
inv.destroy()
game.tick_paused = false game.speed = 60`;

const WIRE = `${HEAD}
local m = mach()
for _, c in ipairs(comb()) do
  for _, wm in ipairs(m.get_wire_connectors(true)) do
    for _, wc in ipairs(c.get_wire_connectors(true)) do
      if wm.wire_type == wc.wire_type then
        pcall(function() return wm.connect_to(wc, false, defines.wire_origin.script) end)
      end
    end
  end
  c.update_connections()
end
m.update_connections()
pp("wired %d combinators to the assembler", #comb())
game.tick_paused = false game.speed = 60`;

for (const [label, shape] of SHAPES) {
  console.log(run(CASE(shape)));
  console.log(run(WIRE));
  settle();
  console.log(run(`${HEAD}\njudge(${JSON.stringify(`=== ${label} ->`)})`));
}
console.log(run(`game.tick_paused = true game.speed = 1
local s = game.surfaces[${JSON.stringify(SURFACE)}]
local n = 0
for _, e in ipairs(s.find_entities_filtered{area = {{-40,-40},{40,40}}}) do e.destroy(); n = n + 1 end
rcon.print("paused again, cleared " .. n)`));
