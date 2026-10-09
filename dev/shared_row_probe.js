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
// 还没量到的一格（2026-10-09 追过一轮，写在这免得下一个人又当它成立）：玩家补的那一条是对的模型
// —— "取货臂两股都能取，放货只放**远端那一股**" —— 这台架也证实了前半句（机器在产、下游箱收得到 23 个
// 齿轮、筛过的进料臂不吃回成品）。但后半句在这里没复现出来：站带子**南侧**（机器这一侧）的成品臂与站
// 带子**北侧**的上游放料臂，读回来都是同一条 line（`格(-1) line1[iron-plate] ` 与 `格(7) line1[齿轮]`），
// line2 一直是空的。也就是说"进料走近股、成品走远股、一行带两种料"这件事，沙盒里我还摆不出来 ——
// 要么 `line1/line2` 的号与南北的对应关系不是我想的那样，要么真线上多一个我没摆的件（分流器分股？）。
// 下一步是去他存档里读一条**真实**的这种线（同一面一进一出、带子上两样料并行），
// 拿它的"臂在第几格 + 两样料各在第几条 line"回来当律，而不是在这继续猜。
//
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
-- 上游放料站在带子的**北岸**：臂在 y-3、箱子在更北的 y-4，direction 在这一台 2.0 上是它**取货**的那一面，所以朝北
-- = 从 y-4 的箱子取、往南放到 y-2 的带子上。它放的是**离自己远的那一股**（南岸 = line2），
-- 而机器这一面（南岸）的成品臂放的也是离自己远的那一股（北岸 = line1）—— 这就是他说的"进出料各一只臂
-- 共用一行"。上一版这里写的是南岸放料臂，两样料于是挤进同一股，我就误判成"同面做不到"。
mk("steel-chest", x - 4, y - 4, 0).insert({name = "iron-plate", count = 400})
mk("fast-inserter", x - 4, y - 3, defines.direction.north)
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
for _, cx in ipairs({ x - 2, x + 6 }) do
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
    out[#out+1] = "格(" .. (cx - x) .. ") " .. table.concat(parts, " ")
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
// 他口述的那一条，现在量成了律：**臂只往离自己远的那一股放**，而取货两股都能取（所以进料臂必须带筛选，
// 否则会把对面那股上的成品抓回去 —— 上面那条 gate 钉的就是这件事没发生）。向东的带子上 line1 = 北股、
// line2 = 南股：南岸（机器这一面）的成品臂 → line1；北岸的上游放料臂 → line2。两样料因此在**同一行**上
// 各占一股，也就是"≤0.5 的料占一股、腾出来的那一股给成品"能做出来，不用第二条带子。
const upCell = (String(read).split("\n").find((l) => /格\(-2\)/.test(l)) || "");
const downCell = (String(read).split("\n").find((l) => /格\(6\)/.test(l)) || "");
check("进料走北岸放料臂那一股（line2），成品走机器这一面的远股（line1）—— 同一行、各占一股",
  /line2\[[^\]]*iron-plate/.test(upCell) && /line1\[[^\]]*iron-gear-wheel/.test(downCell)
    && !/line2\[[^\]]*iron-gear-wheel/.test(downCell),
  String(read).split("\n").filter((l) => /格\(|line\d/.test(l)).join(" | "));
check("铁板没有被一路带到下游箱（进料确实是被机器吃掉的）", platesBox === 0, boxLine);

// 快进用的是 `game.ticks_to_run`：那东西把世界**停在暂停里**再走若干 tick，走完不复位。跑完必须解开，
// 不然链上下一套等"世界自己在走"的台架（arm_pair_probe / arm_rate_e2e）读到一屏零 —— 源箱满着、带子空的、
// 机器 crafting=true 而 progress=0，长得跟"这套摆法不成立"一模一样。借了世界就得还（belt_stack_probe 早这么做）。
ask(`game.tick_paused = false rcon.print("unpaused=" .. tostring(not game.tick_paused))`, 3);

console.log("\n-- 收台");
check("台架收干净", /left=0/.test(String(ask(`local s = game.surfaces["arch-lab"]
for _, e in ipairs(s.find_entities_filtered{area = {{${X - 8}, ${Y - 6}}, {${X + 18}, ${Y + 6}}}}) do e.destroy() end
rcon.print("left=" .. tostring(#s.find_entities_filtered{area = {{${X - 8}, ${Y - 6}}, {${X + 18}, ${Y + 6}}}}))`, 3))),
  "sweep");
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
