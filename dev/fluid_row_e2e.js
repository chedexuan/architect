// The pipe row, end to end: a lane that DRINKS, laid by this mod, built by the engine, and proven by water
// reaching the machine's own box through the row -- and not reaching it while nobody has joined the port.
//
// Every lane this mod laid until now was fed by a chest, and a chest cannot hold what `concrete` wants.
// That was honest while it was true: the refusal said so by name. It stopped being true the moment the
// shape grew a row of pipe beside its machines, and this file is the witness that the row is a plumbing
// rather than a drawing.
//
// Four facts it is built on, each read rather than remembered. The second is the reason the row is laid by
// a pass over the FINISHED shape rather than inside the style that drew it:
//
//   * Where a machine's fluid box is. `ports.lua` reads it out of the prototype's own `pipe_connections`,
//     resolved for each facing, and `boxes.lua` carries the slower witness -- one pipe, 50 units, one cell,
//     and the machine that ended up holding the water. For assembling-machine-2 both say the same cell:
//     north face, middle, facing north.
//   * What the machine will really be standing like once it is built. Asked of the engine by putting one
//     down and reading it back, because 2.0 does not expose `rotatable` to a script and the answer is not
//     uniform: a chemical plant, an oil refinery, a belt, an arm, a combinator and a drill keep the facing
//     they are given, while an assembling machine, every furnace, a centrifuge and a lab come back NORTH and
//     then ignore a written `direction` too. A ghost is no better -- an assembler ghosted at direction 8
//     revives at 0. So a row drawn in the style's frame and turned with everything else would sit on the
//     wrong side of the machine it was laid to feed, and the pipe goes where the BUILT entity's box is.
//   * Whether that cell is free ground. The row is laid where nothing else stands -- which is how the two
//     belt styles turned out to be feedable after all (their machines have an aisle on the north side), and
//     how a lane that genuinely cannot be fed is refused with the blocking part named rather than with a
//     style's name guessed.
//   * What the fluid costs per minute: `units_per_min` is the recipe's own water-per-concrete ratio times
//     the rate the lane claims, checked against the engine's numbers rather than a figure remembered here.
//
// What is refused by name, and asserted here rather than commented: a fluid PRODUCT (a drain row is not a
// shape this mod lays), and two ingredients (two rows that touch are one network and a mixture).
//
// What this file's ground block does NOT claim: that the hand-laid lane crafted. Nothing in that block
// puts a power source near it, so its three machines sit at `no_power` and the witness there is the box
// filling -- which is the same instrument that found the box in `dev/fluid_box_cells.js` and needs no
// grid at all. That is a fact about that block, not about the bench: the ideal supply the rigs use
// (`electric-energy-interface` on a surface given `create_global_electric_network`) does power an
// electric crafter, and the measurement at the end of this file is the asserted version of that -- the
// same lane, with the same row, delivering concrete on the bench.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("fluid_row_e2e");

const call = (method, args) => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
    { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 28 });
  return JSON.parse(out.trim());
};
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: { ...process.env }, maxBuffer: 1 << 28 }).trim();
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const asArr = (v) => (Array.isArray(v) ? v : []);
// The console wrapper prints a warm-up reply and an `OK` tail around whatever the chunk printed, so a
// value has to be picked out of the noise rather than parsed off the last line.
const one = (s) => String(s).split(/\r?\n/)[0].trim();

const fails = [];
const check = (name, ok, detail) => {
  console.log((ok ? "ok   " : "FAIL ") + name + (detail === undefined ? "" : " :: " + String(detail).slice(0, 300)));
  if (!ok) fails.push(name);
};

// `concrete` drinks water and the recipe itself is a technology on this install; `automation-2` is what
// makes an assembling machine that can take a fluid at all. Both are put back the way they were found --
// a suite that leaves the research tree changed is a suite the next reader cannot blame.
const TECHS = ["automation", "automation-2", "concrete", "electronics", "logistics", "steel-processing",
  "fluid-handling"];
// Spelled as a Lua list rather than interpolated as JSON: `ipairs{["a"]=1}` is a table constructor with
// an index in it, which the engine refuses with a parse error it answers with silence.
const LUA_TECHS = TECHS.map((t) => JSON.stringify(t)).join(",");
const before = lua(`local f=game.forces.player
local out={}
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; out[#out+1]=t.."="..(x and tostring(x.researched) or "absent")
end
rcon.print(table.concat(out," "))`);
console.log("research before:", before);
const alreadyOn = {};
for (const pair of one(before).split(/\s+/)) {
  const [k, v] = pair.split("=");
  if (v === "true") alreadyOn[k] = true;
  check("a technology this line needs exists in the save: " + k, v !== "absent", pair);
}
lua(`local f=game.forces.player
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; if x then x.researched=true end
end
rcon.print("on")`);
// The machine and the recipe the whole file is about, checked as engine facts rather than assumed: if
// `concrete` is not enabled here, every "the machine drank it" reading below is a machine that was never
// allowed to craft, and that is the one failure this suite must not report as a pass.
const enabled = lua(`local f=game.forces.player
rcon.print("concrete="..tostring(f.recipes["concrete"] and f.recipes["concrete"].enabled)
  .." assembler="..tostring(f.recipes["assembling-machine-2"] and f.recipes["assembling-machine-2"].enabled)
  .." pipe="..tostring(f.recipes["pipe"] and f.recipes["pipe"].enabled))`);
console.log("recipes:", enabled);
check("this force can craft concrete, place the assembler and place the pipe",
  /concrete=true assembler=true pipe=true/.test(one(enabled)), enabled);

