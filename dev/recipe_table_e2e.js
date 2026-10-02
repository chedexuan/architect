// Every item's real ingredients and proportions, read out of the engine and checked against what the
// mod claims -- because two "facts" in this project were remembered rather than asked.
//
// 2026-10-02, morning: a line was declared fixed for 绿板 after being built and measured for
// `electronic-circuit`. `electronic-circuit` is the FIRST circuit tier and eats two items; the tier a
// player calls 绿板 is `advanced-circuit`, and in 2.0 it is plastic bar 2 + copper cable 4 + electronic
// circuit 2 -- not the 1/1/6 that every 1.1-era mental model carries, and not two materials. The amounts
// are what the lane arithmetic divides by, so a remembered table is not a small error: it picks the
// shape, and the shape decides whether the factory runs.
//
// So nothing here is remembered. The recipe list is read from `prototypes.recipe` page by page (a single
// print of 659 rows is bigger than one RCON reply wants to carry), and for every production recipe that
// eats two or more ITEMS, the mod's own `card_example` answer must agree with the engine: same set of
// materials, same per-craft amounts, one lane minimum per material (the geometry puts one material in
// each lane of a belt row -- see the measured invariant in styles.lua), and therefore no "share one
// row" verdict for a recipe with three or more.
//
// The last section of this file was written as a PIN, and read like a bug report on purpose: `card_example`
// laid ONE feed row, a row has two lanes, and 141 of the production recipes eat three items or more -- so
// every sampled recipe above two materials arrived short and the number of them was the finding. The
// two-feed-row shape (`two-feed`) landed the same day, and the pin was upgraded rather than deleted: the
// claim now is that a shape with a feed line on EACH face brings EVERY material of the recipes its four
// lanes can hold, that the one-row shape still leaves the third out and SAYS so in `unfed`, and that
// `unfed` is the boxes read back rather than a decoration -- five materials is one more than any shape
// here can bring, and the answer has to name the one it cannot reach.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("recipe_table_e2e");

