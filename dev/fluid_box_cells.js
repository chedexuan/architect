// Which cell of which face does each of a machine's fluid boxes sit on?
//
// Follows `dev/fluid_slots_probe.js`, which settled the coarser question: an oil refinery takes
// both of its ingredients through its south face, a whole-face pipe row reaches either box, and a
// 3-wide flush tank reaches only one of them. A box sits at one cell of a face and a run only
// reaches the box it is laid over, so a machine with two fluids on one face needs its runs placed
// against the cells -- and nothing in the runtime data says which cells. The engine will say it,
// one transaction at a time: a lone pipe holding 50 units, offered to one cell, either empties
// into the machine or it does not.
//
// Reading note: this probe measures one pipe, which is sound only because the machine here stands
// alone. The rig reads the whole connected network instead -- 50 units offered beside an empty pipe
// settle to 16.7 in each of three, and a single-pipe reading calls that "the machine drank it".
// Raw entities on arch-sandbox; dev/cycle.sh restarts from the save, so nothing here persists.
//
// What the `scan` phase has answered, since it was written to be re-asked of any machine:
//
//   ANSWERS (scan, assembling-machine-2 / concrete / water, 13 trials of one pipe each): the only machine
//   that ended up holding the water was the one with a pipe at its NORTH face, middle cell -- every other
//   cell of all four faces left the fluid in the pipe, and the control machine with no pipe beside it held
//   nothing. `ports.lua`, reading the prototype's own `pipe_connections`, names the same cell for a
//   north-facing assembler, and the two have disagreed nowhere yet. That cell is what `boxes.lua` carries.
//
//   ANSWERS (the same pass, on how to find a trial a second later): a handle does not work. All thirteen
//   `game.get_entity_by_unit_number` lookups answered nil for entities that `find_entities_filtered` at the
//   recorded cell found immediately -- one second of game time after they were created, not the same tick.
//   So a trial is stashed with its POSITION and resolved by cell, and the handle is kept beside it only to
//   prove the point: the read prints HANDLED_GONE next to any trial found by position but not by number.
//   Whatever the engine's reason, the rule for this rig is the one every other phase here already used.
const connect = require("./rcon_client");
const r = connect();

// Which machine, which recipe, which of its ingredients. The default is the fixture this file was
// written for -- the oil refinery, whose two south-face boxes were the first cells ever read here --
// and the point of the knobs is the `scan` phase: the SAME question asked of any machine, because the
// pipe row a drinking lane grows has to be laid against a cell that was read for THAT machine, and a
// lane that guesses one lays a pipe beside an empty box and reports a line that produces nothing.
//   MACHINE=assembling-machine-2 RECIPE=concrete FLUID=water PHASES=scan node dev/fluid_box_cells.js
const MACHINE = process.env.MACHINE || "oil-refinery";
const RECIPE = process.env.RECIPE || "basic-oil-processing";
const FLUID = process.env.FLUID || "crude-oil";
const TECHS = (process.env.TECHS || "oil-processing,advanced-oil-processing")
  .split(",").map((s) => s.trim()).filter((s) => s);
const TECH_LUA = "{" + TECHS.map((x) => `"${x}"`).join(",") + "}";

const PRELUDE = `
local function pos(p) return string.format("%.1f,%.1f", p.x, p.y) end
local function names_of(ent)
  local out = {}
  pcall(function()
    for k, v in pairs(ent.get_fluid_contents()) do
      local nm = (type(k) == "table") and k.name or k
      out[#out + 1] = nm .. "=" .. string.format("%.1f", (type(v) == "number") and v or (v.amount or 0))
    end
  end)
  table.sort(out)
  return out
end
-- the cell one tile outside the machine border, N tiles along that face from its centre
local function cell(m, face, off)
  local p = prototypes.entity[m.name]
  local e, ux, uy = m.position, 0, 0
  if face == "east" then ux = 1 elseif face == "west" then ux = -1
  elseif face == "south" then uy = 1 else uy = -1 end
  local span = (ux ~= 0) and p.tile_height or p.tile_width
  local d = span / 2 + 0.5
  return { x = e.x + d * ux + (ux ~= 0 and 0 or off), y = e.y + d * uy + (uy ~= 0 and 0 or off) }
end
local function unit(face)
  return ({ east = 1, west = -1, south = 0, north = 0 })[face],
    ({ east = 0, west = 0, south = 1, north = -1 })[face]
end
local s = game.surfaces["arch-sandbox"]
local m = s and s.find_entities_filtered { name = "${MACHINE}", area = { { -30, -30 }, { 30, 30 } } }[1]`;

