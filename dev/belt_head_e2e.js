// 线头去箱：一条带子直接接总线的产线，加开头那块把料道写明白的标牌。
//
// A lane's head used to be chests. They are what the bench fills (`storage.lab.rig.in_chests`), so they
// are also what every rate this mod has ever reported leans on -- and in a real factory nobody builds a
// chest at the head of a smelting row: you bring your own feed belt up to it. Helmod's own
// blueprints do the same, which is why "为啥还会有一堆箱子" arrived as a complaint about a pressed line.
//
// `heads = "belt"` is that head, and it is the DEFAULT: no chest, no head arm, the row starts as a bare
// belt tail, and the cells the heads would have taken carry a SIGN -- one display panel standing right
// beside the belt it describes, its text naming which material rides which half-lane (0.93.0: the
// emitter box and the wires are gone -- his third note after laying the blueprints by hand). Asserted
// from four sides, because
// each one breaks quietly:
//
//   * the SHAPE: the chests really are gone (`parts.chests === 0` on the card the default answer returns,
//     and on the two-row one), and the two sign parts really are there;
//   * the SIGN: every material the recipe eats is named, with a lane number, on the panel's own list
//     (`sign_lanes`) -- and the answer's `head.lanes` is read back off that list rather than off a wish;
//   * the NO-WIRE: 0.93.0 took the emitter box out (his third note: 那块牌子旁边的组合器与电线根本看不懂).
//     Asserted as an absence on both doors, because a leftover combinator would still pass the old check:
//     the card's wire list is empty, the card holds no combinator at all, the ghosts on the ground show
//     `display-panel` and zero `decider-combinator`, and re-exporting the blueprint counts 0 wires.
//     (连线这一路今天只剩"手搓的卡自己带 `wires`"那一条：`"wires":[[1,3,2,1]]` 走
//     `get_blueprint_entities` 量过，而铺到地上那一路在 2.0 根本连不了线（`circuit_connect` 不存在），
//     答案里自己就这么说。撤回那一步两种交付路都要把件从地上带走。)
//   * the REFUSALS: asking for the deleted chest head, and naming a panel this install cannot place, are
//     both refused BY NAME -- while an install that cannot place the sign without being asked still gets
//     its line, with the missing part said out loud (`head.sign_missing`) rather than the whole chain
//     refused for a piece of documentation.
//
// What this file does NOT claim: that a BUILT panel is lit. The panel's own text is written on the ghost
// and read back off the ground here, and the blueprint record carries it to the engine's own reader -- but
// nothing on this install can turn a ghost into an entity for you (`revive()` answers nil on a script-made
// ghost), so "does the content survive the build" is still the player's one click to answer.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("belt_head_e2e");

