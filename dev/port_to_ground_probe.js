// 路 A 的第一扇门：**机器的液体口，接不认穿地管的地面接口**。
//
// 为什么这一扇必须先开：0.90.0 挪面做掉 4 条之后，剩下的那几条（fluoroketone / coal-liquefaction）缺的是
// 同一手几何 —— 一面既要一口一列、又要站固体带子。列要跨过带子那一叠（臂行 + 1~2 条带 = 3 格），唯一的
// 分道办法是他存档炼油厂那一手：出机器两格就用一对穿地管换道（dev/存档排法学习.md 第四轮，段号
// 377/382/365 从头到尾没并过）。而 dev/pipe_cross_probe.js 现在量到的律是：**背对背的一对从隔 2 到隔 8
// 都成对**，被跨的那几格站着别人的管子（自己仍是独立段、不湿）或整排带子（一格都没被顶掉），水照样送到
// 对面 —— 跨得过去。
//
// 但那把尺两头量的都是**管子**。这一扇问的是它没问过的一件事：
//   pipe-to-ground 的地面接口贴在机器的流体口上时，引擎认不认这一接？
// 认，列就能做成"贴机器那只穿地管 + 固体行外面那只"；不认，就得先来一根普通管再上穿地管（那一发要多占
// 一格地面，深度从 2 变 3，要跟着改 units 的 extent）。两种都能画，只能画量到的那一种。
//
// 三发对照，机器都是化工厂（3×3、dir=0，两口在北面第 -1/+1 格 —— dev/two_fluid_ports.js 读的原型）：
//   A 普通管贴口（现在这一档就是它）—— **基线**：它不绿，后面两发都不能信。
//   B 穿地管贴口，地面接口朝机器 + 隔 4 格另一只朝外 + 远端一根管灌水 —— 要答的那一问。
//   C 同 B 但两只朝向反过来（地面接口背对机器）—— 反向对照：它不该送得水。
// 两份读数都要：机器自己的箱体里有没有这股液体（fb[i].name），以及引擎认这几件连接（get_connections）。
// 只量"湿不湿"不够：贴口那一格站着东西，与真的接上，是两件事。
//
// 两处 2026-10-11 在这把尺上抓到的仪器坑，写在这一点因为它们都会把结论**反过来**说：
//   * `find_entities_filtered` 里 **`names = {...}` 会被静默忽略**（等于没写过滤），正解是
//     `name = {...}`（字符串或表都认）。对照量过：地上 1 根管 + 1 根带子时，`names={"pipe"}` 回 2 件、
//     `name="pipe"` 回 1 件。带 `names=` 的读数其实是"抓到算谁的"，全dev 六个文件里有这一手，
//     三个真用于过滤的（这一把与 `dev/pipe_cross_probe.js`）都已改成 `name=`；第三个 `cryo_feed_probe` 2026-10-14 删了（它自己读不到东西，问题由 `multi_fluid_probe` 1b 钉住）。
//   * 读那**一对**穿地管的段号时，搜索盒的右边界写成 my-1 —— 贴口那一只在 my-0.5，正好被关在框外，
//     每发只读回一根管子。一根管子的段号"不重复"就让我把"摆好了自己成对"改口成"不配对"，那是又一次
//     拿仪器的形状当引擎的说法。整格的框要盖住被读那一格本身。
//
// 坐标按**机器左上角那一格**摆。前一版把 3×3 的机器当 1×1 用 create_entity 的中心摆，于是
// find_entities_filtered 什么都找不到、四发全读成"没这一行" —— 那是我的坐标坏，不是引擎不接。
// 只清自己摆的那几件（pipe / pipe-to-ground / chemical-plant）：一把全清会把服务器弄死（§0 那条坑）。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("port_to_ground_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "30000" };
const lua = (src) => {
  try {
    return execFileSync("node", [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 300); }
};
const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 500)}`);
  ok ? pass++ : fail++;
};

const X0 = 9700, Y0 = 9700;
// 每发自己的机器左上角 (mx,my)：机器占 mx..mx+2 / my..my+2，北面贴口那一格是 y = my-1。
const LUA_CASES = `{
  {k="A-pipe",    mx=${X0},        my=${Y0}},
  {k="B-ptg-in",  mx=${X0 + 40},   my=${Y0}},
  {k="C-ptg-out", mx=${X0 + 80},   my=${Y0}},
  -- D：与 B 一模一样的摆法，但**一次都不调 add_linked_connection** —— 交付走的是虚影/蓝图，
  -- 玩家（或脚本）把件建起来那一刻引擎自己配不配对，决定这一手能不能进牌。
  {k="D-auto",    mx=${X0 + 120},  my=${Y0}},
  -- E：与 D 同一套摆法、同样一次都不调成对 API，但件是**以一个玩家的手**建的（by_player 递进去）。
  -- 交付走的是虚影/蓝图，玩家落下那一刻引擎配不配对，才是这一手能不能进牌的那一问；
  -- D 用脚本建 ⟹ 不配对也正常。两发对着读才分得开"引擎不认脚本建的对"与"引擎谁都不自动配"。
  {k="E-byplayer", mx=${X0 + 160}, my=${Y0}}
}`;

const setup = lua(`local s = game.surfaces["arch-lab"]
local DIR_NORTH, DIR_SOUTH = 0, 8
local function one(name, x, y, dir, bp)
  return s.create_entity({name = name, position = {x = x + 0.5, y = y + 0.5}, direction = dir,
    force = "player", raise_built = true, by_player = bp})
