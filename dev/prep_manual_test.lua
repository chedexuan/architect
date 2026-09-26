-- Prep the test world for a human sitting down to try the panel.
--
-- Everything here is done through the engine's own calls (this is the rcon console state, so
-- `prototypes` is reached as `game.*_prototypes`), and every item name is checked before it is handed
-- out: a list like this rots when a modpack renames something, and a chest that silently arrives with
-- 37 slots filled instead of 40 is a worse surprise than one that says which name was missing.

@@ tech_and_map
local f = game.forces.player
local before = 0
for _, t in pairs(f.technologies) do if t.researched then before = before + 1 end end
local ok, err = pcall(function() f.research_all_technologies() end)
-- 8 recipes stay locked after research-all on this build (the loaders, pistol, heat-interface and the
-- two map-gen-only infinity items): the call walks the tech tree, and those are not reachable that way
-- here. `recipe.enabled` is real state -- unlike setting a technology's `researched` flag, which is the
-- lesson this save already learned the hard way -- so unlocking them directly actually unlocks them.
local unlocked = 0
for _, r in pairs(f.recipes) do
  if r.enabled == false then
    r.enabled = true
    unlocked = unlocked + 1
  end
end
local after = 0
for _, t in pairs(f.technologies) do if t.researched then after = after + 1 end end
local s = game.surfaces[1]
local sp = f.get_spawn_position(s)
s.request_to_generate_chunks({ sp.x, sp.y }, 12)
s.force_generate_chunk_requests()
f.chart_all(s)
rcon.print(string.format("techs %d -> %d (all ok=%s), 另开 %d 个锁着的配方; spawn %d,%d 区块已生成并揭开\n",
  before, after, tostring(ok), unlocked, sp.x, sp.y))

@@ clear_pad
local f = game.forces.player
local s = game.surfaces[1]
local sp = f.get_spawn_position(s)  -- 2.0: on the FORCE, not the surface
local area = { left_top = { x = sp.x - 40, y = sp.y - 12 }, right_bottom = { x = sp.x + 60, y = sp.y + 40 } }
local gone = 0
for _, e in ipairs(s.find_entities_filtered { area = area,
  type = { "tree", "rock", "simple-entity", "dead-reef", "fish", "unit" } }) do
  e.destroy(); gone = gone + 1
end
local ores = {}
for _, e in ipairs(s.find_entities_filtered { area = area, type = "resource" }) do
  ores[e.name] = (ores[e.name] or 0) + 1
