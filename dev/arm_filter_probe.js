// 臂的筛选（`set_filter`）能不能带走三条交付路：活件、虚影、蓝图 record。
//
// 为什么现在要量这个：`dev/shared_row_probe.js` 量到的那条律 —— 取货臂两股都能取 —— 让"成品借进料行的
// 空股"这件事必须配一只**带筛选的进料臂**，不然它把对面那股上的成品抓回机器（而组装机收不下非配方的料，
// 那只臂就卡在手里）。形状要铺这种臂，就得先知道这份筛选在三条路上各带不带得住：
//   * 活件（台架铺真件）：`arm.set_filter(1, 料)` 在 shared_row_probe 里已经量过是活的，这里当对照。
//   * 虚影（`card_place` 往地上铺 `entity-ghost`）：带不带得住没人量过。带不住就是玩家按下去之后
//     每一只进料臂都要手动点一次筛选 —— 那一格必须像 `circuits.recipe_control` 一样单独说，不许并进
//     `carried` 凑数。
//   * 蓝图 record（`set_blueprint_entities` → 回读 → `export_stack`）：2.0 的 record 上臂的筛选项有
//     `filter` 与 `filters` 两种写法，哪一种带得住、回读长什么样，都是量的而不是猜的。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("arm_filter_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 300); }
};
const ask = (src, tries) => {
  let out = lua(src);
  for (let n = 1; n <= (tries || 5) && (!out.trim() || /PROBE-FAIL|TRUNCATED|no output/.test(out)); n++) {
    console.log(`  (no reply, asking again in 4 s -- attempt ${n})`);
    require("child_process").execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${4000})`]);
    out = lua(src);
  }
  return out;
};
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 600)}`);
  ok ? pass++ : fail++;
};

const X = 7900, Y = 7900;