end
local function machine3(x, y)
  return s.create_entity({name = "chemical-plant", position = {x = x + 1.5, y = y + 1.5}, direction = 0,
    force = "player", raise_built = true})
end
local out = {}
for _, c in ipairs(${LUA_CASES}) do
  s.request_to_generate_chunks({c.mx, c.my}, 2) s.force_generate_chunk_requests()
  for _, e in ipairs(s.find_entities_filtered{area = {{c.mx - 3, c.my - 9}, {c.mx + 6, c.my + 5}},
    name = {"pipe", "pipe-to-ground", "chemical-plant"}}) do e.destroy() end
  local m = machine3(c.mx, c.my)
  -- 北面两只口在第 mx+0 与 mx+2 格（floor(3/2)=1，off = -1/+1）。这一发只用第 -1 格那一只：单口最好读。
  local col = c.mx
  local bp = (c.k == "E-byplayer") and game.players[1] or nil
  if c.k == "A-pipe" then
    one("pipe", col, c.my - 1, 0)
    one("pipe", col, c.my - 2, 0)
  else
    local nearDir, farDir = DIR_NORTH, DIR_SOUTH
    if c.k == "B-ptg-in" or c.k == "D-auto" or c.k == "E-byplayer" then nearDir, farDir = DIR_SOUTH, DIR_NORTH end
    one("pipe-to-ground", col, c.my - 1, nearDir, bp)
    one("pipe-to-ground", col, c.my - 5, farDir, bp)
    one("pipe", col, c.my - 6, 0, bp)
  end
  local g1, g2 = nil, nil
  -- 搜索盒按**整格**给（从前写 {col, my-6}..{col+1, my-1} 把贴机器那一格排除在外 —— 那只穿地管的
  -- 位置是 my-0.5，落在框外，于是 B 这一发其实也没调成对 API，标签却写着"成对"）
  for _, e in ipairs(s.find_entities_filtered{area = {{col, c.my - 6}, {col + 1, c.my}},
    name = {"pipe-to-ground"}}) do
    if e.position.y < c.my - 2 then g2 = e else g1 = e end
  end
  local linked = "没成对"
  if c.k == "D-auto" or c.k == "E-byplayer" then
    linked = "故意不调"
  elseif g1 and g2 then
    local okl = pcall(function() return g1.fluidbox.add_linked_connection(1, g2, 1) end)
    local okr = pcall(function() return g2.fluidbox.add_linked_connection(1, g1, 1) end)
    linked = "显式" .. tostring(okl) .. "/" .. tostring(okr)
  end
  local pick = nil
  for _, e in ipairs(s.find_entities_filtered{area = {{col, c.my - 7}, {col + 1, c.my - 1}},
    name = {"pipe"}}) do
    if not pick or e.position.y < pick.position.y then pick = e end
  end
  local wrote = "?"
  if pick then wrote = tostring(pcall(function() pick.fluidbox[1] = {name = "water", amount = 100} return true end)) end
  out[#out + 1] = string.format("%s 机器=%s 灌=%s 成对=%s 写=%s", c.k,
    m and string.format("%.1f,%.1f", m.position.x, m.position.y) or "无",
    pick and string.format("%.1f,%.1f", pick.position.x, pick.position.y) or "无", linked, wrote)
