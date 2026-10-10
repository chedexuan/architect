// 四种形状各自遇到"吐液体的配方"时答什么 —— 一张矩阵，逐格读，不靠猜。
//
// 为什么要有这一张：0.86.0 之前这一格是"整个按名拒"（`LANE_CARRIES_NO_FLUIDS`），现在只有
// `fluid-through` 那一档铺得出成品管道行，另外三档遇到液体成品要么**镜像不成**、要么那一面被臂占着，
// 都该按名拒，而且要说清是哪一面被谁占着。矩阵里每一个数都是门那一扇回的原文，不是我推的。
//
//   bash dev/test.sh node dev/fluid_shape_matrix.js
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("fluid_shape_matrix");
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...process.env, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 200) }; }
};
const RECIPES = ["lubricant", "sulfuric-acid", "ice-melting", "empty-water-barrel"];
const STYLES = ["stacked", "two-row", "fluid-back", "fluid-through"];
const rows = [];
for (const recipe of RECIPES) {
  const line = [recipe.padEnd(20)];
  for (const style of STYLES) {
    const r = call("card_example", { recipe, machines: 2, style, force: "player" });
    line.push(r.ok ? "LAY" : `REFUSE ${(r.code || r.data && r.data.code || "?")}`);
  }
  rows.push(line.join("  |  "));
}
console.log("".padEnd(20) + "  |  " + STYLES.map((s) => s.padEnd(18)).join("  |  "));
console.log(rows.join("\n"));