// Everything this run puts on the ground is recorded with the cell it landed on, and torn down by handle
// AND by cell: destroying one pipe re-creates neighbours it was joined to with new handles, which is how
// a previous suite left a belt standing that its own list said was gone.
const markHands = () => Number(lua("rcon.print(tostring(#(_G.FRF or {})))").split("\n")[0].trim() || 0);
const cleanTo = (keep) => lua([
  'local gone, by_cell = 0, 0',
  'while #(_G.FRF or {}) > ' + keep + ' do',
  '  local rec = table.remove(_G.FRF)',
  '  local e = rec and rec.ent',
  '  if e and e.valid then',
  '    local p = e.position',
  '    e.destroy()',
  '    gone = gone + 1',
  '    local s = game.surfaces[rec.surface]',
  '    if s then',
  '      for _,o in ipairs(s.find_entities_filtered{area={{math.floor(p.x)-1,math.floor(p.y)-1},'
  + '{math.floor(p.x)+1,math.floor(p.y)+1}}}) do',
  '        if o.name == rec.name then o.destroy(); by_cell = by_cell + 1 end',
  '      end',
  '    end',
  '  end',
  'end',
  'rcon.print("destroyed="..gone.." by_cell="..by_cell.." kept="..#(_G.FRF or {}))',
].join("\n"));

// Destroying one belt of a run leaves its neighbours standing under NEW handles -- the engine replaces them
// -- so a sweep by handle alone always misses some, and a leftover lane inside the next block's search area
// reads as a lane that is already there. This goes by name, over the rectangle the block was laid in, and
// repeats until the ground says nothing of ours is left (bounded, because a belt run that keeps
// re-creating itself would otherwise hang the suite rather than report it).
const sweepNames = (areaStr, names, surfName) => lua([
  'local s = game.surfaces["' + surfName + '"]',
  'local want = {}',
  'for _, n in ipairs{' + names.map((n) => `"${n}"`).join(",") + '} do want[n] = true end',
  'want["entity-ghost"] = true',
  'local gone, passes = 0, 0',
  'while passes < 6 do',
  '  local round = 0',
  '  for _, e in ipairs(s.find_entities_filtered{area=' + areaStr + '}) do',
  '    if want[e.name] then e.destroy(); round = round + 1 end',
  '  end',
  '  gone = gone + round; passes = passes + 1',
  '  if round == 0 then break end',
  'end',
  'rcon.print("swept=" .. gone .. " passes=" .. passes)',
].join("\n"));

// Where the ground block was laid, once it has been: `finish` has to sweep the same rectangle whether the
// run reached it or bailed out before.
let ground = null;

let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  try {
    for (let i = 0; i < 6; i++) call("place_undo", { count: 1 });
    console.log("exit cleanup:", cleanTo(0));
    if (ground) console.log("exit sweep:", sweepNames(ground.area, ground.names, ground.surf));
  } catch (e) { console.log("cleanup failed:", String(e).slice(0, 140)); }
  lua(`local f=game.forces.player
local want={${Object.keys(alreadyOn).map((k) => `[${JSON.stringify(k)}]=true`).join(",")}}
for _,t in ipairs{${LUA_TECHS}} do
  local x=f.technologies[t]; if x and not want[t] then x.researched=false end
end
rcon.print("restored")`);
  try { call("card_forget", { name: "lane-concrete-3" }); } catch (e) { /* never placed */ }
  console.log(fails.length ? "FAILURES: " + fails.join(", ") : "all checks passed");
  process.exit(code || (fails.length ? 1 : 0));
};

const RECIPE = "concrete";
const FLUID = "water";
const MACHINE = "assembling-machine-2";

// ---- what the card says it laid ----
const ex = call("card_example", { recipe: RECIPE, machines: 3, machine: MACHINE });
const card = ex.data || ex;
check("a lane that drinks comes back as a card rather than a refusal", !!card.name,
  ex.ok === false ? `${ex.code} ${ex.msg || ""}` : JSON.stringify([card.name, card.recipe]));
if (ex.ok === false) finish(1);
const ents = asArr(card.entities);
const feed = asArr(card.fluid_in);

// Which machine the lane stands is read from the engine rather than trusted: the whole feature is a
// machine that can take a fluid through a box, and a card built around a crafter that cannot run the
// recipe's category would be a shape nobody can build.
const cats = lua(`local p=prototypes.entity["${card.components.furnace}"]
local c={} for k,v in pairs(p.crafting_categories or {}) do if v then c[#c+1]=k end end
table.sort(c)
rcon.print(table.concat(c,",").."|"..tostring(prototypes.recipe["${RECIPE}"].category))`);
const [catList, catWant] = one(cats).split("|");
check("the machine the lane stands can run the recipe's category",
  catList.split(",").indexOf(catWant) >= 0, cats);
check("one fluid feed is reported, for water, across every machine in the lane",
  feed.length === 1 && feed[0].fluid === FLUID && feed[0].machines === 3, JSON.stringify(feed));
const f0 = feed[0] || {};
check("the row is made of pipe, chosen as a role and named in the answer",
  !!card.components.pipe && f0.pipe === card.components.pipe, card.components.pipe);
check("the box the fluid enters is named, with the rule that matched it",
  typeof f0.box === "number" && !!f0.how, JSON.stringify([f0.box, f0.how]));
check("the feed cell is a whole tile, so a 1x1 pipe can stand on it",
  typeof f0.off === "number" && f0.off === Math.floor(f0.off), f0.off);
check("and the row drinks the number the claim implies, not zero",
  typeof f0.units_per_min === "number" && f0.units_per_min > 0, JSON.stringify([f0.units_per_min,
    (card.contract || {}).outputs]));
