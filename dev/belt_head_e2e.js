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

// On the ground: the wire is drawn with the ghosts, and the undo takes the whole head back.
const fz = call("card_freeze", { card: beltHead.data, name: "belt-head-e2e", allow_unmeasured: true });
check("a belt head freezes", fz.ok, `${fz.code} ${fz.msg}`);
if (fz.ok) {
  const pl = call("card_place", { name: "belt-head-e2e", surface: "nauvis" });
  const pd = (pl.data || {});
  check("placing it draws the sign's wire on the ghosts", pl.ok && (pd.wires || {}).drawn >= 1,
    pl.ok ? JSON.stringify(pd.wires) : `${pl.code} ${pl.msg}`);
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
  check("the sign itself arrived as ghosts, panel and box both",
    /display-panel=[1-9]/.test(ghostKinds) && /decider-combinator=[1-9]/.test(ghostKinds), ghostKinds);
  const un = call("place_undo", { count: 2 });
  check("and one undo takes the head back off the ground",
    un.ok && un.data.standing_now === 0, JSON.stringify(un.ok ? un.data : un.code));
}

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
// 落回那一条要真的量得到：最慢的带子 + 64 台把这条线的带行数顶到一个面叠不起的数（3 > 2），零箱子
// 那一档就铺不出来（`LINES_BEYOND_SHAPE`）。这里断言的不是"它拒了"，是"它换到一张喂得齐料、并且把放回去
// 的箱子说出口的线"。
const slow = call("card_example", { recipe: "iron-plate", machines: 64, heads: "belt",
  belt: "transport-belt" });
check("when the chest-free shape cannot be laid, the ladder moves to one that feeds everything",
  slow.ok && slow.data.style !== "stacked" && asArr(slow.data.unfed).length === 0
    && !!slow.data.style_overridden && slow.data.style_overridden.asked === "stacked"
    && slow.data.parts.chests > 0,
  JSON.stringify([slow.code, slow.data.style, (slow.data.style_overridden || {}).used,
    asArr(slow.data.unfed).length, (slow.data.parts || {}).chests]));
check("...and the answer says which number did not fit, and does not hide the boxes it put back",
  slow.ok && (slow.data.lane_plan || {}).feed_rows_needed > (slow.data.lane_plan || {}).rows_per_face
    && /带/.test(String((slow.data.style_overridden || {}).because || ""))
    && (slow.data.style_overridden || {}).code === "LINES_BEYOND_SHAPE",
  JSON.stringify([(slow.data.style_overridden || {}).because,
    (slow.data.lane_plan || {}).feed_rows_needed, (slow.data.lane_plan || {}).rows_per_face,
    (slow.data.style_overridden || {}).code]));

if (fz.ok) call("card_forget", { name: "belt-head-e2e" });
setTech(wasOn);
console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