const fresh = (recipe) => `if not s then rcon.print("NO_SANDBOX") return end
for _, e in ipairs(s.find_entities_filtered { area = { { -30, -30 }, { 30, 30 } } }) do e.destroy() end
pcall(function() s.create_global_electric_network() end)
s.create_entity { name = "electric-energy-interface", position = { 0, 16 }, force = "player" }
local f = game.forces.player
for _, t in ipairs(${TECH_LUA}) do
  if f.technologies[t] and not f.technologies[t].researched then f.technologies[t].researched = true end
end
local mm = s.create_entity { name = "${MACHINE}", position = { 0, 0 }, force = "player" }
if not mm then rcon.print("MACHINE_REFUSED") return end
pcall(function() mm.set_recipe("${recipe}") end)`;

const toLua = (v) => {
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return `"${v}"`;
  if (Array.isArray(v)) return "{" + v.map(toLua).join(",") + "}";
  return "{" + Object.entries(v).map(([k, val]) => `${k}=${toLua(val)}`).join(",") + "}";
};

// One offer per trial: pipes laid on the named cells, each either filled with the fluid under test
// or left empty to catch what the machine pushes out.
const offer = (recipe, what) => `${fresh(recipe)}
for _, o in ipairs(${toLua(what)}) do
  local p = s.create_entity { name = "pipe", position = cell(mm, o.face, o.off), force = "player" }
  if not p then rcon.print("PIPE_REFUSED " .. o.face .. " " .. o.off) return end
  if o.fluid then
    local ok, err = pcall(function() return p.insert_fluid { name = o.fluid, amount = o.amount } end)
    if not ok then rcon.print("INSERT_FAILED " .. o.face .. " " .. o.off .. " " .. tostring(err)) end
  end
  rcon.print(string.format("  pipe %-6s off=%-3d at %-10s %s", o.face, o.off, pos(p.position),
    table.concat(names_of(p), " ")))
end`;

// The supply row a measurement needs when the machine has to keep running: cells along one face
// and a tank behind one end of the row -- behind its middle and the tank of a second run on the
// same face shares its network, which is what made the split trials read as nothing at all.
const supplyRow = (face, cells, far, fluid) => `do
  local ux, uy = unit("${face}")
  local made = 0
  for _, off in ipairs(${toLua(cells)}) do
    if s.create_entity { name = "pipe", position = cell(mm, "${face}", off), force = "player" } then
      made = made + 1
    end
  end
  local at = cell(mm, "${face}", ${far})
  local tank_pos = { x = at.x + 2 * ux, y = at.y + 2 * uy }
  local dir = (ux > 0) and defines.direction.west or (ux < 0) and defines.direction.east
    or (uy > 0) and defines.direction.north or defines.direction.south
  local t = s.create_entity { name = "storage-tank", position = tank_pos, force = "player", direction = dir }
  if t then
    pcall(function()
      t.insert_fluid { name = "${fluid}", amount = prototypes.entity["storage-tank"].fluid_capacity }
    end)
  end
  rcon.print(string.format("  row ${face} pipes=%d asked=%s actual=%s %s", made, pos(tank_pos),
    t and pos(t.position) or "REFUSED", t and table.concat(names_of(t), " ") or ""))
end`;

const readCells = `if not m then rcon.print("NO_REFINERY") return end
local rev = {} for k, v in pairs(defines.entity_status) do rev[v] = k end
local by_pipe = {}
for _, p in ipairs(s.find_entities_filtered { name = "pipe", area = { { -30, -30 }, { 30, 30 } } }) do
  by_pipe[#by_pipe + 1] = string.format("%.1f,%.1f[%s]", p.position.x, p.position.y,
    table.concat(names_of(p), " "))
end
table.sort(by_pipe)
rcon.print(string.format("  status=%s(%d) machine[%s] pipes: %s", tostring(rev[m.status]), m.status,
  table.concat(names_of(m), " "), table.concat(by_pipe, " ")))`;

