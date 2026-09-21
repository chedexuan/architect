-- The player-facing panel.
--
-- Everything the rules can do has so far been reachable only over RCON, which makes the mod
-- a test harness rather than a mod. This is the thin end of the wedge: a window that shows
-- what has been frozen, what it produces, whether it lints, and two actions -- drop blueprint
-- strings in chat, or put the thing down as ghosts where the player is standing.
--
-- Division of labour is the same as everywhere else in this project: this file renders and
-- dispatches, it decides nothing. The data it shows comes from `G.model`, a plain function
-- over the same tables the RCON methods return -- so the panel's CONTENTS are regression
-- testable without a client. What cannot be tested headless is the widgets themselves: a
-- server with no connected player never runs a single line of the build code, so the layout
-- is unverified until someone opens the window in the game.
--
-- Captions are English on purpose: the same words appear in the JSON a designer reads on the
-- other side, and one name for one thing beats a translation that no check can confirm.

local G = {}

local ROOT = "arch-root"
G.ROOT = ROOT   -- the self-test looks the frame up by this name

local function truncated(s, n)
  s = tostring(s or "")
  if #s <= (n or 40) then return s end
  return s:sub(1, (n or 40)) .. "..."
end

-- What the panel would show, as data. Takes the frozen-card store and a version string and
-- returns plain values only, so it can be built and asserted without anyone being connected.
function G.model(cards, version)
  local list = {}
  for name, rec in pairs(cards or {}) do
    local card = rec.card or {}
    local outputs = {}
    for item, rate in pairs((card.contract or {}).outputs or {}) do
      outputs[#outputs + 1] = { item = item, per_min = rate }
    end
    table.sort(outputs, function(a, b) return a.item < b.item end)
    list[#list + 1] = {
      name = name,
      entities = #(card.entities or {}),
      -- the distinction the whole freeze policy rests on, shown rather than assumed
      proven = rec.measured_this_card ~= false,
      outputs = outputs,
      blueprint = rec.blueprint ~= nil,
      label = #outputs == 0 and "no exports" or (function()
        local parts = {}
        for _, o in ipairs(outputs) do
          parts[#parts + 1] = string.format("%g/min %s", o.per_min, o.item)
        end
        if rec.measured_this_card == false then
          for i, o in ipairs(outputs) do
            parts[i] = parts[i] .. " (planned, not measured)"
          end
        end
        return table.concat(parts, ", ")
      end)(),
    }
  end
  table.sort(list, function(a, b) return a.name < b.name end)
  return {
    title = "Architect",
    version = version,
    cards = list,
    empty = #list == 0,
    hint = #list == 0 and "nothing frozen yet -- run card_lab then card_freeze, or freeze a region with allow_unmeasured"
      or "Place puts ghosts down near your character; String fills the field above with a "
        .. "blueprint string you can Ctrl+C. A row marked 'planned' was never measured.",
  }
end

local function clear_frame(player)
  local gui = player.gui
  if not gui then return end
  local existing = gui.screen[ROOT]
  if existing then existing.destroy() end
end

function G.build(player, model)
  clear_frame(player)
  local frame = player.gui.screen.add {
    type = "frame", name = ROOT, direction = "vertical",
    caption = model.title .. "  v" .. tostring(model.version),
  }
  frame.auto_center = true
  local flow = frame.add { type = "flow", direction = "horizontal" }
  flow.add { type = "label", caption = model.hint }
  flow.add { type = "button", name = "arch-refresh", caption = "Refresh" }
  flow.add { type = "button", name = "arch-close", caption = "Close" }

  -- A blueprint string in chat cannot be selected, which makes it useless: the whole point of the
  -- string is pasting it into the game or sending it to someone. A text field can be, and selecting
  -- it on the way in means one Ctrl+C is the whole interaction.
  local srow = frame.add { type = "flow", direction = "horizontal", name = "arch-string-row" }
  srow.add { type = "label", name = "arch-string-label", caption = "blueprint:" }
  srow.add { type = "textfield", name = "arch-string-out", text = "" }

  local tbl = frame.add { type = "table", column_count = 5, name = "arch-cards" }
  for _, h in ipairs({ "card", "entities", "produces", "", "" }) do
    tbl.add { type = "label", caption = h }
  end
  for _, card in ipairs(model.cards) do
    tbl.add { type = "label", caption = truncated(card.name, 30) }
    tbl.add { type = "label", caption = tostring(card.entities) }
    tbl.add { type = "label", caption = truncated(card.label, 44) }
    tbl.add { type = "button", name = "arch-place:" .. card.name, caption = "Place" }
    tbl.add { type = "button", name = "arch-string:" .. card.name, caption = "String" }
  end
  return frame
end

-- Put a string where a hand can copy it. Returns whether the field was reached, because a panel that
-- has been closed between the click and here is a real sequence, not a hypothetical one.
--
-- Each lookup is one level deep on purpose: whether `frame[name]` searches every descendant or only
-- direct children is not something this mod wants to depend on, and two named hops say the same
-- thing either way.
function G.show_string(player, name, str)
  local frame = player.gui and player.gui.screen and player.gui.screen[ROOT]
  if not frame then return false end
  local row = frame["arch-string-row"]
  local field = row and row["arch-string-out"]
  if not field then return false end
  field.text = str or ""
  local label = row["arch-string-label"]
  if label then label.caption = name and (name .. ":") or "blueprint:" end
  -- `select_all` is a method, and an element that has not received focus yet can refuse it
  pcall(function() field.select_all() end)
  return true
end

function G.open(player, model)
  local ok, err = pcall(G.build, player, model)
  if not ok then
    pcall(function() player.print("Architect could not build its window: " .. tostring(err)) end)
    return nil, err
  end
  return player.gui.screen[ROOT]
end

function G.toggle(player, model)
  if player.gui and player.gui.screen[ROOT] then
    G.close(player)
    return "closed"
  end
  G.open(player, model)
  return player.gui.screen[ROOT] and "opened" or "failed"
end

function G.close(player)
  pcall(clear_frame, player)
  return true
end

-- Button names carry their argument because Factorio hands the click handler an element, not
-- a closure: "arch-place:<card>" is the whole context.
function G.on_click(player, element_name, model, api)
  if not element_name then return nil end
  if element_name == "arch-close" then G.close(player); return "closed" end
  if element_name == "arch-refresh" then G.open(player, model); return "refreshed" end
  local cmd, arg = element_name:match("^(arch%-%a+):(.*)$")
  if not cmd then return nil end
  local name = arg
  if cmd == "arch-place" then
    local res = api.place(name)
    if res and res.ok then
      player.print(string.format("architect: %s -> %d ghosts at %s,%s on %s", name,
        res.data and res.data.ghosts or 0,
        tostring(res.data and res.data.origin and res.data.origin.x),
        tostring(res.data and res.data.origin and res.data.origin.y),
        tostring(res.data and res.data.surface)))
    else
      player.print("architect: " .. name .. " refused -- " .. tostring((res or {}).code or "?")
        .. " " .. truncated((res or {}).msg, 160))
    end
    return "place", res
  elseif cmd == "arch-string" then
    local res = api.blueprint(name)
    if res and res.ok and res.data and res.data.blueprint then
      local shown = G.show_string(player, name, res.data.blueprint)
      player.print(string.format("architect: %s -> %d bytes %s", name, #res.data.blueprint,
        shown and "(in the field above, Ctrl+C)"
          or "(the panel is gone, so here it is, uncopyable from chat: " .. truncated(res.data.blueprint, 120) .. ")"))
    else
      player.print("architect: no blueprint string for " .. name
        .. " (" .. tostring((res or {}).code or ((res or {}).data or {}).error) .. ")")
    end
    return "string", res
  end
  return nil
end

return G
