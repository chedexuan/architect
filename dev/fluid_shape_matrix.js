// 四种形状各自遇到"吐液体的配方"时答什么 —— 一张矩阵，逐格钉，不靠猜。
//
// 为什么要有这一张：0.86.0 之前这一格是"整个按名拒"（`LANE_CARRIES_NO_FLUIDS`），现在只有
// `fluid-through` 那一档铺得出成品管道行，另外三档遇到液体成品要么**镜像不成**、要么那一面被臂占着，
// 都该按名拒，而且要说清是哪一面被谁占着。矩阵里每一个数都是门那一扇回的原文，不是我推的。
//
// 这一套从前**一条断言都没有**（2026-10-14 清点门禁时发现的：它在全量名单里，打印一张矩阵，
// 然后无论读到什么都报绿 —— 那是"套件不可能红"那一类谎）。现在钉的是**每一格**：形状换了档、
// 拒因换了码、或者某一格悄悄从"按名拒"变成"铺得出但铺歪"，都要在这里红，而不是等到玩家在客户端看见。
//
//   bash dev/test.sh node dev/fluid_shape_matrix.js
//   FREEZE=1 bash dev/test.sh node dev/fluid_shape_matrix.js   # 重新量一遍，把该钉的数打出来
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("fluid_shape_matrix");
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 200) }; }
};
const lua = (src) => {
  try {
    return execFileSync("node", [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: process.env, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "HARNESS " + String(e.stdout || e.message).slice(0, 200); }
};

// 借世界层（与 `fluid_line_e2e` 同一套理由）：这一张矩阵问的是**形状**，而台架按"这条配方研究了没有"
// 下判。少了这一格，某一格会因为"这一档零件没解锁"而拒，看起来像形状的问题 —— 2026-10-14 那条
// "测试钉过期"的红就是这么差点被我当成几何退步。收尾原样还回去（只留原来就在的那几样）。
const WANTED_TECH = ["automation", "automation-2", "logistics", "logistics-2", "chemistry",
  "concrete", "circuit-network", "oil-processing", "sulfur-processing", "advanced-material-processing",
  "fluid-handling", "barreling", "display-panel"];
const WANTED_RECIPES = ["assembling-machine-2", "chemical-plant", "pipe", "storage-tank", "concrete",
  "sulfur", "lubricant", "empty-water-barrel", "ice-melting", "sulfuric-acid", "display-panel",
  "long-handed-inserter", "fast-inserter", "transport-belt", "fast-transport-belt"];
const techState = () => String(lua(`local f = game.forces.player
local on = {}
for _, n in ipairs({ "${WANTED_TECH.join('", "')}" }) do
  local t = f.technologies[n]
  if t and t.researched then on[#on+1] = n end
end
rcon.print(table.concat(on, ","))`)).split("\n").map((l) => l.trim()).filter((l) => l && l !== "OK").pop() || "";
const wasOn = new Set(techState().split(",").filter(Boolean));
lua(`local f = game.forces.player
for _, n in ipairs({ "${WANTED_TECH.join('", "')}" }) do
  local t = f.technologies[n]
  if t then t.researched = true end
end
for _, nm in ipairs({ "${WANTED_RECIPES.join('", "')}" }) do
  local r = f.recipes[nm]
  if r then r.enabled = true end
end
rcon.print("granted")`);

const RECIPES = ["lubricant", "sulfuric-acid", "ice-melting", "empty-water-barrel"];
const STYLES = ["stacked", "two-row", "fluid-back", "fluid-through"];

// 每一格该答什么（2026-10-14 量出来后钉的；`LAY` 之外都要求那句拒话说清是哪一面/哪一件）。
// 值写成一格一个字符串：`LAY` 或 `REFUSE <码>`。改任何一格之前先去看它为什么是那样，别顺着新读数改。
const EXPECTED = {
  "lubricant|stacked": "REFUSE BELT_SHAPE_WITHOUT_BELTS",  // 整条线没有一件固体可搬 → 那一档根本不带带子，说的是形状与这发不搭，不是"铺歪了"
  "lubricant|two-row": "REFUSE BELT_SHAPE_WITHOUT_BELTS",
  "lubricant|fluid-back": "REFUSE BELT_SHAPE_WITHOUT_BELTS",
  "lubricant|fluid-through": "LAY",
  "sulfuric-acid|stacked": "REFUSE LANE_FEED_ROW_UNREACHABLE",  // 成品那一格被自己那排的臂占着（`FEED_CELL_TAKEN`，北面 off -1）
  "sulfuric-acid|two-row": "REFUSE LANE_FEED_ROW_UNREACHABLE",
  "sulfuric-acid|fluid-back": "REFUSE LANE_DRAIN_ROW_UNREACHABLE",  // 这一档的成品臂正站在南面管口那一格（`DRAIN_CELL_TAKEN`）
  "sulfuric-acid|fluid-through": "LAY",
  "ice-melting|stacked": "LAY",  // 量的结果：这一档**铺得出**（成品那一格没人占着）
  "ice-melting|two-row": "REFUSE LANE_DRAIN_ROW_UNREACHABLE",
  "ice-melting|fluid-back": "REFUSE LANE_DRAIN_ROW_UNREACHABLE",
  "ice-melting|fluid-through": "LAY",
  "empty-water-barrel|stacked": "LAY",
  "empty-water-barrel|two-row": "REFUSE LANE_DRAIN_ROW_UNREACHABLE",  // 两排各在一行 ⟹ 南面那根管跨到另一排去（`DRAIN_SPAN_MULTIPLE_LINES`）
  "empty-water-barrel|fluid-back": "REFUSE LANE_DRAIN_ROW_UNREACHABLE",
  "empty-water-barrel|fluid-through": "LAY",
};


let fails = 0;
const cells = {};
const detail = [];
const byCell = {};
const check = (name, cond, got) => {
  if (cond) { console.log(`ok   ${name}`); return; }
  fails++;
  console.log(`FAIL ${name} -- ${got}`);
};

for (const recipe of RECIPES) {
  const line = [recipe.padEnd(20)];
  for (const style of STYLES) {
    const r = call("card_example", { recipe, machines: 2, style, force: "player" });
    const code = r.ok ? "LAY" : `REFUSE ${r.code || (r.data && r.data.code) || "?"}`;
    cells[`${recipe}|${style}`] = code;
    line.push(code.padEnd(18));
    byCell[`${recipe}|${style}`] = JSON.stringify([r.ok, r.code, (r.detail || {}).blocked,
      String(r.msg || "").slice(0, 60)]);
    detail.push(`[${recipe}/${style}] ${JSON.stringify([r.ok, r.code, (r.detail || {}).blocked,
      String(r.msg || "").slice(0, 60)]).slice(0, 220)}`);
  }
  console.log("".padEnd(20) + "  |  " + STYLES.map((s) => s.padEnd(18)).join("  |  "));
  console.log(line.join("  |  "));
}

if (process.env.FREEZE === "1") {
  console.log("\n// FREEZE：把下面这几行抄进 EXPECTED，再逐格去读 detail 确认它说的是同一件事");
  for (const k of Object.keys(EXPECTED)) console.log(`  "${k}": "${cells[k]}",`);
  console.log(detail.join("\n"));
  const back = Array.from(wasOn);
  lua(`local f = game.forces.player
local keep = {}
for _, n in ipairs({ "${back.join('", "')}" }) do keep[n] = true end
for _, n in ipairs({ "${WANTED_TECH.join('", "')}" }) do
  local t = f.technologies[n]
  if t then t.researched = keep[n] == true end
end
rcon.print("returned")`);
  process.exit(0);
}

for (const k of Object.keys(EXPECTED)) {
  const want = EXPECTED[k];
  check(`矩阵那一格 ${k} 答的是钉的那一句（${want}）`,
    cells[k] === want, `读到 ${cells[k]} ——  ${(byCell[k] || "").slice(0, 220)}`);
}
// 三条**不靠快照**的判断（快照会随几何一起老，这三条是这个套件存在的理由）：
// ① 四发液体成品在 `fluid-through` 那一档都必须铺得出 —— 它是唯一为"又喝又吐"准备的一档；
// ② 凡是按名拒的格子，那句拒话必须点名是哪一面、哪一件占着那一格（只给一个码等于没说）；
// ③ `lubricant` 那一列另外三档一律拒 —— 整条线一件固体都没有，带子那一档不该硬铺。
check("四发液体成品在 `fluid-through` 那一档都铺得出",
  RECIPES.every((rc) => cells[`${rc}|fluid-through`] === "LAY"),
  JSON.stringify(RECIPES.map((rc) => [rc, cells[`${rc}|fluid-through`]])));
check("...而每一个按名拒的格子都说清是哪一面被谁占着",
  Object.keys(EXPECTED).filter((k) => EXPECTED[k] !== "LAY").every((k) => {
    const [rc, st] = k.split("|");
    const r = call("card_example", { recipe: rc, machines: 2, style: st, force: "player" });
    const d = r.detail || {};
    const b = d.blocked || {};
    // 两种"说清"：管口那一格被占 → 点名哪一面、哪一件；形状与这发不搭 → 点名是哪一档、为什么。
    // 只丢一个码、或话说得比 20 字还短，都算这一格没过。
    return !r.ok && String(r.msg || "").length > 20
      && ((b.face && (b.taken_by || b.other_line)) || !!d.style);
  }),
  Object.keys(EXPECTED).filter((k) => EXPECTED[k] !== "LAY")
    .map((k) => `${k}: ${(byCell[k] || "").slice(0, 90)}`).join(" ~ ").slice(0, 300));
check("一件固体都没有的那一发，其余三档一律按名拒（不硬铺一条空带子）",
  STYLES.filter((s) => s !== "fluid-through").every((s) => cells[`lubricant|${s}`] === "REFUSE BELT_SHAPE_WITHOUT_BELTS"),
  JSON.stringify(STYLES.map((s) => [s, cells[`lubricant|${s}`]])));

call("lab_reset", {});
const back = Array.from(wasOn);
lua(`local f = game.forces.player
local keep = {}
for _, n in ipairs({ "${back.join('", "')}" }) do keep[n] = true end
for _, n in ipairs({ "${WANTED_TECH.join('", "')}" }) do
  local t = f.technologies[n]
  if t then t.researched = keep[n] == true end
end
rcon.print("returned")`);
console.log(fails === 0 ? `ALL PASS: ${Object.keys(EXPECTED).length + 2} 格钉住，0 条红`
  : `FAILED: ${Object.keys(EXPECTED).length + 2 - fails} passed, ${fails} failed`);
process.exit(fails ? 1 : 0);
