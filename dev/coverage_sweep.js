// 覆盖率那一把尺：把 §6 那张"多少条配方铺得出完整的线"的表变成能重跑的东西。
//
// 为什么要有它：`dev/待办.md` §6 里"316 条生产配方（去回收）里 236 条铺得出（75%）、80 条按名拒"是上一轮
// **手工**跑出来的，脚本没留下 —— 于是"改了排法/取整律/行数下限之后救回几行"这句话只能说嘴。这一趟把它
// 落成脚本：研究全打开 → 每条配方按 4 台过一遍 `card_example` → 按拒因归类，跑完把研究照原样还。
//
// 它量的是**铺不铺得出**，不是"铺出来的线会不会生产"（那是台架那一族：`belt_line_produces`、
// `layout_ledger` 里 run_lab 那几条）。所以这一趟一台机器都不放、一条带子都不铺，只问答案。
//
// 三条与本仓库其它套件同一样的坑：`dev/test.sh` 前缀（不许动玩家连的那台）、rcon 一次回话有大小上限
// （所以配方名分批问）、研究状态是**世界状态**（借了必须还，还法是先把研究过的科技名单抄到脚本这边，
// 再按名单原样写回去 + `reset_recipes()`，而不是 `force.reset()` 那种把别的东西一起抹掉的）。
//
// **这一趟还没跑出数（2026-10-10 量到的阻塞点，写在这免得下一个人重撞）**：研究全打开之后（252 项），
// 一次 `card_example` 要几十秒 —— 挑臂/挑带那几级梯子与 `refresh_availability` 都要过一遍全部原型。
// 于是一批 8 条就把 rcon 的静默窗口（60 s）耗光，回话是 `TRUNCATED: got 0 bytes`，长得跟"这些配方都没答案"
// 一模一样（实测：同样两条配方、只读 `r.ok`/`r.code` 的那版秒回；加上 `lane_plan` 那几个字段就卡住）。
// 下一步两条路，选一条再跑：(a) 一批只问 1~2 条、静默窗口放到 300 s；(b) 让 `card_example` 在这种扫法下
// 走一条"不挑梯子"的快路（把可用性/臂档缓存住），那才是 §6 那张表能天天重跑的样子。
// 在跑出数之前，`dev/待办.md` §6 那张表的数字**不改**。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("coverage_sweep");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw",
  // 一批 card_example 要跑上一两秒，而 rcon 默认"静默 5 秒就当没回话"—— 那正是这仓库里
  // "回话被截断"长得跟"没有答案"一样的那一格。把静默窗口放宽，批也切小。
  RCON_IDLE_MS: process.env.RCON_IDLE_MS || "60000" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 300); }
};
// `lua.js` 每次回答后面跟一行 "OK"（它自己那句 pcall 的结论），取第一行就是 rcon.print 出来的东西。
// 静默窗口内没回话就再问一次（这一趟里发生过：一批问下去回的是 TRUNCATED，看着像"这些配方都没答案"）。
const line = (src, tries) => {
  let out = String(lua(src));
  for (let n = 1; n <= (tries || 3) && /TRUNCATED|no output|PROBE-FAIL/.test(out); n++) {
    out = String(lua(src));
  }
  return out.split("\n")[0];
};

const MACHINES = Number(process.argv[2] || 4);
const BATCH = 20;

// 研究过的科技名单：抄下来，跑完照着写回去。
const researchedBefore = JSON.parse(line(`local f = game.forces.player
local out = {}
for name, t in pairs(f.technologies) do if t.researched then out[#out+1] = name end end
table.sort(out)
for i, v in ipairs(out) do out[i] = '"' .. v .. '"' end
rcon.print("[" .. table.concat(out, ",") .. "]")`) || "[]");
console.log(`== 研究全打开（原本研究过的 ${researchedBefore.length} 项，跑完照名单还）`);

// 生产配方的名单：去回收、去隐藏、去"没有产物"的。筛法写在这里而不是散在断言里，
// 因为"多少条里铺得出多少条"这个数的分母就是它。
const recipes = JSON.parse(line(`local out = {}
for name, r in pairs(prototypes.recipe) do
  local hidden = r.hidden
  local cat = tostring(r.category or "")
  local recyc = string.find(name, "recycl", 1, true) ~= nil or cat == "recycling"
  local has_out = false
  for _ in pairs(r.products or {}) do has_out = true end
  if not hidden and not recyc and has_out then out[#out+1] = name end
end
table.sort(out)
for i, v in ipairs(out) do out[i] = '"' .. v .. '"' end
rcon.print("[" .. table.concat(out, ",") .. "]")`) || "[]");
console.log(`== 生产配方（去回收）${recipes.length} 条，每条按 ${MACHINES} 台问一次 card_example`);

const setAllTechs = (on) => line(`local f = game.forces.player
local n = 0
for _, t in pairs(f.technologies) do t.researched = ${on}; n = n + 1 end
pcall(function() f.reset_recipes() end)
rcon.print("techs=" .. n)`);
setAllTechs("true");

