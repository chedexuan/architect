// Why does the multi-fluid supply search place nothing, and which runs really move fluid?
//
// The geometry is the one `card_lab` would use: a run of pipes on the cells touching a machine's
// border, with a full tank behind the middle of the run. Nothing about a machine says where its
// fluid boxes are, so the search's only knowledge is which runs *fit* -- and every attempt in the
// lab reported that none did. This asks that question of one refinery on empty ground, printing
// every `can_place_entity` answer instead of folding it into a verdict, then watches the machine's
// own status to find out which of those shapes a refinery accepts.
//
// Raw entities on arch-sandbox; dev/cycle.sh restarts from the save, so nothing here persists.
const connect = require("./rcon_client");
const r = connect();

// The slot vocabulary: one whole face, or that same face split into its two end groups with the
// middle cell left empty -- two fluids on one side cannot touch or their pipe rows join.
// Prepended whole to every command, because a `/c` chunk keeps no locals between calls.
const PRELUDE = `
local function pos(p) return string.format("%.1f,%.1f", p.x, p.y) end
local function held(ent)
  local n = 0
  pcall(function() for _, v in pairs(ent.get_fluid_contents()) do
    n = n + ((type(v) == "number") and v or (v.amount or 0)) end end)
  return n
end
local function side_slots(label, ux, uy, span)
  local cells = {}
  for i = 0, span - 1 do cells[#cells + 1] = i - (span - 1) / 2 end
  local out = { { label = label, ux = ux, uy = uy, cells = cells } }
  local half = math.floor(span / 2)
  if half * 2 < span and half >= 1 then
    local a, b = {}, {}
    for i = 1, half do a[#a + 1] = cells[i] end
    for i = span - half + 1, span do b[#b + 1] = cells[i] end
    out[#out + 1] = { label = label .. "-a", ux = ux, uy = uy, cells = a }
    out[#out + 1] = { label = label .. "-b", ux = ux, uy = uy, cells = b }
  end
  return out
end
local function slots_of(ent)
  local p = prototypes.entity[ent.name]
  local w, h = p.tile_width, p.tile_height
  local out = {}
  for _, spec in ipairs({
    { "east",  1, 0, h }, { "west", -1, 0, h }, { "south", 0, 1, w }, { "north", 0, -1, w },
  }) do
    for _, s in ipairs(side_slots(spec[1], spec[2], spec[3], spec[4])) do out[#out + 1] = s end
  end
  return out
end
-- a pipe row sits on the cells touching the machine's border; the tank centre is two cells further
-- out, so its body abuts the pipe row without overlapping the machine
local function layout(m, slot)
  local e = m.position
  local px = (prototypes.entity[m.name].tile_width + 1) / 2
  local py = (prototypes.entity[m.name].tile_height + 1) / 2
  local pipes = {}
  for _, cell in ipairs(slot.cells) do
    if slot.ux ~= 0 then pipes[#pipes + 1] = { x = e.x + px * slot.ux, y = e.y + cell }
    else pipes[#pipes + 1] = { x = e.x + cell, y = e.y + py * slot.uy } end
  end
  local middle = slot.cells[math.ceil(#slot.cells / 2)]
  local tank, dir
  if slot.ux ~= 0 then
    tank = { x = e.x + (px + 2) * slot.ux, y = e.y + middle }
    dir = (slot.ux > 0) and defines.direction.west or defines.direction.east
  else
    tank = { x = e.x + middle, y = e.y + (py + 2) * slot.uy }
    dir = (slot.uy > 0) and defines.direction.north or defines.direction.south
  end
  return pipes, tank, dir
end
-- the other shape a player uses: the tank's own wall as the pipe. A 3x3 tank reaches a face only
-- whole, so this arrangement has four slots and no splits
local function flush(m, slot)
  local p = prototypes.entity[m.name]
  local e = m.position
  if slot.ux ~= 0 then
    return { x = e.x + ((p.tile_width + 3) / 2) * slot.ux, y = e.y },
      (slot.ux > 0) and defines.direction.west or defines.direction.east
  end
  return { x = e.x, y = e.y + ((p.tile_height + 3) / 2) * slot.uy },
    (slot.uy > 0) and defines.direction.north or defines.direction.south
end
local s = game.surfaces["arch-sandbox"]
local m = s and s.find_entities_filtered { name = "oil-refinery", area = { { -30, -30 }, { 30, 30 } } }[1]`;

const setup = `if not s then rcon.print("NO_SANDBOX") return end
if not s.is_chunk_generated({ 0, 0 }) then rcon.print("CHUNK_NOT_GENERATED") return end
for _, e in ipairs(s.find_entities_filtered { area = { { -30, -30 }, { 30, 30 } } }) do e.destroy() end
local made = s.create_entity { name = "oil-refinery", position = { 0, 0 }, force = "player" }
if not made then rcon.print("REFINERY_REFUSED") return end
rcon.print("refinery at " .. pos(made.position) .. " size " .. made.prototype.tile_width .. "x"
  .. made.prototype.tile_height)`;

