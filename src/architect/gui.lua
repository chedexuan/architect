-- The player-facing panel.
--
-- Everything the rules can do was reachable only over RCON, which makes the mod a test harness
-- rather than a mod. This is the window on the other side of that: six verbs per row (verify, why,
-- power, measure, place, string), a form that asks the solver what to build, a box the player dragged
-- that says whether it fits, and one question the player types for whoever designs from outside.
--
-- Division of labour is the same as everywhere else in this project: this file renders and
-- dispatches, it decides nothing. The data it shows comes from `G.model`, a plain function
-- over the same tables the RCON methods return -- so the panel's CONTENTS are regression
-- testable without a client. The build and click code is too, against a recording stand-in for a
-- player (`M.gui_selftest`), which is how the dead Ask button was found: dispatch, swallowed raises
-- and renamed fields all show up there. Widget specs are checked by name against the installed
-- runtime API, types included. What no headless run reaches is what the window is like to READ --
-- whether six buttons on a row plus a form is too much to find your way around, whether a player
-- notices the box row at all -- and that is a person with a client, not a suite.
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


-- A menu arrives from the method as a list of {value, label} pairs so the widget can show something a
-- player recognises while the value stays the prototype name the solver wants. `chosen` is the value to
-- land on, which is how a panel re-opened after a plan keeps showing what was asked for.
local function menu_labels(list)
  local out = {}
  for _, e in ipairs(list or {}) do out[#out + 1] = tostring(e.label or e.value) end
  if #out == 0 then out[1] = "(nothing available)" end
  return out
end

local function menu_index(list, chosen)
  if not chosen then return 1 end
  for i, e in ipairs(list or {}) do
    if e.value == chosen then return i end
  end
  return 1   -- not on the menu: show the first, and let the method refuse by name if it is used
end

-- What the panel would show, as data. Takes the frozen-card store and a version string and
-- returns plain values only, so it can be built and asserted without anyone being connected.
function G.model(cards, version, selection)
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
    -- What the player boxed with the selection tool, if anything. Named in the model rather than read
    -- off the world by the build code: the panel decides nothing, including what it is about to show.
    selection = selection and {
      surface = selection.surface,
      entities = selection.entities,
      area = string.format("%s,%s to %s,%s",
        tostring(selection.left_top and selection.left_top.x), tostring(selection.left_top and selection.left_top.y),
        tostring(selection.right_bottom and selection.right_bottom.x),
        tostring(selection.right_bottom and selection.right_bottom.y)),
      age_ticks = selection.tick,
    } or nil,
    -- One label, so it has to stay short enough to read at a glance: what the row buttons are, then
    -- the one caveat that changes how a number should be read. Where the ask goes is said at the ask.
    -- Renamed rows and new buttons both show up here first: this sentence is the only thing telling a
    -- player what the six buttons on a row are for, so it has to name them as they are named above.
    hint = #list == 0 and "nothing frozen yet -- drag a box with the selection tool and press Freeze box, or fill the form and press Fit + ghosts"
      or "Verify / Why / Power answer about that row; Measure runs it on the bench for real and Status "
        .. "shows claimed against measured; Place puts ghosts down near your character, String fills the "
        .. "field above with a blueprint you can Ctrl+C. A row marked 'planned' was never measured.",
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

  -- The form. Every choice on it is a parameter `solve` already takes; what the panel adds is being
  -- able to say it without knowing the names. The lists come from `model.menus`, built from this
  -- install's prototypes and this force's unlocks -- a machine list remembered in a widget file is
  -- exactly the claim that goes stale against a modpack.
  local frow = frame.add { type = "flow", direction = "horizontal", name = "arch-form-row" }
  frow.add { type = "label", name = "arch-form-label", caption = "make" }
  frow.add { type = "drop-down", name = "arch-form-item",
    items = menu_labels(model.menus and model.menus.items),
    selected_index = menu_index(model.menus and model.menus.items, model.goal and model.goal.item) }
  frow.add { type = "textfield", name = "arch-form-rate",
    text = tostring((model.goal or {}).rate or 1), numeric = true, allow_negative = false, allow_decimal = true }
  frow.add { type = "drop-down", name = "arch-form-unit",
    items = { "/second", "/minute", "/hour" }, selected_index = 2 }
  frow.add { type = "label", caption = "on" }
  frow.add { type = "drop-down", name = "arch-form-machine",
    items = menu_labels(model.menus and model.menus.machines),
    selected_index = menu_index(model.menus and model.menus.machines, model.goal and model.goal.machine) }
  frow.add { type = "label", caption = "modules" }
  frow.add { type = "drop-down", name = "arch-form-module",
    items = menu_labels(model.menus and model.menus.modules),
    selected_index = menu_index(model.menus and model.menus.modules, model.goal and model.goal.module) }
  frow.add { type = "textfield", name = "arch-form-module-count",
    text = tostring((model.goal or {}).module_count or 1), numeric = true, allow_negative = false }
  frow.add { type = "checkbox", name = "arch-form-power", caption = "with power",
    state = (model.goal or {}).power and true or false }
  frow.add { type = "button", name = "arch-plan", caption = "Plan" }
  -- The box the plan has to live in, and the two clicks that use it. Spacing is offered as the three
  -- words because what they mean -- cells of clear aisle between lanes -- is exactly the thing a
  -- player decides about their own factory, and the answer reports the footprint each one costs.
  frow.add { type = "label", caption = "in the box, spacing" }
  frow.add { type = "drop-down", name = "arch-form-spacing",
    items = { "compact", "standard", "loose" }, selected_index = 1 }
  frow.add { type = "button", name = "arch-fit", caption = "Fit" }
  frow.add { type = "button", name = "arch-build", caption = "Fit + ghosts" }
  -- Where the measurement got to, and the click that keeps it. `card_lab` runs on real game time, so
  -- the answer to "is it done" is a button a player presses rather than a number the panel watches:
  -- a window that updated itself every tick would be a window that costs ticks.
  frow.add { type = "button", name = "arch-status", caption = "Measure status" }
  frow.add { type = "button", name = "arch-save", caption = "Keep measurement" }

  -- What the selection tool boxed, and the two clicks that act on it. Read is separate from Freeze on
  -- purpose: reading walks the entities and says what it skipped and why, and a player who boxed the
  -- wrong thing gets one more look before it becomes a card in the save.
  local brow = frame.add { type = "flow", direction = "horizontal", name = "arch-box-row" }
  brow.add { type = "label", name = "arch-box-label",
    caption = model.selection and string.format("boxed: %s entities on %s [%s]",
      tostring(model.selection.entities or "?"), tostring(model.selection.surface or "?"),
      tostring(model.selection.area))
      or "boxed: nothing -- pick the selection tool and drag a rectangle, then come back" }
  brow.add { type = "button", name = "arch-read", caption = "Read box" }
  brow.add { type = "button", name = "arch-freeze", caption = "Freeze box" }

  local tbl = frame.add { type = "table", column_count = 9, name = "arch-cards" }
  for _, h in ipairs({ "card", "entities", "produces", "verify", "why", "power", "measure", "", "" }) do
    tbl.add { type = "label", caption = h }
  end
  for _, card in ipairs(model.cards) do
    tbl.add { type = "label", caption = truncated(card.name, 30) }
    tbl.add { type = "label", caption = tostring(card.entities) }
    tbl.add { type = "label", caption = truncated(card.label, 44) }
    tbl.add { type = "button", name = "arch-verify:" .. card.name, caption = "Verify" }
    tbl.add { type = "button", name = "arch-why:" .. card.name, caption = "Why" }
    tbl.add { type = "button", name = "arch-power:" .. card.name, caption = "Power" }
    tbl.add { type = "button", name = "arch-measure:" .. card.name, caption = "Measure" }
    tbl.add { type = "button", name = "arch-place:" .. card.name, caption = "Place" }
    tbl.add { type = "button", name = "arch-string:" .. card.name, caption = "String" }
  end
  -- The answer goes in the window, not only in chat: a verification is a dozen lines, and the chat
  -- log is where a player loses a line the moment they scroll. Named so `G.show_report` can find it
  -- with the same two-hop lookup the string field uses.
  local report = frame.add { type = "flow", direction = "vertical", name = REPORT }
  report.add { type = "label", name = "arch-report-title",
    caption = "nothing asked yet -- the row buttons answer about one card, the top row about a box or a plan" }
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
  -- An open bound is said as an open bound: `min = 4000, max = nil` is "4000 or more", and printing it
  -- as "4000-4000" would be the same lie a clipped tooltip tells.
  -- The engine writes "no upper bound" as the largest double rather than as an absent key: measured on
  -- `boiler` (pressure 10 to 1.7976931348623e+308) and `wooden-chest` (gravity 0.1 to the same). Said
  -- out loud in a panel row that is an open bound wearing a number, so the bound is dropped when it is
  -- beyond anything a surface answers.
  local UNBOUNDED = 1e300
  local function bound_of(v)
    if type(v) ~= "number" or math.abs(v) >= UNBOUNDED then return nil end
    return v
  end
  local function condition_words(c)
    if c.here == nil then return tostring(c.why or ("this surface does not answer " .. tostring(c.property))) end
    local mn, mx = bound_of(c.need_min), bound_of(c.need_max)
    local want
    if mn ~= nil and mx ~= nil then
      want = mn == mx and ("exactly " .. tostring(mn)) or (tostring(mn) .. " to " .. tostring(mx))
    elseif mn ~= nil then want = "at least " .. tostring(mn)
    elseif mx ~= nil then want = "at most " .. tostring(mx)
    else want = "any value" end
    return "wants " .. tostring(c.property) .. " " .. want .. ", here it is " .. tostring(c.here)
  end
  local function reason(e)
    if type(e) ~= "table" then return tostring(e) end
    local what = e.name or e.code or e.why or e.recipe or e.item or e.at
      or (e.x ~= nil and e.y ~= nil and (tostring(e.x) .. "," .. tostring(e.y))) or ""
    local note = e.msg or e.note
      -- a blocked placement says what it landed ON, which is the only half of the answer a player can
      -- act on: "#3 assembling-machine-1" names the card's own part, "on top of your furnace" is the fact
      or (e.on_top_of and #e.on_top_of > 0 and ("lands on " .. table.concat(list_of(e.on_top_of), ", ")))
      -- A solver candidate says two things at once and `what` only carries the recipe: what it is worth
      -- per craft, and which input it would have to be fed first.
      or (e.blocked_by and ("yields " .. tostring(e.net_per_craft) .. " per craft, needs "
        .. tostring(e.blocked_by)
        .. (e.blocked_demand_per_min and (" at " .. tostring(e.blocked_demand_per_min) .. "/min") or "")))
      or (e.net_per_craft and ("yields " .. tostring(e.net_per_craft) .. " per craft"))
      -- A placement can be refused by the PLANET rather than by the tile or by anything standing on
      -- it: `can_place_entity` answers a bare false for both, so without this the card's report would
      -- blame clear ground for a machine that only stands in zero gravity (`crusher`, measured).
      or (e.surface_refused and ("the planet refuses it: " .. condition_words(e.surface_refused)))
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
  -- One surface report, in the words a player can check. Shared by the plan and the fit answers because
  -- both are claims about a specific planet, and a `fit` that names no surface is the same silence as a
  -- `plan` that does.
  local function surface_words(sv)
    if type(sv) ~= "table" or not sv.surface then return end
    local out = {}
    local vals = {}
    for k, x in pairs(sv.values or {}) do vals[#vals + 1] = tostring(k) .. " " .. tostring(x) end
    table.sort(vals)
    out[#out + 1] = "surface: " .. tostring(sv.surface) .. " (" .. table.concat(vals, ", ") .. ")"
    -- Only the hardware half can appear in a plan that came back at all: a step this ground will not
    -- run is refused by name (`SURFACE_REFUSES_RECIPE`) rather than shown as numbers for a factory that
    -- could never move. So this loop is the report, and the refusal's own words are rendered from
    -- `recipes` in its detail.
    for _, m in ipairs(list_of(sv.machines_built_elsewhere)) do
      out[#out + 1] = "  build it elsewhere: " .. tostring(m.machine) .. " "
        .. truncated(condition_words(m), 120)
    end
    if not sv.machines_built_elsewhere then
      out[#out + 1] = "  nothing on this surface refuses the plan"
    end
    return out
  end

  if not res.ok then
    add("refused: " .. tostring(res.code or "?") .. (res.msg and (" -- " .. tostring(res.msg)) or ""))
    local det = res.detail
    if type(det) == "table" then
      for _, key in ipairs({ "errors", "problems", "candidates", "known", "surfaces", "ingredients",
        "cards", "blockers", "prerequisites", "examples", "verdicts", "loop" }) do
        for _, e in ipairs(list_of(det[key])) do add("  " .. key .. ": " .. truncated(reason(e), 130)) end
      end
      -- A surface refusal lists the steps the ground will not run, and each one is three numbers: the
      -- property, the bound it wants, and what this surface answers. `reason` would print the recipe and
      -- drop the rest, which is the half a player needs.
      for _, r in ipairs(list_of(det.recipes)) do
        add("  refused here: " .. tostring(r.recipe) .. " " .. truncated(condition_words(r), 120))
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
      if type(det.lane_makes) == "table" then
        local m = {}
        for k, v in pairs(det.lane_makes) do m[#m + 1] = tostring(v) .. "/min " .. k end
        table.sort(m)
        add("  the lane makes: " .. table.concat(m, ", "))
      end
      if det.use_instead then add("  instead: " .. truncated(tostring(det.use_instead), 140)) end
      -- The solver's refusals carry a sentence of their own, and it is the part that says what to do
      -- next: research, route, or go and build the thing that is not a recipe. The number beside it is
      -- the same answer in a form a player can use -- how much of the missing item the line wants --
      -- and `item` is named because "24/min" without a unit after it is not an answer.
      if det.why then add("  why: " .. truncated(tostring(det.why), 200)) end
      if det.demand_per_min then
        add("  how much: " .. tostring(det.demand_per_min) .. "/min of " .. tostring(det.item)
          .. ", for the " .. tostring(det.for_target_per_min) .. "/min of "
          .. tostring(det.for_item or "the target") .. " asked for")
      elseif det.demand_per_plan_unit then
        add("  how much: " .. tostring(det.demand_per_plan_unit) .. " of " .. tostring(det.item)
          .. " per unit of what was asked for")
      end
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
  elseif cmd == "scan" then
    local c = d.card or {}
    add("read: " .. tostring(d.entities_kept or 0) .. " entities, "
      .. tostring(d.machines_bound or 0) .. " of them machines with a recipe live in them")
    if c.contract and c.contract.outputs then
      add("claims (nameplate, NOT measured): " .. truncated(rates_of(c.contract.outputs), 130))
      if c.contract.fluid_outputs then
        add("  fluids: " .. truncated(rates_of(c.contract.fluid_outputs), 110))
      end
    end
    if d.claim_how then add("how: " .. truncated(d.claim_how, 160)) end
    for _, k in ipairs(list_of(d.skipped)) do
      add("  skipped: " .. truncated(tostring(k.name) .. " x" .. tostring(k.count or 1)
        .. " -- " .. tostring(k.why), 130))
    end
    add(truncated(d.next or "", 150))
  elseif cmd == "freeze" then
    local f = d.frozen or {}
    add("frozen: " .. tostring(f.name or "?") .. " -- " .. tostring(d.entities or 0) .. " entities, "
      .. (f.measured_this_card == false and "NOT MEASURED" or "carries what it measured"))
    if d.claim_how then add("how: " .. truncated(d.claim_how, 160)) end
    for _, k in ipairs(list_of(d.skipped)) do
      add("  skipped: " .. truncated(tostring(k.name) .. " x" .. tostring(k.count or 1)
        .. " -- " .. tostring(k.why), 130))
    end
  elseif cmd == "plan" then
    local p = d.plan or d
    local shown = d.rate_shown or "?"
    add(string.format("asked for %s %s%s", tostring(shown), tostring(d.item or "?"),
      d.unit_shown and (" " .. (d.unit_shown == "per_second" and "/second"
        or d.unit_shown == "per_hour" and "/hour" or "/minute")) or ""))
    for _, n in ipairs(list_of(d.how_many)) do
      add(string.format("  %s x%s @ %s/min %s%s", tostring(n.machine), tostring(n.count),
        tostring(n.per_machine_per_min), tostring(n.item),
        n.estimated and "  (nameplate -- call drill_rate/pump_rate to measure)" or ""))
      if n.recirculated then
        -- The rate on the row above is what the line gains. This is what the pipe next to the machine
        -- carries, and for kovarex the two differ by forty-one to one.
        add(string.format("    %s of %s goes back in for %s out per craft: a belt here sees %s/min",
          tostring(n.recirculated.per_craft_in), tostring(n.recirculated.item),
          tostring(n.recirculated.per_craft_out), tostring(n.recirculated.gross_per_machine_per_min)))
      end
    end
    for _, c in ipairs(list_of((d.plan or d).in_flight)) do
      add("  needs in the loop, consumes none of it: " .. tostring(c.item) .. " "
        .. tostring(c.per_min) .. "/min (" .. tostring(c.per_craft) .. " per craft, from "
        .. tostring(c.recipe) .. ")")
    end
    for _, c in ipairs(list_of((d.plan or d).cyclic)) do
      add("  recirculated through a loop: " .. tostring(c.item) .. " "
        .. tostring(c.throughput_per_min) .. "/min")
    end
    -- Space Age refuses a plan in two different ways and the window has to keep them apart: a recipe
    -- the ground will not run (the line never moves), and a machine nobody can build there (the
    -- hardware has to arrive, and then the line runs fine).
    for _, l in ipairs(list_of(surface_words((d.plan or d).surface))) do add(l) end
    for _, m in ipairs(list_of(d.modules)) do
      add("  modules: " .. truncated(string.format("%s x%s in %s -- %s", tostring(m.item),
        tostring(m.asked), tostring(m.machine), tostring(m.note)), 140))
    end
    -- Written against what `solve` answers here, measured rather than imagined: `power` splits grid
    -- draw from fuel burn (a plan can be affordable and still unfuelable), `margin` is a NUMBER --
    -- how many times the ground exceeds the plan's intake -- and `needs_measured_margin` says that
    -- number is still prototype arithmetic rather than a measured field.
    local pw = (p.unit or {}).power or {}
    if pw.machine_grid_kw ~= nil or pw.machine_fuel_kw ~= nil then
      add("power: " .. tostring(pw.machine_grid_kw or 0) .. " kW from the grid"
        .. ((tonumber(pw.machine_fuel_kw) or 0) > 0 and (" + " .. tostring(pw.machine_fuel_kw) .. " kW as fuel") or "")
        .. ((tonumber(pw.emissions_per_sec) or 0) > 0
          and ("; " .. string.format("%.2f", pw.emissions_per_sec) .. " pollution/s") or ""))
    end
    if p.margin ~= nil then
      add("ground: the map holds " .. tostring(p.margin) .. "x this plan's intake"
        .. (p.needs_measured_margin and "  (estimated from prototype ratings -- not measured)" or ""))
    end
    for _, pre in ipairs(list_of(p.prerequisites)) do
      add("  needs research: " .. truncated(tostring(pre.technology or pre.name or pre)
        .. (pre.unlocks and (" (unlocks " .. tostring(pre.unlocks) .. ")") or ""), 120))
    end
    for _, cnd in ipairs(list_of(p.candidates)) do
      add("  could also make: " .. truncated(reason(cnd), 120))
    end
  elseif cmd == "measure" then
    add(string.format("measuring: job %s, %s on the bench, state %s",
      tostring(d.job), tostring((d.run_ticks or 0) / 60) .. "s of game time", tostring(d.state)))
    add(string.format("expected %s/min from the card's claim; %d entities, %d feeds, %d collectors",
      tostring(d.expected_per_min), tostring(d.entities or 0),
      tostring(d.feeds or 0), tostring(d.collectors or 0)))
    if d.unwired_inputs then
      add("  unwired: " .. #list_of(d.unwired_inputs) .. " fluid port(s) the bench could not feed")
    end
    add("press Measure status when it should be done -- the rig runs on game time, not on this window")
  elseif cmd == "status" then
    add(string.format("job %s is %s: %s of %s ticks in",
      tostring(d.job), tostring(d.state), tostring(d.elapsed_ticks),
      tostring((d.elapsed_ticks or 0) + (d.remaining_ticks or 0))))
    if d.state == "running" or d.state == "probing" then
      add(string.format("so far %s/min measured against %s/min claimed -- not a verdict yet",
        tostring(d.measured_per_min or "?"), tostring(d.expected_per_min or "?")))
    end
    for _, v in ipairs(list_of(d.verdicts)) do
      add(string.format("  %s claimed %s/min, measured %s/min -- %s%s",
        tostring(v.item), tostring(v.claimed_per_min), tostring(v.measured_per_min),
        v.met and "met" or "NOT MET",
        (v.ratio and tonumber(v.ratio) and string.format(" (%.0f%%)", (tonumber(v.ratio) or 0) * 100)) or ""))
    end
    if d.delivered == false then
      add("the card cannot pay its own claim -- Keep measurement will refuse until the layout or the claim changes")
    elseif d.delivered == true then
      add("delivered. Keep measurement writes these numbers onto " .. tostring(d.card or "the card") .. ".")
    end
    if d.abandoned_because then
      add("ended early: " .. truncated(tostring(d.abandoned_because), 120))
    end
  elseif cmd == "save" then
    add(d.frozen and string.format("kept: %s now carries the measured rate -- %s",
      tostring(d.name), truncated(rates_of(d.measured), 90))
      or "refused: " .. tostring(res.code or "?") .. " -- " .. truncated(res.msg, 130))
    if d.measured_this_card == false then add("  NOT MEASURED -- this card still carries a claim, not a measurement") end
  elseif cmd == "fit" or cmd == "build" then
    local b = d.built or {}
    if d.box then
      add(string.format("box: %sx%s on %s, lane is %sx%s (%s, %s cells of aisle)",
        tostring(d.box.w), tostring(d.box.h), tostring(d.box.surface),
        tostring((d.lane or {}).footprint and d.lane.footprint.width),
        tostring((d.lane or {}).footprint and d.lane.footprint.height),
        tostring((d.lane or {}).spacing), tostring((d.lane or {}).gap)))
      add(string.format("fits %s lanes (%s per row x %s rows), wanted %s",
        tostring(d.lanes_fit), tostring(d.per_row), tostring(d.rows), tostring(d.lanes_wanted)))
      add(string.format("that is %s/min of what %s would need -- %s",
        tostring(d.rate_placed), tostring(d.rate_wanted),
        d.fits and "the plan fits" or string.format("%d lanes short (%s/min less)",
          tostring(d.shortfall_lanes), tostring((d.shortfall_lanes or 0) * ((d.lane or {}).per_lane_rate or 0)))))
    end
    -- The ghosts are going into THIS ground, so the ground is the one that gets to object. Same two
    -- news as the plan row: a recipe that cannot run here was refused before reaching this answer, and
    -- what is left to say is which hardware has to be built somewhere else and carried in.
    for _, l in ipairs(list_of(surface_words(d.surface))) do add(l) end
    if b.card then
      local p = b.placed or {}      add("built: " .. tostring(b.card) .. ", " .. tostring(b.composed) .. " entities from "
        .. tostring(b.lanes_used) .. " lanes")
      if p.ghosts then
        local refused = list_of(p.refused)
        add(string.format("ghosts: %d at %s,%s on %s, refused %d",
          tostring(p.ghosts), tostring(p.origin and p.origin.x), tostring(p.origin and p.origin.y),
          tostring((d.box or {}).surface or "?"), #refused))
        for _, e in ipairs(refused) do add("  refused: " .. truncated(reason(e), 120)) end
      elseif b.refused then
        add("refused: " .. tostring(b.refused.code) .. " -- " .. truncated(b.refused.msg, 130))
        local g = (b.refused.detail or {}).ground
        if g then add("  ground: " .. tostring(g.tile or "?") .. (g.generated == false and " (not generated)" or "")) end
      end
    end
    add(truncated(d.next or "", 150))
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

local function read_form(player)
  local frame = player.gui and player.gui.screen and player.gui.screen[ROOT]
  if not frame then return nil end
  local row = frame["arch-form-row"]
  if not row then return nil end
  local function idx(name) return (row[name] or {}).selected_index end
  local power = row["arch-form-power"]
  return {
    item_index = idx("arch-form-item"),
    machine_index = idx("arch-form-machine"),
    module_index = idx("arch-form-module"),
    unit_index = idx("arch-form-unit"),
    rate = tonumber((row["arch-form-rate"] or {}).text),
    module_count = tonumber((row["arch-form-module-count"] or {}).text),
    power = power and power.state or false,
    spacing_index = idx("arch-form-spacing"),
    spacing = ({ "compact", "standard", "loose" })[idx("arch-form-spacing") or 1],
  }
end

-- Fit, and fit-then-lay. Both take the form plus the box the player dragged; `lanes` is the count the
-- plan asked for, which is why Fit runs first -- a Build with no box is refused with a sentence about
-- what a box is, not a crash.
local function fit_or_build(player, cmd, model, api)
  local form = read_form(player) or {}
  local sel = model.selection
  if not sel then
    local out = G.report_lines(cmd == "arch-fit" and "fit" or "build", "",
      { ok = false, code = "NO_SELECTION", msg = "drag a rectangle with the selection tool first -- this lays lanes INSIDE it" })
    G.show_report(player, out.title, out.lines)
    return cmd == "arch-fit" and "fit" or "build", out
  end
  local res = api.fit(form, sel, cmd == "arch-build")
  local out = G.report_lines(cmd == "arch-fit" and "fit" or "build",
    tostring(form.item_index or "?"), res)
  G.show_report(player, out.title, out.lines)
  return cmd == "arch-fit" and "fit" or "build", res
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
  if element_name == "arch-status" or element_name == "arch-save" then
    local is_status = element_name == "arch-status"
    local res = is_status and api.progress() or api.save_measurement()
    local out = G.report_lines(is_status and "status" or "save", "", res)
    G.show_report(player, out.title, out.lines)
    return is_status and "status" or "save", res
  end
  if element_name == "arch-fit" or element_name == "arch-build" then
    return fit_or_build(player, element_name, model, api)
  end
  if element_name == "arch-plan" then
    local form = read_form(player)
    local res = api.plan(form or {})
    local out = G.report_lines("plan", tostring((form or {}).item_index or "?"), res)
    G.show_report(player, out.title, out.lines)
    return "plan", res
  end
  if element_name == "arch-ask" or element_name == "arch-queue" then
    return ask_or_queue(player, element_name, model, api)
  end
  if element_name == "arch-read" or element_name == "arch-freeze" then
    local is_read = element_name == "arch-read"
    local res = (is_read and api.scan or api.freeze_scan)()
    local out = G.report_lines(is_read and "scan" or "freeze",
      tostring((model.selection or {}).area or "nothing boxed"), res)
    G.show_report(player, out.title, out.lines)
    return is_read and "scan" or "freeze", res
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
  elseif cmd == "arch-verify" or cmd == "arch-why" or cmd == "arch-power" or cmd == "arch-measure" then
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
