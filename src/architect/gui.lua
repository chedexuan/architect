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
    elseif type(p) == "table" and type(rawget(p, "proto")) == "string" then
      -- 句子里那个原型名交给引擎自己翻译：数据层递 `{proto=名, kind=哪一组}`（`host.proto_word`）。
      -- 欠的就是这一格 —— 句子本身本地化了，句中那台机器还是 `assembling-machine-3`，
      -- 中文窗口里混一串英文 id。替身里 `prototypes` 是空的，`NM` 回原名字符串，所以门禁那一路
      -- 读到的仍然是 id（它们引的就是 id），他看到的才是中文机器名。
      out[i] = G.NM(p.proto, p.kind)
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
  for i, l in ipairs(arr or {}) do
    -- 答案区收起的那几句是 `{ tech = true, line = ... }`（不是本地化串表），展平时要先拆这一层壳：
    -- 直接丢给 `flat` 会把一个带键的表当成一串拼接元素，读回来是一句空话 —— 门禁看到"空"和看到"没有这一行"
    -- 长得一模一样，那正是这一串改动被指过很多次的形状。
    out[i] = flat(type(l) == "table" and (rawget(l, "tech") and l.line or l) or l)
  end
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

-- The list a build with no styles layer would show: the two shapes that are left, in the order the
-- ladder walks them. `model.styles` normally carries the registry's own ids, and a panel that hardcoded
-- them would be a second list free to fall behind the file it is supposed to describe -- which is
-- exactly what the one name this list used to hold (`row-chest`) became: a deleted shape, offered as a
-- real row, refused the moment a player picked it.
local STYLE_FALLBACK = { "stacked", "two-row" }
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
  -- 一条**吐液体**的线：机器两面各有一行是管子（一面进、一面出），固体臂站到管子外面那一行。
  ["fluid-through"] = L("style-fluid-through"),
}

-- 类别词：每档排法**给哪几类线用**，印在标签最前面。这是第 1 条里"看得懂"那一半 —— 光把用不了的档从
-- 列表里摘掉不够，留在那一行的字要说清这一行是给谁的（他铺的是自己的工厂，术语得说人话）。
-- 键名写全，不用前缀拼出来：拼出来的键静态检查证不了它存在。
-- 每一档那句"铺出来长什么样"：与 `styles.<id>.about` 同一句话的两个说法都收在这儿，
-- 因为下拉里那一行只放得下短词。加一档形状而没在这里加一句 ⟹ 它会静默地没有 tooltip
-- （`locale_check` 的"这个键没人用了"那条红就是留给这一刻的）。
local STYLE_TIPS = {
  ["stacked"] = L("style-stacked-tip"),
  ["two-row"] = L("style-two-row-tip"),
  ["fluid-back"] = L("style-fluid-back-tip"),
  ["fluid-through"] = L("style-fluid-through-tip"),
}
local STYLE_CLASS_WORDS = {
  solid = L("style-class-solid"),
  mixed = L("style-class-mixed"),
  liquid = L("style-class-liquid"),
}

