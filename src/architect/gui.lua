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

-- Two things, both lookups with no judgement in them: `host.clip`, so that a caption and a chat line
-- are cut on the same rule; and `host.icon_sprite`, so that the picture next to a row is looked up by
-- the same helper that decides whether there is one at all.
local host = require("host")

local ROOT = "arch-root"
G.ROOT = ROOT   -- the self-test looks the frame up by this name

-- How many frozen cards the window lists before it asks. One number for the cap and for the step the
-- "show more" press adds (`control.lua` reads it back through `G.CARDS_PAGE`), because a page that
-- means two things grows by one row per press at some point and someone calls that a bug.
G.CARDS_PAGE = 12
local CARDS_PAGE = G.CARDS_PAGE
-- The row holding the box's two size fields. Named once, because the builder writes the name and the
-- click reads it back, and those two strings drifting apart is a button that silently takes the
-- default size forever.
local BOX_HERE_ROW = "arch-boxhere-row"
G.BOX_HERE_ROW = BOX_HERE_ROW
local REPORT = "arch-report"
G.REPORT = REPORT

-- Factorio's Lua sandbox has no `utf8` library -- measured: `utf8.offset` raises "attempt to index
-- global 'utf8' (a nil value)" -- so a character boundary is found by hand, and that scan lives in
-- `host.clip` because a chat line cut by `sub(1, n)` has the same problem as a caption does.
-- A field the method did not send is not the same fact as a field it sent empty, but in a sentence
-- they both read as nothing -- and a nil passed as a placeholder is how a sentence grows a hole in it.
local function or_blank(v) return v == nil and "" or v end

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

