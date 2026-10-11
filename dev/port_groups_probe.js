// 2026-10-11 那一铲量到一件比"气体压不进"更根本的事：低温厂设上 sulfur **建起来之后**，运行时只有 2 只
// 进料箱体，而 `b1` 自己报告"我该站两格"（off −2 与 off 0），`b2` 只报告 off +2 那一格 —— 与原型
// （P1@−2、P2@0、P3@+2，各一格）**对不上**。牌是按原型一格一箱排的，于是两种液体落到同一只箱体上：
// 一只箱同一时刻只装一种液体，第二种永远进不去（灌 water 进、灌 petroleum-gas 200 或 4000 都不进）。
//
// 这一把不问台架、也不写代码，只把"**建起来的机器**自己怎么说"摊开，跨几台机器 × 几个配方：
//   运行时几只箱（`#fb`）、每只的原型 index、进还是出、容量、以及 `get_pipe_connections(i)` 交回的
//   **地面格**（那是权威：`ports.lua` 算面与格号走的就是它）—— 与 `ports.declared` 从原型推出的那份
//   并排打出来，才知道"并了几格"是这一台的个例、还是"配方用的进料箱数 < 原型声明的格数"的一般律。
// 为什么值得先量：修法只有两种，而它们决定于答案 —— 一般律成立就写成一式（便宜、静态就能算），
// 个例就得在建的时候读一次（那是 `fluid_slots` 那把部分尺的位置，上次当筛子用把覆盖率打到 241）。
//
// 工具坑（都是这一轮在这类尺上抓到的，写在这点）：过滤要 `name=`（`names=` 被引擎静默忽略）；
// 搜索盒按整格且要盖住被读那一格；`get_connections` 回的是**别人的 fluidbox**（要实体走 c.owner）；
// Lua 注释里不许写反引号（会截断 JS 模板串，`dev/lua_templates.py` 现在会点名报这个）。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("port_groups_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "60000" };
const lua = (src) => {
  try {
    return execFileSync("node", [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 300); }
};
const flat = (v, n) => String(v).replace(/\n/g, " ").slice(0, n || 1600);

// 机器 × 配方：都是"两种以上液体进"那一族（0.90.0/0.91.0 这一路在做的那些），加上一条只有一种液体进的
// 对照（润滑油：水 + …… 实际是固体+液体，看运行时给几只箱），以及炼油那条三种液体出的。
const PAIRS = process.env.PGP_PAIRS
  ? JSON.parse(process.env.PGP_PAIRS)
  : [["cryogenic-plant", "sulfur"], ["cryogenic-plant", "fluoroketone"],
    ["cryogenic-plant", "lithium"], ["chemical-plant", "sulfur"],
    ["chemical-plant", "lubricant"], ["oil-refinery", "advanced-oil-processing"],
    ["foundry", "battery"]];
const SURF = "arch-port-groups";

const asLuaList = (xs) => `{${xs.map((x) => `"${x}"`).join(",")}}`;
const RECIPES = PAIRS.map((p) => p[1]);
const MACHINES = [...new Set(PAIRS.map((p) => p[0]))];

// 借开这些配方与机器（照读回来的原值还；`rechart()` 是这一路的第三条口径 —— 光把技术置真，
// 引擎不跑"研究完成时解锁配方"那一步）。
const neededTechs = () => lua(`local want = {}
for _, n in ipairs(${asLuaList(RECIPES.concat(MACHINES))}) do want[n] = true end
local out = {}
for tname, t in pairs(prototypes.technology) do
  local ok, eff = pcall(function() return t.effects end)
  for _, e in ipairs((ok and eff) or {}) do
    if e.type == "unlock-recipe" and e.recipe and want[e.recipe] then out[tname] = true end
  end
end
local ks = {} for k in pairs(out) do ks[#ks + 1] = k end
table.sort(ks)
rcon.print(table.concat(ks, ","))`);
const TECHS = String(neededTechs()).split(/[,\s]+/).filter((x) => /^[a-z][a-z0-9_-]*$/.test(x));
const KEYS = TECHS.map((t) => "t:" + t).concat(RECIPES.concat(MACHINES).map((r) => "r:" + r));
const luaTable = (obj) => `{${Object.entries(obj).map(([k, v]) => `["${k}"]=${v ? "true" : "false"}`).join(",")}}`;
const readState = () => lua(`local f = game.forces.player
local out = {}
for _, n in ipairs(${asLuaList(TECHS)}) do
  local t = f.technologies[n]
  out[#out + 1] = "t:" .. n .. "=" .. tostring(t ~= nil and t.researched or false)
end
for _, n in ipairs(${asLuaList(RECIPES.concat(MACHINES))}) do
  local r = f.recipes[n]
  out[#out + 1] = "r:" .. n .. "=" .. tostring(r ~= nil and r.enabled or false)
end
rcon.print(table.concat(out, " "))`);
const writeState = (pairs) => lua(`local f = game.forces.player
local set = ${luaTable(pairs)}
for key, val in pairs(set) do
  local kind, name = key:sub(1, 1), key:sub(3)
  if kind == "t" then
    local t = f.technologies[name] if t then t.researched = val end
  else
    local r = f.recipes[name] if r then r.enabled = val end
  end
end
f.rechart()
rcon.print("ok")`);
const parseState = (line) => {
  const out = {};
  for (const tok of String(line).trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1) === "true";
  }
  return out;
};
const before = parseState(readState());
// 借窗口要能自己报空（§0 第十一条第 2 条），但**只报个数不报名字**的守卫没用：读回 18 项、期望 19 项，
// 我照样得再跑一遍才知道少了哪个名字。这里直接把差集打出来。
const missing = KEYS.filter((k) => !(k in before));
const extra = Object.keys(before).filter((k) => KEYS.indexOf(k) < 0);
if (missing.length || extra.length) {
  console.log(`FAIL  借窗口对不上：读到 ${Object.keys(before).length} 项 / 名单 ${KEYS.length} 项`
    + `\n  名单里没读到: ${missing.join(",") || "无"}\n  读到但不在名单: ${extra.join(",") || "无"}`
    + `\n  技术名单(${TECHS.length}): ${TECHS.join(",")}`);
  process.exit(1);
}
const grant = (on) => {
  const next = {};
  for (const k of Object.keys(before)) next[k] = on ? true : before[k];
  return writeState(next);
};

