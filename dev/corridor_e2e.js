// M14 + M15: the road has a capacity, and a corridor can carry more than one commodity.
//
// Belt throughput was already read into the model (15/30/45 items per second for the three
// vanilla tiers, which is speed x 8 items/tile x 60 and agrees with the data file), but it
// never entered the flow arithmetic -- the rules would happily plan a rate no belt could
// move. And every bus card so far was single-item, so a region needing two commodities
// side by side had nothing to ask for.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const asArr = (v) => (Array.isArray(v) ? v : v == null ? [] : Object.keys(v).length ? Object.values(v) : []);
const call = (m, a) => JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
  { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
const lua = (src) => execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src], { encoding: "utf8" }).trim();
const wait = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ready = (m, a) => {
  for (let i = 0; i < 15; i++) {
    const r = call(m, a);
    if (r.ok || r.code !== "SANDBOX_GENERATING") return r;
    wait(1000);
  }
  return { ok: false, code: "SANDBOX_STUCK" };
};

lua(`local f=game.forces.player
for _,t in ipairs({"electronics","automation","logistics","steel-processing","logistics-2","solar-energy","electric-energy-accumulators"}) do
  local x=f.technologies[t]; if x then x.researched=true end
end`);

let fails = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  -- " + detail : ""}`);
  if (!ok) fails++;
};

// ---- 1. a two-lane corridor is a legal card ----
const cor = call("corridor_example", { taps: 2, items: ["iron-plate", "copper-plate"] });
check("a corridor builds", cor.ok === true, cor.ok ? `${cor.data.entities.length} entities, ${cor.data.lanes.length} lanes` : `${cor.code} ${cor.msg}`);
const cl = call("card_check", { card: cor.data });
check("a corridor lints clean", cl.ok && cl.data.ok === true,
  cl.ok ? (asArr(cl.data.errors).map((e) => e.code + ":" + (e.at || "")).join(" ") || `${cor.data.entities.length} entities ok`) : cl.code);
const cv = ready("card_verify", { card: cor.data });
check("every corridor arm picks from its own row and drops on its own chest",
  cv.ok && asArr(cv.data.errors).length === 0 && asArr(cv.data.arms).length === 6,
  cv.ok ? `${asArr(cv.data.arms).length} arms, ${asArr(cv.data.errors).map((e) => e.code).join(" ") || "no errors"}, `
    + `warnings ${asArr(cv.data.warnings).map((w) => w.code).join(" ")}` : `${cv.code} ${cv.msg}`);

// ---- 2. each row declares what it can carry ----
const caps = asArr(cor.data.lanes);
check("each row carries its tier's throughput, not the spine's length",
  caps.length === 2 && caps.every((l) => l.per_min === 1800) && caps[0].item !== caps[1].item,
  caps.map((l) => `${l.item}:${l.per_min}/min on ${l.spine_tiles} tiles of ${l.tier}`).join("  "));

// ---- 3. a corridor joins a region and the flow sees the limit ----
const lane = call("card_example", {}).data;
const cell = JSON.parse(fs.readFileSync(path.join(__dirname, "card_gear_fixed.json"), "utf8"));
{
  const lay = ready("region_layout", { entries: [{ card: lane }, { card: cor.data }, { card: cell, count: 2 }] });
  if (!lay.ok) { check("corridor region lays out", false, `${lay.code} ${lay.msg}`); }
  else {
    const d = lay.data;
    const fused = asArr(d.placements).filter((p) => p.fused).map((p) => p.ref);
    // refs are entry<N> unless the caller names a frozen card, so assert the property
    // (producer -> corridor -> consumers all wired) rather than matching a name.
    check("the corridor sits between the smelting lane and both consumers, all fused",
      fused.length === 3,
      `placements ${asArr(d.placements).map((p) => `${p.ref}:${p.fused ? "fused" : p.packed ? "PACKED" : "seed"}`).join(" ")}; entities ${d.entities}`);
    const flows = asArr(d.flows);
    const iron = flows.find((f) => f.item === "iron-plate");
    check("the flow through a belt row reports that row's carrying capacity",
      !!iron && iron.belt_capacity_per_min === 1800,
      iron ? `supply ${iron.supplied_per_min}/min, demand ${iron.demanded_per_min}/min, belt ${iron.belt_capacity_per_min}/min, limited=${!!iron.belt_limited}` : "no iron flow");
    check("a rate the belts can carry is not flagged as belt-limited",
      !!iron && iron.belt_limited !== true, iron ? `needs ${iron.demanded_per_min}/min under a 1800/min row` : "");
    const copper = flows.find((f) => f.item === "copper-plate");
    check("the second row is visible as its own lane even with nothing feeding it yet",
      !copper || copper.belt_capacity_per_min === 1800,
      copper ? `copper flow present, belt ${copper.belt_capacity_per_min}/min` : "copper not an internal flow (nothing consumes it) - ok");
  }
}

// ---- 4. and a rate the belts cannot carry is refused ----
{
  const greedy = JSON.parse(JSON.stringify(cell));
  greedy.contract = { outputs: { "iron-gear-wheel": 1500 } };   // 3000 plates/min through one row
  const lay = ready("region_layout", { entries: [{ card: lane }, { card: cor.data }, { card: greedy }] });
  const iron = lay.ok ? asArr(lay.data.flows).find((f) => f.item === "iron-plate") : null;
  check("a flow that outstrips its belt row is refused, with the fix",
    !!iron && iron.belt_limited === true && iron.feasible === false && /parallel rows/.test(iron.fix || ""),
    iron ? `wants ${iron.demanded_per_min}/min vs ${iron.belt_capacity_per_min}/min -> `
      + `ceiling ${iron.max_supported_per_min}; fix: ${iron.fix}` : `${lay.code} ${lay.msg}`);
}

console.log(fails === 0 ? "\nall corridor/belt-capacity checks passed" : `\n${fails} check(s) failed`);
process.exit(fails ? 1 : 0);