-- 下拉那一行配的 tooltip。**建窗口与玩家改下拉都点这一个函数**：从前只有建窗口那一刻算一次，而
-- 这一带没有任何一处监听下拉的变化 —— 换了排法之后 tooltip 还停在上一档，而它存在的理由恰恰是
-- "选中那一档铺出来长什么样"（2026-10-14 审出来的）。行号在这里是**包含第一行"不表态"**的那张表：
-- 与 `items` 同长同序，两处不再各数一遍。
local function style_ids_of(model)
  local out = { "" }
  for _, id in ipairs((model or {}).styles or STYLE_FALLBACK) do out[#out + 1] = id end
  return out
end

function G.style_tip(model, sel)
  local one = style_ids_of(model)[tonumber(sel) or 1] or ""
  return STYLE_TIPS[one] or L("style-auto-tip")
end

local function style_labels(ids, classes, units)
  local out = {}
  for _, id in ipairs(ids or STYLE_FALLBACK) do
    local word = STYLE_WORDS[id] or tostring(id)
    local cs = (classes or {})[id]
    local tags = {}
    for _, c in ipairs(cs or {}) do
      if STYLE_CLASS_WORDS[c] then tags[#tags + 1] = STYLE_CLASS_WORDS[c] end
    end
    -- 一行两段：类别（这档给谁用）｜那一档铺出来长什么样（`style-*` 那四句写的就是这个），
    -- 需要多台才成立的档再跟一句「≥2 台起」。他那句"排法选择有点乱 看不懂"要的是**选之前**看得见，
    -- 而不是确认完吃一句 `STYLE_NEEDS_UNITS`。
    -- ⚠ 拼法只能用 locale 那一套**嵌套字典**（首项空串 = 把后面所有参数首尾相接）：`L` 交回的是
    -- `{"architect.style-class-solid"}` 这样的表，不是字符串。0.93.0 第一版在这里用了
    -- `table.concat` / `..`，于是**整扇窗建不起来**（`gui.lua:330: invalid value (table)`），
    -- 玩家那边只是"点一下没反应"。抓到它的是 `smoke` 里的 `gui_selftest`，不是玩家。
    local n = tonumber((units or {})[id]) or 1
    if #tags == 0 and n <= 1 then
      out[#out + 1] = word
    else
      local parts = { "" }
      for i, tag in ipairs(tags) do
        parts[#parts + 1] = tag
        if i < #tags then parts[#parts + 1] = "/" end
      end
      if #tags > 0 then parts[#parts + 1] = "｜" end
      parts[#parts + 1] = word
      if n > 1 then parts[#parts + 1] = L("style-min-units", tostring(n)) end
      out[#out + 1] = parts
    end
  end
  return out
end
-- 一个下拉的值读成后端听得懂的样子：空串读成 nil（"这一格不表态"），默认由后端定。
local function word_of(v)
  if v == nil or v == "" then return nil end
  return v
end

-- 下拉的行号 → 值。**行号与值表必须一样长**：下拉里第 i 行就是 `vals[i]`，一处多一行就整列错位。
-- 这一条是 2026-10-14 审出来的：从前这里统一减一（那一年值表头部多留着一行"不表态"而下拉里没有），
-- 于是玩家点"第二行"、后端收到的是第一行的值，而窗口上亮的还是他点那一行 —— 一声不响。
local function word_value(vals, index)
  return word_of(vals and vals[tonumber(index) or 1])
end

-- 带子那一格背后那份原型名名单（第一行是"不表态"）。建窗口与按下去读回来**都点这一个函数**，
-- 否则两处各数一遍，改一处就不同意另一件。
local function belt_ids_of(model)
  local out = { "" }
  for _, name in ipairs((model or {}).belts or {}) do out[#out + 1] = tostring(name) end
  return out
end

-- 下拉的每一行**背后是什么原型名**，在建那一格的那一刻钉在控件自己身上（`tags.arch_ids`）。
-- 为什么不能按下时再拿行号去数 `model.styles` / `model.belts`：那份名单是每次重建按"这个势力现在
-- 用得上哪几档"重算的，窗口开着的时候研究开了一档，名单就少一行或多一行，行号于是指到别的档上 ——
-- 玩家点着"双排"、压下去的是"单排"，而屏幕上亮的还是他点的那一行（2026-10-14 审出来的第 13 条）。
-- 名字里不含逗号（形状 id 与原型名都不含），所以一份名单串成一条字符串存进 tags 就够。
local SEP = ","

-- 按分隔符逐格切，**保留空格子**（每个下拉的第一行都是"不表态"= 空串，用 `gmatch("[^,]+)")`
-- 那类写法会把它整格吞掉，行号于是集体前移一位 —— 而我依赖的正是"名单第 i 项 = 下拉第 i 行"这件事。
local function split_keep(s, sep)
  local out, at = {}, 1
  while true do
    local n = s:find(sep, at, true)
    if not n then out[#out + 1] = s:sub(at) break end
    out[#out + 1] = s:sub(at, n - 1)
    at = n + 1
  end
  return out
end

local function pin_ids(el, ids)
  if not el then return end
  local parts = {}
  for _, one in ipairs(ids or {}) do parts[#parts + 1] = tostring(one or "") end
  pcall(function() el.tags = { arch_ids = table.concat(parts, SEP) } end)
end

local function pinned_ids(el, fallback)
  local kept = nil
  if el then pcall(function()
    local tg = el.tags
    kept = type(tg) == "table" and tg.arch_ids or nil
  end) end
  if type(kept) ~= "string" then return fallback end
  return split_keep(kept, SEP)
end

-- 面板要看的那份数据。只剩四样：名字与版本、玩家留在两个下拉里的偏好、形状清单、helmod 现在有哪几页。
-- 从前这里还带冻住的卡片列表、拖出来的方框、七份零件菜单（物品/机器/模组/带/臂/箱/杆）和上一份计划的
-- 表格 —— 那些行渲染的是已经不在这个窗口里的按钮，图标还得先在 data 阶段注册成 sprite 才能画。
-- 窗口自己的状态（在哪一页、最小化没有、要不要看详细输出）。都存在玩家那一份记录里：
-- 窗口不记自己的意见，它记玩家上一次留下的样子 —— 刷新一次就跳回默认，等于每秒替玩家重开一遍。
local LAYOUTS = { normal = true, mini = true, max = true }

-- "自动刷新这一格到底开没开"只在这一个地方判。窗口画它、计时器跑它，两边必须读同一句 ——
-- 2026-10-13 就是分两处写各写各的：窗口按 `~= false`（没表过态 = 开着）画成亮着，而 `on_nth_tick`
-- 读的是真值（nil = 关），玩家看见"自动刷新"勾着、列表却一动不动。
function G.auto_refresh_on(panel)
  return (panel or {}).auto_refresh ~= false
end

function G.model(version, panel)
  local goal = (panel or {}).goal or {}
  -- 线头不再是玩家的一格意见（2026-10-12：窗口上那颗下拉去掉，全部走裸带）。
  -- 这里把它按 belt 交出去，是为了让后端只有一条路：`heads` 为 nil 时后端要自己判，
  -- 而"判出来是 belt"和"窗口显示的是 belt"必须是同一件事，否则窗口说的话和地上铺的会各走一半。
  if goal.heads == nil then goal.heads = "belt" end
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
    -- 自动刷新**默认开着**（他要"无感刷新"）：只有玩家亲手关掉那一格才停。
    -- 老存档里这一格从没被点过 = nil，那是"没表过态"，不是"关着" —— 所以读法在 `auto_refresh_on` 那一句里。
    auto_refresh = G.auto_refresh_on(panel),
    layout = LAYOUTS[(panel or {}).layout] and (panel or {}).layout or "normal",
    detail = (panel or {}).detail and true or false,
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
      -- 一行字要说清这条线**多大**：从前只有台数，挑线的人看不出 8 台和 8 台差在哪（有的每分钟 450 件、
      -- 有的 4500 件）。数来自 helmod 自己折过的那一份（`per_min` 是成品件数/分，`fluid_per_min` 是液体
      -- 成品/分），问不到就不写这一截 —— 一行没有数的下拉比一行编了 0 的下拉诚实。
      local rate = ""
      local ip, fp = tonumber(f.per_min), tonumber(f.fluid_per_min)
      if ip and ip > 0 then rate = string.format("%.0f/min", ip) end
      if fp and fp > 0 then rate = rate .. (rate ~= "" and " + " or "") .. string.format("%.0f/min", fp) end
      items[#items + 1] = L("helmod-line-word", NM(f.name or "?", "recipe"),
        tostring(tonumber(f.machines) or 0), NM(f.machine or "?", "entity"),
        rate ~= "" and rate or L("helmod-line-no-rate"))
    else
      -- 页那一格：显示用的台数与 helmod 深算的台数并着写（两个数不一样时才加那一截）——
      -- "页上 49 台、铺出来 48 台"这种事要有个数能对，不能只靠玩家眼神。
      local shown = tostring(tonumber(f.machines) or 0) .. " / " .. tostring(tonumber(f.recipes) or 0)
      local dp = tonumber(f.machines_deep)
      if dp and dp ~= tonumber(f.machines) then shown = shown .. " · " .. L("helmod-page-deep", tostring(dp)) end
      items[#items + 1] = string.format("%s · %s", tostring(f.name or f.id), shown)
    end
  end
  return ids, items, hm
end

-- 把 `row` 清空，再按 model 摆回这一行的四件东西：标签、那一页的下拉、压线/整页/撤回三颗按钮。
--
-- `selected_id` 是重建前从旧下拉里读到的那一页的 id。没有它时退回玩家上一次按下记住的那一页。
-- 工厂列表那一格：固定宽高的**滑动列表**，一行一条，**按图标显示而不是文字**，行尾跟着这一行的动作按钮。
-- 这是他 2026-10-12 要的形状（"所有工厂改成滑动列表、全部按图标显示、每条后面跟随选项和拿到手里蓝图
-- 等按钮、面板宽和高固定"）。原来的形状是"一行下拉 + 一排全局按钮"：选页在一处、压线在另一处，
-- 手机上点两遍还要认文字。
--
-- 三件事按这台机器量出来的写法办（不是照记忆）：
--   * 元素名是 `scroll-pane`（**连字符**）。`scroll_pane` 引擎直接回 "Unknown gui element type"。
--   * 定尺寸靠 style 表里的 `minimal_width`/`maximal_width`/`minimal_height`/`maximal_height` ——
--     这一格的 style 在 2.0.77 上就是 LuaStyle 那张表（实测写得进、读得回），本 mod 没有 data 阶段的
--     自定义样式可用。
--   * 图标走 data.lua 注册过的 `arch-icon-<kind>-<原型名>` 精灵（`host.icon_sprite` 画之前先验一次），
--     而不是 `choose-elem-button` —— 后者是可点的，会把"这一行的图标"变成"一按就弹选择器"。
-- 每秒一次的自动刷新**不会**重画这一格：`refresh_world` 早就只在签名变了才重建这一行（见
-- `G.helmod_signature`），而签名没变时列表原地不动 —— 这就是"滚动位置不会被顶回顶部"那一条的落点。
-- 图标：先问引擎的图库（`item/x`、`entity/x`、`fluid/x`、`recipe/x`、`technology/x`），
-- 库里没有再退回本 mod 抄出来的那份 `arch-icon-*`，两样都没有就写名字 —— 一行安静的空白是他
-- 反复指过的那种"窗口在装死"。尺寸一律钉成 28×28 并 `stretch_image_to_widget_size = true`：
-- 他 2026-10-13 报的"图标被放大了、只看到一角"就是没让图缩放、又被小格子裁开。
local HF_ICON_PX = 28

-- 提示语：`NM` 交回的是**游戏自己那份翻译**，而它是一张本地化串表（`{"item-name.iron-plate"}`），
-- 不是字符串 —— 拿 `..` 拼它一次，整扇窗就建不起来（`G.open` 把那声抛错压成了聊天里一行英文，
-- 玩家看到的就是"点了按钮什么窗都没有"）。所以要接文字就接成一张嵌套的本地化串表，让客户端去展平。
-- 这一条是 2026-10-14 从代码里审出来的，替身看不出来（替身里 `prototypes` 是空表，`NM` 回的是原名
-- 字符串，拼得动），只有他那样装了真原型的档才会炸 —— 所以自测现在直接点这个名字（见 `gui_selftest`
-- 的 `tip_is_localisable`），不再靠"建一次窗"碰运气。
local function tip_words(name, kind, extra)
  local base = NM(name, kind)
  if not extra or extra == "" then return base end
  if type(base) == "table" then return { "", base, " " .. tostring(extra) } end
  return tostring(base) .. " " .. tostring(extra)
end
G.tip_words = tip_words

local function hf_icon(parent, icon, extra)
  local kind = icon and icon.kind
  local name = icon and icon.name
  if not name or name == "" then return false end
  local path = host.library_sprite(kind, name) or host.icon_sprite(kind, name)
  local tip = tip_words(name, kind, extra)
  if not path then
    parent.add { type = "label", caption = NM(name, kind), tooltip = tip }
    return true
  end
  local ic = parent.add { type = "sprite", sprite = path, tooltip = tip }
  pcall(function()
    ic.style.minimal_width = HF_ICON_PX
    ic.style.maximal_width = HF_ICON_PX
    ic.style.minimal_height = HF_ICON_PX
    ic.style.maximal_height = HF_ICON_PX
    -- 这一格才是"别裁我"：图按控件的尺寸缩放，而不是控件按图的原始尺寸长大（2.0 的图库里产物图标
    -- 是 64px 的东西，钉在 28 的格子里不缩放就只剩一个角）。
    ic.style.stretch_image_to_widget_size = true
  end)
  return true
end

-- 表格的五列 + 最右那一颗「复制」。宽度只在这里说一次：表头与每一行用的是同一张表，
-- 所以"对齐"不靠调两处数字（这个项目最怕的就是同一件事有两份数字）。
-- 一行摆六列是量出来的**坏**：产物那格 86px 要放 3 个 32px 图标（96px），原料那格 104px 要放 4 个
-- （128px），格子装不下自己要画的东西，超出的一格被滚动面板横向裁掉 —— 他 2026-10-14 深夜看到的
-- "产物与原料两列空白、最右那颗复制没有字"就是这么来的。所以这里改成**每条线占两小行**，
-- 整扇面板跟着收窄成竖向（他第 2 条），宽度按 helmod 那三档格子（80/50/30）与本 mod 的图标 32px 凑。
local HF_ROW_W = 344   -- 图标那一格仍用上面 `HF_ICON_PX`（28），不另定一份                    -- 一小行的总宽
local HF_COLS = {                       -- 只有表头那一格用得到名字，宽度另按两行算
  { key = "recipe",     width = 176, label = "col-recipe" },
  { key = "factory",    width = 84,  label = "col-factory" },
  { key = "beacon",     width = 56,  label = "col-beacon" },
  { key = "product",    width = 132, label = "col-products" },
  { key = "ingredient", width = 132, label = "col-ingredients" },
  { key = "action",     width = 64,  label = "col-action" },
}
local HF_LIST_W = HF_ROW_W

local function hf_cell(parent, width)
  local c = parent.add { type = "flow", direction = "horizontal" }
  pcall(function()
    c.style.minimal_width = width
    c.style.maximal_width = width
    c.style.horizontally_stretchable = false
    c.style.vertical_align = "center"
  end)
  return c
end

-- 一格里放"图标 ×N"（工厂、插件塔、产物、原料四列都是这个形状）。N 是每次工艺几个 / 共几台，
-- 交进来的文案已经说明了它是哪一种，这里不另加口径。
local function hf_stack(cell, list, cap)
  local n = 0
  for _, e in ipairs(list or {}) do
    if n < cap then
      hf_icon(cell, e, e.count and ("x" .. tostring(e.count)) or nil)
      n = n + 1
    end
  end
  if #(list or {}) > n then
    cell.add { type = "label", caption = L("col-more", #(list or {}) - n) }
  end
  return n > 0
end

function G.helmod_row(row, model, selected_id)
  if not row then return false end
  -- 先摘一份快照再拆：`destroy()` 会把自己从父亲的 `children` 里摘掉，**一边遍历一边删会隔一个漏一个** ——
  -- 真引擎的 `children` 交回来的是副本所以看不出来，而替身给的就是那张活表，于是自测里旧的列表一直站着，
  -- 后来 `find("arch-hf-list")` 拿到的是那一块旧的（2026-10-13 在他的档上跑自测就是这么读出 10 行真数据、
  -- 而 `same_when_unchanged` 永远不可能是 same）。写成一行的代价是零，读出来的却是同一件事。
  local kids = {}
  for i, c in ipairs(row.children or {}) do kids[i] = c end
  for _, c in ipairs(kids) do c.destroy() end
  row.add { type = "label", caption = L("form-helmod") }
  local ids, items, hm = helmod_rows(model)
  local rows = (model.helmod or {}).factories or {}
  local chosen = selected_id or (model.goal or {}).helmod_factory or ""
  if #ids > 1 then
    local list = row.add { type = "scroll-pane", name = "arch-hf-list", direction = "vertical",
      tooltip = L("hf-list-tip") }
    list.style.minimal_width = HF_LIST_W
    list.style.maximal_width = HF_LIST_W
    list.style.minimal_height = 240
    list.style.maximal_height = 240
    list.vertical_scroll_policy = "always"
    list.horizontal_scroll_policy = "never"
    -- 把自己按哪一份结构建出来的记在这块控件上（自动刷新比的就是它，见 `G.helmod_shown`）。
    list.tags = { arch_key = G.helmod_signature(model) }
    -- 表头：他自己说"helmod 那一套表格样式的，有配方、工厂、插件塔、产物、原料，复制按钮放在右边"。
    -- 抄的是那五列的名字，不是我的分类词。
    -- 表头这六格**写死六个 L(...)**，不用 `L(c.label)`：`dev/locale_check.js` 读的是文件里出现的字面
    -- 键名，键名走变量的话它判"这个键没人用"，而真正的漏翻（少了一种语言）就永远看不见 ——
    -- 让一个会检查漏翻的门禁因为写法而失明，比多写五行贵。
    -- 表头也按这两小行给（他点名的五列名字一个不少，只是不再挤在同一横排里）。
    -- 六格写死六个 L(...)，不用 `L(c.label)`：`dev/locale_check.js` 读的是文件里出现的字面键名。
    local head = list.add { type = "flow", direction = "vertical", name = "arch-hf-head" }
    local h1 = head.add { type = "flow", direction = "horizontal" }
    hf_cell(h1, HF_COLS[1].width).add { type = "label", caption = L("col-recipe") }
    hf_cell(h1, HF_COLS[2].width).add { type = "label", caption = L("col-factory") }
    hf_cell(h1, HF_COLS[3].width).add { type = "label", caption = L("col-beacon") }
    local h2 = head.add { type = "flow", direction = "horizontal" }
    hf_cell(h2, HF_COLS[4].width).add { type = "label", caption = L("col-products") }
    hf_cell(h2, HF_COLS[5].width).add { type = "label", caption = L("col-ingredients") }
    hf_cell(h2, HF_COLS[6].width).add { type = "label", caption = L("col-action") }
    for i = 2, #ids do
      local f = rows[i - 1] or {}
      local id = ids[i]
      -- 一条线占两小行：竖着的一个盒子，里面第一横排是"做什么 / 几台 / 有没有信标"，
      -- 第二横排是"出什么料 / 进什么料 / 复制"。名字仍然按 `arch-hf-row-<n>` 交出去，
      -- 门禁与自测认的是名字，不是第几格。
      local box = list.add { type = "flow", direction = "vertical",
        name = "arch-hf-row-" .. tostring(i - 1), tooltip = items[i] }
      local a = box.add { type = "flow", direction = "horizontal" }
      -- 配方：这一行做什么（图标是配方自己的产物图，配方名给游戏自己的翻译）
      local cell = hf_cell(a, HF_COLS[1].width)
      if not hf_icon(cell, { kind = "recipe", name = f.recipe or f.name }) then
        cell.add { type = "label", caption = "?" }
      end
      cell.add { type = "label", caption = NM(f.recipe or f.name or "?", "recipe") }
      -- 工厂：哪台机器、几台
      cell = hf_cell(a, HF_COLS[2].width)
      hf_icon(cell, { kind = "entity", name = f.machine }, "x" .. tostring(f.machines or 0))
      cell.add { type = "label", caption = "x" .. tostring(f.machines or 0) }
      -- 插件塔：这一行有没有信标（没有就一个点，不留空白 —— 空白看起来像没读到）
      cell = hf_cell(a, HF_COLS[3].width)
      if (tonumber(f.beacons) or 0) > 0 then
        hf_icon(cell, { kind = "entity", name = "beacon" }, "x" .. tostring(f.beacons))
        cell.add { type = "label", caption = "x" .. tostring(f.beacons) }
      else
        cell.add { type = "label", caption = "·" }
      end
      local b = box.add { type = "flow", direction = "horizontal" }
      -- 产物 / 原料：读自配方原型（每次工艺几个），不是每分钟几件 —— 后者在下面的提示里
      cell = hf_cell(b, HF_COLS[4].width)
      if not hf_stack(cell, f.products, 4) then cell.add { type = "label", caption = "·" } end
      cell = hf_cell(b, HF_COLS[5].width)
      if not hf_stack(cell, f.ingredients, 4) then cell.add { type = "label", caption = "·" } end
      -- 复制（2026-10-13 他第 5 条 + 测完那一条）：整排全局按钮一颗不剩，这一颗就是全部入口。
      -- 页 id 带在名字里：Factorio 交给点击处理的是一个元素、不是闭包。
      cell = hf_cell(b, HF_COLS[6].width)
      cell.add { type = "button", name = "arch-hf-copy:" .. id, caption = L("hf-copy"),
        tooltip = L("hf-copy-tip") }
    end
  else
    -- 没有可列的页时这一格必须有一句话，而且要说清是哪一种"没有"：没装、装了没算、
    -- 还是算了但没有可铺的东西。从前这里只在 `hm.error` 时摆一句，于是空列表连一句都没有。
    local none_el = row.add { type = "label", name = "arch-helmod-none",
      caption = L("helmod-none", hm.msg_key and L(hm.msg_key) or L("report-idle")) }
    -- 这一格也把自己按哪一份结构建出来的记在 tags 上：签名现在带上"是哪一种没有"（`msg_key`），
    -- 而 `G.helmod_shown` 若还回那句写死的 "(none)"，两种"没有"之间就永远比不相等 ——
    -- 于是每一次刷新都把这一格重建一遍（他 10-13 报的"滚动位置每秒回顶"正是这一类）。
    if none_el then pcall(function() none_el.tags = { arch_key = G.helmod_signature(model) } end) end
  end
  return true
end

-- 这一行现在该显示什么：有页就把每一行标签串起来；一页都没有时它不是"一行下拉"，而是那句原因，
-- 所以签名也就是那句原因的位置（`(none)`）。两边写成同一套，没有计划的存档才不会每一秒都重画一次。
-- 这一格现在该不该重画，看的是**结构**而不是渲染出来的词：
-- 词是本地化串表（`L(...)` 每次造的都是一张新表），拿它的 tostring 当签名会把"表地址"当内容 ——
-- 下拉那一版侥幸没坏，是因为比对的是同一批已经塞进控件的表；换成列表之后两侧各算一次，
-- 每一秒都会"变了"，于是列表每秒被连根重建、滚动位置每秒回顶（smoke 那条 `same_when_unchanged`
-- 2026-10-13 就是这样抓到的）。签名改成 id/台数/条数/图标数这些稳定的数。
function G.helmod_signature(model)
  local hm = (model or {}).helmod or {}
  local rows = hm.factories or {}
  if #rows == 0 then
    -- 一页都没有的时候，签名要说清是**哪一种**没有：没装、装了没算、算了但这页没有可铺的东西。
    -- 只回一个 "(none)" 的话，helmod 从"没装"变成"装了没算"这一跳读不出来，那一格就停在旧句子上。
    return table.concat({ "(none)", tostring(hm.msg_key or ""), tostring(hm.error or "") }, "\3")
  end
  local out = {}
  for _, f in ipairs(rows) do
    -- 表格那五列都算进签名：换机器、多一只信标、产物/原料换了，玩家都该当场看到那一行变了。
    -- 名单比的是**原型 id 那一串纯文本**（`f.products[i].name`），不是渲染出来的词：词是本地化串表，
    -- 每次造的都是一张新表，拿它当签名会把"表地址"当内容 —— 那一版的结果是每秒都"变了"、列表每秒重建。
    -- 但只数"每类几个"也不对：铁板换成铜板、数量不变，那一行就该重画而签名没动（2026-10-14 审出来的）。
    local names = {}
    for _, key in ipairs({ "products", "ingredients" }) do
      for _, e in ipairs(f[key] or {}) do names[#names + 1] = tostring(e.name or "") end
    end
    out[#out + 1] = table.concat({ tostring(f.id), tostring(f.kind or "page"),
      tostring(f.machines or 0), tostring(f.recipes or 0), tostring(f.per_min or ""),
      tostring(f.fluid_per_min or ""), tostring(#(f.icons or {})),
      tostring(f.machine or ""), tostring(f.beacons or 0),
      tostring(f.recipe or ""), table.concat(names, ",") }, "\2")
  end
  return table.concat(out, "\1")
end

-- 列表把自己那一份签名存在自己的 tags 上：下一次自动刷新比的就是"这块控件当时是按哪一份结构建的"，
-- 而不是重新渲染一遍再猜。相等就一个字节都不动这一格（他的手指头在列表上，这是唯一不烦他的写法）。
local function shown_key(frame, name)
  local el = frame and G.find(frame, name)
  if not el then return nil end
  local kept = nil
  -- 直接读 `el.tags`，**不要 rawget**：替身里控件是 Lua 表（rawget 过），真引擎里它是 userdata
  -- （rawget 直接抛 "bad argument #1 of 3 to 'rawget'"）—— 2026-10-13 就是真建一次窗这一手抓到的，
  -- 而 smoke 全程绿，因为替身看不出让 rawget 崩的那半。
  pcall(function()
    local tg = el.tags
    kept = type(tg) == "table" and tg.arch_key or nil
  end)
  return kept, el
end

function G.helmod_shown(frame)
  local kept, pane = shown_key(frame, "arch-hf-list")
  -- 列表在，但那一格身上没记结构（窗口不是这个函数建起来的）：回一个签名永远不可能等于的值，
  -- 让它重画一次，而不是把"没记"读成"没变"。
  if pane then return kept or "(list)" end
  local none_kept, none_el = shown_key(frame, "arch-helmod-none")
  -- "没有可列的页"这一格**也记自己的签名**（哪一种没有：没装 / 装了没算 / 算了但空）。
  -- 从前这里回一句写死的 "(none)"，而签名那一边现在带上了 `msg_key` —— 两边永远不相等，
  -- 每一次刷新都把这一格连根重建（滚动位置那一坑的同一条形状，2026-10-14 审出来的）。
  if none_el then return none_kept or G.helmod_signature({}) end
  return "(blank)"
end

-- 自动刷新那一格真正做的事：只重画 helmod 那一格的列表，答案区、蓝图串、排法下拉都不动。
-- 返回 false 表示窗口不在（那正是计时器该什么都不做的时候）。
--
-- 返回值里的 `"same"` 是这一版的新东西，也是玩家用手指头量出来的那条 bug 的修法：**列表没变就不许碰那一格**。
-- 列表是一格滚动窗，重建它等于把它连根拔掉 —— 无条件一秒一次的话，他的滚动位置每一秒回顶。判"变没变"
-- 比的是这块控件建自己时留在 `tags.arch_key` 上的那份**结构签名**（见 `G.helmod_shown`），而不是重渲染一遍再猜；
-- 真变了才重建（那一下确实会跳回顶部，但那是他的 helmod 多了一页/少了一页），而答案区仍然不动。
function G.refresh_world(player, model)
  local frame = player.gui and player.gui.screen and player.gui.screen[ROOT]
  if not frame then return false end
  local row = G.find(frame, "arch-helmod-row")
  if not row then return false end
  if G.helmod_shown(frame) == G.helmod_signature(model) then return "same" end
  -- 列表没有"当前行号"这一格：最近复制过哪一页存在 `goal.helmod_factory` 里（行尾那颗「复制」按下去
  -- 写的就是它，见 `G.hf_click`），重建时按 id 找回那一行即可 —— 从前那套"下拉的行号 ↔ 页 id"
  -- 两份平行数组，连同下拉一起退休了。
  return G.helmod_row(row, model, ((model or {}).goal or {}).helmod_factory)
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
-- 这两样排在 `G.build` 之前不是排版问题：Lua 的 `local` 只对**它之后的文字**生效，声明在后面
-- 就等于把这一手交回给全局查找，答案是 nil —— 窗口一重建就崩在这里（`dev/lint.py` 的 forward-reference 那一gate
-- 抓的就是这一条，本文件顶上第一段注释也写着同一件事）。
-- 上一次那段答案。窗口是每次重建的，而"重建"在玩家手里有两个入口（顶行那颗刷新、以及自动刷新之后
-- 他再开一次窗），两个都不该把他刚读到的话擦掉 —— 2026-10-13 他第 2 条要的就是这一格。
-- 存在这个模块的一格里，不存进 `storage`：这不是存档的事实，是这一块屏幕的事实。
-- 进程换了它就没了（重启后重开窗口看到的是空答案区），这是这一版的边界，写在这儿而不是让它看起来像永存。
local report_cache = {}

local function render_report(box, title, lines, detail)
  pcall(function() box.clear() end)
  box.add { type = "label", name = "arch-report-title", caption = truncated(title, 120) }
  -- `detail` 不是"少说点"：收起来的那些是**给脚本与调试看的数**（牌子几块带字、连线几条回读、
  -- 控制带几件配置…），而**被拒的页与失败永远留在默认那一组里** —— 收起细节把失败也收起，
  -- 就是这一串改动最被指着说的那种安静。
  local hidden = 0
  for _, l in ipairs(lines or {}) do
    if type(l) == "table" and l.tech and not detail then
      hidden = hidden + 1
    else
      box.add { type = "label", caption = truncated(type(l) == "table" and l.line or l, 200) }
    end
  end
  if hidden > 0 then
    box.add { type = "label", name = "arch-report-folded",
      caption = L("detail-hidden", hidden) }
  end
end

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
  -- 窗口三颗：最小化 / 最大化 / 关闭。Factorio 不给 mod 自己的标题栏，所以这一排是自己搭的
  -- （2026-10-13 他要的"像 windows 窗口那样"）。三颗都在**顶行最右**，位置和他习惯的一致；
  -- 状态存进 `storage.gui_panel[i].layout`，所以下次开窗口还是他上次要的样子。
  -- 顶行这些按钮一律画成一个符号（他第 2 条："顶部这些按钮变为图标"）。为什么是字符不是图：
  -- 这个 build 里 `helpers.is_valid_sprite_path("utility/close_white")` 回 false —— 引擎不给 mod
  -- 用它标题栏那套现成图，而本 mod 自己烤四张 png 只是为了三个箭头形状，不值。符号 + tooltip
  -- 是同一种可读性，代价是一行文案。（要换成图：`dev/make_icon.py` 出 png、data.lua 注册 sprite、
  -- 这里 `type="sprite-button"` 换掉 `type="button"` 即可。）
  head.add { type = "button", name = "arch-refresh", caption = L("refresh-glyph"), tooltip = L("refresh") }
  -- 自动刷新是一格偏好，不是一颗按钮：它改的是"这个窗口开着的时候每隔一会儿重读 helmod"，所以它的状态
  -- 必须能留在存档里（下次开窗口还是玩家上次要的样子），也必须手动那一按还在 —— 有人只想在自己按下之后
  -- 看一眼结果。
  head.add { type = "checkbox", name = "arch-auto-refresh", state = model.auto_refresh and true or false,
    caption = L("auto-refresh"), tooltip = L("auto-refresh-tip") }
  -- 字面算好再进 `add{}`：检查器扫的是表里的 `xxx =`，而 `foo == "bar"` 的第一个等号也算一个键
  -- （`model.layout ==` 与 `win ==` 两次都是这么被判成"未知控件属性"的）。比较放在外面，表里只留名字。
  local win = (model or {}).layout or "normal"
  -- 字面一律先在外面算好再进 `add{}`：`dev/gui_api_check.js` 扫的是表里的 `ident =`，
  -- 而 `win == "mini"` 的第一个等号也被它读成一个控件属性（这条已经栽过两次，注释在 `head` 那一段）。
  -- tooltip 里要说清这一格**现在**是什么档（符号只能告诉他"收起/展开这一类"）：收起那颗点下去是还原。
  local min_caption = (win == "mini") and L("win-restore-glyph") or L("win-min-glyph")
  local min_tip = (win == "mini") and L("win-restore") or L("win-min")
  local max_caption = (win == "max") and L("win-shrink-glyph") or L("win-max-glyph")
  local max_tip = (win == "max") and L("win-shrink") or L("win-max")
  head.add { type = "button", name = "arch-win-min", caption = min_caption, tooltip = min_tip }
  head.add { type = "button", name = "arch-win-max", caption = max_caption, tooltip = max_tip }
  head.add { type = "button", name = "arch-close", caption = L("close-glyph"), tooltip = L("close") }

  -- 玩家的输入只有这三格，而且每一格都是一个 RCON 参数，不是这个文件自己的意见：第 1 行都是"不表态"
  -- （空串），于是记住的选择和窗口重建后看到的选择不会各说一套。
  local form = frame.add { type = "flow", direction = "horizontal", name = "arch-form-row" }
  form.add { type = "label", caption = L("form-style") }
  local style_ids = style_ids_of(model)
  local style_items = { L("style-auto") }
  for _, word in ipairs(style_labels(model.styles, model.style_classes, model.style_units)) do
    style_items[#style_items + 1] = word
  end
  -- 下拉里是**短词**（"单排 / 双排 / 液体后进"），长的那句解释挂在 tooltip 上：
  -- 他 2026-10-13 说"排法显示的方式和内容我有点看不懂"—— 窗口现在窄了，一行里塞一整句
  -- 说明会把下拉顶成一列长条，反而更难选。选中哪一档，tooltip 就说那一档铺出来长什么样。
  local style_sel = word_index(style_ids, (model.goal or {}).style)
  local style_dd = form.add { type = "drop-down", name = "arch-form-style", items = style_items,
    selected_index = style_sel, tooltip = G.style_tip(model, style_sel) }
  pin_ids(style_dd, style_ids)
  -- 这一格少了一档而玩家自己没动过它 —— 必须说出来（口径：不背着换）。写在这一行他才看得见，
  -- 只写在存档里等于没说。
  if (model.style_dropped or "") ~= "" then
    form.add { type = "label", name = "arch-form-style-note",
      caption = L("style-dropped", tostring(model.style_dropped),
        tostring(model.style_class or "")) }
  end
  -- 线头那一格**取消了**（2026-10-13 他第 3 条）：四种带箱线头 0.98.0 前就拆光了，今天所有线都从裸带子
  -- 起步，这一格只剩"不表态/裸带"两行 —— 一行永远等于另一行。留着一个只会有一个答案的下拉就是让
  -- 玩家去点一个不会改变任何东西的控件。值改由 `G.model` 固定交出去（`goal.heads = "belt"`），
  -- 所以后端读到的和窗口显示的是同一件事，不是"窗口不说话了、后端自己猜"。
  -- 带子那一格是"可以选"那一半：默认（第一行）不表态，由模按这条线的流量从最慢能装的开始挑；
  -- 往下点就是玩家自己指定哪一档。候选读自零件阶梯，所以模组加的带子也在这列表里。
  form.add { type = "label", caption = L("form-belt") }
  local belt_items = { L("belt-auto") }
  local belt_ids = belt_ids_of(model)
  for _, name in ipairs(model.belts or {}) do
    -- 名字用游戏自己的翻译，后面跟着原型 id —— 和本 mod 其它菜单同一写法。`NM` 交回的是一个本地化串
    -- 表，不能 `..` 拼（拼一次窗口就整扇建不起来，量过），所以这句话走 locale。
    belt_items[#belt_items + 1] = L("belt-row", NM(name, "entity"), name)
  end
  local belt_dd = form.add { type = "drop-down", name = "arch-form-belt", items = belt_items,
    selected_index = word_index(belt_ids, (model.goal or {}).belt),
    tooltip = L("form-belt-tip") }
  pin_ids(belt_dd, belt_ids)

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
  local ahead = out.add { type = "flow", direction = "horizontal" }
  ahead.add { type = "label", caption = L("sec-answer"), tooltip = L("sec-answer-tip") }
  -- 详细开关（2026-10-13 他第 6 条"输出简化，让人看得懂"）：默认只留几句人话，
  -- 勾上才把每一步的数字都摊开。**被拒的页永远都在**，不受这一格影响 —— 收起细节不能把失败也收起。
  ahead.add { type = "checkbox", name = "arch-detail", state = model.detail and true or false,
    caption = L("detail-on"), tooltip = L("detail-tip") }
  -- 蓝图串要能复制：一串 base64 贴在聊天里是选不中的，而它的用途正是粘到别处或发给别人。所以是个
  -- 文本框，并且一进来就全选上 —— 一次 Ctrl+C 就是整个交互。
  local srow = out.add { type = "flow", direction = "horizontal", name = "arch-string-row" }
  srow.add { type = "label", name = "arch-string-label", caption = L("blueprint-label") }
  srow.add { type = "textfield", name = "arch-string-out", text = "" }

  -- 答案区是一块**滚动区**：上一版把话截到 24 行再补一句"另有 N 行"，于是"跳过哪一行 / 哪几台被拒 /
  -- 怎么回去"这些页级的话，在一页铺得长一点时会被挤到看不见 —— 而这三句恰恰是他点名要永远在的那几条。
  -- 元素名是 `scroll-pane`（连字符；写成下划线引擎回 Unknown gui element type）。
  local pane = out.add { type = "scroll-pane", direction = "vertical", name = "arch-report-scroll",
    -- 横的不要（每行本来就截到 200 字），纵的留着 —— 2.0 的键叫 `horizontal_scroll_policy`，值取自
    -- 这台安装自带的 runtime-api.json 那个 `ScrollPolicy` 枚举（never / dont-show-but-allow-scrolling /
    -- always / auto / auto-and-reserve-space）。从前这里写的是 1.1 那一路的 `..._scrollbar_policy`
    -- 加一个不存在的值 "disable"，被 `gui_api_check` 拦在打包之前 —— 那正是"玩家一开窗就没窗"那一类。
    horizontal_scroll_policy = "dont-show-but-allow-scrolling" }
  pane.style.minimal_height = 120
  pane.style.maximal_height = 320
  local box = pane.add { type = "flow", direction = "vertical", name = REPORT }
  -- 窗口重建 ≠ 答案作废：上一次那段话原样画回来。但**展开到哪一档按现在这一档画**，不按缓存里那一档：
  -- 勾上「详细」走的是"写状态 → 重建窗口"这条路，缓存里存的还是勾之前那份，照它画就等于
  -- "勾亮上了、字没多出来"，要再按一次别的东西才展开（2026-10-14 审出来的就是这一格）。
  local kept = report_cache[player.index]
  if kept then render_report(box, kept.title, kept.lines, model.detail) end
  G.apply_layout(frame, model)
  return frame
end

-- 窗口的三档形状（正常 / 最小化 / 最大化）落在同一处：尺寸只有一个地方说，
-- 否则"最大化"改了一格、"最小化"改了另一格，两半会各自长。
-- 宽度读自列表那六列之和（`HF_LIST_W`），不是又拍一个数：从前窗口 780 而列表 760 各写一遍，
-- 他说"窄一点"时改一处就会让另一处对不上（答案区比列表宽出一截那种歪）。
local LAYOUT_SIZE = {
  normal = { list = 240, answer_w = HF_LIST_W + 24, answer_h = 240 },
  max    = { list = 520, answer_w = HF_LIST_W + 24, answer_h = 460 },
}

function G.apply_layout(frame, model)
  if not frame then return false end
  local layout = (model or {}).layout or "normal"
  local want = LAYOUT_SIZE[layout] or LAYOUT_SIZE.normal
  pcall(function() frame.tags = { arch_layout = layout, arch_detail = (model or {}).detail and 1 or 0 } end)
  -- 最小化 = 只留顶行（标题、刷新、三颗窗口按钮）。正文整排藏起来，不销毁 ——
  -- 销毁了再点回来就什么都没了，玩家要的"最小化"是收起来，不是把窗口清空。
  for i, c in ipairs(frame.children or {}) do
    if i > 1 then pcall(function() c.visible = (layout ~= "mini") end) end
  end
  local pane = G.find(frame, "arch-hf-list")
  if pane then
    pcall(function()
      pane.style.minimal_height = want.list
      pane.style.maximal_height = want.list
      pane.style.minimal_width = want.answer_w - 20
      pane.style.maximal_width = want.answer_w - 20
    end)
  end
  local answer = G.find(frame, "arch-sec-answer")
  if answer then
    pcall(function()
      answer.style.minimal_width = want.answer_w
      answer.style.maximal_width = want.answer_w
      answer.style.minimal_height = want.answer_h
      answer.style.maximal_height = want.answer_h
    end)
  end
  return true
end

-- Which verb this answer belongs to, said in the window's words. The English column is deliberately the
-- same string the method and the JSON use -- `plan`, `scan`, `save` -- so a suite that reads the header
-- back is still matching the verb it clicked, and only the player sees 算一下.
local VERB_WORDS = {
  helmod = L("verb-helmod"),
  -- `helmod_all`（每一页各出一张）与 `undo`（撤回压到地面的那一按）两个动词跟着那两条门一起删了
  -- （2026-10-14 深夜他第 7 条）。窗口上现在只有每行那颗「复制」。
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
  -- 技术上成立、但玩家不需要的几句（牌子几块带字、连线回读几条、控制带配了几件…）包一层形状，
  -- 让答案区在默认那一档收起来（`G.show_report` 认 `{tech=,line=}`）。**拒因与失败永远不走这一层。**
  local function add_tech(s) if s and s ~= "" then lines[#lines + 1] = { tech = true, line = s } end end
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
      if det.why or det.why_key then add(L("r-why", words_for(det, "why", 200))) end
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

  if cmd == "helmod" then  -- 「复制」那一行交回的答案走这一支（`api.helmod` = `into = "string"`）
    -- Helmod's numbers as ground. The counts are said twice on purpose: `wanted` is what the plan
    -- asked for and can be a fraction (2.5 furnaces is a real answer in helmod), `laid` is whole
    -- ghosts, and a reader who is not told the difference counts machines and concludes the mod lost
    -- some. The undo line is the one that makes an ungated button safe to press.
    local o = (d.origin or {})
    -- `held` for the hand, `ghosts` for the ground: the same authored plan counted where it landed.
    if d.scoped then add(L("n-hm-scoped", tostring(d.scoped), tostring(d.page or ""))) end
    -- 第一个数是**这一发铺了几条线**（`#d.lanes`），不是从前那个 `d.kinds`：那格只有从 helmod 工厂
    -- 名单那一扇门才数得出东西，走"复制这一页"的玩家每一条答案都读到 "0 kind(s)" —— 一个永远为零的数
    -- 写在第一句，比不写更坏（2026-10-13 他第 6 条"要让人看得懂"量的就是这一行）。
    add(L("n-hm", #list_of(d.lanes), d.ghosts or d.held or d.entities or 0, tostring(d.surface or "?"),
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
      add_tech(L("n-hm-signs", (d.signs or {}).carried or 0, d.signs.asked))
    end
    -- 连线只有蓝图那一路带得住（地那一路的虚影连不了线：2.0 没有脚本连线的方法），所以这一行只在
    -- 这一页走了蓝图时出现，说的还是"回读出来几条"，不是"我们写了几条"。
    if (d.wires or {}).asked then
      add_tech(L("n-hm-wires", (d.wires or {}).carried or 0, d.wires.asked))
    end
    -- 控制带那一圈（每台机器一只选择器 + 发射器/算术盒）：这一行说的是"几件配置写下去了、引擎那一侧
    -- 还带着配置的有几件"，而蓝图那一路还要多念一句机器那一格没跟过来（`circuits.recipe_control`）。
    -- 数的都是引擎的答复，不是铺的人自报 —— 一句"配好了"而地上一件都没配置，正是这类答案被指过的错。
    if (d.circuits or {}).asked then
      add_tech(L("n-hm-circuits", (d.circuits or {}).carried or (d.circuits or {}).written or 0,
        d.circuits.asked))
      if (d.circuits.recipe_control or {}).asked then
        add_tech(L("n-hm-circuits-rc", d.circuits.recipe_control.asked,
          d.circuits.recipe_control.carried or 0))
      end
    end
    -- 页级那三句排在**逐行明细之前**：详细那一档只留前 24 行（下面 `t-more` 说还剩几条），而从前这三句
    -- 排在最后 —— 于是一页铺得越长，"跳过哪一行 / 哪几台被拒 / 怎么回去"越是先被砍掉的那几条。
    -- 他点名的恰恰是"被拒的那几页永远都在，不用勾"，所以这个顺序不能靠长短赌运气。
    for _, s in ipairs(list_of(d.skipped)) do
      add(L("n-hm-skip", NM(s.name or "?", "entity"), string.format("%.2f", tonumber(s.wanted) or 0),
        words_for(s, "why", 160)))
    end
    for _, r in ipairs(list_of(d.refused)) do
      add(L("n-hm-refused", NM(r.name or "?", "entity"),
        tostring((r.at or {}).x) .. "," .. tostring((r.at or {}).y)))
    end
    if d.undo_depth then add(L("n-hm-undo", d.undo_depth, tostring(d.rounded or "?"))) end
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
      -- 配方名走 `NM`：这一句从前打的是 `electronic-circuit` 这样的原型 id（他："这些英文我看不懂"）。
      -- 原型 id 仍然在 JSON 里给脚本读，只是不再顶在给人看的那一行上。
      add(L("n-hm-lane", NM(l.recipe or "?", "recipe"), NM(l.machine or "?", "entity"),
        l.machines or 0, l.entities or 0, belts, arms, chests,
        tostring((l.at or {}).x or "?"), tostring((l.at or {}).y or "?")))
      -- The SHAPE, in its own row: the counts above say 3 chests and 99 arms for 48 machines, and the
      -- word that says why is the style this lane was laid as -- a line pays its interface once.
      if l.shape then
        -- 排法也一样：`row-belts` / `stacked` 这种 id 只留在 JSON 里，行上给的是窗口那一格用的短词。
        add_tech(L("n-hm-shape", STYLE_WORDS[l.shape] or tostring(l.shape),
          NM(l.machine or "?", "entity")))
        -- 占地：`width`/`height` 是这条线**实际**摆出来的行列数（虚影那一路带在每条线上），
        -- 所以这里报的是量到的数。"比另一档深几格"不写 —— 那要把同一发再摆一遍才知道，
        -- 而真换了档的时候上面那行 `n-hm-style-*` 会点名是哪一档、为什么换。
        if tonumber(l.width) and tonumber(l.height) then
          add_tech(L("n-hm-size", tostring(l.width), tostring(l.height)))
        end
      end
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
        -- 同一件事下面那句 `n-hm-swap` 已经写在默认那一档了（那句还带"要几台、可以点名"的下一步）。
        -- 两行说一句，正是他第 6 条要收掉的那种啰嗦 —— 这一行留着给"详细"那一档。
        add_tech(L("n-hm-machine-moved", NM(l.asked_machine, "entity"), NM(l.machine, "entity")))
      end
      if l.fed_items and #l.fed_items > 1 then
        -- Which materials the ONE line this lane laid carries. Said because the compactness is the point
        -- the player traded for: two materials sharing a belt is only a fact if both of them arrive, and
        -- the row above is where the answer commits to that rather than to the drawing.
        add_tech(L("n-hm-fed", NM(l.fed_items[1], "item"), NM(l.fed_items[2], "item")))
      end
      -- 两头那两块牌各自写的是什么。玩家要的就是"站在头看一眼知道吃什么、站在尾看一眼知道吐什么"，
      -- 所以窗口这里把两块牌的读数分开交出来 —— 少了尾那一行，铺没铺上都看不出来。
      -- 牌上那两行字**此刻就写在游戏里的两块牌上**（0.99.0 起字真的画得出来了），所以窗口里再念一遍
      -- 是第二次说同一件事 —— 收进"详细"那一档：他要看的是"牌上到底有没有字"，那一眼在地上。
      if l.head_manifest then add_tech(L("n-hm-sign-head", l.head_manifest)) end
      if l.tail_manifest then add_tech(L("n-hm-sign-tail", l.tail_manifest)) end
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
      -- 两个口径并列（#35 ③）：helmod 那一句"要几条带子"（式子出来的分数 + 按"≤0.5 占一股、再多整条向上"
      -- 贴好的那个数），与这一条线实际铺了几行成品带（几何律：股数 ÷ 每行能装几股）。玩家要的"1.1 条按 2 条"
      -- 就是第一个数；第二个数是他地上会看到的行数。两者不一致时要能当场看见差在哪，而不是只能拆蓝图去反推。
      local bn = l.belt_need_helmod
      if bn and bn.product_belts ~= nil then
        -- 那一档是谁定的，写成两条键而不是一条带参数的：把局部化串当参数塞进去，在窗口里没问题，
        -- 在门禁那种"把参数原样拼出来"的读法里就是一张表（这一文件为 `NM` 踩过一次）。
        local raw = { string.format("%.2f", tonumber(bn.product_raw) or 0),
          bn.product_belts, bn.product_belts * 2, tostring(bn.belt or "?"),
          l.product_rows or 0, bn.bonus or 0 }
        if l.belt_chosen_by == "caller" then
          add_tech(L("n-hm-belt-need-named", raw[1], raw[2], raw[3], raw[4], raw[5], raw[6]))
        else
          add_tech(L("n-hm-belt-need-auto", raw[1], raw[2], raw[3], raw[4], raw[5], raw[6]))
        end
        -- 上面那句说"铺了 0 行成品带"的那些发，成品并不是没铺 —— 它走进料行离机器远的那一股里
        -- （0.85.0 的共用行）。少了这一行，玩家看到"要 2 条 → 铺 0 行"会以为线在漏东西。
        if (l.product_lanes_shared or 0) > 0 then
          add_tech(L("n-hm-belt-shared", l.product_lanes_shared))
        end
        -- 成品一行管子那一档：`l.product_rows` 是 0 而成品没丢 —— 它从机器出口那一面的一行管子走。
        -- 不说这一句，"铺了 0 行成品带"与那一行"每分钟 9000"就是两句互相打脸的话。
        local pf = l.product_fluid
        if pf and pf.fluid then
          add(L("n-hm-fluid-out", NM(pf.fluid, "fluid"), tostring(pf.face or "?"),
            string.format("%.0f", tonumber(pf.units_per_min) or 0)))
        end
      end
      -- 分子退回自算的理由只有一个能在这里出现：地上这台机器不是 helmod 那一行点名的那台。两个数都给出
      -- （helmod 那份原数与按地上这台算出来的那份），因为"到不到那个数"是玩家下一步要问的问题。
      local rs = l.rate_source or {}
      if rs.reason == "machine_swapped" then
        local aside = rs.helmod_aside or {}
        add_tech(L("n-hm-rate-self", NM(aside.helmod_machine or "?", "entity"),
          NM(l.machine or rs.laid_machine or aside.laid_machine or "?", "entity"),
          string.format("%.0f", tonumber(aside.crafts_per_min) or 0),
          string.format("%.0f", tonumber(rs.crafts_per_min) or 0)))
      end
    end
    for _, f in ipairs(list_of(d.lane_fallback)) do
      -- The lane did not happen and the machines still did: said as its own row, because a plan that
      -- arrives as loose machines instead of as a line is a different job for the player.
      add(L("n-hm-nolane", tostring(f.recipe or "?"), NM(f.machine or "?", "entity"),
        f.asked or 0, words_for(f, "why", 160)))
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
      add(L("n-hm-modules-page", d.modules_said, d.modules_count or 0))
    end
  else
    add(L("t-no-summary", tostring(cmd)))
  end
  -- Still a ceiling -- a plan must not be able to push the frame off the screen -- but counted against
  -- the row cap above rather than against everything, so what a reader would lose here is a repeated
  -- row and not the sentence that tells them what to do about it.
  -- 仍然有一道顶，但它现在是"防失控"而不是"替玩家决定他读得到哪几句"：答案区会滚，
  -- 而 400 行之外的那一部分本来也不是一段人该读完的话（完整回答始终在 RCON 里）。
  -- 从前这里是 24 —— 一页 12 条线的计划会把页级那三句挤出窗口。
  if #lines > 400 then
    local cut = {}
    for i = 1, 400 do cut[i] = lines[i] end
    cut[#cut + 1] = L("t-more", #lines - 400)
    lines = cut
  end
  return { title = titled(cmd, name), lines = lines }
end

-- Fill the report area. Returns whether it was reached: a panel closed between the click and here is
-- a real sequence, and `show_string` already treats it that way.
function G.show_report(player, title, lines, detail)
  local frame = player.gui and player.gui.screen and player.gui.screen[ROOT]
  local box = frame and G.find(frame, REPORT)
  if not box then return false end
  report_cache[player.index] = { title = title, lines = lines, detail = detail }
  render_report(box, title, lines, detail)
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
local function read_form(player, model)
  local screen = player and player.gui and player.gui.screen
  local root = screen and screen[ROOT]
  local function idx(name)
    local el = root and G.find(root, name)
    return el and el.selected_index or nil
  end
  -- 行号 → 值，读的那份名单是**建这一格时钉在控件上的那一份**（`pin_ids`）。拿现在重算的名单数行号
  -- 会这样坏：窗口开着的时候研究开了一档、或 helmod 少算一页，名单少一行，行号就往前挪一位 ——
  -- 玩家点着"双排"、压下去的是"单排"，而屏幕上亮的还是"双排"（2026-10-14 审出来的第 13 条）。
  local function picked(name, fallback)
    local el = root and G.find(root, name)
    return word_value(pinned_ids(el, fallback), el and el.selected_index)
  end
  -- 压的是哪一页。列表这一格不再有"行号"这件事（下拉退休了）：他的意见就是记在 goal 里的那个 id。
  -- 从前这里比的是"下拉第几行 ↔ 那个 id"，而 `idx("arch-form-helmod")` 现在永远是 nil ⟹
  -- 每一次压线都会冒出一句"helmod 的列表动了"（2026-10-13 体检抓到的假话：控件已经不存在，
  -- 比对还在跑）。现在只剩一种真会动的情况：**他记住的那一页从 helmod 的列表里消失了** ——
  -- 那时这一按回到"整页"，并且把这件事说出口。
  local pages = ((model or {}).helmod or {}).factories or {}
  local by_id = {}
  for _, f in ipairs(pages) do by_id[tostring(f.id)] = f.name or tostring(f.id) end
  local page_kept = tostring(((model or {}).goal or {}).helmod_factory or "")
  local pressed_for, page_drift = page_kept, nil
  if page_kept ~= "" and not by_id[page_kept] then
    pressed_for = ""
    page_drift = { vanished = page_kept }
  end
  return {
    -- 第 1 行 = 空串 = "不表态"，于是形状交给阶梯按机器数与料种数给；其它行是对两条路都算的一道令。
    style = picked("arch-form-style", style_ids_of(model)),
    style_index = idx("arch-form-style"),

    -- 线头不再从控件读（那一格取消了）：值由 `G.model` 固定在 goal 上（裸带），
    -- 所以"窗口显示的"和"后端拿到的"是同一个词，不是两处各猜一次。
    heads = (model or {}).goal and (model.goal or {}).heads,
    -- 带子：第 1 行是"不表态"，交给 `card_example` 按"够用就好"从最慢那档往上试；其它行是玩家点名的
    -- 那一档，点名就不升级也不降级。读回的是原型名，不是标签。
    belt = picked("arch-form-belt", belt_ids_of(model)),
    belt_index = idx("arch-form-belt"),
    -- 压的是哪一页（或页里的哪一条线）：读回的是 helmod 自己给的 id，不是标签。
    helmod_factory = pressed_for,
    helmod_page_drift = page_drift,
  }
end

-- Every button this dispatcher answers for, named in the file that owns the answering. The self-test
-- snapshots the report area after each of these clicks, and until now it kept its own copy of this list
-- in control.lua -- which is how `arch-undo` and `arch-boxhere` were added to the window, dispatched
-- correctly, and never once checked for the answer they left in it: a list maintained two files away from
-- the thing it describes rots exactly that quietly.
-- 窗口上真的会做事的按钮。`gui_selftest` 按这一列逐颗按一次，所以它必须**就是窗口上那些颗**：
-- 名单与窗口两处各维护一份的时候，就会有一颗按钮上线至今没人按过一次（`arch-modules` 与
-- `arch-listen` 当年正是这样漏的）。列表行尾那颗名字带页 id，不在这张表里，由自测按
-- `arch-hf-copy:selftest` 那一次覆盖。
G.COMMAND_BUTTONS = {
  "arch-win-min", "arch-win-max", "arch-refresh", "arch-close", "arch-toolbar" }

-- 行尾那三颗按钮把"哪一页"带在名字里：Factorio 交给点击处理的是一个元素、不是闭包（1397 行那条注释
-- 早就写了这一手，只是一直停在注释上）。这里给它一个实现：`arch-hf-<动词>:<页 id>`。
local function hf_split(element_name)
  return string.match(tostring(element_name or ""), "^arch%-hf%-(%a+):(.+)$")
end

-- 行尾这一颗按钮的名字带页 id（`arch-hf-<动词>:<页 id>`），是因为 Factorio 交给点击处理的是一个元素、
-- 不是闭包。原来这一族有三颗（选页 / 压页 / 拿到手里），2026-10-13 他第 5 条之后只剩「复制」一颗：
-- 选页不需要单独一颗（按哪一页就复制哪一页），压页整扇门从窗口撤了（要铺地上走 RCON 那一扇门）。
-- 底下走的还是同一只 `api.helmod`、同一份几何 —— 没有第二份状态，这正是这个项目最怕的东西。
-- 行尾那一颗「复制」= 原来那颗"按 helmod 拿到手上"，只是按在**具体的哪一行**上：
-- 走的是同一只 `api.helmod`（同一个后端、同一份几何），差别只有两点 —— 页 id 从按钮名字里来，
-- 以及写明 `into = "cursor"`（不写的话引擎那侧默认就是 cursor，但那正是上一轮体检抓到的坑：
-- 靠默认值走某条路，等默认值一改，按钮就悄悄换了行为）。
function G.hf_click(player, verb, id, model, api)
  if verb ~= "copy" then return nil end
  local form = read_form(player, model) or {}
  form.helmod_factory = id
  form.into = "cursor"
  local res = api.helmod(form)
  local out = G.report_lines("helmod", "", res)
  G.show_report(player, out.title, out.lines, (model or {}).detail)
  if res and res.ok then
    local d = res.data or {}
    local shown = d.blueprint and G.show_string(player, "helmod", d.blueprint) or false
    player.print(L("chat-helmod", tostring(d.held or d.ghosts or d.entities or 0),
      tostring(d.surface or "?"),
      shown and "(Ctrl+C)" or (d.blueprint and "(field gone)" or "(no text)")))
  end
  -- 被拒时**不再往聊天里印第二遍**：这一按的结果已经整段写在答案区了（含拒因与那一页的名字）。
  -- 两个地方说同一件事、还各用一种语言，正是这个项目最贵的那类错 —— 而 `style_classes_probe`
  -- 那条"建窗口期间不许碎嘴"的门禁就是把这一处重复抓出来的（我加它的时候就红了）。
  return "hf_copy", res
end

-- 顶行那三颗窗口按钮：最小化 / 最大化 / 关闭。状态写在玩家那一份记录里，所以"收起"不会被
-- 下一次自动刷新又弹回来；切换后用新模型重建一次 —— 这是唯一允许重建的场合：动手的是玩家自己，
-- 他要的就是这一按之后窗口变了样。
function G.win_click(player, element_name, model, api)
  local want = element_name == "arch-win-min" and "mini" or "max"
  local frame = player.gui and player.gui.screen and player.gui.screen[ROOT]
  -- 当前档位读的是**控件自己身上**那份（`apply_layout` 写进去的），不是 model 传进来的那一份：
  -- 玩家连按两次要能"展开→收回"，而 model 是这一按之前建的，读它会第二按没反应。
  local now = nil
  if frame then
    local ok, tags = pcall(function() return frame.tags end)
    now = ok and type(tags) == "table" and tags.arch_layout or nil
  end
  local next_layout = (want == now) and "normal" or want
  api.panel_set("layout", next_layout)
  -- 重建用的模型：拿手上这一份改一个字段就够（存储里已经写了同一档）。
  -- 从前这里写的是 `api.model()` 再 `.data`，而那只 api 交回的就是模型本身、没有 `data` 这一层
  -- ⟹ 取到 nil ⟹ `G.build(player, nil)` 在建标题那一行炸（style_classes_probe 抓到的是
  -- "attempt to index local 'model' (a nil value)"）—— 传进去一个可能是 nil 的东西，比不重建糟得多。
  local shown = {}
  for k, v in pairs(model or {}) do shown[k] = v end
  shown.layout = next_layout
  G.open(player, shown)
  return "window", { layout = next_layout }
end

function G.on_click(player, element_name, model, api)
  if not element_name then return nil end
  local hf_verb, hf_id = hf_split(element_name)
  if hf_verb then return G.hf_click(player, hf_verb, hf_id, model, api) end
  if element_name == "arch-close" then G.close(player); return "closed" end
  -- 右上角那颗按钮是"开或关"，不是"重建"：窗口已经开着再按一次，玩家要的是它消失。
  if element_name == "arch-toolbar" then
    local opened = G.toggle(player, model)
    return "toolbar", opened
  end
  if element_name == "arch-refresh" then
    -- 无感刷新（2026-10-13 他第 2 条）：helmod 那一格没变就**一个字节都不动** —— 从前这一按把整扇窗
    -- 连根重建，于是列表的滚动位置回到顶部、答案区被擦成空白，他要重看的那段话正是被这一按擦掉的。
    -- 判"变没变"用的是那块控件建自己时留下的结构签名（与自动刷新同一句，两处不各记一套）；
    -- 真变了才重建，而重建时答案区由 `report_cache` 原样补回来。
    if G.refresh_world(player, model) ~= "same" then G.open(player, model) end
    return "refreshed"
  end
  -- 顶行那三颗窗口按钮（最小化 / 最大化 / 关闭）。
  if element_name == "arch-win-min" or element_name == "arch-win-max" then
    return G.win_click(player, element_name, model, api)
  end
  -- 「按 helmod 拿到手上」与「全部塞进背包」这两颗全局按钮**删掉了**（2026-10-13 他第 5 条）：
  -- 前者每一行都有一颗「复制」，同一个动作不该在窗口里有两个入口还各起一个名字；
  -- 后者服务的是"一整页各出一张蓝图"，而他不要这一步。两条 RCON 门（`helmod_ghosts` 的
  -- `factory` / 不带 factory 的整计划）都还在，被删的只是窗口上那一颗。
  -- 「撤销放置」那颗按钮删了（2026-10-13 他第 5 条）：窗口不再直接往地上铺虚影（"压这页"也删了），
  -- 这一颗就没有对象可撤。RCON 那一侧的 `place_undo` 留着 —— 用 `into = "ground"` 铺的那一路 still 需要它。
  return nil
end

-- 复选框走的是另一个事件（`on_gui_checked_state_changed`），所以它有自己的入口。这里只说"这一格现在是
-- 什么"，不碰 storage —— 那份状态归 control 管，窗口重建时它读回来，两边才不会各记一份。
function G.on_checked(player, element_name, state)
  -- 两格复选框：自动刷新、答案区的"详细"。窗口只说"这一格现在亮着"，
  -- 存到哪去由 control 那一侧定 —— 状态不归窗口记，否则重建一次就忘一次。
  local VERB = { ["arch-auto-refresh"] = "auto_refresh", ["arch-detail"] = "detail" }
  local verb = VERB[element_name or ""]
  if not verb then return nil end
  return verb, state and true or false
end

-- 下拉换了一行。窗口上原本没有任何一处听这件事，所以"选中那一档的解释"停在上一档 —— 而那句解释正是
-- 这一格唯一的用处（2026-10-14 审出来的第 12 条）。这里**只改那一格的 tooltip，不重建窗口**：
-- 重建会把工厂列表的滚动位置拔掉，那正是他 10-13 要"无感刷新"时指的同一格。
function G.on_selection(element, model)
  local name = element and tostring(element.name or "")
  if name == "arch-form-style" then
    element.tooltip = G.style_tip(model, tonumber(element.selected_index) or 1)
    return "style"
  end
  return nil
end

return G