const ENV = { ...process.env, RAW: "1" };
const call = (method, args) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"], env: ENV }));
  } catch (e) { return { ok: false, code: "BRIDGE_ERR", msg: String(e.stdout || e.message).slice(0, 200) }; }
};
const lua = (src) => execFileSync("node", [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", maxBuffer: 1 << 28, env: ENV }).trim();
const asArr = (v) => (Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : []));
let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : "\n  " + String(detail).slice(0, 400)}`);
  cond ? pass++ : fail++;
};

// The sign needs `circuit-network` (both parts unlock behind it, measured), which the throwaway save has
// not researched. Put it back at the end (every suite that borrows a tech does this -- dev/fluid_line_e2e.js
// is the other one): leaving it on would move which tier
// every other suite's picker can reach.
const techState = () => lua(`local t = game.forces.player.technologies["circuit-network"]
  rcon.print(t and tostring(t.researched) or "absent")`);
const setTech = (on) => lua(`local t = game.forces.player.technologies["circuit-network"]
  if t then t.researched = ${on ? "true" : "false"} end
  rcon.print("ok")`);
const wasOn = /^true$/.test(techState());
if (!wasOn) setTech(true);
// 落回那一条还要钉住**用哪台炉子**：进料要几行是流量算出来的，而流量是机器的合成速度乘出来的 —— 同一句
// "iron-plate × 128"，能拿到电炉的世界要 3 行进料，只能拿到烧煤炉的世界要 2 行，于是这条断言从前测的是
// "跑在它前面那套套件留下了哪些科技"。科技照旧借了还回去，请求里点名要炉子。
// 借的是**配方那一格**而不是科技：这台安装上开钢炉的科技叫 `advanced-material-processing`，而
// `technologies["steel-furnace"]` 根本不存在（实测 `absent`），所以从前那一句"把科技研究了"一直是空操作 ——
// 那三条点名钢炉的断言于是量的是**被静默换成的石炉**。0.82.0 起点名的机器不再被背着换（按名拒），
// 空操作就藏不住了：必须真把这一格开放，那三发才钉得住它们说的那件事。
const furnaceWasOn = /^true$/.test(lua(`local r = game.forces.player.recipes["steel-furnace"]
  rcon.print(r and tostring(r.enabled) or "absent")`));
lua(`local f = game.forces.player
local r = f.recipes["steel-furnace"]
if r then r.enabled = true end
local t = f.technologies["steel-processing"]
if t then t.researched = true end
rcon.print("ok")`);

const RECIPE = "electronic-circuit";
// 带箱子的四种排法删掉之后，"箱子线头 vs 裸带线头"这一对照没有了 —— 现在只有一种线头，而那一格是
// 按名拒的。所以这里钉两件事：不表态就得到裸带线头（并且一只箱子都没有），点名要箱子线头就被拒并且
// 说得出为什么。从前那几条"比箱子少几只、别的都没变"的断言，它的凭据（一张有箱子的卡）已经不存在的
// 情况下才有意义 —— 留着就是让门禁去比一个不会出现的形状。
const beltHead = call("card_example", { recipe: RECIPE, machines: 3 });
const chestHead = call("card_example", { recipe: RECIPE, machines: 3, heads: "chest" });
check("不表态就落在裸带线头上，并且这只卡一只箱子都没有",
  beltHead.ok && beltHead.data.head.kind === "belt" && (beltHead.data.parts || {}).chests === 0
  && beltHead.data.style === "stacked",
  JSON.stringify([beltHead.code, beltHead.msg, (beltHead.data || {}).style,
    ((beltHead.data || {}).head || {}).kind, ((beltHead.data || {}).parts || {}).chests]).slice(0, 220));
check("点名要箱子线头是按名拒，不是悄悄给一条裸带",
  chestHead.ok === false && chestHead.code === "CHEST_HEAD_REMOVED"
  && String(chestHead.msg || "").indexOf("stacked") >= 0,
  JSON.stringify([chestHead.code, String(chestHead.msg || "").slice(0, 90)]));
check("牌的两件（发射器 + 面板）在零件表上，替掉了箱子该在的位置",
  beltHead.ok && (beltHead.data.parts || {}).others >= 2,
  JSON.stringify((beltHead.data || {}).parts));

const hd = (beltHead.data || {}).head || {};
check("the answer says which head this is, and its sign is ONE part", hd.kind === "belt"
  && !!(hd.sign || {}).panel && (hd.sign || {}).panel.entity === (hd.sign || {}).box.entity,
  JSON.stringify(hd).slice(0, 300));
const ents = (beltHead.data || {}).entities || [];
const at = (w) => (((hd.sign || {})[w] || {}).entity || 0) - 1;
// 线头现在是一排图标牌（他 2026-10-13 第 1 条）：中间那块画带子、左右画各自的料。
// 一块牌只画一个图标（这台构建量的），所以这里按"一排"来数：`boards` 是这一排的件，
// `beltBoard` 是中间那块（它带着整排的股道清单，也是"挨着带子那一格"该成立的那一块）。
const boards = Object.values(ents).filter((e) => String(e.name || "") === "display-panel");
const beltBoard = boards.find((e) => !!(e.sign_lanes || []).length) || {};
const panel = ents[at("panel")] || beltBoard;
// 0.93.0 的第 3 条（他亲手铺完提的）：线头**只有一块显示面板**，没有组合器、没有电线。这一条钉的
// 就是"地上真的没有那两样了"—— 一张卡里的组合器只有两种来源：线头那一对（去掉了）与总线控制带
// （这一发没带总线），所以这里数到 0 才是对的。
check("那块牌是一块显示面板，而这张卡上再无组合器",
  /panel/.test(panel.name || "")
  && !ents.some((e) => /combinator|emitter/.test(String(e.name || ""))),
  JSON.stringify([panel.name, ents.filter((e) => /combinator/.test(String(e.name || ""))).length]));
const lanesOf = (list) => asArr(list).map((x) => Number(x.count !== undefined ? x.count : x.lane));
// 号一律 1..N 这一条从前是成立的，现在成品借走某一行的远股（那一行的 2*(行-1)+1），料就走到那一行的
// 近股 —— 于是 3 件料可以报成 2、4、3。号还是引擎自己的号，只是不再连着。所以这里钉的是**这件事实**：
// 一件料一个号、不重号、每个号落在 1..2×行数 里，而**面板身上的清单与答案抄的是同一套号**（两块牌不许各记一套）。
const said = asArr(beltBoard.sign_lanes);
const rowsLaid = Math.max(1, Math.ceil(Math.max(...lanesOf(said)) / 2));
check("面板自己带着那份股道清单：一种料一条、号不重、号落在实际铺出的行数里",
  said.length >= 1
  && said.every((sg) => sg.item && Number.isInteger(Number(sg.lane)) && Number(sg.lane) >= 1)
  && new Set(lanesOf(said)).size === said.length
  && lanesOf(said).every((n) => n <= 2 * rowsLaid),
  JSON.stringify([beltBoard.sign_lanes, boards.length]));
check("...而答案里那份清单就是面板身上这一份，不是第二意见",
  asArr(hd.lanes).length === said.length
  && asArr(hd.lanes).every((l, i) => l.item === said[i].item && Number(l.lane) === Number(said[i].lane)),
  JSON.stringify([hd.lanes, said]));
// 他说"显示器要放在挨着传送带的地方"。这一条钉的就是那一格：头那块牌所在的列上，紧挨着它的那一格
// （往带子那一侧）是一根带子 —— 不是隔了三行的空地。尾那块在 `two-row` 那一档确实挨不到（共用行两侧
// 都是臂行），所以这一条只管头。
const pcell = (beltBoard.position || panel.position || {});
const beltsNear = ents.filter((e) => /^(\w+-)?transport-belt$/.test(String(e.name || ""))
  || /belt/.test(String(e.name || "")));
const adjacent = beltsNear.some((b) => Math.abs((b.position || {}).x - pcell.x) < 0.6
  && Math.abs(Math.abs((b.position || {}).y - pcell.y) - 1) < 0.6);
check("...而且这块牌就站在那条带子旁边一格", adjacent,
  JSON.stringify([pcell, beltsNear.slice(0, 3).map((b) => [b.name, b.position])]));
check("the sign says what it says in one readable line",
  typeof hd.manifest === "string" && lanesOf(hd.lanes).every((n) => new RegExp("lane " + n + "\\b").test(hd.manifest)),
  JSON.stringify(hd.manifest));
// 从前这一条钉的是"卡里带着从盒子到面板的那根线"。0.93.0 起线头不铺盒子、不接线，所以钉的是**反面**：
// 这张卡的电线清单是空的。留着这根线反而说明形状里还藏着组合器（那就是他要撤掉的东西没撤干净）。
check("这张卡不带任何电线（线头只剩一块面板）",
  asArr(beltHead.data && beltHead.data.wires).length === 0,
  JSON.stringify(beltHead.data && beltHead.data.wires));
const lint = call("card_check", { card: beltHead.data });
check("a belt head lints clean（那块面板站的格子不与自己的带子或机器重叠）",
  lint.ok && lint.data.ok === true,
  lint.ok ? JSON.stringify(asArr(lint.data.errors).map((e) => e.code)) : `${lint.code} ${lint.msg}`);
check("the join tile the player has to reach is a belt",
  !!(hd.sign || {}).join && /transport-belt/.test((ents[hd.sign.join.entity - 1] || {}).name || ""),
  JSON.stringify(hd.sign && hd.sign.join));
check("...and the lane order is said out loud, since 1 and 2 are two halves of ONE belt",
  typeof hd.lane_order === "string" && /half/.test(hd.lane_order), JSON.stringify(hd.lane_order));

// The bench must refuse, not measure zero —— 但"零箱子的裸带"不再属于那一类：台架现在按牌上点的名，在每根
// 进料带的最西一格把料插进对应那一股。这里只问它接不接受这张卡；量到东西那一句在 dev/belt_line_produces.js。
const lab = call("card_lab", { card: beltHead.data, seconds: 10 });
check("the bench takes a chest-free head and feeds it by half-lane instead of refusing it",
  lab.ok === true, `${lab.code} ${lab.msg}`);
call("lab_stop", {});

// 落到地面那一段走玩家真正那扇门：压一页（同一批参数，只是把料从手写 plan 交给它）铺成虚影，
// 然后看那块牌有没有跟着下来、撤销有没有把整个头带走。从前这里绕了 card_freeze + card_place 两道，
// 而卡片存放那套功能已经删了 —— 绕开真门去测一扇门，测到的是替身。
//
// 这里断言的是虚影身上那份字（下面 `panelWords` 从地上读回来），不断言建成之后它还亮着 ——
// 建那一步这台机器上做不了（脚本造的虚影 `revive()` 回 nil），留给玩家按一次。
// 压之前先把这一片地扫一遍。2026-10-14 我在同一组坐标连压了三发做量测、没清场，下一趟这套件就数到
// 13 块牌（它扫的正是这一页的包围盒，而残留就在这盒里），两条本来绿的门红了 —— 报错看着像 mod 少写，
// 其实是我上一趟留的垃圾。门禁用固定坐标，就不能假设地上是干净的。
const swept = lua(`local s = game.surfaces["nauvis"]
local n = 0
for _, e in ipairs(s.find_entities_filtered({ area = { { 100, 100 }, { 200, 200 } } })) do
  e.destroy() n = n + 1