-- The "what next" line, in the window's language when the method named one. The same bargain as
-- `msg_key`: the RCON answer keeps the English sentence a designer greps for and the suites assert on,
-- and the window prefers the key. No key -- or a key no locale row answers -- and the English line is
-- shown, which is a sentence in the wrong language rather than a hole in the middle of one. That was
-- the state of the fit verdicts: a player who asked 能否放下 and was told 只放得下三条 read
-- "only 3 of 5 lanes fit. Wider box, smaller spacing (now compact)..." because the sentence behind the
-- number was written in `plan_fit` and never carried a key.
-- A sentence a method wrote, in the window's language when the method named one. The same bargain as
-- `msg_key`: the RCON answer keeps the English line a designer greps for and the suites assert on,
-- and the window prefers the key beside it. No key -- or a key no locale row answers -- and the
-- English line shows, which is a sentence in the wrong language rather than a hole in one.
--
-- `why`, `note`, `fix`, `claim_how` and `next` are all this shape, so one helper covers the family:
-- the alternative was five copies of "prefer the key", which is how one of them stops preferring.
--
-- A parameter may itself be a sentence -- `{key=, params=}`, the shape `roles.lua` composes ranked
-- choices out of ("best " wrapped around "supply_reach desc (measured)"). `sentences` walks the list
-- first so each of those becomes a LocalizedString of its own, which the game then substitutes into the
-- row above it. Composing at the render site is what lets Chinese reorder the halves without English
-- having to; a flat string could only ever be translated as one unbreakable lump.
local sentences
sentences = function(params)
  local out = {}
  for i = 1, #params do
    local p = params[i]
    if type(p) == "table" and type(rawget(p, "key")) == "string" then
      local inner = p.params or {}
      out[i] = L(p.key, table.unpack(sentences(inner), 1, #inner))
    else
      out[i] = p
    end
  end
  return out
end

local function words_for(d, field, clip)
  if type(d) ~= "table" then return "" end
  local key = d[field .. "_key"]
  if type(key) == "string" then
    local ok, words = pcall(function()
      local params = d[field .. "_params"] or {}
      return L(key, table.unpack(sentences(params), 1, #params))
    end)
    if ok then return words end
  end
  return truncated(tostring(d[field] or ""), clip or 150)
end

local function next_words(d, clip) return words_for(d, "next", clip or 150) end

-- The sentence a method refused with, in the language of whoever is looking at the window.
--
-- `msg_key` is additive (see `host.fail_key`): the RCON answer still carries the English `msg` a designer
-- greps for and half the suites assert on, and the window prefers the key when the method named one. No
-- key -- or a key no locale row answers -- and the English line is shown, which is a sentence in the
-- wrong language rather than a hole in the middle of one.
--
-- The parameters stay what the data layer said (prototype ids and numbers), which is the same thing every
-- menu row does; a name the game translates is reached by `NM`/`NMI` at the site that renders it, not by
-- a table a method wrote before it knew who would read it.
local function refused_words(res)
  if type(res) ~= "table" or type(res.msg_key) ~= "string" then return nil end
  local p = res.msg_params
  if type(p) ~= "table" then return L(res.msg_key) end
  return L(res.msg_key, table.unpack(p, 1, #p))
end

-- The whole head line of a refusal: `refused: CODE -- <the sentence the method refused with>`, with the
-- sentence taken from the key when there is one. `clip` is the long-standing cut on the English line,
-- which a key does not need (its words are chosen by whoever is looking at the window, and cutting them
-- would cut the numbers the sentence is about).
local function refused_line(res, clip)
  local code = (res or {}).code or "?"
  local words = refused_words(res)
  if words then return L("r-refused-msg", code, words) end
  if (res or {}).msg == nil then return L("r-refused", code) end
  return L("r-refused-msg", code, clip and truncated(res.msg, clip) or tostring(res.msg))
end
G.refused_line = refused_line

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

-- Which row of a fixed word list a stored value sits on. `menu_index` does this for the availability
-- menus, whose rows change with the save; these two lists belong to this file, so the ids are the words
-- and the mapping cannot drift out from under a player. Row 1 for a caller that named nothing -- which
-- is also what the solver treats as "no opinion".
local function word_index(list, chosen)
  for i, v in ipairs(list) do if v == chosen then return i end end
  return 1
end

-- The value behind a menu row, or nil for row 1 of the hardware menus (that row IS the empty string,
-- which every part resolver already reads as "no preference"). Read off the model handed to THIS click
-- rather than re-derived from a row number later: the row and the name then cannot come from two
-- different builds of the menu.
local function menu_value(list, i)
  local entry = type(list) == "table" and list[tonumber(i) or 0]
  if not entry or entry.value == nil or entry.value == "" then return nil end
  return entry.value
end
local SPACING_WORDS = { "compact", "standard", "loose" }
-- When the plan is made whole: the whole line at once, or one row at a time. Row 1 is what every
-- caller got before the choice existed, and what the solver answers with when the word is missing.
local WHEN_WORDS = { "merged", "per_line" }
-- The list a build with no styles layer would show -- the default shape, and only it. `model.styles`
-- normally carries the registry's own ids, and a panel that hardcoded them would be a second list free
-- to fall behind the file it is supposed to describe.
local STYLE_FALLBACK = { "row-chest" }

-- Words for the registry's ids. One lookup per id, spelled out: a key assembled from a prefix at
-- runtime is a key no static check can prove exists, and the player reading a raw key where a style
-- name should be is how this file's whole locale policy got written in the first place.
local STYLE_WORDS = {
  ["row-chest"] = L("style-row-chest"),
  ["row-belts"] = L("style-row-belts"),
  ["sandwich-2"] = L("style-sandwich-2"),
}
-- One sentence: everything this row has to be handed, and whether a row of the same plan makes it.
-- `or_blank`/`tostring` guards are on the amounts rather than trusted, because a stand-in answer is
-- allowed to hold whatever its author typed -- which is the lesson the summary line below already learned.
local function needs_tooltip(n)
  local parts = {}
  for _, nd in ipairs(n.needs or {}) do
    local per_min = tonumber(nd.per_min)
    if per_min then
      parts[#parts + 1] = L("needs-item", NM(nd.item, "item"), string.format("%.0f", per_min),
        nd.supplied_by_plan == "plan" and L("needs-from-plan") or L("needs-outside"))
    end
  end
  for _, nd in ipairs(n.needs_fluids or {}) do
    local per_min = tonumber(nd.per_min)
    if per_min then
      -- The amount is the recipe's; the pipe's is nobody's, and the tooltip says which of the two it
      -- is quoting rather than letting a fluids figure look like the item figures above it.
      parts[#parts + 1] = L("needs-fluid", NM(nd.item, "fluid"), string.format("%.0f", per_min))
    end
  end
  if #parts == 0 then return "" end
  return L("plan-needs-tip", join(parts, ", "))
end

local function style_labels(ids)
  local out = {}
  for _, id in ipairs(ids or STYLE_FALLBACK) do
    out[#out + 1] = STYLE_WORDS[id] or tostring(id)
  end
  return out
end
local ORIENTATIONS = { "horizontal", "vertical" }
-- How much of a plan goes down when the box cannot hold all of it. 尽量放 lays what fits and says out
-- loud what did not; 整卡放 refuses rather than half-building a line. The default is the first because
-- whether this fits is the player's decision -- the mod's job is to say what it counted, not to
-- withhold the ghosts until the box is big enough. Row 1 is also what every caller that says nothing
-- gets, which is the same bargain as 自动 in the hardware row.
local FIT_MODES = { "fill", "whole" }
-- The three things a group of machines can do with one list of recipes. Row 1 is `split`, which is what
-- every caller that says nothing gets, and the order here is the order the drop-down shows.
--   split    machine i builds candidate i -- the list, at once, in the caller's order
--   rotate   every machine takes the same random pick on an interval -- the list, over time
--   shortage the list's order is not the plan's at all: a box per candidate subtracts what the lane's
--            own output chests hold from a target, and position 0 is whatever is shortest
local BUS_MODES = { "split", "rotate", "shortage" }
-- How many candidates the row offers as ticks before it says "pick from the plan instead". The window
-- grows with the save otherwise, and a list of 400 checkboxes is not a choice a hand can make.
local BUS_MAX = 12
local BUS_ROW = "arch-bus-row"   -- the row's own name, read by `read_form`
-- The bench rigs the window can start, in the order the drop-down shows them. The words are locale keys
-- and the value is the method this row calls, so renaming 机械臂 cannot move a click to another rig.
local RIGS = { "drill", "pump", "farm", "arm" }
local RIG_ROW = "arch-rig-row"

-- The window's pages, and the rule for what belongs on one: A PAGE IS ONE THING A PLAYER IS TRYING TO DO,
-- not one kind of widget. The first cut of this split the form, the hardware pickers and the ground row
-- onto three pages -- which made the commonest job in the mod ("一条铁板线") require three page switches
-- to say 产物 / 用哪些零件 / 塞进哪个框 / 能不能放下: busier than the one column it replaced, and the
-- mistake is worth naming because it is the easy one -- categories are tidy from the outside and useless
-- from inside a workflow. So: one page carries the whole line, and the pages that remain are the separate
-- errands (keep what you froze, ask the bench for a number, wire a bus).
--
-- Each id is a locale key (`page-<id>`), a flow name (`arch-page-<id>`) and the argument of its own nav
-- button (`arch-page:<id>`) -- one name, three uses, so a page in the list cannot fail to appear. The word
-- is the `L(...)` call itself rather than a key assembled at runtime, because `dev/locale_check.js` -- the
-- only thing standing between a renamed key and a player reading `architect.page-rig` where a button
-- should say 台架 -- can see a literal and cannot see `"page-" .. id`.
local PAGES = {
  -- The whole line, start to finish: what to make, at what rate, out of which parts, in which shape, into
  -- which box -- and the two presses that turn that into ghosts. Deliberately one page.
  { id = "line",  word = L("page-line") },
  { id = "cards", word = L("page-cards") },   -- what this save already holds, and what was read off ground
  { id = "rig",   word = L("page-rig") },     -- the bench rigs
  { id = "bus",   word = L("page-bus") },     -- a signal-controlled group
}
G.PAGES = PAGES

local function page_word(id)
  for _, p in ipairs(PAGES) do
    if p.id == id then return p.word end
  end
  return PAGES[1].word
end

-- Which page the window shows. Anything the store does not recognise falls back to the first page: a
-- value left by an older window, or a typo out of a click, must not leave a frame with nothing visible.
local function page_named(wanted)
  for _, p in ipairs(PAGES) do
    if p.id == wanted then return p.id end
  end
  return PAGES[1].id
end

-- What the panel would show, as data. Takes the frozen-card store and a version string and
-- returns plain values only, so it can be built and asserted without anyone being connected.
-- The box the player dragged, in the shape the panel shows it. Its own function because the drag happens
-- OUTSIDE the window: the event handler has to say the same sentence the label says, and a second copy of
-- the formatting would be two places where "what is boxed" can disagree with itself.
function G.box_of(raw)
  if not raw then return nil end
  return {
    surface = raw.surface,
    entities = raw.entities,
    area = string.format("%s,%s to %s,%s",
      tostring(raw.left_top and raw.left_top.x), tostring(raw.left_top and raw.left_top.y),
      tostring(raw.right_bottom and raw.right_bottom.x),
      tostring(raw.right_bottom and raw.right_bottom.y)),
    age_ticks = raw.tick,
  }
end

function G.box_words(box)
  if not box then return L("boxed-nothing") end
  return L("boxed", tostring(box.entities or "?"), tostring(box.surface or "?"), tostring(box.area))
end

-- `panel` is the last plan this window answered. Its rows are copied rather than shown in place, and
-- the copy is where the picture goes: `icon` is decided here, so the build code that draws the table
-- can be certain an absent field means "no icon" rather than "nobody looked".
function G.model(cards, version, selection, panel)
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
      -- The card's picture is its first product's -- a card is a promise about one thing the factory
      -- makes, and the row is where that thing gets recognised at a glance. A card that exports
      -- nothing has no picture, which is the truth rather than a gap in the layout.
      icon = host.icon_sprite("item", outputs[1] and outputs[1].item),
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
    selection = G.box_of(selection),
    -- One label, so it has to stay short enough to read at a glance: what the row buttons are, then
    -- the one caveat that changes how a number should be read. Where the ask goes is said at the ask.
    -- Renamed rows and new buttons both show up here first: this sentence is the only thing telling a
    -- player what the six buttons on a row are for, so it has to name them as they are named above.
    -- Which sentence the window shows is a decision, so it is made here -- but what it picks is a
    -- localized string, not a key the build would have to look up by name. A key assembled at runtime
    -- out of a prefix and a variable is a key no static check can prove is defined, and the failure
    -- that goes unproven is a player reading a raw key where a sentence should be.
    hint = #list == 0 and L("hint-empty") or L("hint-rows"),
    panel = (function()
      if type(panel) ~= "table" then return nil end
      local rows = {}
      -- What this plan does not feed itself. Every row already carries its own ingredient demand and
      -- whether another row of the same plan supplies it; this folds the leftovers into one list,
      -- because the question a player acts on is not "what does the assembler eat" but "what still has
      -- to arrive from outside". A row whose supply is short by 40 a minute and a row whose input the
      -- plan never makes at all both land here, and both are true: the first says the plan is
      -- incomplete, the second says the plan is only this much of a factory.
      local unmet = {}
      local function note(item, gap, kind)
        if not gap or gap <= 0 then return end
        local e = unmet[item] or { item = item, per_min = 0, kind = kind }
        e.per_min = e.per_min + gap
        unmet[item] = e
      end
      -- The kind rides along because the game's word for `water` and the word for `iron-plate` come
      -- from different lists, and an id looked up in the wrong one reads back as the id itself -- which
      -- in a Chinese client is the difference between 水 and `water`.
      for _, r in ipairs(panel.rows or {}) do
        for _, nd in ipairs(r.needs or {}) do note(nd.item, nd.gap_per_min, "item") end
        for _, nd in ipairs(r.needs_fluids or {}) do note(nd.item, nd.gap_per_min, "fluid") end
      end
      local outside = {}
      for _, e in pairs(unmet) do outside[#outside + 1] = e end
      table.sort(outside, function(a, b) return a.item < b.item end)
      for i, r in ipairs(panel.rows or {}) do
        local copy = {}
        for k, v in pairs(r) do copy[k] = v end
        copy.icon = host.icon_sprite("entity", r.machine)
        rows[i] = copy
      end
      local asked = {}
      for k, v in pairs(panel.asked or {}) do asked[k] = v end
      asked.icon = host.icon_sprite("item", asked.item)
      return { rows = rows, asked = asked, outside = #outside > 0 and outside or nil }
    end)(),
  }
end

local function clear_frame(player)
  local gui = player.gui
  if not gui then return end
  local existing = gui.screen[ROOT]
  if existing then existing.destroy() end
end

-- Find a named element anywhere under `el`.
--
-- The engine's own `element[name]` looks at DIRECT children only -- measured against the live window,
-- where `root["arch-box-label"]` is nil and `root["arch-box-row"]["arch-box-label"]` is the label. That
-- is fine while every row is one hop from the frame, and quietly wrong the moment the window gains a
-- section: the lookup returns nil, the caller's `if element then` guard passes the test that nothing
-- happened, and a player keeps reading a line the code had already decided to update.
--
-- So anything that reaches for a widget by name comes through here, and the tree can be rearranged
-- without re-auditing every hop.
function G.find(el, name)
  if not el then return nil end
  for _, c in ipairs(el.children or {}) do
    if c.name == name then return c end
    local deep = G.find(c, name)
    if deep then return deep end
  end
  return nil
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

  -- Four sections instead of one wall. The column had grown to thirteen rows -- the form, the hardware,
  -- the box, the plan, the cards, the answer -- all at the same visual weight, which is how a player
  -- spends time looking for the button they pressed last. Each group now sits in its own sunken frame
  -- under a name, in the order the questions are actually asked: what to make, what that takes, what is
  -- already frozen, what the mod just said.
  --
  -- All four are built up front and the empty ones are destroyed at the end, because the order they are
  -- CREATED in is the order they are DRAWN in: a section made lazily where its data turned up would
  -- move down the window depending on whether a plan had been run yet, and a panel whose parts move is
  -- a panel you have to re-read every time.
  -- One page per kind of work, with a row of buttons across the top to move between them, and the answer
  -- left OUTSIDE the pages: it is the thing you read after any press, wherever you were pressing from.
  --
  -- Every page is built every time and switched by visibility, exactly as the sections were built up front
  -- and destroyed when empty -- because the order things are CREATED in is the order they are DRAWN in. A
  -- window that assembled only the current page would move its own parts around depending on state, and
  -- it would take the off-page rows out of the tree the self-test and the suites read their names from.
  local page_id = page_named(model.page)
  local nav = frame.add { type = "flow", direction = "horizontal", name = "arch-nav" }
  local page = {}
  for _, p in ipairs(PAGES) do
    -- The name and the caption are built outside the `add` table: a `.id` field reference inside it reads
    -- to the GUI-API gate as a key named `id`, and the gate is right to be suspicious of bare words.
    local id, here, word = p.id, p.id == page_id, p.word
    nav.add { type = "button", name = "arch-page:" .. id, caption = word }
    page[id] = frame.add { type = "flow", direction = "vertical", name = "arch-page-" .. id, visible = here }
  end
  nav.add { type = "label", name = "arch-nav-here", caption = L("nav-here", page_word(page_id)) }

  local function section(parent, name, caption, tip)
    local box = parent.add { type = "frame", direction = "vertical", name = name,
      style = "deep_frame_in_shallow_frame" }
    box.add { type = "label", caption = caption, tooltip = tip }
    return box
  end
  local sec_in = section(page.line, "arch-sec-input", L("sec-input"), L("sec-input-tip"))
  local sec_plan = section(page.line, "arch-sec-plan", L("sec-plan"), L("sec-plan-tip"))
  local sec_cards = section(page.cards, "arch-sec-cards", L("sec-cards"), L("sec-cards-tip"))
  local sec_out = section(frame, "arch-sec-answer", L("sec-answer"), L("sec-answer-tip"))

  -- A blueprint string in chat cannot be selected, which makes it useless: the whole point of the
  -- string is pasting it into the game or sending it to someone. A text field can be, and selecting
  -- it on the way in means one Ctrl+C is the whole interaction.
  local srow = sec_out.add { type = "flow", direction = "horizontal", name = "arch-string-row" }
  srow.add { type = "label", name = "arch-string-label", caption = L("blueprint-label") }
  srow.add { type = "textfield", name = "arch-string-out", text = "" }

  -- The player's only input. A text field rather than a chat command, because the answer comes back
  -- into this window beside the question instead of into a log that scrolls away. The label says what
  -- this mod actually does with the words: it holds them. Nothing here can answer them.
  local arow = sec_in.add { type = "flow", direction = "horizontal", name = "arch-ask-row" }
  arow.add { type = "label", name = "arch-ask-label", caption = L("ask-label") }
  arow.add { type = "textfield", name = "arch-ask-in", text = "" }
  arow.add { type = "button", name = "arch-ask", caption = L("ask") }
  arow.add { type = "button", name = "arch-queue", caption = L("queue") }

  -- The form. Every choice on it is a parameter `solve` already takes; what the panel adds is being
  -- able to say it without knowing the names. The lists come from `model.menus`, built from this
  -- install's prototypes and this force's unlocks -- a machine list remembered in a widget file is
  -- exactly the claim that goes stale against a modpack.
  local frow = sec_in.add { type = "flow", direction = "horizontal", name = "arch-form-row" }
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
  -- How to round the plan. The solver hands back a unit plan whose machine counts are whole by
  -- construction, plus the scalings that reach the rate asked for; which one the window shows is the
  -- player's call, and `fit` takes the same answer so that "does it fit" is asked of the plan on
  -- screen rather than of a differently rounded one.
  frow.add { type = "label", caption = L("form-round") }
  frow.add { type = "drop-down", name = "arch-form-round",
    items = { L("round-unit"), L("round-up"), L("round-down"), L("round-nearest") },
    -- Where the last answer left it, for the same reason the item and rate fields read from `goal`: the
    -- window is rebuilt after every press, and a picker that snapped back to 整套 under a 多放 table
    -- would be telling the player they had never asked for the numbers they are looking at.
    selected_index = (model.goal or {}).round_index or 1, tooltip = L("form-round-tip") }
  -- Which way is half the question; what that way is applied TO is the other half. 整套 buys the line
  -- in copies of one unit (every ratio the solver proved survives); 每行单独 rounds each row to its own
  -- machines, which is the arithmetic of "I have four furnaces and need to know about the drill".
  frow.add { type = "label", caption = L("form-when") }
  frow.add { type = "drop-down", name = "arch-form-when",
    items = { L("when-merged"), L("when-per-line") },
    selected_index = word_index(WHEN_WORDS, (model.goal or {}).round_when),
    tooltip = L("form-when-tip") }
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
    items = { L("spacing-compact"), L("spacing-standard"), L("spacing-loose") },
    selected_index = word_index(SPACING_WORDS, (model.goal or {}).spacing) }
  -- Which shape a lane has. The list is the registry's own (`model.styles`, built from `styles.ids()`),
  -- so adding a style in styles.lua puts it in this control without anything here being edited -- which
  -- is the whole reason the registry exists rather than another table of numbers in the layout code.
  frow.add { type = "label", caption = L("form-style") }
  -- Row 1 is 自动: for a card it means the shape this mod has always defaulted to, and for a helmod
  -- press it means "pick it by machine count". Every other row is an order both paths obey. The id
  -- list carries that blank first row, so a saved choice lands back on the row the player left it on.
  local style_ids = { "" }
  for _, id in ipairs(model.styles or STYLE_FALLBACK) do style_ids[#style_ids + 1] = id end
  local style_items = { L("style-auto") }
  for _, word in ipairs(style_labels(model.styles)) do style_items[#style_items + 1] = word end
  frow.add { type = "drop-down", name = "arch-form-style",
    items = style_items,
    selected_index = word_index(style_ids, (model.goal or {}).style) }
  -- Which way the lanes run. One axis is worth a control of its own because it changes the answer the
  -- box gives: the same six lanes are a wide shape or a tall one, and 能否放下 has to count them that way.
  frow.add { type = "label", caption = L("form-orientation") }
  frow.add { type = "drop-down", name = "arch-form-orientation",
    items = { L("orientation-horizontal"), L("orientation-vertical") },
    selected_index = word_index(ORIENTATIONS, (model.goal or {}).orientation) }
  -- What to do when the box is smaller than the plan. The count itself is always said (能否放下 answers
  -- that question whatever is chosen here); this control chooses what 放下并出虚影 does with it.
  frow.add { type = "label", caption = L("form-fit"), tooltip = L("form-fit-tip") }
  frow.add { type = "drop-down", name = "arch-form-fit",
    items = { L("fit-fill"), L("fit-whole") },
    selected_index = word_index(FIT_MODES, (model.goal or {}).fit_mode),
    tooltip = L("form-fit-tip") }
  -- Taking back what the panel laid. It sits here rather than on a card's row because the stack is not
  -- per card: the last thing placed is the first thing that goes back, whichever row it came from.
  frow.add { type = "button", name = "arch-undo", caption = L("place-undo") }

  -- Which parts a lane is made of, on a row of their own. The row above had already grown to nineteen
  -- widgets, and a wall of drop-downs in which the one button you wanted is the twentieth is the shape
  -- of a panel nobody reads. 自动 (row 1) means "the best this force can craft", which is exactly what
  -- every caller got before these three existed; naming one is how a player trades belt speed for the
  -- iron it costs.
  local wrow = sec_in.add { type = "flow", direction = "horizontal", name = "arch-form-hw-row" }
  wrow.add { type = "label", name = "arch-form-hw-label", caption = L("form-hardware"),
    tooltip = L("form-hardware-tip") }
  wrow.add { type = "label", caption = L("form-belt") }
  wrow.add { type = "drop-down", name = "arch-form-belt",
    items = menu_labels(model.menus and model.menus.belts),
    selected_index = menu_index(model.menus and model.menus.belts, model.goal and model.goal.belt) }
  wrow.add { type = "label", caption = L("form-arm") }
  wrow.add { type = "drop-down", name = "arch-form-arm",
    items = menu_labels(model.menus and model.menus.arms),
    selected_index = menu_index(model.menus and model.menus.arms, model.goal and model.goal.arm) }
  wrow.add { type = "label", caption = L("form-chest") }
  wrow.add { type = "drop-down", name = "arch-form-chest",
    items = menu_labels(model.menus and model.menus.chests),
    selected_index = menu_index(model.menus and model.menus.chests, model.goal and model.goal.chest) }
  -- The pole is on the same row because it is the same kind of choice, even though it reaches a
  -- different door: a lane lays no poles at all (the shape has none until 电量 runs the coverage
  -- search), so this picker answers "which pole tier should that search build with" rather than
  -- "what is in the box". Said plainly because a control whose effect is one tile away is the one
  -- players press twice to find out what it was for.
  wrow.add { type = "label", caption = L("form-pole") }
  wrow.add { type = "drop-down", name = "arch-form-pole",
    items = menu_labels(model.menus and model.menus.poles),
    selected_index = menu_index(model.menus and model.menus.poles, model.goal and model.goal.pole),
    tooltip = L("form-pole-tip") }

  -- The four bench rigs, reachable from the window at last. Everything they answer -- how many tiles a
  -- tower tills, how fast an arm actually swings, what a drill and a pump pull out of a fresh patch --
  -- is a number no prototype gives, and until now the only way to get one was for someone to type the
  -- method over RCON. That left the panel asking `solve` for figures it had no way to produce, and the
  -- honest answer on screen was "not measured" with no door to the thing that would change it.
  --
  -- One drop-down for which rig, one button to start it, and the argument taken from what is already on
  -- the screen: the item row for the arm, the plan's own ingredient for the drill and the pump, and the
  -- item's seed for the tower. A rig that does not know that argument refuses it by name and lists what
  -- it does know -- the method is the authority on its own vocabulary, not this row.
  local rrow = page.rig.add { type = "flow", direction = "horizontal", name = RIG_ROW }
  rrow.add { type = "label", caption = L("form-rig"), tooltip = L("form-rig-tip") }
  rrow.add { type = "drop-down", name = "arch-form-rig",
    items = { L("rig-drill"), L("rig-pump"), L("rig-farm"), L("rig-arm") },
    selected_index = word_index(RIGS, (model.goal or {}).rig), tooltip = L("form-rig-tip") }
  -- The button says which of its two jobs the NEXT press does. First press opens a window on the bench;
  -- a second press while that window is running only reads it. One label for two acts is how a player
  -- concludes the button is broken when it is merely waiting.
  -- Where a run got to, and the click that keeps its numbers. These two used to sit at the end of the
  -- form row -- nineteen widgets deep on the page where you choose a product -- while what they are about
  -- is a window that is already running. Same page as the rigs now, and the reason is on the row itself:
  -- `card_lab` and the bench rigs run on real game time, so "is it done" is something a player presses
  -- rather than a value the panel polls -- a window that refreshed itself every tick would be a window
  -- that costs ticks.
  local rdrow = page.rig.add { type = "flow", direction = "horizontal", name = "arch-rig-read-row" }
  rdrow.add { type = "label", caption = L("form-rig-read") }
  rdrow.add { type = "button", name = "arch-status", caption = L("measure-status"),
    tooltip = L("status-tip") }
  rdrow.add { type = "button", name = "arch-save", caption = L("keep-measurement"), tooltip = L("save-tip") }
  rrow.add { type = "button", name = "arch-rig",
    caption = (model.rig_running and model.rig_running.seconds_left or 0) > 0
      and L("rig-wait", model.rig_running.seconds_left) or L("run-rig"),
    tooltip = L("form-rig-tip") }

  -- The bus: a GROUP of machines covering a LIST of recipes, in one of the three orders above. It sits
  -- under the rig row because it is the same kind of thing -- a press that lays a lane the plan table
  -- cannot describe, since the plan's rows each answer about one product.
  --
  -- Candidates are checkboxes rather than a multi-select list, for one reason: a `list-box` selection
  -- cannot carry a per-row number, and a mix (two machines on gear, one on cable) is the same
  -- information -- so the row would have needed a second widget for the half the feature is about.
  -- One row per candidate, ticked to include it, with its machine count beside it, is the whole ask.
  --
  -- The list is what the CHOSEN machine can craft, from `model.menus.bus_candidates` -- not every recipe
  -- the save. A player who ticks a recipe the assembler cannot run gets `BUS_NOT_RUNNABLE` naming it,
  -- which is a refusal about a menu that should not have offered it; the menu not offering it is the
  -- same truth told earlier and cheaper.
  local busrow = page.bus.add { type = "flow", direction = "vertical", name = BUS_ROW }
  local bhead = busrow.add { type = "flow", direction = "horizontal" }
  bhead.add { type = "label", caption = L("form-bus"), tooltip = L("form-bus-tip") }
  bhead.add { type = "drop-down", name = "arch-form-bus-mode",
    items = { L("bus-split"), L("bus-rotate"), L("bus-shortage") },
    selected_index = word_index(BUS_MODES, (model.goal or {}).bus_mode), tooltip = L("form-bus-mode-tip") }
  bhead.add { type = "textfield", name = "arch-form-bus-target",
    -- Only 缺货优先 reads this, and it has to say so on the widget: an empty box beside a mode that
    -- ignores it is indistinguishable from a box the window forgot to wire up.
    text = tostring((model.goal or {}).bus_target or ""), tooltip = L("form-bus-target-tip") }
  bhead.add { type = "label", caption = L("form-bus-target") }
  -- One machine is one lane; the count is asked per candidate so a mix is whole machines, which is the
  -- only form a mix can take on a bus (measured: every machine on position j builds recipe j).
  bhead.add { type = "label", caption = L("form-bus-each") }
  bhead.add { type = "textfield", name = "arch-form-bus-each",
    text = tostring((model.goal or {}).bus_each or ""), tooltip = L("form-bus-each-tip") }

  local cands = ((model.menus or {}).bus_candidates) or {}
  if #cands == 0 then
    -- Not an empty row of boxes and not a guess at a list: the sentence says which machine has no
    -- candidates, because "the machine menu is on 自动" is a different problem from "this assembler
    -- can make nothing this lane could carry".
    -- Three different silences, said three ways: "this machine cannot hear a wire" is not the same news
    -- as "this machine has nothing carryable to make", and neither is "there is no machine at all". The
    -- candidate function reports which one it hit; the row says that one. Chosen into a local first
    -- because a comparison written INSIDE the widget literal reads to the GUI gate as a key being set
    -- on the element, which is exactly the kind of thing that check exists to be suspicious of.
    local why = (model.menus or {}).bus_why
    local why_words = why == "not-settable" and L("bus-machine-not-settable")
      or (why == "no-machine" and L("bus-no-machine") or L("bus-no-candidates"))
    busrow.add { type = "label", caption = why_words }
  else
    local shown = 0
    for i, c in ipairs(cands) do
      if i <= BUS_MAX then
        shown = shown + 1
        local crow = busrow.add { type = "flow", direction = "horizontal" }
        crow.add { type = "checkbox", name = "arch-bus-c" .. i,
          caption = NM(c.label, "item"), state = ((model.goal or {}).bus_on or {})[i] == true,
          tooltip = L("form-bus-cand-tip", tostring(c.value)) }
        crow.add { type = "textfield", name = "arch-bus-n" .. i,
          text = tostring((model.goal or {}).bus_counts and (model.goal.bus_counts)[i]
            or (model.goal or {}).bus_each or 1), tooltip = L("form-bus-each-tip") }
      end
    end
    if #cands > shown then
      busrow.add { type = "label", caption = L("bus-more-hidden", #cands - shown) }
    end
    local bprow = busrow.add { type = "flow", direction = "horizontal" }
    bprow.add { type = "button", name = "arch-bus-preview", caption = L("bus-preview"),
      tooltip = L("form-bus-preview-tip") }
    bprow.add { type = "button", name = "arch-bus-lay", caption = L("bus-lay"),
      tooltip = L("form-bus-lay-tip") }
  end

  -- What the selection tool boxed, and the two clicks that act on it. Read is separate from Freeze on
  -- purpose: reading walks the entities and says what it skipped and why, and a player who boxed the
  -- wrong thing gets one more look before it becomes a card in the save.
  local brow = sec_in.add { type = "flow", direction = "horizontal", name = "arch-box-row" }
  brow.add { type = "label", name = "arch-box-label",
    -- The surface goes through as the word the save calls it, because a surface has no prototype to
    -- take a name from: `nauvis` is what the player typed in the create-screen, and `arch-sandbox` is
    -- what this mod made, and neither is a key the game's locale files know.
    caption = G.box_words(model.selection) }
  brow.add { type = "button", name = "arch-read", caption = L("read-box") }
  brow.add { type = "button", name = "arch-freeze", caption = L("freeze-box") }
  -- The question a player standing in a finished factory actually has: not "can this fit" but "what is
  -- this line making". It spends the same box and, unlike the rigs, waits in real seconds without
  -- touching the world clock -- so it is the measurement that works while the game is being played.
  brow.add { type = "button", name = "arch-watch", caption = L("watch-line") }
  -- The two buttons that spend the box, on the box's row: 能否放下 and 放下并出虚影 are about THIS
  -- rectangle, and sitting them on the plan row made the primary line read like a wall of six
  -- equivalents when only one of them is what a player asks most. Nothing else about them changed.
  brow.add { type = "button", name = "arch-fit", caption = L("fit") }
  brow.add { type = "button", name = "arch-build", caption = L("fit-ghosts") }

  -- The second way to get a box, because the first one is a mouse gesture this game asks for an empty
  -- hand to make: two numbers and wherever the player is standing. Same remembered box, same label, same
  -- readers -- `plan_fit` never learns which button made it.
  local hrow = sec_in.add { type = "flow", direction = "horizontal", name = BOX_HERE_ROW }
  hrow.add { type = "label", caption = L("box-size") }
  hrow.add { type = "textfield", name = "arch-box-w", text = "21", numeric = true,
    allow_negative = false, tooltip = L("box-size-tip") }
  hrow.add { type = "textfield", name = "arch-box-h", text = "21", numeric = true,
    allow_negative = false, tooltip = L("box-size-tip") }
  hrow.add { type = "button", name = "arch-boxhere", caption = L("box-here") }
  -- Helmod's plan, into the hand. Its own row, on the 产线 page: `frow` is already the strip of item,
  -- rate, machine, shape and fit menus, and a fifteenth and sixteenth control there is a strip nobody
  -- can read. The button hands over a whole laid-out line without deciding where it goes -- the game's
  -- own placement flow (drag, snap, rotate, green/red) is what finishes the job.
  --
  -- The drop-down is the question a player actually asks: people who work in helmod keep several
  -- factories open, and "which one" is not this mod's guess to make. The list comes from the same
  -- `get_models()` the press will read, so an entry in the list IS a factory the press can lay; when
  -- helmod is missing or has no plan yet, the row says which -- rather than offering one blank line to
  -- choose from.
  do
    local hm = model.helmod or {}
    local mrow = sec_in.add { type = "flow", direction = "horizontal", name = "arch-helmod-row" }
    mrow.add { type = "label", caption = L("form-helmod") }
    -- "" is 全部一起: row 1 of every picker here means "no preference", and the goal stores the same
    -- empty string, so the drop-down and the remembered answer cannot disagree.
    local ids, items = { "" }, { L("helmod-all") }
    for _, f in ipairs(hm.factories or {}) do
      ids[#ids + 1] = f.id
      -- Two shapes of entry because the list carries two things: a whole page (named by what it makes,
      -- with how many machines and how many lines are on it) and ONE line under a page, which reads as
      -- its recipe, its machine and how many of them -- the row a player is actually choosing.
      if f.kind == "line" then
        items[#items + 1] = L("helmod-line-word", NM(f.name or "?", "recipe"),
          tostring(tonumber(f.machines) or 0), NM(f.machine or "?", "entity"))
      else
        items[#items + 1] = string.format("%s · %s", tostring(f.name or f.id),
          tostring(tonumber(f.machines) or 0) .. " / " .. tostring(tonumber(f.recipes) or 0))
      end
    end
    if #items > 1 then
      mrow.add { type = "drop-down", name = "arch-form-helmod", items = items,
        selected_index = word_index(ids, (model.goal or {}).helmod_factory),
        tooltip = L("form-helmod-tip") }
    elseif hm.error then
      mrow.add { type = "label", name = "arch-helmod-none",
        caption = L("helmod-none", L(hm.msg_key or "report-idle")) }
    end
    mrow.add { type = "button", name = "arch-helmod", caption = L("helmod"), tooltip = L("helmod-tip") }
    -- Every page at once, into the pack. Two buttons because they answer two different asks -- "this
    -- line, in my hand" and "everything I computed, give it to me" -- and one cannot serve both: a
    -- cursor holds a single blueprint, so the whole plan has to go somewhere a player can pick apart.
    mrow.add { type = "button", name = "arch-helmod-all", caption = L("helmod-all-press"),
      tooltip = L("helmod-all-tip") }
  end


  -- The plan, as something to work in rather than read.
  --
  -- A plan is a tree and the rows below are its children: until now the window printed the answer as
  -- sentences, so following one level down meant reading a machine name and typing it into the form at
  -- the top -- which is the work Helmod removed from this kind of tool, and the reason people keep the
  -- spreadsheet open next to the game. Each row's button makes THAT product the target at the rate this
  -- plan needs of it, and ×2 / ÷2 move the target the way a hand wants to move it.
  --
  -- Nothing here decides arithmetic. Every number on a row came out of `plan_form`, and every press
  -- goes back through it, so what is on screen is always an answer rather than the window's opinion.
  local panel = model.panel or {}
  local prows = panel.rows or {}
  if #prows > 0 then
    local asked = panel.asked or {}
    local prow = sec_plan.add { type = "flow", direction = "horizontal", name = "arch-plan-row" }
    prow.add { type = "label", name = "arch-plan-target",
      caption = L("plan-target", or_blank(asked.rate_shown or asked.rate),
        NM(tostring(asked.item or "?"), "item"),
        or_blank(asked.unit_shown)) }
    prow.add { type = "button", name = "arch-scale:2", caption = L("plan-x2"),
      tooltip = L("plan-x2-tip") }
    prow.add { type = "button", name = "arch-scale:0.5", caption = L("plan-half"),
      tooltip = L("plan-half-tip") }
    local pt = sec_plan.add { type = "table", column_count = 5, name = "arch-plan-rows" }
    -- One column wider than the numbers, and the cell is there even when no picture resolved: a table
    -- whose rows slide left because one item has no icon is worse than a table with a blank in it.
    for _, h in ipairs({ "", L("column-machine"), L("column-count"), L("column-each"), L("column-next") }) do
      pt.add { type = "label", caption = h }
    end
    for i, n in ipairs(prows) do
      -- `sprite`, not `image`: 2.0 has no widget type called image, and the GUI key check says so
      -- before the game ever has to. `resize_to_sprite = false` keeps every row the same height,
      -- because the registered icons are 32, 48 and 64 pixels depending on who drew them.
      -- Named, so a headless run can tell a plan-row picture from a card-row one by its parent rather
      -- than by counting every picture in the frame.
      pt.add(n.icon and { type = "sprite", name = "arch-plan-icon-" .. i, sprite = n.icon,
        resize_to_sprite = false, tooltip = NM(tostring(n.machine), "entity") }
        or { type = "label", name = "arch-plan-blank-" .. i, caption = "" })
      -- One row per product the plan buys, with the rate that row has to hold. `estimated` is said
      -- rather than smoothed: a nameplate row and a measured row are different kinds of promise, and
      -- the button on the end works the same either way.
      pt.add { type = "label", caption = truncated(NM(tostring(n.machine), "entity"), 26) }
      -- The row's own ingredients live under the pointer over its machine count, rather than as one more
      -- line per row in the answer text: that area is capped at fourteen lines so one plan cannot fill
      -- the window, and the lines that were being pushed off the end were the summary ones -- what still
      -- has to arrive from outside, the power and margin figures, which candidate the table is. Per-row
      -- detail belongs under a pointer; the summary belongs where it cannot be crowded out.
      pt.add { type = "label", name = "arch-plan-count-" .. i,
        caption = tostring(n.count), tooltip = needs_tooltip(n) }
      pt.add { type = "label",
        caption = n.estimated and L("plan-each-est", n.per_machine_per_min)
          or L("plan-each", n.per_machine_per_min) }
      pt.add { type = "button", name = "arch-pick:" .. tostring(n.item),
        caption = L("plan-pick"), tooltip = L("plan-pick-tip", NM(tostring(n.item), "item")) }
    end
    -- What the plan cannot feed itself, in one line under the rows it is made of. The table already
    -- says what each row produces; this is the other half of the same arithmetic -- the inputs that
    -- arrive from somewhere this plan does not include -- and it belongs in the window rather than
    -- only in the answer text, because it is the thing that decides whether the plan is tonight's
    -- build or next week's.
    if panel.outside then
      local parts = {}
      for i, nd in ipairs(panel.outside) do
        if i <= 3 then
          parts[#parts + 1] = L("plan-outside-item", NM(nd.item, nd.kind or "item"),
            string.format("%.0f", nd.per_min))
        end
      end
      if #panel.outside > 3 then parts[#parts + 1] = L("plan-outside-more", #panel.outside - 3) end
      sec_plan.add { type = "label", name = "arch-plan-outside",
        caption = L("plan-outside", join(parts, ", ")) }
    end
  end

  -- A scroll pane, because the card list is the one part of this window that grows without asking: a
  -- save with forty frozen cards pushed the answer and the buttons off the bottom of the screen, and a
  -- table you have to move a window to reach the right half of is a table whose last four columns do
  -- not exist. Height is capped rather than counted: the cards are the least urgent thing here.
  -- A scroll pane with no height set is a pane that never scrolls -- `element.style.<attr>` is the 1.1
  -- idiom and 2.0 reads it as writing to the shared style prototype (the docs: reading `element.style`
  -- gives a LuaStyle, writing accepts only a style NAME), so the cap has to come from a style defined in
  -- the data stage. Until then the pane is still worth having: it is the element the cap goes on, and it
  -- keeps the card table from deciding the window's height by itself.
  local tbl = sec_cards.add { type = "scroll-pane", direction = "vertical", name = "arch-cards-scroll" }
  tbl = tbl.add { type = "table", column_count = 12, name = "arch-cards" }
  -- Spelled out one by one rather than assembled from a prefix at runtime, because the locale check
  -- reads the keys this file uses out of this file: a key built by string concatenation is a key no
  -- static check can prove is defined, and what goes unproven is a player reading a raw key where a
  -- table header should be. Four blanks because four columns hold a picture or buttons and have
  -- nothing to name.
  for _, h in ipairs({ "", L("column-card"), L("column-entities"), L("column-produces"), L("column-verify"),
    L("column-why"), L("column-power"), L("column-measure"), "", "", "", "" }) do
    tbl.add { type = "label", caption = h }
  end
  -- A page, not a cap that hides things silently: the card list is the one part of this window that
  -- grows with the save rather than with the question, and forty frozen cards push the form, the plan
  -- and the answer off the screen. What is not drawn is counted on the button that draws more of it.
  -- The step `show_more_cards` adds lives here too, in `G.CARDS_PAGE`, because the cap and the step
  -- are one number: two copies is how a page stops being a page.
  local shown = tonumber(model.cards_shown) or CARDS_PAGE
  for ci, card in ipairs(model.cards) do
    if ci > shown then break end
    -- Twelve cells, because `column_count` is twelve: the first holds a picture and the last five are
    -- buttons, and a heading over a picture would only be a word for "the thing you can see".
    tbl.add(card.icon and { type = "sprite", name = "arch-card-icon-" .. tostring(card.name),
      sprite = card.icon, resize_to_sprite = false, tooltip = L("column-card") }
      or { type = "label", caption = "" })
    tbl.add { type = "label", caption = truncated(card.name, 30) }
    tbl.add { type = "label", caption = tostring(card.entities) }
    tbl.add { type = "label", caption = truncated(card.label, 44) }
    tbl.add { type = "button", name = "arch-verify:" .. card.name, caption = L("verify"),
      tooltip = L("verify-tip") }
    -- Tooltips on the four whose consequence is not in the label: `下地验一遍` really puts the card on the
    -- ground and takes it back, `上试验台跑` asks to move the whole server's clock, `拿到手上` overwrites
    -- whatever blueprint is in the hand already. A button that does something the player did not expect
    -- once is a button they stop pressing, and "what would this do" is exactly what a tooltip is for.
    tbl.add { type = "button", name = "arch-why:" .. card.name, caption = L("why"),
      tooltip = L("why-tip") }
    tbl.add { type = "button", name = "arch-power:" .. card.name, caption = L("power"),
      tooltip = L("power-tip") }
    tbl.add { type = "button", name = "arch-measure:" .. card.name, caption = L("measure"),
      tooltip = L("measure-tip") }
    tbl.add { type = "button", name = "arch-place:" .. card.name, caption = L("place"),
      tooltip = L("place-tip") }
    -- The one button that asks about the factory rather than about the card: 放下去、建起来之后，
    -- 信号线到底接上没有、哪台机器的控制器被引擎拒了。它排在放置之后，因为这是放置之后才会有的问题。
    tbl.add { type = "button", name = "arch-wire:" .. card.name, caption = L("wire"),
      tooltip = L("wire-tip") }
    tbl.add { type = "button", name = "arch-carry:" .. card.name, caption = L("carry"),
      tooltip = L("carry-tip") }
    tbl.add { type = "button", name = "arch-string:" .. card.name, caption = L("string") }
  end
  if #model.cards > shown then
    sec_cards.add { type = "button", name = "arch-more-cards",
      caption = L("cards-more", #model.cards - shown), tooltip = L("cards-more-tip") }
  end

  -- The answer goes in the window, not only in chat: a verification is a dozen lines, and the chat
  -- log is where a player loses a line the moment they scroll. Named so `G.show_report` can find it
  -- with the same two-hop lookup the string field uses.
  local report = sec_out.add { type = "flow", direction = "vertical", name = REPORT }
  report.add { type = "label", name = "arch-report-title", caption = L("report-idle") }
  -- A section with nothing in it but its own heading is a box around a word. They are built up front so
  -- the four of them always appear in the same order -- see `section` -- and the ones nobody filled this
  -- time come back out before the window is shown.
  for _, box in ipairs({ sec_in, sec_plan, sec_cards, sec_out }) do
    if #box.children <= 1 then box.destroy() end
  end
  -- A page whose every section came back empty is a page with nothing on it, and a blank rectangle is not
  -- an answer to "where did my buttons go". It says so instead.
  for _, p in ipairs(PAGES) do
    local box = page[p.id]
    if #box.children == 0 then
      box.add { type = "label", name = "arch-page-empty-" .. p.id, caption = L("page-empty") }
    end
  end
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
  helmod = L("verb-helmod"),
  helmod_all = L("verb-helmod-all"),
  wire = L("verb-wire"),
  undo = L("verb-undo"), watch = L("verb-watch"), boxhere = L("verb-boxhere"),
  carry = L("verb-carry"), rig = L("verb-rig"),
}
local function titled(cmd, name)
  return L("title-line", VERB_WORDS[cmd] or tostring(cmd), tostring(name))
end

-- Which door a delivery came in by, in the window's own words. `cursor` is the mouse and `pack` is the
-- inventory, and the two tell the player to look at different places, so the code is translated rather
-- than printed. Two literal keys because `dev/locale_check.js` reads the calls, not a string assembled
-- from one -- that is also how this row once passed a key it could not find.
local function door_word(which)
  if which == "pack" then return L("door-pack") end
  if which == "string" then return L("door-string") end
  return L("door-cursor")
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

  if not res.ok then
    add(refused_line(res))
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
          -- The tower, once the bench has measured one: `farm_rate` found the ground it tills and what it
          -- carries, so the plan can stop at plants and say the purchase instead. Without a measurement
          -- the honest line is still the old one -- the two numbers are not prototype fields.
          if fm.towers then
            local by_plot = ((fm.towers_from or {}).plot or 0) >= ((fm.towers_from or {}).crane or 0)
            add(L("r-farm-tower", fm.towers, fm.tiles, fm.tiles_per_tower, fm.reach_tiles,
              fm.items_per_tower_min, (fm.rig or {}).first_harvest_after or "?"))
            -- Which of the two ceilings bit, because they are two different things to buy: another
            -- tower for the crane, another plot for the ground.
            add(by_plot and L("r-farm-bound-plot") or L("r-farm-bound-crane"))
          else
            add(L("r-farm-notower"))
          end
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
      if det.use_instead or det.use_instead_key then add(L("r-instead", words_for(det, "use_instead", 200))) end
      -- The solver's refusals carry a sentence of their own, and it is the part that says what to do
      -- next: research, route, or go and build the thing that is not a recipe. The number beside it is
      -- the same answer in a form a player can use -- how much of the missing item the line wants --
      -- and `item` is named because "24/min" without a unit after it is not an answer.
      --
      -- Except for a farm, whose `why` is those same numbers in English: printing both would be one
      -- sentence twice, once in the player's language and once not, and the second half is exactly what
      -- the window is meant to be free of (see #31 for when the data layer's prose gets keys of its own).
      if (det.why or det.why_key) and #farms == 0 then add(L("r-why", words_for(det, "why", 200))) end
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
    if d.pole_how or d.pole_how_key then add(L("p-pole-how", words_for(d, "pole_how", 130))) end
    if d.next or d.next_key then add(L("p-next", next_words(d, 140))) end
  elseif cmd == "helmod_all" then
    -- One row per blueprint the pack gained, with the line count and the part count that came out of
    -- the SAME arithmetic the single press uses -- and a row for every page that refused, because a
    -- "3 of 5" answer that hides which two failed is worse than no answer.
    local refused = 0
    for _ in ipairs(d.refused or {}) do refused = refused + 1 end
    add(L("n-hmall-total", d.count or 0, refused))
    for _, b in ipairs(d.blueprints or {}) do
      add(L("n-hmall", tostring(b.name or b.factory or "?"), b.entities or 0, b.lines or 0,
        door_word(b.via or b.into)))
      for _, miss in ipairs(b.unfed or {}) do
        add(L("n-hmall-unfed", tostring(miss.name or "?"), miss.amount or 1,
          tostring(miss.recipe or "?")))
      end
      for _, sk in ipairs(b.skipped or {}) do
        add(L("n-hm-skip", NM(sk.name, "item"), sk.wanted or 0, tostring(sk.why or "?")))
      end
    end
    for _, r in ipairs(d.refused or {}) do
      add(L("n-hmall-refused", tostring(r.name or r.factory or "?"), tostring(r.code or "?")))
    end
  elseif cmd == "helmod" then
    -- Helmod's numbers as ground. The counts are said twice on purpose: `wanted` is what the plan
    -- asked for and can be a fraction (2.5 furnaces is a real answer in helmod), `laid` is whole
    -- ghosts, and a reader who is not told the difference counts machines and concludes the mod lost
    -- some. The undo line is the one that makes an ungated button safe to press.
    local o = (d.origin or {})
    -- `held` for the hand, `ghosts` for the ground: the same authored plan counted where it landed.
    if d.scoped then add(L("n-hm-scoped", tostring(d.scoped), tostring(d.page or ""))) end
    add(L("n-hm", d.kinds or 0, d.ghosts or d.held or d.entities or 0, tostring(d.surface or "?"),
      tostring(o.x or "?"), tostring(o.y or "?"), tostring(d.source or "?")))
    if d.landed_via then
      add(L("n-hm-hand", d.held or d.entities or 0,
        d.landed_via == "pack" and L("door-pack") or L("door-cursor")))
      if d.blueprint then add(L("n-hm-copy", d.bytes or 0)) end
    end
    if d.short_by then
      add(L("n-hm-short", d.held or 0, (d.held or 0) + d.short_by))
    end
    -- The lanes first, because they are the answer to "全铺": the machines came with the belts and the
    -- arms that feed them, counted by kind so a reader can check the shape instead of trusting a total.
    for _, l in ipairs(list_of(d.lanes)) do
      local p = l.parts or {}
      -- Counts by CLASS, on the same grounds the gate uses: which belt, arm and chest a lane gets is this
      -- install's unlocked list, so a row that named `fast-transport-belt` would be wrong on a save where
      -- the lane legitimately came out with express ones.
      local belts, arms, chests = 0, 0, 0
      for k, v in pairs(p) do
        if k:find("belt") then belts = belts + v
        elseif k:find("inserter") then arms = arms + v
        elseif k:find("chest") then chests = chests + v end
      end
      add(L("n-hm-lane", tostring(l.recipe or "?"), NM(l.machine or "?", "entity"),
        l.machines or 0, l.entities or 0, belts, arms, chests,
        tostring((l.at or {}).x or "?"), tostring((l.at or {}).y or "?")))
      -- The SHAPE, in its own row: the counts above say 3 chests and 99 arms for 48 machines, and the
      -- word that says why is the style this lane was laid as -- a line pays its interface once.
      if l.shape then add(L("n-hm-shape", tostring(l.shape), NM(l.machine or "?", "entity"))) end
      for _, miss in ipairs(l.unfed or {}) do
        -- One row per ingredient the line does not bring, named and quantified: "this machine also eats
        -- 3 copper cable per craft and nothing here delivers it" is the whole reason a computed plan of
        -- two-ingredient recipes cannot be laid as one belt and left unexplained.
        add(L("n-hm-unfed", NM(miss.name or "?", "item"), miss.amount or 1,
          NM(l.fed_item or "?", "item")))
      end
      if l.swapped then
        -- "the plan asked X, this lane is Y", in its own row: a substitute is a decision the player is
        -- entitled to overrule, and a silent one is how 48 steel furnaces become 48 electric ones and
        -- nobody notices until the smelt rate is wrong.
        add(L("n-hm-swap", NM(l.swapped, "entity"), NM(l.machine or "?", "entity"), l.machines or 0))
      end
    end
    for _, f in ipairs(list_of(d.lane_fallback)) do
      -- The lane did not happen and the machines still did: said as its own row, because a plan that
      -- arrives as loose machines instead of as a line is a different job for the player.
      add(L("n-hm-nolane", tostring(f.recipe or "?"), NM(f.machine or "?", "entity"),
        f.asked or 0, or_blank(f.why)))
    end
    for _, it in ipairs(list_of(d.items)) do
      if it.name then
        add(L("n-hm-item", NM(it.name, "entity"), it.placed or 0,
          string.format("%.2f", tonumber(it.wanted) or 0)))
      end
    end
    for _, s in ipairs(list_of(d.skipped)) do
      add(L("n-hm-skip", NM(s.name or "?", "entity"), string.format("%.2f", tonumber(s.wanted) or 0),
        or_blank(s.why)))
    end
    for _, r in ipairs(list_of(d.refused)) do
      add(L("n-hm-refused", NM(r.name or "?", "entity"),
        tostring((r.at or {}).x) .. "," .. tostring((r.at or {}).y)))
    end
    if d.undo_depth then add(L("n-hm-undo", d.undo_depth, tostring(d.rounded or "?"))) end
  elseif cmd == "wire" then
    -- The ledger for one card: what got drawn, what is still waiting, and -- the reason this button
    -- exists -- the controllers the engine refused. A refusal is otherwise invisible from the window:
    -- the machine was marked settled anyway, the job that recorded it closed, and every other verb on
    -- this row answers about the card rather than about what happened when it was built.
    add(L("n-wire", d.drawn or 0, d.waiting or 0, d.written or 0,
      d.bound or 0, d.no_setter or 0))
    for _, j in ipairs(list_of(d.jobs)) do
      add(L("n-wire-job", tostring(j.card or "?"), tostring(j.surface or "?"),
        j.drawn or 0, j.wires or 0, j.waiting or 0))
    end
    for _, e in ipairs(list_of(d.refused)) do add(L("pl-refused", or_blank(reason(e)))) end
    for _, rec in ipairs(list_of(d.refused_after_build)) do
      local items = list_of(rec.items)
      add(L("n-wire-settled", tostring(rec.card or "?"), tostring(rec.surface or "?"), #items))
      for _, it in ipairs(items) do
        local whys = list_of(it.why)
        -- One line per refused thing on the machine, nested rather than concatenated: a LocalizedString
        -- is a TABLE, and `table.concat` of one raises "invalid value (table) in table for 'concat'" --
        -- which is exactly how this branch arrived here already answered as an undispatched button.
        for _, w in ipairs(whys) do
          add(L("n-wire-refused", tostring(it.entity or "?"),
            L("n-wire-why", tostring(w.what or "?"), tostring(w.name or "?"), or_blank(w.why))))
        end
        if #whys == 0 then
          add(L("n-wire-refused", tostring(it.entity or "?"), or_blank(it.why)))
        end
      end
    end
    if #list_of(d.jobs) == 0 and #list_of(d.refused_after_build) == 0 and #list_of(d.refused) == 0 then
      add(L("n-wire-quiet"))
    end
  elseif cmd == "boxhere" then
    -- The box as the save now holds it: size, ground, corners, and how much of it is standing things.
    -- `counted == false` is its own sentence because "0" would be a lie about a chunk that was never
    -- generated, and the two lead to different next clicks.
    add(L("bh-set", d.w or "?", d.h or "?", tostring(d.surface or "?"),
      d.counted == false and L("bh-uncounted") or tostring(d.entities or 0),
      tostring((d.left_top or {}).x) .. "," .. tostring((d.left_top or {}).y),
      tostring((d.right_bottom or {}).x) .. "," .. tostring((d.right_bottom or {}).y)))
    if d.clamped then add(L("bh-clamped", tostring(d.clamped))) end
    add(L("bh-next"))
  elseif cmd == "ask" or cmd == "queue" then
    local q = list_of(d.queue)
    if cmd == "ask" and d.asked and d.asked.request then
      local req = d.asked.request
      add(req.surface and L("a-asked-on", req.id, req.asked_tick, tostring(req.surface))
        or L("a-asked", req.id, req.asked_tick))
      add(tostring(req.ask))
      if d.asked.note then add(L("a-note", truncated(tostring(d.asked.note), 160))) end
    elseif cmd == "ask" then
      add(refused_line(res, 130))
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
  elseif cmd == "carry" then
    -- Two numbers, because they are two different facts: how many objects the card holds, and how many
    -- the engine says are in the hand right now. Printed apart rather than as one "已放置", because the
    -- point of this verb is that the game decides where they go -- the receipt can only claim the hand.
    -- A refusal is already the line above this branch, and a receipt of `0 of 0 in hand` under it would
    -- be a second, vaguer claim about the same failed click.
    if res.ok then
      add(L("h-carry", d.entities or 0, d.landed or 0, NM(d.surface or "?", "surface")))
      if (d.landed or 0) ~= (d.entities or 0) then
        add(L("h-carry-short", d.entities or 0, d.landed or 0))
      end
      add(d.measured_this_card and L("pl-measured", rates_of(d.measured)) or L("pl-unmeasured"))
    end
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
    if d.claim_how or d.claim_how_key then add(L("f-how", words_for(d, "claim_how", 160))) end
    -- Grouped by WHY, and the ground itself folded into one count. Left as it was, a player who圈ed a
    -- patch got a hundred and twenty eight lines reading "跳过：coal —— 属于中立势力" and concluded the mod
    -- was losing their factory; the ore is not something a card can carry, and saying it 128 times is
    -- how that reads. The JSON keeps one entry per kind, because an agent wants exactly that.
    local skip_other, skip_ground, ground_kinds = {}, 0, 0
    for _, k in ipairs(list_of(d.skipped)) do
      if k.why_key == "s-why-force" then
        skip_ground = skip_ground + (tonumber(k.count) or 1); ground_kinds = ground_kinds + 1
      else
        skip_other[#skip_other + 1] = L("f-skipped", NM(k.name, "entity"), k.count or 1,
          words_for(k, "why", 160))
      end
    end
    for _, line in ipairs(skip_other) do add(line) end
    if skip_ground > 0 then add(L("f-skipped-ground", skip_ground, ground_kinds)) end
    -- Guarded and labelled, like every other next-step line: a bare sentence is the same words in two
    -- shapes depending on which report rendered them, and an empty one when the method had nothing to
    -- suggest is a hole in the middle of a window.
    if d.next or d.next_key then add(L("p-next", next_words(d))) end
  elseif cmd == "watch" then
    -- Three states, because a window is a request with a wait in it: the first press starts it, the
    -- window says how long is left, and only the third press has a number. Rendering the first two as
    -- a zero would be the exact lie this mod keeps refusing.
    if d.state == "started" then
      add(L("w-started", d.seconds or "?", d.machine_count or 0))
      add(L("w-wait"))
    elseif d.state == "running" then
      add(L("w-running", d.seconds_left, d.machine_count or 0))
    else
      add(L("w-head", d.machine_count or 0, d.elapsed_game_seconds or "?"))
      -- Two numbers per item, because they are two different observations: what appeared where output
      -- lands, and what vanished from where input waits. Adding them would make a figure that means
      -- neither, and a line feeding a belt out of the box has a large second number and no first one.
      for _, e in ipairs(list_of(d.per_item)) do
        add(L("w-item", NMI(e.item), e.gained or 0,
          e.per_min and string.format("%.1f", e.per_min) or "-", e.spent or 0))
      end
      add(L("w-status", d.running or 0, d.stalled or 0, d.gone or 0))
      if d.unassigned then add(L("w-unassigned", d.unassigned)) end
      -- Which reading of a zero this is. `shipped_out` and `idle` cannot be told apart by the player
      -- from a count of nothing, and they are opposite facts about the line.
      if d.shipped_out then add(L("w-shipped", d.spent_total or 0)) end
      if d.idle then add(L("w-idle")) end
      if type(d.clock) == "table" then
        add(d.clock.warps_world
          and L("m-clock-warp", d.clock.speed, d.clock.game_seconds or "?", d.clock.real_seconds or "?")
          or L("m-clock-real", d.clock.game_seconds or "?"))
      end
      -- The watch did not speed anything up; that is not the same statement as "nothing was sped up".
      -- A rig running beside this window makes the seconds game seconds rather than wall-clock ones.
      if d.clock_moved then
        add(L("w-clock-moved", d.speed_at_start or "?", d.speed_at_end or "?"))
      end
      add(L("w-scope"))
      if d.cached then add(L("w-cached", truncated(d.measured_tick or "?", 20))) end
    end
  elseif cmd == "rig" then
    -- The same three states as a watch: the first press opens a window on the bench, the presses inside
    -- it say how long is left, and only a press after it closes carries a number. A rig rendered as a
    -- zero while it runs is the lie that made the solver size a plant around nothing.
    if d.state == "running" then
      add(L("rg-running", d.seconds or "?"))
      add(L("rg-wait"))
    elseif d.state == "probing" or d.state == "settling" then
      add(L("rg-phase", tostring(d.state), d.seconds or "?"))
      add(L("rg-wait"))
    else
      if name == "drill" or d.machine then
        add(L("rg-drill", NM(d.machine or "?", "entity"), NMI(d.resource or "?"),
          string.format("%.1f", d.items_per_min or 0),
          d.first_item_after and string.format("%.1f", d.first_item_after) or "?"))
      end
      if d.fluid then
        add(L("rg-pump", NM(d.machine or "?", "entity"), NMI(d.fluid),
          string.format("%.1f", d.units_per_min or 0)))
      end
      if d.plant or d.tiles_tilled then
        add(L("rg-farm", d.tiles_tilled or 0, string.format("%.1f", d.reach_tiles or 0),
          string.format("%.0f", d.steady_items_per_min or d.items_per_min or 0),
          string.format("%.0f", d.first_harvest_after or 0), NMI(d.seed or "?")))
        -- Seeds are the part a player can run out of without the tower stopping, so the rate that was
        -- actually eaten travels with the rate that was harvested -- and the floor of one per planting
        -- is said as the floor, not as a fact about this install.
        add(L("rg-farm-seed", d.seeds_consumed_per_min or 0, d.plantings_seen or 0,
          d.seeds_consumed or 0))
      end
      local best = d.best or {}
      if best.arm then
        add(L("rg-arm", NM(best.arm, "entity"), string.format("%.0f", best.items_per_min or 0),
          string.format("%.1f", best.swings_per_min or 0), best.items_per_swing or 1,
          #list_of(d.tiers)))
        -- The hand and the swing are different observations, and one save's hand was four times another
        -- save's on the same arm. Naming both is what keeps this number from being read as a promise.
        add(L("rg-arm-note", best.swings_per_min or 0, best.items_per_swing or 1,
          best.source_spacing or "?"))
      end
      if d.clock_speed and d.clock_speed > 1 then
        add(L("m-clock-warp", d.clock_speed, d.elapsed_game_seconds or "?",
          d.elapsed_game_seconds and string.format("%.0f", d.elapsed_game_seconds / d.clock_speed) or "?"))
      elseif d.slow_for_players then
        -- The rig ran, just not fast: someone is connected and the world clock is everybody's. Said
        -- because fifteen minutes of tower window is a fact the player should learn before the press,
        -- not after the second one.
        add(L("rg-slow", d.elapsed_game_seconds or "?"))
      end
      if d.slow_reason then add(truncated(tostring(d.slow_reason), 160)) end
      if d.cached then add(L("rg-cached")) end
      if d.error then add(refused_line({ code = d.error, msg = d.note or d.error }, 140)) end
    end
  elseif cmd == "freeze" then
    local f = d.frozen or {}
    -- The card's name is whatever the player typed or the scan guessed -- not an entity -- so it goes
    -- into the sentence as it is: looking `pipe` up as an entity would call a card by a machine's name.
    add(L("f-frozen", f.name or "?", d.entities or 0,
      f.measured_this_card == false and L("f-not-measured") or L("f-carries")))
    if d.claim_how or d.claim_how_key then add(L("f-how", words_for(d, "claim_how", 160))) end
    -- Grouped by WHY, and the ground itself folded into one count. Left as it was, a player who圈ed a
    -- patch got a hundred and twenty eight lines reading "跳过：coal —— 属于中立势力" and concluded the mod
    -- was losing their factory; the ore is not something a card can carry, and saying it 128 times is
    -- how that reads. The JSON keeps one entry per kind, because an agent wants exactly that.
    local skip_other, skip_ground, ground_kinds = {}, 0, 0
    for _, k in ipairs(list_of(d.skipped)) do
      if k.why_key == "s-why-force" then
        skip_ground = skip_ground + (tonumber(k.count) or 1); ground_kinds = ground_kinds + 1
      else
        skip_other[#skip_other + 1] = L("f-skipped", NM(k.name, "entity"), k.count or 1,
          words_for(k, "why", 160))
      end
    end
    for _, line in ipairs(skip_other) do add(line) end
    if skip_ground > 0 then add(L("f-skipped-ground", skip_ground, ground_kinds)) end
  elseif cmd == "plan" then
    local p = d.plan or d
    local shown = d.rate_shown or "?"
    if d.dropped_machine then
      -- Said out loud because the alternative is silence: the press changed the question, and a window
      -- that answers a different question than the one the button looked like it asked is the one a
      -- player stops trusting.
      add(L("n-dropped-machine", NM(d.dropped_machine.machine, "entity"), NMI(d.dropped_machine.item)))
    end
    add(L("n-asked", shown, NMI(d.item or "?"), d.unit_shown
      and (d.unit_shown == "per_second" and L("unit-second")
        or d.unit_shown == "per_hour" and L("unit-hour") or L("unit-minute")) or ""))
    -- Rows are the part of a plan that has no natural length; the summaries below it each take one line
    -- and every one of them changes what a player does next -- which candidate is on screen, what still
    -- has to arrive from outside, whether the ground can carry the power. So the rows are what gets
    -- counted, and the summaries are never the casualty of a long plan.
    local ROWS_SHOWN = 8
    for i, n in ipairs(list_of(d.how_many)) do
      if i > ROWS_SHOWN then
        add(L("n-more-rows", #list_of(d.how_many) - ROWS_SHOWN))
        break
      end
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
    -- The plan's own leftovers, in one line: everything the rows ask for that no row of this plan
    -- supplies, or supplies only partly. Folded from the rows rather than handed up, because this is
    -- the same arithmetic `G.model` does for the window line and a second source of the number would
    -- be a second truth -- so both read the rows, and neither is told the answer.
    do
      local gap = {}
      for _, n in ipairs(list_of(d.how_many)) do
        for _, nd in ipairs(list_of(n.needs)) do
          -- `item` and `per_min` are read through the same guard the row's own numbers use, because a
          -- stand-in answer is allowed to hold whatever its author typed: a string sneaking in where a
          -- number belongs is caught here rather than three lines later by `table.sort`, which then
          -- spends its time comparing two tables and takes the whole Plan press down with it.
          local item, per_min = or_blank(nd.item), tonumber(nd.gap_per_min)
          if item ~= "" and per_min and per_min > 0 then gap[item] = (gap[item] or 0) + per_min end
        end
        for _, nd in ipairs(list_of(n.needs_fluids)) do
          local item, per_min = or_blank(nd.item), tonumber(nd.gap_per_min)
          if item ~= "" and per_min and per_min > 0 then gap[item] = (gap[item] or 0) + per_min end
        end
      end
      -- Sorted by ITEM, before any of them becomes a localised table: `table.sort` on the built
      -- captions compares two tables and raises, which is how the first version of this line took the
      -- whole Plan press down rather than printing an unordered list.
      local items = {}
      for item in pairs(gap) do items[#items + 1] = item end
      table.sort(items)
      if #items > 0 then
        local parts = {}
        for _, item in ipairs(items) do
          parts[#parts + 1] = L("n-outside-item", NMI(item), string.format("%.0f", gap[item]))
        end
        add(L("n-outside", join(parts, ", "), #items))
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
      add(L("n-modules", NM(m.item, "item"), m.asked, NM(m.machine, "entity"), words_for(m, "note", 100)))
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
    -- The rounding alternatives the solver offered. `reason()` is written for refusals and placements
    -- (it knows name/code/why/recipe/item/coordinates), and a candidate is none of those -- so passed
    -- through it this row printed "也可以造：" with nothing after the colon, once per candidate. A label
    -- that promises a choice and delivers whitespace is worse than the row not existing: say the three
    -- things that make it a choice -- how many machines, what it delivers, and by how much it misses
    -- the number that was asked for.
    for _, cnd in ipairs(list_of(p.candidates)) do
      local over, under = tonumber(cnd.over_by), tonumber(cnd.shortfall)
      add(L("n-candidate", cnd.machine_slots or cnd.replicas or "?",
        cnd.output_per_min or "?",
        (over and over > 0 and L("n-cand-over", math.floor(over * 100 + 0.5)))
          or (under and under > 0 and L("n-cand-under", math.floor(under * 100 + 0.5)))
          or ""))
    end
    -- Which of those candidates the table a player is reading actually is. The rows scale with the
    -- direction picked in the form, so without this sentence 多放 looks like the plan grew by itself:
    -- "twice the unit line" is the fact, and the two rates are how a reader checks it.
    local rd = d.rounding
    if rd and rd.mode == "per_line" then
      -- A different sentence, not the same one with a different number: the table below is not a
      -- multiple of the unit line, so saying "twice the unit" over a per-row plan would be the window
      -- describing a factory it did not draw. The machine total is the figure a reader can add up from
      -- the rows, which is the whole point of rounding them separately.
      add(L("n-rounded-line",
        rd.direction == "down" and L("round-down") or rd.direction == "nearest" and L("round-nearest")
          or L("round-up"),
        rd.machine_slots or 0, rd.output_per_min or 0, rd.requested_per_min or 0))
    elseif rd then
      add(L("n-rounded",
        rd.label == "ceil" and L("round-up") or rd.label == "floor" and L("round-down") or L("round-unit"),
        rd.replicas or 0, rd.output_per_min or 0, rd.requested_per_min or 0))
    end
  elseif cmd == "measure" then
    add(L("m-start", d.job, (d.run_ticks or 0) / 60, word(STATE_WORDS, d.state)))
    add(L("m-expected", d.expected_per_min, d.entities or 0, d.feeds or 0, d.collectors or 0))
    if d.unwired_inputs then
      add(L("m-unwired", #list_of(d.unwired_inputs)))
    end
    -- The cost of the number, stated: a measurement that sped the world up ran everything else with it.
    if type(d.clock) == "table" then
      add(d.clock.warps_world
        and L("m-clock-warp", d.clock.speed, d.clock.game_seconds or "?", d.clock.real_seconds or "?")
        or L("m-clock-real", d.clock.game_seconds or "?"))
    end
    -- Where the number came from, said before the number is quoted. A bench is cleared, level, wired
    -- and fed by a patch laid out for the test; ground the player pointed at is their factory. The two
    -- answers are not interchangeable and the window used to print "on the bench" for both.
    if d.bench == true then add(L("m-where-bench"))
    elseif d.surface then add(L("m-where-ground", NM(d.surface, "surface"))) end
    add(L("m-hint"))
  elseif cmd == "status" then
    add(L("st-job", d.job, word(STATE_WORDS, d.state), d.elapsed_ticks,
      (d.elapsed_ticks or 0) + (d.remaining_ticks or 0)))
    if type(d.clock) == "table" then
      add(d.clock.warps_world
        and L("m-clock-warp", d.clock.speed, d.clock.game_seconds or "?", d.clock.real_seconds or "?")
        or L("m-clock-real", d.clock.game_seconds or "?"))
    end
    if d.state == "running" or d.state == "probing" then
      add(L("st-so-far", d.measured_per_min or "?", d.expected_per_min or "?"))
    end
    -- The same two sentences the start press gets: a player reading progress halfway through is about
    -- to act on this number, and which ground it is being measured on is part of what it means.
    if d.bench == true then add(L("m-where-bench"))
    elseif d.surface then add(L("m-where-ground", NM(d.surface, "surface"))) end
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
      or refused_line(res, 130))
    if d.measured_this_card == false then add(L("sv-still")) end
  elseif cmd == "fit" or cmd == "build" then
    local b = d.built or {}
    if d.box then
      add(L("b-box", d.box.w, d.box.h, NM(d.box.surface, "surface"),
        (d.lane or {}).footprint and d.lane.footprint.width,
        (d.lane or {}).footprint and d.lane.footprint.height,
        word(SPACING_WORDS, (d.lane or {}).spacing), (d.lane or {}).gap))
      add(L("b-fits", d.lanes_fit, d.per_row, d.rows, d.lanes_wanted))
      -- One lane's own worth, stated beside the count of lanes. Without it "fits 21 lanes" and
      -- "150/min" are two numbers the reader has to divide themselves, and the quotient is the one fact
      -- about the template they cannot see anywhere else.
      if (d.lane or {}).per_lane_rate then
        add(L("b-lane", string.format("%.1f", d.lane.per_lane_rate), NMI(d.lane.product or "?")))
      end
      -- A lane that drinks says so beside the verdict, with the cell its port stands on. This is the one
      -- part of a generated line the mod cannot finish -- it lays the row to the machine's box and leaves
      -- the free end for the player's own network -- and a player who never sees that cell gets a lane that
      -- sits dry and a report that says nothing about why.
      local feed = list_of((d.lane or {}).fluid_in)[1]
      if feed then
        add(L("b-fluid", NMI(feed.fluid or "?"), string.format("%.0f", feed.units_per_min or 0),
          NM(feed.pipe or "pipe", "entity"),
          (feed.port and feed.port.position)
            and string.format("%d,%d", math.floor(feed.port.position.x), math.floor(feed.port.position.y))
            or "?"))
      end
      -- The lane count above is in templates, and a template of a shared-pair row stands two machines.
      -- A player who read the plan as "5 furnaces" needs the conversion in the same breath as the
      -- verdict, including the case where rounding a row of pairs buys one machine more than asked.
      if (d.machines_per_lane or 1) > 1 then
        add(L("b-machines", d.machines_per_lane, d.machines_asked, d.lanes_wanted, d.machines_laid))
      end
      -- And what else is standing in the box. A row that carries its own poles is a bigger shape than
      -- the machines alone -- that is the whole reason 能否放下 answers a different number with 供电 on
      -- -- so the count and the spacing go beside the verdict rather than in a footnote.
      local pg = (d.lane or {}).power_grid
      if pg and (pg.poles or 0) > 0 then
        add(L("b-poles", pg.poles, pg.step, NM(pg.pole or "?", "entity")))
      elseif pg and pg.needed == 0 then
        add(L("b-poles-none"))
      end
      -- What the coverage search added on top of that, and what it could not reach. Kept separate from
      -- the row's own poles on purpose: one is the shape the player is looking at, the other is a
      -- repair the engine worked out, and a single line saying "7 poles" would hide which is which.
      -- Only said when the search actually had to do something beyond putting a generator on -- a line
      -- reading "0 more poles, 1 supply" beside a row that already carries its own is noise about a
      -- thing that worked.
      local ap = d.power_applied
      if ap and ((ap.poles or 0) > 0 or (ap.still_unserved or 0) > 0) then
        add(L("b-poles-fix", ap.poles or 0, ap.supply or 0, ap.still_unserved or 0))
      end
      -- The road under the claim. `row-chest` lays no product line at all (an arm lifts the plate into
      -- a chest), and saying "no product belt here" is a fact about the shape, not an omission.
      local bc = (d.lane or {}).belt_ceiling
      if bc and (bc.lines or 0) > 0 then
        add(L("b-belt", bc.lines, string.format("%.0f", bc.per_min or 0),
          string.format("%.1f", bc.claimed_per_min or 0)))
        if bc.over_claimed then add(words_for(bc, "next", 200)) end
      end
      -- ...and the arm's version of the same line, for the shape that has no belt to be the limit.
      -- Measured or not is the difference that matters to the reader: one is a ceiling they can plan
      -- against, the other is an instruction to go and measure it. They are not the same sentence, and
      -- neither is a silent absence beside a claim the player cannot check.
      local ac = (d.lane or {}).arm_ceiling
      if ac and (ac.arms or 0) > 0 then
        if ac.measured then
          -- Both ends, because they are two different claims and the lane sits somewhere between them:
          -- one item a swing is what an arm over a thin belt does, a full hand is what the rig's chest
          -- to chest does. Only the full-hand end is ever called a shortage.
          add(L("b-arm", ac.arms, NM(ac.arm or "?", "entity"),
            string.format("%.0f", ac.per_arm_min or 0), string.format("%.0f", ac.per_min or 0),
            string.format("%.0f", ac.per_min_floor or 0), string.format("%.1f", ac.claimed_per_min or 0)))
        end
        if ac.next or ac.next_key then add(words_for(ac, "next", 200)) end
      end
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
        add(refused_line(b.refused, 130))
        local g = (b.refused.detail or {}).ground
        if g then
          add(g.generated == false and L("b-ground-ungenerated", NM(g.tile or "?", "tile"))
            or L("b-ground", NM(g.tile or "?", "tile")))
        end
      end
    end
    if d.next or d.next_key then add(L("p-next", next_words(d))) end
  elseif cmd == "bus_preview" or cmd == "bus_lay" then
    -- A group, counted. These lines are the group's own arithmetic rather than a plan row's: what one
    -- group covers, how many landed in the box, what is left over, and what the box makes per minute --
    -- which for a bus is a VECTOR, one line per candidate, because "the rate" of a group that makes
    -- three things is a number belonging to no recipe on it.
    local g = d.group or {}
    local gb = g.bus or {}
    local lay = cmd == "bus_lay"
    add(L("gb-mode", word(BUS_MODES, d.bus_mode or gb.mode), tostring(d.machines or g.machines or "?")))
    if (d.bus_target or gb.target) then
      add(L("gb-target", tostring(d.bus_target or gb.target), tostring(gb.shelves or "?"),
        tostring(gb.boxes or "?")))
    end
    if d.box then
      add(L("gb-box", tostring((d.box or {}).width or (d.box or {}).w or "?"),
        tostring((d.box or {}).height or (d.box or {}).h or "?"),
        NM(d.box.surface or "?", "surface"),
        tostring(g.width or "?"), tostring(g.height or "?"),
        tostring((d.cols or "?")), tostring((d.rows or "?")),
        tostring(d.groups or "?"), tostring(d.left_over or "?")))
    end
    for _, c in ipairs(list_of(gb.covered)) do
      add(L("gb-covered", NM(c.recipe, "recipe"), tostring(c.position), tostring(c.machines or 0)))
    end
    if gb.unclaimed then
      local un = {}
      for _, r in ipairs(list_of(gb.unclaimed)) do un[#un + 1] = NM(r, "recipe") end
      add(L("gb-unclaimed", join(un, ", ")))
    end
    if gb.idle_machines then
      local idl = {}
      for _, k in ipairs(list_of(gb.idle_machines)) do idl[#idl + 1] = tostring(k) end
      add(L("gb-idle", join(idl, ", ")))
    end
    -- Per candidate: what one hand there is worth, and what the landed groups are worth together. Under
    -- shortage neither is a promise about what gets built WHEN -- that is the shelf's decision -- which
    -- is what the `缺货` line above is for.
    for _, r in ipairs(list_of((d.output or {}).total)) do
      if r.recipe then
        add(L("gb-rate", NM(r.recipe, "recipe"), string.format("%.1f", r.per_min or 0),
          string.format("%.1f", r.per_min_total or r.per_min or 0)))
      end
    end
    if lay then
      local b = d.built or {}
      if b.card then
        add(L("gb-laid", b.card, tostring(b.groups_used or b.lanes_used or "?")))
        local p = b.placed or {}
        if p.ghosts then
          local w = p.wires or {}
          add(L("gb-ghosts", p.ghosts, p.origin and p.origin.x, p.origin and p.origin.y,
            tostring(w.drawn or 0)))
          if w.redraw_pending then add(L("gb-redraw", tostring(w.job or "?"))) end
          for _, e in ipairs(list_of(p.refused)) do add(L("pl-refused", or_blank(reason(e)))) end
        elseif b.refused then
          add(refused_line(b.refused, 130))
        end
      end
    end
    for _, l in ipairs(list_of(surface_words(d.surface))) do add(l) end
    if d.next or d.next_key then add(L("p-next", next_words(d))) end
  else
    add(L("t-no-summary", tostring(cmd)))
  end
  -- Still a ceiling -- a plan must not be able to push the frame off the screen -- but counted against
  -- the row cap above rather than against everything, so what a reader would lose here is a repeated
  -- row and not the sentence that tells them what to do about it.
  if #lines > 24 then
    local cut = {}
    for i = 1, 24 do cut[i] = lines[i] end
    cut[#cut + 1] = L("t-more", #lines - 24)
    lines = cut
  end
  return { title = titled(cmd, name), lines = lines }
end

-- Fill the report area. Returns whether it was reached: a panel closed between the click and here is
-- a real sequence, and `show_string` already treats it that way.
function G.show_report(player, title, lines)
  local frame = player.gui and player.gui.screen and player.gui.screen[ROOT]
  local box = frame and G.find(frame, REPORT)
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
  local row = G.find(frame, "arch-string-row")
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

-- The registry's ids, as the window sees them: `model.styles` is built from `styles.ids()` on the
-- way in, and the fallback is the shape this mod laid before there was a choice at all.
local STYLE_FALLBACK = { "row-chest" }

-- The form is read back as the ROW the player chose for the style, not the word: the id behind that row
-- belongs to the registry, and a list of ids copied into this file would be free to fall out of step
-- with the file that owns it.
local function read_form(player, model)
  local frame = player.gui and player.gui.screen and player.gui.screen[ROOT]
  if not frame then return nil end
  local row = G.find(frame, "arch-form-row")
  if not row then return nil end
  -- By name, from the whole window -- not from `arch-form-row`. The hardware pickers sit on a row of
  -- their own (the form row had grown past what a hand can scan), and a hop written as `row[name]`
  -- read them as missing: the drop-downs were on screen, filled in, and silently absent from every
  -- click. `G.find` is what makes the window's shape someone else's problem.
  local function idx(name)
    local el = G.find(frame, name)
    return el and el.selected_index
  end
  local power = G.find(frame, "arch-form-power")
  return {
    item_index = idx("arch-form-item"),
    machine_index = idx("arch-form-machine"),
    module_index = idx("arch-form-module"),
    unit_index = idx("arch-form-unit"),
    rate = tonumber((row["arch-form-rate"] or {}).text),
    module_count = tonumber((row["arch-form-module-count"] or {}).text),
    power = power and power.state or false,
    spacing_index = idx("arch-form-spacing"),
    -- The two word lists the window draws and the two this function reads back are now the same
    -- constants: a third copy of `{"compact", ...}` here was free to fall out of step with the labels
    -- above, and the way to tell was to build with the wrong aisle width.
    spacing = SPACING_WORDS[idx("arch-form-spacing") or 1],
    -- The drop-down's words are the only thing translated here; the id the solver takes is the row it
    -- sits on, so renaming a label cannot change a plan.
    round = ({ "unit", "up", "down", "nearest" })[idx("arch-form-round") or 1],
    round_index = idx("arch-form-round"),
    round_when = WHEN_WORDS[idx("arch-form-when") or 1],
    round_when_index = idx("arch-form-when"),
    orientation = ORIENTATIONS[idx("arch-form-orientation") or 1],
    orientation_index = idx("arch-form-orientation"),
    -- Whether a too-small box lays less, or lays nothing and says so. The default row is `fill`.
    fit_mode = FIT_MODES[idx("arch-form-fit") or 1],
    fit_mode_index = idx("arch-form-fit"),
    -- The ROW the player chose; the id behind it is resolved where the registry lives. Same bargain
    -- as the item and machine menus, so renaming a label cannot move a plan into another shape.
    -- one row of slack because row 1 is 自动, which reads back as "" (no preference)
    style = ((model or {}).styles or STYLE_FALLBACK)[(idx("arch-form-style") or 1) - 1],
    style_index = idx("arch-form-style"),
    -- The hardware row: which belt, which arm, which chest the lane is built out of. Names, not rows,
    -- because the shape builder takes names; row 1 (自动) answers nil, which is the same "no opinion"
    -- these arguments had before the row existed.
    belt_index = idx("arch-form-belt"),
    arm_index = idx("arch-form-arm"),
    chest_index = idx("arch-form-chest"),
    pole_index = idx("arch-form-pole"),
    belt = menu_value((model or {}).menus and model.menus.belts, idx("arch-form-belt")),
    arm = menu_value((model or {}).menus and model.menus.arms, idx("arch-form-arm")),
    chest = menu_value((model or {}).menus and model.menus.chests, idx("arch-form-chest")),
    pole = menu_value((model or {}).menus and model.menus.poles, idx("arch-form-pole")),
    -- Which bench rig the 台架 row is asking for, and the word it will hand that rig as its argument.
    -- The argument is read here, where the window's own choices live, so the click handler stays a
    -- single line per rig and the method stays the one that decides whether the name means anything.
    -- Which helmod factory this press should lay: the drop-down's row maps to the id the model listed,
    -- so the value handed to the method is the same string the player saw -- and row 1 means "all of
    -- them together", which is what an empty string means everywhere else in this window.
    helmod_factory = ((model.helmod or {}).factories or {})[(idx("arch-form-helmod") or 1) - 1]
      and tostring((((model.helmod or {}).factories or {})[(idx("arch-form-helmod") or 1) - 1]).id) or "",
    helmod_factory_index = idx("arch-form-helmod"),
    rig = RIGS[idx("arch-form-rig") or 1],
    rig_index = idx("arch-form-rig"),
    rig_item = menu_value((model or {}).menus and model.menus.items, idx("arch-form-item")),
    -- The bus row. Read by the same `G.find` as everything else in the window, and by NAME built from
    -- the candidate's position -- which is safe here only because the row that wrote those names is the
    -- row that reads them, and the count is clamped to `BUS_MAX` on both sides. A widget the row did not
    -- build (no candidates, or a machine that cannot craft anything the lane could carry) reads nil and
    -- is left out rather than becoming an unchecked candidate: the first version of this loop walked
    -- `cands` blindly, so a window with two boxes in it reported eight.
    bus_mode = BUS_MODES[idx("arch-form-bus-mode") or 1],
    bus_mode_index = idx("arch-form-bus-mode"),
    bus_target = tonumber((G.find(frame, "arch-form-bus-target") or {}).text),
    bus_each = tonumber((G.find(frame, "arch-form-bus-each") or {}).text),
    bus_on = (function()
      local out, n = {}, 0
      local row = G.find(frame, BUS_ROW)
      if not row then return out end
      for i = 1, BUS_MAX do
        local cb = G.find(frame, "arch-bus-c" .. i)
        if cb and cb.state == true then
          out[i] = true
          n = n + 1
        end
      end
      return n > 0 and out or nil
    end)(),
    bus_counts = (function()
      local out = {}
      for i = 1, BUS_MAX do
        local f = G.find(frame, "arch-bus-n" .. i)
        if f then out[i] = tonumber(f.text) or 1 end
      end
      return next(out) ~= nil and out or nil
    end)(),
  }
end

-- The two numbers beside 以脚下取框. Read off the widgets at click time, like the form: the panel decides
-- nothing, including how big a box it is about to ask for, and a nil here is the method's `default 21`
-- rather than a guess made in the window.
local function read_box_size(player)
  local f = player.gui and player.gui.screen and player.gui.screen[ROOT]
  local row = f and G.find(f, BOX_HERE_ROW)
  if not row then return nil, nil end
  return tonumber((row["arch-box-w"] or {}).text), tonumber((row["arch-box-h"] or {}).text)
end

-- Fit, and fit-then-lay. Both take the form plus the box the player dragged; `lanes` is the count the
-- plan asked for, which is why Fit runs first -- a Build with no box is refused with a sentence about
-- what a box is, not a crash.
local function fit_or_build(player, cmd, model, api)
  local form = read_form(player, model) or {}
  local sel = model.selection
  if not sel then
    -- Built with `fail_key` rather than hand-written as a string, so that the sentence is gated like
    -- every other refusal: `dev/locale_check.js` fails the build if the row behind the key stops
    -- matching the line below. This particular refusal was the one English sentence the window could
    -- still produce, and a player who has not drawn a box sees it on EVERY fit click, whatever they
    -- chose in the form -- which reads as "the button is broken", not as "I have not drawn a box".
    local res = host.fail_key("NO_SELECTION", "m-no-box-fit", nil,
      "no box is drawn -- hold nothing in your hand, drag a rectangle over the ground, then press this "
      .. "again: lanes are laid INSIDE that rectangle")
    local out = G.report_lines(cmd == "arch-fit" and "fit" or "build", "", res)
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
    local row = f and G.find(f, "arch-ask-row")
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

-- Every button this dispatcher answers for, named in the file that owns the answering. The self-test
-- snapshots the report area after each of these clicks, and until now it kept its own copy of this list
-- in control.lua -- which is how `arch-undo` and `arch-boxhere` were added to the window, dispatched
-- correctly, and never once checked for the answer they left in it: a list maintained two files away from
-- the thing it describes rots exactly that quietly.
G.COMMAND_BUTTONS = { "arch-read", "arch-freeze", "arch-watch", "arch-boxhere", "arch-plan", "arch-fit",
  "arch-more-cards",
  "arch-build", "arch-status", "arch-save", "arch-undo", "arch-ask", "arch-queue", "arch-power",
  "arch-measure", "arch-verify", "arch-why", "arch-string", "arch-rig", "arch-helmod",
  "arch-helmod-all",
  "arch-bus-preview", "arch-bus-lay" }

-- Button names carry their argument because Factorio hands the click handler an element, not
-- a closure: "arch-place:<card>" is the whole context. The verbs are the methods a player cannot
-- run from chat, and the point of listing them here is that the panel stops being a deploy button:
-- the same questions an outside designer asks over RCON, answered in the window for whoever is
-- standing in the factory.
function G.on_click(player, element_name, model, api)
  if not element_name then return nil end
  if element_name == "arch-close" then G.close(player); return "closed" end
  if element_name == "arch-refresh" then G.open(player, model); return "refreshed" end
  do
    -- Navigation, and the only button family that changes no world state. It goes through the api because
    -- the page belongs to the same per-player panel state the goal and the card page do, and because the
    -- rebuild IS the answer: a press that only moved a number would leave the old page on screen.
    local wanted = element_name:match("^arch%-page%:(%a+)$")
    if wanted then return "page", api.show_page(wanted) end
  end
  if element_name == "arch-more-cards" then return "cards", api.show_more_cards() end
  if element_name == "arch-status" or element_name == "arch-save" then
    local is_status = element_name == "arch-status"
    local res = is_status and api.progress() or api.save_measurement()
    local out = G.report_lines(is_status and "status" or "save", "", res)
    G.show_report(player, out.title, out.lines)
    return is_status and "status" or "save", res
  end
  if element_name == "arch-helmod-all" then
    local res = api.helmod_all(read_form(player, model))
    local out = G.report_lines("helmod_all", "", res)
    G.show_report(player, out.title, out.lines)
    if res and res.ok then
      local d = res.data or {}
      player.print(L("chat-hmall", tostring(d.count or 0),
        tostring((d.refused and #d.refused) or 0)))
    end
    return "helmod_all", res
  end
  if element_name == "arch-helmod" then
    local form = read_form(player, model) or {}
    local res = api.helmod(form)
    local out = G.report_lines("helmod", "", res)
    G.show_report(player, out.title, out.lines)
    if res and res.ok then
      -- The text goes in the copyable field beside the item going in the pack: one press, two doors,
      -- and the second of them writes nothing to the player at all.
      local d = res.data or {}
      local shown = d.blueprint and G.show_string(player, "helmod", d.blueprint) or false
      player.print(L("chat-helmod", tostring(d.ghosts or d.held or 0),
        tostring(d.surface or "?"),
        shown and "(Ctrl+C)" or (d.blueprint and "(field gone)" or "(no text)")))
    end
    return "helmod", res
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
    local form = read_form(player, model)
    local res = api.plan(form or {})
    local out = G.report_lines("plan", tostring((form or {}).item_index or "?"), res)
    G.show_report(player, out.title, out.lines)
    return "plan", res
  end
  if element_name == "arch-ask" or element_name == "arch-queue" then
    return ask_or_queue(player, element_name, model, api)
  end
  if element_name == "arch-boxhere" then
    local w, h = read_box_size(player)
    local res = api.box_here(w, h)
    local out = G.report_lines("boxhere", "", res)
    G.show_report(player, out.title, out.lines)
    return "boxhere", res
  end
  -- Walking down the plan. `arch-pick:<item>` makes that product the new target at the rate this plan
  -- already needs of it; `arch-scale:<factor>` moves the target without reaching for the keyboard.
  -- Both re-render the frame afterwards, because the rows ARE the answer, and an answer that left the
  -- old rows on screen would be offering a second, stale copy of the same tree.
  local picked = element_name:match("^arch%-pick:(.+)$")
  local scaled = element_name:match("^arch%-scale:([%d%.]+)$")
  if picked or scaled then
    local res = scaled and api.plan_scale and api.plan_scale(tonumber(scaled))
      or api.plan_to and api.plan_to(picked) or { ok = false, code = "NO_HANDLER", msg = "plan" }
    -- Re-render FIRST: `G.open` rebuilds the frame, and a report written before it would be written
    -- into the flow that is about to be thrown away -- which is the shape of "I pressed it and the
    -- answer vanished", not a bug in the plan.
    local fresh_model = model
    if res and res.ok and api.model then
      local ok, m = pcall(api.model)
      if ok and m then fresh_model = m end
      G.open(player, fresh_model)
    end
    local out = G.report_lines("plan", picked or "", res)
    G.show_report(player, out.title, out.lines)
    return scaled and "scale" or "pick", res
  end
  if element_name == "arch-bus-preview" or element_name == "arch-bus-lay" then
    -- The two presses of the bus row, and the second one is the only press in the window that lays
    -- ghosts from something other than a plan row: the group is asked for per candidate, so the plan
    -- table has no row that describes it. Lay is Fit with the ghosts attached -- `group_fit` is the one
    -- that counts the box, so a box too small for a whole group answers rather than half-laying one.
    local form = read_form(player, model) or {}
    local res = api.bus and api.bus(form, element_name == "arch-bus-lay")
      or host.fail_key("NO_HANDLER", "m-bus-no-handler", nil, "the bus row's press has no handler in this build")
    local out = G.report_lines(element_name == "arch-bus-lay" and "bus_lay" or "bus_preview",
      tostring(form.bus_mode or "?"), res)
    G.show_report(player, out.title, out.lines)
    return element_name == "arch-bus-lay" and "bus_lay" or "bus_preview", res
  end
  if element_name == "arch-watch" then
    -- Pressed again after the window closes and the same click returns the finished record: the job
    -- finalises on the tick its deadline passes, and this is the click that comes to read it.
    local res = api.line_watch and api.line_watch() or { ok = false, code = "NO_HANDLER", msg = "watch" }
    local out = G.report_lines("watch", "", res)
    G.show_report(player, out.title, out.lines)
    return "watch", res
  end
  if element_name == "arch-rig" then
    -- One click, one rig, one argument taken from what is on the screen. Pressed again after the
    -- window closes, the same click reads the finished record back -- the rigs answer `running` while
    -- their window is open, exactly like `arch-watch` does, so the button is both the start and the
    -- result and a player never has to guess which one they got.
    local form = read_form(player, model) or {}
    local res = api.rig and api.rig(form.rig or "arm", form)
      or { ok = false, code = "NO_HANDLER", msg = "rig" }
    local out = G.report_lines("rig", form.rig or "", res)
    G.show_report(player, out.title, out.lines)
    return "rig", res
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
      -- The same sentence the report area shows, on the chat line too: this is the one place a refusal
      -- reaches a player who is not looking at the window, and it used to be English by construction.
      player.print(L("chat-refused", name, refused_line(res, 160)))
    end
    local out = G.report_lines("place", name, res)
    G.show_report(player, out.title, out.lines)
    return "place", res
  elseif cmd == "arch-carry" then
    local res = api.carry and api.carry(name) or { ok = false, code = "NO_HANDLER", msg = "carry" }
    if res and res.ok then
      player.print(L("chat-carry", name, tostring((res.data or {}).landed or 0)))
    else
      player.print(L("chat-refused", name, refused_line(res, 160)))
    end
    local out = G.report_lines("carry", name, res)
    G.show_report(player, out.title, out.lines)
    return "carry", res
  elseif cmd == "arch-verify" or cmd == "arch-why" or cmd == "arch-power" or cmd == "arch-measure"
    or cmd == "arch-wire" then
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
