-- The geometry ledger, one line per case, printed as it is collected.
--
-- Why printed rather than written to a file: `game.write_file` is not reachable from the console state on
-- this build (measured: reading it raises), and one 50 KB `rcon.print` is where a reply starts losing its
-- tail -- which looks exactly like a geometry having changed. So the ledger arrives as small answers and
-- the harness compares the whole text, because that is the property worth having: not one number that
-- moved, but a chest that moved by one cell.
--
-- The strings are the method's own JSON, so the ledger compares exactly what a caller outside the game
-- compares: `footprint`, the entity list, and the rate the card claims.
@@ ledger
local function one(args)
  local ok, txt = pcall(function() return remote.call("arch", "call", "card_example", args) end)
  if not ok then return "ERR " .. tostring(txt) end
  return tostring(txt)
end
rcon.print("@@LEDGER-BEGIN\n")
for _, ins in ipairs({ "inserter", "long-handed-inserter", "fast-inserter" }) do
  for _, fur in ipairs({ "stone-furnace", "steel-furnace", "electric-furnace" }) do
    for _, sp in ipairs({ "compact", "standard", "loose" }) do
      for n = 1, 3 do
        rcon.print(ins .. "|" .. fur .. "|" .. sp .. "|n" .. n .. "="
          .. one({ machines = n, inserter = ins, furnace = fur, spacing = sp, outlets = 1 }) .. "\n")
      end
    end
  end
end
-- Outlets and a different belt tier are the two extras that change a lane's shape rather than its
-- length, so they get their own cases: a style that silently dropped the second outlet would look
-- identical in every row above.
rcon.print("outlets2=" .. one({ machines = 2, inserter = "long-handed-inserter",
  furnace = "steel-furnace", spacing = "standard", outlets = 2 }) .. "\n")
rcon.print("belt-tier=" .. one({ machines = 2, belt = "express-transport-belt", chest = "steel-chest" }) .. "\n")
rcon.print("@@LEDGER-END\n")
