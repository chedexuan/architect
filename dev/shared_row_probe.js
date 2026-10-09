// 一行带子共用：一股走进料、另一股走成品，机器同一面站两只臂（一只取、一只放）。
//
// 玩家 2026-10-09 给的就是这一手："如果进料和出料共用一个传送带的话，机械臂要用两个，进出料各一个，
// 机器同一面肯定可以放多个机械臂的。" 而 `lane_side_probe.js` 早先把两件相关的事量死了：
//   (a) 一只**不筛料**的取货臂会把同一行两股里的两样料都取走 —— 直接照他说的摆，进料臂会把对面那股上的
//       成品又抓回机器；
//   (b) 同一面两只都在放货的臂落进**同一股**。
// 两条合起来指向同一个解：**臂带筛选**。这一把台架问的是剩下那两个能验的问题：
//   1. 筛过的进料臂会不会跳过对面那股上的成品（不抓回来）；
//   2. 进料走的那一股与成品落的那一股，是不是真的两股（`get_max_transport_line_index` = 2，一股指）。
// 配方用 `iron-gear-wheel`（铁板进、齿轮出）—— 上一版这里写的是 `iron-plate`，那是一条**冶炼**配方，
// 组装机根本不做它：机器 `get_recipe()` 回 nil，带子明明在动而整台架静悄悄，看着就像"这套摆法不成立"。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("shared_row_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 300); }
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ask = (src, tries) => {
  let out = lua(src);
  for (let n = 1; n <= (tries || 6) && (!out.trim() || /PROBE-FAIL|TRUNCATED|no output/.test(out)); n++) {
    console.log(`  (no reply, asking again in 5 s -- attempt ${n})`);
    sleep(5000);
    out = lua(src);
  }
  return out;
};
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 500)}`);
  ok ? pass++ : fail++;
};

const X = 7600, Y = 7760;

// 向东的一行带子在 y-2；机器 3×3 中心在 y+1（顶行是 y）；两只臂站在 y-1 那一行。
// 上游 (x-4) 铁板箱 + 一只朝南的臂把铁板放上带子；下游 (x+10) 一只朝北的臂 + 空箱收齿轮。
console.log("\n-- 架台");
const built = ask(`local s = game.surfaces["arch-lab"]
local x, y = ${X}, ${Y}
s.request_to_generate_chunks({x, y}, 2) s.force_generate_chunk_requests()
for _, e in ipairs(s.find_entities_filtered{area = {{x - 8, y - 6}, {x + 18, y + 6}}}) do e.destroy() end
pcall(function() s.create_global_electric_network() end)
local mk = function(name, cx, cy, dir)
  return s.create_entity({name = name, position = {x = cx + 0.5, y = cy + 0.5}, direction = dir,
    force = "player", raise_built = true}) end