const geometry = `if not m then rcon.print("NO_REFINERY") return end
rcon.print("--- can_place per slot (! marks a refused pipe) ---")
for _, slot in ipairs(slots_of(m)) do
  local pipes, tank, dir = layout(m, slot)
  local marks = {}
  for _, p in ipairs(pipes) do
    marks[#marks + 1] = pos(p) .. (s.can_place_entity { name = "pipe", position = p, force = "player" }
      and "" or "!")
  end
  local tok = s.can_place_entity { name = "storage-tank", position = tank, force = "player", direction = dir }
  rcon.print(string.format("%-11s cells=[%s] pipes=%s tank=%s can=%s", slot.label,
    table.concat(slot.cells, ","), table.concat(marks, " "), pos(tank), tostring(tok)))
end
rcon.print("--- creating each run on its own ---")
for _, slot in ipairs(slots_of(m)) do
  local pipes, tank, dir = layout(m, slot)
  local made = 0
  for _, p in ipairs(pipes) do
    if s.create_entity { name = "pipe", position = p, force = "player" } then made = made + 1 end
  end
  local t = s.create_entity { name = "storage-tank", position = tank, force = "player", direction = dir }
  rcon.print(string.format("create %-11s pipes=%d/%d tank=%s", slot.label, made, #pipes, t and "ok" or "no"))
  if t then t.destroy() end
  for _, p in ipairs(s.find_entities_filtered { name = "pipe", area = { { -30, -30 }, { 30, 30 } } }) do
    p.destroy()
  end
end`;

// One trial = one machine built fresh for it, plus the runs under test. That last part is not
// tidiness: a refinery keeps whatever its boxes already held, so a second trial on the same entity
// reads "no drainage" from a machine that has nothing left to take.
const trial = (recipe, runs) => `if not s then rcon.print("NO_SANDBOX") return end
for _, e in ipairs(s.find_entities_filtered { area = { { -30, -30 }, { 30, 30 } } }) do e.destroy() end
-- no generator survives a restart on this map, and an unpowered refinery reads a clean zero that
-- looks exactly like a supply run that failed to connect
pcall(function() s.create_global_electric_network() end)
s.create_entity { name = "electric-energy-interface", position = { 0, 14 }, force = "player" }
local f = game.forces.player
for _, t in ipairs({ "oil-processing", "advanced-oil-processing" }) do
  if f.technologies[t] and not f.technologies[t].researched then f.technologies[t].researched = true end
end
local mm = s.create_entity { name = "oil-refinery", position = { 0, 0 }, force = "player" }
if not mm then rcon.print("REFINERY_REFUSED") return end
-- an idle refinery with no recipe chosen waits for neither fluid and moves none, which is
-- indistinguishable from a run laid on the wrong face
pcall(function() mm.set_recipe("${recipe}") end)
local cap = prototypes.entity["storage-tank"].fluid_capacity
local made = {}
for _, ob in ipairs({ ${runs} }) do
  local sl
  for _, x in ipairs(slots_of(mm)) do if x.label == ob.slot then sl = x end end
  if not sl then rcon.print("NO_SLOT " .. ob.slot) return end
  -- an explicit cell list is the same face narrowed to part of it: what a run has to become when
  -- two fluids are to be served by one side without their pipes joining
  if ob.cells then
    local cells = {}
    for c in string.gmatch(ob.cells, "[^,]+") do cells[#cells + 1] = tonumber(c) end
    sl = { label = sl.label .. ":" .. ob.cells, ux = sl.ux, uy = sl.uy, cells = cells }
  end
  local tank, dir, npipes = nil, nil, 0
  if ob.mode == "flush" then
    tank, dir = flush(mm, sl)
  else
    local row
    row, tank, dir = layout(mm, sl)
    for _, p in ipairs(row) do
      if s.create_entity { name = "pipe", position = p, force = "player" } then npipes = npipes + 1 end
    end
  end
  local t = tank and s.create_entity { name = "storage-tank", position = tank, force = "player", direction = dir }
  local started = 0
  if t then
    pcall(function() t.insert_fluid { name = ob.fluid, amount = cap } end)
    started = held(t)
  end
  made[#made + 1] = { slot = sl.label .. "/" .. ob.mode, fluid = ob.fluid, tank = t, started = started }
  rcon.print(string.format("  run %-16s %-5s <- %-10s pipes=%d tank=%s filled=%.0f", sl.label, ob.mode,
    ob.fluid, npipes, t and pos(tank) or "REFUSED", started))
end
rcon.print("trial recipe=" .. tostring(mm.get_recipe() and mm.get_recipe().name))
storage["a1_runs"] = made`;