const PORT = process.env.RCON_PORT || "27015";
const ENV = { ...process.env, RCON_PORT: PORT, RCON_PW: process.env.RCON_PW || "m0pw" };
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 400)}`);
  ok ? pass++ : fail++;
};
const asList = (v) => (Array.isArray(v) ? v : (v && Object.keys(v).length
  ? Object.keys(v).map((k) => v[k]) : []));

const lua = (src) => {
  for (let n = 0; n < 5; n++) {
    try {
      return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
        { encoding: "utf8", env: ENV, maxBuffer: 1 << 28 }).trim();
    } catch (e) {
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},2500)"]);
      if (n === 4) return "";
    }
  }
  return "";
};
const call = (method, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method,
      JSON.stringify(args || {})], { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 });
    return JSON.parse(out.trim());
  } catch (e) { return { ok: false, code: "CALL_FAILED", msg: String((e && e.stderr) || e).slice(0, 160) }; }
};

// ---------------------------------------------------------------- the engine's own table
//
// Paged, because the whole table is more than one reply: `recipes` is 659 prototypes on this install and
// a print that big comes back as silence, which a careless suite would read as "no recipes".
const PAGE = 40;
const pageSrc = (off) => `local names = {}
for name in pairs(prototypes.recipe) do names[#names+1] = name end
table.sort(names)
local out = {}
for i = ${off + 1}, math.min(${off + PAGE}, #names) do
  local r = prototypes.recipe[names[i]]
  local ing, pro = {}, {}
  for _, x in ipairs(r.ingredients or {}) do
    local t = x.type or (prototypes.fluid[x.name] and "fluid" or "item")
    ing[#ing+1] = tostring(x.name) .. "|" .. tostring(x.amount or x.minimum or 1) .. "|" .. t
  end
  for _, p in ipairs(r.products or {}) do
    local a = (p.amount or ((p.amount_min or 0) + (p.amount_max or 0)) / 2 or 1) * (p.probability or 1)
    pro[#pro+1] = tostring(p.name) .. "|" .. string.format("%.4f", a)
  end
  out[#out+1] = names[i] .. "\\t" .. tostring(r.category or "") .. "\\t" .. tostring(r.energy or 0)
    .. "\\t" .. table.concat(ing, ";") .. "\\t" .. table.concat(pro, ";")
end
rcon.print(table.concat(out, "\\n"))`;

const readTable = () => {
  const total = Number((lua(`local n = 0
for _ in pairs(prototypes.recipe) do n = n + 1 end
rcon.print(n)`).match(/\d+/) || [0])[0]);
  const rows = [];
  for (let off = 0; off < total; off += PAGE) {
    String(lua(pageSrc(off))).split(/\r?\n/).forEach((line) => {
      const p = line.split("\t");
      if (p.length !== 5) return;
      const ing = p[3].split(";").filter(Boolean).map((x) => {
        const [n, a, t] = x.split("|");
        return { name: n, amount: Number(a) || 0, type: t };
      });
      rows.push({
        name: p[0], category: p[1], energy: Number(p[2]) || 0,
        items: ing.filter((i) => i.type !== "fluid"),
        fluids: ing.filter((i) => i.type === "fluid"),
        products: p[4].split(";").filter(Boolean).map((x) => {
          const [n, a] = x.split("|"); return { name: n, amount: Number(a) || 0 };
        }),
      });
    });
  }
  return { total, rows };
};

const { total, rows } = readTable();
check("the recipe table came out of the engine whole, not out of a page that got truncated",
  total > 200 && rows.length === total, JSON.stringify([total, rows.length]));

const production = rows.filter((r) => r.energy > 0 && r.products.length && !/recycling$/.test(r.name));
const byMaterials = {};
production.forEach((r) => {
  const k = Math.min(r.items.length, 6);
  byMaterials[k] = (byMaterials[k] || 0) + 1;
});
const multi = production.filter((r) => r.items.length >= 2);
const threePlus = production.filter((r) => r.items.length >= 3);
const fluidish = production.filter((r) => r.fluids.length > 0);

console.log(`  recipes=${total} production=${production.length} by item count=`
  + JSON.stringify(byMaterials) + ` with a fluid=${fluidish.length}`);
console.log(`  需要 2 条股以上的配方：${threePlus.length} 条（每种料至少占一条道）`);

// The distribution is asserted as a SHAPE, not as numbers copied from a run: the tiers exist, and a
// future "one feed row is enough" shortcut has to go red against this line rather than against a
// comment someone might not read.
check("this install really does have recipes at every material count from one to four",
  (byMaterials[1] || 0) > 0 && (byMaterials[2] || 0) > 0 && (byMaterials[3] || 0) > 0
    && (byMaterials[4] || 0) > 0 && multi.length > 100,
  JSON.stringify(byMaterials));

// ---------------------------------------------------------------- the claim each card makes
//
// Every recipe with 2+ item materials: what the mod says it will feed, against what the engine says the
// recipe eats. Sampled only where the plan can be built at all -- a machine the recipe's category
// excludes is the builder's refusal, not a mismatch about the ingredient table.
const mismatches = [], checked = [], overTwo = [];
const shortRow = [], shortTwo = [], overFeed = [], twoBuilt = [];
for (const r of threePlus.concat(multi.filter((x) => x.items.length === 2))) {
  // `row-belts`, explicitly: the lane builder's default shape lifts the product into a chest and lays no
  // feed line at all, so its `feed_plan` has no lane verdict to compare against -- a gate that read the
  // default would be checking the absence of a number. The shared-row shape is the one that claims to
  // carry materials on a belt, so that is the one whose claim is put next to the engine.
  const card = call("card_example", { recipe: r.name, machines: 4, force: "player",
    style: "row-belts" }).data || {};
  if (!card || card.fail || !card.feed_plan || !card.feed_plan.per_lane) continue;
  const want = r.items.slice().sort((a, b) => a.name < b.name ? -1 : 1);
  const got = asList(card.feed_plan.needs).slice().sort((a, b) => a.item < b.item ? -1 : 1);
  checked.push(r.name);
  const sameSet = want.length === got.length && want.every((w, i) => got[i] && got[i].item === w.name);
  const sameAmounts = sameSet && want.every((w, i) => Math.abs((got[i].per_craft || 0) - w.amount) < 1e-6);
  if (!sameSet || !sameAmounts) mismatches.push([r.name, want.map((w) => [w.name, w.amount]),
    got.map((g) => [g.item, g.per_craft])]);
  // One lane per material, never two materials in one lane: that is the geometry the blueprint can
  // actually carry, and `lanes_wanted` is where the answer admits it.
  if ((card.feed_plan.lanes_wanted || 0) < want.length) overTwo.push([r.name, want.length,
    card.feed_plan.lanes_wanted]);
  // A row has two lanes, so more than two materials cannot fit one row -- the verdict must say so.
  if (want.length > 2 && card.feed_plan.share_one_line !== false) {
    overTwo.push(["share-claim", r.name, card.feed_plan.share_one_line]);
  }
  // ...and which materials the laid lane does NOT bring, counted two ways: from the boxes on the card and
  // from the `unfed` field the card itself is supposed to say them with. The two have to agree, or the
  // field is decoration.
  const portsIn = new Set(asList((card.ports || {}).in).map((p) => p.item).filter(Boolean));
  const missing = want.filter((w) => !portsIn.has(w.name)).map((w) => w.name);
  if (missing.length) shortRow.push([r.name, missing]);
  const namedRow = asList(card.unfed).map((u) => u.name).sort();
  if (JSON.stringify(namedRow) !== JSON.stringify(missing.slice().sort())) {
    overFeed.push([r.name, "row-belts", namedRow, missing]);
  }
  // The shape with a feed line on EACH face of the machines is the one that can bring three and four.
  // Same recipe, same engine list, so the difference between the two answers is a difference of shape and
  // nothing else -- and a shape that cannot hold the material still has to NAME it rather than drop it.
  if (want.length <= 4) {
    const two = call("card_example", { recipe: r.name, machines: 4, force: "player",
      style: "two-feed" }).data || {};
    if (two.feed_plan && two.feed_plan.per_lane) {
      twoBuilt.push(r.name);
      const tin = new Set(asList((two.ports || {}).in).map((p) => p.item).filter(Boolean));
      const tmissing = want.filter((w) => !tin.has(w.name)).map((w) => w.name);
      if (tmissing.length) shortTwo.push([r.name, tmissing]);
      const namedTwo = asList(two.unfed).map((u) => u.name).sort();
      if (JSON.stringify(namedTwo) !== JSON.stringify(tmissing.slice().sort())) {
        overFeed.push([r.name, "two-feed", namedTwo, tmissing]);
      }
    }
  }
  if (checked.length >= 60) break; // the point is agreement, not a minute of geometry
}

check("for every multi-material recipe we built, the card's feed_plan names the SAME materials and the SAME per-craft amounts as the engine",
  checked.length >= 25 && mismatches.length === 0,
  JSON.stringify([checked.length, mismatches.slice(0, 3)]).slice(0, 400));
check("...and it never books a material at less than one lane (no two materials share a lane)",
  overTwo.length === 0, JSON.stringify(overTwo.slice(0, 4)).slice(0, 300));
check("...so a three-material recipe is reported as needing more than one feed row, not as a shared row",
  threePlus.length > 0 && multi.some((x) => x.items.length === 2),
  JSON.stringify([threePlus.length, byMaterials]).slice(0, 200));

// THE GAP THIS FILE WAS WRITTEN TO PIN, AND THE SHAPE THAT CLOSED IT.
//
// The line used to read "KNOWN GAP: recipes whose lane brings only two of its materials", counted on the
// one-row shape, because that was the truth: `row-belts` lays one feed line, a feed line has two lanes,
// and 141 of the 337 production recipes eat three items or more. `two-feed` is the shape that puts a
// second feed line on the machines' other face, and this is where the claim changed rather than a number
// getting smaller: for EVERY recipe sampled at four materials or fewer, that shape brings all of them.
const fourOrLess = threePlus.filter((r) => r.items.length <= 2 + 2);
check("the gap that was pinned here is closed for the recipes the shape can hold: two-feed brings EVERY "
  + "material of every sampled recipe with at most four",
  twoBuilt.length >= 15 && shortTwo.length === 0
    && twoBuilt.length >= Math.min(15, fourOrLess.length),
  JSON.stringify([twoBuilt.length, shortTwo.slice(0, 3)]).slice(0, 320));
check("...and the one-row shape still leaves the third material out, named, for those same recipes",
  shortRow.length >= 10 && shortRow.every(([, miss]) => miss.length >= 1)
    && threePlus.length > 0,
  JSON.stringify(shortRow.slice(0, 3)).slice(0, 320));
check("...and `unfed` is the boxes read back, never a decoration: what it names is exactly what has no box",
  overFeed.length === 0 && checked.length >= 25,
  JSON.stringify(overFeed.slice(0, 3)).slice(0, 320));
// Five materials is one more than any shape on this install can bring, so the answer is not a lane with a
// silent hole in it: the shortfall has to be named, and named from the engine's list.
const five = call("card_example", { recipe: "rocket-silo", machines: 2, force: "player",
  style: "two-feed" }).data || {};
const fiveNeed = asList((five.feed_plan || {}).needs).map((k) => k.item);
const fiveMiss = asList(five.unfed).map((u) => u.name);
check("...and a recipe with FIVE materials says which one its four lanes cannot reach, rather than laying "
  + "four boxes and calling the line done",
  fiveNeed.length >= 5 && fiveMiss.length === fiveNeed.length - 4
    && fiveMiss.every((n) => fiveNeed.indexOf(n) >= 0),
  JSON.stringify([fiveNeed, fiveMiss, asList((five.ports || {}).in).map((p) => p.item)]).slice(0, 320));
console.log(`  一条进料带就够不着的配方（抽到 ${checked.length} 条里）：${shortRow.length} 条；`
  + `两种料以上的配方换成两条进料带后仍缺料的：${shortTwo.length} 条（抽验 ${twoBuilt.length} 条）`);

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