// The fluid has to be declared where the rest of the mod looks for an in-port: on the machine whose box
// it is, as a `ports.in` row with a `fluid` and no `item`. That is the shape `compose` carries through a
// merge and the shape `card_lab` feeds -- a port left on the lane's own pipe is a port with no box to
// find, and the rig says so (`FLUID_PORT_NOT_ON_A_MACHINE`).
const fluidPorts = asArr(card.ports && card.ports["in"]).filter((p) => p.fluid === FLUID);
check("the fluid the machine drinks is declared as an in-port ON THE MACHINE, not on its pipe",
  fluidPorts.length === 3
    && fluidPorts.every((p) => ents[p.entity - 1]
      && ents[p.entity - 1].name === card.components.furnace),
  JSON.stringify([fluidPorts, asArr(card.ports && card.ports["in"])]));
check("and it comes back as an anchor too, so a composed region still knows what it owes",
  asArr(card.anchors).filter((a) => a.kind === "in" && a.fluid === FLUID).length === 3,
  JSON.stringify(asArr(card.anchors)));
// The card also says which recipe each of its machines runs. That binding is what lets lint, the rig and a
// hand-placed ghost agree about the lane's purpose -- and it was missing, which showed up as the rig
// answering RECIPE_UNFEEDABLE for a concrete lane: the chest is an in-port for ONE item, this recipe
// wants two, and nothing on the card said what the machines were there to do.
check("every machine in the lane is bound to the recipe the lane is a template for",
  Object.keys(card.machine_recipes || {}).length === 3
    && Object.keys(card.machine_recipes || {}).every((k) => card.machine_recipes[k] === RECIPE
      && ents[Number(k) - 1] && ents[Number(k) - 1].name === card.components.furnace),
  JSON.stringify([card.machine_recipes, (card.parts || {}).machines]));
// 100 water per craft, 10 concrete per craft: the demand the port has to meet, checked against the rate
// the lane itself promises rather than against a number written into this file.
const ratio = (typeof f0.units_per_min === "number" && card.contract && card.contract.outputs
  && card.contract.outputs[RECIPE]) ? f0.units_per_min / card.contract.outputs[RECIPE] : 0;
check("so the demand is the recipe's own water-per-concrete ratio", Math.abs(ratio - 10) < 0.001, ratio);
check("every pipe counted is a pipe in the card",
  (card.parts || {}).pipes === ents.filter((e) => e.name === "pipe").length,
  JSON.stringify([(card.parts || {}).pipes, ents.filter((e) => e.name === "pipe").length]));
check("a lane that drinks nothing still lays no pipe at all",
  (() => {
    const plain = call("card_example", { recipe: "iron-gear-wheel", machines: 2 });
    const d = plain.data || plain;
    return (d.parts || {}).pipes === 0 && asArr(d.fluid_in).length === 0;
  })(), "gear lane");

// The geometry, in the engine's words: a machine's box is one tile outside its own footprint, on the face
// the answer names, `off` tiles along it -- and that is where the stub has to be. `built_direction` is the
// facing the entity will really hold, measured rather than assumed (an assembling machine is built facing
// north however the card asked, which is the fact that moved this row out of the style and into a pass over
// the finished shape). So this check follows the machine, and says nothing about which row it should be.
const sizeOf = (name) => {
  const r = one(lua(`local p=prototypes.entity["${name}"]
rcon.print(string.format("%d %d", p.tile_width, p.tile_height))`));
  const [w, h] = r.split(/\s+/).map(Number);
  return { w, h };
};
const size = sizeOf(card.components.furnace);
const OUTWARD = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
const cellOf = (e) => [Math.floor(e.position.x), Math.floor(e.position.y)];
const machineCell = (e) => [Math.round(e.position.x - size.w / 2), Math.round(e.position.y - size.h / 2)];
const tipOf = (c, feed) => {
  const u = OUTWARD[feed.face];
  const off = feed.off || 0;
  return u[0] === 0
    ? [c[0] + Math.floor(size.w / 2) + off, c[1] + (u[1] < 0 ? -1 : size.h)]
    : [c[0] + (u[1] < 0 ? -1 : size.w), c[1] + Math.floor(size.h / 2) + off];
};
const pipesAt = new Set(ents.filter((e) => e.name === "pipe").map((e) => cellOf(e).join(",")));
const machines = ents.filter((e) => e.name === card.components.furnace);
check("the answer says which facing the machine will really be built in, and whether it keeps one",
  [0, 4, 8, 12].indexOf(f0.built_direction) >= 0 && typeof f0.keeps_facing === "boolean",
  JSON.stringify([f0.built_direction, f0.keeps_facing]));
check("each machine has a pipe one tile outside its own footprint, on the side its box faces",
  machines.length === 3 && machines.every((m) => pipesAt.has(tipOf(machineCell(m), f0).join(","))),
  JSON.stringify(machines.map((m) => [machineCell(m), tipOf(machineCell(m), f0)])));

// The port: the free end of the spine, and the one cell of a generated line the mod cannot finish.
const portEnt = ents[(f0.port || {}).entity ? f0.port.entity - 1 : -1];
check("the answer names a port, and it is a pipe", portEnt && portEnt.name === "pipe",
  JSON.stringify([f0.port, portEnt && portEnt.name]));
const portCell = portEnt && cellOf(portEnt);
const along = OUTWARD[f0.face][0] === 0;
const rowOf = (e) => (along ? cellOf(e)[1] : cellOf(e)[0]);
const axisOf = (e) => (along ? cellOf(e)[0] : cellOf(e)[1]);
const rowPipes = ents.filter((e) => e.name === "pipe").filter((e) => rowOf(e) === rowOf(portEnt));
check("the spine joins every stub into one unbroken run of pipe",
  rowPipes.length === (card.parts || {}).pipes && rowPipes.length >= 3 + 3,
  JSON.stringify([(card.parts || {}).pipes, rowPipes.length]));
const axisVals = rowPipes.map(axisOf).sort((a, b) => a - b);
check("with no hole in it, from the port to the farthest stub",
  axisVals.every((v, i) => i === 0 || v === axisVals[i - 1] + 1), JSON.stringify(axisVals));
