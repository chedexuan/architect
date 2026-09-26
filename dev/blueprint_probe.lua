-- Can script author a blueprint item, with no player and no mouse?
--
-- THE ANSWER, left here so nobody re-derives it (all three sources agree on this build, 2.0.77):
--
--   yes.  `stack.set_stack({name = "blueprint"})` then `stack.set_blueprint_entities(specs)` on a stack in
--   a `game.create_inventory(1)` writes a real blueprint, and `get_blueprint_entities()` reads the same
--   list back -- verified here, and relied on by `card_carry` / `blueprint_string` in control.lua.
--
--   the door into a player's hand is the game's OWN paste: `LuaPlayer::add_to_clipboard(blueprint)` puts
--   an authored stack in that player's clipboard queue, and `LuaPlayer::activate_paste()` pulls it into the
--   cursor "as if the player activated Paste". Documented in `doc-html/runtime-api.json` -- which is the
--   local copy of this install's API and answers a name question in seconds, unlike the web docs. Note the
--   same file lists class MEMBERS under `attributes`, not `properties`: reading `properties` alone reports
--   an empty list for every class and makes the doc look truncated when it is not.
--
--   `LuaPlayer::blueprint_to_setup` and `LuaPlayer::blueprints` are READ ONLY on this build (no
--   `write_type`), so the setup GUI cannot be opened by script and the blueprint LIBRARY cannot be written
--   into. Anything that "travels with a blueprint" has to ride inside the item we author -- the label, the
--   description, the entity list -- not the player's library.
--
--   names that do NOT exist here, whatever a forum post says: `LuaItemStack::set_blueprint_string`,
--   `get_blueprint_string`, `get_record_inventory`, `blueprint_record`, `export_record` (that one is a
--   LuaRecord method, not a stack's), `game.blueprint_library`, `mtLuaItemStack` and the other `mtLua*`
--   metatables at runtime (they exist in the data stage only, so a member list cannot be enumerated from
--   the console -- probe names one at a time and tell "doesn't contain key" from "invalid for read").
--
-- The changelog (INSTALL/data/changelog.txt) names members the truncated HTML does not, and is worth
-- grepping before any of this: it is where set/get_blueprint_entities and LuaRecord first appear.
--
-- One block, because the rcon console state has no `storage` and is not promised to keep globals between
-- commands -- everything shares one local.

@@ author_blueprint
local function probe(obj, names, tag)
  for _, m in ipairs(names) do
    local ok, v = pcall(function() return obj[m] end)
    local verdict
    if not ok then
      local s = tostring(v)
      verdict = s:find("doesn't contain key") and "ABSENT" or ("EXISTS, read blocked: " .. s:gsub(".*key ", ""):sub(1, 50))
    else
      verdict = "EXISTS (" .. type(v) .. ")"
    end
    rcon.print("  " .. tag .. "." .. m .. " -> " .. verdict .. "\n")
  end
end

local ok, inv = pcall(game.create_inventory, 2)
if not ok then rcon.print("create_inventory: " .. tostring(inv) .. "\n") return end
rcon.print("create_inventory(2) ok\n")
probe(inv, {"insert", "set_filter", "clear"}, "LuaInventory")

local st = inv[1]
probe(st, {"set_stack", "get_blueprint_entities", "set_blueprint_entities", "get_blueprint_tiles",
  "preview_icons", "blueprint_description", "export_record", "import_record", "record", "get_record",
  "label", "create_grid", "get_record_inventory", "request_protection"}, "LuaItemStack")

local e1 = pcall(function() st.set_stack({name = "blueprint", count = 1}) end)
rcon.print("set_stack(blueprint): " .. tostring(e1) .. " valid=" .. tostring(st.valid) .. "\n")
local e1b = pcall(function() st.set_blueprint_tiles({{position = {0, 0}, name = "tile-refined-concrete"}}) end)
rcon.print("set_blueprint_tiles: " .. tostring(e1b) .. (e1b and "" or " (name may be wrong)") .. "\n")

local ents = {
  {entity_number = 1, name = "transport-belt", position = {0, 0}, direction = defines.direction.east},
  {entity_number = 2, name = "inserter", position = {1.5, 0.5}, direction = defines.direction.north},
  {entity_number = 3, name = "assembling-machine-2", position = {3.5, 0.5}, recipe = "iron-gear-wheel"},
}
local e2, err2 = pcall(function() return st.set_blueprint_entities(ents) end)
rcon.print("set_blueprint_entities: " .. tostring(e2) .. (e2 and "" or (" -> " .. tostring(err2))) .. "\n")
local e3, back = pcall(function() return st.get_blueprint_entities() end)
if e3 and back then
  rcon.print("read back n=" .. tostring(#back) .. "\n")
  for i, e in ipairs(back) do
    local p = e.position or {}
    rcon.print("  #" .. i .. " " .. tostring(e.name) .. " @" .. tostring(p.x) .. "," .. tostring(p.y) ..
      " dir=" .. tostring(e.direction) .. " recipe=" .. tostring(e.recipe) .. "\n")
  end
else
  rcon.print("get_blueprint_entities: ok=" .. tostring(e3) .. " -> " .. tostring(back) .. "\n")
end

local e4, rec = pcall(function() return st.export_record() end)
rcon.print("export_record: ok=" .. tostring(e4) .. " -> " ..
  (e4 and (type(rec) .. " " .. tostring(rec.name) .. " class=" .. tostring(rec.class and rec.class.name)) or tostring(rec)) .. "\n")
if e4 and rec then
  probe(rec, {"contents", "contents_size", "export_record", "preview_icons", "blueprint_description",
    "is_preview", "active_index", "get_active_index", "valid"}, "LuaRecord")
  local e5, str = pcall(function() return rec.export_record() end)
  rcon.print("record.export_record: ok=" .. tostring(e5) .. " -> " .. (e5 and ("len=" .. tostring(str and #tostring(str))) or tostring(str)) .. "\n")
  local e6, txt = pcall(function() return rec.get_blueprint_entities() end)
  rcon.print("record.get_blueprint_entities: ok=" .. tostring(e6) .. " -> n=" .. (e6 and tostring(txt and #txt) or tostring(txt)) .. "\n")
end

local surf = game.surfaces["nauvis"]
probe(surf, {"create_entities_from_blueprint_string"}, "LuaSurface")
local ok2, v2 = pcall(function() return game.blueprint_library end)
rcon.print("game.blueprint_library -> " .. (ok2 and type(v2) or tostring(v2)) .. "\n")
local d = pcall(function() return inv.destroy() end)
rcon.print("inv.destroy=" .. tostring(d) .. "\n")
rcon.print("done\n")
