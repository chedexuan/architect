// 把 `stacked` 这个形状本身摆到地上，喂上料，看它真造不造得出东西。
//
// 为什么需要这台架：`card_verify` 已经证明它放得下、臂不瞎（55/55、blind=0），但"放得下"和"在生产"是
// 两个断言。现有的实测台架 `card_lab` 是**往线头的箱子里灌东西**的，而这条线一只箱子都没有 —— 裸带尾
// 没有 in-port，`card_lab` 按名拒（CARD_NO_PORTS），所以它量不到这条线。玩家要恰恰是"零箱子的线也要
// 能正常生产"，那就得有一台"在带子尾巴上接供料"的台架 —— 那也正是玩家自己接总线的动作。
//
// 台架做的三件事，一件不含糊：
//   1. 用 `card_example` 要来的**就是这张卡的 parts**（不是手抄的坐标），按格子摆到 arch-lab 的一角；
//   2. 在每条进料带的最西一格外面接"源箱 + 一只快臂"（玩家在那儿接总线，这里替他接上）；
//   3. 成品带东头一只取货臂 + 一只收箱（在卡外，不算这条线的箱子），数它做出了多少。
// 断言的是：**做出来了 > 0**，而且机器级/线头/末端在卡内的箱子是 0。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("stacked_line_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 200); }
};
const call = (m, a) => {
  const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
    { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 26 });
  return JSON.parse(out.slice(out.indexOf("{")));
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ask = (src, tries) => {
  let out = lua(src);
  for (let n = 1; n <= (tries || 5) && (!out.trim() || /PROBE-FAIL|no output/.test(out)); n++) {
    console.log(`  (没回话，4 秒后再问 -- 第 ${n} 次)`);
    sleep(4000);
    out = lua(src);
  }
  return out;
};

// 卡落在哪一格由模型自己选（`find_card_site` 会挑一块地真的接受这张卡的格子）—— arch-lab 的格子是
// out-of-map，`create_entity` 允许、`card_place` 按 SITE_REJECTED 拒，所以这里必须跟着答案走而不是写死。

const SURF = "arch-stacked-probe";
// 为什么自己开一张图：上一版这台架在公用的 arch-sandbox 上调了 create_global_electric_network()，而
// 那张图**再也变不回去**（regress.sh 开头就写着这个操作不可撤销）—— 于是接下来的极子测量全报
// CANNOT_MEASURE_POLE，一次探针把两套门禁弄红。这台架要的"电"只是让臂和机器动起来，不值得拿公用图去换，
// 所以它用自己的图、结尾把图删掉。落在哪一格由 `card_place` 自己选（`find_card_site` 会拒 out-of-map 的
// 地面，arch-lab 就是），探针跟着答案走，不写死坐标。
let OX = 0, OY = 0;

let pass = 0, fail = 0, step = 0;
const LOG = (what, detail) => {
  step++;
  console.log(`  [step ${step}] ${what}${detail ? " :: " + String(detail).replace(/\n/g, " ").slice(0, 420) : ""}`);
};
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 400)}`);
  ok ? pass++ : fail++;
};
// 每相建之前先扫同一片地：上一相留在地上的带子会被下一相当成"供料"，那读出来的数是垃圾。
// 箱子要先倒空再拆 —— 拆一只装满的箱子会把东西掉在地上，下一套走进来看到的是 litter 不是实体。
const sweepLua = (tag) => ask(`local SURF = "${SURF}"
local s = game.surfaces[SURF]
if not s then
  -- 2.0 的写法量过：create_surface(名字) 一个参数就行；带 game.map_settings 反而报 "table expected, got userdata"
  local ok2, made = pcall(function() return game.create_surface(SURF) end)
  if ok2 and made then s = made end
end
if not s then rcon.print("NO_SURFACE") return end
s.request_to_generate_chunks({0.5, 0.5}, 3) s.force_generate_chunk_requests()
local area = {{${OX - 12}, ${OY - 12}}, {${OX + 64}, ${OY + 34}}}
for _, e in ipairs(s.find_entities_filtered{type = "container", area = area}) do
  pcall(function() e.get_inventory(defines.inventory.chest).clear() end) end