check("and the port is one END of that run, so what a player joins is the row's own network",
  portCell && (axisOf(portEnt) === axisVals[0] || axisOf(portEnt) === axisVals[axisVals.length - 1]),
  JSON.stringify([axisOf(portEnt), axisVals[0], axisVals[axisVals.length - 1]]));
// The cell beyond the port -- away from the run, not between the port and its own row -- has to be free
// ground, because that is where a hand has to come in. A port hemmed in on both sides is a pipe nobody can
// join, and the row would claim a feed it cannot be given.
const portAxis = axisOf(portEnt || { position: { x: -999, y: -999 } });
const outward = portAxis === axisVals[0] ? -1 : 1;
const beyond = along ? [portCell ? portCell[0] + outward : -999, portCell[1]]
  : [portCell[0], portCell[1] + outward];
check("  and the cell beyond it is free ground for the hand that joins it",
  portCell && !ents.some((e) => {
    const c = cellOf(e);
    return c[0] === beyond[0] && c[1] === beyond[1];
  }), JSON.stringify([portCell, beyond]));
check("the fluid is the recipe's own ingredient, read from the engine",
  (() => {
    const r = one(lua(`local out={}
for _,i in ipairs(prototypes.recipe["${RECIPE}"].ingredients or {}) do
  if i.type=="fluid" then out[#out+1]=i.name..":"..tostring(i.amount) end
end
rcon.print(table.concat(out," "))`));
    return r.split(/\s+/).some((p) => p.split(":")[0] === FLUID) && f0.fluid === FLUID;
  })(), f0.fluid);

// ---- a turned lane: the same bargain, on the other axis ----
// A machine that does not keep its facing cannot be fed by a row that was drawn in a turned frame, so the
// honest answer for `concrete` standing up is a refusal that says which part is in the way -- unless the
// turned shape happens to leave the box's own face free, in which case the row is laid there. Either way is
// checked; what would be a lie is a vertical lane whose pipe is on the side the built machine does not
// present.
const vert = call("card_example", { recipe: RECIPE, machines: 3, machine: MACHINE, orientation: "vertical" });
const vd = vert.data || vert;
const vFeed = asArr(vd.fluid_in)[0] || {};
const vents = asArr(vd.entities);
if (vert.ok === false) {
  check("a vertical fluid lane is refused by name when the row cannot reach the box",
    vert.code === "LANE_FEED_ROW_UNREACHABLE", `${vert.code} ${vert.msg || ""}`);
} else {
  const vpipes = new Set(vents.filter((e) => e.name === "pipe").map((e) => cellOf(e).join(",")));
  const vmachines = vents.filter((e) => e.name === card.components.furnace);
  check("a vertical lane that does get a feed lays every stub opposite the box its machine really shows",
    vmachines.length === 3 && vmachines.every((m) => vpipes.has(tipOf(machineCell(m), vFeed).join(","))),
    JSON.stringify([vFeed.face, vFeed.built_direction, vmachines.map((m) => cellOf(m))]));
  check("  and the row is the whole of the pipe it counted",
    (vd.parts || {}).pipes === vents.filter((e) => e.name === "pipe").length,
    JSON.stringify([(vd.parts || {}).pipes, vents.filter((e) => e.name === "pipe").length]));
}

// The other two shapes, each with the answer this build gives. The feed row is chosen from the ground the
// finished shape leaves free, so these are measured verdicts rather than a table of what each style
// "supports": `row-belts` has an aisle on the north side of its machines and is fed; `sandwich-2`'s two rows
// of boxes sit on two different lines, which is a bend, and this mod does not lay bends (seams.lua says a
// bend is path finding through ground the mod does not own) -- so it is refused with that said, rather than
// laid as two half-rows where the far machines' pipes join nothing.
const rb = call("card_example", { recipe: RECIPE, machines: 3, machine: MACHINE, style: "row-belts" });
const rbd = rb.data || rb;
const vbf = asArr(rbd.fluid_in)[0] || {};
{
  const ps = new Set(asArr(rbd.entities).filter((e) => e.name === "pipe").map((e) => cellOf(e).join(",")));
  const ms = asArr(rbd.entities).filter((e) => e.name === card.components.furnace);
  check("row-belts: the lane it lays has every stub opposite a box, on ground nothing else stands on",
    ms.length === 3 && ms.every((m) => ps.has(tipOf(machineCell(m), vbf).join(","))),
    JSON.stringify([vbf.face, vbf.off, ms.map((m) => cellOf(m))]));
  const pipes = asArr(rbd.entities).filter((e) => e.name === "pipe");
  const alongV = (OUTWARD[vbf.face] || [0, -1])[0] === 0;
  const lineKey = (e) => (alongV ? cellOf(e)[1] : cellOf(e)[0]);
  const axisKey = (e) => (alongV ? cellOf(e)[0] : cellOf(e)[1]);
  const lines = new Set(pipes.map(lineKey));
  const axis = pipes.filter((e) => lineKey(e) === lineKey(pipes[0]))
    .map(axisKey).sort((a, b) => a - b);
  check("row-belts: its run is one unbroken line from the port to the farthest stub",
    lines.size === 1 && axis.every((v, i) => i === 0 || v === axis[i - 1] + 1),
    JSON.stringify([lines.size, axis]));
}
const sw = call("card_example", { recipe: RECIPE, machines: 4, machine: MACHINE, style: "sandwich-2" });
check("sandwich-2: refused, and said as the two lines its machines' boxes sit on",
  sw.ok === false && sw.code === "LANE_FEED_ROW_UNREACHABLE"
  && ((sw.detail || {}).blocked || {}).why === "FEED_SPAN_MULTIPLE_LINES"
  && (((sw.detail || {}).blocked || {}).first_line !== undefined),
  `${sw.code} ${String(sw.msg).slice(0, 140)} :: ${JSON.stringify((sw.detail || {}).blocked)}`);