mk("electric-energy-interface", x + 3, y + 4, 0)
mk("steel-chest", x - 4, y, 0).insert({name = "iron-plate", count = 400})
mk("fast-inserter", x - 4, y - 1, defines.direction.south)
for i = 0, 15 do mk("transport-belt", x - 5 + i, y - 2, defines.direction.east) end
local mach0 = mk("assembling-machine-2", x + 3, y + 1, 0)
local okr, rr = pcall(function() mach0.set_recipe("iron-gear-wheel") return tostring(mach0.get_recipe().name) end)
local productArm = mk("fast-inserter", x + 2, y - 1, defines.direction.south)
local feedArm = mk("fast-inserter", x + 4, y - 1, defines.direction.north)
local okf, rf = pcall(function() feedArm.set_filter(1, "iron-plate") return feedArm.get_filter(1) end)
local okp, rp = pcall(function() productArm.set_filter(1, "iron-gear-wheel") return productArm.get_filter(1) end)
mk("steel-chest", x + 10, y, 0)
mk("fast-inserter", x + 10, y - 1, defines.direction.north)
game.ticks_to_run = 1
local nbelt = s.find_entities_filtered{name = "transport-belt", area = {{x, y - 3}, {x + 1, y - 1}}}[1]
local nl = 0
pcall(function() nl = nbelt.get_max_transport_line_index() end)
rcon.print(string.format("配方=%s 取料臂筛=%s 成品臂筛=%s 带行数=%s",
  (okr and rr or ("ERR:" .. tostring(rr))),
  (okf and rf and tostring(rf.name) or ("ERR:" .. tostring(rf))),
  (okp and rp and tostring(rp.name) or ("ERR:" .. tostring(rp))), tostring(nl)))`);
console.log("   " + String(built).split("\n")[0]);
check("这一台 2.0 上：臂的筛选写得进也读得回（set_filter(1,…) / get_filter(1)），配方设得上，一行带子确实是两条 line",
  /配方=iron-gear-wheel/.test(String(built)) && /取料臂筛=iron-plate/.test(String(built))
    && /成品臂筛=iron-gear-wheel/.test(String(built)) && /带行数=2/.test(String(built)), built);

ask(`game.ticks_to_run = 1800 rcon.print("running")`, 3);
sleep(24000);

const read = ask(`local s = game.surfaces["arch-lab"]
local x, y = ${X}, ${Y}
local out = {}
local mach = s.find_entities_filtered{name = "assembling-machine-2", area = {{x, y}, {x + 5, y + 2}}}[1]
if mach then
  local inv = mach.get_inventory(defines.inventory.crafter_input)
  local oiv = mach.get_inventory(defines.inventory.crafter_output)
  out[#out+1] = "机器 进铁板=" .. tostring(inv and inv.get_item_count("iron-plate"))
    .. " 进齿轮=" .. tostring(inv and inv.get_item_count("iron-gear-wheel"))
    .. " 出齿轮=" .. tostring(oiv and oiv.get_item_count("iron-gear-wheel"))
    .. " 进度=" .. tostring(mach.crafting_progress)
end
local box = s.find_entities_filtered{type = "container", area = {{x + 9, y - 1}, {x + 11, y + 1}}}[1]
out[#out+1] = "下游箱 齿轮=" .. tostring(box and box.get_item_count("iron-gear-wheel"))
  .. " 铁板=" .. tostring(box and box.get_item_count("iron-plate"))
for _, cx in ipairs({ x + 3, x + 6 }) do
  local b = s.find_entities_filtered{name = "transport-belt", area = {{cx, y - 3}, {cx + 1, y - 1}}}[1]
  if b then
    local parts = {}
    for i = 1, 2 do
      local okl, l = pcall(function() return b.get_transport_line(i) end)
      if okl and l then
        local t = {}
        local okc, c = pcall(function() return l.get_contents() end)
        if okc and c then for _, it in ipairs(c) do t[#t+1] = it.name .. "=" .. it.count end end
        parts[#parts+1] = "line" .. i .. "[" .. table.concat(t, ",") .. "]"
      else parts[#parts+1] = "line" .. i .. "[ERR]" end
    end
    out[#out+1] = "格(" .. cx .. ") " .. table.concat(parts, " ")
  end
end
rcon.print(table.concat(out, "\\n"))`);
console.log(read.split("\n").map((l) => "   " + l).join("\n"));

const boxLine = (String(read).split("\n").find((l) => /下游箱/.test(l)) || "");
const gearsIn = Number((/进齿轮=(\d+)/.exec(String(read)) || [])[1] || -1);
const gearsBox = Number((/齿轮=(\d+)/.exec(boxLine) || [])[1] || 0);
const platesBox = Number((/铁板=(\d+)/.exec(boxLine) || [])[1] || 0);
const lineHas = (which, item) => new RegExp("line" + which + "\\[[^\\]]*" + item).test(String(read));
check("筛过的进料臂没有把对面那股上的成品抓回来：机器输入格里齿轮数是 0，而线真的在产（下游箱收得到）",
  gearsIn === 0, String(read).slice(0, 300));
check("成品走完了这一段：下游箱里数得到齿轮（成品臂放上带子、下游取货臂取走）",
  gearsBox > 0, String(read).slice(0, 300));
// 这一条原来写的是"各占一股"，量下来**不是**：同一面那两只臂（一只从带子取、一只往带子放）落的
// 是同一条 line —— 与 `lane_side_probe.js` 那条"同一面两只放货的臂装的是同一股"对上，而且这一发把
// "一进一出"那种组合也量到了。所以共用一行的那一行只按**一股**的运力算，别按两股许诺产率。
const middle = (String(read).split("\n").find((l) => /格\(\d+\)/.test(l)) || "");
check("进料与成品落在**同一条 line**（同一面两只臂只占一股）—— 这一行的运力按一股算，不按两股",
  /line1\[[^\]]*iron-plate[^\]]*,[^\]]*iron-gear-wheel/.test(middle) && !/line2\[[^\]]+\]/.test(middle),
  String(read).split("\n").filter((l) => /line\d/.test(l)).join(" | "));
check("铁板没有被一路带到下游箱（进料确实是被机器吃掉的）", platesBox === 0, boxLine);

console.log("\n-- 收台");
check("台架收干净", /left=0/.test(String(ask(`local s = game.surfaces["arch-lab"]
for _, e in ipairs(s.find_entities_filtered{area = {{${X - 8}, ${Y - 6}}, {${X + 18}, ${Y + 6}}}}) do e.destroy() end
rcon.print("left=" .. tostring(#s.find_entities_filtered{area = {{${X - 8}, ${Y - 6}}, {${X + 18}, ${Y + 6}}}}))`, 3))),
  "sweep");
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