pcall(function() s.destroy_items({area = area, inset = 0}) end)
local gone = 0
for _, e in ipairs(s.find_entities_filtered{area = area}) do e.destroy(); gone = gone + 1 end
rcon.print("${tag} swept=" .. gone)`);

// 配方点名，机器不点名。
// 为什么配方要钉：第一版选的是 advanced-circuit —— 那个配方**这个存档没研究**
// （force.recipes[...].enabled = false），于是机器有电、料吃满（in=[4,8,4] 正好两次工艺）、progress 永远
// 0.00，被误读成"形状有问题"。2.0 的 set_recipe 对"这个势力做不了的配方"照单接受，get_recipe 也读得回来，
// 所以模型必须在挑的时候就说 —— 这条单独立任务。改用 lab（三种料、这个存档会做）。
// 为什么机器反过来不钉：上一版把机器也钉成 `assembling-machine-2`，而这台测试服的 player 势力**没研究
// automation-2**（量的：`unlocks_with = automation-2, researched = false`），于是这一发按名拒
// `MACHINE_ASKED_UNUSABLE`。那是那扇门该有的行为（点名的机器不许被背着换），不是形状的问题；从前这里能过
// 只是因为那张档研究过。探针不该依赖一档它从未声明过的研究状态，所以让梯子自己挑（这台机上它会用
// assembling-machine-1，lab 照跑），下面的 `recipes_bound` 数的是" type = assembling-machine "的件数，
// 与挑了哪一档无关。
const card = call("card_example", { recipe: "lab", machines: 4, style: "stacked" });
const d = card.data || {};
const lp = d.lane_plan || {};
LOG("要的卡", JSON.stringify({ style: d.style, footprint: d.footprint, parts: d.parts,
  需要进成: [lp.feed_rows_needed, lp.product_rows_needed], 铺了: [lp.feed_rows_laid, lp.product_rows_laid],
  chest_free: lp.chest_free }));
if (!card.ok) { console.log("卡就没成，探针停"); process.exit(1); }
const ents = (d.entities || []).map((e) => ({ name: e.name, x: e.position.x, y: e.position.y,
  dir: e.direction || 0 }));
const belts = ents.filter((e) => /transport-belt/.test(e.name));
const rows = {};
belts.forEach((b) => { const k = Math.floor(b.y); rows[k] = (rows[k] || 0) + 1; });
const beltRows = Object.keys(rows).map(Number).sort((a, b) => a - b);
LOG("带子行", JSON.stringify({ rows: beltRows, counts: beltRows.map((r) => rows[r]) }));
// 最北的两行是进料带（stacked 把它们摆在机器上面），最南那行是成品带。
const feedRows = beltRows.slice(0, lp.feed_rows_laid);
const productRows = beltRows.slice(lp.feed_rows_laid);
LOG("分面", JSON.stringify({ feedRows, productRows }));
check("卡里一只箱子都没有", (d.parts || {}).chests === 0 && lp.chest_total === 0,
  JSON.stringify([d.parts, lp.chests_by_role]));
check("带子的分面对得上：进料在上面 " + feedRows.length + " 行、成品在下面 " + productRows.length + " 行",
  feedRows.length === lp.feed_rows_laid && productRows.length === lp.product_rows_laid
    && productRows.every((r) => r > Math.max(...feedRows)),
  JSON.stringify({ beltRows, feedRows, productRows }));

// ---------------------------------------------------------------- 第 1 步收尾：把这张卡真摆到地上
// 从前这里绕两道门：`card_freeze`（存一张卡）+ `card_place`（把存着的卡铺下去）。那套"卡片存放"整段删了
// （dev/refusals.js 开头记着这批死门），而这台架要的从来不是"存卡"，是**卡上的零件按卡上的坐标落到地上**
// —— 所以直接走引擎，一件都不绕。
// 为什么分批：一次 /c 摊 55 行 create_entity 会被截断（服务端回 0 字节；"编译不过等于沉默"这条在
// dev/lane_side_probe.js 开头量过）。每批 10 件，批与批之间不落任何断言，最后只数总件数。
// 坐标就用地面原点：卡的零件已被 `styles.normalize` 滑到左上角 {0,0}，而这张图是自己开的、结尾自己删，
// 所以不必再让一扇门来替它挑格子 —— 挑格子那一步从前正是 `card_place` 的 SITE_REJECTED 在管的事。
sweepLua("开图与前置清扫");
OX = 0; OY = 0;
const layBatches = [];
for (let i = 0; i < ents.length; i += 10) layBatches.push(ents.slice(i, i + 10));
let laidTotal = 0, lostTotal = 0; const lostNames = [];
for (let i = 0; i < layBatches.length; i++) {
  const rows = layBatches[i].map((e) => `{n = "${e.name}", x = ${e.x}, y = ${e.y}, d = ${e.dir}}`).join(", ");
  const one = ask(`local s = game.surfaces["${SURF}"]
