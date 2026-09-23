-- The player-facing panel.
--
-- Everything the rules can do was reachable only over RCON, which makes the mod a test harness
-- rather than a mod. This is the window on the other side of that: what has been frozen, what it
-- produces, whether it lints and what it draws -- five verbs per row (verify, why, power, place,
-- string) and one question the player types, which asks whoever is designing from outside the game.
--
-- Division of labour is the same as everywhere else in this project: this file renders and
-- dispatches, it decides nothing. The data it shows comes from `G.model`, a plain function
-- over the same tables the RCON methods return -- so the panel's CONTENTS are regression
-- testable without a client. The build and click code is too, against a recording stand-in for a
-- player (`M.gui_selftest`), which is how the dead Ask button was found: dispatch, swallowed raises
-- and renamed fields all show up there. What no headless run can reach is the engine accepting the
-- widget specs, and what the window is like to read when someone has it open.
--
-- Captions are English on purpose: the same words appear in the JSON a designer reads on the
-- other side, and one name for one thing beats a translation that no check can confirm.

local G = {}

-- Only for `host.clip`, so that a caption and a chat line are cut on the same rule.
local host = require("host")

local ROOT = "arch-root"
G.ROOT = ROOT   -- the self-test looks the frame up by this name
local REPORT = "arch-report"
G.REPORT = REPORT