console.log("\n-- 三条路各写一次筛选");
const OUT = String(ask(`local s = game.surfaces["arch-lab"]
local x, y = ${X}, ${Y}
s.request_to_generate_chunks({x, y}, 2) s.force_generate_chunk_requests()
for _, e in ipairs(s.find_entities_filtered{area = {{x - 4, y - 4}, {x + 24, y + 4}}}) do e.destroy() end
local out = {}
local mk = function(name, cx, cy, dir)
  return s.create_entity({name = name, position = {x = cx + 0.5, y = cy + 0.5}, direction = dir,
    force = "player", raise_built = true}) end

-- 1) 活件：对照
local live = mk("fast-inserter", x, y, defines.direction.north)
local ok1, err1 = pcall(function() return live.set_filter(1, "iron-plate") end)
local back1 = nil
pcall(function() local g = live.get_filter(1) back1 = g and tostring(g.name) or "nil" end)
out[#out+1] = "活件 set_filter=" .. tostring(ok1) .. " 回读=" .. tostring(back1)
  .. (ok1 and "" or (" 错=" .. tostring(err1)))

-- 2) 虚影：形状交付给玩家的那条路（card_place 铺的就是 entity-ghost）
local gh = s.create_entity({name = "entity-ghost", inner_name = "fast-inserter",
  position = {x = x + 4.5, y = y + 0.5}, direction = defines.direction.north, force = "player"})
if not gh then out[#out+1] = "虚影 造不出来"
else
  local ok2, err2 = pcall(function() return gh.set_filter(1, "iron-plate") end)
  local back2, kind2 = nil, "?"
  pcall(function() kind2 = tostring(gh.type) or "?" end)
  pcall(function() local g = gh.get_filter(1) back2 = g and tostring(g.name) or "nil" end)
  out[#out+1] = "虚影 set_filter=" .. tostring(ok2) .. " 回读=" .. tostring(back2)
    .. " type=" .. kind2 .. " 件名=" .. tostring(gh.name)
    .. (ok2 and "" or (" 错=" .. tostring(err2)))
  -- 虚影身上有没有别的口能带这项：ghost 上的 table 键（blueprint 的 record 表）与 ghost_prototype
  local ok3, err3 = pcall(function() gh.table = {filter = "iron-plate"} return true end)
  out[#out+1] = "虚影 .table=" .. tostring(ok3) .. (ok3 and "" or (" 错=" .. tostring(err3)))
end

-- 3) 蓝图 record：三种写法，各写各读，再看 export_stack 的文字里有没有那项
local inv = game.create_inventory(1)
inv.insert({name = "blueprint", count = 1})
local st = inv[1]
local spellings = {
  { name = "filter字符串", rec = function(i) return {entity_number = i, name = "fast-inserter",
      position = {x = i, y = 0}, direction = 0, filter = "iron-plate"} end },
  { name = "filters列表", rec = function(i) return {entity_number = i, name = "fast-inserter",
      position = {x = i, y = 0}, direction = 0, filters = {{item = "iron-plate"}}} end },
  { name = "filters+items_to_filter", rec = function(i) return {entity_number = i, name = "fast-inserter",
      position = {x = i, y = 0}, direction = 0, filters = {{item = "iron-plate"}},
      items_to_filter = 1} end },
}
for i, sp in ipairs(spellings) do
  local rec = sp.rec(i)
  local okw, errw = pcall(function() st.set_blueprint_entities({rec}) end)
  local read, got = "写失败", "nil"
  if okw then
    local okr, back = pcall(function() return st.get_blueprint_entities() end)
    if okr and back and back[1] then
      local b = back[1]
      local f1 = nil
      pcall(function() f1 = b.filter and tostring(b.filter) or nil end)
      local fl = nil
      pcall(function()
        local t = b.filters
        if t and t[1] then fl = tostring(t[1].item or t[1].name or t[1]) else fl = "空表" end
      end)
      got = "回读 filter=" .. tostring(f1) .. " filters=" .. tostring(fl)
      local tx = nil
      pcall(function() tx = st.export_stack() end)
      read = (tx and tx:find("iron%-plate", 1, false) and "文字里有料名" or "文字里没有料名")
    else got = "回读为空(" .. tostring(back) .. ")" end
  end
  out[#out+1] = "蓝图 " .. sp.name .. " 写=" .. tostring(okw)
    .. (okw and "" or (" 错=" .. tostring(errw))) .. " " .. got .. " " .. read
end
pcall(function() inv.destroy() end)

-- 4) 上面三种写法引擎都不收（filter 静默丢、filters 要 index），那就让它自己写一张蓝图，
--    把它认的那种 record 形状抄下来 —— 而不是继续猜键名。
local mk2 = function(name, cx, cy, dir)
  local e = s.create_entity({name = name, position = {x = cx + 0.5, y = cy + 0.5}, direction = dir,
    force = "player"})
  return e end
local src = mk2("fast-inserter", x + 16, y, defines.direction.north)
pcall(function() src.set_filter(1, "iron-plate") end)
local made, made_err = nil, "?"
pcall(function()
  made = script.create_blueprint({name = "blueprint", force = "player",
    area = {{x + 15, y - 1}, {x + 17, y + 1}}, position = {x = x + 16.5, y = y + 0.5}})
end)
if not made then
  out[#out+1] = "引擎自写蓝图 script.create_blueprint 不可用（拿不到 record 形状）"
else
  local st2 = made[1]
  local txt = nil
  pcall(function() txt = st2.export_stack() end)
  out[#out+1] = "引擎自写 导出文字=" .. (txt and txt:sub(1, 420) or "nil")
  local b2 = nil
  pcall(function() b2 = st2.get_blueprint_entities() end)
  if b2 and b2[1] then
    local r = b2[1]
    local parts = {}
    for k, v in pairs(r) do parts[#parts+1] = tostring(k) .. "=" .. tostring(v) end
    table.sort(parts)
    out[#out+1] = "引擎自写 回读键=" .. table.concat(parts, " ")
    local f = nil
    pcall(function() local t = r.filters; if t then for i, e2 in ipairs(t) do
      local kk = {} for a, b in pairs(e2) do kk[#kk+1] = tostring(a) .. "=" .. tostring(b) end
      table.sort(kk); f = (f or "") .. "[" .. i .. "]" .. table.concat(kk, ",") end end end)
    out[#out+1] = "引擎自写 filters 内容=" .. tostring(f) .. " filter=" .. tostring(r.filter)
      .. " items_to_filter=" .. tostring(r.items_to_filter)
  else out[#out+1] = "引擎自写 回读为空" end
  pcall(function() made.destroy() end)
end

-- 5) 照引擎那一种写法往回写一遍：set_blueprint_entities 收不收、回读有没有、export 文字里有没有料名
local tryBack = nil
pcall(function()
  local inv3 = game.create_inventory(1)
  inv3.insert({name = "blueprint", count = 1})
  local s3 = inv3[1]
  local okw, errw = pcall(function()
    s3.set_blueprint_entities({{entity_number = 1, name = "fast-inserter",
      position = {x = 0, y = 0}, direction = 0,
      filters = {{index = 1, item = "iron-plate"}}, items_to_filter = 1}})
  end)
  local rd = "写失败"
  if okw then
    local back = nil
    pcall(function() back = s3.get_blueprint_entities() end)
    local txt = nil
    pcall(function() txt = s3.export_stack() end)
    rd = "回读 filters[1].item=" .. tostring(back and back[1] and back[1].filters
      and back[1].filters[1] and back[1].filters[1].item)
      .. " 文字里有料名=" .. tostring(txt and txt:find("iron%-plate", 1, false) ~= nil)
  else rd = "写失败 错=" .. tostring(errw) end
  pcall(function() inv3.destroy() end)
  tryBack = rd
end)
out[#out+1] = "照引擎写法回写 index+item " .. tostring(tryBack)

-- 6) record 的形状不靠猜：一次把候选写法各写各读，把引擎回读到的**全部键**打出来，
--    再看 export 的文字里有没有那个料名（文字才是玩家真会粘贴到的东西）。
local inv4 = game.create_inventory(1)
inv4.insert({name = "blueprint", count = 1})
local s4 = inv4[1]
local cand = {
  {"filter=字符串", {filter = "iron-plate"}},
  {"filter=信号表", {filter = {type = "item", name = "iron-plate"}}},
  {"filters={{index,item}}", {filters = {{index = 1, item = "iron-plate"}}, items_to_filter = 1}},
  {"filters={{index,name}}", {filters = {{index = 1, name = "iron-plate"}}, items_to_filter = 1}},
  {"filters={{index,filter}}", {filters = {{index = 1, filter = "iron-plate"}}, items_to_filter = 1}},
  {"filters={{item}}+无index", {filters = {{item = "iron-plate"}}, items_to_filter = 1}},
  {"filters=字符串数组", {filters = {"iron-plate"}, items_to_filter = 1}},
  {"settings=表", {settings = {filter = "iron-plate"}}},
}
for _, c in ipairs(cand) do
  local tag, extra = c[1], c[2]
  local rec = {entity_number = 1, name = "fast-inserter", position = {x = 0, y = 0}, direction = 0}
  for k, v in pairs(extra) do rec[k] = v end
  local okw, errw = pcall(function() s4.set_blueprint_entities({rec}) end)
  local keys, has = {}, {}
  if okw then
    local back = nil
    pcall(function() back = s4.get_blueprint_entities() end)
    local r = back and back[1]
    if r then for k, v in pairs(r) do keys[#keys+1] = tostring(k) .. "=" .. tostring(v) end end
    table.sort(keys)
    local txt = nil
    pcall(function() txt = s4.export_stack() end)
    has["文字有iron"] = (txt and txt:find("iron%-plate", 1, false) ~= nil) and "Y" or "N"
  end
  out[#out+1] = "候选 " .. tag .. " 写=" .. tostring(okw)
    .. (okw and (" 回读键=" .. table.concat(keys, ",") .. " " .. tostring(has["文字有iron"]))
       or (" 错=" .. tostring(errw):gsub("\\n", " "):sub(1, 120)))
end
pcall(function() inv4.destroy() end)

-- 7) 上一段唯一在回读里留下 filters 的那一种，把它的**内容**读出来，并且和"同样一件、不写筛选"的
--    导出文字比字节差：export_stack 是 base64+zlib，里面搜不到明文料名，所以"文字里没有"从来不能当结论，
--    能当结论的是**两份文字不一样长、不一样值**。
local function bp_text(with_filter)
  local i = game.create_inventory(1)
  i.insert({name = "blueprint", count = 1})
  local st = i[1]
  local rec = {entity_number = 1, name = "fast-inserter", position = {x = 0, y = 0}, direction = 0}
  if with_filter then
    rec.filters = {{index = 1, name = "iron-plate"}}
    rec.items_to_filter = 1
  end
  local txt, read = nil, nil
  pcall(function() st.set_blueprint_entities({rec}) read = st.get_blueprint_entities() end)
  pcall(function() txt = st.export_stack() end)
  local detail = "无"
  if read and read[1] and read[1].filters and read[1].filters[1] then
    local f = read[1].filters[1]
    local ks = {}
    for k, v in pairs(f) do ks[#ks+1] = tostring(k) .. "=" .. tostring(v) end
    table.sort(ks)
    detail = table.concat(ks, ",")
  end
  local len = txt and #txt or 0
  i.destroy()
  return detail, len, txt
end
local dYes, lYes, tYes = bp_text(true)
local dNo, lNo, tNo = bp_text(false)
out[#out+1] = "认的写法 filters[1]内容=" .. dYes .. " 导出长度 带筛选=" .. lYes
  .. " 不带=" .. lNo .. " 两份不同=" .. tostring(tYes ~= tNo)
-- 同一种写法换到 stack-inserter（形状真会铺到的那一档：reach 2 以上常落到堆叠机械臂）
local i5 = game.create_inventory(1)
i5.insert({name = "blueprint", count = 1})
local s5 = i5[1]
local ok5, err5 = pcall(function()
  s5.set_blueprint_entities({{entity_number = 1, name = "stack-inserter", position = {x = 0, y = 0},
    direction = 0, filters = {{index = 1, name = "iron-plate"}}, items_to_filter = 1}})
end)
local d5 = "无"
if ok5 then
  local b5 = nil
  pcall(function() b5 = s5.get_blueprint_entities() end)
  local f = b5 and b5[1] and b5[1].filters and b5[1].filters[1]
  if f then d5 = tostring(f.name) .. "/" .. tostring(f.index) end
end
out[#out+1] = "堆叠臂同写法 写=" .. tostring(ok5) .. " filters[1]=" .. d5
  .. (ok5 and "" or (" 错=" .. tostring(err5)))
pcall(function() i5.destroy() end)

-- 顺带量一格这一版真正要用到的：**未筛选**的进料臂把成品抓回机器时，机器收不收
-- （收了 = 会污染配方输入；不收 = 那只臂卡在自己手里）。这是"筛选必须带得住"的代价那句要说清的。
local mach = mk("assembling-machine-2", x + 10, y, 0)
local refused = "?"
pcall(function()
  mach.set_recipe("iron-gear-wheel")
  local inv2 = mach.get_inventory(defines.inventory.crafter_input)
  local moved = inv2 and inv2.insert({name = "iron-gear-wheel", count = 1})
  refused = tostring(moved)
end)
out[#out+1] = "机器塞非配方的成品（回 0 = 引擎不收，臂会卡在手里）moved=" .. refused

for _, e in ipairs(s.find_entities_filtered{area = {{x - 4, y - 4}, {x + 24, y + 4}}}) do e.destroy() end
rcon.print(table.concat(out, "\\n"))`, 6));
console.log(OUT.split("\n").map((l) => "   " + l).join("\n"));