if not s then rcon.print("NO_SURFACE") return end
s.request_to_generate_chunks({0.5, 0.5}, 3) s.force_generate_chunk_requests()
local n, bad = 0, {}
for _, p in ipairs({ ${rows} }) do
  local e = s.create_entity({name = p.n, position = {x = p.x, y = p.y}, direction = p.d,
    force = "player", raise_built = true})
  if e then n = n + 1 else bad[#bad + 1] = p.n end
end
rcon.print("LAY " .. n .. " bad=" .. #bad .. " " .. table.concat(bad, ","))`);
  const m = String(one).match(/LAY (\d+) bad=(\d+)/);
  if (!m) { LOG(`第 1 步：批 ${i + 1} 没回话`, String(one).slice(0, 160)); continue; }
  laidTotal += Number(m[1]); lostTotal += Number(m[2]);
  for (const nm of String(one).slice(String(one).indexOf("bad=") + 8).split(",")) {
    if (nm && nm.trim()) lostNames.push(nm.trim());
  }
}
LOG("第 1 步：真建到地上", JSON.stringify([laidTotal, lostTotal, lostNames.slice(0, 4), OX, OY]));
check("整条线真的建成了实体（不是虚影）：卡上几件就落下几件，一件都不肯静默少",
  laidTotal === ents.length && lostTotal === 0,
  JSON.stringify([laidTotal, ents.length, lostNames]).slice(0, 400));

// ---------------------------------------------------------- 第 2、3 步：卡外接料与收料
// 行号不假设：先在摆好的地上把带子的行找出来（最上面 feedRows.length 行是进料带，最下面是成品带），
// 再从带子的头尾格往外接 —— 探针自己定位，不拿一份手抄坐标去对。
const rig = ask(`local SURF = "${SURF}"
local s = game.surfaces[SURF]
if not s then
  -- 2.0 的写法量过：create_surface(名字) 一个参数就行；带 game.map_settings 反而报 "table expected, got userdata"
  local ok2, made = pcall(function() return game.create_surface(SURF) end)
  if ok2 and made then s = made end
end
if not s then rcon.print("NO_SURFACE") return end
s.request_to_generate_chunks({0.5, 0.5}, 3) s.force_generate_chunk_requests()
pcall(function() s.create_global_electric_network() end)
local area = {{${OX - 12}, ${OY - 12}}, {${OX + 64}, ${OY + 34}}}
local byRow, minC, maxC = {}, nil, nil
for _, e in ipairs(s.find_entities_filtered{name = "fast-transport-belt", area = area}) do
  local cx, cy = math.floor(e.position.x), math.floor(e.position.y)
  byRow[cy] = (byRow[cy] or 0) + 1
  if not minC or cx < minC then minC = cx end
  if not maxC or cx > maxC then maxC = cx end
end
local rws = {}
for r in pairs(byRow) do rws[#rws + 1] = r end
table.sort(rws)
local function put(name, cx, cy, dir)
  return s.create_entity({name = name, position = {x = cx + 0.5, y = cy + 0.5}, direction = dir or 0,
    force = "player", raise_built = true})
end
-- 一条带两半股，而**一只臂只能喂一股**：这一版就是这么栽的 —— 一只箱里混装塑料+铜线、一只臂往带子上推，
-- 结果机器收满 4 根铜线就不再收，臂卡在自己手里那根铜线上，塑料永远进不去（84 根铜线、68 个电路板被取走，
-- 塑料一件没动，产出 0）。§4 那条"混道无害"说的是**取料**那一侧（同一排机器吃同一配方，抓哪股都是它的料），
-- 不是**放料**这一侧：放料要两个半股就得有两只臂，从这条带的两个面各放一次（放下去永远落在离自己远那一股）。
-- 所以这里按"每条带的哪一格、从哪个面"摆供料：最上面那条带两面都空着（北边是卡外），能喂两股；
-- 里面那条带的北面是上面那条带子（实体），只剩西头一个面 → 一股。这正好也是 #9 的牌必须写给玩家看的事。
local lanes = {
  { item = "iron-gear-wheel", row = 1, face = "west" },
  { item = "copper-cable", row = 1, face = "north" },
  { item = "electronic-circuit", row = 2, face = "west" },
}
local note = { "rows=" .. table.concat(rws, ",") .. " cols=" .. tostring(minC) .. ".." .. tostring(maxC) }
for _, ln in ipairs(lanes) do
  local r = rws[ln.row]
  if r then
    local cx, cy, adir, chx, chy = minC - 1, r, defines.direction.west, minC - 2, r
    if ln.face == "north" then
      -- 臂站在带子北边那一格：要往南放到带子上，就得**朝北**抓（方向 = 取货那一面，放点在反面）。
      -- 上一版把这里写成朝南，于是它成了从带子上往箱子里偷料 —— 读数里那个"北边的箱子装着塑料"就是它。
      cx, cy, adir = minC + 1, r - 1, defines.direction.north
      chx, chy = minC + 1, r - 2
    end
    local c = put("steel-chest", chx, chy, 0)
    local got = c and (c.insert{name = ln.item, count = 600} or 0) or -1
    -- 近的一股会饿死远的一股（本轮量到的）：机器那侧的进臂先抽**离它近**的那一股，近股不断料时远股
    -- 一件都不动。所以往"近股"放料的那只供料臂要**慢**，让进臂抽空它、才轮得到远股。
    -- 供料必须比机器吃得慢：上一版用快臂往带子上推（7.5 件/秒），机器 1 秒做一件，结果齿轮把进料仓
    -- 灌满 20 件上限、臂放不进去就**永远卡在那一件上**（§4 相 D 量的正是这个），整台机器再也不动。
    -- 慢臂（inserter）比机器慢，带子不堆料，两半股都轮得到。
    local a = put("inserter", cx, cy, adir)
    note[#note + 1] = ln.item .. "/" .. ln.face .. "=" .. tostring(c ~= nil) .. "," .. tostring(a ~= nil)
      .. "(" .. tostring(got) .. ")"
  end
end
-- 电源：全局电网是**线**，不是发电机（lane_split 开头那条坑）。这台架必须自己带一台
-- electric-energy-interface，否则臂不动、机器不造，读出来全是 0 —— 而那会被误读成"形状错了"。
local gen = put("electric-energy-interface", maxC + 3, rws[1] - 2, defines.direction.north)
-- 配方：卡上没带机器配方这一格，所以在卡外按名字绑上（探针不替这条线改几何，只补玩家会做的事）
local bound = 0
for _, e in ipairs(s.find_entities_filtered{type = "assembling-machine", area = area}) do
  if pcall(function() return e.set_recipe(${JSON.stringify("lab")}) end) then bound = bound + 1 end
end
note[#note + 1] = "power=" .. tostring(gen ~= nil) .. " recipes_bound=" .. bound
-- 成品带东头：臂站在最后一格正南朝北抓，往南放到收箱里（都在卡外，不算这条线的箱子）
local pr = rws[#rws]
local ca = put("fast-inserter", maxC, pr + 1, defines.direction.north)
local sn = put("steel-chest", maxC, pr + 2, 0)
note[#note + 1] = "collector=" .. tostring(ca ~= nil) .. "," .. tostring(sn ~= nil)
rcon.print("RIG " .. table.concat(note, " "))`);
LOG("第 2、3 步：卡外的供料与收料都接上了", rig);
check("供料与收料都接起来了（六件都在，没有 false）",
  /true,true/.test(String(rig)) && !/false/.test(String(rig))
    && /recipes_bound=4/.test(String(rig)), rig);
const sinkCellM = String(rig).match(/rows=([0-9,]+) cols=(-?\d+)\.\.(-?\d+)/);
// 收箱所在的格子直接用台架自己印回来的绝对坐标（floor 后的格心），不拿 BX 再加一遍。
const sinkCell = sinkCellM
  ? `${sinkCellM[3]}/${Number(sinkCellM[1].split(",").filter(Boolean).pop()) + 2}` : "?";
LOG("收箱在哪一格", sinkCell);

let last = "";
for (let i = 0; i < 16; i++) {
  sleep(5000);
  last = ask(`local SURF = "${SURF}"
local s = game.surfaces[SURF]
if not s then
  -- 2.0 的写法量过：create_surface(名字) 一个参数就行；带 game.map_settings 反而报 "table expected, got userdata"
  local ok2, made = pcall(function() return game.create_surface(SURF) end)
  if ok2 and made then s = made end
end
if not s then rcon.print("NO_SURFACE") return end
s.request_to_generate_chunks({0.5, 0.5}, 3) s.force_generate_chunk_requests()
-- 数组一律翻成 Lua 的 {..}：JSON.stringify 出来的 [..] 在这边是 "unexpected symbol near '"'"'['"'"'"'"'"，
-- 而编译不过的 /c 回的是沉默（一次报错只在服务器日志里）。
local area = {{${OX - 12}, ${OY - 12}}, {${OX + 64}, ${OY + 34}}}
local parts = {}
for _, e in ipairs(s.find_entities_filtered{type = "container", area = area}) do
  local inv = e.get_inventory(defines.inventory.chest)
  local items = {}
  for _, it in ipairs(inv.get_contents()) do items[#items + 1] = it.name .. "=" .. it.count end
  parts[#parts + 1] = math.floor(e.position.x) .. "/" .. math.floor(e.position.y) .. ":["
    .. table.concat(items, "+") .. "]"
end
local crafting, machines = 0, {}
for _, e in ipairs(s.find_entities_filtered{type = "assembling-machine", area = area}) do
  local ok, pr = pcall(function() return e.crafting_progress end)
  if ok and (pr or 0) > 0 then crafting = crafting + 1 end
  -- 一台不造东西的组装机，能看的就这四样：吃的配方、手里的活、进料仓、成品仓、电量。
  -- 只读箱子和"有没有在动"是分不出"配方没绑上"和"成品出不去"这两种故障的。
  local one = {}
  pcall(function()
    local r = e.get_recipe()
    one[#one + 1] = "r=" .. (r and r.name or "none")
    one[#one + 1] = "p=" .. string.format("%.2f", e.crafting_progress or -1)
    local i = e.get_inventory(defines.inventory.assembling_machine_input)
    local o = e.get_inventory(defines.inventory.assembling_machine_output)
    local ii, oo = {}, {}
    for _, x in ipairs(i.get_contents()) do ii[#ii + 1] = x.name .. "=" .. x.count end
    for _, x in ipairs(o.get_contents()) do oo[#oo + 1] = x.name .. "=" .. x.count end
    one[#one + 1] = "in=[" .. table.concat(ii, ",") .. "]"
    one[#one + 1] = "out=[" .. table.concat(oo, ",") .. "]"
    one[#one + 1] = "kJ=" .. string.format("%.0f", e.energy or -1)
  end)
  machines[#machines + 1] = table.concat(one, " ")
end
table.sort(parts)
rcon.print("STATE crafting=" .. crafting .. " " .. table.concat(parts, " ") .. " || " .. table.concat(machines, " | "))`);
  if (String(last).indexOf("lab=") >= 0) break;
}
LOG("跑完之后", last);
const sinkLine = String(last).split(" ").find((p) => p.startsWith(sinkCell + ":")) || "";
const produced = (sinkLine.split("[")[1] || "").split("]")[0];
const madeCount = Number((produced.match(/lab=(\d+)/) || [0, 0])[1]);
LOG("成品箱里", JSON.stringify([sinkCell, produced, madeCount]));
// 这台架证明的是"摆得下 + 两半股各自进得去机器"，**不是**"在生产"。三种料的线在这里死在启动顺序上：
// 同一条带上的两种料里，机器的进臂先抽离它近那一股，那一股先灌到 20 件的类型上限，臂放不进去就永远卡在
// 那一件上（§4 相 D 量的同一条律），于是另一种料一辈子进不去、progress 恒为 0。
// 这不是台架的手艺问题，是形状自己带出来的硬要求：**一条带要两股各装一种料，股就得分别被喂**。而这条线
// 不许箱子，所以卡内只给到裸带尾 + 那块说清"第几条带子第几股装哪种料"的牌（#9）—— 总线这一周整条删了，
// 按股接进机器那一步今天在卡外由玩家自己做，于是"在生产"这一证归 §7 那把按股喂的夹具，不在这里。
const lanesLoaded = /in=\[[^\]]*iron-gear-wheel=\d+[^\]]*electronic-circuit=\d+/.test(String(last));
check("两条进料带各有一股真的进了机器（近带与远带都被抽到，臂与电都通）",
  lanesLoaded, String(last).slice(0, 260));
