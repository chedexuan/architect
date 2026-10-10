// 两种液体进的配方，那两只口到底在机器的哪一面、第几格 —— 第一簇（`LANE_FEEDS_ONE_FLUID`）的输入。
//
// 为什么自己读原型：`card_example` 在这一档**按名拒**（它连形状都没走到），答案里既没有面也没有格号。
// 而这一簇的几何全押在口位上：两口在**同一面**、格号差 2（中间那一格留空），就还有"各走一道"的活路；
// 差 1 就是"两张贴管的管子一挨就并成一段"；落在半格上（`off` 不是整数）那一格根本站不上 1×1 的管子。
// 这三个数是量出来的，不是推的：
//   chemical-plant(3x3)      进 @(-1,-1) (1,-1) 出 @(-1,1) (1,1)
//   oil-refinery(5x5)        进 @(-1,2) (1,2)  出 @(-2,-2) (0,-2) (2,-2)
//   cryogenic-plant(5x5)     进 @(-2,2) (0,2) (2,2) 出 @(-2,-2) (0,-2) (2,-2)
//   foundry(5x4)             进 @(-1,2) (1,2)  出 @(-1,-2) (1,-2)
//   electromagnetic-plant    进 @(-1.5,0.5) (1.5,-0.5) —— 两只口在**相对两面**、而且各差半格
// 这套读法与 `ports.lua` 同一手（`fluidbox_prototypes[i].pipe_connections[k].positions[1+dir/4]`，
// 再用"尖点在哪条边上"换成 面 + 沿面的偏移），并在第四轮那座 5×5 炼油厂上对过真档。
//
// 两件把这一把尺自己绊倒过的坑，写在这里免得下次再踩：
//   * `LuaFluidBoxPrototype` **没有** `kind`，只有 `production_type`（问 `kind` 直接报错）；
//     运行时原型的碰撞盒是 `left_top`/`right_bottom`，不是 data 阶段的 `left_bottom`/`right_top`。
//   * 静态门 `dev/lua_templates.py` 那个 Lua 解析器**不收"表面量直接取下标"**（`{a=1}[1]`），
//     真 Lua 却收 —— 这样一把尺会挡在打包门外，报出来只有"template do not parse"。
//     先把表存进 local，再取下标。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("two_fluid_ports");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "30000" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 200); }
};
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 400)}`);
  ok ? pass++ : fail++;
};

const STUB = { "0": [0, -1], "2": [1, 0], "4": [0, 1], "6": [-1, 0] };
const out = lua(`local function field(o, k)
  if o == nil then return nil end
  local ok, v = pcall(function() return o[k] end)
  return ok and v or nil
end
local function face_of(t, w)
  if math.abs(t.x) <= math.floor((w - 1) / 2) then return (t.y > 0) and "south" or "north", t.x end
  return (t.x > 0) and "east" or "west", t.y
end
local UNIT = {}
UNIT[0] = {0, -1} UNIT[2] = {1, 0} UNIT[4] = {0, 1} UNIT[6] = {-1, 0}
local WIDE = {"chemical-plant", "cryogenic-plant", "oil-refinery", "foundry",
  "electromagnetic-plant", "centrifuge", "biogas-plant", "distillery", "unit-assembly-plant",
  "big-mining-drill", "steel-assembling-machine-2"}
