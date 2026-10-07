// Regression suite, rewritten at the 0.61.0 boundary: node dev/smoke.js
//
// 这个文件干两件事，顺序不能反：
//
//   1) **把世界设成后面每一根套件都认得的那份**。研究是"设"而不是"继承"：一个 session 里谁手工研究过
//      后面的机器，后面那根套件就会给同一个请求换一台机器，于是同一道断言两次跑出两个答案（量到的那次是
//      熔炼段从 4 台石炉变成 2 台电炉，`grid_is_vacuous` 不再成立）。撤销一台科技不会自动撤销它解锁的
//      配方，所以这里连"没有科技解锁的配方"要原样留着这条规矩也一起写死。
//   2) **只测这条链**：ping / 形状与件数 / 几何 lint / 台架 / 压线 / 撤回 / 面板自测。从前这里还有 106 条
//      测电力、区域、求解、钻头农场泵、卡片存放、提问队列、总线走廊的断言 —— 那些门在 0.61.0 被删了，
//      断言跟着删，不是放宽。
//
// 每条都断言**形状**而不是"有没有回话"：真正踩过的坑都是看着合理、内容错了的返回。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("smoke");
const { en, enLine } = require("./lines.js");

const call = (method, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
      { encoding: "utf8", maxBuffer: 512 * 1024 * 1024, env: { ...process.env, RAW: "1" } });
    return JSON.parse(out.trim());
  } catch (e) {
    return { ok: false, code: "HARNESS", msg: (e.stdout || String(e)).toString().slice(0, 160) };
  }
};

const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: { ...process.env } }).trim();
  } catch (e) { return "HARNESS"; }
};

const asArr = (v) => (Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : []));

const results = [];
const check = (name, cond, detail) => results.push({ name, pass: !!cond, detail: detail || "" });

// 结果是**跑完再打**的，所以中途崩掉会把已经拿到的读数全丢掉 —— 一份空日志读起来像"套件坏了"而不是
// "第 214 条在第 1625 行断了"。崩溃路径打同一份报告，然后把崩溃本身也算一条红。
let reported = false;
const report = (crash) => {
  if (reported) return;
  reported = true;
  const width = Math.max(0, ...results.map((x) => x.name.length));
  let failed = 0;
  for (const x of results) {
    if (!x.pass) failed++;
    console.log(`${x.pass ? "  ok " : "  FAIL"} ${x.name.padEnd(width)}  ${x.detail}`);
  }
  if (crash) {
    failed++;
    console.log(`  FAIL ${"CRASHED MID-RUN（这行之后的检查一条都没跑）".padEnd(width)}`
      + `  ${crash.message || String(crash)}`);
  }
  console.log(`\n${results.length + (crash ? 1 : 0) - failed}/${results.length + (crash ? 1 : 0)} passed`);
  process.exit(failed ? 1 : 0);
};
process.on("uncaughtException", (e) => report(e));
process.on("unhandledRejection", (e) => report(e instanceof Error ? e : new Error(String(e))));

// ---------------------------------------------------------------- 1. 世界夹具
lua(`local f = game.forces.player
local keep = {}
local names = {"electronics","automation","logistics","steel-processing","logistics-2","solar-energy","electric-energy-accumulators"}
for _, t in ipairs(names) do keep[t] = true end
local unlocked_by = {}
for name, tech in pairs(prototypes.technology) do
  local ok, effects = pcall(function() return tech.effects end)
  if ok then
    for _, e in ipairs(effects or {}) do
      if e.type == "unlock-recipe" and e.recipe then
        unlocked_by[e.recipe] = unlocked_by[e.recipe] or {}
        unlocked_by[e.recipe][name] = true
      end
    end
  end
end
for name, tech in pairs(f.technologies) do
  if not keep[name] then
    tech.researched = false
  elseif not tech.researched then
    tech.researched = true
  end
  tech.enabled = not keep[name]
end
local held, orphan = 0, 0
for name, r in pairs(f.recipes) do
  local want
  if not unlocked_by[name] then
    orphan = orphan + 1
    want = r.enabled
  else
    want = false
    for t in pairs(unlocked_by[name]) do
      if keep[t] then want = true break end
    end
  end
  if r.enabled ~= want then r.enabled = want end
  if r.enabled then held = held + 1 end
end
rcon.print("research reset to the seven; " .. held .. " recipes enabled by rule, "
  .. orphan .. " with no unlocker left as found")`);

