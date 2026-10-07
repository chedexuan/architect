// 线头去箱：一条带子直接接总线的产线，加开头那块把料道写明白的标牌。
//
// A lane's head used to be chests. They are what the bench fills (`storage.lab.rig.in_chests`), so they
// are also what every rate this mod has ever reported leans on -- and in a real factory nobody builds a
// chest at the head of a smelting row: you splice the row into the bus you already have. Helmod's own
// blueprints do the same, which is why "为啥还会有一堆箱子" arrived as a complaint about a pressed line.
//
// `heads = "belt"` is that head: no chest, no head arm, the row starts as a bare belt tail, and the cells
// the heads would have taken carry a SIGN -- one emitter box and one display panel wired together, saying
// which material rides which half-lane. Asserted from four sides, because each one breaks quietly:
//
//   * the SHAPE: the chests really are gone (compared against the same card with the chest head, not
//     against a number), and the two sign parts really are there;
//   * the SIGN: every material the recipe eats is named, with a lane number, on the box's own signal list
//     -- and the answer's `head.lanes` is read back off that list rather than off a wish;
//   * the WIRE: the card carries one, the engine draws it when the line is placed as ghosts, and the
//     undo takes it all back off the ground;
//   * the REFUSALS: a shape that has no belt to splice into, and an install that cannot place the sign,
//     are both refused BY NAME -- and the bench refuses to measure a lane it has nothing to feed
//     (`CARD_NO_PORTS`) rather than report zero as a verdict.
//
// What this file does NOT claim: that a built panel is lit. The wire is drawn on the ghosts and the
// emitter's signal list is written on the ghost box (both measured here / in the probes), but a ghost's
// circuit content is not known to survive the build -- dev/circuit_wire_e2e.js opens by recording that
// ghost WIRES are gone once the player builds them. That question is #53 and stays open.
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
// not researched. Put it back at the end, the way bus_line_e2e does: leaving it on would move which tier
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
const chestHead = call("card_example", { recipe: RECIPE, machines: 3, style: "two-feed" });
const beltHead = call("card_example", { recipe: RECIPE, machines: 3, style: "two-feed", heads: "belt" });
check("a belt head is drawn at all", beltHead.ok, `${beltHead.code} ${beltHead.msg}`);
check("...and it is the same lane otherwise", beltHead.ok && chestHead.ok
  && beltHead.data.style === chestHead.data.style
  && beltHead.data.parts.machines === chestHead.data.parts.machines
  && beltHead.data.parts.belts === chestHead.data.parts.belts,
  beltHead.ok && chestHead.ok ? JSON.stringify([chestHead.data.parts, beltHead.data.parts]) : "-");
check("the head chests really are gone (one fewer per material, and nothing else lost)",
  beltHead.ok && chestHead.ok && beltHead.data.parts.chests < chestHead.data.parts.chests
  && (chestHead.data.parts.chests - beltHead.data.parts.chests) >= 2,
  beltHead.ok && chestHead.ok ? `chest head ${chestHead.data.parts.chests} → belt head ${beltHead.data.parts.chests}` : "-");
check("...and the sign's two parts are on the bill in their place",
  beltHead.ok && beltHead.data.parts.others === chestHead.data.parts.others + 2,
  beltHead.ok ? JSON.stringify([chestHead.data.parts.others, beltHead.data.parts.others]) : "-");

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

// The bench must refuse, not measure zero.
const lab = call("card_lab", { card: beltHead.data, seconds: 10 });
check("the bench refuses a lane it has nothing to fill, by name",
  lab.ok === false && lab.code === "CARD_NO_PORTS", `${lab.code} ${lab.msg}`);

// 落到地面那一段走玩家真正那扇门：压一页（同一批参数，只是把料从手写 plan 交给它）铺成虚影，
// 然后看那块牌有没有跟着下来、撤销有没有把整个头带走。从前这里绕了 card_freeze + card_place 两道，
// 而卡片存放那套功能已经删了 —— 绕开真门去测一扇门，测到的是替身。
//
// 这里【不】断言牌的线也画到虚影上了：虚影建的实体带不带电路内容，本来就是 #53 那个没量的问题
// （dev/circuit_wire_e2e.js 记着幽灵的线建好就没了），不是这一按要证明的事。
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