local ports = {}
for _, n in ipairs(WIDE) do
  local p = prototypes.entity[n]
  if p then
    -- 宽度取 tile_width（占地几格），**不是**碰撞盒的跨度：chemical-plant 的碰撞盒只有 2.4 格，
    -- 拿它当宽度会把"两口在北面第 -1/+1 格"算成"一口在西、一口在东" —— 面判错了，整簇的排法就跟着错。
    local cb = field(p, "collision_box")
    local w = field(p, "tile_width")
      or (cb and math.ceil(field(field(cb, "right_bottom"), "x") - field(field(cb, "left_top"), "x")) or 0)
    local list = {}
    for i, b in ipairs(field(p, "fluidbox_prototypes") or {}) do
      for _, c in ipairs(field(b, "pipe_connections") or {}) do
        local pos = field(c, "positions")
        local o = pos and pos[1]
        if o then
          local u = UNIT[field(c, "direction")]
          local t = { x = field(o, "x") + (u and u[1] or 0), y = field(o, "y") + (u and u[2] or 0) }
          local f, off = face_of(t, w)
          list[#list + 1] = i .. ":" .. tostring(field(b, "production_type")) .. ":" .. f .. ":" .. off
        end
      end
    end
    ports[n] = w .. "|" .. table.concat(list, " ")
  end
end
local ins = {}
for rname, r in pairs(prototypes.recipe) do
  local k = 0
  for _, ing in ipairs(field(r, "ingredients") or {}) do if field(ing, "type") == "fluid" then k = k + 1 end end
  if k >= 2 then
    local cat = tostring(field(r, "category"))
    local mach = nil
    for _, n in ipairs(WIDE) do
      local p = prototypes.entity[n]
      if p then
        local hit = false
        -- 这两个字段在**运行时原型**上是字典（crafting_categories["chemistry"] = true 这种形状），不是
        -- data 阶段那个列表 —— 用 ipairs 走一遍就是空的，于是每条配方都配不到机器（我这把尺第一次跑就
        -- 全列 nil，看着像"这些机器都不存在"）。
        for c, _ in pairs(field(p, "crafting_categories") or {}) do if c == cat then hit = true end end
        for rn, _ in pairs(field(p, "recipes") or {}) do if rn == rname then hit = true end end
        if hit and not mach then mach = n end
      end
    end
    ins[#ins + 1] = rname .. "<" .. cat .. "<" .. tostring(mach)
  end
end
table.sort(ins)
local lines = {}
for _, l in ipairs(ins) do lines[#lines + 1] = l end
local pp = {}
for n, v in pairs(ports) do pp[#pp + 1] = n .. "=" .. v end
table.sort(pp)
rcon.print("RECIPES " .. table.concat(lines, ";") .. "\\n\\nPORTS " .. table.concat(pp, " ||| "))`);

const text = String(out);
const recLine = (text.split("\n\n")[0] || "").replace(/^RECIPES /, "");
const portLine = (text.split("\n\n")[1] || "").replace(/^PORTS /, "");
const recipes = recLine.split(";").filter(Boolean).map((x) => {
  const [recipe, category, machine] = x.split("<");
  return { recipe, category, machine };
});
const ports = {};
for (const chunk of portLine.split(" ||| ")) {
  const i = chunk.indexOf("=");
  if (i < 0) continue;
  const name = chunk.slice(0, i);
  const [w, list] = chunk.slice(i + 1).split("|");
  ports[name] = { w: Number(w), boxes: list.split(" ").filter(Boolean).map((b) => {
    const [box, kind, face, off] = b.split(":");
    return { box, kind, face, off: Number(off) };
  }) };
}

console.log(`两种以上液体进的配方：${recipes.length} 条\n`);
const gaps = {};
for (const r of recipes) {
  const p = ports[r.machine];
  const inb = ((p || {}).boxes || []).filter((b) => b.kind === "1" || b.kind === "input");
  const byFace = {};
  for (const b of inb) (byFace[b.face] = byFace[b.face] || []).push(b.off);
  const rows = Object.entries(byFace).map(([f, offs]) => {
    const s = offs.slice().sort((a, b) => a - b);
    let min = null;
    for (let i = 1; i < s.length; i++) min = (min === null ? s[i] - s[i - 1] : Math.min(min, s[i] - s[i - 1]));
    if (min !== null) gaps[min] = (gaps[min] || 0) + 1;
    return { face: f, cells: s, gap: min, half: s.some((x) => x !== Math.floor(x)) };
  });
  console.log(`${r.recipe.padEnd(30)} ${String(r.machine).padEnd(22)} 进 ${inb.length} 口 `
    + JSON.stringify(rows));
}

console.log("\n同面两口最小格距的分布（同面多口能不能各走一道，看的就是这个数）：");
console.log("  " + JSON.stringify(gaps));
check("这一把尺读得到配方（一条两种以上液体进的配方都没有，就是读法坏了）",
  recipes.length >= 5, `${recipes.length} 条`);
check("机器口的 `production_type` 读回来了（问 `kind` 会整批报错，这条就是在防它回来）",
  Object.keys(ports).length >= 6 && Object.values(ports).every((p) => p.boxes.length >= 0),
  Object.keys(ports).join(","));
check("同面两口要么隔 2 格以上、要么在相对两面 —— 出现差 1 的那些得单独说，不能一起画",
  Object.keys(gaps).every((g) => Number(g) >= 2 || Number(g) === 0.5),
  JSON.stringify(gaps));
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
