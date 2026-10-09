-- The player-facing panel: the window on the side of the mod that a hand uses.
--
-- It answers one question now that helmod cannot answer itself -- 把算好的那一页变成地上的线 -- and it
-- holds exactly the inputs that question needs: which shape, whether the line ends in a bare belt or a
-- chest, which factory page, and the three presses (压线 / 整页 / 撤回). Everything else this file used to
-- render (a card table, a dragged box, seven part menus, six verbs per row) went out with the methods it
-- drove, and the RCON surface lost the same doors.
--
-- Division of labour is the same as everywhere else in this project: this file renders and dispatches, it
-- decides nothing. The data it shows comes from `G.model`, a plain function over the same tables the RCON
-- methods return -- so the panel's CONTENTS are regression testable without a client. The build and click
-- code is too, against a recording stand-in for a player (`M.gui_selftest`), which is how the dead Ask
-- button was found: dispatch, swallowed raises and renamed fields all show up there. Widget specs are
-- checked by name against the installed runtime API, types included. What no headless run reaches is what
-- the window is like to READ -- whether a row of buttons is too much to find your way around, whether
-- anyone notices the checkbox at all -- and that is a person with a client, not a suite.
--
-- Every sentence here is a key, and the words behind it live in `locale/en` and `locale/zh-CN`: the
-- window is in the language of whoever is looking at it, while the values inside the sentences stay the
-- prototype ids and numbers the RCON answer uses. See `L` below for why that split is free.

local G = {}

-- Two things, both lookups with no judgement in them: `host.clip`, so that a caption and a chat line
-- are cut on the same rule; and `host.icon_sprite`, so that the picture next to a row is looked up by
-- the same helper that decides whether there is one at all.
local host = require("host")

-- 右上角那颗 mod_gui 按钮要 core 的一份 lualib。它必须在这里、在这份文件被解析的那一刻取：引擎只在
-- control.lua 的解析期允许 `require`，运行期调它会直接回答 "Require can't be used outside of control.lua
-- parsing."（量过）。取不到也不报错 —— 那颗按钮只是不出现，窗口还有 `/arch` 和工具栏快捷键两扇门。
local ok_mod_gui, mod_gui = pcall(require, "mod-gui")
if not ok_mod_gui or type(mod_gui) ~= "table" or type(mod_gui.get_button_flow) ~= "function" then
  mod_gui = nil
end

local ROOT = "arch-root"
G.ROOT = ROOT   -- the self-test looks the frame up by this name

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

-- The whole head line of a refusal: `refused: CODE -- <the sentence the method refused with>`, with the
-- sentence taken from the key when there is one. `clip` is the long-standing cut on the English line,
-- which a key does not need (its words are chosen by whoever is looking at the window, and cutting them
-- would cut the numbers the sentence is about).
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

local function word(map, value)
  return map[value] or tostring(value)
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
-- The list a build with no styles layer would show: the two shapes that are left, in the order the
-- ladder walks them. `model.styles` normally carries the registry's own ids, and a panel that hardcoded
-- them would be a second list free to fall behind the file it is supposed to describe -- which is
-- exactly what the one name this list used to hold (`row-chest`) became: a deleted shape, offered as a
-- real row, refused the moment a player picked it.
local STYLE_FALLBACK = { "stacked", "two-row" }
-- 线头每一行按下发出去的词，和下面建下拉时写的 `items` 一一对应：第 1 行是"不表态"（空串，读回 nil），
-- 第 2 行是裸带。带箱子的线头已经随那四种排法删掉，这一列里就不该再有它的名字 —— 而 `gui_selftest`
-- 当场比一次"标签有几行、值有几项"，因为从前这里标签两行、值三行，玩家选"裸带"按下的是删掉的那一档。
local HEAD_VALUES = { "", "belt" }
-- 交给 `gui_selftest` 当场比一次"下拉有几行、值列有几项"：这两份东西分在两处写的时候，玩家选"裸带"
-- 按下的是已经不存在的 `chest`。
G.head_values = HEAD_VALUES

-- Words for the registry's ids. One lookup per id, spelled out: a key assembled from a prefix at
-- runtime is a key no static check can prove exists, and the player reading a raw key where a style
-- name should be is how this file's whole locale policy got written in the first place.
local STYLE_WORDS = {
  -- 由流量数出来的那一档（F 条进料带 + P 条成品带，混档臂，零箱）。这个兜底表是"没有 styles 层时
  -- 面板该显示什么"，新形状不在这里就会出现一个键名顶在玩家面前。
  ["stacked"] = L("style-stacked"),
  ["fluid-back"] = L("style-fluid-back"),
  -- 双排：两排机器共用中间那条成品带。加一档形状而没加这一行时，`locale_check` 会以"这个键没人用了"
  -- 报红 —— 那条红就是留给这一刻的。
  ["two-row"] = L("style-two-row"),
}

