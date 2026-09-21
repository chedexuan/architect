// Do the three answers to "which cell is this machine's fluid port" agree?
//
// There are now three ways to get that cell, and they were bought in three different ways:
//
//   data      `ports.lookup` -- the prototype's `pipe_connections`, rotated by the facing
//   measured  `boxes.lookup` -- a cell that was proven to drink fluid, frozen into a table
//   live      `ports.read` -- what a standing machine answers about itself, recipe included
//
// The first is new and generalises to machines nobody has probed; the second is the only one that has
// ever been trusted; the third is what a placed entity says after the engine has resolved its recipe.
// This probe makes them face each other in both directions -- a cell the data names that the table
// denies, and a cell the table claims that the data cannot reach -- and then rotates a real machine
// through all four facings, because the rotation rule is arithmetic and arithmetic is exactly what
// wants checking against the engine.
//
// Run after `bash dev/cycle.sh`.
const { execFileSync } = require("child_process");
const path = require("path");

const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 29, stdio: ["ignore", "pipe", "ignore"] }).trim());
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8", maxBuffer: 1 << 29 });
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) fails++;
};

const DIRS = [0, 4, 8, 12];

(async () => {
  // the lab surface is created on demand and its chunks land a few ticks later; the live half of
  // this probe places a machine on it, so there has to be ground under it
  for (let i = 0; i < 12; i++) {
    const ready = call("sandbox", {});
    if (ready.ok) break;
    sleep(2000);
  }

  // ---- 1. data vs the frozen measurement, on the one machine the table knows ----
  const refined = call("machine_ports", { machine: "oil-refinery", recipe: "advanced-oil-processing" });
  check("the read reproduces every cell the measured table claims, with none extra",
    refined.ok && asArr(refined.data.by_direction).every((d) => d.diverged_count === 0)
    && asArr(refined.data.by_direction)[0].entries.length === 5,
    refined.ok ? `directions ${DIRS.join(",")} diverged=${asArr(refined.data.diverged || []).length}` : `${refined.code} ${refined.msg}`);
  const dir0 = refined.ok && asArr(refined.data.by_direction).find((d) => d.direction === 0);
  const claimed = dir0 && asArr(dir0.entries).filter((e) => e.measured);
  check("the three cells that had been measured are the same face and offset, not merely the same count",
    claimed && claimed.length === 3
    && claimed.every((e) => e.measured.face === e.face && Math.abs(e.measured.off - e.off) < 0.001),
    JSON.stringify((claimed || []).map((e) => `${e.fluid}:${e.face}${e.off >= 0 ? "+" : ""}${e.off}=measured`)));
  // the gap in the old table, named rather than left implicit
  const filled = dir0 && asArr(dir0.entries).filter((e) => e.kind === "out" && !e.measured).map((e) => e.fluid);
  check("the read fills the outlet cells the table never had, and says which ones they are",
    filled && filled.length === 2 && filled.includes("heavy-oil") && filled.includes("light-oil"),
    JSON.stringify(filled));

  // ---- 2. data vs a machine that is standing there, in all four facings ----
  const wipe = () => lua(`local s=game.surfaces["arch-sandbox"]
if s then for _,e in ipairs(s.find_entities_filtered{area={{-40,-40},{40,40}}}) do e.destroy() end end
rcon.print("sandbox wiped")`);
  wipe();
  for (const d of DIRS) {
    wipe();
    // no power here on purpose: a machine reports its boxes whether or not it can run, and merging
    // the surface into one electric network is the slow thing that timed this probe out
    console.log("  place dir " + d + ": " + lua(`local s=game.surfaces["arch-sandbox"]
if not s then rcon.print("NO_SURFACE") return end
local e=s.create_entity{name="oil-refinery", position={x=0.5, y=0.5}, force="player", direction=${d}}
if not e then rcon.print("REFUSED") return end
local ok,err=pcall(function() return e.set_recipe("advanced-oil-processing") end)
rcon.print("placed dir ${d} recipe="..tostring(ok).." boxes="..tostring(#e.fluidbox))`));
    const live = call("machine_ports", { surface: "arch-sandbox", at: { x: 0.5, y: 0.5 } });
    const readBack = live.ok && asArr(live.data.boxes);
    const fromData = live.ok && live.data.from_data && asArr(live.data.from_data.entries);
    const kind = (k) => (k || "").startsWith("in") ? "in" : (k || "").startsWith("out") ? "out" : k;
    const cells = (list) => (list || []).map((b) => `${kind(b.kind)}:${b.face},${b.off}`).sort();
    const same = readBack && fromData && JSON.stringify(cells(readBack)) === JSON.stringify(cells(fromData));
    check(`a standing refinery facing ${d} answers the same cells the data derives`,
      live.ok && live.data.direction === d && readBack && readBack.length === 5 && same,
      live.ok ? `live ${JSON.stringify(cells(readBack))} data ${JSON.stringify(cells(fromData))}`
        : `${live.code} ${live.msg}`);
    check(`  the live read also names the recipe it resolved (dir ${d})`,
      live.ok && live.data.recipe === "advanced-oil-processing",
      live.ok ? String(live.data.recipe) : live.code);
  }

  // ---- 3. the live read knows the recipe, and the recipe decides which boxes exist ----
  const basic = lua(`local s=game.surfaces["arch-sandbox"]
local e=s.find_entities_filtered{area={{-40,-40},{40,40}}, name="oil-refinery"}[1]
e.set_recipe("basic-oil-processing")
local fb=e.fluidbox
rcon.print(helpers.table_to_json({boxes=#fb}))`);
  console.log("  (basic-oil-processing leaves the live machine with fewer boxes:", basic.replace(/\s+/g, " "));

  lua(`local s=game.surfaces["arch-sandbox"]
if s then for _,e in ipairs(s.find_entities_filtered{area={{-40,-40},{40,40}}}) do e.destroy() end end
rcon.print("cleared")`);

  console.log(`\n${fails === 0 ? "all three answers agree" : fails + " FAILED"}`);
  process.exit(fails ? 1 : 0);
})();