end
rcon.print(table.concat(out, "\\n"))`);
console.log("\n-- 摆出来的样子");
console.log(String(setup).split("\n").map((l) => "   " + l).join("\n"));

lua(`game.ticks_to_run = 900 rcon.print("ran")`);
sleep(9000);

const read = lua(`local s = game.surfaces["arch-lab"]
local out = {}
for _, c in ipairs(${LUA_CASES}) do
  local col = c.mx
  local m = s.find_entities_filtered{area = {{c.mx, c.my}, {c.mx + 3, c.my + 3}},
    name = {"chemical-plant"}, limit = 1}[1]
  local got, conns = {}, {}
  if m then
    local fb = m.fluidbox
    -- 活体 fluidbox 的长度是 #fb，没有 fb.count() 这个方法（写过一次，整条命令编译不过，
    -- 于是这一把尺一个字都没回，看着像"机器没摆上"）。模板串里也不许写反引号 —— 那是 JS 的边界。
    for i = 1, #fb do
      local b = fb[i]
      got[i] = b and (tostring(b.name) .. ":" .. tostring(b.amount) .. "/" .. tostring(fb.get_capacity(i))) or "空"
      local n = -1
      pcall(function() local l = fb.get_connections(i) n = l and #l or 0 end)
      conns[i] = n
    end
  else
    got[1] = "机器没了"
  end
  local near = s.find_entities_filtered{area = {{col, c.my - 1}, {col + 1, c.my}}, limit = 1}[1]
  local nb = "?"
  if near and near.fluidbox then pcall(function() local b = near.fluidbox[1] nb = b and tostring(b.name) or "干" end) end
  -- 两只穿地管自己的段号：同一个号 = 这一对成了；两个号 = 各走各的（水过不去）。
  local segs = {}
  -- 搜索盒要**盖住贴口那一格**：那只穿地管的位置是 my-0.5，把右边界写成 my-1 就正好把它关在框外
  -- （先前 D/E 两发只读回一根管子，"没配对"这个结论当时根本没证据）。整格给到 my+1 才两根都在。
  for _, e in ipairs(s.find_entities_filtered{area = {{col, c.my - 6}, {col + 1, c.my + 1}},
    name = {"pipe-to-ground"}}) do
    local sid = "?"
    pcall(function() sid = tostring(e.fluidbox.get_fluid_segment_id(1)) end)
    segs[#segs + 1] = string.format("%.0f,%s", e.position.y, sid)
  end
  out[#out + 1] = string.format("%s 箱体[%s] 连接数[%s] 贴口格=%s 湿=%s 柱内段[%s]",
    c.k, table.concat(got, " "), table.concat(conns, ","), near and near.name or "空", nb,
    table.concat(segs, " "))
end
rcon.print(table.concat(out, "\\n"))`);
console.log("\n-- 量到的（箱体里有 water = 这股真的进了机器）");
const lines = String(read).split("\n").filter((l) => /箱体/.test(l));
if (!lines.length) console.log("   读回来的原文：" + String(read).slice(0, 700));
for (const l of lines) console.log("   " + l);
const lineFor = (k) => lines.find((l) => l.startsWith(k));
const connsOf = (l) => { const m = /连接数\[(\d)/.exec(String(l)); return m ? Number(m[1]) : null; };
const wetCell = (l) => /湿=water/.test(String(l));
const cellOf = (l) => { const m = /贴口格=(\S+)/.exec(String(l)); return m ? m[1] : null; };
// 断言问的是**接不接得上**，不是"箱体里有没有水"：这台机器没设配方，箱体本来就空着（实测：连普通管
// 贴口那一发的箱体也是[空 空 空 空]，而贴口那格自己是湿的）。把"箱体空"读成"接不上"就是又一次
// 拿仪器读数的形状当引擎的说法。所以两份读数各归各：`连接数` 归"接没接"，`湿` 归"水到没到那一格"。
const A = lineFor("A-pipe"), B = lineFor("B-ptg-in"), C = lineFor("C-ptg-out");
check("基线 A：普通管贴口 —— 机器那一侧连接数 1，且贴口那一格是湿的",
  !!A && connsOf(A) === 1 && wetCell(A), A || "没读到 A 这一行");
check("这一问的答案 B：穿地管的地面接口朝机器贴在口上 —— 连接数也是 1（与普通管同一格）",
  !!B && connsOf(B) === 1 && cellOf(B) === "pipe-to-ground" && wetCell(B), B || "没读到 B 这一行");
check("水是从地底下送上来的：B 那发的远端管子灌了水，贴口那一格（穿地管自己）才是湿的",
  !!B && wetCell(B), B || "没读到 B 这一行");
check("反向对照 C：两只朝向反过来（地面接口背对机器）—— 连接数 0，那一格是干的",
  !!C && connsOf(C) === 0 && !wetCell(C), C || "没读到 C 这一行");
// 第二扇门那一问：不调 `add_linked_connection`、只按朝向与距离摆好的一对，引擎认不认（段号一样 = 认）。
// 这一问有两种失败方式，得分开：**脚本建的不配对**（那还有救：交付时显式连一手）与**谁建都不配对**
// （那这一手就进不了牌）。所以同一套摆法各建一遍：D 用脚本，E 以一个玩家的手（`by_player`）。
const D = lineFor("D-auto"), E = lineFor("E-byplayer");
const segsOf = (l) => { const m = /柱内段\[([^\]]*)\]/.exec(String(l)); return m ? m[1].trim().split(/\s+/) : []; };
const oneSeg = (l) => { const v = segsOf(l).map((x) => x.split(",")[1]); return v.length === 2 && v[0] === v[1]; };
const wetOf = (l) => { const m = /湿=(\S+)/.exec(String(l)); return m ? m[1] : "?"; };
console.log("  D（脚本建的一对，不调成对 API）: 段=" + segsOf(D).join(" ") + " 配对=" + oneSeg(D) + " 湿=" + wetOf(D));
console.log("  E（玩家的手建的一对，不调成对 API）: 段=" + segsOf(E).join(" ") + " 配对=" + oneSeg(E) + " 湿=" + wetOf(E));
check("两发都读回来了（每发两根穿地管各带一个段号）",
  !!D && !!E && segsOf(D).length === 2 && segsOf(E).length === 2,
  [D, E].join(" ||| ").slice(0, 400));
console.log("  两扇门都在：贴口的穿地管与机器的口算接上（连接数与普通管同为 1，反过来就不算）；"
  + "而一对穿地管摆好了就自己成对（D 脚本建的、E 玩家的手建的，每发两根都是同一个段号）。"
  + "这一条 2026-10-11 差点被我改口成\"不配对\"：那把尺的搜索盒右边界写在 my-1，正好把贴口那一格关在框外，"
  + "每发只读回一根管子 —— 一根管子的段号当然\"不重复\"。搜索盒与 names= 这两处仪器的坑都在这把尺上踩过，"
  + "结论要拿修好的尺重跑一遍才算数（现在就是重跑过的那一份）。");

console.log("\n-- 收尾：只清我自己摆的这三件，并把世界时钟解回来");
console.log("  " + lua(`game.tick_paused = false
local s = game.surfaces["arch-lab"]
local n = 0
for _, e in ipairs(s.find_entities_filtered{area = {{${X0 - 3}, ${Y0 - 9}}, {${X0 + 170}, ${Y0 + 5}}},
  name = {"pipe", "pipe-to-ground", "chemical-plant"}}) do e.destroy() n = n + 1 end
rcon.print("cleared " .. n .. " paused=" .. tostring(game.tick_paused))`));
check("世界时钟解开（这把探针不欠一条暂停的世界）",
  /false/.test(String(lua("rcon.print(tostring(game.tick_paused))"))), "game.tick_paused 读回不是 false");
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