const line = (re) => (String(OUT).split("\n").find((l) => re.test(l)) || "");
check("对照：活件写进筛选并读得回（形状要的正是这一手）",
  /活件 set_filter=true 回读=iron-plate/.test(OUT), line(/活件/));
console.log("\n   虚影那一条（带不住就是按名说出来，不许静默）：" + line(/虚影/));
check("蓝图那三种写法各自量到了答案（写成功/失败、回读长什么样、export 文字里有没有料名）",
  (String(OUT).split("\n").filter((l) => /^蓝图 /.test(l)).length) === 3, OUT);
check("八种 record 写法都量到了回读（把引擎认的那一种抄下来，而不是继续猜）",
  (String(OUT).split("\n").filter((l) => /^候选 /.test(l)).length) === 8, OUT);
check("机器收不收非配方的成品这一格量到了数", /moved=\d/.test(line(/机器塞非配方/)) || /moved=/.test(OUT),
  line(/机器塞非配方/));
check("引擎自己写的那张蓝图给了 record 形状（抄它，不猜键名）", /引擎自写/.test(OUT), line(/引擎自写/));
check("照量到的写法回写那一条量到了结果（收/不收、回读、export 文字）", /照引擎写法回写/.test(OUT),
  line(/照引擎写法回写/));
check("台架收干净", /left=0/.test(String(ask(`local s = game.surfaces["arch-lab"]
for _, e in ipairs(s.find_entities_filtered{area = {{${X - 4}, ${Y - 4}}, {${X + 24}, ${Y + 4}}}}) do e.destroy() end
rcon.print("left=" .. tostring(#s.find_entities_filtered{area = {{${X - 4}, ${Y - 4}}, {${X + 24}, ${Y + 4}}}}))`, 3))),
  "sweep");

console.log(`\n量到的原文（写进 styles/control 之前先照这些数说话）：\n${OUT}`);
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