// A furnace is the other half of the same promise, and it is not a failure: 2.0 gives a smelting machine
// no recipe setter at all (measured -- `set_recipe` answers "Entity is not assembling-machine"), and such a
// machine runs whatever its inputs allow, which is what the lane's own chest and belt are for. So the
// answer counts the machines it could not write separately from the ones it refused, and refuses nothing.
{
  const plate = call("card_example", { machines: 2 });
  const pc = plate.data || plate;
  const pfz = call("card_freeze", { card: pc, allow_unmeasured: true, name: "lane-plate-bind" });
  const real = call("card_place", { name: "lane-plate-bind", surface: "nauvis", ghosts: false });
  const rw = ((real.data || {}).wires) || {};
  const rr = rw.recipes || {};
  check("a lane of furnaces says its machines have no setter, and refuses nothing for it",
    pfz.ok === true && real.ok === true && Object.keys(pc.machine_recipes || {}).length === 2
    && rr.bound === 0 && (rr.no_setter || 0) === 2 && !rr.refused,
    JSON.stringify([real.code || "ok", pc.machine_recipes, rw.recipes]));
  for (let i = 0; i < 3; i++) { try { call("place_undo", { count: 1 }); } catch (e) { /* already back */ } }
  try { call("card_forget", { name: "lane-plate-bind" }); } catch (e) { /* never placed */ }
}

// And the refusal that IS somebody's mistake: a card can bind a machine to a recipe that does not exist,
// and the engine says so in its own words. The binding is not allowed to be theatre -- a machine that was
// "set" to nothing would be the same silent line as before this pass existed.
{
  const bogus = JSON.parse(JSON.stringify(card));
  const keys = Object.keys(bogus.machine_recipes || {});
  bogus.machine_recipes[keys[0]] = "no-such-recipe-anywhere";
  const bf = call("card_freeze", { card: bogus, allow_unmeasured: true, name: "lane-bogus-bind" });
  const br = call("card_place", { name: "lane-bogus-bind", surface: "nauvis", ghosts: false });
  const rec = ((br.data || {}).wires || {}).recipes || {};
  // One machine out of three bound to a name that does not exist: the other two still take theirs, and
  // the one that cannot is refused with the engine's own words -- no all-or-nothing, and no quiet half
  // line either.
  check("a card that binds one machine to a recipe that is not there refuses that one, with the engine's words",
    bf.ok === true && br.ok === true && rec.bound === 2 && asArr(rec.refused).length === 1
    && asArr(rec.refused)[0].why === "SET_RECIPE_FAILED"
    && /Unknown recipe name/.test(String(asArr(rec.refused)[0].note)),
    JSON.stringify([bf.code, br.code, rec]));
  for (let i = 0; i < 3; i++) { try { call("place_undo", { count: 1 }); } catch (e) { /* already back */ } }
  try { call("card_forget", { name: "lane-bogus-bind" }); } catch (e) { /* never placed */ }
}

// ---- what is refused before any shape is drawn, and said by name ----
const two = call("card_example", { recipe: "sulfur", machines: 2, machine: "chemical-plant" });
check("two ingredients on one lane refuse as one row carrying one fluid",
  two.ok === false && two.code === "LANE_FEEDS_ONE_FLUID", `${two.code} ${two.msg || ""}`);
check("  and the refusal names both fluids it cannot separate",
  two.ok === false && asArr((two.detail || {}).fluids).length === 2,
  JSON.stringify((two.detail || {}).fluids));
const prod = call("card_example", { recipe: "advanced-oil-processing", machines: 2, machine: "oil-refinery" });
check("a fluid PRODUCT still refuses, because a drain row is not a shape yet",
  prod.ok === false && prod.code === "LANE_CARRIES_NO_FLUIDS"
    && (prod.detail || {}).kind === "out", `${prod.code} ${prod.msg || ""}`);

// The refusal that is not about the fluid at all, but about the arm. An assembling machine's box is on its
// NORTH face, and the row a `row-chest` lane feeds from has to be the free aisle above the machine -- which
// only exists if the arm that lifts the belt's items into the machine stands further north than the box's
// own cell. With a reach-1 arm the arm IS that cell, so the pipe has nowhere to go and the lane is refused
// with the part named. Asking for a short arm is therefore not a hypothetical input here: it is the shape
// of a lane that cannot be plumbed.
const short = call("card_example", { recipe: RECIPE, machines: 2, machine: MACHINE, inserter: "inserter" });
check("a lane whose arm is short enough to stand in the row is refused, and names the arm",
  short.ok === false && short.code === "LANE_FEED_ROW_UNREACHABLE"
  && ((short.detail || {}).blocked || {}).why === "FEED_ROW_TAKEN"
  && ((short.detail || {}).blocked || {}).taken_by === "inserter",
  `${short.code || "accepted"} ${String(short.msg).slice(0, 120)} :: ${JSON.stringify((short.detail || {}).blocked)}`);

// ---- on the ground: does the water actually get there ----
// Placed the way every other lane suite places a line: on the map, in ground the placement finds free. A
// fluid finds its own level with no power at all -- that is the whole instrument of
// `dev/fluid_box_cells.js`, and it is what makes the box reading below a witness rather than a hope.
const fz = call("card_freeze", { card, allow_unmeasured: true, name: "lane-concrete-3" });
check("the lane freezes with its pipes in it", fz.ok, fz.ok ? fz.data.name : `${fz.code} ${fz.msg || ""}`);
if (!fz.ok) finish(1);

const mark = markHands();
const pl = call("card_place", { name: "lane-concrete-3", surface: "nauvis" });
const pp = pl.data || {};
const surf = pp.surface || "nauvis";
const origin = pp.origin || { x: 0, y: 0 };
const fp = card.footprint || { width: 40, height: 12 };
check("placed as ghosts, pipes included", pl.ok && pp.ghosts === ents.length,
  pl.ok ? `${pp.ghosts}/${ents.length} at ${origin.x},${origin.y}` : `${pl.code} ${pl.msg || ""}`);