-- Factorio's Lua sandbox has no `utf8` library -- measured: `utf8.offset` raises "attempt to index
-- global 'utf8' (a nil value)" -- so a character boundary is found by hand, and that scan lives in
-- `host.clip` because a chat line cut by `sub(1, n)` has the same problem as a caption does.
local function truncated(s, n)
  s = tostring(s or "")
  -- Compare like with like: `n` counts CHARACTERS and `#s` counts BYTES, so a fast path on `#s` used
  -- to decide a 27-character CJK name (81 bytes) did not fit in 30 and append an ellipsis to a string
  -- that was never cut.
  local keep = host.clip(s, n or 40)
  if #keep >= #s then return s end
  if keep == "" then return "..." end
  return keep .. "..."
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
    -- One label, so it has to stay short enough to read at a glance: what the row buttons are, then
    -- the one caveat that changes how a number should be read. Where the ask goes is said at the ask.
    hint = #list == 0 and "nothing frozen yet -- run card_lab then card_freeze, or freeze a region with allow_unmeasured"
      or "Verify / Why / Power answer about that row; Place puts ghosts down near your character and "
        .. "String fills the field above with a blueprint you can Ctrl+C. A row marked 'planned' was "
        .. "never measured.",
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

  -- The player's only input. A text field rather than a chat command, because the answer comes back
  -- into this window beside the question instead of into a log that scrolls away. The label says what
  -- this mod actually does with the words: it holds them. Nothing here can answer them.
  local arow = frame.add { type = "flow", direction = "horizontal", name = "arch-ask-row" }
  arow.add { type = "label", name = "arch-ask-label", caption = "ask the designer (queued, not answered here):" }
  arow.add { type = "textfield", name = "arch-ask-in", text = "" }
  arow.add { type = "button", name = "arch-ask", caption = "Ask" }
  arow.add { type = "button", name = "arch-queue", caption = "Queue" }

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
  -- One word for "what is this entry about". A detail bag holds several shapes -- a named thing, a
  -- refusal with its own code, a rejected site as a coordinate -- and an entry rendered as `nil` in
  -- the window is the same silence as not rendering it.
  local function reason(e)
    if type(e) ~= "table" then return tostring(e) end
    local what = e.name or e.code or e.why or e.recipe or e.item or e.at
      or (e.x ~= nil and e.y ~= nil and (tostring(e.x) .. "," .. tostring(e.y))) or ""
    local note = e.msg or e.note
      -- a blocked placement says what it landed ON, which is the only half of the answer a player can
      -- act on: "#3 assembling-machine-1" names the card's own part, "on top of your furnace" is the fact
      or (e.on_top_of and #e.on_top_of > 0 and ("lands on " .. table.concat(list_of(e.on_top_of), ", ")))
      or ""
    -- `at` is which entity of the card, and for a placement refusal it is the whole point: "a
    -- steel-chest is in the way" is a shrug, "#7 of this card lands on a steel-chest" is actionable.
    local pre = (type(e.at) == "number" and e.name) and ("#" .. tostring(e.at) .. " ") or ""
    return pre .. tostring(what) .. " " .. tostring(note)
  end
  local function rates_of(t)
    local out = {}
    for k, v in pairs(type(t) == "table" and t or {}) do out[#out + 1] = tostring(v) .. "/min " .. tostring(k) end
    table.sort(out)
    return table.concat(out, ", ")
  end

  if not res.ok then
    add("refused: " .. tostring(res.code or "?") .. (res.msg and (" -- " .. tostring(res.msg)) or ""))
    local det = res.detail
    if type(det) == "table" then
      for _, key in ipairs({ "errors", "problems", "candidates", "known", "surfaces", "ingredients",
        "cards", "blockers" }) do
        for _, e in ipairs(list_of(det[key])) do add("  " .. key .. ": " .. truncated(reason(e), 130)) end
      end
      -- `wanted` is not a `blockers` list: these are the parts the card tried to put down where
      -- nothing stands, so labelling them obstacles would be the same lie in a new font.
      for _, e in ipairs(list_of(det.wanted)) do
        add("  would place: " .. truncated(reason(e), 130))
      end
      if type(det.ground) == "table" then
        add("  ground: " .. (det.ground.tile and ("tile " .. tostring(det.ground.tile)) or "no tile here")
          .. (det.ground.generated == false and " (this ground is not generated yet)" or ""))
      end
      -- Where it tried and failed, as its own line: `blockers` says what is in the way and `origin`
      -- says where, and a player needs the second one to know whether the first is worth moving.
      if type(det.origin) == "table" then
        add("  at: " .. tostring(det.origin.x) .. "," .. tostring(det.origin.y)
          .. (det.origin.surface and (" on " .. tostring(det.origin.surface)) or ""))
      end
      -- ...and a detail that IS the list rather than a bag of them: `NO_CLEAR_SITE` carries the four
      -- origins it tried, and a refusal that names where it looked is the difference between "it would
      -- not fit" and "move it off the refinery".
      local bare = {}
      for _, e in ipairs(list_of(det)) do
        local w = truncated(reason(e), 40)
        if w:match("%S") then bare[#bare + 1] = w end
      end
      if #bare > 0 then add("  named: " .. truncated(table.concat(bare, "; "), 160)) end
      if det.reason then add("  reason: " .. truncated(tostring(det.reason), 130)) end
      if det.pole then add("  pole asked for: " .. truncated(tostring(det.pole), 60)) end
    end
    -- `#lines == 0` here could never happen -- the code line above always lands first -- so the check
    -- that the branch exists for had to be written against the one thing that varies: whether anything
    -- came after the code.
    if #lines == 1 then add("  (nothing else came with it -- the code above is all the method said)") end
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
  elseif cmd == "ask" or cmd == "queue" then
    local q = list_of(d.queue)
    if cmd == "ask" and d.asked and d.asked.request then
      add("asked #" .. tostring(d.asked.request.id) .. " at tick "
        .. tostring(d.asked.request.asked_tick)
        .. (d.asked.request.surface and (" on " .. tostring(d.asked.request.surface)) or ""))
      add(tostring(d.asked.request.ask))
      if d.asked.note then add("(how it gets answered) " .. truncated(tostring(d.asked.note), 160)) end
    elseif cmd == "ask" then
      add("refused: " .. tostring(res.code or "?") .. " -- " .. truncated(res.msg, 130))
    end
    add("queue: " .. tostring(#q) .. " held, " .. tostring(d.open or 0) .. " still open")
    for _, r in ipairs(q) do
      add("#" .. tostring(r.id) .. " [" .. tostring(r.state) .. "] " .. truncated(r.ask, 60))
      if r.answer then add("   answered: " .. truncated(r.answer, 140)) end
      if #lines > 12 then add("... the rest through requests{}") break end
    end
  elseif cmd == "place" then
    -- The receipt for putting it down. `refused` is counted, not just mentioned: a card that lands
    -- 12 of 14 entities is a partial deployment, and the first version of this line reported only the
    -- 12.
    local refused = list_of(d.refused)
    add("ghosts: " .. tostring(d.ghosts or 0) .. " at " .. tostring(d.origin and d.origin.x) .. ","
      .. tostring(d.origin and d.origin.y) .. " on " .. tostring(d.surface or "?")
      .. "; built " .. tostring(d.built or 0) .. ", refused " .. tostring(#refused))
    for _, e in ipairs(refused) do add("  refused: " .. truncated(reason(e), 120)) end
    add(d.measured_this_card and ("measured: " .. rates_of(d.measured))
      or "NOT MEASURED -- what appears is a plan, not a rate the game confirmed")
  elseif cmd == "string" then
    add("blueprint: " .. tostring(d.bytes or 0) .. " bytes"
      .. (d.error and (" (the string itself reported: " .. truncated(d.error, 80) .. ")") or "")
      .. " -- in the field above, Ctrl+C")
    add(d.measured_this_card and ("measured: " .. rates_of(d.measured))
      or "NOT MEASURED -- the blueprint copies a plan, and a plan copied twice is still a plan")
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

-- Ask and Queue carry no card name, so they are not shaped like the per-card buttons and cannot be
-- dispatched by the pattern in `G.on_click`: `^(arch%-%a+):(.*)$` requires the colon, and "arch-ask"
-- has none. Both halves of that mistake were silent -- the click returned nil without a word, in the
-- selftest exactly as in the game, and the selftest then printed "raised" for an answer that was
-- merely a refusal.
--
-- Queue shows the whole held list rather than only what is open, because an answer the player has
-- not read yet is the more interesting half of the queue.
local function ask_or_queue(player, cmd, model, api)
  local text
  if cmd == "arch-ask" then
    local f = player.gui and player.gui.screen and player.gui.screen[ROOT]
    local row = f and f["arch-ask-row"]
    local field = row and row["arch-ask-in"]
    text = field and field.text or nil
  end
  -- Where the question was asked, from the player's feet. The method defaults to the first surface
  -- when nothing is named, and an ask that says "nauvis" while the one who typed it stood on a
  -- platform is a wrong fact wearing the shape of a default.
  local surface
  local here = host.field(player, "surface")
  if here then surface = host.field(here, "name") end
  local res = cmd == "arch-ask" and api.request(text, nil, surface) or { ok = true }
  local q = api.queue and api.queue() or { ok = true, data = { requests = {} } }
  local merged = {
    ok = res.ok, code = res.code, msg = res.msg, detail = res.detail,
    data = { asked = res.data, queue = (q.data or {}).requests, open = (q.data or {}).open,
      asked_text = text },
  }
  local out = G.report_lines(cmd == "arch-ask" and "ask" or "queue", text or "", merged)
  G.show_report(player, out.title, out.lines)
  return cmd == "arch-ask" and "ask" or "queue", merged
end

-- Button names carry their argument because Factorio hands the click handler an element, not
-- a closure: "arch-place:<card>" is the whole context. The verbs are the methods a player cannot
-- run from chat, and the point of listing them here is that the panel stops being a deploy button:
-- the same questions an outside designer asks over RCON, answered in the window for whoever is
-- standing in the factory.
function G.on_click(player, element_name, model, api)
  if not element_name then return nil end
  if element_name == "arch-close" then G.close(player); return "closed" end
  if element_name == "arch-refresh" then G.open(player, model); return "refreshed" end
  if element_name == "arch-ask" or element_name == "arch-queue" then
    return ask_or_queue(player, element_name, model, api)
  end
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
    local out = G.report_lines("place", name, res)
    G.show_report(player, out.title, out.lines)
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
    local out = G.report_lines("string", name, res)
    -- Called unconditionally: when the panel went away between the click and here, `show_report`
    -- reports that itself by returning false, and the chat line above already carried the string.
    G.show_report(player, out.title, out.lines)
    return "string", res
  end
  return nil
end

return G