end
local parts = {}
for k, v in pairs(ores) do parts[#parts + 1] = k .. "=" .. v end
table.sort(parts)
rcon.print("cleared " .. gone .. " scenery entities; ore left in the pad: " .. table.concat(parts, ", ") .. "\n")

@@ material_chests
local f = game.forces.player
local s = game.surfaces[1]
local sp = f.get_spawn_position(s)
local GROUPS = {
  { "A1 带与分流", { "transport-belt", "fast-transport-belt", "express-transport-belt", "turbo-transport-belt",
    "underground-belt", "fast-underground-belt", "express-underground-belt", "turbo-underground-belt",
    "splitter", "fast-splitter", "express-splitter", "turbo-splitter" } },
  { "A2 机械臂与箱", { "burner-inserter", "inserter", "long-handed-inserter", "fast-inserter", "filter-inserter",
    "stack-inserter", "stack-filter-inserter", "loader", "fast-loader", "express-loader", "turbo-loader",
    "wooden-chest", "iron-chest", "steel-chest" } },
  { "B1 组装与熔炼", { "assembling-machine-1", "assembling-machine-2", "assembling-machine-3",
    "foundry", "centrifuge", "chemical-plant", "oil-refinery", "biomechanical-machine", "crusher",
    "stone-furnace", "steel-furnace", "electric-furnace", "lab", "radar", "lamp" } },
  { "B2 采矿与电", { "burner-mining-drill", "electric-mining-drill", "big-mining-drill", "pumpjack",
    "small-electric-pole", "medium-electric-pole", "big-electric-pole", "substation",
    "solar-panel", "accumulator", "boiler", "steam-engine", "steam-turbine", "nuclear-reactor",
    "heat-pipe", "heat-interface" } },
  { "C1 管与桶", { "pipe", "pipe-to-ground", "pump", "offshore-pump", "storage-tank", "empty-barrel",
    "water-barrel", "crude-oil-barrel", "light-oil-barrel", "heavy-oil-barrel", "petroleum-gas-barrel",
    "sulfuric-acid-barrel", "lubricant-barrel" } },
  { "C2 料与模组", { "iron-ore", "copper-ore", "coal", "stone", "iron-plate", "copper-plate", "steel-plate",
    "battery", "engine-unit", "automation-science-pack", "logistic-science-pack", "chemical-science-pack",
    "speed-module", "speed-module-2", "speed-module-3", "efficiency-module", "efficiency-module-2",
    "efficiency-module-3", "productivity-module", "productivity-module-2", "productivity-module-3" } },
}
local report, gone_name = {}, {}
for gi, g in ipairs(GROUPS) do
  -- two rows of three so a chest is never more than a click from the spawn pad
  local at = { x = sp.x - 8 + ((gi - 1) % 3) * 4, y = sp.y + 5 + math.floor((gi - 1) / 3) * 4 }
  for _, e in ipairs(s.find_entities_filtered { position = at, radius = 1.6 }) do
    if e.name ~= "character" and e.name ~= "player" then e.destroy() end
  end
  local box = s.create_entity { name = "steel-chest", position = at, force = "player" }
  if box then
    box.destructible = false
    box.minable = false
    local tagged = pcall(function() box.name_tag = g[1] end)
    local reads = nil
    pcall(function() reads = box.name_tag end)
    local inv = box.get_inventory(defines.inventory.chest)
    local put, full, skipped = 0, {}, {}
    for _, item in ipairs(g[2]) do
      local proto = prototypes.item[item]
      if not proto then
        skipped[#skipped + 1] = item
      else
        -- Two stacks each rather than a flat 500: a steel chest is 40 slots, and 500 of a
        -- hundred-stack item eats a quarter of it, so the flat number fills the box after a dozen
        -- kinds and everything after that is reported as missing while it was only crowded out.
        local want = math.max(1, (proto.stack_size or 1) * 2)
        local n = inv.insert { name = item, count = want }
        if n and n > 0 then put = put + 1 else full[#full + 1] = item end
      end
    end
    report[#report + 1] = string.format("%s @%d,%d：%d/%d 种放进去%s%s",
      g[1], at.x, at.y, put, #g[2],
      (#full > 0 and ("，装不下: " .. table.concat(full, ", ")) or ""),
      (tagged and reads == g[1]) and ("，箱子标签写成「" .. tostring(reads) .. "」")
        or "，箱子标签写不上（用位置认）")
    if #skipped > 0 then gone_name[#gone_name + 1] = g[1] .. " 没有这些名字: " .. table.concat(skipped, ", ") end
  else
    report[#report + 1] = g[1] .. "：放不下箱子"
  end
end
rcon.print(table.concat(report, "\n") .. "\n")
if #gone_name > 0 then rcon.print(table.concat(gone_name, "\n") .. "\n") end
rcon.print("玩家数=" .. (function() local n = 0 for _ in pairs(game.players) do n = n + 1 end return n end)()
  .. " —— 人没连上就没有角色，背包只能等你进来再填；进来说一句就行。\n")

-- ---------------------------------------------------------------- 人来了之后该做的事
--
-- 填包是一个挂在全局上的函数（`__arch_fill`），由 `@@ fill_now` 在人进来之后当场调一次。
-- 不要在这里注册任何 `script.on_event`：控制台代码属于 `__level__` 状态，注册会让服务端多出一份客户端
-- 没有的处理器表，客户端进门直接被拒（弹窗里的 mod 名会写成 `level`）。原因写在 `@@ fill_now` 头上。

@@ pack_fn
-- 只给名字，不给数字：每样给几"叠"，叠多大问引擎。1.1 记下来的 stack size 在这一版有好几个对不上，
-- 而一个装不下的数字只会以"少了两样"的形式回来烦人。
__arch_give = {
  { "transport-belt", 2 }, { "fast-transport-belt", 2 }, { "express-transport-belt", 2 },
  { "underground-belt", 2 }, { "fast-underground-belt", 2 },
  { "splitter", 1 }, { "fast-splitter", 1 },
  { "inserter", 2 }, { "long-handed-inserter", 2 }, { "fast-inserter", 1 },
  { "stack-inserter", 1 }, { "bulk-inserter", 1 }, { "burner-inserter", 1 },
  { "steel-chest", 2 }, { "pipe", 2 }, { "pipe-to-ground", 2 },
  { "small-electric-pole", 2 }, { "medium-electric-pole", 1 }, { "substation", 1 },
  { "assembling-machine-2", 2 }, { "assembling-machine-3", 1 },
  { "electric-furnace", 2 }, { "foundry", 1 },
  { "roboport", 1 }, { "construction-robot", 1 },
  { "accumulator", 1 }, { "solar-panel", 1 },
  { "electric-mining-drill", 2 }, { "burner-mining-drill", 1 },
  { "speed-module-3", 1 }, { "productivity-module-3", 1 }, { "effectivity-module-3", 1 },
  { "blueprint", 1 }, { "deconstruction-plan", 1 },
}
-- 名字先对一遍再等人：这一版把 filter-inserter 一类的名字换掉了，列表里留着旧名不会报错，
-- 只会让人以为"给了"。当场问引擎，缺什么当场说。
for _, g in ipairs(__arch_give) do
  if not prototypes.item[g[1]] then g[4] = "MISSING" end
end
local SLOTS = 60   -- 2.0 的角色背包没有背包升级可买，直接把格子撑开是唯一那条路（LuaInventory.resize）

__arch_fill = function(who)
  local p = who or (function() for _, q in pairs(game.players) do if q.connected then return q end end end)()
  if not p then return "no-player" end
  -- 权限先给：这台服的 allow_commands 是 admins-only，不是管理员就连 /arch 都敲不动
  local was_admin = p.admin
  p.admin = true
  pcall(function() p.enable_flashlight() end)  -- 夜里测东西看得见，不占背包也不花钱
  local inv = p.get_inventory(defines.inventory.character_main)
  if not inv then return "no-character-yet" end
  if inv.get_item_count("blueprint") > 0 or inv.get_item_count("steel-chest") > 0 then
    return "already"
  end
  if #inv < SLOTS then pcall(function() inv.resize(SLOTS) end) end
  local put, missing, crowded = {}, {}, {}
  local failed = {}
  for _, g in ipairs(__arch_give) do
    local name, stacks = g[1], g[2]
    local proto = prototypes.item[name]
    if not proto then
      missing[#missing + 1] = name
    else
      local size = math.max(1, proto.stack_size or 1)
      local got = 0
      for _ = 1, stacks do
        -- insert 塞多少算多少，返回值就是进去的那部分：所以"没塞满"要当成"包满了"，
        -- 而不是把这一样当成失败 —— 一半的带子也比没有的带子有用。
        local n = inv.insert { name = name, count = size }
        got = got + (n or 0)
        if not n or n < size then
          if not failed[name] then failed[name] = true; crowded[#crowded + 1] = name end
          break
        end
      end
      if got > 0 then put[#put + 1] = name .. "x" .. got end
    end
  end
  -- 快捷栏按槽位认：槽 1..N 就是刚才塞进去的顺序。这一版每页 10 格（文档：11 是第二页第一格），
  -- 所以背包槽号直接当快捷栏格号用。判据是回读，不是调用成功 —— 1.1 的 (index, stack) 参数顺序在
  -- 这一版是反的（`set_quick_bar_slot(filter, index)`），顺序错了不报错，只会安静地什么也没排上。
  local bar = 0
  for i = 1, math.min(#inv, 20) do
    local st = inv[i]
    if st and st.valid_for_read then
      local back
      local okr = pcall(function()
        p.set_quick_bar_slot({ name = st.name }, i)
        local raw = p.get_quick_bar_slot(i)
        back = type(raw) == "string" and raw or (type(raw) == "table" and raw.name or nil)
      end)
      if okr and back == st.name then bar = bar + 1 end
    end
  end
  p.print(string.format(
    "背包好了：%d 样 %d 格（快捷栏排上 %d 个%s）。\n"
    .. "材料箱在出生点南边两排共 6 个，箱子上有标签；科技全开、地图已揭开；面板是 /arch。\n"
    .. "版本：mod 0.56.0 / 游戏 2.0.77。%s",
    #put, #inv, bar, (#crowded > 0 and "，装不下 " .. table.concat(crowded, ",") or ""),
    (#missing > 0 and ("这一版没有这些名字: " .. table.concat(missing, ", ") .. "\n") or "")))
  return string.format("admin %s->true, %d 样进包 (背包 %d 格), 快捷栏 %d, 挤掉 %d, 无此物 %d",
    tostring(was_admin), #put, #inv, bar, #crowded, #missing)
end
rcon.print("__arch_fill 已挂上全局: " .. type(__arch_fill))

@@ fill_now
-- 这里曾经注册过 `on_player_created / on_player_joined_game / on_player_changed_position` 三个钩子，
-- 想让人一进门就自动填包。实测把它删掉了，原因是它对客户端进门是致命的：
--
-- 控制台（rcon `/c`）跑的代码属于 `__level__` 这个脚本状态（存档里那 48 字节的 `control.lua` 就是它，
-- 加载日志写着 `Checksum for script __level__/control.lua`）。从控制台注册事件 = 服务端多出一份客户端
-- 没有的处理器表，2.0.77 的进门检查会当场拒绝，弹窗原文"以下模组的事件处理程序与服务器端不一致"，
-- 而列出的名字就是 `level` —— 看着像一个叫 level 的 mod，实际是 `__level__` 去掉下划线。
-- `script.on_event(e, nil)` 摘不干净（摘完再连仍然被拒），所以只能重启回干净状态，并且不再注册。
--
-- 于是填包退回"人已经在里面了，当场调一次"：只调 API、不注册事件，就不会动那份指纹。
local n = 0
for _ in pairs(game.players) do n = n + 1 end
if n == 0 then
  rcon.print("还没有人进来（填包要等人进来之后再跑这一块）")
else
  rcon.print("当场填: " .. tostring(__arch_fill()))
end
