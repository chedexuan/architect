-- Why "all techs" is not all techs, on this build.
--
-- `research_all_technologies()` reported success and left 23 of 275 unresearched. The candidates are
-- technologies whose `enabled` flag is false -- a research-all call has no reason to reach a tech the
-- game considers not-present -- so the question is which ones, and whether turning them on and asking
-- again finishes the job. Setting `.researched` by hand is NOT the fix: that is the flag, not the
-- unlock, and every recipe the tech gates stays locked (this save has been fooled by that before).

@@ which_ones
local f = game.forces.player
local off, not_enabled = {}, {}
for name, t in pairs(f.technologies) do
  if not t.researched then
    off[#off + 1] = name .. "(enabled=" .. tostring(t.enabled) .. ",prereq=" .. tostring(#(t.prerequisites or {})) .. ")"
    if t.enabled == false then not_enabled[#not_enabled + 1] = name end
  end
end
table.sort(off)
rcon.print("未开的科技 " .. #off .. " 个：\n  " .. table.concat(off, "\n  ") .. "\n")

@@ finish_it
local f = game.forces.player
local turned_on = 0
for _, name in ipairs({}) do end
for name, t in pairs(f.technologies) do
  if not t.researched and t.enabled == false then
    t.enabled = true
    turned_on = turned_on + 1
  end
end
local ok, err = pcall(function() f.research_all_technologies() end)
local left, locked_recipes, locked_tech = {}, {}, {}
for name, t in pairs(f.technologies) do
  if not t.researched then left[#left + 1] = name end
end
for name, r in pairs(f.recipes) do
  if r.enabled == false then locked_recipes[#locked_recipes + 1] = name end
end
rcon.print(string.format("开了 %d 个再问一次：ok=%s 仍未开科技 %d [%s] 仍锁着的配方 %d [%s]\n",
  turned_on, tostring(ok), #left, table.concat(left, ","), #locked_recipes,
  table.concat(locked_recipes, ",", 1, 12)))