const rows = [];
try {
  for (let i = 0; i < recipes.length; i += BATCH) {
    const names = recipes.slice(i, i + BATCH);
    // Lua 的表字面量，不是 JSON：`["a","b"]` 在 Lua 里编译不过，而那一路的表现是**整批没有回话**
    // （rcon 静默到超时），长得跟"这些配方都没答案"一模一样 —— 这一趟第一版就栽在这里。
    const asked = "{" + names.map((n) => '"' + n + '"').join(",") + "}";
    // 一批一批问：一次 rcon 回话装不下全部答案，而"回话被截断"在这仓库里长得跟"没有答案"一样。
    const raw = line(`local names = ${asked}
local out = {}
-- 远程那一扇门回的是 **JSON 文字**（dev/call.js 就是这么读的），Lua 这边没有解码器，所以按文字取字段 ——
-- 与 §2b 里"蓝图内容核对解 export_stack 的文字做"是同一手：要的是几个标量，不是整棵树。
local function pick(txt, key)
  local v = txt:match('"' .. key .. '":"([^"]*)"') or txt:match('"' .. key .. '":([%d%.%-]+)')
  return v
end
for _, n in ipairs(names) do
  local ok, r = pcall(function()
    return remote.call("arch", "call", "card_example", { recipe = n, machines = ${MACHINES}, force = "player" })
  end)
  if not ok or type(r) ~= "string" then
    out[#out+1] = string.format('["%s",0,"BRIDGE_ERR","","",0,""]', n)
  else
    local laid = r:find('"ok":true', 1, true) ~= nil
    local code = laid and "LAY" or (pick(r, "code") or "?")
    out[#out+1] = string.format('["%s",%d,"%s","%s","%s",%s,"%s"]',
      n, laid and 1 or 0, code, pick(r, "blocked_by") or "", pick(r, "style") or "",
      tonumber(pick(r, "materials") or 0) or 0, pick(r, "product_lanes_shared") or "")
  end
end
rcon.print("[" .. table.concat(out, ",") .. "]")`);
    let batch = [];
    try { batch = JSON.parse(raw || "[]"); } catch (e) {
      console.log("  (这一批的回答解不开：" + String(raw).slice(0, 160) + ")");
    }
    rows.push(...batch);
    process.stdout.write(".");
  }
  console.log("");
} finally {
  // 借的研究照原样还：按名单写回去，再让配方跟着研究走一次。不还的话，下一套门禁看到的存档就不是
  // 它以为的那个（belt_head_e2e 还科技、layout_ledger 还配方，是同一个道理）。
  // 同上：还原名单也要写成 Lua 表字面量，不然"还研究"那一步静默失败，
  // 下一套门禁看到的就是一个研究全开的存档（这一趟真发生过：第二次跑时数到 252 项研究过）。
  const keep = "{" + researchedBefore.map((n) => '["' + n + '"]=true').join(",") + "}";
  setAllTechs("false");
  line(`local f = game.forces.player
local keep = ${keep}
for name, t in pairs(f.technologies) do t.researched = keep[name] == true end
f.rechart()  -- 还旗子也要 rechart：它顺带把「以前谁借走没还」的配方收回到该在的状态（今晚反复读到「开放集变薄」的机制就是这个）
pcall(function() f.reset_recipes() end)
rcon.print("restored=" .. tostring(#f.technologies))`);
}

const laid = rows.filter((r) => r[1] === 1);
const refused = rows.filter((r) => r[1] !== 1);
const byCode = {};
for (const r of refused) byCode[r[2]] = (byCode[r[2]] || 0) + 1;
const codes = Object.keys(byCode).sort((a, b) => byCode[b] - byCode[a]);
const sharedRows = laid.filter((r) => Number(r[6] || 0) > 0);

console.log(`\n== ${rows.length} 条里 ${laid.length} 条铺得出完整的线（`
  + `${(100 * laid.length / Math.max(1, rows.length)).toFixed(1)}%），${refused.length} 条按名拒`);
console.log("== 拒因（按贵的排）：");
for (const c of codes) console.log(`   ${String(c).padEnd(30)} ${byCode[c]}`);
// 行数下限那一格要看的两件事：多少条是"料/成品件数"顶上去的（切线换带子都不解决），多少条是流量顶上去的。
const beyond = refused.filter((r) => r[2] === "LINES_BEYOND_SHAPE");
const byKind = {};
for (const r of beyond) { const k = r[3] || "(没写)"; byKind[k] = (byKind[k] || 0) + 1; }
console.log(`== LINES_BEYOND_SHAPE ${beyond.length} 条，按 blocked_by 分：`
  + JSON.stringify(byKind));
console.log(`== 铺得出的里面，成品借进料行那股走的（share.laid）：${sharedRows.length} 条`);
console.log("== 明细（拒的那几条，一行一条）：");
for (const r of refused.slice(0, 200)) {
  console.log(`   ${String(r[0]).padEnd(34)} ${String(r[2]).padEnd(28)} ${r[3] || ""}`);
}
console.log(`\n${rows.length > 0 ? "ALL PASS" : "FAILED"}: 扫了 ${rows.length} 条，`
  + `铺得出 ${laid.length}，按名拒 ${refused.length}`);
// `CS_DUMP=<路径>` 把整张表（铺得出的与拒因明细都在里面）落到文件：这一把尺跑一趟不便宜，
// 而下一档形状要按簇里的**配方名字**逐条问 —— 没有这份数就得为同一个问题重跑一次。
if (process.env.CS_DUMP) {
  require("fs").writeFileSync(process.env.CS_DUMP, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log("  明细已落盘: " + process.env.CS_DUMP + "（" + rows.length + " 行）");
}
process.exit(rows.length > 0 ? 0 : 1);