const dump = `if not s then rcon.print("NO_SANDBOX") return end
local out = {}
for _, e in ipairs(s.find_entities_filtered { area = { { -20, -20 }, { 20, 20 } } }) do
  out[#out + 1] = string.format("%-22s @ %-10s %s", e.name, pos(e.position),
    table.concat(names_of(e), " "))
end
table.sort(out)
rcon.print("  " .. table.concat(out, "\\n  "))`;

const teardown = `if s then
  for _, e in ipairs(s.find_entities_filtered { area = { { -30, -30 }, { 30, 30 } } }) do e.destroy() end
end
rcon.print("cleared")`;

const OFFSETS = [-2, -1, 0, 1, 2];
const CELL = (face, off, fluid) => ({ face, off, ...(fluid ? { fluid, amount: 50 } : {}) });

// 50 units is below one craft of either ingredient, so a box that takes it keeps it: the reading is
// "where did it go", not "did the machine happen to run".
const INPUT_TRIALS = [];
for (const fluid of ["crude-oil", "water"]) {
  for (const off of OFFSETS) {
    INPUT_TRIALS.push({ label: `${fluid} offered to south cell ${off}`,
      recipe: "advanced-oil-processing", what: [CELL("south", off, fluid)] });
  }
}

// Products leave through boxes of their own. One ingredient in via a proven row, and empty pipes on
// non-adjacent cells of the other three faces: the product that appears names the cell it came out
// of, and three products cannot share a network, so the first to arrive wins each cell.
const OUTPUT_TRIAL = {
  label: "crude in via the south row, empty pipes on three faces",
  recipe: "basic-oil-processing",
  what: ["north", "east", "west"].flatMap((face) => [-2, 0, 2].map((off) => CELL(face, off))),
};

// Which cell behind the row does a tank actually join it from? One trial per cell: the same
// five-cell row, the tank behind a different one of them. The reading is the tank's own level --
// a connected tank has already given the row ~490 units before anything is crafted.
const TANK_CELL_TRIALS = OFFSETS.map((far) => ({
  label: `crude row, tank behind cell ${far}`,
  recipe: "basic-oil-processing", far,
}));

const withRow = (recipe, face, cells, far, fluid, empties) => `${fresh(recipe)}
${supplyRow(face, cells, far, fluid)}
${empties ? `for _, o in ipairs(${toLua(empties)}) do
  s.create_entity { name = "pipe", position = cell(mm, o.face, o.off), force = "player" }
end` : ""}`;

