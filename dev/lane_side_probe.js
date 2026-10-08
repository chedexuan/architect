// 一条带子的两股，分别由站在哪一侧的臂装货。
//
// 为什么先量这个再画"双排"：玩家定的两种排法里，双排的定义就是"两排机器共用中间那条成品带"。两排机器
// 一上一下，各有一只成品臂把货往同一条带子上放 —— 如果它们放的是同一股，那条带子实际只能走一种成品，
// "共用"就是假的；如果各占一股，共用成立，而且不用任何分流器。
//
// `belt_stack_probe` 量的是"臂按距离选哪一行"（近带 / 远带），没有量同一行里的两股。这一台架量的正是
// 那一格：一条向东的带子，北边一只臂从装 iron-plate 的箱子里取货往下放，南边一只臂从装 copper-plate 的
// 箱子里取货往上放，然后在下游三个格子分别读 line1 / line2 里各是什么。后半段还有两台架：同一套动作换到
// **向西**的带子上（牌上的股号会不会随方向换，`S.turn` 会把每张卡都转一次），以及一只朝北的取货臂能不能
// 把同一行两股里的两样料都取走（"一条带子带两种料"靠的就是这一句，画图的代码一直当它是真的）。
//
// 三条坑与全仓库一样：坐标是格子中心；站在 global-electric-network 上的臂仍然没电（那张图是导线不是发电
// 机，所以要一只 electric-energy-interface）；编译失败的 /c 回答**空字符串**，所以读数前先确认它答话了。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("lane_side_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 200); }
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ask = (src, tries) => {
  let out = lua(src);
  for (let n = 1; n <= (tries || 5) && (!out.trim() || /PROBE-FAIL|TRUNCATED|no output/.test(out)); n++) {
    console.log(`  (no reply, asking again in 4 s -- attempt ${n})`);
    sleep(4000);
    out = lua(src);
  }
  return out;
};

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 400)}`);
  ok ? pass++ : fail++;
};

// arch-lab 的一角，别的套件不走这里。(7300,7300) 那角是 arm_pair_probe 的。
const X = 7400, Y = 7400;

const BUILD = String(ask(`local s = game.surfaces["arch-lab"]
local x, y = ${X}, ${Y}
s.request_to_generate_chunks({x, y}, 2) s.force_generate_chunk_requests()
local area = { {x - 4, y - 6}, {x + 86, y + 6} }
for _, e in ipairs(s.find_entities_filtered{ area = area }) do e.destroy() end
-- 自己刷自己那一块地：create_entity 不看地形，can_place_entity 看，而这一角生成出来是 out-of-map。
local tiles = {}
for cx = x - 6, x + 86 do
  for cy = y - 6, y + 6 do
    local ok, t = pcall(function() return s.get_tile(cx, cy) end)
    if not ok or not t or t.name == "out-of-map" or t.name == "water-deep" then
      tiles[#tiles + 1] = { name = "grass-1", position = { x = cx, y = cy }, tile_index = 1 }
    end
  end
end
s.set_tiles(tiles)
pcall(function() s.create_global_electric_network() end)
s.create_entity({ name = "electric-energy-interface", position = { x = x + 12.5, y = y + 4.5 },
  force = "player", raise_built = true })
local function centre(name, cx, cy)
  local p = prototypes.entity[name]
  local w, h = (p and p.tile_width) or 1, (p and p.tile_height) or 1
  return { x = cx + w / 2, y = cy + h / 2 }
end
local function mk(name, cx, cy, dir)
  local e = s.create_entity({ name = name, position = centre(name, cx, cy), direction = dir,
    force = "player", raise_built = true })
  if not e then error("cannot place " .. name .. " at " .. cx .. "," .. cy) end
  return e
end
-- 被测的那一行：y 这一排，向东，从 x-1 到 x+10
for i = 0, 11 do mk("transport-belt", x - 1 + i, y, defines.direction.east) end
-- 北边的臂：站在 y-1，取货面是 y-2 那只箱子，放货面是带子那一行
local northChest = mk("steel-chest", x, y - 2, 0)
mk("fast-inserter", x, y - 1, defines.direction.north)
-- 南边的臂：站在 y+1，取货面是 y+2 那只箱子，放货面是同一条带子
local southChest = mk("steel-chest", x + 1, y + 2, 0)
mk("fast-inserter", x + 1, y + 1, defines.direction.south)
northChest.insert({ name = "iron-plate", count = 200 })
southChest.insert({ name = "copper-plate", count = 200 })
rcon.print("BUILT painted=" .. #tiles .. " north_iron=" .. northChest.get_item_count("iron-plate")
  .. " south_copper=" .. southChest.get_item_count("copper-plate"))`)).replace(/\n/g, " ");
console.log("== build: one east-going row, an arm on each face, a different item in each hand");
console.log("  " + BUILD.slice(0, 200));

// 等东西真的走起来：两只臂各搬 40 个，带子把它们送到下游。
let READ = "";
for (let n = 0; n < 12; n++) {
  sleep(5000);
  READ = String(ask(`local s = game.surfaces["arch-lab"]
local x, y = ${X}, ${Y}
local function read(cx, cy)
  local b = s.find_entities_filtered{ name = "transport-belt", area = { {cx, cy}, {cx + 1, cy + 1} } }[1]
  if not b then return "?" end
  local out = {}
  local n_lines = 0
  pcall(function() n_lines = b.get_max_transport_line_index() end)
  for i = 1, n_lines do
    local line = b.get_transport_line(i)
    local iron, cu = 0, 0
    pcall(function() iron = line.get_item_count("iron-plate") end)
    pcall(function() cu = line.get_item_count("copper-plate") end)
    out[#out + 1] = "line" .. i .. "[iron=" .. iron .. " copper=" .. cu .. "]"
  end
  return table.concat(out, " ")
end
local chests = {}
for _, c in ipairs(s.find_entities_filtered{ name = "steel-chest",
    area = { {x - 3, y - 3}, {x + 3, y + 3} } }) do
  chests[#chests + 1] = math.floor(c.position.x) .. "," .. math.floor(c.position.y)
    .. "=iron" .. c.get_item_count("iron-plate") .. "/cu" .. c.get_item_count("copper-plate")
end
rcon.print("READ " .. read(x + 4, y) .. " || at+7 " .. read(x + 7, y)
  .. " || chests " .. table.concat(chests, " "))`)).replace(/\n/g, " ");
  if (/iron=[1-9]/.test(READ) && /copper=[1-9]/.test(READ)) break;
}
console.log("  " + READ.slice(0, 300));

// 台架可信吗：两样料都得在带子上走（空读数在这台架里和"分流失败"长得一模一样）。
const bothMoving = /iron=[1-9]/.test(READ) && /copper=[1-9]/.test(READ);
check("两只臂都真的把货放上了同一条带子（两样料都在走）", bothMoving, READ.slice(0, 300));

// 分流本身：北臂的 iron 与南臂的 copper 落在**不同**的那一股。
const lineOf = (item) => {
  const m = String(READ).match(new RegExp("line(\\d+)\\[[^\\]]*" + item + "=[1-9][^\\]]*\\]"));
  return m ? Number(m[1]) : 0;
};
const northLane = lineOf("iron");
const southLane = lineOf("copper");
check("北边那只臂装的那一股，和南边那只臂装的，不是同一股",
  northLane >= 1 && southLane >= 1 && northLane !== southLane,
  JSON.stringify([northLane, southLane, READ.slice(0, 200)]));
check("而且这一格在下游是稳的：at+4 与 at+7 都是同一对股道",
  (String(READ).match(/iron=[1-9]/g) || []).length >= 2
  && (String(READ).match(/copper=[1-9]/g) || []).length >= 2, READ.slice(0, 300));
// 这台架量到的是"哪一条股"（line1 / line2 这两个索引各自装的是哪只臂的料）。至于是"离自己近的那一股"
// 还是"离自己远的那一股"，那是 `styles.lua` 文件头已经量过的那条规矩（臂只装远股），两边在这里对得上：
// 两只臂站在带子的两面，各自的料落在不同的股里 —— 这一条就足够让"两排机器共用中间那条成品带"成立。
check("量到的编号：北臂的料在 line" + northLane + "、南臂的料在 line" + southLane
  + "（两臂站在同一行的两面，各占一股）", northLane === 2 && southLane === 1,
  JSON.stringify([northLane, southLane]));

// ---------------------------------------------------------------- 两个方向问题，一次量掉
//
// 上面那条量的是**向东**的带子。牌上写的股号要说的是引擎自己的 line1/line2，而带子的两股是按它行进方向
// 编号的 —— 如果转个方向就换号，那"第 1 股 = 离机器远的那一股"这句话就只对半张卡成立，而 `S.turn` 会把
// 每一张卡转成竖的。所以这里把同一个 rig 镜像一份（带子向西），看两只臂各落在哪一号。
//
// 第二个问题是取货那一侧：单排一条进料带上装两种料（牌写 1、2 两股），靠的是站在带子南边、朝北取货的
// 那只臂**两股都取得走**。这句话原来只是画图的假设，而它要是假的，三种料的单排就会喂不齐 —— 这里用两只
// 臂把两样料分别装进两股（rig 1 量过的动作），再让下游一只朝北的臂去取，看它身后的箱子里到了几样。
const X2 = X + 24, X3 = X + 48, X4 = X + 72;
const BUILD2 = String(ask(`local s = game.surfaces["arch-lab"]
local function centre(name, cx, cy)
  local p = prototypes.entity[name]
  local w, h = (p and p.tile_width) or 1, (p and p.tile_height) or 1
  return { x = cx + w / 2, y = cy + h / 2 }
end
local function mk(name, cx, cy, dir)
  local e = s.create_entity({ name = name, position = centre(name, cx, cy), direction = dir,
    force = "player", raise_built = true })
  if not e then error("cannot place " .. name .. " at " .. cx .. "," .. cy) end
  return e
end
-- rig 2：向西的一行。臂站在**东头**，带子往西走，所以下游读数是往西读的格子（站在西头的话，东西
-- 一放上去就往反方向走，读到的 0 是夹具的错，不是带子的错）。
for i = 0, 11 do mk("transport-belt", ${X2} - 1 + i, ${Y}, defines.direction.west) end
local wNorth = mk("steel-chest", ${X2} + 9, ${Y} - 2, 0)
mk("fast-inserter", ${X2} + 9, ${Y} - 1, defines.direction.north)
local wSouth = mk("steel-chest", ${X2} + 10, ${Y} + 2, 0)
mk("fast-inserter", ${X2} + 10, ${Y} + 1, defines.direction.south)
wNorth.insert({ name = "iron-plate", count = 200 })
wSouth.insert({ name = "copper-plate", count = 200 })
-- 三只臂都要电：arch-lab 上那张 global-electric-network 是导线而不是发电机，rig 之间隔了 24 格，
-- 一只 electric-energy-interface 供不到第二台架（量的时候表现为"两只臂一动不动"，读数全零）。
-- rig 4：**同一面**两只臂装同一条带子。这是单排那一侧的事实：一排机器的成品臂全站在带子同一面，
-- 它们装的是同一股还是两股，决定一条成品带能走 450/分还是 900/分 —— 也就是牌上那个"这张卡许诺每分
-- 多少"到底有没有一条带走得完。从前这条写在已删的 lane_split_probe 里，这里重新量一遍。
for i = 0, 11 do mk("transport-belt", ${X4} - 1 + i, ${Y}, defines.direction.east) end
local n1 = mk("steel-chest", ${X4}, ${Y} - 2, 0)
mk("fast-inserter", ${X4}, ${Y} - 1, defines.direction.north)
local n2 = mk("steel-chest", ${X4} + 1, ${Y} - 2, 0)
mk("fast-inserter", ${X4} + 1, ${Y} - 1, defines.direction.north)
n1.insert({ name = "iron-plate", count = 200 })
n2.insert({ name = "copper-plate", count = 200 })
for _, ix in ipairs({ ${X2} + 9, ${X3} + 4, ${X4} + 6 }) do
  s.create_entity({ name = "electric-energy-interface", position = { x = ix + 0.5, y = ${Y} + 4.5 },
    force = "player", raise_built = true })
end
-- rig 3：一只取货臂能不能把同一行**两股**里的两样料都取走。两样料用与 rig 1 同样的办法放上去（北边的
-- 臂装 iron 到一股、南边的臂装 copper 到另一股，都是量过的动作），然后在下游站一只朝北的臂，箱子放它
-- 身后。取货那一侧原来只是画图的假设（"一条带子带两种料"），而它要是假的，三种料的单排就会喂不齐。
for i = 0, 11 do mk("transport-belt", ${X3} - 1 + i, ${Y}, defines.direction.east) end
mk("steel-chest", ${X3}, ${Y} - 2, 0).insert({ name = "iron-plate", count = 200 })
mk("fast-inserter", ${X3}, ${Y} - 1, defines.direction.north)
mk("steel-chest", ${X3} + 1, ${Y} + 2, 0).insert({ name = "copper-plate", count = 200 })
mk("fast-inserter", ${X3} + 1, ${Y} + 1, defines.direction.south)
-- 取货的那只臂与它身后的箱子：臂站在带子南边、朝北取货（和单排的进料臂同一姿势），放货面朝南。
mk("fast-inserter", ${X3} + 7, ${Y} + 1, defines.direction.north)
mk("steel-chest", ${X3} + 7, ${Y} + 2, 0)
rcon.print("BUILT2 ok")`)).replace(/\n/g, " ");
console.log("== build 2: a west-going mirror, and one arm asked to take from BOTH halves");
console.log("  " + BUILD2.slice(0, 200));

let READ2 = "";
for (let n = 0; n < 12; n++) {
  sleep(5000);
  READ2 = String(ask(`local s = game.surfaces["arch-lab"]
local function read(cx, cy)
  local b = s.find_entities_filtered{ name = "transport-belt", area = { {cx, cy}, {cx + 1, cy + 1} } }[1]
  if not b then return "?" end
  local out, n_lines = {}, 0
  pcall(function() n_lines = b.get_max_transport_line_index() end)
  for i = 1, n_lines do
    local line = b.get_transport_line(i)
    local iron, cu = 0, 0
    pcall(function() iron = line.get_item_count("iron-plate") end)
    pcall(function() cu = line.get_item_count("copper-plate") end)
    out[#out + 1] = "line" .. i .. "[iron=" .. iron .. " copper=" .. cu .. "]"
  end
  return table.concat(out, " ")
end
local got = s.find_entities_filtered{ name = "steel-chest",
  area = { {${X3} + 7, ${Y} + 2}, {${X3} + 8, ${Y} + 3} } }[1]
local iron_in_chest, copper_in_chest = -1, -1
if got then
  iron_in_chest = got.get_item_count("iron-plate")
  copper_in_chest = got.get_item_count("copper-plate")
end
rcon.print("READ2 " .. read(${X2} + 6, ${Y}) .. " || at-3 " .. read(${X2} + 3, ${Y})
  .. " || rig3 " .. read(${X3} + 2, ${Y})
  .. " || rig4 " .. read(${X4} + 4, ${Y}) .. " at+7 " .. read(${X4} + 7, ${Y})
  .. " || chest iron=" .. iron_in_chest .. " copper=" .. copper_in_chest)`)).replace(/\n/g, " ");
  if (/chest iron=[1-9][\s\S]*copper=[1-9]/.test(READ2)) break;
}
console.log("  " + READ2.slice(0, 300));
const westNorthLane = (() => {
  const m = String(READ2).match(/line(\d+)\[[^\]]*iron=[1-9][^\]]*\]/);
  return m ? Number(m[1]) : 0;
})();
const westSouthLane = (() => {
  const m = String(READ2).match(/line(\d+)\[[^\]]*copper=[1-9][^\]]*\]/);
  return m ? Number(m[1]) : 0;
})();
check("向西那一行：两只臂仍然各占一股（共用成品带这件事与带子朝向无关）",
  westNorthLane >= 1 && westSouthLane >= 1 && westNorthLane !== westSouthLane,
  JSON.stringify([westNorthLane, westSouthLane, READ2.slice(0, 160)]));
// 股号会不会随方向换：会或不会都要写下来，因为牌上的号是给玩家按号接总线的，方向是 `S.turn` 给的。
check("量到的编号（向西）：北臂的料在 line" + westNorthLane + "、南臂的料在 line" + westSouthLane
  + " —— 与向东那一行比：" + (westNorthLane === northLane ? "同一套号，转方向不换号" : "号随方向换，牌上的号只能说引擎那一侧"),
  (westNorthLane === northLane) === (westSouthLane === southLane) && westNorthLane >= 1,
  JSON.stringify([northLane, southLane, westNorthLane, westSouthLane]));
// 同一面两只臂的读数：两样料各落在哪一股（同一条带子上）。
const sameFace = (tag) => {
  const seg = String(READ2).split(" || ").find((x) => x.startsWith(tag)) || "";
  const lanes = [...seg.matchAll(/line(\d+)\[iron=([1-9][0-9]*)|line(\d+)\[[^\]]*copper=([1-9][0-9]*)/g)];
  const iron = seg.match(/line(\d+)\[iron=[1-9]/);
  const copper = seg.match(/line(\d+)\[[^\]]*copper=[1-9]/);
  return { iron: iron ? Number(iron[1]) : 0, copper: copper ? Number(copper[1]) : 0, seg };
};
const face4 = sameFace("rig4");
check("同一面两只臂装的是同一股（所以一条成品带只按一股算，单排不能拿两股的运力许诺产率）",
  face4.iron >= 1 && face4.copper >= 1 && face4.iron === face4.copper,
  JSON.stringify([face4.iron, face4.copper, face4.seg]).slice(0, 260));
const CHEST_TAKEN = /iron=([1-9][0-9]*) copper=([1-9][0-9]*)/.test(String(READ2));
check("一只取货臂把同一行**两股**里的两样料都取走了（所以一条带子能带两种料）",
  CHEST_TAKEN, READ2.slice(0, 260));

const SWEPT = String(ask(`local s = game.surfaces["arch-lab"]
local x, y = ${X}, ${Y}
local area = { {x - 6, y - 6}, {x + 86, y + 6} }
local gone = 0
for _, e in ipairs(s.find_entities_filtered{ area = area }) do e.destroy(); gone = gone + 1 end
rcon.print("swept=" .. gone .. " left=" .. #s.find_entities_filtered{ area = area })`));
check("台架收干净（不留电源、不留带子给下一套）", /left=0/.test(String(SWEPT)),
  String(SWEPT).replace(/\n/g, " ").slice(0, 200));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