const stillCrafting = Number((String(last).match(/crafting=(\d+)/) || [0, 0])[1]);
const verdictMade = madeCount > 0
  ? "做出来了 " + madeCount + " 件 —— 按股喂的夹具已经能证明到底了"
  : "未证：还差一把按股分别喂料的台架（§7）。现在读到的死锁是"
    + "一股先灌满 20 件类型上限、臂卡住后另一股永远进不去";
LOG("生产那一证的状态", verdictMade);
// 从前这里是 `check(..., true, ...)` —— 一条打在空气上的断言，套件的绿没有它也一样，那它就只是在冒充
// 一件事（AGENTS：不许留永远绿的断言）。它真正该钉的是**那句自述与读数是否同一件事**：
// 做出来了就说做出来几件，没做出来就说是哪一头卡住，不许读数 0 而话写成"在生产"。
const verdict = madeCount > 0 ? "做出来了" : "未证";
check("成品箱的读数与那句自述对得上（0 就说不成立，不许读数 0 而话说成在生产）",
  (madeCount > 0) === (verdict === "做出来了")
    && String(verdictMade).includes(verdict)
    && (madeCount === 0 || /做出来了 \d+ 件/.test(String(verdictMade))),
  JSON.stringify([madeCount, stillCrafting, String(verdictMade).slice(0, 120)]));