(async () => {
  await r.ready();
  const run = async (label, body) => {
    if (label) console.log(`\n### ${label}`);
    console.log(await r.cmd(PRELUDE + "\n" + body));
  };
  const polls = Number(process.env.POLLS || 2);
  const settle = async (n) => {
    for (let i = 0; i < n; i++) {
      await r.runFor(1200, 4);
      await run(null, readCells);
    }
  };

  const phases = (process.env.PHASES || "tank").split(",");
  // Every cell of every face, asked of one machine each, in one settled pass: the trials cannot share
  // a pipe network (a connected row lets a machine drink from a pipe laid on another face, which is
  // how the first version of this file mistook a whole face for a box), so each candidate gets its own
  // machine standing far enough away that no two of their pipes can touch. One pipe, 50 units, one
  // cell: the machine that ends up holding the fluid was fed by that cell and by no other.
  //
  // A machine with no pipe beside it is in the same pass, because "the box is at cell 1" is only a
  // reading if a machine that drank nothing shows nothing.
  if (phases.includes("scan")) {
    await run(`scan ${MACHINE} / ${RECIPE} / ${FLUID}: build`, `
for _, e in ipairs(s.find_entities_filtered{area = {{-40, -40}, {160, 160}}}) do e.destroy() end
pcall(function() s.create_global_electric_network() end)
local f = game.forces.player
for _, t in ipairs(${TECH_LUA}) do
  if f.technologies[t] and not f.technologies[t].researched then f.technologies[t].researched = true end
end
local p = prototypes.entity["${MACHINE}"]
if not p then rcon.print("NO_MACHINE_PROTOTYPE") return end
local sw = math.floor((p.tile_width or 1) / 2)
local sh = math.floor((p.tile_height or 1) / 2)
local trials = { { face = "none", off = 0 } }
for off = -sw, sw do trials[#trials + 1] = { face = "north", off = off } end
for off = -sw, sw do trials[#trials + 1] = { face = "south", off = off } end
for off = -sh, sh do trials[#trials + 1] = { face = "east", off = off } end
for off = -sh, sh do trials[#trials + 1] = { face = "west", off = off } end
local kept, refused = {}, 0
for i, tr in ipairs(trials) do
  local m = s.create_entity { name = "${MACHINE}", position = { x = 6 + (i - 1) % 6 * 16,
    y = 6 + math.floor((i - 1) / 6) * 16 }, force = "player" }
  if not m then refused = refused + 1
  else
    pcall(function() m.set_recipe("${RECIPE}") end)
    s.create_entity { name = "electric-energy-interface", position = { x = m.position.x,
      y = m.position.y - 7 }, force = "player" }
    local pu, pp
    if tr.face ~= "none" then
      local pipe = s.create_entity { name = "pipe", position = cell(m, tr.face, tr.off), force = "player" }
      if pipe then
        pu = pipe.unit_number
        pp = { x = pipe.position.x, y = pipe.position.y }
        pcall(function() pipe.insert_fluid { name = "${FLUID}", amount = 50 } end)
      else
        rcon.print("PIPE_REFUSED " .. tr.face .. " " .. tr.off)
      end
    end
    -- the position goes in the stash alongside the handle: the read below is a second command, and this
    -- pass is where the two ways of resolving a trial get compared -- find_entities_filtered at the recorded
    -- cell (which is what every other read in this file does) against game.get_entity_by_unit_number, which
    -- once answered nil for 21 machines that had all been created a second earlier. A machine found by
    -- position but not by handle is the answer; both nil is a different problem, and the pass says which.
    kept[#kept + 1] = { m = m.unit_number, mp = { x = m.position.x, y = m.position.y },
      pu = pu, pp = pp, face = tr.face, off = tr.off }
  end
end
_G.FBC_SCAN = kept
rcon.print("trials=" .. #kept .. " refused=" .. refused .. " (cells per face follow the machine's own "
  .. "tile size, so a 5-wide machine is asked about five cells)")
`);
    await settle(polls);
    await run(null, `
local kept = _G.FBC_SCAN or {}
local out, drank, gone, unhandled = {}, 0, 0, 0
local rev = {} for k, v in pairs(defines.entity_status) do rev[v] = k end
local function at(name, p)
  if not p then return nil end
  local e = s.find_entities_filtered { name = name, area = { p, p }, force = "player" }[1]
  return e or (function() unhandled = unhandled + 1; return nil end)()
end
for _, rec in ipairs(kept) do
  local m = at("${MACHINE}", rec.mp)
  local p = at("pipe", rec.pp)
  if not m then out[#out + 1] = rec.face .. "/" .. rec.off .. "=GONE"; gone = gone + 1
  else
    local held = table.concat(names_of(m), " ")
    local pipe = p and table.concat(names_of(p), " ") or "-"
    local st; pcall(function() st = m.status end)
    if held:find("${FLUID}") then drank = drank + 1 end
    out[#out + 1] = string.format("%s/%d{machine=%s pipe=%s %s%s}", rec.face, rec.off,
      held, pipe, tostring(rev[st] or st),
      (rec.m and not game.get_entity_by_unit_number(rec.m)) and " HANDLED_GONE" or "")
  end
end
rcon.print("SCAN ${MACHINE} ${RECIPE} ${FLUID}: drank=" .. drank .. " of " .. #kept
  .. " gone=" .. gone .. " position_unfound=" .. unhandled)
rcon.print("  " .. table.concat(out, "  "))
_G.FBC_SCAN = nil`);
  }

  await run(null, teardown);

  if (phases.includes("input")) {
    for (const t of INPUT_TRIALS) {
      await run(t.label, offer(t.recipe, t.what));
      await settle(polls);
    }
  }

  // the row's own cells, one tank position per trial; the machine's crude box is at cell 1 so a
  // connected tank anywhere on the row should still fill it
  if (phases.includes("tank")) {
    for (const t of TANK_CELL_TRIALS) {
      await run(t.label, withRow(t.recipe, "south", OFFSETS, t.far, "crude-oil"));
      await settle(polls);
    }
  }

  if (phases.includes("output")) {
    await run(OUTPUT_TRIAL.label,
      withRow(OUTPUT_TRIAL.recipe, "south", OFFSETS, Number(process.env.FAR || 0), "crude-oil",
        OUTPUT_TRIAL.what));
    await settle(8);
  }

  // the shape the two cell answers demand: each ingredient gets its own row over its own box, and a
  // row that has to fit a tank clear of the other one's continues past the corner of the machine
  if (phases.includes("pair2")) {
    await run("crude {1,2,3}+tank at 3 || water {-2,-1}+tank at -1",
      `${fresh("advanced-oil-processing")}
${supplyRow("south", [1, 2, 3], 3, "crude-oil")}
${supplyRow("south", [-2, -1], -1, "water")}`);
    await settle(8);
  }

  // two runs, one face, each tank behind the outer end of its own row: the shape the cell
  // discovery says an oil refinery needs, and the one every middle-tank split failed at
  if (phases.includes("pair")) {
    await run("crude {1,2} + water {-2,-1}, tanks at the outer ends", `${fresh("advanced-oil-processing")}
${supplyRow("south", [1, 2], 2, "crude-oil")}
${supplyRow("south", [-2, -1], -2, "water")}`);
    await settle(8);
  }

  // Where do the products go? Same trick as the input probe, run the other way: empty isolated
  // pipes, and whichever one a product appears in names the cell its box sits on. Two rounds,
  // because a face's cells cannot all be isolated from each other in one pass.
  if (phases.includes("out")) {
    for (const pattern of [[-2, 0, 2], [-1, 1]]) {
      const empties = [];
      for (const face of ["north", "east", "west", "south"]) {
        for (const off of pattern) {
          // the crude row owns south cells 1..3, and a pipe beside it would join its network
          if (face === "south" && (off === 0 || off === 1 || off === 2)) continue;
          empties.push({ face, off });
        }
      }
      await run(`products: empty pipes at cells {${pattern.join(",")}}`, `${fresh("basic-oil-processing")}
${supplyRow("south", [1, 2, 3], 3, "crude-oil")}
for _, o in ipairs(${toLua(empties)}) do
  s.create_entity { name = "pipe", position = cell(mm, o.face, o.off), force = "player" }
end`);
      await settle(6);
    }
  }

  // If a script can take a product out of the machine's own box, the lab needs no collector
  // plumbing at all -- and the box level becomes a reading rather than a ceiling.
  if (phases.includes("drain")) {
    await run("can a box be drained by script?", `${fresh("basic-oil-processing")}
${supplyRow("south", [1, 2, 3], 3, "crude-oil")}`);
    await settle(3);
    await run(null, `if not m then rcon.print("NO_REFINERY") return end
for _, k in ipairs({"remove_fluid", "extract_fluid", "insert_fluid"}) do
  rcon.print("  " .. k .. "=" .. tostring(m[k]))
end
local rev = {} for kk, v in pairs(defines.entity_status) do rev[v] = kk end
rcon.print("  before: status=" .. tostring(rev[m.status]) .. " " .. table.concat(names_of(m), " "))
local ok, err = pcall(function() return m.remove_fluid { name = "petroleum-gas", amount = 1000 } end)
rcon.print("  remove_fluid ok=" .. tostring(ok) .. " took=" .. tostring(err))
rcon.print("  held_now=" .. table.concat(names_of(m), " "))`);
    await settle(3);
    await run(null, readCells);
  }

  await run("teardown", teardown);
  r.close();
})();
