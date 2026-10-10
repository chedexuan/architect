// 一个簇的**具体挡在哪一格**：`coverage_sweep` 的明细只存到"拒因"那一层，而画新形状要的是
// 每一档的口位、被谁占了、哪一面 —— 那些在 `detail` 里，而 `detail` 只在借了全研究的世界里才读得到
// （这些配方大多要 `automation-3` / `foundry` / `uranium-processing` 那一层的机器）。
//
// 用法：
//   CS_CODE=LANE_FEED_ROW_UNREACHABLE bash dev/test.sh node dev/cluster_detail.js
//   CS_CODE=ARM_TIER_MISSING,STEMS_AND_FEED_ROWS CS_IN=.factorio-data/coverage_0870.jsonl ...
//
// 它借研究的方式与 `coverage_sweep` 同一手：**先读回原本研究过的那份名单，跑完照名单还**
// （一刀清零会把这台测试实例的研究状态改掉，下一套套件读到的是我造成的世界，§0 那条坑）。
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
require("./suite-guard.js").guardMain("cluster_detail");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "60000" };
// `dev/lua.js` 在回话末尾打了一行 `OK`（§0 第六条那一坑），要 JSON 的调用只取第一行。
const line = (src) => execFileSync("node", [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim().split("\n")[0];
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 200) }; }
};

const IN = process.env.CS_IN || ".factorio-data/coverage_0870.jsonl";
const CODES = String(process.env.CS_CODE || "LANE_FEED_ROW_UNREACHABLE").split(",").map((x) => x.trim());
const MACHINES = Number(process.env.CS_MACHINES || 3);
if (!fs.existsSync(IN)) { console.log("没有 " + IN + " —— 先跑 CS_DUMP=" + IN + " bash dev/test.sh node dev/coverage_sweep.js"); process.exit(1); }
const rows = fs.readFileSync(IN, "utf8").trim().split("\n").map(JSON.parse);
const picked = rows.filter((r) => CODES.includes(String(r[2])));
console.log(`== 簇 ${CODES.join("/")} 共 ${picked.length} 条（来自 ${IN}）`);

// 与 `coverage_sweep` 同一手：Lua 那边自己拼 JSON 数组 —— `game.table_to_json` 在这台机上不存在
// （问过报 "LuaGameScript doesn't contain key table_to_json"，而报出来像"名单是空的"）。
const researchedBefore = JSON.parse(line(`local f = game.forces.player
local out = {}
for name, t in pairs(f.technologies) do if t.researched then out[#out+1] = name end end
table.sort(out)
for i, v in ipairs(out) do out[i] = '"' .. v .. '"' end
rcon.print("[" .. table.concat(out, ",") .. "]")`) || "[]");
line(`local f = game.forces.player
for _, t in pairs(f.technologies) do t.researched = true end
rcon.print("granted")`);

const OUT = process.env.CS_OUT || (".factorio-data/cluster_" + CODES[0] + ".jsonl");
const writes = [];
try {
  for (const r of picked) {
    const recipe = r[0];
    const ans = call("card_example", { recipe, machines: MACHINES, force: "player" });
    const d = ans.detail || {};
    const brief = {
      recipe, code: ans.ok ? "LAY" : ans.code,
      blocked_by: d.blocked_by, machine: d.machine, fluid: d.fluid, face: d.face, off: d.off,
      cell: d.cell, taken_by: d.taken_by, style: d.style, column: d.column,
      needs: d.needs, tiers: d.tiers, fluids: d.fluids, why: d.why, why2: d.why2,
      feed_rows: d.feed_rows, rows_per_face: d.rows_per_face, arm_reach_missing: d.arm_reach_missing,
      facings: d.facings, blocked: d.blocked,
    };
    writes.push(JSON.stringify(brief));
    console.log("   " + recipe.padEnd(30) + " " + String(brief.code).padEnd(26)
      + " " + JSON.stringify({ face: brief.face, off: brief.off, taken_by: brief.taken_by,
        by: brief.why || brief.why2, needs: brief.needs, fluid: brief.fluid })
        .replace(/"\\\\/g, "").slice(0, 190));
  }
} finally {
  const keep = "{" + researchedBefore.map((n) => '["' + n + '"]=true').join(",") + "}";
  line(`local f = game.forces.player
local keep = ${keep}
for name, t in pairs(f.technologies) do t.researched = keep[name] == true end
rcon.print("restored=" .. tostring(#f.technologies))`);
}
fs.writeFileSync(OUT, writes.join("\n") + "\n");
console.log("== 明细落盘 " + OUT + "（研究已照名单还）");