if (!pl.ok) finish(1);

const area = `{{${origin.x - 2},${origin.y - 2}},{${origin.x + fp.width + 2},${origin.y + fp.height + 2}}}`;
ground = { area, surf, names: Array.from(new Set(ents.map((e) => e.name))) };
const built = lua(`local s=game.surfaces["${surf}"]
_G.FRF = _G.FRF or {}
local n, errs = 0, {}
for _,g in ipairs(s.find_entities_filtered{area=${area},type="entity-ghost"}) do
  local at, nm = g.position, g.ghost_name
  local ok, err = pcall(function() g.silent_revive{raise_revive=true} end)
  if not ok then errs[#errs+1]=tostring(err):sub(1,70) else
    local found = s.find_entities_filtered{area={{math.floor(at.x)-1,math.floor(at.y)-1},
      {math.floor(at.x)+1,math.floor(at.y)+1}}, name=nm}
    if found[1] then n=n+1
      _G.FRF[#_G.FRF+1]={ent=found[1], name=nm, surface="${surf}", at=found[1].position}
    else errs[#errs+1]="no entity at "..nm end
  end
end
rcon.print("revived="..n.." errs=["..table.concat(errs,"; ").."]")`);
console.log("built:", built);
check("the engine built every part of the lane, the row of pipe with it",
  new RegExp("revived=" + ents.length + " .*errs=\\[\\]").test(built), built);

// The starved half of the witness: the machines have their ingredients and no water, so nothing is
// crafted. Without this reading, "the water got in" would say nothing about which pipe carried it.
// Nothing here sets a recipe: the card bound one (see the machine_recipes check above), the build was
// done by the engine, and what the machine says it is making is that promise arriving or not.
const starved = lua(`local s=game.surfaces["${surf}"]
local out = {}
local chests = s.find_entities_filtered{area=${area}, type="container"}
table.sort(chests, function(a,b) return a.position.x < b.position.x end)
local feeding = chests[1]
if feeding then
  feeding.insert{name="iron-ore", count=64}
  feeding.insert{name="stone-brick", count=64}
end
local rev={} for k,v in pairs(defines.entity_status) do rev[v]=k end
for _,m in ipairs(s.find_entities_filtered{area=${area}, name="${card.components.furnace}"}) do
  local held = {}
  -- 2.0 hands a box back as {name = units}: a plain number per entry. Indexing v.amount is how the
  -- first cut raised, and a suite whose read chunk raised reports an empty answer about a line that ran.
  pcall(function() for k,v in pairs(m.get_fluid_contents()) do held[#held+1]=tostring(type(k)=="table" and k.name or k) end end)
  local now = (m.get_recipe or function() return nil end)()
  out[#out+1]=string.format("recipe=%s fluid=[%s] status=%s",
    tostring(now and now.name or "none"), table.concat(held,","), tostring(rev[m.status] or m.status))
end
rcon.print("fed="..tostring(feeding~=nil).." "..table.concat(out," | "))`);
console.log("starved:", starved);
// The card's own coordinates are relative to the shape's origin, and the origin is the cell the placement
// chose -- so a port the answer names is only testable on the ground after adding the two.
const PORT = f0.port && f0.port.position;
const PW = PORT ? origin.x + PORT.x : 0;
const PH = PORT ? origin.y + PORT.y : 0;
const atPort = `s.find_entities_filtered{area={{${PW - 0.6},${PH - 0.6}},{${PW + 0.6},${PH + 0.6}}}, name="pipe"}[1]`;
check("the port cell the answer names is where a pipe was built",
  PORT && one(lua(`local s=game.surfaces["${surf}"]
rcon.print((${atPort}) and "pipe" or "none")`)) === "pipe", JSON.stringify([PORT, origin]));
sleep(4500);
const noCraft = lua(`local s=game.surfaces["${surf}"]
local n = 0
for _,c in ipairs(s.find_entities_filtered{area=${area}, type="container"}) do
  n = n + c.get_item_count("concrete")
end
local held = 0
for _,m in ipairs(s.find_entities_filtered{area=${area}, name="${card.components.furnace}"}) do
  pcall(function() for k,v in pairs(m.get_fluid_contents()) do held = held + (tonumber(v) or (type(v)=="table" and v.amount) or 0) end end)
end
rcon.print("concrete="..n.." machine_fluid="..string.format("%.1f", held))`);
console.log("before the port is joined:", noCraft);
check("with the row laid and nobody's network joined to it, no fluid has reached a box",
  /machine_fluid=0\.0/.test(noCraft), noCraft);
check("  and the lane has not produced anything either", /concrete=0 /.test(noCraft), noCraft);

// The instrument, and its own control. A machine's box reports how many things it is joined to through its
// fluid box, and that is the engine's answer to "does a pipe reach this box" -- so a machine standing alone
// has to answer zero, or the reading below would be a number that means nothing.
const control = lua(`local s=game.surfaces["${surf}"]
local at = { x = ${origin.x + fp.width + 6.5}, y = ${origin.y + 6.5} }
for _, e in ipairs(s.find_entities_filtered{area={{at.x-3,at.y-3},{at.x+3,at.y+3}}}) do e.destroy() end
local m = s.create_entity{name="${card.components.furnace}", position=at, force="player"}
-- A crafting machine carries only the boxes its CURRENT recipe needs, so the box a reader is about to ask
-- about does not exist until the recipe does -- and get_connections on a box that is not there raises
-- "Passed index is out of range", which is not the same fact as "a box joined to nothing".
pcall(function() m.set_recipe("${RECIPE}") end)
local boxes, n = 0, -1
pcall(function() boxes = #m.fluidbox end)
pcall(function() if boxes > 0 then n = 0 for _ in pairs(m.fluidbox.get_connections(1) or {}) do n = n + 1 end end end)
if m then _G.FRF[#_G.FRF+1]={ent=m, name=m.name, surface="${surf}", at=m.position} end
rcon.print("alone_boxes="..tostring(boxes).." joined="..tostring(n))`);
console.log("control:", control);
check("a machine with no pipe beside it reports a box joined to nothing",
  /alone_boxes=[1-9] joined=0/.test(control), control);

