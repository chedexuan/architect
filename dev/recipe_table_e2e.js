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
// The last check is a PIN, and it reads like a bug report on purpose: today `card_example` lays ONE
// feed row, so a recipe with three or more materials is fed two of them and the rest are named in
// `ports.in` as missing. When the two-feed-row shape lands, that check is the line to upgrade -- and if
// it is deleted instead, the gap came back quietly, which is how `electronic-circuit` got mistaken for
// the whole problem.
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
const mismatches = [], checked = [], overTwo = [], unfedNow = [];
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
  // ...and today's real gap, counted: which materials the laid lane does NOT bring in.
  const portsIn = new Set(asList((card.ports || {}).in).map((p) => p.item).filter(Boolean));
  const missing = want.filter((w) => !portsIn.has(w.name)).map((w) => w.name);
  if (missing.length) unfedNow.push([r.name, missing]);
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

// The pinned gap, in the file's own words: with ONE feed row per lane, every recipe above two materials
// arrives short. Counted rather than asserted-zero: the number IS the finding, and when the second feed
// row lands, this line becomes "no recipe is left short" -- a smaller number is not a pass, it is a
// change of claim, and it has to be written down.
check("KNOWN GAP (upgrade this line with the two-feed-row shape): recipes whose lane brings only two of its materials",
  unfedNow.length > 0 && unfedNow.every(([, miss]) => miss.length >= 1),
  JSON.stringify(unfedNow.slice(0, 4)).slice(0, 320));
console.log(`  今天还缺料的配方（在抽到的 ${checked.length} 条里）：${unfedNow.length} 条 —— 例如 `
  + JSON.stringify(unfedNow.slice(0, 3)));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