// 一次跑批不许继承上一次的地上物：沙地上除矿以外全清，台架与线的作业全部收掉。
// （两件事清不掉，写在这里而不是假装没有：被人手动 `create_global_electric_network` 过的图回不回来，
// 以及别的套件留在自己存档里的那些图。）
lua(`local s=game.surfaces["arch-sandbox"]
if not s then rcon.print("no sandbox yet") return end
local n=0
for _,e in ipairs(s.find_entities_filtered{area={{-500,-500},{500,500}}}) do
  local ok,t=pcall(function() return e.type end)
  if ok and t~="resource" and e.valid then e.destroy() n=n+1 end
end
rcon.print("sandbox swept "..n)`);
call("lab_reset", {});
call("place_undo", { count: 40 });

// ---------------------------------------------------------------- 2. 门面
let r = call("ping");
check("ping", r.ok && r.data.mod_version, r.ok ? `v${r.data.mod_version} game ${r.data.game_version}` : r.code);
check("压线那四个入口和它们要的引擎都在方法表里",
  ["helmod_ghosts", "helmod_blueprints", "helmod_factories", "helmod_last_steps", "card_example",
    "card_lab", "place_undo", "gui_selftest"].every((m) => asArr((r.data || {}).methods).includes(m)),
  asArr((r.data || {}).methods).join(","));
check("玩家那条 /arch 命令注册上了（注册失败在无头里是看不见的）",
  asArr((r.data || {}).player_commands).includes("arch"),
  JSON.stringify(r.data && r.data.player_commands));
const gone = call("plan_fit", {});
check("删掉的门是 UNKNOWN_METHOD，并且把还在的门交出来",
  gone.ok === false && gone.code === "UNKNOWN_METHOD" && asArr(gone.known).length > 5,
  JSON.stringify([gone.code, asArr(gone.known).length]));

// 显示面板锁在 circuit-network 后面，而上面的夹具把那七项之外的科技全撤了 —— 这是世界状态，不是模的
// 行为。下面凡是裸带线头的读数都在这份科技借来期间取，最后照原样还。
// 显示面板锁在 circuit-network 后面，而上面的夹具把那七项之外的科技全撤了 —— 这是世界状态，不是模的行为，
// 所以照别的套件一样只为这一测借来、测完还回去。
const netWasOn = /true/.test(lua(`local t = game.forces.player.technologies["circuit-network"]
  rcon.print(t and tostring(t.researched) or "absent")`));
const grantNet = (on) => lua(`local f = game.forces.player
local t = f.technologies["circuit-network"]
local r = f.recipes["display-panel"]
if t then t.researched = ${on ? "true" : "false"} end
if r then r.enabled = ${on ? "true" : "false"} end
rcon.print("net=" .. tostring(${on ? "true" : "false"}))`);
grantNet(true);

// ---------------------------------------------------------------- 3. 形状与件数
const ex = call("card_example", {});
const good = ex.ok && ex.data;
check("card_example 自洽", !!good, good ? `${asArr(good.entities).length} 件 ${JSON.stringify(good.components)}`
  : `${ex.code} ${ex.msg || ""}`);
check("答案说清每个件是怎么挑出来的",
  good && good.components_how && Object.keys(good.components_how).length === 4
  && Object.values(good.components_how).every((h) => typeof h === "string" && h.length > 0),
  JSON.stringify(good && good.components_how));
const bogus = call("card_example", { belt: "not-a-real-belt", inserter: "not-a-real-arm" });
check("点了这台安装没有的件，是被换掉而不是原样吐回来",
  bogus.ok && bogus.data.components.belt !== "not-a-real-belt"
  && bogus.data.components.inserter !== "not-a-real-arm",
  JSON.stringify(bogus.ok ? { parts: bogus.data.components, how: bogus.data.components_how } : bogus.code));
