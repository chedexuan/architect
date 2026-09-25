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
-- Every sentence here is a key, and the words behind it live in `locale/en` and `locale/zh-CN`: the
-- window is in the language of whoever is looking at it, while the values inside the sentences stay the
-- prototype ids and numbers the RCON answer uses. See `L` below for why that split is free.

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
  -- A localized table has nothing to cut: its words are chosen by whoever is looking at the window,
  -- and cutting it would mean cutting the numbers the sentence is about.
  if type(s) == "table" then return s end
  s = tostring(s or "")
  -- Compare like with like: `n` counts CHARACTERS and `#s` counts BYTES, so a fast path on `#s` used
  -- to decide a 27-character CJK name (81 bytes) did not fit in 30 and append an ellipsis to a string
  -- that was never cut.
  local keep = host.clip(s, n or 40)
  if #keep >= #s then return s end
  if keep == "" then return "..." end
  return keep .. "..."
end


-- Captions were English on purpose for a long time, and that reason has now been measured to be the
-- wrong reason: the claim was "the JSON the designer reads has the same words in it". It does not need
-- to. 2.0 resolves a LocalisedString table on the CLIENT, in each viewer's own language, and the game
-- ships its own zh-CN strings for every vanilla item, entity and fluid -- so a window can be Chinese
-- while the RCON answer stays the exact prototype id the agent parses. One name for one thing is kept;
-- what goes is the idea that the player's language has to be the protocol's language.
--
-- `L` builds those tables. The words themselves live in `locale/en/architect.cfg` and
-- `locale/zh-CN/architect.cfg`, and `dev/locale_check.js` fails the build if a key is used without
-- being in both files (or sits in a file unused) -- a headless run cannot read a window, so that
-- cross-check is the only thing standing between a renamed key and a player seeing `architect.foo`
-- where a button caption should be.
local function L(key, ...)
  local out = { "architect." .. key }
  -- `select("#")` rather than `ipairs`: a hole in the middle of the parameter list would drop every
  -- parameter after it, and the sentence would be read with `__3__` still in it. A field the method did
  -- not answer is written the way `tostring` wrote it for years -- as `nil` -- because that is what a
  -- suite asserts on and what tells a player the answer is missing rather than empty.
  for i = 1, select("#", ...) do
    local p = select(i, ...)
    local t = type(p)
    if p == nil then p = "nil" elseif t ~= "string" and t ~= "table" then p = tostring(p) end
    out[i + 1] = p
  end
  return out
end
G.L = L   -- the self-test reads the keys back out of the tree, and the report layer will need it too