local function style_labels(ids)
  local out = {}
  for _, id in ipairs(ids or STYLE_FALLBACK) do
    out[#out + 1] = STYLE_WORDS[id] or tostring(id)
  end
  return out
end
-- How many candidates the row offers as ticks before it says "pick from the plan instead". The window
-- grows with the save otherwise, and a list of 400 checkboxes is not a choice a hand can make.
local BUS_MAX = 12
local BUS_ROW = "arch-bus-row"   -- the row's own name, read by `read_form`
local RIG_ROW = "arch-rig-row"


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
-- 面板要看的那份数据。只剩四样：名字与版本、玩家留在两个下拉里的偏好、形状清单、helmod 现在有哪几页。
-- 从前这里还带冻住的卡片列表、拖出来的方框、七份零件菜单（物品/机器/模组/带/臂/箱/杆）和上一份计划的
-- 表格 —— 那些行渲染的是已经不在这个窗口里的按钮，图标还得先在 data 阶段注册成 sprite 才能画。
function G.model(version, panel)
  local goal = (panel or {}).goal or {}
  return {
    -- 窗口标题读自 locale：这个名字要在英文窗口和中文窗口里都像是有人起的，而不是一个占位的英文单词。
    -- `info.json` 的 title 是单份字符串（引擎不在那里查 locale），所以它是"铺线师 Linewright"这种两边
    -- 都认的写法，而窗口里这一格说的是玩家自己语言里的那一个。
    title = L("app-title"),
    version = version,
    -- 一句提示：这条链现在只回答一件事 —— helmod 算好了，这里把它变成线。
    hint = L("hint-helmod"),
    goal = goal,
    helmod = (panel or {}).helmod,
    auto_refresh = (panel or {}).auto_refresh and true or false,
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

-- The picker's two parallel arrays: the factory id behind each row (so a rebuild can put the selection
-- back by NAME -- an index would point at a different page once helmod has one fewer factory), and the
-- words the row shows. Row 1 is "整页", which belongs to no id.
local function helmod_rows(model)
  local hm = model.helmod or {}
  local ids, items = { "" }, { L("helmod-all") }
  for _, f in ipairs(hm.factories or {}) do
    ids[#ids + 1] = f.id
    if f.kind == "line" then
      items[#items + 1] = L("helmod-line-word", NM(f.name or "?", "recipe"),
        tostring(tonumber(f.machines) or 0), NM(f.machine or "?", "entity"))
    else
      items[#items + 1] = string.format("%s · %s", tostring(f.name or f.id),
        tostring(tonumber(f.machines) or 0) .. " / " .. tostring(tonumber(f.recipes) or 0))
    end
  end
  return ids, items, hm
end

-- 把 `row` 清空，再按 model 摆回这一行的四件东西：标签、那一页的下拉、压线/整页/撤回三颗按钮。
--
-- `selected_id` 是重建前从旧下拉里读到的那一页的 id。没有它时退回玩家上一次按下记住的那一页。
function G.helmod_row(row, model, selected_id)
  if not row then return false end
  for _, c in ipairs(row.children or {}) do c.destroy() end
  row.add { type = "label", caption = L("form-helmod") }
  local ids, items, hm = helmod_rows(model)
  if #items > 1 then
    row.add { type = "drop-down", name = "arch-form-helmod", items = items,
      selected_index = word_index(ids, selected_id or (model.goal or {}).helmod_factory),
      tooltip = L("form-helmod-tip") }
  else
    -- 没有下拉的时候这一格必须有一句话，而且那句话要说清是哪一种"没有"：没装、装了但没算、
    -- 还是算了但这页里没有可铺的东西。从前这里只在 `hm.error` 时摆一句，于是空列表连一句都没有，
    -- 玩家看到的是一行安静的空白，只能反复按同一颗按钮。
    row.add { type = "label", name = "arch-helmod-none",
      caption = L("helmod-none", hm.msg_key and L(hm.msg_key) or L("report-idle")) }
  end
  row.add { type = "button", name = "arch-helmod", caption = L("helmod"), tooltip = L("helmod-tip") }
  row.add { type = "button", name = "arch-helmod-all", caption = L("helmod-all-press"),
    tooltip = L("helmod-all-tip") }
  -- 压线铺的是虚影，而虚影身上装不了模块（实测）。这一颗是他**建完之后**按的：把上一按那一页点名的
  -- 模块从地上的箱子里拿出来装进真机器。它跟压线用同一个页下拉，所以不会成为"第二份意见"。
  row.add { type = "button", name = "arch-modules", caption = L("modules-press"),
    tooltip = L("modules-tip") }
  -- 蓝图粘完之后按这一颗：把这片地上的机器挨个打开「从电路网络读取配方」。引擎不接受这一格进
  -- 脚本写的蓝图（实测七种拼法都回读为空），所以不是模不肯做，是那一路根本没有这个口。
  row.add { type = "button", name = "arch-listen", caption = L("listen-press"),
    tooltip = L("listen-tip") }
  row.add { type = "button", name = "arch-undo", caption = L("place-undo"),
    tooltip = L("place-undo-tip") }
  return true
end

-- 这一行现在该显示什么：有页就把每一行标签串起来；一页都没有时它不是"一行下拉"，而是那句原因，
-- 所以签名也就是那句原因的位置（`(none)`）。两边写成同一套，没有计划的存档才不会每一秒都重画一次。
function G.helmod_signature(model)
  local _, items = helmod_rows(model)
  if #items <= 1 then return "(none)" end
  local out = {}
  for i, s in ipairs(items) do out[i] = tostring(s) end
  return table.concat(out, "\1")
end

local function helmod_shown(frame)
  local dd = frame and G.find(frame, "arch-form-helmod")
  if dd and dd.items then
    local out = {}
    for i, s in ipairs(dd.items) do out[i] = tostring(s) end
    return table.concat(out, "\1")
  end
  return G.find(frame, "arch-helmod-none") and "(none)" or "(blank)"
end

-- 自动刷新那一格真正做的事：只重画 helmod 那一行，答案区、蓝图串、两个下拉都不动。
-- 返回 false 表示窗口不在（那正是计时器该什么都不做的时候）。
--
-- 返回值里的 `"same"` 是这一版的新东西，也是玩家用手指头量出来的那条 bug 的修法：**列表没变就不许碰
-- 那一格下拉**。下拉是一列展开的选项，重建它等于把它连根拔掉 —— 无条件一秒一次的话，他每次展开列表
-- 都会被关掉，那一按还没落下，于是"选择配方列表一直关闭、没有办法选择"。真变了才重建（那一下确实会
-- 关弹窗，但那是他的 helmod 多了一页/少了一页），而答案区仍然不动。
function G.refresh_world(player, model)
  local frame = player.gui and player.gui.screen and player.gui.screen[ROOT]
  if not frame then return false end
  local row = G.find(frame, "arch-helmod-row")
  if not row then return false end
  if helmod_shown(frame) == G.helmod_signature(model) then return "same" end
  local held = G.find(frame, "arch-form-helmod")
  local selected
  if held and held.selected_index then
    local ids = helmod_rows(model)
    selected = ids[held.selected_index]
  end
  return G.helmod_row(row, model, selected)
end

-- 右上角那颗按钮，和 helmod 同一处。`mod_gui` 是文件顶上取好的那份（运行期不能再 require），所以拿不到
-- 它就是不建 —— 窗口本身还有 `/arch` 和右下角快捷键两扇门，一颗建不出来的按钮不该把别的入口一起带走。
function G.toolbar_button(player, on)
  if not mod_gui then return false, "mod-gui library not available" end
  local flow = mod_gui.get_button_flow(player)
  if not flow then return false, "no button flow" end
  local existing = flow["arch-toolbar"]
  if not on then
    if existing then existing.destroy() end
    return true
  end
  if existing then return true end
  flow.add {
    type = "sprite-button", name = "arch-toolbar",
    sprite = "architect-toolbar",
    style = mod_gui.button_style,
    tooltip = L("shortcut-open"),
  }
  return true
end

-- 整个窗口：两个偏好下拉、一个工厂页选择、三个按钮、一块答案区。
--
-- 从前这块地方是 570 行、四个分区、三页导航、七份零件菜单和一张会自己长行的卡片表。它们服务的按钮
-- 已经随功能一起删了，留下的这条链只有一个问题要回答：helmod 算好了，怎么变成地上的线。
--
-- 一个约定没变：所有分区都是先建好、再按状态显示或销毁，因为**创建的顺序就是绘制的顺序** —— 只建
-- 当前页的窗口会随状态挪动自己的部件，而且会把不在当前页的行从自测和套件读名字的树里摘掉。
function G.build(player, model)
  clear_frame(player)
  local frame = player.gui.screen.add {
    type = "frame", name = ROOT, direction = "vertical",
    -- 标题是一个本地化串表，不是一串英文：`..` 拼不动它（量过：`attempt to concatenate field 'title'
    -- (a table value)`，整扇窗建不出来）。引擎的写法是把空串放在列表第一位，后面每一项各是自己。
    caption = { "", model.title, "  v" .. tostring(model.version) },
  }
  frame.auto_center = true
  local head = frame.add { type = "flow", direction = "horizontal" }
  head.add { type = "label", caption = model.hint }
  head.add { type = "button", name = "arch-refresh", caption = L("refresh") }
  -- 自动刷新是一格偏好，不是一颗按钮：它改的是"这个窗口开着的时候每隔一会儿重读 helmod"，所以它的状态
  -- 必须能留在存档里（下次开窗口还是玩家上次要的样子），也必须手动那一按还在 —— 有人只想在自己按下之后
  -- 看一眼结果。
  head.add { type = "checkbox", name = "arch-auto-refresh", state = model.auto_refresh and true or false,
    caption = L("auto-refresh"), tooltip = L("auto-refresh-tip") }
  head.add { type = "button", name = "arch-close", caption = L("close") }

  -- 玩家的输入只有这三格，而且每一格都是一个 RCON 参数，不是这个文件自己的意见：第 1 行都是"不表态"
  -- （空串），于是记住的选择和窗口重建后看到的选择不会各说一套。
  local form = frame.add { type = "flow", direction = "horizontal", name = "arch-form-row" }
  form.add { type = "label", caption = L("form-style") }
  local style_ids = { "" }
  for _, id in ipairs(model.styles or STYLE_FALLBACK) do style_ids[#style_ids + 1] = id end
  local style_items = { L("style-auto") }
  for _, word in ipairs(style_labels(model.styles)) do style_items[#style_items + 1] = word end
  form.add { type = "drop-down", name = "arch-form-style", items = style_items,
    selected_index = word_index(style_ids, (model.goal or {}).style) }
  form.add { type = "label", caption = L("form-heads") }
  -- 线头只剩两档可选（不表态 / 裸带）。标签写在这一行的字面上（`locale_check` 才证得了这两个键真的存
  -- 在），值写在旁边的 `HEAD_VALUES` 一列里，两列的行数由 `gui_selftest` 当场比一次。
  form.add { type = "drop-down", name = "arch-form-heads",
    items = { L("heads-auto"), L("heads-belt") },
    selected_index = word_index(HEAD_VALUES, (model.goal or {}).heads),
    tooltip = L("form-heads-tip") }
  -- 带子那一格是"可以选"那一半：默认（第一行）不表态，由模按这条线的流量从最慢能装的开始挑；
  -- 往下点就是玩家自己指定哪一档。候选读自零件阶梯，所以模组加的带子也在这列表里。
  form.add { type = "label", caption = L("form-belt") }
  local belt_items, belt_ids = { L("belt-auto") }, { "" }
  for _, name in ipairs(model.belts or {}) do
    -- 名字用游戏自己的翻译，后面跟着原型 id —— 和本 mod 其它菜单同一写法。`NM` 交回的是一个本地化串
    -- 表，不能 `..` 拼（拼一次窗口就整扇建不起来，量过），所以这句话走 locale。
    belt_items[#belt_items + 1] = L("belt-row", NM(name, "entity"), name)
    belt_ids[#belt_ids + 1] = name
  end
  form.add { type = "drop-down", name = "arch-form-belt", items = belt_items,
    selected_index = word_index(belt_ids, (model.goal or {}).belt),
    tooltip = L("form-belt-tip") }

  -- helmod 的那一页。下拉表读自 helmod 自己的 `get_models()`，所以列表里有一项，压线就铺得出一条；
  -- 没有计划时这一格说清是"没装 helmod"还是"装了但还没算"，而不是摆一个只有一行空选项的下拉。
  --
  -- 它有自己的函数，因为自动刷新要在不碰答案区的前提下重画这一行：一按就重建整个窗口会把玩家刚读到的
  -- 那段话擦掉，而"刷新"这件事在这条链上唯一的含义是"helmod 又算了一遍"。
  local hrow = frame.add { type = "flow", direction = "horizontal", name = "arch-helmod-row" }
  G.helmod_row(hrow, model)

  -- 答案在按钮之外：任何一按之后都要读的那段话，不该藏在按下它的那个区里。
  local out = frame.add { type = "frame", direction = "vertical", name = "arch-sec-answer",
    style = "deep_frame_in_shallow_frame" }
  out.add { type = "label", caption = L("sec-answer"), tooltip = L("sec-answer-tip") }
  -- 蓝图串要能复制：一串 base64 贴在聊天里是选不中的，而它的用途正是粘到别处或发给别人。所以是个
  -- 文本框，并且一进来就全选上 —— 一次 Ctrl+C 就是整个交互。
  local srow = out.add { type = "flow", direction = "horizontal", name = "arch-string-row" }
  srow.add { type = "label", name = "arch-string-label", caption = L("blueprint-label") }
  srow.add { type = "textfield", name = "arch-string-out", text = "" }

  out.add { type = "flow", direction = "vertical", name = REPORT }
  return frame
end

-- Which verb this answer belongs to, said in the window's words. The English column is deliberately the
-- same string the method and the JSON use -- `plan`, `scan`, `save` -- so a suite that reads the header
-- back is still matching the verb it clicked, and only the player sees 算一下.
local VERB_WORDS = {
  helmod = L("verb-helmod"),
  helmod_all = L("verb-helmod-all"),
  undo = L("verb-undo"),
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

  if    cmd == "helmod_all" then
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
      -- 整计划那按也要说同一件事：每页那一行下面挂一行"这一页的数是装着哪些模块算的、铺了几个"。
      -- 只出散件的页没有生产线，逐条线那一行不会出现，这里就是唯一说这句话的地方。
      if b.modules_said then
        add(L("n-hm-modules-page", b.modules_said, b.modules_count or 0, b.modules_laid or 0))
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
    -- 牌上的字：这两个数是"这一页铺了几块面板"与"引擎那一侧还带着字的有几块"。它排在件数之后，
    -- 因为玩家按完这一按最先问的是"地上多了什么"，第二件就是"那两块牌要不要我自己打字"—— 以前答案是
    -- 不用问也没人知道（地铺出来了、字没下去），现在它自己报数。
    if (d.signs or {}).asked then
      add(L("n-hm-signs", (d.signs or {}).carried or 0, d.signs.asked))
    end
    -- 连线只有蓝图那一路带得住（地那一路的虚影连不了线：2.0 没有脚本连线的方法），所以这一行只在
    -- 这一页走了蓝图时出现，说的还是"回读出来几条"，不是"我们写了几条"。
    if (d.wires or {}).asked then
      add(L("n-hm-wires", (d.wires or {}).carried or 0, d.wires.asked))
    end
    -- 控制带那一圈（每台机器一只选择器 + 发射器/算术盒）：这一行说的是"几件配置写下去了、引擎那一侧
    -- 还带着配置的有几件"，而蓝图那一路还要多念一句机器那一格没跟过来（`circuits.recipe_control`）。
    -- 数的都是引擎的答复，不是铺的人自报 —— 一句"配好了"而地上一件都没配置，正是这类答案被指过的错。
    if (d.circuits or {}).asked then
      add(L("n-hm-circuits", (d.circuits or {}).carried or (d.circuits or {}).written or 0,
        d.circuits.asked))
      if (d.circuits.recipe_control or {}).asked then
        add(L("n-hm-circuits-rc", d.circuits.recipe_control.asked,
          d.circuits.recipe_control.carried or 0))
      end
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
      -- 阶梯换过形（裸带线头先试的那档铺不出来、或点名的形状喂不齐料）就把"要的是哪个、落的是哪个、
      -- 为什么"写成一行：悄悄换形是玩家最没法复查的那类改动，而这一行就是让他复查的。
      if l.style_overridden then
        local mo = l.style_overridden
        add(L("n-hm-shape-moved", tostring(mo.asked or "?"), tostring(mo.used or "?"),
          tostring(mo.because or mo.code or "?")))
      end
      -- 这一行铺的机器不是那一页点名的那台时，说清"点的是谁、铺的是谁、为什么"。压线走的是偏好那一条
      -- （玩家要的是"这一页铺出来"，所以允许换），但产量是按点名的那台折出来的，换了就必须让他看见 ——
      -- 换了机器等于每分工艺术数、口在哪一面、要几档臂全跟着换（#35 的 B2 说的就是这件事）。
      if l.asked_machine and l.machine and l.asked_machine ~= l.machine then
        add(L("n-hm-machine-moved", NM(l.asked_machine, "entity"), NM(l.machine, "entity")))
      end
      if l.fed_items and #l.fed_items > 1 then
        -- Which materials the ONE line this lane laid carries. Said because the compactness is the point
        -- the player traded for: two materials sharing a belt is only a fact if both of them arrive, and
        -- the row above is where the answer commits to that rather than to the drawing.
        add(L("n-hm-fed", NM(l.fed_items[1], "item"), NM(l.fed_items[2], "item")))
      end
      -- 两头那两块牌各自写的是什么。玩家要的就是"站在头看一眼知道吃什么、站在尾看一眼知道吐什么"，
      -- 所以窗口这里把两块牌的读数分开交出来 —— 少了尾那一行，铺没铺上都看不出来。
      if l.head_manifest then add(L("n-hm-sign-head", l.head_manifest)) end
      if l.tail_manifest then add(L("n-hm-sign-tail", l.tail_manifest)) end
      if l.split then
        -- The row is longer than its belt. Counting machines on a plan that arrived as two lines is how a
        -- player ends up believing half of it went missing, so the split is a row of its own: what one
        -- line can feed, how many lines the plan row became, and which of them this one is.
        add(L("n-hm-split", l.split.per_line or 0, l.split.lines or 1, l.split.of or 1))
      end
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
      -- 这条线的流量与台数是**装着这些模块**算出来的，而地上铺的是虚影 —— 虚影身上装不了模块（实测：
      -- `get_inventory(crafter_modules)` 是 nil，2.0 没有 `set_module_info`）。所以这一行说的不是"顺手少装
      -- 几样"，而是"这一行还欠哪几样、各几个，建成真机器后要谁来装"。那份名单由 Lua 一侧拼好
      -- （`modules_said`），不在这里 `string.format` 局部化名 —— 那玩意是张表，格式化出来是 "table"。
      if l.modules_said then
        add(L("n-hm-modules", l.modules_said, l.machines or 0))
      end
      -- 两个口径并列（#35 ③）：helmod 那一句"要几条带子"（式子出来的分数 + 向上贴到半条的那个数），
      -- 与这一条线实际铺了几行成品带（几何律：股数 ÷ 每行能装几股）。玩家要的"1.1 条先按 1.5"就是第一
      -- 个数；第二个数是他地上会看到的行数。两者不一致时要能当场看见差在哪，而不是只能拆蓝图去反推。
      local bn = l.belt_need_helmod
      if bn and bn.product_belts ~= nil then
        -- 那一档是谁定的，写成两条键而不是一条带参数的：把局部化串当参数塞进去，在窗口里没问题，
        -- 在门禁那种"把参数原样拼出来"的读法里就是一张表（这一文件为 `NM` 踩过一次）。
        local raw = { string.format("%.2f", tonumber(bn.product_raw) or 0),
          bn.product_belts, bn.product_belts * 2, tostring(bn.belt or "?"),
          l.product_rows or 0, bn.bonus or 0 }
        if l.belt_chosen_by == "caller" then
          add(L("n-hm-belt-need-named", raw[1], raw[2], raw[3], raw[4], raw[5], raw[6]))
        else
          add(L("n-hm-belt-need-auto", raw[1], raw[2], raw[3], raw[4], raw[5], raw[6]))
        end
        -- 上面那句说"铺了 0 行成品带"的那些发，成品并不是没铺 —— 它走进料行离机器远的那一股里
        -- （0.85.0 的共用行）。少了这一行，玩家看到"要 2 条 → 铺 0 行"会以为线在漏东西。
        if (l.product_lanes_shared or 0) > 0 then
          add(L("n-hm-belt-shared", l.product_lanes_shared))
        end
      end
      -- 分子退回自算的理由只有一个能在这里出现：地上这台机器不是 helmod 那一行点名的那台。两个数都给出
      -- （helmod 那份原数与按地上这台算出来的那份），因为"到不到那个数"是玩家下一步要问的问题。
      local rs = l.rate_source or {}
      if rs.reason == "machine_swapped" then
        local aside = rs.helmod_aside or {}
        add(L("n-hm-rate-self", NM(aside.helmod_machine or "?", "entity"),
          NM(l.machine or rs.laid_machine or aside.laid_machine or "?", "entity"),
          string.format("%.0f", tonumber(aside.crafts_per_min) or 0),
          string.format("%.0f", tonumber(rs.crafts_per_min) or 0)))
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
    -- 整页欠的模块。逐条线那一行给的是那一条线的；挑一条线时页合计被清空，这一行就不出现。只铺散件
    -- （没成长度线）时，这是唯一说"这一页的台数与每分钟件数是装着模块算出来的"那句话的地方。
    if d.modules_said then
      add(L("n-hm-modules-page", d.modules_said, d.modules_count or 0, d.modules_laid or 0))
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
  elseif cmd == "modules" then
    -- 「把模块装上」的结果。三种"没装上"必须分开写：拿不到（去补货）、机器不收（上限/槽位）、
    -- 还没建成真机器（虚影）。混成一个"欠 N 个"就是让他自己去猜该补哪一头，而那三头的补法相反。
    add(L("n-modules", d.machines or 0, d.with_module_slots or 0, d.installed or 0,
      d.missing or 0, d.ghosts or 0))
    if d.area_from then add(L("n-modules-area", tostring(d.area_from), tostring(d.surface or "?"))) end
    if d.sources and #list_of(d.sources) > 0 then
      add(L("n-modules-from", table.concat(list_of(d.sources), ", ")))
    end
    for _, r in ipairs(list_of(d.by_machine)) do
      local put, short, refused = {}, {}, {}
      for _, e in ipairs(list_of(r.put)) do put[#put + 1] = string.format("%s×%d", NM(e.item, "item"), e.count) end
      for _, e in ipairs(list_of(r.missing)) do
        short[#short + 1] = string.format("%s×%d", NM(e.item, "item"), e.count)
        if e.refused then refused[#refused + 1] = string.format("%s×%d", NM(e.item, "item"), e.refused) end
      end
      if #put > 0 then
        add(L("n-modules-one", tostring(r.unit_number or "?"), NM(r.name or "?", "entity"),
          table.concat(put, " ")))
      end
      if #short > 0 then
        add(L("n-modules-short", tostring(r.unit_number or "?"),
          refused[1] and table.concat(refused, " ") or "", table.concat(short, " ")))
      end
      if r.unplanned then
        add(L("n-modules-unplanned", tostring(r.unit_number or "?"),
          NM(r.name or "?", "entity"), tostring(r.unplanned)))
      end
    end
    if d.ghosts and (d.ghosts or 0) > 0 then add(L("n-modules-note", d.note or "")) end
  elseif cmd == "listen" then
    -- 「让这批机器听线」的结果。数的是写下去**并读回来**的那些：开了几台、本来就开着的几台、
    -- 没写成的几台，再加上这片地里还虚影着的台数（虚影身上这一格跟不跟过去量不到，所以要等他建）。
    add(L("n-listen", d.machines or 0, d.set or 0, d.already or 0, d.failed or 0, d.ghosts or 0))
    if d.area_from then add(L("n-listen-area", tostring(d.area_from), tostring(d.surface or "?"))) end
    for _, r in ipairs(list_of(d.by_machine)) do
      if r.failed or r.why then
        add(L("n-listen-bad", tostring(r.unit_number or "?"), NM(r.name or "?", "entity"),
          tostring(r.why or "?")))
      end
    end
    for _, u in ipairs(list_of(d.not_settable)) do
      -- 收这一格的只有能设配方的机器；熔炉/臂/带子/组合器没有这一格，数出来而不是并入失败里去。
      add(L("n-listen-no-slot", NM(u.name or "?", "entity"), u.count or 0))
    end
    if d.note then add(L("n-listen-note", tostring(d.note))) end
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
-- way in, and the fallback above is the two shapes that are left -- a fallback naming a deleted shape
-- would be offered as a real row and refused the moment a player picked it.
-- 把窗口读回成压线的那几个参数。窗口是每次重建的，所以玩家留在下拉里的选择存在存档的那份状态里
-- (`remember_form`)，这里负责把它读回来 —— 读的是"第几行"，不是那一行写的字：菜单标签可以被翻译、
-- 可以被改名，行号不会因此把一条线搬到另一个形状上。
-- 线头那一行的值：第 1 行是不表态（nil），其它行照 `HEAD_VALUES` 那一列发。写成一个函数而不是
-- `x and nil or y`（那种写法在这里永远取到右边，lint 会当场抓到）。
local function head_value(row)
  local v = HEAD_VALUES[row or 1]
  if v == nil or v == "" then return nil end
  return v
end

local function read_form(player, model)
  local screen = player and player.gui and player.gui.screen
  local root = screen and screen[ROOT]
  local function idx(name)
    local el = root and G.find(root, name)
    return el and el.selected_index or nil
  end
  -- 压的是哪一页：行号说的是"此刻列表的第几行"，而这份列表是 helmod 现场算的（自动刷新一秒一读）。
  -- 他改下拉那一刻记下的 id（`on_gui_selection_state_changed` → `goal.helmod_factory`）才是他的意见，
  -- 两者不一致时信 id；除非那一页已经不在这份列表里了 —— 那时窗口正显示"全部一起"（重建时它落回
  -- 第 1 行），跟着窗口走比追一个已经不存在的页诚实。
  local page_row = idx("arch-form-helmod") or 1
  local pages = ((model or {}).helmod or {}).factories or {}
  local by_id = {}
  for _, f in ipairs(pages) do by_id[tostring(f.id)] = f.name or tostring(f.id) end
  local page_by_row = pages[page_row - 1]
  page_by_row = page_by_row and tostring(page_by_row.id) or ""
  local page_kept = tostring(((model or {}).goal or {}).helmod_factory or "")
  local pressed_for, page_drift = page_by_row, nil
  if page_kept ~= "" and page_kept ~= page_by_row and by_id[page_kept] then
    pressed_for = page_kept
    page_drift = { row = page_row, row_means = page_by_row, pressed_for = page_kept,
      pressed_for_name = by_id[page_kept], row_means_name = by_id[page_by_row] or "(整页)" }
  end
  return {
    -- 第 1 行 = 空串 = "不表态"，于是形状交给阶梯按机器数与料种数给；其它行是对两条路都算的一道令。
    style = ((model or {}).styles or STYLE_FALLBACK)[(idx("arch-form-style") or 1) - 1],
    style_index = idx("arch-form-style"),
    -- 读的是"第几行"，值取自 `HEAD_VALUES` —— 和窗口建下拉时用的是同一列，所以标签与值不会各走一半。
    -- 第一行（不表态）读出来是 nil，交给阶梯按机器数与料种数挑。
    heads = head_value(idx("arch-form-heads")),
    heads_index = idx("arch-form-heads"),
    -- 带子：第 1 行是"不表态"，交给 `card_example` 按"够用就好"从最慢那档往上试；其它行是玩家点名的
    -- 那一档，点名就不升级也不降级。读回的是原型名，不是标签。
    belt = ((model or {}).belts or {})[(idx("arch-form-belt") or 1) - 1],
    belt_index = idx("arch-form-belt"),
    -- 压的是哪一页（或页里的哪一条线）：读回的是 helmod 自己给的 id，不是标签。
    -- 压的是哪一页（或页里的哪一条线）：读回的是 helmod 自己给的 id，不是标签。
    helmod_factory = pressed_for,
    helmod_factory_index = page_row,
    helmod_page_drift = page_drift,
  }
end

-- Every button this dispatcher answers for, named in the file that owns the answering. The self-test
-- snapshots the report area after each of these clicks, and until now it kept its own copy of this list
-- in control.lua -- which is how `arch-undo` and `arch-boxhere` were added to the window, dispatched
-- correctly, and never once checked for the answer they left in it: a list maintained two files away from
-- the thing it describes rots exactly that quietly.
G.COMMAND_BUTTONS = { "arch-helmod", "arch-helmod-all", "arch-modules", "arch-listen", "arch-undo" }

-- Button names carry their argument because Factorio hands the click handler an element, not
-- a closure: "arch-helmod:<factory id>" is the whole context. The verbs are the ones this window is
-- for -- pick a helmod factory, press it over a whole page, take the last press back -- and the point of
-- listing them here is that the window is not a second implementation: every one of them is the same
-- method a script calls over RCON, answered here for whoever is standing in the factory.
function G.on_click(player, element_name, model, api)
  if not element_name then return nil end
  if element_name == "arch-close" then G.close(player); return "closed" end
  -- 右上角那颗按钮是"开或关"，不是"重建"：窗口已经开着再按一次，玩家要的是它消失。
  if element_name == "arch-toolbar" then
    local opened = G.toggle(player, model)
    return "toolbar", opened
  end
  if element_name == "arch-refresh" then G.open(player, model); return "refreshed" end
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
    if form.helmod_page_drift then
      -- 手指没动、列表动了：这一句必须说出口。不说，玩家看到的就是一次"我明明选的是那一页"的铺法，
      -- 而没有任何地方承认过窗口替他换过页。
      local d = form.helmod_page_drift
      pcall(function()
        player.print(L("chat-page-drift", tostring(d.row), tostring(d.row_means_name),
          tostring(d.pressed_for_name)))
      end)
    end
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
  if element_name == "arch-modules" then
    local res = api.modules(read_form(player, model))
    local out = G.report_lines("modules", "", res)
    G.show_report(player, out.title, out.lines)
    if res and res.ok then
      local d = res.data or {}
      player.print(L("chat-modules", tostring(d.installed or 0), tostring(d.missing or 0),
        tostring(d.ghosts or 0)))
    end
    return "modules", res
  end
  if element_name == "arch-listen" then
    local res = api.listen(read_form(player, model))
    local out = G.report_lines("listen", "", res)
    G.show_report(player, out.title, out.lines)
    if res and res.ok then
      local d = res.data or {}
      player.print(L("chat-listen", tostring(d.set or 0), tostring(d.already or 0),
        tostring(d.ghosts or 0)))
    end
    return "listen", res
  end
  if element_name == "arch-undo" then
    -- The number is read off the window rather than remembered in the model: it is a one-shot instruction
    -- ("take back the last three"), not a setting the next press should inherit.
    local f = player.gui and player.gui.screen and player.gui.screen[ROOT]
    local row = f and G.find(f, "arch-form-row")
    local field = row and row["arch-undo-n"]
    local res = api.undo(tonumber(field and field.text) or 1)
    local out = G.report_lines("undo", "", res)
    G.show_report(player, out.title, out.lines)
    return "undo", res
  end
  return nil
end

-- 复选框走的是另一个事件（`on_gui_checked_state_changed`），所以它有自己的入口。这里只说"这一格现在是
-- 什么"，不碰 storage —— 那份状态归 control 管，窗口重建时它读回来，两边才不会各记一份。
function G.on_checked(player, element_name, state)
  if element_name ~= "arch-auto-refresh" then return nil end
  return "auto_refresh", state and true or false
end

-- 下拉换了一行 → 把那一行背后的 id 交出去（control 那边存进 per-player 的那份状态）。
-- 为什么要在**改的那一刻**记，而不是等按下"压线"才读 `selected_index`：行号说的是"当前列表的第几行"，
-- 而这份列表是 helmod 现场算的、自动刷新开着时一秒重读一次。他在第 3 行停了手，其间 helmod 少了一页，
-- A 就从第 3 行挪到第 2 行 —— 那时才去读行号，铺出去的是别人那一页，而窗口上他从头到尾没动过手。
-- 第 1 行（"全部一起"）背后是空串，跟"不表态"是同一个意思。
function G.on_selection(player, element_name, index, model)
  if element_name ~= "arch-form-helmod" then return nil end
  local ids = helmod_rows(model)
  return "helmod_page", tostring(ids[tonumber(index) or 1] or "")
end

return G