lua(`if not game.surfaces["${SURF}"] then
  local ok2, made = pcall(function() return game.create_surface("${SURF}") end)
  if ok2 and made then
    made.request_to_generate_chunks({0.5, 0.5}, 3) made.force_generate_chunk_requests()
  end
end
rcon.print(tostring(game.surfaces["${SURF}"] ~= nil))`);

grant(true);
try {
  // 一发一格：摆一台机器 → 设上配方 → 读它**自己**报的箱体与地面格。
  const out = lua(`local s = game.surfaces["${SURF}"]
if not s then rcon.print("NO_SURFACE") return end
local lines = {}
local i = 0
for _, pr in ipairs(${asLuaList(PAIRS.map((p) => p.join("|")))}) do
  i = i + 1
  local machine, recipe = pr:match("^(.-)|(.+)$")
  local proto = prototypes.entity[machine]
  local w, h = proto.tile_width or 1, proto.tile_height or 1
  -- 每台机器各占一片自己的地（负坐标 + 先热 chunk：can_place_entity/create 在未生成的地上会假失败）
  local cx, cy = i * 30 + 15.5, i * 30 + 15.5
  local m = s.create_entity({ name = machine, position = { cx, cy }, direction = 0,
    force = game.forces.player, raise_built = true })
  if not m then lines[#lines + 1] = pr .. " 建不起来"; goto continue end
  -- 设配方这一步**要把错因打出来**：上一版只打了 建方=false，七发全是 false，读起来像"这些配方都
  -- 不能上这几个机器"，而实际是设法不对（m.recipe = name 在 2.0 会拒）—— 那就是我这次量到的
  -- 最要紧的一件事：**没设配方的低温厂报 0 只箱体**（chemical-plant 没配方也报 4 只），
  -- 也就是"箱体由配方给"，原型那一侧根本推不出运行时几只、各站哪几格。
  -- **对照那一格**：设配方之前先读一次箱位数。上一版没有它，"低温厂报几只"这件事就没法定性 ——
  -- 到底是"这台机器没有箱体"，还是"箱体等配方来给"，两种说法要做的东西完全不同。
  local fb_before = m.fluidbox
  local before_n = #fb_before
  local set_ok, set_err = pcall(function() m.recipe = recipe end)
  if not set_ok then
    set_ok, set_err = pcall(function() m.set_recipe(recipe) end)
    if set_ok then set_err = "走 set_recipe 成了" end
  end
  local fb = m.fluidbox
  local one = { machine .. "+" .. recipe .. " 建方=" .. tostring(set_ok)
    .. "(" .. tostring(set_err):sub(1, 90) .. ") 空机几只=" .. before_n .. " 设配方后几只=" .. #fb
    .. "（原型声明 " .. #(proto.fluidbox_prototypes or {}) .. " 只）" }
  for bi = 1, #fb do
    local pbox = nil
    pcall(function() pbox = fb.get_prototype(bi) end)
    local cells = {}
    pcall(function()
      for _, pc in ipairs(fb.get_pipe_connections(bi) or {}) do
        local t = pc.target_position
        -- 格号换成"离机器中心沿面偏几格"，与牌上那一手同一个说法（off 沿面、depth 离面）
        local dx, dy = t.x - m.position.x, t.y - m.position.y
        local face, off
        if math.abs(dy) > math.abs(dx) then face = (dy > 0) and "south" or "north"; off = dx
        else face = (dx > 0) and "east" or "west"; off = dy end
        cells[#cells + 1] = string.format("%s/%+g", face, off)
      end
    end)
    local cap = "?"
    pcall(function() cap = tostring(fb.get_capacity(bi)) end)
    one[#one + 1] = "b" .. bi .. "[" .. tostring(pbox and pbox.production_type) .. " idx="
      .. tostring(pbox and pbox.index) .. " 容" .. cap .. "]" .. table.concat(cells, ",")
  end
  -- 原型那一侧：ports.declared 只取每只箱体的**第一**条 pipe_connections（conns[1]），这里把每条都数一遍，
  -- 才知道"这格是另一条接口"还是"运行时并了别只箱的格"。
  local decl = {}
  for bi = 1, #(proto.fluidbox_prototypes or {}) do
    local b = proto.fluidbox_prototypes[bi]
    local n = #(b.pipe_connections or {})
    local per = {}
    for ci = 1, n do
      local ps = b.pipe_connections[ci].positions or {}
      local p0 = ps[1]
      per[#per + 1] = p0 and (string.format("%+g,%+g", p0.x, p0.y)) or "?"
    end
    decl[#decl + 1] = "P" .. bi .. "×" .. n .. "[" .. table.concat(per, " ") .. "]"
  end
  one[#one + 1] = "原型:" .. table.concat(decl, " ")
  lines[#lines + 1] = table.concat(one, "  ")
  m.destroy()
  ::continue::
end
rcon.print(table.concat(lines, "\\n"))`);
  console.log("\n-- 建起来的机器自己怎么说（并排：运行时箱体 / 原型声明）");
  for (const l of String(out).split("\n")) {
    if (l.trim() && !/^OK$/.test(l.trim())) console.log("   " + l);
  }
} finally {
  console.log("  还回去: " + grant(false));
  console.log("  删图: " + lua(`if game.surfaces["${SURF}"] then pcall(function() game.delete_surface("${SURF}") end) end rcon.print("gone")`));
}
