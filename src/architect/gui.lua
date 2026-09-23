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
local REPORT = "arch-report"
G.REPORT = REPORT

-- Factorio's Lua sandbox has no `utf8` library -- measured: `utf8.offset` raises "attempt to index
-- global 'utf8' (a nil value)" -- so the boundary is found by hand. A byte below 0x80 is its own
-- character; 0xC0 and above starts one; 0x80-0xBF continues the one before it. Cutting in the middle
-- of a sequence is what showed a broken glyph in the panel where a card's name should be.
local function utf8_prefix_len(s, chars)
  local i, seen = 1, 0
  while i <= #s do
    local b = s:byte(i)
    if b < 0x80 or b >= 0xC0 then
      if seen == chars then break end
      seen = seen + 1
    end
    i = i + 1
  end
  return i - 1
end

local function truncated(s, n)
  s = tostring(s or "")
  -- Compare like with like: `n` counts CHARACTERS and `#s` counts BYTES, so the fast path here used
  -- to decide a 27-character CJK name (81 bytes) did not fit in 30 and append an ellipsis to a
  -- string that was never cut.
  local keep = utf8_prefix_len(s, n or 40)
  if keep >= #s then return s end
  if keep <= 0 then return "..." end
  return s:sub(1, keep) .. "..."
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

  local tbl = frame.add { type = "table", column_count = 8, name = "arch-cards" }
  for _, h in ipairs({ "card", "entities", "produces", "verify", "why", "power", "", "" }) do
    tbl.add { type = "label", caption = h }
  end
  for _, card in ipairs(model.cards) do
    tbl.add { type = "label", caption = truncated(card.name, 30) }
    tbl.add { type = "label", caption = tostring(card.entities) }
    tbl.add { type = "label", caption = truncated(card.label, 44) }
    tbl.add { type = "button", name = "arch-verify:" .. card.name, caption = "Verify" }
    tbl.add { type = "button", name = "arch-why:" .. card.name, caption = "Why" }
    tbl.add { type = "button", name = "arch-power:" .. card.name, caption = "Power" }
    tbl.add { type = "button", name = "arch-place:" .. card.name, caption = "Place" }
    tbl.add { type = "button", name = "arch-string:" .. card.name, caption = "String" }
  end
  -- The answer goes in the window, not only in chat: a verification is a dozen lines, and the chat
  -- log is where a player loses a line the moment they scroll. Named so `G.show_report` can find it
  -- with the same two-hop lookup the string field uses.
  local report = frame.add { type = "flow", direction = "vertical", name = REPORT }
  report.add { type = "label", name = "arch-report-title", caption = "nothing asked yet -- Verify / Why / Power are per card" }
  return frame
end