// 带的默认是"最快"这一条是玩家的意见（2026-10-07）：这里把它钉成可查的事实，改成"够用就好"那天这条会红。
check("现在带子还是按 belt_speed 最快挑的（D3 要改的就是这一行）",
  good && /best belt_speed desc/.test(String((good.components_how || {}).belt)),
  String((good.components_how || {}).belt).slice(0, 120));
const stacked = call("card_example", { recipe: "advanced-circuit", machines: 4, heads: "belt" });
check("裸带线头 + 三种料 = 零箱子那一档，牌上把料和成品都写了",
  stacked.ok && stacked.data.style === "stacked" && (stacked.data.parts || {}).chests === 0
  && asArr((stacked.data.head || {}).lanes).length === 4,
  JSON.stringify(stacked.ok ? [stacked.data.style, stacked.data.parts, asArr((stacked.data.head || {}).lanes).length]
    : [stacked.code, stacked.msg]));

// ---------------------------------------------------------------- 4. 几何 lint
const lint = (card, extra) => {
  const res = call("card_check", Object.assign({ card }, extra || {}));
  return res.ok ? res.data : { errors: [{ code: "BRIDGE_" + res.code }], ok: false };
};
const clone = () => JSON.parse(JSON.stringify(good));
const expectReject = (name, card, code) => {
  const d = lint(card);
  const errs = asArr(d.errors);
  check(name, d.ok !== true && errs.some((e) => e.code === code),
    errs.map((e) => `${e.code}@${e.at}`).join(" ") || "接受了一张它该拒的卡");
};
if (good) {
  const R = good.roles;
  const E = (i) => i - 1;
  const m = () => clone();
  check("好卡过 lint", (() => { const d = lint(good); return d && d.ok === true; })(),
    JSON.stringify((lint(good) || {}).stats || {}));
  let c;
  c = m(); c.entities[E(R.in_chest || R.in_chests[1])].name = "definitely-not-an-entity";
  expectReject("lint 拒掉不存在的实体", c, "UNKNOWN_ENTITY");
  c = m(); c.entities[E(R.arms[0])].name = "stack-inserter";
  expectReject("lint 拒掉没研究的件", c, "LOCKED_ENTITY");
  c = m(); c.entities[E(R.arms[0])].name = "stack-inserter";
  const freed = lint(c, { ignore_locked: true });
  check("ignore_locked 只放行几何那一半", freed.ok === true,
    asArr(freed.errors).map((e) => e.code).join(" ") || "ok");
  c = m(); c.entities[E(R.machines[0])].position.x += 0.5;
  expectReject("lint 拒掉不在格心上的中心", c, "MISALIGNED");
  c = m(); const f0 = c.entities[E(R.machines[0])].position;
  c.entities[E(R.in_chest || R.in_chests[1])].position = { x: f0.x, y: f0.y };
  expectReject("lint 拒掉重叠实体", c, "OVERLAP");
  c = m(); c.entities[E(R.machines[0])].position = { x: 40, y: 40 };
  expectReject("lint 拒掉够不着机器的线", c, "MACHINE_NO_ARM");
  c = m(); c.ports.out[0].entity = 999;
  expectReject("lint 拒掉指向不存在实体的口", c, "PORT_UNKNOWN_ENTITY");
  c = m(); c.entities = [];
  const empty = lint(c);
  check("lint 拒掉空卡", asArr(empty.errors).some((e) => e.code === "EMPTY_CARD"),
    asArr(empty.errors).map((e) => e.code).join(" "));
}