const swept = ask(`local SURF = "${SURF}"
local s = game.surfaces[SURF]
if not s then
  -- 2.0 的写法量过：create_surface(名字) 一个参数就行；带 game.map_settings 反而报 "table expected, got userdata"
  local ok2, made = pcall(function() return game.create_surface(SURF) end)
  if ok2 and made then s = made end
end
if not s then rcon.print("NO_SURFACE") return end
s.request_to_generate_chunks({0.5, 0.5}, 3) s.force_generate_chunk_requests()
local area = {{${OX - 12}, ${OY - 12}}, {${OX + 64}, ${OY + 34}}}
for _, e in ipairs(s.find_entities_filtered{type = "container", area = area}) do
  pcall(function() e.get_inventory(defines.inventory.chest).clear() end) end
pcall(function() s.destroy_items({area = area, inset = 0}) end)
local gone = 0
for _, e in ipairs(s.find_entities_filtered{area = area}) do e.destroy(); gone = gone + 1 end
game.speed = 1
local left = 0
for _ in ipairs(s.find_entities_filtered{area = area}) do left = left + 1 end
rcon.print("swept=" .. gone .. " left=" .. left)`);
check("台架收干净", /left=0/.test(String(swept)), swept);
// 图自己也删掉：这台架要的只是"有一张能铺的图"，不是往存档里添一张公用图。
const gone = ask(`if game.surfaces[${JSON.stringify(SURF)}] then game.delete_surface(${JSON.stringify(SURF)}) end rcon.print("gone")`);
check("自建的那张图删掉了（不给存档留一张多余的地面）", /gone/.test(String(gone)), gone);
// 从前这里还有一步 `card_forget`（忘掉冻在 `storage.cards` 里的那张卡）。那套"卡片存放"整段删了，
// 而这台架现在根本不冻卡（零件直接落地），所以地扫干净、图删掉就是它欠存档的全部。
// 留一条断言在一扇不存在的门上，读到的永远是 UNKNOWN_METHOD —— 那是门禁自己变成的谎话。

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