// The two refusals, each one an argument away.
const wrongShape = call("card_example", { recipe: RECIPE, machines: 3, style: "row-chest", heads: "belt" });
check("a shape with no belt to splice into says so, rather than drawing a chest and renaming it",
  wrongShape.ok === false && wrongShape.code === "HEADS_NEED_BELT_STYLE",
  `${wrongShape.code} ${wrongShape.msg}`);
const wrongType = call("card_example", { recipe: RECIPE, machines: 3, style: "two-feed",
  heads: "belt", panel: "steel-chest" });
check("a panel name that is not a panel is replaced with the reason written beside it",
  wrongType.ok === true && /its type is/.test(((wrongType.data.components_how || {}).panel) || ""),
  wrongType.ok ? JSON.stringify(wrongType.data.components_how.panel) : `${wrongType.code} ${wrongType.msg}`);
if (!wasOn) setTech(false);
const noSign = call("card_example", { recipe: RECIPE, machines: 3, style: "two-feed", heads: "belt" });
check("an install that can place no sign refuses the head outright",
  noSign.ok === false && noSign.code === "HEAD_SIGN_UNAVAILABLE", `${noSign.code} ${noSign.msg}`);
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
  style: "two-feed" });
check("...while a shape the caller named is still never swapped",
  pinned.ok && pinned.data.style === "two-feed" && !pinned.data.style_overridden
    && pinned.data.parts.chests > 0,
  JSON.stringify([pinned.data.style, pinned.data.parts.chests, pinned.data.style_overridden]));
const chestAuto = call("card_example", { recipe: "advanced-circuit", machines: 4 });
check("and a caller that says nothing about the head gets the world it always got",
  chestAuto.ok && (chestAuto.data.head || {}).kind === "chest" && chestAuto.data.style !== "stacked"
    && chestAuto.data.parts.chests > 0,
  JSON.stringify([chestAuto.data.style, (chestAuto.data.head || {}).kind, chestAuto.data.parts.chests]));
// 落回那一条要真的量得到：最慢的带子 + 64 台铁矿把这条线的带行数顶到一个面叠不起的数（3 > 2），零箱子
// 那一档就铺不出来（`LINES_BEYOND_SHAPE`）。这里断言的不是"它拒了"，是"它换到一张喂得齐料、并且把放回去
// 的箱子说出口的线"。数字从答案里读，不钉死在句子里：那句话目前是按中文写的（`because` 走 locale 是 #9
// 的一部分），钉住"哪个数放不下"才是这条的门。
const slow = call("card_example", { recipe: "iron-plate", machines: 128, heads: "belt",
  belt: "transport-belt", furnace: "steel-furnace" });
check("when the chest-free shape cannot be laid, the ladder moves to one that feeds everything",
  slow.ok && slow.data.style !== "stacked" && asArr(slow.data.unfed).length === 0
    && !!slow.data.style_overridden && slow.data.style_overridden.asked === "stacked"
    && slow.data.style_overridden.code === "LINES_BEYOND_SHAPE"
    && slow.data.parts.chests > 0,
  JSON.stringify([slow.code, slow.data.style, (slow.data.style_overridden || {}).used,
    asArr(slow.data.unfed).length, (slow.data.parts || {}).chests,
    (slow.data.style_overridden || {}).code]));
const slowPlan = (slow.data || {}).lane_plan || {};
check("...and the answer says which number did not fit, and does not hide the boxes it put back",
  slow.ok && slowPlan.feed_rows_needed > slowPlan.rows_per_face
    && String((slow.data.style_overridden || {}).because || "").length > 8
    && String((slow.data.style_overridden || {}).because || "").includes(String(slowPlan.feed_rows_needed))
    && String((slow.data.style_overridden || {}).because || "").includes(String(slowPlan.rows_per_face)),
  JSON.stringify([String((slow.data.style_overridden || {}).because || "").slice(0, 90),
    slowPlan.feed_rows_needed, slowPlan.rows_per_face, (slow.data.style_overridden || {}).code]));

setTech(wasOn);
lua(`local f = game.forces.player
local t = f.technologies["steel-furnace"]
if t then t.researched = ${furnaceWasOn ? "true" : "false"} end
rcon.print("ok")`);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