// Now the player joins the network: water at the port, and the row carries it the length of the lane. The
// amount is more than the row can hold on purpose -- what is being read is how far it got, not how much of
// it survived.
const joined = lua(`local s=game.surfaces["${surf}"]
local p = ${atPort}
if not p then rcon.print("NO_PORT") return end
local ok, err = pcall(function() return p.insert_fluid{name="${FLUID}", amount=20000} end)
rcon.print("insert="..tostring(ok)..(ok and "" or tostring(err)).." port_now="
  ..string.format("%.1f", (function()
    local t=0 for k,v in pairs(p.get_fluid_contents()) do t=t+(tonumber(v) or (type(v)=="table" and v.amount) or 0) end return t end)()))`);
console.log("joined:", joined);
check("the port is a pipe the fluid can be put into", /insert=true/.test(joined), joined);
sleep(6000);
const ran = lua(`local s=game.surfaces["${surf}"]
local function held(x)
  local t = 0
  pcall(function() for k, v in pairs(x.get_fluid_contents()) do
    t = t + (tonumber(v) or (type(v) == "table" and v.amount) or 0) end end)
  return t
end
local pipes, dry = 0, 0
for _, x in ipairs(s.find_entities_filtered{area=${area}, name="pipe"}) do
  pipes = pipes + 1
  if held(x) <= 0 then dry = dry + 1 end
end
local out = {}
for _, m in ipairs(s.find_entities_filtered{area=${area}, name="${card.components.furnace}"}) do
  local n = 0
  pcall(function() for _ in pairs(m.fluidbox.get_connections(1) or {}) do n = n + 1 end end)
  out[#out+1] = string.format("joined=%d box=%.0f at %.1f,%.1f", n, held(m), m.position.x, m.position.y)
end
local made = 0
for _, c in ipairs(s.find_entities_filtered{area=${area}, type="container"}) do
  made = made + c.get_item_count("concrete")
end
rcon.print(string.format("pipes=%d dry=%d made=%d machines[%s]", pipes, dry, made, table.concat(out, " | ")))`);
console.log("after the water:", ran);
// What the row carries, in the engine's own words: water in every pipe of the run from the port to the
// farthest stub, and every machine's box joined to something on its outside cell.
check("water reached every pipe of the row, port end to farthest stub",
  /dry=0 /.test(ran) && /pipes=([1-9][0-9]*)/.test(ran), ran);
check("and every machine's box is joined to the row laid beside it",
  (ran.match(/joined=[1-9]/g) || []).length === machines.length, ran);
// The fluid is not merely in the pipes: it is inside each machine's own box, which is the difference
// between a row that reaches the machine and a row that stops next to it. A box only takes fluid once the
// machine has a recipe that drinks it -- the same machine with no recipe held nothing while the pipe beside
// it was full -- so this is also the reading that says the port, the row and the box are one network.
check("and the water is inside every machine's box, not just beside it",
  (ran.match(/box=[1-9]/g) || []).length === machines.length, ran);
// What this file does NOT claim: that the lane crafted. Every machine here reports `status=no_power` -- the
// ideal supply the rigs use (`electric-energy-interface`) neither consumes nor produces, and 2.0 gives a
// script no way to fuel a `burner-generator`: `insert` lands in an inventory the burner does not read, and
// there is no `fuel_inventory` at all. So `made` is printed and not asserted: the row has done everything a
// row can do -- the water is in the boxes -- and what is missing is the machine being allowed to spend it.
// Put the same lane inside a powered base and it will run; that half is the player's ground, not this
// suite's claim.
console.log("crafted (printed, not asserted: the bench has no source):", ran);
// The card said `concrete` for every machine it stands; the ghosts were built by the engine, not by this
// mod; and the machines now say the same. This is the promise `machine_recipes` made arriving -- before
// it existed, a lane built out of ghosts came up on `no recipe` and a player watched a line that never
// moved while the plan above it promised 90 a minute.
check("the built machines say the recipe the card bound, with nothing of this suite's writing it",
  (starved.match(/recipe=concrete/g) || []).length === machines.length, starved);

// Both halves of the teardown, in the order that makes the count meaningful: the ghosts this mod placed
// and never built are taken back through its own ledger, then everything this run recorded -- by handle and
// by the cell it was recorded at -- is destroyed. Sweeping first would leave a row of ghosts standing, and
// a leftover lane in the next block's search area reads as a lane that already exists.
for (let i = 0; i < 6; i++) { try { call("place_undo", { count: 1 }); } catch (e) { /* nothing to undo */ } }
console.log("undo:", cleanTo(mark));
console.log("sweep:", sweepNames(area, ground.names, surf));
// Counted by the names this lane is made of, not by everything in the rectangle: the bench ground has ore,
// rocks and coal on it, and a sweep that reports those as leftovers teaches the next reader to ignore the
// number.
const partNames = Array.from(new Set(ents.map((e) => e.name)));
const leftStanding = lua(`local s=game.surfaces["${surf}"]
local want = {}
for _, n in ipairs{${partNames.map((n) => `"${n}"`).join(",")}} do want[n] = true end
want["entity-ghost"] = true
local n, kinds = 0, {}
for _, e in ipairs(s.find_entities_filtered{area=${area}}) do
  if want[e.name] then
    n = n + 1
    kinds[e.name] = (kinds[e.name] or 0) + 1
  end
end
local parts = {}
for k, v in pairs(kinds) do parts[#parts + 1] = k .. "=" .. v end
table.sort(parts)
rcon.print("left=" .. n .. " " .. table.concat(parts, " "))`);
check("the block is swept clean -- every part this run laid is gone", /left=0/.test(leftStanding), leftStanding);