// ---------------------------------------------------------------- 5. 台架：能生产这件事唯一的实证
r = call("lab_reset");
check("lab_reset 回话", r.ok, r.code || "");
r = call("lab_start", { machine: "not-a-real-machine" });
check("lab_start 拒掉这台安装没有的机器", !r.ok && r.code === "UNKNOWN_MACHINE", r.code);
r = call("lab_start", { recipe: "no-such-recipe" });
check("lab_start 拒掉不存在的配方", !r.ok && r.code === "UNKNOWN_RECIPE", r.code);
r = call("lab_start", { machine: "inserter" });
check("lab_start 拒掉不工艺的机器", !r.ok && r.code === "NOT_A_CRAFTER", r.code);
r = call("lab_start", { machine: "stone-furnace", recipe: "iron-plate", count: 3, seconds: 6, speed: 40 });
const labJob = r.ok ? r.data : {};
check("lab_start 在自己那张台架上找地，不在硬编码的点上建",
  r.ok && labJob.surface === "arch-lab" && !!labJob.origin,
  JSON.stringify([labJob.surface, labJob.origin]));
(() => {
  const deadline = Date.now() + 90000;
  let st = {};
  while (Date.now() < deadline) {
    st = (call("lab_status", {}) || {}).data || {};
    if (st.state === "done" || st.state === "abandoned") break;
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},2000)"]);
  }
  check("跑完的作业自己收摊", st.state === "done" && (st.destroyed || 0) >= 3,
    `state=${st.state} destroyed=${st.destroyed} missing=${st.missing}`);
  check("台架真的产出了东西（这条链的'能生产'就靠它）",
    (st.produced || 0) > 0 && (st.measured_per_min || 0) > 0,
    `produced=${st.produced} measured=${st.measured_per_min} expected=${st.expected_per_min}`);
  r = call("lab_stop", {});
  check("停一个已经跑完的作业说没东西可停", !r.ok && r.code === "LAB_IDLE", r.code);
})();
check("时钟回到一格一跳（台架改过的游戏速度必须还回去）",
  ((call("lab_status", {}).data || {}).clock || {}).speed === 1,
  JSON.stringify((call("lab_status", {}).data || {}).clock));
const beltHeadCard = call("card_example", { recipe: "electronic-circuit", machines: 3, style: "two-feed",
  heads: "belt", force: "player" });
const labBelt = call("card_lab", { card: (beltHeadCard.data || {}), seconds: 6 });
check("台架对裸带线头是**按名拒**，不是量出 0 当成结论",
  labBelt.ok === false && labBelt.code === "CARD_NO_PORTS",
  `${labBelt.code} ${String(labBelt.msg || "").slice(0, 90)}`);

// ---------------------------------------------------------------- 6. 压线与撤回
const press = call("helmod_ghosts", {
  into: "ground", surface: "nauvis", origin: { x: 3000, y: 3000 }, width: 40,
  plan: [{ name: "assembling-machine-3", count: 4, recipe: "electronic-circuit" }],
});
const pd = press.data || {};
check("压一页（这里是手写 plan 那一形状）铺出的是带臂机器，不是散件",
  press.ok === true && (pd.lanes || []).length === 1 && (pd.ghosts || 0) > 20
  && pd.fed === true, JSON.stringify([press.code, (pd.lanes || []).length, pd.ghosts, pd.fed]));
check("每一步判断都留了一行日志（玩家要的是能指到第几步）",
  asArr(pd.steps).length >= 8 && asArr(pd.steps).some((l) => /线卡/.test(String(l)))
  && asArr(pd.steps).some((l) => /落一条线/.test(String(l))),
  asArr(pd.steps).slice(0, 2).map(String).join(" || ").slice(0, 200));
check("上一次压的步骤能按页读回来", (() => {
  const back = call("helmod_last_steps", {});
  return back.ok === true && asArr(back.data && back.data.lines).length >= 8;
})(), JSON.stringify([String((call("helmod_last_steps", {}) || {}).code),
  ((call("helmod_last_steps", {}) || {}).data || {}).count]));
const asString = call("helmod_ghosts", { into: "string", surface: "nauvis", origin: { x: 3000, y: 3000 },
  plan: [{ name: "assembling-machine-3", count: 4, recipe: "electronic-circuit" }] });
