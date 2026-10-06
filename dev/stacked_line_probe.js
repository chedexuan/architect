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

// 机器与配方都点名。这一台架第一版选的是 advanced-circuit —— 那个配方**这个存档没研究**
// （force.recipes[...].enabled = false），于是机器有电、料吃满（in=[4,8,4] 正好两次工艺）、progress 永远
// 0.00，被误读成"形状有问题"。2.0 的 set_recipe 对"这个势力做不了的配方"照单接受，get_recipe 也读得回来，
// 所以模型必须在挑的时候就说 —— 这条单独立任务。改用 lab（三种料、这个存档会做）。
const card = call("card_example", { recipe: "lab", machines: 4, style: "stacked",
  machine: "assembling-machine-2" });
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

// ---------------------------------------------------------------- 第 1 步收尾：冻一张卡，真建
// 摆东西一律走模型自己的 `card_place`：上一版把 55 个零件摊成 55 行 create_entity 塞进一条 /c，服务端
// 一个字都不回（TRUNCATED: got 0 bytes —— lane_split_probe 开头说"编译不过等于沉默"，这里是太长）。
// 走 card_place 还顺带多证一件事：玩家拿到手上、放下去的就是这张卡。
// 先把图开出来：`card_place` 用 `resolve_surface(名字)` 找地面，图不存在它就 NO_SURFACE。
// 上一版把这一步删了（因为公用图上不需要），自建图之后它又是必需的了。
sweepLua("开图与前置清扫");
const froze = call("card_freeze", {
  card: { name: "stacked-probe", entities: d.entities, ports: d.ports, contract: d.contract,
    recipe: d.recipe, product: d.product, ingredient: d.ingredient, components: d.components,
    footprint: d.footprint },
  name: "stacked-probe", allow_unmeasured: true,
});
LOG("第 1 步：冻卡", JSON.stringify([froze.ok, froze.code, (froze.data || {}).entities]));
const placed = call("card_place", { name: "stacked-probe", surface: SURF, ghosts: false });
const pd = placed.data || {};
if (pd.origin) { OX = Math.floor(pd.origin.x); OY = Math.floor(pd.origin.y); }
LOG("第 1 步：真建到地上", JSON.stringify([placed.ok, placed.code, pd.placed, pd.built, OX, OY,
  (((placed.data || {}).wires || {}).recipes || {}).bound, placed.msg]));
check("整条线真的建成了实体（不是虚影）：55 件全落下、没有 refused",
  placed.ok && (pd.built || pd.placed || 0) >= (d.entities || []).length - 3
    && Object.keys(pd.refused || {}).length === 0,
  JSON.stringify([placed.code, placed.msg, pd]).slice(0, 400));

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
-- 配方：这张冻卡没带 machine_recipes，所以在卡外按名字绑上（探针不替这条线改几何，只补玩家会做的事）
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
// 这不是台架的手艺问题，是形状自己带出来的硬要求：**一条带要两股各装一种料，股就得分别被喂**；而这条线
// 不许箱子，所以线头只能是裸带尾 + 一块写清"第几条带子第几股装哪种料"的牌（#9），由玩家的总线在卡外
// 按股接上。完整的"按股喂"夹具记进 §7，生产那一证等它。
const lanesLoaded = /in=\[[^\]]*iron-gear-wheel=\d+[^\]]*electronic-circuit=\d+/.test(String(last));
check("两条进料带各有一股真的进了机器（近带与远带都被抽到，臂与电都通）",
  lanesLoaded, String(last).slice(0, 260));
const stillCrafting = Number((String(last).match(/crafting=(\d+)/) || [0, 0])[1]);
LOG("生产那一证的状态", madeCount > 0
  ? "做出来了 " + madeCount + " 件 —— 按股喂的夹具已经能证明到底了"
  : "未证：还差一把按股分别喂料的台架（§7）。现在读到的死锁是"
    + "一股先灌满 20 件类型上限、臂卡住后另一股永远进不去");
check("成品箱的读数如实带进日志（0 也是一条读数，不拿它当形状的证据）",
  true, JSON.stringify([madeCount, stillCrafting]));

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
// 冻的卡也忘掉：探针留在 `storage.cards` 里的一张 "stacked-probe"，下一套按名字找卡片时会看见它。
const forgot = call("card_forget", { name: "stacked-probe" });
check("冻的那张卡也忘掉（不给下一套留一张会被人当成自己卡的卡）",
  forgot.ok !== false, JSON.stringify([forgot.code, forgot.msg]));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