// ---- the bench measures the lane through the row the lane itself laid ----
// The ground above proves the row carries water. This proves the rig MEASURES through it: `card_lab`
// used to stop at `supply_unproven` for any lane that drinks, because it laid a second supply run of its
// own over a cell the lane's pipe already occupied, and then stood a full storage tank behind it -- and
// a tank, measured here, gives up nothing on its own: 25000 units sat in one for fifteen seconds beside
// a machine reporting `fluid_ingredient_shortage` with both of its item ingredients already in hand,
// while the same water poured into the row's pipe filled the box at once (dev/supply_pump_e2e.js, and no
// facing of a pump fixes it). So the supply is the row: pour into its port pipe, meter what the network
// loses, and that loss is what the machine drank.
{
  const lab = call("card_lab", { card, seconds: 60, speed: 40 });
  const ld = lab.data || {};
  check("a lane that drinks starts a measurement instead of refusing one",
    lab.ok && (ld.state === "proving" || ld.state === "running" || ld.state === "probing"),
    lab.ok ? `state=${ld.state} obligations=${ld.fluid_obligations} box_table=${ld.box_table_served || 0}`
      : `${lab.code} ${lab.msg || ""}`);
  check("and the card said which of its own parts is the inlet, so the rig does not lay a second row",
    ld.fluid_obligations === 3, JSON.stringify(ld.fluid_obligations));
  let fin = null;
  const until = Date.now() + 120000;
  while (Date.now() < until) {
    sleep(3000);
    const st = call("lab_status", {});
    const d = st.data || {};
    if (d.state !== "probing" && d.state !== "proving" && d.state !== "running") { fin = d; break; }
  }
  const faces = asArr(fin && fin.supply_faces);
  const row = faces.filter((f) => f.source === "card_row");
  console.log("lab:", JSON.stringify(fin && { state: fin.state, produced: fin.produced,
    per_min: fin.measured_per_min, faces: faces, status: fin.machine_status }).slice(0, 700));
  check("the measurement opened on a plan that was moving fluid",
    fin && fin.state === "done", JSON.stringify(fin && { state: fin.state,
      problems: fin.supply_problems, notes: fin.box_notes }));
  check("one supply is the lane's own row, metered at its port, feeding all three machines",
    row.length === 1 && (row[0].serves || []).length === 3 && row[0].units > 0,
    JSON.stringify(faces));
  // The number the row has to carry is the recipe's own ratio times the rate the lane claims, and the
  // metering above is in the same units -- so the two can be compared without a figure written in here.
  const want = (typeof f0.units_per_min === "number" ? f0.units_per_min : 0) * 60;
  check("and what it drank is not a rounding error of the row's own capacity",
    row.length === 1 && row[0].units > 0 && want > 0, JSON.stringify([row[0] || {}, want]));
  check("the machines ran the recipe the card bound, and say so at the end of the window",
    asArr(fin && fin.machine_status).length === 3
      && asArr(fin.machine_status).every((m) => m.recipe === RECIPE),
    JSON.stringify(asArr(fin && fin.machine_status)));
  check("the bench's grid does power an electric crafter (the claim this whole feature rests on)",
    asArr(fin && fin.machine_status).every((m) => m.status !== "no_power"),
    JSON.stringify(asArr(fin && fin.machine_status)));
  call("lab_reset", {});
}

// The same instrument aimed at a row that does NOT reach a box. The three pipes standing on the
// machines' own cells are lifted out, the spine and its port are left where they are, and the rig is
// asked what it makes of that: the metered network now stops one cell short of every machine, so the
// honest answer is a row that fed nothing -- said about the row, not as a stale `boxes.lua` entry and
// not as a rate of zero.
{
  const stubs = new Set(machines.map((m) => tipOf(machineCell(m), f0).join(",")));
  const broken = JSON.parse(JSON.stringify(card));
  // Replaced rather than removed: the port is named by its index in this same list, so dropping three
  // parts would move it and the test would be about a card that points at nothing. A chest on the box's
  // cell keeps the index, keeps the ground occupied, and leaves the row short of every machine.
  let swapped = 0;
  broken.entities = broken.entities.map((e) => {
    if (e.name === "pipe" && stubs.has(cellOf(e).join(","))) { swapped = swapped + 1; return { ...e, name: "iron-chest" }; }
    return e;
  });
  check("the broken card keeps its indices and loses the three cells that touch the boxes",
    swapped === 3 && broken.entities.length === card.entities.length,
    JSON.stringify([swapped, broken.entities.length, card.entities.length]));
  const lab2 = call("card_lab", { card: broken, seconds: 5, speed: 40 });
  let fin2 = null;
  const until2 = Date.now() + 90000;
  while (Date.now() < until2) {
    sleep(2000);
    const st = call("lab_status", {});
    const d = st.data || {};
    if (d.state !== "probing" && d.state !== "proving" && d.state !== "running") { fin2 = d; break; }
  }
  const problems = asArr(fin2 && fin2.supply_problems);
  const unproven = problems.some((p) => p.why === "CARD_ROW_NOT_FED");
  check("a row that stops short of every box is named as that row, and the job does not open a window",
    fin2 && fin2.state === "supply_unproven" && unproven,
    JSON.stringify(fin2 && { state: fin2.state, problems: fin2.supply_problems }));
  call("lab_reset", {});
}
finish(fails.length ? 1 : 0);