end
rcon.print("swept " .. n)`);
if (Number(/swept (\d+)/.exec(String(swept))?.[1] || 0) > 0) {
  console.log("  (压之前扫掉 " + String(swept).match(/swept (\d+)/)[1] + " 件上一趟的残留)");
}
const press = call("helmod_ghosts", { into: "ground", heads: "belt", surface: "nauvis",
  origin: { x: 120, y: 120 }, width: 40,
  plan: [{ name: "assembling-machine-3", count: 3, recipe: RECIPE }] });
const pd = press.data || {};
check("裸带线头压到地面上：铺出的是带子加牌子的虚影，不是一个箱子头",
  press.ok === true && (pd.ghosts || 0) > 10 && asArr(pd.lanes).some((l) => l.head === "belt"),
  JSON.stringify([press.code, pd.ghosts, asArr(pd.lanes).map((l) => [l.shape, l.head, l.chests])]).slice(0, 260));
// 地上这三扇扫描都**只扫这一页占的那块地**（`answer.area` 就是这一发铺出去的包围盒）。
// 从前它们扫整个 nauvis：台面上常有别的套件留下的虚影（跑一趟能数到 60 多个），于是"这块牌带着字"
// 会读成"少一行"—— 那是隔壁那页的旧虚影，不是这一页没写。玩家看的是自己刚压的那一块，门禁也该看那一块。
const pressArea = (pd.area || {});
const AREA = `area = { { ${pressArea.x1 ?? 100}, ${pressArea.y1 ?? 100} }, { ${pressArea.x2 ?? 170}, ${pressArea.y2 ?? 170} } }`;
const ghostKinds = lua(`local s = game.surfaces["nauvis"]
local seen = {}
for _, e in ipairs(s.find_entities_filtered({ ${AREA}, type = "entity-ghost", force = "player" })) do
  seen[e.ghost_name] = (seen[e.ghost_name] or 0) + 1