-- What a player would read for one action, as data.
--
-- Split out of the click handler for the same reason `G.model` is split out of the build: the words
-- in this window are the part worth asserting, and a headless run can reach them while it cannot
-- reach a widget. Every branch reads a field the method actually returns; nothing here decides, and
-- a refusal keeps its code and its reason rather than becoming "failed".
function G.report_lines(cmd, name, res)
  res = res or {}
  local d = res.data or {}
  local lines = {}
  local function add(s) if s and s ~= "" then lines[#lines + 1] = s end end
  local function list_of(v)
    local out = {}
    for _, e in ipairs(type(v) == "table" and v or {}) do out[#out + 1] = e end
    return out
  end
  local function reason(e)
    if type(e) ~= "table" then return tostring(e) end
    return tostring(e.code or e.why or e.recipe or e.at or "") .. " " .. tostring(e.msg or e.note or "")
  end

  if not res.ok then
    add("refused: " .. tostring(res.code or "?") .. (res.msg and (" -- " .. tostring(res.msg)) or ""))
    local det = res.detail
    if type(det) == "table" then
      for _, key in ipairs({ "errors", "problems", "candidates", "known", "surfaces", "ingredients" }) do
        for _, e in ipairs(list_of(det[key])) do add("  " .. key .. ": " .. truncated(reason(e), 130)) end
      end
      if det.reason then add("  reason: " .. truncated(tostring(det.reason), 130)) end
      if det.pole then add("  pole asked for: " .. truncated(tostring(det.pole), 60)) end
    end
    if #lines == 0 then add("  (the refusal carries no detail -- the code above is all there is)") end
    return { title = cmd .. "  " .. name, lines = lines }
  end

  if cmd == "verify" then
    local p = d.power or {}
    add("verdict: " .. (d.ok and "ok" or "not ok") .. ", " .. tostring(d.placed or 0) .. " entities placed")
    add("power: " .. tostring(p.covered or 0) .. "/" .. tostring(p.powered_entities or 0)
      .. " on a grid, " .. tostring(p.demand_kw or 0) .. " kW draw vs "
      .. tostring(p.in_card_supply_kw or 0) .. " kW carried")
    add("networks: " .. tostring(#list_of(d.networks)) .. "; arms: " .. tostring(#list_of(d.arms)))
    for _, e in ipairs(list_of(d.errors)) do add("ERROR " .. truncated(reason(e), 130)) end
    for _, e in ipairs(list_of(d.warnings)) do add("note  " .. truncated(reason(e), 130)) end
  elseif cmd == "why" then
    local rec = d.record or {}
    add(rec.measured_this_card and "this card was measured in game"
      or "NOT MEASURED -- frozen from a plan, so the rate below is what the card claims, not what the game confirmed")
    local function pairs_of(t, unit)
      local out = {}
      for k, v in pairs(type(t) == "table" and t or {}) do out[#out + 1] = tostring(v) .. " " .. unit .. " " .. tostring(k) end
      table.sort(out)
      return out
    end
    for _, s in ipairs(pairs_of(d.claimed or rec.claimed, "/min")) do add("claims:   " .. s) end
    for _, s in ipairs(pairs_of(rec.measured, "/min")) do add("measured: " .. s) end
    if rec.window_seconds then add("window: " .. tostring(rec.window_seconds) .. "s, warm-up "
      .. tostring(rec.warmup_seconds or "?") .. "s, job " .. tostring(rec.source_job or "?")) end
    for _, e in ipairs(list_of(d.errors)) do add("ERROR " .. truncated(reason(e), 130)) end
    for _, e in ipairs(list_of(d.warnings)) do add("note  " .. truncated(reason(e), 130)) end
  elseif cmd == "power" then
    add("plan: " .. tostring(d.to_add or 0) .. " additions from " .. tostring(d.probes or 0)
      .. " engine placements, pole " .. tostring(d.pole or "?"))
    add("served " .. tostring(d.served or 0) .. "/" .. tostring(d.powered or 0)
      .. " machines, still unserved " .. tostring(d.still_unserved or 0))
    if d.pole_how then add("pole chosen by: " .. truncated(tostring(d.pole_how), 130)) end
    if d.next then add("next: " .. truncated(tostring(d.next), 140)) end
  else
    add("(no summary for " .. tostring(cmd) .. ")")
  end
  if #lines > 14 then
    local cut = {}
    for i = 1, 14 do cut[i] = lines[i] end
    cut[#cut + 1] = "... " .. (#lines - 14) .. " more lines (the full answer is over RCON)"
    lines = cut
  end
  return { title = cmd .. "  " .. name, lines = lines }
end

-- Fill the report area. Returns whether it was reached: a panel closed between the click and here is
-- a real sequence, and `show_string` already treats it that way.
function G.show_report(player, title, lines)
  local frame = player.gui and player.gui.screen and player.gui.screen[ROOT]
  local box = frame and frame[REPORT]
  if not box then return false end
  pcall(function() box.clear() end)
  box.add { type = "label", name = "arch-report-title", caption = truncated(title, 120) }
  for _, l in ipairs(lines or {}) do
    box.add { type = "label", caption = truncated(l, 200) }
  end
  return true
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
--
-- The verbs are the methods a player cannot run from chat, and the point of listing them here is
-- that the panel stops being a deploy button: the same three questions an outside designer asks over
-- RCON, answered in the window for whoever is standing in the factory.
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
  elseif cmd == "arch-verify" or cmd == "arch-why" or cmd == "arch-power" then
    local verb = cmd:sub(6)
    local res = api[verb] and api[verb](name) or { ok = false, code = "NO_HANDLER", msg = verb }
    local out = G.report_lines(verb, name, res)
    G.show_report(player, out.title, out.lines)
    player.print("architect: " .. verb .. " " .. name .. " -- "
      .. (res and res.ok and "answered" or ("refused " .. tostring((res or {}).code))))
    return verb, res
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
