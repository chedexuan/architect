// 线头去箱：一条带子直接接总线的产线，加开头那块把料道写明白的标牌。
//
// A lane's head used to be chests. They are what the bench fills (`storage.lab.rig.in_chests`), so they
// are also what every rate this mod has ever reported leans on -- and in a real factory nobody builds a
// chest at the head of a smelting row: you splice the row into the bus you already have. Helmod's own
// blueprints do the same, which is why "为啥还会有一堆箱子" arrived as a complaint about a pressed line.
//
// `heads = "belt"` is that head, and it is the DEFAULT: no chest, no head arm, the row starts as a bare
// belt tail, and the cells the heads would have taken carry a SIGN -- one emitter box and one display
// panel wired together, saying which material rides which half-lane. Asserted from four sides, because
// each one breaks quietly:
//
//   * the SHAPE: the chests really are gone (`parts.chests === 0` on the card the default answer returns,
//     and on the two-row one), and the two sign parts really are there;
//   * the SIGN: every material the recipe eats is named, with a lane number, on the box's own signal list
//     -- and the answer's `head.lanes` is read back off that list rather than off a wish;
//   * the WIRE: the card carries one, the engine draws it when the line is placed as ghosts, and the
//     undo takes it all back off the ground;
//   * the REFUSALS: asking for the deleted chest head, and naming a panel this install cannot place, are
//     both refused BY NAME -- while an install that cannot place the sign without being asked still gets
//     its line, with the missing part said out loud (`head.sign_missing`) rather than the whole chain
//     refused for a piece of documentation.
//
// What this file does NOT claim: that a built panel is lit. The wire is drawn on the ghosts and the
// emitter's signal list is written on the ghost box (both measured here), but a ghost's circuit content
// is not known to survive the build. That question is open, and no gate here pretends otherwise.
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
const furnaceWasOn = /^true$/.test(lua(`local t = game.forces.player.technologies["steel-furnace"]
  rcon.print(t and tostring(t.researched) or "absent")`));
lua(`local f = game.forces.player
local t = f.technologies["steel-furnace"]
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
check("the answer says which head this is", hd.kind === "belt" && !!(hd.sign || {}).box
  && !!(hd.sign || {}).panel, JSON.stringify(hd).slice(0, 300));
const ents = (beltHead.data || {}).entities || [];
const at = (w) => (((hd.sign || {})[w] || {}).entity || 0) - 1;
const box = ents[at("box")] || {};
const panel = ents[at("panel")] || {};
check("the box is an emitter and the panel is a display panel",
  /combinator/.test(box.name || "") && /panel/.test(panel.name || ""),
  JSON.stringify([box.name, panel.name]));
check("the box carries one signal per material the recipe eats, numbered by lane",
  asArr(box.circuit && box.circuit.emitter).length >= 1
  && asArr(box.circuit && box.circuit.emitter).every((sg, i) => sg.count === i + 1 && sg.name),
  JSON.stringify(box.circuit && box.circuit.emitter));
check("...and the answer's lane list IS that signal list, not a second opinion",
  asArr(hd.lanes).length === asArr(box.circuit && box.circuit.emitter).length
  && asArr(hd.lanes).every((l, i) => l.item === asArr(box.circuit.emitter)[i].name && l.lane === i + 1),
  JSON.stringify(hd.lanes));
check("the sign says what it says in one readable line",
  typeof hd.manifest === "string" && /lane 1/.test(hd.manifest) && /lane 2/.test(hd.manifest),
  JSON.stringify(hd.manifest));
check("the card carries the wire from the box to the panel",
  asArr(beltHead.data && beltHead.data.wires).some((w) => w.from === at("box") + 1
    && w.to === at("panel") + 1),
  JSON.stringify(beltHead.data && beltHead.data.wires));
const lint = call("card_check", { card: beltHead.data });
check("a belt head lints clean (the box's two cells clear its own belt row)",
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
// 这里【不】断言牌的线也画到虚影上了：虚影建的实体带不带电路内容，是一个没量过的问题，不是这一按要
// 证明的事。
const press = call("helmod_ghosts", { into: "ground", heads: "belt", surface: "nauvis",
  origin: { x: 120, y: 120 }, width: 40,
  plan: [{ name: "assembling-machine-3", count: 3, recipe: RECIPE }] });
const pd = press.data || {};
check("裸带线头压到地面上：铺出的是带子加牌子的虚影，不是一个箱子头",
  press.ok === true && (pd.ghosts || 0) > 10 && asArr(pd.lanes).some((l) => l.head === "belt"),
  JSON.stringify([press.code, pd.ghosts, asArr(pd.lanes).map((l) => [l.shape, l.head, l.chests])]).slice(0, 260));
const ghostKinds = lua(`local s = game.surfaces["nauvis"]
local seen = {}
for _, e in ipairs(s.find_entities_filtered({ type = "entity-ghost", force = "player" })) do
  seen[e.ghost_name] = (seen[e.ghost_name] or 0) + 1
end
local out = {}
for _, n in ipairs({ "display-panel", "decider-combinator" }) do
  out[#out + 1] = n .. "=" .. tostring(seen[n] or 0)
end
rcon.print(table.concat(out, " "))`);
check("那块牌真的下来了：虚影里有显示面板，也有写料道的组合器",
  /display-panel=[1-9]/.test(String(ghostKinds)) && /decider-combinator=[1-9]/.test(String(ghostKinds)),
  ghostKinds);
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
check("...而把带子交回给模，同一发就铺得出来：升级到装得下的那一档，行数落回一个面叠得起的数，箱子仍然零只",
  unpinned.ok === true && (unpinned.data.parts || {}).chests === 0
    && upPlan.feed_rows_laid <= upPlan.rows_per_face
    && upPlan.product_rows_laid <= upPlan.rows_per_face
    && ((unpinned.data.belt_choice || {}).chosen || "") !== "transport-belt"
    && asArr((unpinned.data.belt_choice || {}).tried).indexOf("transport-belt") === 0,
  JSON.stringify([unpinned.code, (unpinned.data || {}).style, upPlan,
    unpinned.data && unpinned.data.belt_choice, (unpinned.data || {}).parts]).slice(0, 300));
check("...而点名要一种带子时，模不会背着把它换掉：同一发点名黄带就是黄带",
  slow.ok === false && unpinned.ok === true
    && (call("card_example", { recipe: "iron-plate", machines: 8, heads: "belt",
      belt: "fast-transport-belt", furnace: "steel-furnace" }).data || {}).components.belt
      === "fast-transport-belt",
  JSON.stringify([slow.code, (unpinned.data || {}).belt_choice]));

setTech(wasOn);
lua(`local f = game.forces.player
local t = f.technologies["steel-furnace"]
if t then t.researched = ${furnaceWasOn ? "true" : "false"} end
rcon.print("ok")`);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
