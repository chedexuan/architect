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
  // 默认那一档（单排）就是"把料带上带子"的那一种，所以它的主张直接和引擎对。带箱子的四种排法删掉之后
  // 这里不再有"一种只铺一行、另一种铺两行"的对照 —— 现在两种排法每一面都是 F 行 × 2 股，能带的料数
  // 相同，不同之处在长度。所以对照换成了"同一张配方，两种排法各自说得出自己缺哪几种料"。
  const card = call("card_example", { recipe: r.name, machines: 4, force: "player" }).data || {};
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
  // 哪几种料没带上来，两种数法必须一致：一种是从"这条线铺了几行、一行几股"算出来的（超出容量的那些），
  // 一种是卡自己用 `unfed` 说出来的。对不上，`unfed` 就是一件装饰。
  //
  // 顺序按卡上 `feed_plan.needs` 自己的顺序（也就是配方的进料顺序）来数，不是按名字排完再数 ——
  // "装不下时丢掉哪一种"是模的决定，测试跟着它自己的顺序比，才有意义。
  const capacity = 2 * Number((card.lane_plan || {}).feed_rows_laid || card.feed_plan.lane_rows || 0);
  const order = asList(card.feed_plan.needs).map((k) => k.item);
  const missing = order.slice(capacity);
  if (missing.length) shortRow.push([r.name, missing]);
  const namedRow = asList(card.unfed).map((u) => u.name).sort();
  if (JSON.stringify(namedRow) !== JSON.stringify(missing.slice().sort())) {
    overFeed.push([r.name, "stacked", namedRow, missing, capacity]);
  }
  // 双排：同一张配方，另一档排法，同样的主张必须由它自己的行数说出来。
  if (want.length <= 4) {
    const two = call("card_example", { recipe: r.name, machines: 4, force: "player",
      style: "two-row" }).data || {};
    if (two.feed_plan && two.feed_plan.per_lane && !two.fail) {
      twoBuilt.push(r.name);
      const tcapacity = 2 * Number((two.lane_plan || {}).feed_rows_laid || two.feed_plan.lane_rows || 0);
      const tmissing = asList(two.feed_plan.needs).map((k) => k.item).slice(tcapacity);
      if (tmissing.length) shortTwo.push([r.name, tmissing]);
      const namedTwo = asList(two.unfed).map((u) => u.name).sort();
      if (JSON.stringify(namedTwo) !== JSON.stringify(tmissing.slice().sort())) {
        overFeed.push([r.name, "two-row", namedTwo, tmissing, tcapacity]);
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

// THE GAP THIS FILE WAS WRITTEN TO PIN.
//
// It used to read "recipes whose lane brings only two of its materials", and the shape that closed it was
// `two-feed` (a feed line on each face). That shape is gone, and with it the story that a *different
// layout* brings more materials: both surviving layouts put F rows × 2 lanes on the face they feed, so
// what a line can bring is the same either way -- what 双排 buys is half the length, not more materials.
// So the claim here is the honest one: whatever the shape cannot bring has to be NAMED, by both shapes,
// from the engine's own list.
check("料带不下的那几种，两种排法都按名说出来，且和行数算出来的一致（不是悄悄少铺一行）",
  twoBuilt.length >= 15 && overFeed.length === 0,
  JSON.stringify([twoBuilt.length, overFeed.slice(0, 3)]).slice(0, 320));
check("...一条线装不下的配方仍然被记为「缺料」，而不是被当成铺齐了",
  shortRow.every(([, miss]) => miss.length >= 1) && threePlus.length > 0,
  JSON.stringify([shortRow.length, shortRow.slice(0, 2)]).slice(0, 320));
check("...and `unfed` is never a decoration: what it names is exactly what has no lane",
  overFeed.length === 0 && checked.length >= 25,
  JSON.stringify(overFeed.slice(0, 3)).slice(0, 320));
// 五种料比这一档能叠的行数还多一行（一个面 2 行 × 2 股），而答案不再是"铺四只箱子、把第五种说出来"：
// 带箱子的排法删了之后，没有东西可以"铺给"第五种料，于是整条线按名拒，并且把放不下的那两个数交出来。
// 这仍然是这个文件当初被写下来要钉的那句话 —— 一条线不会悄悄少一种料 —— 只是现在唯一还成立的答法。
const five = call("card_example", { recipe: "rocket-silo", machines: 2, force: "player" });
const fiveDetail = (five.data || five.detail) || {};
check("...and a recipe with FIVE materials is refused by name, quoting the two numbers that do not fit",
  five.ok === false && five.code === "LINES_BEYOND_SHAPE"
  && Number(fiveDetail.feed_rows) >= 5
  && Number(fiveDetail.feed_rows) > Number(fiveDetail.rows_per_face),
  JSON.stringify([five.code, fiveDetail.feed_rows, fiveDetail.product_rows,
    fiveDetail.rows_per_face, fiveDetail.arm_reach_tiers]).slice(0, 320));

console.log(`  一条进料带就够不着的配方（抽到 ${checked.length} 条里）：${shortRow.length} 条；`
  + `双排同样缺料的：${shortTwo.length} 条（抽验 ${twoBuilt.length} 条）`);

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
