// 排法那一格**按这条线是什么料过滤**（他 2026-10-11 亲手铺完提的第 1 条：列表与料无关，选了才发现冲突）。
//
// 这一把不问台架、不问几何，问的是"窗口那一刻递给玩家的是哪几行"：
//   * 一条纯固体的线（一件液体都不沾）只该看到 `stacked` 与 `two-row`；
//   * 一条喝水/吐液体的线只该看到 `fluid-back` 与 `fluid-through`；
//   * 叫不出类别的时候（没有玩家、没选线、helmod 没答）宁可**全列**，因为少列的那一档他看不见，
//     也就不知道自己其实可以点名 —— 这条红线写在 `styles.fits` 里，这里钉住它。
//   * 记住的那一档如果被这一格摘掉了，模要交出 `style_dropped`（窗口那一行才有话可说）；不交就是
//     背着替他换（本项目的口径：可以摘，必须说）。
//
// 类别不是这里另记的一份表：它是从**配方自己的原料与成品**读出来的（`prototypes.recipe`），
// 所以这一把同时钉"类别是从地上数的"，而不是某个文件里写死的名单。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("style_classes_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "30000" };
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 300) }; }
};
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 400)}`);
  ok ? pass++ : fail++;
};

// 1) 注册表自己说得出每一档给谁用（这一格是窗口的标签前缀，也是过滤的依据）。
const registry = call("styles_registry", {});
const rows = asArr(registry.data && registry.data.styles);
check("每一档排法都报得出它给哪几类线用（没有一个空着）",
  registry.ok && rows.length >= 4 && rows.every((r) => asArr(r.classes).length >= 1),
  JSON.stringify(rows.map((r) => [r.id, r.classes])).slice(0, 400));
const byId = {};
for (const r of rows) byId[r.id] = asArr(r.classes);
check("纯固体那一类里只有走带子的那两档，液体那一类里只有铺管子的那两档",
  JSON.stringify(Object.keys(byId).filter((k) => (byId[k] || []).includes("solid")).sort())
    === JSON.stringify(["stacked", "two-row"])
  && JSON.stringify(Object.keys(byId).filter((k) => (byId[k] || []).includes("liquid")).sort())
    === JSON.stringify(["fluid-back", "fluid-through"]),
  JSON.stringify(byId).slice(0, 400));

// 2) 一条线的类别读自配方自己：各点几条对答案（固体料线 / 全液体进料线 / 又喝水又吃件的线）。
const probe = call("recipe_classes", {
  recipes: ["electronic-circuit", "sulfur", "iron-plate", "lubricant", "plastic-bar"] });
const got = (probe.data || {}).classes || {};
check("电子件/铁板是纯固体；硫酸与润滑油喝的全是液体（纯液体）；塑料又喝水又吃件（固液混合）",
  probe.ok && got["electronic-circuit"] === "solid" && got["iron-plate"] === "solid"
    && got["sulfur"] === "liquid" && got["lubricant"] === "liquid"
    && got["plastic-bar"] === "mixed",
  JSON.stringify(got));

// 3) 窗口那一刻递给玩家的是哪几行。问的是 `gui_model`（面板每次重建走的就是这一句），入口点配方名：
//    窗口自己是从 helmod 名单里认出"他选的那条线"再数类别，而这里要证的只是**类别 → 列表**那一步，
//    所以两种入口都吃（这一档存档里未必有 helmod 计划 —— 依赖它会把这条绿变成"取决于上一套留了什么"）。
const modelFor = (recipes, style) => call("gui_model", { recipes, style });
const solidList = asArr((modelFor(["electronic-circuit"]).data || {}).styles);
check("一条纯固体的线（电子件）：排法那一格只列走带子的两档",
  JSON.stringify(solidList) === JSON.stringify(["stacked", "two-row"])
  && (modelFor(["electronic-circuit"]).data || {}).style_class === "solid",
  JSON.stringify(solidList));
const sulfurModel = modelFor(["sulfur"]);
const sulfurList = asArr((sulfurModel.data || {}).styles);
check("一条喝的全是液体的线（硫酸）：只列铺管子的两档，而它的类别是「纯液体」不是「固液混合」",
  JSON.stringify(sulfurList) === JSON.stringify(["fluid-back", "fluid-through"])
  && (sulfurModel.data || {}).style_class === "liquid",
  JSON.stringify([sulfurList, (sulfurModel.data || {}).style_class]));
const plasticModel = modelFor(["plastic-bar"]);
const plasticList = asArr((plasticModel.data || {}).styles);
check("既喝水又吃件的线（塑料）：类别是「固液混合」，列表还是铺管子那两档",
  (plasticModel.data || {}).style_class === "mixed"
  && JSON.stringify(plasticList) === JSON.stringify(["fluid-back", "fluid-through"]),
  JSON.stringify([(plasticModel.data || {}).style_class, plasticList]));
// 整页混着好几类：并列（=全列），并在标签上写清每一档给谁用 —— 少列一档是替他做决定。
const bothList = asArr((modelFor(["electronic-circuit", "sulfur"]).data || {}).styles);
check("一页里既有纯固体又有液体的线：四档都列（并置类别，不替玩家挑）",
  bothList.length >= 4, JSON.stringify(bothList));

// 4) 叫不出类别时**全列**：没有玩家、也没点线，窗口不能替他少摆一档。
const bare = call("gui_model", {});
const bareList = asArr((bare.data || {}).styles);
check("没点线时四档都还在列表里（宁可行多，不少列一档）",
  bare.ok && bareList.length >= 4, JSON.stringify(bareList));

// 5) 摘掉要说出口：递一格这一类用不了的档进来，模要交出 `style_dropped`，窗口那一行才有那句
//    「已回到自动」；不交就是背着替他换（本项目的口径：可以摘，必须说）。
const droppedModel = modelFor(["sulfur"], "two-row");
check("给一条液体的线递「双排」时，模把「这一档被摘掉了、已回到自动」交出来",
  droppedModel.ok && (droppedModel.data || {}).style_dropped === "two-row",
  JSON.stringify([(droppedModel.data || {}).style_dropped, (droppedModel.data || {}).style_class]));
const keptModel = modelFor(["sulfur"], "fluid-through");
check("而递进来得上的那一档时，什么都不摘、也不说废话",
  keptModel.ok && (keptModel.data || {}).style_dropped === undefined
  && asArr((keptModel.data || {}).styles).includes("fluid-through"),
  JSON.stringify([(keptModel.data || {}).style_dropped, (keptModel.data || {}).styles]));

// 6) **标签真的建得出来**：这一条是 0.93.0 那一发炸窗之后补的 —— `L()` 交回的是 locale 字典（一个表），
//    不是字符串，所以我第一版用 `table.concat` / `..` 把类别词并到排法词前面时，整扇窗都建不起来
//    （`gui.lua:330: invalid value (table)`），玩家那边只是"点一下没反应"。上面那几条读的都是**模**，
//    模不碰 GUI，所以它们全绿而窗是坏的：只有真建一次窗才证得了这一行字。
const built = call("gui_selftest", {});
const bd = built.data || {};
check("带上类别前缀的那几行标签，窗口真建得起来（不是只有模算得出来）",
  bd.ok === true && bd.opened === true && !asArr(bd.widgets_missing).length
  && Number(bd.printed_at_build) === 0
  // 顶部下拉删了（2026-10-14 深夜他第 5 条），标签现在长在每行那颗钮上 —— 所以这里钉的是
  // "每一档的词都拼得出来"（走的是建钮那条同一份 `style_pick_lists`），不再数下拉的行数。
  && Number(bd.auto_refresh && bd.auto_refresh.style_words) >= rows.length + 1,
  JSON.stringify([bd.ok, bd.opened, (bd.widgets_missing || []).slice(0, 3),
    bd.printed_at_build, (bd.printed || [])[0],
    (bd.auto_refresh || {}).style_words, bd.dropdowns]).slice(0, 300));

// 7) 「这一档最少几台」要在**标签**上看得见，而不是等他确认完吃一句 `STYLE_NEEDS_UNITS`。
//    依据是形状自己那份 `min_units`（双排两排要成对 = 2，其余 1 台就成立）—— 模只是把它抄给窗口，
//    所以这里钉的是"抄到了、并且只有该说的那一档说了"。
const unitsOf = {};
for (const r of rows) unitsOf[r.id] = Number(r.units);
check("每一档都报得出最少几台（双排 2 台，其余 1 台）",
  rows.length >= 4 && Object.values(unitsOf).every((n) => n >= 1)
  && unitsOf["two-row"] === 2
  && ["stacked", "fluid-back", "fluid-through"].every((k) => unitsOf[k] === 1),
  JSON.stringify(unitsOf).slice(0, 300));
const withUnits = call("gui_model", {});
check("而窗口那一格拿得到这份数（标签后面那句「≥2 台起」就是从这里拼的）",
  withUnits.ok && Number((withUnits.data || {}).style_units
    && (withUnits.data || {}).style_units["two-row"]) === 2,
  JSON.stringify((withUnits.data || {}).style_units).slice(0, 300));

// 每一档排法在**窗口里靠那张图被认出来**（2026-10-14 深夜他第 5 条要"图标选项"）。
// 服务器侧量不到图有没有真画出来（这台构建既没有 `game.get_sprite`，runtime 也读不到
// `prototypes.sprites`，两条都试过），所以这里钉的是能钉的那一半：**图的注册与文件必须在**——
// 加了形状忘了配图，以前只会让他看到一颗退回文字的钮（没人报警），现在这里直接红。
const fs = require("fs");
const dataSrc = fs.readFileSync("src/architect/data.lua", "utf8");
const iconDir = "src/architect/graphics/icons/";
check("每一档排法都注册了一张自己的图，且文件真在（data 阶段那份名单与磁盘一一对得上）",
  rows.length >= 4 && rows.every((r) => dataSrc.includes('\"' + r.id + '\"')
    && fs.existsSync(iconDir + "style-" + r.id + "-24.png")),
  JSON.stringify(rows.map((r) => [r.id, dataSrc.includes('\"' + r.id + '\"'),
    fs.existsSync(iconDir + "style-" + r.id + "-24.png")])).slice(0, 300));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