check("要字符串就给字符串，而且真的是张蓝图",
  asString.ok === true && /^0e/.test(String((asString.data || {}).blueprint || "")),
  String((asString.data || {}).blueprint || asString.code).slice(0, 12));
const undo = call("place_undo", { count: 1 });
check("压到地面的那一按能撤回", undo.ok === true && ((undo.data || {}).undone || 0) >= 1,
  JSON.stringify(undo.ok ? undo.data : undo.code).slice(0, 160));
const emptyUndo = call("place_undo", {});
check("空栈是一次有理由的拒绝，不是一个空答案",
  emptyUndo.ok === false && emptyUndo.code === "NOTHING_TO_UNDO", `${emptyUndo.code}`);

// ---------------------------------------------------------------- 7. 面板
const gm = call("gui_model", {});
check("面板模型回话，而且带着形状清单与 helmod 那一格",
  gm.ok === true && asArr(gm.data && gm.data.styles).length >= 1,
  JSON.stringify([(gm.data || {}).styles && (gm.data || {}).styles.length,
    (gm.data || {}).helmod && (gm.data || {}).helmod.error || "ok"]));
const self = call("gui_selftest", {});
check("窗口建得起来、每个部件都在树里、每个按钮都派发得到",
  self.ok === true && self.data && self.data.ok === true && !self.data.widgets_missing
  && !asArr(self.data && self.data.unhandled).length,
  JSON.stringify(self.data && [self.data.widgets_missing, self.data.unhandled]).slice(0, 220));
check("窗口里压线那一按的话里有件数、形状和撤回的去处",
  asArr((self.data || {}).report_after && (self.data || {}).report_after["arch-helmod"]
    && (self.data || {}).report_after["arch-helmod"].lines).join("\n").length > 40,
  String(((self.data || {}).report_after || {})["arch-helmod"] && "有").slice(0, 40));
// 三个把手开同一扇窗，所以三样都要在：右上角那颗按钮（画的是 data 阶段注册的那一张图）、快捷键那一按
// 真的把窗关掉、自动刷新只重画 helmod 那一行而不擦答案。红的时候要说得出是哪一件。
const sd = self.data || {};
check("右上角那颗按钮建得出来，并且画的是这个 mod 自己注册的那张图",
  sd.toolbar && sd.toolbar.built === true && sd.toolbar.named === true
  && sd.toolbar.sprite === "architect-toolbar",
  JSON.stringify(sd.toolbar));
check("快捷键那一按走的是和窗口里同一格：把窗关掉",
  sd.shortcut_toggle && sd.shortcut_toggle.verb === "toolbar"
  && sd.shortcut_toggle.closed === true, JSON.stringify(sd.shortcut_toggle));
check("自动刷新：没窗口时什么都不做，有窗口时重画那一行并且留下答案",
  sd.auto_refresh && sd.auto_refresh.no_window === "false" && sd.auto_refresh.open === "true"
  && Number(sd.auto_refresh.report_before) > 0
  && sd.auto_refresh.report_before === sd.auto_refresh.report_after_refresh,
  JSON.stringify(sd.auto_refresh));
check("自动刷新那一格在窗口树里（不在就没人能把它打开）",
  String(sd.tree || "").includes("arch-auto-refresh"), String(sd.tree || "").slice(0, 160));

// 拒因是一句话，不只是一个码：面板渲染的是 key，RCON 留的是英文 —— 两边必须说的是同一件事。
const refused = call("helmod_ghosts", { into: "string", surface: "nauvis", factory: "model_4242",
  models: { model_7: { class: "Model", id: "model_7",
    block_root: { class: "Block", name: "iron chain",
      summary_global: { factories: { a: { name: "assembling-machine-2", type: "entity", count: 2 } } } } } } });
check("拒因两边同一件事：key 渲染出来的句子就是代码里那句英文",
  refused.ok === false && refused.code === "HELMOD_NO_FACTORY"
  && String(asArr(refused.detail && refused.detail.known).join(",")).includes("model_7"),
  JSON.stringify([refused.code, refused.detail && refused.detail.known]).slice(0, 200));

if (!netWasOn) grantNet(false);
report();
