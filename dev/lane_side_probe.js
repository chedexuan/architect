// 一条带子的两股，分别由站在哪一侧的臂装货。
//
// 为什么先量这个再画"双排"：玩家定的两种排法里，双排的定义就是"两排机器共用中间那条成品带"。两排机器
// 一上一下，各有一只成品臂把货往同一条带子上放 —— 如果它们放的是同一股，那条带子实际只能走一种成品，
// "共用"就是假的；如果各占一股，共用成立，而且不用任何分流器。
//
// `belt_stack_probe` 量的是"臂按距离选哪一行"（近带 / 远带），没有量同一行里的两股。这一台架量的正是
// 那一格：一条向东的带子，北边一只臂从装 iron-plate 的箱子里取货往下放，南边一只臂从装 copper-plate 的
// 箱子里取货往上放，然后在下游三个格子分别读 line1 / line2 里各是什么。
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
local area = { {x - 4, y - 6}, {x + 14, y + 6} }
for _, e in ipairs(s.find_entities_filtered{ area = area }) do e.destroy() end
-- 自己刷自己那一块地：create_entity 不看地形，can_place_entity 看，而这一角生成出来是 out-of-map。
local tiles = {}
for cx = x - 6, x + 16 do
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

const SWEPT = String(ask(`local s = game.surfaces["arch-lab"]
local x, y = ${X}, ${Y}
local area = { {x - 6, y - 6}, {x + 16, y + 6} }
local gone = 0
for _, e in ipairs(s.find_entities_filtered{ area = area }) do e.destroy(); gone = gone + 1 end
rcon.print("swept=" .. gone .. " left=" .. #s.find_entities_filtered{ area = area })`));
check("台架收干净（不留电源、不留带子给下一套）", /left=0/.test(String(SWEPT)),
  String(SWEPT).replace(/\n/g, " ").slice(0, 200));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