const readRuns = `if not m then rcon.print("NO_REFINERY") return end
local rev = {} for k, v in pairs(defines.entity_status) do rev[v] = k end
local line = {}
for _, run in ipairs(storage["a1_runs"] or {}) do
  local t = run.tank
  local now = (t and t.valid) and held(t) or 0
  line[#line + 1] = string.format("%s %.0f->%.0f drained=%.0f", run.slot, run.started, now,
    math.max(0, run.started - now))
end
local inside = {}
pcall(function()
  for k, v in pairs(m.get_fluid_contents()) do
    local nm = (type(k) == "table") and k.name or k
    inside[#inside + 1] = nm .. "=" .. string.format("%.1f", (type(v) == "number") and v or (v.amount or 0))
  end
end)
table.sort(inside)
local by_fluid = {}
for _, p in ipairs(s.find_entities_filtered { name = "pipe", area = { { -30, -30 }, { 30, 30 } } }) do
  for k, v in pairs(p.get_fluid_contents()) do
    local nm = (type(k) == "table") and k.name or k
    by_fluid[nm] = (by_fluid[nm] or 0) + ((type(v) == "number") and v or (v.amount or 0))
  end
end
local pipes = {}
for nm, amt in pairs(by_fluid) do pipes[#pipes + 1] = nm .. "=" .. string.format("%.1f", amt) end
table.sort(pipes)
rcon.print(string.format("  status=%s(%d) tank[%s] machine[%s] pipes[%s]", tostring(rev[m.status]),
  m.status, table.concat(line, " "), table.concat(inside, " "), table.concat(pipes, " ")))`;

const teardown = `if s then
  for _, e in ipairs(s.find_entities_filtered { area = { { -30, -30 }, { 30, 30 } } }) do e.destroy() end
end
storage["a1_runs"] = nil
rcon.print("cleared")`;

// The face-by-face matrix above settled where each ingredient enters and through what. What is
// still unknown is the thing a two-fluid machine actually needs: whether one side can serve both,
// and if so which cells each run has to cover -- a box sits at one cell of a face, and a run only
// reaches the box it is laid over.
const FACES = ["east", "west", "south", "north"];
const RUN = (fluid, slot, mode, cells) =>  `{fluid="${fluid}", slot="${slot}", mode="${mode}"${cells ? `, cells="${cells}"` : ""}}`;
const TRIALS = [
  { label: "control: crude alone, south via pipes", runs: [RUN("crude-oil", "south", "pipes")] },
  { label: "control: water alone, south via pipes", runs: [RUN("water", "south", "pipes")] },
  { label: "all four faces at once, crude", runs: FACES.map((f) => RUN("crude-oil", f, "pipes")) },
  { label: "all four faces at once, water", runs: FACES.map((f) => RUN("water", f, "pipes")) },
  { label: "south split: crude {-2,-1} water {1,2}", runs: [
    RUN("crude-oil", "south", "pipes", "-2,-1"), RUN("water", "south", "pipes", "1,2")] },
  { label: "south split: water {-2,-1} crude {1,2}", runs: [
    RUN("water", "south", "pipes", "-2,-1"), RUN("crude-oil", "south", "pipes", "1,2")] },
  { label: "south split: crude {-2} water {0,1,2}", runs: [
    RUN("crude-oil", "south", "pipes", "-2"), RUN("water", "south", "pipes", "0,1,2")] },
  { label: "south split: crude {2} water {-2,-1,0}", runs: [
    RUN("crude-oil", "south", "pipes", "2"), RUN("water", "south", "pipes", "-2,-1,0")] },
  { label: "south split: water {0} crude {-2,-1} + {1,2}?", runs: [
    RUN("water", "south", "pipes", "0"), RUN("crude-oil", "south", "pipes", "-2,-1"),
    RUN("crude-oil", "south", "pipes", "1,2")] },
];
for (const t of TRIALS) t.recipe = "advanced-oil-processing";

(async () => {
  await r.ready();
  const run = async (label, body) => {
    if (label) console.log(`\n### ${label}`);
    console.log(await r.cmd(PRELUDE + "\n" + body));
  };
  const polls = Number(process.env.POLLS || 3);
  await run(null, teardown);
  if (!process.env.QUIET_GEOMETRY) {
    await run("one refinery on empty ground", setup);
    await run("slot geometry", geometry);
  }
  for (const t of TRIALS) {
    await run(t.label, trial(t.recipe, t.runs.join(",")));
    for (let i = 0; i < polls; i++) {
      await r.runFor(1500, 4);
      await run(null, readRuns);
    }
  }
  await run("teardown", teardown);
  r.close();
})();