-- One table, as the single string a headless run can compare against. `tostring` on a caption prints
-- `table: 0x…`, which is the shape of every assertion that would otherwise be able to read it, so the
-- self-test flattens instead: key and parameters joined, nested tables folded the same way.
-- `dev/lines.js` turns that back into the English sentence by substituting the `en` file -- which is
-- what lets a suite keep quoting words a player would recognise while the Lua holds only keys, and
-- what makes an undefined key fail the run rather than pass it with a hole in the middle.
local function flat(v)
  if type(v) ~= "table" then return tostring(v) end
  local parts = {}
  for _, x in ipairs(v) do parts[#parts + 1] = flat(x) end
  -- A list headed by `""` is Factorio's concatenation form, and it has no fixed arity -- so it gets
  -- delimiters. Without them `~a|b~` would be indistinguishable from two parameters and the resolver
  -- reading this back would put `b` in the wrong hole of the sentence.
  if v[1] == "" then return "~|" .. table.concat(parts, "|", 2) .. "|~" end
  return table.concat(parts, "|")
end
G.flat = flat

-- A whole report, flattened. The self-test hands a suite the lines it is about to put in the window,
-- and an array of tables over RCON is a shape nobody can grep -- one string per line, same grammar as
-- `flat`, is what `dev/lines.js` reads back into words.
function G.flat_lines(arr)
  local out = {}
  for i, l in ipairs(arr or {}) do out[i] = flat(l) end
  return out
end

-- Several of one thing on one line -- the rates a card claims, the properties a surface answers --
-- assembled the way the game assembles its own: a concatenation list, so each element keeps its own
-- key and the line still resolves in the viewer's language.
local function join(parts, sep)
  local out = { "" }
  for i, p in ipairs(parts or {}) do
    if i > 1 then out[#out + 1] = sep end
    out[#out + 1] = p
  end
  if #out == 1 then out[2] = "" end
  return out
end

-- A name the way the player's own client says it. `localised_name` is the prototype's answer rather
-- than a list this mod keeps, so 铁板 and `iron-plate` come out of the same line of code and there is
-- nothing here to be wrong about. When the name is not a prototype on this install -- a card name, a
-- refusal code, a coordinate -- it goes back as it came, because an entry in a LocalisedString whose
-- key no locale defines renders as the raw key: a guess would read to a Chinese player as
-- `item-name.copper-ore2` instead of as the plain string it is.
--
-- `kind` is which unified list to look in first (`entity`, `item`, `fluid`, `recipe`, `technology`);
-- left out, the lookup tries them in that order, which is what an entry that could be any of them
-- (`blockers` name a machine, a candidate names a recipe) needs.
local nm_cache = {}
local NM_ORDER = { "entity", "item", "fluid", "recipe", "technology", "tile", "surface" }
local function nm_in(kind, name)
  -- `prototypes` is userdata, measured: `type(prototypes)` says `userdata`, so a guard written as a
  -- table check silently turns every lookup into a fallback and the window keeps showing ids. And
  -- reading a group that this install does not have (`prototypes["surface-property"]`) is a RAISE, not
  -- a nil -- so the whole two-step lookup goes inside the pcall, which is also what makes an unknown
  -- name come back as nil rather than as an error in a click handler.
  local ok, proto = pcall(function()
    local group = prototypes[kind]
    return group and group[name]
  end)
  if not ok or proto == nil then return nil end
  local ln = host.localised(proto)
  if type(ln) == "table" then return ln end
  if type(ln) == "string" and ln ~= "" then return ln end
  return nil
end

local function NM(name, kind)
  if type(name) ~= "string" or name == "" then return name end
  local cache_key = (kind or "*") .. "\1" .. name
  local hit = nm_cache[cache_key]
  if hit ~= nil then return hit end
  local out = name
  if kind then
    out = nm_in(kind, name) or name
  else
    for _, k in ipairs(NM_ORDER) do
      local found = nm_in(k, name)
      if found then out = found break end
    end
  end
  nm_cache[cache_key] = out
  return out
end
G.NM = NM

-- A value the method answers with one of a short fixed set of words -- a lane spacing, a job state --
-- said in the panel's words when they are known. New states keep showing up on the bench, so a value
-- with no row here reads as the raw state rather than as nothing, and every key is spelled out because
-- a key assembled at runtime is a key `dev/locale_check.js` cannot prove is defined.
local SPACING_WORDS = {
  compact = L("spacing-compact"), standard = L("spacing-standard"), loose = L("spacing-loose"),
}
local STATE_WORDS = {
  open = L("state-open"), answered = L("state-answered"), running = L("state-running"),
  proving = L("state-proving"), probing = L("state-probing"), done = L("state-done"),
  supply_unproven = L("state-supply-unproven"), abandoned = L("state-abandoned"),
  error = L("state-error"),
}
local function word(map, value)
  return map[value] or tostring(value)
end

-- A menu arrives from the method as a list of {value, label} pairs so the widget can show something a
-- player recognises while the value stays the prototype name the solver wants. `chosen` is the value to
-- land on, which is how a panel re-opened after a plan keeps showing what was asked for.
-- A menu row shows the name the player's own client has for the thing -- 铁板 on a Chinese client,
-- `iron-plate` on an English one, both straight out of the game's locale files rather than a list this
-- mod keeps -- with the prototype id beside it, because that id is what the JSON answer and any
-- conversation with the designer use. The `value` behind it stays the id, so nothing about how the
-- choice is resolved changes with the wording.
local function menu_labels(list)
  local out = {}
  for _, e in ipairs(list or {}) do
    local name, id = e.localised, tostring(e.label or e.value)
    if type(name) == "table" then
      out[#out + 1] = { "", name, " (", id, ")" }
    else
      out[#out + 1] = id
    end
  end
  if #out == 0 then out[1] = L("nothing-available") end
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
      label = #outputs == 0 and L("card-no-exports") or (function()
        local parts = {}
        for _, o in ipairs(outputs) do
          -- `%g` rather than `tostring`, because that is what this row has always printed: a rate of
          -- a third is `0.333333` here and not fifteen digits of a number nobody can read.
          local rate = string.format("%g", o.per_min)
          parts[#parts + 1] = rec.measured_this_card == false
            and L("card-rate-planned", rate, NM(o.item, "item"))
            or L("card-rate", rate, NM(o.item, "item"))
        end
        -- The row used to be cut at 44 characters, which is a cut a Chinese client cannot make the
        -- same way (the words are shorter, the ids are not). Counting products instead keeps the table
        -- the width it is and says out loud that something is folded away.
        local shown = {}
        for i = 1, math.min(#parts, 4) do shown[#shown + 1] = parts[i] end
        if #parts > 4 then shown[#shown + 1] = L("card-more", #parts - 4) end
        return join(shown, ", ")
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
    -- Which sentence the window shows is a decision, so it is made here -- but what it picks is a
    -- localized string, not a key the build would have to look up by name. A key assembled at runtime
    -- out of a prefix and a variable is a key no static check can prove is defined, and the failure
    -- that goes unproven is a player reading a raw key where a sentence should be.
    hint = #list == 0 and L("hint-empty") or L("hint-rows"),
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
  flow.add { type = "button", name = "arch-refresh", caption = L("refresh") }
  flow.add { type = "button", name = "arch-close", caption = L("close") }

  -- A blueprint string in chat cannot be selected, which makes it useless: the whole point of the
  -- string is pasting it into the game or sending it to someone. A text field can be, and selecting
  -- it on the way in means one Ctrl+C is the whole interaction.
  local srow = frame.add { type = "flow", direction = "horizontal", name = "arch-string-row" }
  srow.add { type = "label", name = "arch-string-label", caption = L("blueprint-label") }
  srow.add { type = "textfield", name = "arch-string-out", text = "" }

  -- The player's only input. A text field rather than a chat command, because the answer comes back
  -- into this window beside the question instead of into a log that scrolls away. The label says what
  -- this mod actually does with the words: it holds them. Nothing here can answer them.
  local arow = frame.add { type = "flow", direction = "horizontal", name = "arch-ask-row" }
  arow.add { type = "label", name = "arch-ask-label", caption = L("ask-label") }
  arow.add { type = "textfield", name = "arch-ask-in", text = "" }
  arow.add { type = "button", name = "arch-ask", caption = L("ask") }
  arow.add { type = "button", name = "arch-queue", caption = L("queue") }

  -- The form. Every choice on it is a parameter `solve` already takes; what the panel adds is being
  -- able to say it without knowing the names. The lists come from `model.menus`, built from this
  -- install's prototypes and this force's unlocks -- a machine list remembered in a widget file is
  -- exactly the claim that goes stale against a modpack.
  local frow = frame.add { type = "flow", direction = "horizontal", name = "arch-form-row" }
  frow.add { type = "label", name = "arch-form-label", caption = L("form-make") }
  frow.add { type = "drop-down", name = "arch-form-item",
    items = menu_labels(model.menus and model.menus.items),
    selected_index = menu_index(model.menus and model.menus.items, model.goal and model.goal.item) }
  frow.add { type = "textfield", name = "arch-form-rate",
    text = tostring((model.goal or {}).rate or 1), numeric = true, allow_negative = false, allow_decimal = true }
  frow.add { type = "drop-down", name = "arch-form-unit",
    items = { L("unit-second"), L("unit-minute"), L("unit-hour") }, selected_index = 2 }
  frow.add { type = "label", caption = L("form-on") }
  frow.add { type = "drop-down", name = "arch-form-machine",
    items = menu_labels(model.menus and model.menus.machines),
    selected_index = menu_index(model.menus and model.menus.machines, model.goal and model.goal.machine) }
  frow.add { type = "label", caption = L("form-modules") }
  frow.add { type = "drop-down", name = "arch-form-module",
    items = menu_labels(model.menus and model.menus.modules),
    selected_index = menu_index(model.menus and model.menus.modules, model.goal and model.goal.module) }
  frow.add { type = "textfield", name = "arch-form-module-count",
    text = tostring((model.goal or {}).module_count or 1), numeric = true, allow_negative = false }
  frow.add { type = "checkbox", name = "arch-form-power", caption = L("form-with-power"),
    state = (model.goal or {}).power and true or false }
  frow.add { type = "button", name = "arch-plan", caption = L("plan") }
  -- The box the plan has to live in, and the two clicks that use it. Spacing is offered as the three
  -- words because what they mean -- cells of clear aisle between lanes -- is exactly the thing a
  -- player decides about their own factory, and the answer reports the footprint each one costs.
  frow.add { type = "label", caption = L("form-in-box") }
  frow.add { type = "drop-down", name = "arch-form-spacing",
    -- the three words the player picks; `read_form` maps the CHOSEN ROW back to the id the solver takes, so
    -- translating these labels cannot move a spacing value
    items = { L("spacing-compact"), L("spacing-standard"), L("spacing-loose") }, selected_index = 1 }
  frow.add { type = "button", name = "arch-fit", caption = L("fit") }
  frow.add { type = "button", name = "arch-build", caption = L("fit-ghosts") }
  -- Where the measurement got to, and the click that keeps it. `card_lab` runs on real game time, so
  -- the answer to "is it done" is a button a player presses rather than a number the panel watches:
  -- a window that updated itself every tick would be a window that costs ticks.
  frow.add { type = "button", name = "arch-status", caption = L("measure-status") }
  frow.add { type = "button", name = "arch-save", caption = L("keep-measurement") }
  -- Taking back what the panel laid. It sits here rather than on a card's row because the stack is not
  -- per card: the last thing placed is the first thing that goes back, whichever row it came from.
  frow.add { type = "button", name = "arch-undo", caption = L("place-undo") }

  -- What the selection tool boxed, and the two clicks that act on it. Read is separate from Freeze on
  -- purpose: reading walks the entities and says what it skipped and why, and a player who boxed the
  -- wrong thing gets one more look before it becomes a card in the save.
  local brow = frame.add { type = "flow", direction = "horizontal", name = "arch-box-row" }
  brow.add { type = "label", name = "arch-box-label",
    -- The surface goes through as the word the save calls it, because a surface has no prototype to
    -- take a name from: `nauvis` is what the player typed in the create-screen, and `arch-sandbox` is
    -- what this mod made, and neither is a key the game's locale files know.
    caption = model.selection and L("boxed", tostring(model.selection.entities or "?"),
      tostring(model.selection.surface or "?"), tostring(model.selection.area))
      or L("boxed-nothing") }
  brow.add { type = "button", name = "arch-read", caption = L("read-box") }
  brow.add { type = "button", name = "arch-freeze", caption = L("freeze-box") }

  local tbl = frame.add { type = "table", column_count = 9, name = "arch-cards" }
  -- Spelled out one by one rather than assembled from a prefix at runtime, because the locale check
  -- reads the keys this file uses out of this file: a key built by string concatenation is a key no
  -- static check can prove is defined, and what goes unproven is a player reading a raw key where a
  -- table header should be. Nine labels because the last two columns hold buttons and have no heading.
  for _, h in ipairs({ L("column-card"), L("column-entities"), L("column-produces"), L("column-verify"),
    L("column-why"), L("column-power"), L("column-measure"), "", "" }) do
    tbl.add { type = "label", caption = h }
  end
  for _, card in ipairs(model.cards) do
    tbl.add { type = "label", caption = truncated(card.name, 30) }
    tbl.add { type = "label", caption = tostring(card.entities) }
    tbl.add { type = "label", caption = truncated(card.label, 44) }
    tbl.add { type = "button", name = "arch-verify:" .. card.name, caption = L("verify") }
    tbl.add { type = "button", name = "arch-why:" .. card.name, caption = L("why") }
    tbl.add { type = "button", name = "arch-power:" .. card.name, caption = L("power") }
    tbl.add { type = "button", name = "arch-measure:" .. card.name, caption = L("measure") }
    tbl.add { type = "button", name = "arch-place:" .. card.name, caption = L("place") }
    tbl.add { type = "button", name = "arch-string:" .. card.name, caption = L("string") }
  end
  -- The answer goes in the window, not only in chat: a verification is a dozen lines, and the chat
  -- log is where a player loses a line the moment they scroll. Named so `G.show_report` can find it
  -- with the same two-hop lookup the string field uses.
  local report = frame.add { type = "flow", direction = "vertical", name = REPORT }
  report.add { type = "label", name = "arch-report-title", caption = L("report-idle") }
  return frame
end

-- Which verb this answer belongs to, said in the window's words. The English column is deliberately the
-- same string the method and the JSON use -- `plan`, `scan`, `save` -- so a suite that reads the header
-- back is still matching the verb it clicked, and only the player sees 算一下.
local VERB_WORDS = {
  verify = L("verb-verify"), why = L("verb-why"), power = L("verb-power"),
  measure = L("verb-measure"), status = L("verb-status"), save = L("verb-save"),
  plan = L("verb-plan"), fit = L("verb-fit"), build = L("verb-build"),
  string = L("verb-string"), scan = L("verb-scan"), freeze = L("verb-freeze"),
  place = L("verb-place"), ask = L("verb-ask"), queue = L("verb-queue"),
  undo = L("verb-undo"),
}
local function titled(cmd, name)
  return L("title-line", VERB_WORDS[cmd] or tostring(cmd), tostring(name))
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
  -- A thing that can be either: an output rate names an item or a fluid, and the two live in different
  -- lists with the same id (`pipe` is both, and the game's own word for each is different).
  local function NMI(name)
    local as_item = NM(name, "item")
    if as_item ~= name then return as_item end
    return NM(name, "fluid")
  end
  local function condition_words(c)
    if c.here == nil then
      return tostring(c.why or L("c-no-answer", NM(c.property, "surface_property")))
    end
    local mn, mx = bound_of(c.need_min), bound_of(c.need_max)
    local want
    if mn ~= nil and mx ~= nil then
      want = mn == mx and L("c-exactly", mn) or L("c-range", mn, mx)
    elseif mn ~= nil then want = L("c-at-least", mn)
    elseif mx ~= nil then want = L("c-at-most", mx)
    else want = L("c-any") end
    return L("c-wants", NM(c.property, "surface_property"), want, c.here)
  end
  -- A cut that works on either shape a line can be: a string is clipped to the window's width, and a
  -- table has its parts clipped, because a sentence can be short while the message inside it is long.
  local function clip(v, n)
    if type(v) ~= "table" then return truncated(v, n) end
    local out = {}
    for i, x in ipairs(v) do out[i] = clip(x, n) end
    return out
  end
  local function reason(e)
    if type(e) ~= "table" then return tostring(e) end
    local what = (e.name and NM(e.name)) or e.code
      or (e.why and tostring(e.why)) or (e.recipe and NM(e.recipe, "recipe")) or (e.item and NMI(e.item))
      or (e.at and tostring(e.at))
      or (e.x ~= nil and e.y ~= nil and (tostring(e.x) .. "," .. tostring(e.y))) or ""
    local note = (e.msg and tostring(e.msg)) or (e.note and tostring(e.note))
      -- a blocked placement says what it landed ON, which is the only half of the answer a player can
      -- act on: "#3 assembling-machine-1" names the card's own part, "on top of your furnace" is the fact
      or (e.on_top_of and #e.on_top_of > 0
        and L("r-lands-on", join((function()
          local out = {}
          for _, x in ipairs(list_of(e.on_top_of)) do out[#out + 1] = NM(x) end
          return out
        end)(), ", ")))
      -- A solver candidate says two things at once and `what` only carries the recipe: what it is worth
      -- per craft, and which input it would have to be fed first.
      or (e.blocked_by and (e.blocked_demand_per_min
        and L("r-yields-needs", e.net_per_craft, NMI(e.blocked_by), e.blocked_demand_per_min)
        or L("r-yields-needs-bare", e.net_per_craft, NMI(e.blocked_by))))
      or (e.net_per_craft and L("r-yields", e.net_per_craft))
      -- A placement can be refused by the PLANET rather than by the tile or by anything standing on
      -- it: `can_place_entity` answers a bare false for both, so without this the card's report would
      -- blame clear ground for a machine that only stands in zero gravity (`crusher`, measured).
      or (e.surface_refused and L("r-planet", condition_words(e.surface_refused)))
      or ""
    -- `at` is which entity of the card, and for a placement refusal it is the whole point: "a
    -- steel-chest is in the way" is a shrug, "#7 of this card lands on a steel-chest" is actionable.
    if what == "" and note == "" then return nil end
    if type(e.at) == "number" and e.name then return clip(L("r-entry-idx", e.at, what, note), 130) end
    return clip(L("r-entry", what, note), 130)
  end
  local function rates_of(t)
    local out = {}
    for k, v in pairs(type(t) == "table" and t or {}) do out[#out + 1] = { name = k, rate = v } end
    table.sort(out, function(a, b) return a.name < b.name end)
    local parts = {}
    for _, e in ipairs(out) do parts[#parts + 1] = L("rate", e.rate, NMI(e.name)) end
    return join(parts, ", ")
  end
  -- One surface report, in the words a player can check. Shared by the plan and the fit answers because
  -- both are claims about a specific planet, and a `fit` that names no surface is the same silence as a
  -- `plan` that does.
  local function surface_words(sv)
    if type(sv) ~= "table" or not sv.surface then return end
    local out = {}
    local vals = {}
    for k, x in pairs(sv.values or {}) do vals[#vals + 1] = { k = k, x = x } end
    table.sort(vals, function(a, b) return a.k < b.k end)
    local parts = {}
    for _, e in ipairs(vals) do parts[#parts + 1] = L("u-value", NM(e.k, "surface_property"), e.x) end
    out[#out + 1] = L("u-surface", NM(sv.surface, "surface"), join(parts, ", "))
    -- Only the hardware half can appear in a plan that came back at all: a step this ground will not
    -- run is refused by name (`SURFACE_REFUSES_RECIPE`) rather than shown as numbers for a factory that
    -- could never move. So this loop is the report, and the refusal's own words are rendered from
    -- `recipes` in its detail.
    for _, m in ipairs(list_of(sv.machines_built_elsewhere)) do
      out[#out + 1] = L("u-elsewhere", NM(m.machine, "entity"), condition_words(m))
    end
    if not sv.machines_built_elsewhere then
      out[#out + 1] = L("u-clear")
    end
    return out
  end

  -- Which of the detail lists is being walked, in the panel's words. A field name is what the RCON
  -- answer calls it and what a designer greps for; this is the half a player reads, and "candidates"
  -- is not a word that means anything at 3am next to a factory that will not fit.
  local GROUP_WORDS = {
    errors = L("grp-errors"), problems = L("grp-problems"), candidates = L("grp-candidates"),
    known = L("grp-known"), surfaces = L("grp-surfaces"), ingredients = L("grp-ingredients"),
    cards = L("grp-cards"), blockers = L("grp-blockers"), prerequisites = L("grp-prerequisites"),
    examples = L("grp-examples"), verdicts = L("grp-verdicts"), loop = L("grp-loop"),
  }
  -- An entry that names nothing and says nothing used to come out as a single space, which is what the
  -- one caller that cares could recognise. Nil is the honest shape of that, and every other caller has
  -- to be told to pass an empty string into the sentence instead of a hole.
  local function or_blank(v) return v == nil and "" or v end

  if not res.ok then
    add(res.msg and L("r-refused-msg", res.code or "?", tostring(res.msg))
      or L("r-refused", res.code or "?"))
    local det = res.detail
    if type(det) == "table" then
      for _, key in ipairs({ "errors", "problems", "candidates", "known", "surfaces", "ingredients",
        "cards", "blockers", "prerequisites", "examples", "verdicts", "loop" }) do
        for _, e in ipairs(list_of(det[key])) do
          add(L("r-detail", GROUP_WORDS[key] or key, or_blank(reason(e))))
        end
      end
      -- A surface refusal lists the steps the ground will not run, and each one is three numbers: the
      -- property, the bound it wants, and what this surface answers. `reason` would print the recipe and
      -- drop the rest, which is the half a player needs.
      for _, r in ipairs(list_of(det.recipes)) do
        add(L("r-refused-here", NM(r.recipe, "recipe"), condition_words(r)))
      end
      -- A plantation item comes through the same refusal code as an asteroid chunk and is quite another
      -- piece of news: the plant states its own growth timer and what one harvest hands back, so the
      -- answer is a number of plants standing. It arrives either on the refusal (`solve yumako`) or on
      -- the candidate that ran out at it (`solve wooden-chest`, which is blocked on wood), and either
      -- way it gets the same three lines. The tower is not one of them, and the last line says so
      -- rather than dividing by a tile count nobody read off anything.
      local farms = {}
      if type(det.farm) == "table" then farms[#farms + 1] = det.farm end
      for _, c in ipairs(list_of(det.candidates)) do
        if type(c.farm) == "table" then farms[#farms + 1] = c.farm end
      end
      local said = {}
      for _, fm in ipairs(farms) do
        if not said[fm.item] then
          said[fm.item] = true
          add(L("r-farm-grown", NMI(fm.item), NM(fm.plant, "entity"), NMI(fm.seed), fm.per_plant,
            fm.growth_minutes))
          if fm.plants_standing then
            add(L("r-farm-need", fm.demand_per_min, NMI(fm.item), fm.harvests_per_min,
              fm.plants_standing, fm.seeds_per_min))
          else
            add(L("r-farm-plot", fm.per_min_per_1000_plants))
          end
          add(L("r-farm-notower"))
        end
      end
      -- `wanted` is not a `blockers` list: these are the parts the card tried to put down where
      -- nothing stands, so labelling them obstacles would be the same lie in a new font.
      for _, e in ipairs(list_of(det.wanted)) do
        add(L("r-would-place", or_blank(reason(e))))
      end
      if type(det.ground) == "table" then
        add(L("r-ground", det.ground.tile and L("r-ground-tile", NM(det.ground.tile, "tile"))
          or L("r-ground-none"),
          det.ground.generated == false and L("r-ground-ungenerated") or ""))
      end
      -- Where it tried and failed, as its own line: `blockers` says what is in the way and `origin`
      -- says where, and a player needs the second one to know whether the first is worth moving.
      if type(det.origin) == "table" then
        add(det.origin.surface
          and L("r-at-on", det.origin.x, det.origin.y, NM(det.origin.surface, "surface"))
          or L("r-at", det.origin.x, det.origin.y))
      end
      -- ...and a detail that IS the list rather than a bag of them: `NO_CLEAR_SITE` carries the four
      -- origins it tried, and a refusal that names where it looked is the difference between "it would
      -- not fit" and "move it off the refinery".
      local bare = {}
      for _, e in ipairs(list_of(det)) do
        local w = reason(e)
        if w then bare[#bare + 1] = w end
      end
      if #bare > 0 then add(L("r-named", join(bare, "; "))) end
      if type(det.lane_makes) == "table" then
        add(L("r-lane-makes", rates_of(det.lane_makes)))
      end
      if det.use_instead then add(L("r-instead", tostring(det.use_instead))) end
      -- The solver's refusals carry a sentence of their own, and it is the part that says what to do
      -- next: research, route, or go and build the thing that is not a recipe. The number beside it is
      -- the same answer in a form a player can use -- how much of the missing item the line wants --
      -- and `item` is named because "24/min" without a unit after it is not an answer.
      --
      -- Except for a farm, whose `why` is those same numbers in English: printing both would be one
      -- sentence twice, once in the player's language and once not, and the second half is exactly what
      -- the window is meant to be free of (see #31 for when the data layer's prose gets keys of its own).
      if det.why and #farms == 0 then add(L("r-why", tostring(det.why))) end
      if det.demand_per_min then
        add(L("r-how-much", det.demand_per_min, NMI(det.item), det.for_target_per_min,
          det.for_item and NMI(det.for_item) or L("w-target")))
      elseif det.demand_per_plan_unit then
        add(L("r-how-much-unit", det.demand_per_plan_unit, NMI(det.item)))
      end
      if det.reason then add(L("r-reason", tostring(det.reason))) end
      if det.pole then add(L("r-pole", tostring(det.pole))) end
    end
    -- `#lines == 0` here could never happen -- the code line above always lands first -- so the check
    -- that the branch exists for had to be written against the one thing that varies: whether anything
    -- came after the code.
    if #lines == 1 then add(L("r-alone")) end
    return { title = titled(cmd, name), lines = lines }
  end

  if cmd == "verify" then
    local p = d.power or {}
    add(L("v-verdict", d.ok and L("w-ok") or L("w-not-ok"), d.placed or 0))
    add(L("v-power", p.covered or 0, p.powered_entities or 0, p.demand_kw or 0, p.in_card_supply_kw or 0))
    add(L("v-networks", #list_of(d.networks), #list_of(d.arms)))
    for _, e in ipairs(list_of(d.errors)) do add(L("v-error", or_blank(reason(e)))) end
    for _, e in ipairs(list_of(d.warnings)) do add(L("v-note", or_blank(reason(e)))) end
  elseif cmd == "why" then
    local rec = d.record or {}
    add(rec.measured_this_card and L("y-measured") or L("y-unmeasured"))
    local function pairs_of(t)
      local out = {}
      for k, v in pairs(type(t) == "table" and t or {}) do out[#out + 1] = { k = k, v = v } end
      table.sort(out, function(a, b) return a.k < b.k end)
      local parts = {}
      for _, e in ipairs(out) do parts[#parts + 1] = L("pair", e.v, NMI(e.k)) end
      return parts
    end
    for _, s in ipairs(pairs_of(d.claimed or rec.claimed)) do add(L("y-claims", s)) end
    for _, s in ipairs(pairs_of(rec.measured)) do add(L("y-measured-line", s)) end
    if rec.window_seconds then add(L("y-window", rec.window_seconds, rec.warmup_seconds or "?",
      rec.source_job or "?")) end
    for _, e in ipairs(list_of(d.errors)) do add(L("v-error", or_blank(reason(e)))) end
    for _, e in ipairs(list_of(d.warnings)) do add(L("v-note", or_blank(reason(e)))) end
  elseif cmd == "power" then
    add(L("p-plan", d.to_add or 0, d.probes or 0, NM(d.pole or "?", "entity")))
    add(L("p-served", d.served or 0, d.powered or 0, d.still_unserved or 0))
    if d.pole_how then add(L("p-pole-how", truncated(tostring(d.pole_how), 130))) end
    if d.next then add(L("p-next", truncated(tostring(d.next), 140))) end
  elseif cmd == "ask" or cmd == "queue" then
    local q = list_of(d.queue)
    if cmd == "ask" and d.asked and d.asked.request then
      local req = d.asked.request
      add(req.surface and L("a-asked-on", req.id, req.asked_tick, tostring(req.surface))
        or L("a-asked", req.id, req.asked_tick))
      add(tostring(req.ask))
      if d.asked.note then add(L("a-note", truncated(tostring(d.asked.note), 160))) end
    elseif cmd == "ask" then
      add(L("r-refused-msg", res.code or "?", truncated(res.msg, 130)))
    end
    add(L("a-queue", #q, d.open or 0))
    for _, r in ipairs(q) do
      add(L("a-row", r.id, word(STATE_WORDS, r.state), truncated(r.ask, 60)))
      if r.answer then add(L("a-answered", truncated(tostring(r.answer), 140))) end
      if #lines > 12 then add(L("a-more")) break end
    end
  elseif cmd == "place" then
    -- The receipt for putting it down. `refused` is counted, not just mentioned: a card that lands
    -- 12 of 14 entities is a partial deployment, and the first version of this line reported only the
    -- 12.
    local refused = list_of(d.refused)
    add(L("pl-ghosts", d.ghosts or 0, d.origin and d.origin.x, d.origin and d.origin.y,
      NM(d.surface or "?", "surface"), d.built or 0, #refused))
    for _, e in ipairs(refused) do add(L("pl-refused", or_blank(reason(e)))) end
    add(d.measured_this_card and L("pl-measured", rates_of(d.measured)) or L("pl-unmeasured"))
    -- The receipt is only half of it: a player who just laid 41 ghosts needs to know the mistake is
    -- reversible from this window, and how much of it still is.
    if d.deployment then add(L("un-keep", d.undo_depth or 1)) end
  elseif cmd == "string" then
    add(d.error and L("s-blueprint-error", d.bytes or 0, truncated(d.error, 80))
      or L("s-blueprint", d.bytes or 0))
    add(d.measured_this_card and L("pl-measured", rates_of(d.measured)) or L("s-unmeasured"))
  elseif cmd == "scan" then
    local c = d.card or {}
    add(L("f-read", d.entities_kept or 0, d.machines_bound or 0))
    if c.contract and c.contract.outputs then
      add(L("f-claims", rates_of(c.contract.outputs)))
      if c.contract.fluid_outputs then
        add(L("f-fluids", rates_of(c.contract.fluid_outputs)))
      end
    end
    if d.claim_how then add(L("f-how", truncated(d.claim_how, 160))) end
    for _, k in ipairs(list_of(d.skipped)) do
      add(L("f-skipped", NM(k.name, "entity"), k.count or 1, tostring(k.why)))
    end
    add(truncated(d.next or "", 150))
  elseif cmd == "freeze" then
    local f = d.frozen or {}
    -- The card's name is whatever the player typed or the scan guessed -- not an entity -- so it goes
    -- into the sentence as it is: looking `pipe` up as an entity would call a card by a machine's name.
    add(L("f-frozen", f.name or "?", d.entities or 0,
      f.measured_this_card == false and L("f-not-measured") or L("f-carries")))
    if d.claim_how then add(L("f-how", truncated(d.claim_how, 160))) end
    for _, k in ipairs(list_of(d.skipped)) do
      add(L("f-skipped", NM(k.name, "entity"), k.count or 1, tostring(k.why)))
    end
  elseif cmd == "plan" then
    local p = d.plan or d
    local shown = d.rate_shown or "?"
    add(L("n-asked", shown, NMI(d.item or "?"), d.unit_shown
      and (d.unit_shown == "per_second" and L("unit-second")
        or d.unit_shown == "per_hour" and L("unit-hour") or L("unit-minute")) or ""))
    for _, n in ipairs(list_of(d.how_many)) do
      add(n.estimated
        and L("n-row-est", NM(n.machine, "entity"), n.count, n.per_machine_per_min, NMI(n.item))
        or L("n-row", NM(n.machine, "entity"), n.count, n.per_machine_per_min, NMI(n.item)))
      if n.recirculated then
        -- The rate on the row above is what the line gains. This is what the pipe next to the machine
        -- carries, and for kovarex the two differ by forty-one to one.
        add(L("n-recirc", n.recirculated.per_craft_in, NMI(n.recirculated.item),
          n.recirculated.per_craft_out, n.recirculated.gross_per_machine_per_min))
      end
    end
    for _, c in ipairs(list_of((d.plan or d).in_flight)) do
      add(L("n-inflight", NMI(c.item), c.per_min, c.per_craft, NM(c.recipe, "recipe")))
    end
    for _, c in ipairs(list_of((d.plan or d).cyclic)) do
      add(L("n-cyclic", NMI(c.item), c.throughput_per_min))
    end
    -- Space Age refuses a plan in two different ways and the window has to keep them apart: a recipe
    -- the ground will not run (the line never moves), and a machine nobody can build there (the
    -- hardware has to arrive, and then the line runs fine).
    for _, l in ipairs(list_of(surface_words((d.plan or d).surface))) do add(l) end
    for _, m in ipairs(list_of(d.modules)) do
      add(L("n-modules", NM(m.item, "item"), m.asked, NM(m.machine, "entity"), truncated(tostring(m.note), 100)))
    end
    -- Written against what `solve` answers here, measured rather than imagined: `power` splits grid
    -- draw from fuel burn (a plan can be affordable and still unfuelable), `margin` is a NUMBER --
    -- how many times the ground exceeds the plan's intake -- and `needs_measured_margin` says that
    -- number is still prototype arithmetic rather than a measured field.
    local pw = (p.unit or {}).power or {}
    if pw.machine_grid_kw ~= nil or pw.machine_fuel_kw ~= nil then
      add(L("n-power", pw.machine_grid_kw or 0, join((function()
        local tail = {}
        if (tonumber(pw.machine_fuel_kw) or 0) > 0 then tail[#tail + 1] = L("n-fuel", pw.machine_fuel_kw) end
        if (tonumber(pw.emissions_per_sec) or 0) > 0 then
          tail[#tail + 1] = L("n-poll", string.format("%.2f", pw.emissions_per_sec))
        end
        return tail
      end)(), "")))
    end
    if p.margin ~= nil then
      add(L("n-margin", p.margin, p.needs_measured_margin and L("n-margin-est") or ""))
    end
    for _, pre in ipairs(list_of(p.prerequisites)) do
      local tech = pre.technology or pre.name or pre
      add(pre.unlocks and L("n-research-unlocks", NM(tech, "technology"), tostring(pre.unlocks))
        or L("n-research", NM(tech, "technology")))
    end
    for _, cnd in ipairs(list_of(p.candidates)) do
      add(L("n-candidate", or_blank(reason(cnd))))
    end
  elseif cmd == "measure" then
    add(L("m-start", d.job, (d.run_ticks or 0) / 60, word(STATE_WORDS, d.state)))
    add(L("m-expected", d.expected_per_min, d.entities or 0, d.feeds or 0, d.collectors or 0))
    if d.unwired_inputs then
      add(L("m-unwired", #list_of(d.unwired_inputs)))
    end
    add(L("m-hint"))
  elseif cmd == "status" then
    add(L("st-job", d.job, word(STATE_WORDS, d.state), d.elapsed_ticks,
      (d.elapsed_ticks or 0) + (d.remaining_ticks or 0)))
    if d.state == "running" or d.state == "probing" then
      add(L("st-so-far", d.measured_per_min or "?", d.expected_per_min or "?"))
    end
    for _, v in ipairs(list_of(d.verdicts)) do
      add(v.ratio and tonumber(v.ratio)
        and L("st-verdict-ratio", NMI(v.item), v.claimed_per_min, v.measured_per_min,
          v.met and L("w-met") or L("w-not-met"), string.format("%.0f", (tonumber(v.ratio) or 0) * 100))
        or L("st-verdict", NMI(v.item), v.claimed_per_min, v.measured_per_min,
          v.met and L("w-met") or L("w-not-met")))
    end
    if d.delivered == false then
      add(L("st-cannot"))
    elseif d.delivered == true then
      add(L("st-delivered", d.card or L("w-the-card")))
    end
    if d.abandoned_because then
      add(L("st-ended", truncated(tostring(d.abandoned_because), 120)))
    end
  elseif cmd == "undo" then
    add(L("un-done", d.undone or 0, d.removed or 0))
    -- The difference between "nothing was there" and "something else is there now" is the whole
    -- answer: a ghost the player filled in has become their machine, and this must not eat it.
    if (d.already_gone or 0) > 0 then add(L("un-gone", d.already_gone, d.standing_now or 0)) end
    for _, st in ipairs(list_of(d.standing)) do
      add(L("un-standing", tostring(st.at and (tostring(st.at.x) .. "," .. tostring(st.at.y))),
        tostring(st.was), NM(st.now, "entity")))
    end
    add(L("un-left", d.remaining or 0))
  elseif cmd == "save" then
    add(d.frozen and L("sv-kept", d.name, rates_of(d.measured))
      or L("r-refused-msg", res.code or "?", truncated(res.msg, 130)))
    if d.measured_this_card == false then add(L("sv-still")) end
  elseif cmd == "fit" or cmd == "build" then
    local b = d.built or {}
    if d.box then
      add(L("b-box", d.box.w, d.box.h, NM(d.box.surface, "surface"),
        (d.lane or {}).footprint and d.lane.footprint.width,
        (d.lane or {}).footprint and d.lane.footprint.height,
        word(SPACING_WORDS, (d.lane or {}).spacing), (d.lane or {}).gap))
      add(L("b-fits", d.lanes_fit, d.per_row, d.rows, d.lanes_wanted))
      add(d.fits and L("b-rate", d.rate_placed, d.rate_wanted, L("b-fits-plan"))
        or L("b-rate-short", d.rate_placed, d.rate_wanted,
          -- `%d`, because this is a count of lanes and the answer has always said `1 lanes short`
          -- rather than `1.0`; a whole number that arrives as a float is not a new fact.
          string.format("%d", math.floor(tonumber(d.shortfall_lanes) or 0)),
          (d.shortfall_lanes or 0) * ((d.lane or {}).per_lane_rate or 0)))
    end
    -- The ghosts are going into THIS ground, so the ground is the one that gets to object. Same two
    -- news as the plan row: a recipe that cannot run here was refused before reaching this answer, and
    -- what is left to say is which hardware has to be built somewhere else and carried in.
    for _, l in ipairs(list_of(surface_words(d.surface))) do add(l) end
    if b.card then
      local p = b.placed or {}
      add(L("b-built", b.card, b.composed, b.lanes_used))
      if p.ghosts then
        local refused = list_of(p.refused)
        add(L("b-ghosts", p.ghosts, p.origin and p.origin.x, p.origin and p.origin.y,
          NM((d.box or {}).surface or "?", "surface"), #refused))
        for _, e in ipairs(refused) do add(L("pl-refused", or_blank(reason(e)))) end
      elseif b.refused then
        add(L("r-refused-msg", b.refused.code, truncated(b.refused.msg, 130)))
        local g = (b.refused.detail or {}).ground
        if g then
          add(g.generated == false and L("b-ground-ungenerated", NM(g.tile or "?", "tile"))
            or L("b-ground", NM(g.tile or "?", "tile")))
        end
      end
    end
    add(truncated(d.next or "", 150))
  else
    add(L("t-no-summary", tostring(cmd)))
  end
  if #lines > 14 then
    local cut = {}
    for i = 1, 14 do cut[i] = lines[i] end
    cut[#cut + 1] = L("t-more", #lines - 14)
    lines = cut
  end
  return { title = titled(cmd, name), lines = lines }
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
  if element_name == "arch-undo" then
    local res = api.undo()
    local out = G.report_lines("undo", "", res)
    G.show_report(player, out.title, out.lines)
    return "undo", res
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
