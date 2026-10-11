// 一对穿地管中间夹着**别人的管子**（= 另一条液体横穿这一行），这一发到底成不成。
//
// 为什么必须先量这个：第一簇（两种液体进）的几何被逼到这一格上。机器同面两口隔 2 格（量的：
// chemical-plant 进料两口在北面第 -1/+1 格，oil-refinery 在 -1/+1，cryogenic-plant 三个口在南面
// -2/0/+2 —— `dev/two_fluid_ports.js` 那一把尺），于是一路的管子沿机器排走过去，必然**横穿**另一路的
// 竖管。两张管网一贴就并成一段（同一条律把 26 条配方挡在 `LANE_FEEDS_ONE_FLUID`），而唯一的分道办法
// 是你存档炼油厂那一手：出机器两格就用穿地管对换道（第四轮：段号 377/382/365 从头到尾没并过）。
//
// `dev/linked_pair_probe.js` 量过"一对穿地管能不能由脚本成对"（能：`add_linked_connection` + 两只朝向
// 背对背，段号同一个，水从这头到那头），但它用的是**隔 4 格、中间空着**。这一把要的是那三件事的下限：
//   1) 最近能隔几格（隔 2 = 中间只有一格，正好是被横穿那一格）；
//   2) 中间那一格**站着一根管子**（横穿那一路的竖管）时，这对还成不成、水还过不过得去；
//   3) 那根竖管自己有没有被并进来（段号必须不同、而且不能变湿）。
// **这一把现在钉的律**（2026-10-10 修好读法之后重跑，18 发全绿）：背对背的一对从隔 2 一直到隔 8 都成对，
// 被跨的那几格站着别人的管子（它自己仍是独立段、不湿）**或整排带子**（一格都没被顶掉），水照样送到对面。
// 这里先前写过"隔 2 而中间被占就不成对"，那是**读法坏了**：搜索盒 ±0.4 绕格子中心猜、又没限 `names`，
// 于是"读 g2"抓到的是被跨的那个东西（带子没有 fluidbox ⟹ 段号打回 `?`），而 JS 侧 `segOf` 还要求右方
// 括号（那一列打成 `西[56|水25 连1]`）。改口见 `dev/存档排法学习.md` 第八轮：律换成"跨得过去"之后，
// `STEMS_AND_FEED_ROWS` 那一簇两条路都活了 —— 当晚落地的是**不引入新件**的那一条（固体挪到空面），
// 这一把留着另一条路（列用一对穿地管跨过固体行）的地基。
//
// 只在我自己圈的那块地上动，而且**只清我自己那三件**（pipe / pipe-to-ground / transport-belt）：
// `arch-lab` 上有别的套件冻着的卡，一把 `find_entities_filtered` 全清会把服务器弄死（§0 那条坑）。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("pipe_cross_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "30000" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 200); }
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ask = (src, tries) => {
  let out = lua(src);
  for (let n = 1; n <= (tries || 6) && (!out.trim() || /PROBE-FAIL|TRUNCATED|no output/.test(out)); n++) {
    console.log(`  (没回话，4 秒后再问一次 -- 第 ${n} 次)`);
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

// 每一发自己一格原点：X0 + case*24，避免互相挨着（挨着的两发会自己并网，量出来就是假象）。
const X0 = 9400, Y0 = 9400;
const CASES = [];
// 深度是要跟着形状走的数：一口一列要跨过的那一叠是"臂行 + 每条进料带一行"（两行带子就是
 // 1 行臂 + 2 行带 = 3 格，再加成品行的话更深）。所以这里从隔 2 一路量到隔 8，每一档都问同三件事：
 // 空的、中间站着一根管（= 别的路横穿）、中间**整叠都是带子**（= 这一档形状真正要跨的东西）。
 const MIDS = ["empty", "pipe", "belts"];   // pipe+stub 与 belt 单格已在上一轮量过，这里只补"整叠带子"
 for (const d of [2, 3, 4, 5, 6, 8]) for (const mid of MIDS) CASES.push({ d, mid });

const build = CASES.map((c, i) => {
  const gx = X0 + i * 24 + 4, gy = Y0;
  return { ...c, gx, gy, key: `d${c.d}-${c.mid}` };
});
// 塞进 Lua 的那份坐标表必须写成 **Lua 字面量**：JSON 的 `[{"gx":9404}]` 在 Lua 里是
// `{` 后面跟个 `[` —— 整条命令编译不过（报 unexpected symbol near '['），而编译不过在这一仓库里
// 长得跟"服务器没答案"一样，容易一路查歪。（§0 那批仪器坑里就记着这一手。）
const luaSpots = "{" + build.map((b) =>
  `{gx=${b.gx},gy=${b.gy},d=${b.d},mid="${b.mid}",key="${b.key}"}`).join(",") + "}";

const setup = ask(`local s = game.surfaces["arch-lab"]
-- 穿地管的 direction 走的是**管口方向那一套刻度**（0北 4东 8南 12西），不是机器/带子那套
-- （0北 2东 4南 6西）。给错了刻度，两只都还在、也都连着近邻的管子，但就是不成对 —— 段号各走各的，
-- 看上去像"隔几格都跳不过去"，实际是我在问一件它没听懂的事。地架带那一侧照旧用 2（东）。
local DIR_WEST, DIR_EAST = 12, 4
local DIR_BELT_EAST = 2
local function mk(name, x, y, dir)
  return s.create_entity({name = name, position = {x = x + 0.5, y = y + 0.5}, direction = dir,
    force = "player", raise_built = true})
end
local function clean(box)
  for _, e in ipairs(s.find_entities_filtered{area = box,
    name = {"pipe", "pipe-to-ground", "transport-belt", "fast-transport-belt"}}) do
    e.destroy()
  end
end
local out = {}
local spots = ${luaSpots}
for _, c in ipairs(spots) do
  local box = {{c.gx - 6, c.gy - 4}, {c.gx + c.d + 8, c.gy + 4}}
  s.request_to_generate_chunks({c.gx, c.gy}, 2) s.force_generate_chunk_requests()
  clean(box)
  -- 横着这一行：西边的管 -> g1(朝西) -> [中间 c.d-1 格] -> g2(朝东) -> 东边的管
  local west = mk("pipe", c.gx - 1, c.gy, 0)
  local g1 = mk("pipe-to-ground", c.gx, c.gy, DIR_WEST)
  local g2 = mk("pipe-to-ground", c.gx + c.d, c.gy, DIR_EAST)
  local east = mk("pipe", c.gx + c.d + 1, c.gy, 0)
  local mid
  if c.mid == "pipe" or c.mid == "pipe+stub" then
    mid = mk("pipe", c.gx + 1, c.gy, 0)
    if c.mid == "pipe+stub" then
      mk("pipe", c.gx + 1, c.gy - 1, 0) mk("pipe", c.gx + 1, c.gy + 1, 0)
    end
  elseif c.mid == "belt" then
    mid = mk("transport-belt", c.gx + 1, c.gy, DIR_BELT_EAST)
  elseif c.mid == "belts" then
    -- 形状真正要跨的那一叠：被跨的每一格都站一条带子（臂行 + 两条进料带 = 三格）
    for j = 1, c.d - 1 do
      mid = mk("transport-belt", c.gx + j, c.gy, DIR_BELT_EAST)
    end
  end
  local okl = pcall(function() return g1.fluidbox.add_linked_connection(1, g2, 1) end)
  local okr = pcall(function() return g2.fluidbox.add_linked_connection(1, g1, 1) end)
  -- 从最西那根管灌水，跑一拍，看最东那根有没有湿、段号是不是同一个
  local okw = pcall(function() west.fluidbox[1] = {name = "water", amount = 100} return true end)
  out[#out + 1] = string.format("%s link=%s/%s 写=%s", c.key, tostring(okl), tostring(okr), tostring(okw))
end
rcon.print(table.concat(out, "\\n"))`);

console.log("\n-- 摆出来的样子（link=两个方向各试一次）");
console.log(String(setup).split("\n").map((l) => "   " + l).join("\n"));

sleep(3000);
// 跑拍子只用 `game.ticks_to_run`（一条 rcon 命令里写 `while game.tick < t do end` 会把服务器吊住）。
// 它走完会把世界**留在暂停里**，所以读完一定要解（§0 那条链上污染的坑就是这个）。
ask(`game.ticks_to_run = 600 rcon.print("ran")`, 2);
sleep(8000);

const read = ask(`local s = game.surfaces["arch-lab"]
local out = {}
local spots = ${luaSpots}
local function seg(e)
  if not e then return "nil" end
  local r
  pcall(function() r = tostring(e.fluidbox.get_fluid_segment_id(1)) end)
  return r or "?"
end
local function wet(e)
  if not e then return "nil" end
  local b
  pcall(function() b = e.fluidbox[1] end)
  return (b and b.name) and "水" .. tostring(b.amount) or "干"
end
local function conn(e)
  local c
  pcall(function() c = e.fluidbox.get_connections(1) end)
  return tostring(c and #c or -1)
end
for _, c in ipairs(spots) do
  -- 只认管子：从前这个盒子会抓到隔壁那格站着的东西（"belts" 那一档里它抓到带子，带子没有 fluidbox，
  -- 于是 g2 打成 "?"，看着像"这对没连上"，实际东边那根与西边同段 —— 读法把自己骗了）。
  -- 搜索盒按**整格**给（从前写 ±0.4 是绕着格子中心猜的，我把它改窄成 ±0.1 之后什么都抓不到，
  -- 于是整把尺报成"每一档都没连上" —— 全 nil 是读法坏，不是引擎不连）。
  local function at(dx, dy)
    local list = s.find_entities_filtered{area = {{c.gx + dx, c.gy + dy},
      {c.gx + dx + 1, c.gy + dy + 1}}, name = {"pipe", "pipe-to-ground"}, limit = 1}
    return list[1]
  end
  local function whatever(dx, dy)
    local list = s.find_entities_filtered{area = {{c.gx + dx, c.gy + dy},
      {c.gx + dx + 1, c.gy + dy + 1}}, limit = 1}
    local e = list[1]
    return e and e.name or "空"
  end
  local west, g1, g2, east = at(-1, 0), at(0, 0), at(c.d, 0), at(c.d + 1, 0)
  local middle = at(1, 0)
  local up = at(1, -1)
  out[#out + 1] = string.format(
    "%s 西[%s|%s 连%s] g1段[%s] g2段[%s] 东[%s|%s 连%s] 中[%s|%s 段%s] 中上[段%s] 中格站着[%s]",
    c.key, seg(west), wet(west), conn(west), seg(g1), seg(g2), seg(east), wet(east), conn(east),
    seg(middle), wet(middle), seg(middle), seg(up), whatever(1, 0))
end
rcon.print(table.concat(out, "\\n"))`);

console.log("\n-- 量到的（西=进水那头，东=该收到水的那头，中=横穿那一路）");
const lines = String(read).split("\n").filter((l) => l.includes(" "));
for (const l of lines) console.log("   " + l);

// 段号那一格打成 `西[56|水25 连1]`（后面还跟着干湿与连接数），所以这里**不能**要求右方括号：
// 写成 `\[(\d+)\]` 时西/东/中三列一律返回 null，于是 18 发全红 —— 又是读法坏、不是引擎不连。
const segOf = (l, label) => {
  const m = new RegExp(label + "\\[(\\d+)").exec(l);
  return m ? m[1] : null;
};
const lineFor = (key) => lines.find((l) => l.startsWith(key));

for (const c of build) {
  const l = lineFor(c.key);
  if (!l) { check(`${c.key}：这一发读回来了`, false, "没有这一行"); continue; }
  const west = segOf(l, "西"), g1 = segOf(l, "g1段"), g2 = segOf(l, "g2段"), east = segOf(l, "东");
  const merged = west && g1 && g2 && east && west === g1 && g1 === g2 && g2 === east;
  check(`${c.key} 隔 ${c.d} 格、中间 ${c.mid}：横的这一路是一个段，水到了对面`,
    !!merged && /水/.test((/东\[[^|]*\|([^ ]*)/.exec(l) || [])[1] || ""), l);
  const midSeg = segOf(l, "中"), midWet = ((/中\[[^|]*\|([^ ]*)/.exec(l) || [])[1] || "");
  const midThing = ((/中格站着\[([^\]]*)\]/.exec(l) || [])[1] || "").trim();
  if (c.mid === "pipe" || c.mid === "pipe+stub") {
    // 只有这一档有"竖着横穿的那一路"要隔离：段号必须不同，而且不能湿。
    check(`...而竖的那一路（中间那一格）没被并进来：段号不同、而且没湿`,
      !!midSeg && midSeg !== east && /干/.test(midWet), l);
  } else {
    // `empty` 与 `belts` 两档中间没有别人的管子，"隔离"这一判没有对象 —— 从前它被当成失败，
    // 于是这把尺自己红成一堆。改判它真正该保证的事：被跨的东西还在原地（没被管子顶掉、也没同段）。
    check(`...被跨的那一叠没有被顶掉（中格 = ${c.mid === "empty" ? "空" : "带子"}）`,
      c.mid === "empty" ? midThing === "空" : /belt/.test(midThing), l);
  }
}

console.log("\n-- 收尾：只清我自己摆的这三件，并把世界时钟解回来");
console.log("  " + ask(`game.tick_paused = false
local s = game.surfaces["arch-lab"]
local n = 0
for _, e in ipairs(s.find_entities_filtered{area = {{${X0 - 8}, ${Y0 - 6}}, {${X0 + build.length * 24 + 8}, ${Y0 + 6}}},
  name = {"pipe", "pipe-to-ground", "transport-belt"}}) do e.destroy() n = n + 1 end
rcon.print("cleared " .. n .. " paused=" .. tostring(game.tick_paused))`));
check("世界时钟解开（这把探针不欠一条暂停的世界）",
  /false/.test(String(ask(`rcon.print(tostring(game.tick_paused))`))), "game.tick_paused 读回不是 false");
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