end
local out = {}
for _, n in ipairs({ "display-panel", "decider-combinator" }) do
  out[#out + 1] = n .. "=" .. tostring(seen[n] or 0)
end
rcon.print(table.concat(out, " "))`);
check("那块牌真的下来了：虚影里有显示面板，而组合器一个都不该有（线头去电路那一手）",
  /display-panel=[1-9]/.test(String(ghostKinds)) && /decider-combinator=0/.test(String(ghostKinds)),
  ghostKinds);
// 2026-10-14 他铺完提的：他手摆的牌有字（虚影有、建成也有），我们生成的两块都没字。
// 量过不是引擎的限制：一块牌身上 `display_panel_text` 与 `display_panel_icon` 同时写得进、同时读得回。
// 错在我们自己 —— `fill_sign` 一看到这块牌带图标就整格不写字（把"一块牌只画得下一个图标"用成了
// "只能带图标"）。所以这里从**地上**读回来，两类牌分别钉：
//   · 带头那块（带清单的）：图标与字必须**同时**在；
//   · 两侧的料图：只要求图标（按 2026-10-13 他要的那一句"中间带子、左右物品"，图例本来不带字）。
const ghostPanelSaid = lua(`local s = game.surfaces["nauvis"]
local with_text, with_icon, lanes_board = 0, 0, 0
for _, e in ipairs(s.find_entities_filtered({ ${AREA}, type = "entity-ghost", force = "player" })) do
  if e.ghost_name == "display-panel" then
    local t = e.display_panel_text
    local filled = false
    if type(t) == "string" then filled = t ~= ""
    elseif type(t) == "table" then
      for i = 2, #t do
        local el = t[i]
        if (type(el) == "string" and el ~= "") or type(el) == "table" then filled = true end
      end
    end
    if filled then with_text = with_text + 1 end
    if e.display_panel_icon then with_icon = with_icon + 1 end
    if filled and e.display_panel_icon then lanes_board = lanes_board + 1 end
  end
end
rcon.print("text=" .. with_text .. " icon=" .. with_icon .. " both=" .. lanes_board)`);
check("带清单那块牌：图标与字同时写在虚影身上（从前只写图标，玩家看到一块没字的牌）",
  /both=[1-9]/.test(String(ghostPanelSaid)) && /icon=[1-9]/.test(String(ghostPanelSaid)),
  ghostPanelSaid);

// 同一件事在**他真正粘出去的那一串**上再钉一次：蓝图 record 上牌面那三格叫 `text` / `icon` /
// `always_show`（件身上 `display_panel_*` 那三个名字在 record 里不存在）。他按的是每一行那颗「复制」，
// 所以地那一路写对了而串里没带字，他看到的还是没字 —— 两条路都得钉。
// 拿同一发计划走一次"出蓝图串"那一路（面板上每行那颗「复制」做的就是这件事）。
const bpAns = call("helmod_ghosts", { into: "string", heads: "belt", surface: "nauvis",
  origin: { x: 120, y: 160 }, width: 40,
  plan: [{ name: "assembling-machine-3", count: 3, recipe: RECIPE }] });
const bpString = String(((bpAns.data || {}).blueprint) || "");
if (!bpString) console.log("  (蓝图串那一路这一发没出串，下面这条会红：code=" + bpAns.code + ")");
const bpPanels = lua(`local item = game.create_inventory(1)
item.insert({ name = "blueprint", count = 1 })
local st = item[1]
local ok = pcall(function() return st.import_stack("${bpString}") end)
if not ok then rcon.print("导入失败") item.destroy() return end
local both, icons, texts = 0, 0, 0
for _, e in ipairs(st.get_blueprint_entities() or {}) do
  if e.name == "display-panel" then
    if e.icon then icons = icons + 1 end
    local t = e.text
    local filled = (type(t) == "string" and t ~= "") or (type(t) == "table" and #t > 1)
    if filled then texts = texts + 1 end
    if e.icon and filled then both = both + 1 end
  end
end
rcon.print("icon=" .. icons .. " text=" .. texts .. " both=" .. both)
item.destroy()`);
check("...而交出去那张蓝图的牌记录同时带着 icon 与 text（他粘的是这一串）",
  /both=[1-9]/.test(String(bpPanels)) && /text=[1-9]/.test(String(bpPanels)),
  bpPanels);

// 同一块牌的**最后一步**：他建成之后牌上还有没有字。这台机器做不了真的"虚影建成"（脚本造的虚影
// `revive()` 直接 raise），但能走引擎给的那条路：`create_entity{... , raise_built = true}` 会发
// `script_raised_built`，而那正是我们自己那个"建成补写"钩子接着的事件。所以这里把带字那两块虚影
// 原地换成实物，读回来的字必须在 —— 2026-10-14 他报"实物也没字"时，量到的正是这里：虚影 2 块有字，
// 换成实物 0 块有字（钩子那一支只还图标、整格不写字，和 `fill_sign` 是同一个错）。
// 这一发**另起一页地**（x=900）：它要把虚影拆成真件，落在主那页上就会把后面几条读回的门少数两块牌
// —— 2026-10-14 我这台就这么把两条本来绿的门弄红了，测完自己清干净才算规矩。
const builtWords = lua(`local s = game.surfaces["nauvis"]
local BOX = { { 890, 890 }, { 975, 975 } }
for _, e in ipairs(s.find_entities_filtered({ area = BOX })) do e.destroy() end
remote.call("arch", "call", "helmod_ghosts", { into = "ground", heads = "belt", surface = "nauvis",
  origin = { x = 900, y = 900 }, width = 40, plan = { { name = "assembling-machine-3", count = 3, recipe = "${RECIPE}" } } })
local tried, kept, made = 0, 0, {}
for _, e in ipairs(s.find_entities_filtered({ area = BOX, type = "entity-ghost", force = "player" })) do
  if e.ghost_name == "display-panel" then
    local t = e.display_panel_text
    local filled = (type(t) == "string" and t ~= "") or (type(t) == "table" and #t > 1)
    if filled then
      tried = tried + 1
      local p = e.position
      e.destroy()
      local real = s.create_entity({ name = "display-panel", position = p, force = "player", raise_built = true })
      if real then
        made[#made + 1] = real
        local t2 = real.display_panel_text
        if (type(t2) == "string" and t2 ~= "") or (type(t2) == "table" and #t2 > 1) then kept = kept + 1 end
      end
    end
  end
end
for _, m in ipairs(made) do if m.valid then m.destroy() end end
for _, e in ipairs(s.find_entities_filtered({ area = BOX })) do e.destroy() end
rcon.print("虚影带字 " .. tried .. " 块，建成还有字 " .. kept .. " 块")`);
check("...而他建成之后字还在（补写钩子接的是 script_raised_built 那一扇）",
  /虚影带字 [1-9]/.test(String(builtWords)) && /建成还有字 [1-9]/.test(String(builtWords)),
  builtWords);

// 共用进料行那一档的另一半：**筛选要跟着虚影一起到地上**。`dev/arm_filter_probe.js` 量过虚影吃得下
// `set_filter(1, …)`，这里钉的是真铺的那一页 —— 从地上把每只臂虚影的 `get_filter(1)` 读回来，
// 与答案自己数的那两个数（asked / carried）对，而不是信 mod 自报。带不住的那一发就是一条会吃回成品的线。
const ghostFilters = lua(`local s = game.surfaces["nauvis"]
local total, named, got = 0, 0, {}
for _, e in ipairs(s.find_entities_filtered({ ${AREA}, type = "entity-ghost", force = "player" })) do
  local gname = e.ghost_name or ""
  if string.find(gname, "inserter", 1, true) then
    total = total + 1
    local ok, f = pcall(function() local x = e.get_filter(1) return x and x.name or nil end)
    if ok and f then named = 1 + named; got[#got + 1] = f end
  end
end
table.sort(got)
rcon.print("total=" .. total .. " named=" .. named .. " " .. table.concat(got, ","))`);
const af = pd.arm_filters || {};
check("压到地面的那一页，臂的筛选写在虚影身上：答案那两个数与地上读回来的只数是同一个数",
  af.asked > 0 && af.asked === af.carried
  && new RegExp("named=" + af.asked + "\\b").test(String(ghostFilters))
  && /copper-cable|iron-plate/.test(String(ghostFilters)) && /electronic-circuit/.test(String(ghostFilters)),
  JSON.stringify([af, String(ghostFilters)]));
// 牌上的字跟着虚影一起下来，而且**只走牌面那一格**。这一判骗过我们两轮（都写在注释里、都由他亲手测出来）：
//   * 2026-10-12 "显示器没有任何内容" —— 那时写的是 `control_behavior.messages`，画在牌上的不是它；
//   * 2026-10-13 "虚影和实物都没有字" —— 那一轮 `display_panel_text` 也写了、也读得回（这一格就是绿的），
//     但同一手还顺手给牌建了一个 control behavior，而牌上有判定盒内容时**牌面画的就是电路那一路**
//     （引擎 changelog 2.0 那句 "copying display panel would copy icon and text regardless of control
//     behavior being active"）—— 我们那些牌不连线，于是画出来的是空。
// 所以这里两样都数：牌面那一格有字（`panelWords`），并且这块牌身上**没有** control behavior（`withcb`）。
// 不信 mod 自报的那两个数，从地上读。
// 读的是**图标**那一格（一块牌一个图标），不是文字：文字那一格在 2026-10-13 那一条之后只留给
// 并管口那种"×N"的说明牌。带子那一块牌认得出是因为它的图标名 = 这条线用的那一档带子。
const panelWords = lua(`local s = game.surfaces["nauvis"]
local out, n, withcb = {}, 0, 0
for _, e in ipairs(s.find_entities_filtered({ ${AREA}, type = "entity-ghost", force = "player" })) do
  if e.ghost_name == "display-panel" then
    n = n + 1
    local okc, cb = pcall(function() return e:get_control_behavior() end)
    if okc and cb ~= nil then withcb = withcb + 1 end
    local ok, i = pcall(function() return e.display_panel_icon end)
    local okw, w = pcall(function() return e.display_panel_always_show end)
    out[#out + 1] = (ok and string.format("%s/%s/%s", tostring(i and i.type or "?"),
      tostring(i and i.name or "?"), tostring(okw and w)) or ("RAISES " .. tostring(i)))
  end
end
rcon.print(n .. ";" .. withcb .. "\\n" .. table.concat(out, "\\n"))`);
// 每一块牌单独一行，**不要**用 " | " 拼成一串：`dev/lua.js` 在回话尾巴上还会带一行 `OK`，拼成一条时
// 那行 `OK` 就粘在**最后一块牌**的 JSON 后面，JSON.parse 抛错、这一块的行整块消失 —— 数出来永远是
// "尾牌少一行"，看着像 mod 少写了一行字，其实是门禁自己把最后一行读丢了（2026-10-13 查的就是这个假案）。
const wordsLines = String(panelWords).split("\n");
const wordsM = /^(\d+);(\d+)$/.exec(wordsLines[0] || "");
const wordPanels = wordsM ? Number(wordsM[1]) : 0;
const wordPanelsWithCb = wordsM ? Number(wordsM[2]) : -1;
const wordsBlob = wordsLines.slice(1).join("\n");
// 每一行现在是 `类型/图标名/always_show`。一排里少一块就是这一列少一项。
const groundIcons = String(wordsBlob).split("\n").map((l) => l.trim())
  .filter((l) => l && l !== "OK");
const iconNames = groundIcons.map((l) => String(l).split("/")[1] || "");
// 失败时先看这一句：每一块牌在哪一格、牌身上那一格是什么类型、多长。上面那串 JSON 只把"解析得出的行"
// 交出来，读不出来的那一块在这儿现形（2026-10-13 这一发少一行，靠这一句才分得清"没写"还是"写了读不出"）。
const panelDiag = lua(`local out = {}
for _, e in ipairs(game.surfaces["nauvis"].find_entities_filtered({ ${AREA}, type = "entity-ghost", force = "player" })) do
  if e.ghost_name == "display-panel" then
    local ok, t = pcall(function() return e.display_panel_text end)
    out[#out + 1] = string.format("%.1f,%.1f:%s/%s", e.position.x, e.position.y,
      ok and type(t) or "RAISES", ok and tostring(t == nil and 0 or (type(t) == "table" and #t or #tostring(t))) or "-")
  end
end
rcon.print(#out .. " panels :: " .. table.concat(out, " "))`);
// 牌上每一行是「名字 + 空格 + 箭头 + 股数」，序列化回来是一个嵌套数组：
//   ["",["item-name.iron-plate"]," → 2","\n",["item-name.copper-cable"]," → 4", ...]
// 名字那一格交的是 localised key —— 门禁按它认料（玩家客户端按它渲染中文），号那一格是 " 箭头 数"。
const groundWords = [];
const unreadPanels = [];
for (const blob of wordsBlob.split("\n")) {
  const line = blob.trim();
  if (!line || line === "OK") continue;
  let arr;
  try { arr = JSON.parse(line); } catch (e) { unreadPanels.push(line.slice(0, 60)); continue; }
  if (!Array.isArray(arr)) { unreadPanels.push(line.slice(0, 60)); continue; }
  for (let i = 0; i < arr.length; i++) {
    const key = Array.isArray(arr[i]) ? String(arr[i][0] || "") : "";
    const nm = /^[a-z-]+-name\.([a-z0-9_-]+)$/.exec(key);
    if (!nm) continue;
    const wm = /\s(\S+)\s*(\S+)\s*$/.exec(String(arr[i + 1] || ""));
    if (wm) groundWords.push(`${nm[1]}#${wm[1]} ${wm[2]}`);
  }
}
// 答案那份 manifest 是"这一页该写什么"的声明；地这一句是引擎手里真正带着的东西。两个数对上才算
// "字交出去了"，只对上其中一个都还是自说自话。
const wantWords = asArr(pd.lanes).flatMap((l) => [l.head_manifest, l.tail_manifest])
  .filter(Boolean)
  // 牌上那一行现在带方向箭头（→ 往机器里、← 从机器出来，2026-10-09 玩家要的那一格："这股是放什么料
  // 还是出什么料"），manifest 里同一件事写作 "... on lane 3 → feed"，两边zip的键就是 `图标 + " 箭头 股号"`。
  .flatMap((s) => [...String(s).matchAll(/([a-z0-9_-]+) on lane (\d+) (\S+) (feed|product)/g)]
    .map((m) => `${m[1]}#${m[3]} ${m[2]}`));
// 一排图标牌上的图标 = 这一页 manifest 点名的那些料（+ 中间那块带子）。号码他不认得了，
// 所以这里比的是"画的是哪几样东西"，不是"标了第几股"。
const wantIcons = wantWords.map((w) => String(w).split("#")[0]);
const beltName = String(((pd.lanes || [])[0] || {}).belt || (pd.belt || "") || "transport-belt");
check("...而那一排牌自己带着图：虚影身上读出的图标就是答案 manifest 点名的那些料（加中间那块带子）",
  wordPanels >= 3 && wantIcons.length > 0 && groundIcons.length >= 3
    && wantIcons.every((n) => iconNames.indexOf(n) >= 0)
    && iconNames.some((n) => /belt/.test(n)),
  JSON.stringify([iconNames, wantIcons, beltName, String(panelDiag).slice(0, 120)]).slice(0, 500));
check("...而这块牌身上没有 control behavior（牌面画的就是这一格，判定盒一上来就把它抢走）",
  wordPanels >= 2 && wordPanelsWithCb === 0,
  JSON.stringify([wordPanels, wordPanelsWithCb]));
check("...而答案数的那几个数与地上读到的是同一批牌（铺了几块就写了几块，少摆的要说明）",
  (pd.signs || {}).asked === wordPanels && (pd.signs || {}).carried === (pd.signs || {}).asked
    && (pd.signs || {}).carried > 0
    // 每一块都画得出一个图标、并且是"总是显示"那一档。图标 `type` 那一格在虚影身上回读为空
    // （引擎把它归一化成只留 name，量的那一轮在 `panelWords` 上面），所以这里只比 name。
    && groundIcons.length === wordPanels
    && groundIcons.every((l) => { const n = String(l).split("/")[1]; return !!n && n !== "?"; })
    && groundIcons.some((l) => /belt/.test(String(l).split("/")[1] || ""))
    && groundIcons.every((l) => String(l).split("/")[2] === "true"),
  JSON.stringify([pd.signs, wordPanels, groundIcons]).slice(0, 300));
// 建成那一步：脚本造出来的虚影在这一台构建上**复活不了**（`revive()` 对 `entity-ghost` 一律 "calling
// 'revive' on bad self"，而 `on_built_entity` 也不许脚本 raise —— 都量在这一轮），所以"虚影的字跟不跟着
// 实物走"永远只能由玩家点一次来答。我们能测的是**那张保险**：把虚影换成一块实物、用
// `create_entity{raise_built = true}` 让引擎自己发一次"建成"事件，看钩子有没有从本次铺设记录里把字补回
// 牌面。引擎自己带得住的话这一钩什么都不做（牌面已有字就不动），所以两种结果都不会写坏。
const builtNet = lua(`local s = game.surfaces["nauvis"]
local victim
for _, e in ipairs(s.find_entities_filtered({ ${AREA}, type = "entity-ghost", force = "player" })) do
  if e.ghost_name == "display-panel" and not victim then victim = e end
end
if not victim then rcon.print("NO PANEL GHOST") return end
local x, y = victim.position.x, victim.position.y
victim.destroy()
-- 一排图标牌读的是 icon 那一格（文字格空是设计如此，不是没写上）。
local function face(e)
  local ok, i = pcall(function() return e.display_panel_icon end)
  if not ok or type(i) ~= "table" then return "?" end
  return tostring(i.name or "?")
end
-- 先落一块**不发事件**的实物：读回来是空的（脚本直接 create 的件，没有虚影可继承），它只是下一步的对照。
local plain = s.create_entity { name = "display-panel", position = { x = x, y = y }, force = "player" }
local okp = plain ~= nil and plain.valid
local plainFace = okp and face(plain) or "?"
if plain and plain.valid then plain.destroy() end
-- 同一格再来一次，这回让引擎自己发"建成"事件 —— 钩子就在这一刻跑。
local real = s.create_entity { name = "display-panel", position = { x = x, y = y }, force = "player",
  raise_built = true }
if not real then rcon.print("CANNOT PLACE REAL PANEL") return end
local raisedFace = face(real)
local okc, cb = pcall(function() return real:get_control_behavior() end)
local r = string.format("at %.1f,%.1f plain=%s raised=%s cb=%s", x, y, plainFace, raisedFace,
  tostring(okc and cb ~= nil))
real.destroy()
rcon.print(r)`);
check("...而建成那一刻确实有补写：raise_built 让引擎发一次「建成」，空牌面又被写回了图标",
  /plain=\? raised=(?!\?)/.test(String(builtNet)) && /cb=false/.test(String(builtNet)),
  String(builtNet).slice(0, 260));
// 蓝图那扇门同理：`control_behavior.parameters` 在 record 上，而这一路的 `carried` 是**引擎回读**出来的
// （`get_blueprint_entities`），不是铺的人自报。玩家粘的那一份就是它。
const bpPress = call("helmod_ghosts", { into: "string", heads: "belt", surface: "nauvis",
  origin: { x: 300, y: 300 }, width: 40,
  plan: [{ name: "assembling-machine-3", count: 3, recipe: RECIPE }] });
const bpd = bpPress.data || {};
check("蓝图那一页也带着牌的字：要的块数与引擎回读出字的块数是同一个数",
  bpPress.ok === true && (bpd.signs || {}).asked >= 2 && (bpd.signs || {}).carried === (bpd.signs || {}).asked
    && (bpd.bytes || 0) > 0,
  JSON.stringify([bpPress.code, bpd.signs, bpd.bytes, bpd.held]).slice(0, 240));
// 连线只有这一路带得住（地那一路的虚影没有脚本连线的方法）。这里不信 `wires.carried` 那个自报数：
// 把这一页交出来的蓝图文本**重新导入**一次，按两端去重数出引擎留下的线 —— 玩家粘的就是这份文本。
const bpText = String(bpd.blueprint || "");
const bpLines = lua(`local inv = game.create_inventory(1)
inv.insert { name = "blueprint", count = 1 }
local st = inv[1]
local ok, err = pcall(function() return st.import_stack([[${bpText}]]) end)
if not ok then rcon.print("IMPORT-RAISES " .. tostring(err):sub(1, 120)) inv.destroy() return end
local back = st.get_blueprint_entities()
local seen, out, txt = {}, {}, 0
for _, e in ipairs(back or {}) do
  -- 引擎回读里的牌：字要落在 'text' 那一格（record 上没有 display_panel_text 这个名字，写进去就丢）。
  if e.name == "display-panel" then
    -- 一排图标牌：回读里带得住的是 icon 那一格（一块一个）；文字那一格只有并管口那种说明牌才有。
    local t = e.text
    local ic = e.icon
    if (type(t) == "string" and t ~= "") or (type(t) == "table" and #t > 1)
      or (type(ic) == "table" and tostring(ic.name or "") ~= "") then txt = txt + 1 end
  end
  for _, w in ipairs(e.wires or {}) do
    local fwd = table.concat(w, "-")
    local rev = table.concat({ w[3], w[4], w[1], w[2] }, "-")
    if not seen[fwd] and not seen[rev] then
      seen[fwd] = true
      out[#out + 1] = fwd
    end
  end
end
rcon.print(#out .. ";" .. table.concat(out, ",") .. ";" .. #(back or {}) .. ";" .. txt)
inv.destroy()`);
// `dev/lua.js` closes its reply with an `OK` line, so the pattern is not anchored.
const linesM = /(\d+);([^;]*);(\d+);(\d+)/.exec(String(bpLines));
check("...而那张蓝图导出后再没有线：重导一次引擎数得出 0 条，答案自己也不报带过线",
  !!linesM && Number(linesM[1]) === 0 && ((bpd.wires || {}).asked || 0) === 0,
  JSON.stringify([bpLines, bpd.wires]).slice(0, 260));
// 蓝图那一扇门的字：不信自报的 `signs.carried`，把交出去的文本**重导一次**数引擎留下的 `text`。
// 这一格是引擎自己的字段（玩家手打的字在 record 里也叫 `text`），粘下去的虚影与建成的实物都由它带上。
check("...而那张蓝图重导一次，引擎回读的 `text` 就是答案数出带住的那几块牌",
  !!linesM && Number(linesM[4]) === ((bpd.signs || {}).carried || -1) && Number(linesM[4]) >= 2,
  JSON.stringify([bpLines && String(bpLines).slice(-20), bpd.signs]).slice(0, 240));
// 地这一扇门不许假称连了线。从前这里认的是 `sign_note` 里那句"连线这一路带不住" —— 那句话讲的是
// 牌旁边那只组合器，而组合器 0.93.0 就删掉了，于是一句"代码在说一件没人做的事"被钉成了门禁。
// 现在钉的是实质：这一发没有 `wires` 这一格，note 里也不许出现"线带住了"那种话。
check("...而铺到地上的那一页不假称连了线：地那一路没有 wires 这一格，说法里也不提线",
  (pd.wires === undefined || pd.wires === null) && !/wires|连线/.test(String(pd.sign_note))
    && /牌面/.test(String(pd.sign_note)),
  JSON.stringify([pd.wires, String(pd.sign_note).slice(-90)]).slice(0, 260));
const un = call("place_undo", { count: 1 });
check("一次撤回把这整个头从地上带走", un.ok === true && ((un.data || {}).undone || 0) >= 1,
  JSON.stringify(un.ok ? un.data : un.code).slice(0, 200));

// 点名要一档不存在的排法，是按名拒并把还在的交出来 —— 从前这一格是"点名要一种画不出带子的排法"，
// 而那几种排法整个删了，所以"画不出带子的形状"这一类没有了对象。
const wrongShape = call("card_example", { recipe: RECIPE, machines: 3, style: "row-chest", heads: "belt" });
check("a shape this install no longer has is refused by name, with the list of what is not",
  wrongShape.ok === false && wrongShape.code === "UNKNOWN_STYLE"
  && asArr((wrongShape.data || wrongShape.detail || {}).known || wrongShape.known).length >= 2,
  JSON.stringify([wrongShape.code, wrongShape.msg,
    (wrongShape.data || wrongShape.detail || {}).known || wrongShape.known]).slice(0, 220));
const wrongType = call("card_example", { recipe: RECIPE, machines: 3, panel: "steel-chest" });
check("a panel name that is not a panel is replaced with the reason written beside it",
  wrongType.ok === true && /its type is/.test(((wrongType.data.components_how || {}).panel) || ""),
  wrongType.ok ? JSON.stringify(wrongType.data.components_how.panel) : `${wrongType.code} ${wrongType.msg}`);
if (!wasOn) setTech(false);
// 放不出面板时线照铺，但要说清牌没放上去：牌是说明，不是结构。从前这一格是"整个头按名拒"，那等于
// 让一件文档的缺失升级成整条链的拒绝。反过来，点名要某一格牌而拿不到，仍然是拒。
const noSign = call("card_example", { recipe: RECIPE, machines: 3, heads: "belt" });
check("拿不出面板的线仍然铺得出，并且答案说牌没放",
  noSign.ok === true && (noSign.data.head || {}).kind === "belt"
  && !!(noSign.data.head || {}).sign_missing && !(noSign.data.head || {}).sign
  && (noSign.data.parts || {}).chests === 0,
  JSON.stringify([noSign.code, noSign.msg, noSign.data && noSign.data.head,
    noSign.data && noSign.data.parts]).slice(0, 240));
const namedSign = call("card_example", { recipe: RECIPE, machines: 3, heads: "belt", panel: "display-panel" });
check("但点名要那一格牌而这一发放不出时，还是按名拒",
  namedSign.ok === false && namedSign.code === "HEAD_SIGN_UNAVAILABLE",
  `${namedSign.code} ${namedSign.msg}`);
// 点名 `emitter` 的人要听见一句明确的话，而不是被静默忽略：线头这一档从 0.93.0 起不铺组合器了。
const namedBox = call("card_example", { recipe: RECIPE, machines: 3, heads: "belt", emitter: "emitter" });
check("点名要发射器盒子时按名拒，说的是这一档只剩一块面板、要点就点 panel",
  namedBox.ok === false && namedBox.code === "HEAD_EMITTER_RETIRED",
  `${namedBox.code} ${namedBox.msg}`);
if (!wasOn) setTech(true);

// 线头进阶梯：裸带那一档不再是"点名才用得到的新形状"，它是裸带线头的第一个候选。这四条各钉一件事：
// 不表态就落在零箱子那一档；玩家点名的形状永远不被换；没要裸带的世界一个数字都没变；而零箱子那一档
// 铺不出来时，落回的是"喂得齐料"的那张，并且换形这件事留在答案里（不是只写进服务器日志）。
const auto3 = call("card_example", { recipe: "advanced-circuit", machines: 4, heads: "belt" });
check("a bare head lands on the chest-free shape without being told its name",
  auto3.ok && auto3.data.style === "stacked" && auto3.data.parts.chests === 0
    && auto3.data.head.kind === "belt" && !auto3.data.style_overridden,
  JSON.stringify([auto3.code, auto3.data.style, (auto3.data.parts || {}).chests,
    (auto3.data.head || {}).kind]));
const pinned = call("card_example", { recipe: "advanced-circuit", machines: 4, heads: "belt",
  style: "two-row" });
check("...while a shape the caller named is still never swapped（双排也是零箱子）",
  pinned.ok && pinned.data.style === "two-row" && !pinned.data.style_overridden
    && pinned.data.parts.chests === 0,
  JSON.stringify([pinned.data.style, pinned.data.parts.chests, pinned.data.style_overridden]));
// 带行数改由流量数出来之后（0.62 那一串）+ 一台机器够着的股数修正成"它旁边几只臂 × 2 股"（这一版），
// "最慢那档带子 + 128 台铁矿"落到了另一句话上：一个面叠不起 3 行，而**两种排法都是一个面 2 行**，所以
// 换形救不了它 —— 答案是按名拒，并把"要几条"与"一个面叠得起几条"两个数交出来。
// 这里钉两半：点名带子时拒在哪一个数上；把带子交回给模（不点名）时，它升级到装得下的那一档、铺出同一条
// 线，而且仍然一只箱子也不要。数字都从答案里读，不钉死在句子里。
const slow = call("card_example", { recipe: "iron-plate", machines: 128, heads: "belt",
  belt: "transport-belt", furnace: "steel-furnace" });
check("a pinned slow belt whose rows no face can stack is refused by name, with both numbers beside it",
  slow.ok === false && slow.code === "LINES_BEYOND_SHAPE"
    && (slow.detail || {}).feed_rows > (slow.detail || {}).rows_per_face
    && (slow.detail || {}).product_rows > (slow.detail || {}).rows_per_face
    && asArr((slow.detail || {}).arm_reach_tiers).length >= 1,
  JSON.stringify([slow.code, slow.detail]).slice(0, 220));
const unpinned = call("card_example", { recipe: "iron-plate", machines: 128, heads: "belt",
  furnace: "steel-furnace" });
const upPlan = (unpinned.data || {}).lane_plan || {};
const upDetail = unpinned.detail || {};
// 这一发从前只钉"把带子交回给模，就铺得出来"。运力律（一根成品带只走一面那一股）之后，128 台这一发
// 在**这一台安装上**铺不出来了：要几条成品带是流量除出来的，跟带子快慢同向，可"一个面叠得起几条"是
// min(臂的 reach 档数, 机器深) —— 换到最快那一档也还是超过它。所以两种结局都算数（同 dev/layout_ledger.js
// 那条"行上限"的改法），而按名拒那一支必须把**它试过哪几档带子**说出来：一句"换更快的带子"对着
// 已经从头试到尾的 ladder 说，就是让玩家重跑一遍我们跑过的步。
check("...而把带子交回给模：要么升级到装得下的那一档铺出来，要么说出试过哪几档再按名拒",
  (unpinned.ok === true && (unpinned.data.parts || {}).chests === 0
      && upPlan.feed_rows_laid <= upPlan.rows_per_face
      && upPlan.product_rows_laid <= upPlan.rows_per_face
      && ((unpinned.data.belt_choice || {}).chosen || "") !== "transport-belt"
      && asArr((unpinned.data.belt_choice || {}).tried).indexOf("transport-belt") === 0)
    || (unpinned.ok === false && unpinned.code === "LINES_BEYOND_SHAPE"
      && asArr(upDetail.belts_tried).length >= 2 && upDetail.belt_adequate === false
      && upDetail.product_rows > upDetail.rows_per_face
      && /从慢到快试过一遍/.test(String(unpinned.msg))
      && !/或者换更快的带子/.test(String(unpinned.msg))),
  JSON.stringify([unpinned.code, upDetail, String(unpinned.msg).slice(-90)]).slice(0, 320));
check("...而点名要一种带子时，模不会背着把它换掉：同一发点名黄带就是黄带",
  slow.ok === false && slow.code === "LINES_BEYOND_SHAPE"
    && (call("card_example", { recipe: "iron-plate", machines: 8, heads: "belt",
      belt: "fast-transport-belt", furnace: "steel-furnace" }).data || {}).components.belt
      === "fast-transport-belt",
  JSON.stringify([slow.code, (unpinned.data || {}).belt_choice]));

setTech(wasOn);
lua(`local f = game.forces.player
local r = f.recipes["steel-furnace"]
if r then r.enabled = ${furnaceWasOn ? "true" : "false"} end
rcon.print("returned")`);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
