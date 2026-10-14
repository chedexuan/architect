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
// 每个件都要说清是怎么挑的。键的个数不钉死：牌要立起来就得挑面板与发射器，那一档排法要不要挑箱子
// 也会变 —— 钉个数等于把"这一发挑了哪几样"抄进另一扇门。钉的是"挑了的每一样都有一句话"。
check("答案说清每个件是怎么挑出来的",
  good && good.components_how && Object.keys(good.components_how).length >= 4
  && ["furnace", "inserter", "belt"].every((k) => (good.components_how || {})[k])
  && Object.values(good.components_how).every((h) => typeof h === "string" && h.length > 0),
  JSON.stringify(good && good.components_how));
// 臂的两个工位：`pickup_position` / `drop_position`（2026-10-11 夜量的）。为什么钉在 smoke 而不是别处：
// 建一只臂读两个字段就够（不用台架、不用等窗口），而**整条 `fluid-back` 的"谁站在哪一行"都压在这个数上** ——
// 旧注写着"drop 只有 1 格"，那只对 1 档臂成立：长臂取身前 2 格、放身后 2 格，**两侧一起随 reach 长**。
// 记错这一格，"一个面叠三条带"那条路会被当成不可能（#11），或者反过来把臂画到货落不到的地方。
const armCells = lua(`local s = game.surfaces["arch-sandbox"]
local out = {}
for _, n in ipairs({"inserter","fast-inserter","bulk-inserter","stack-inserter","long-handed-inserter"}) do
  local e = s.create_entity({ name = n, position = { 120.5, 120.5 },
    direction = defines.direction.south, force = "player" })
  if e then
    local function cell(p, axis) return math.floor(p[axis]) end
    local pk, dp = e.pickup_position, e.drop_position
    out[#out + 1] = n .. "|" .. (cell(pk, "y") - 120) .. "|" .. (120 - cell(dp, "y"))
    e.destroy()
  else
    out[#out + 1] = n .. "|建不起来|?"
  end
end
rcon.print(table.concat(out, ","))`);
const arms = {};
// `dev/lua.js` 在末尾打了一行 OK（这条坑在 §0 第五条记过）：不按行切最后一份就变成 "2|OK"，
// Number() 出 NaN，读数看着像"这一档臂没有放货格"。
for (const row of String(armCells).split("\n")[0].split(",")) {
  const [n, pick, drop] = row.split("|");
  if (n) arms[n] = { pick: Number(pick), drop: Number(drop) };
}
check("臂的取货格与放货格：两侧一起随 reach 长（1 档臂 = 前 1 后 1；长臂 = 前 2 后 2）",
  Object.keys(arms).length === 5
  && arms["inserter"].pick === 1 && arms["inserter"].drop === 1
  && arms["fast-inserter"].drop === 1 && arms["long-handed-inserter"].pick === 2
  && arms["long-handed-inserter"].drop === 2,
  JSON.stringify(arms));

const bogus = call("card_example", { belt: "not-a-real-belt", inserter: "not-a-real-arm" });
check("点了这台安装没有的件，是被换掉而不是原样吐回来",
  bogus.ok && bogus.data.components.belt !== "not-a-real-belt"
  && bogus.data.components.inserter !== "not-a-real-arm",
  JSON.stringify(bogus.ok ? { parts: bogus.data.components, how: bogus.data.components_how } : bogus.code));
// 带子的默认从"最快"改成"够用就好"（玩家 2026-10-07 的话："传送带也要够用就好或者可以选"）。这里钉三件事：
// 不表态时试的是从慢到快、停在第一条装得下的；一条铁板线因此落在黄带子上，而不是要先炼润滑剂；点名一档
// 就照点名的来（那是命令，不是提示）。
const d3 = call("card_example", { recipe: "iron-plate", machines: 4 });
const ch = (d3.data || {}).belt_choice || {};
check("不表态时带子从最慢那档往上试，并且落在第一条装得下的",
  d3.ok && ch.adequate === true && !ch.asked && asArr(ch.tried).length >= 1
  && ch.tried[0] === ch.chosen && ch.chosen === "transport-belt"
  && Number(ch.feed_rows) <= Number(ch.rows_per_face)
  && Number(ch.product_rows) <= Number(ch.rows_per_face),
  JSON.stringify([d3.code, ch, (d3.data || {}).components && (d3.data || {}).components.belt]).slice(0, 220));
const d3named = call("card_example", { recipe: "iron-plate", machines: 4, belt: "fast-transport-belt" });
check("点名一档带子就照那档来，不因为黄带子也够用就被换掉",
  d3named.ok && d3named.data.belt_choice && d3named.data.belt_choice.asked === "fast-transport-belt"
  && d3named.data.belt_choice.chosen === "fast-transport-belt",
  JSON.stringify([d3named.code, (d3named.data || {}).belt_choice]).slice(0, 200));
const stacked = call("card_example", { recipe: "advanced-circuit", machines: 4, heads: "belt" });
const sd2 = stacked.data || {};
// 头那一排牌写"吃什么"、尾那一排写"吐什么"（玩家 2026-10-07："头尾都放"）。advanced-circuit 吃三种料、
// 出一种成品，所以两头分别是 3 与 1。卡里那 5 件"其它"是**两排显示面板**：头三块料 + 一块带子 = 4，
// 尾一块带子 + 一块成品 = 2 —— 2026-10-13 他把"标数字"换成"中间放带子图标、两边放对应的料"，
// 一块牌只画一个图标（量的：`display_panel_icon` 收一种信号），所以一块线头从 1 张牌变成一排。
// 0.93.0 那次去掉的是发射器/组合器/电线（"看不懂电路"），箱子到这一版仍然是 0。
check("裸带线头 + 三种料 = 零箱子那一档，头写料、尾写成品",
  stacked.ok && sd2.style === "stacked" && (sd2.parts || {}).chests === 0
  && asArr((sd2.head || {}).lanes).length === 3
  && asArr((sd2.tail || {}).lanes).length === 1
  && (sd2.parts || {}).others === 5
  && String((sd2.head || {}).manifest || "").includes("plastic-bar")
  && String((sd2.tail || {}).manifest || "").includes("advanced-circuit"),
  JSON.stringify([stacked.code, sd2.style, sd2.parts,
    asArr((sd2.head || {}).lanes).length, asArr((sd2.tail || {}).lanes).length,
    (sd2.head || {}).manifest, (sd2.tail || {}).manifest]).slice(0, 260));

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
  // 这一格要"卡里随便一件不是机器的东西"来改名。从前它拿线头箱子用，而带箱子的排法删掉之后默认那张卡
  // 一只箱子都没有 —— 于是这里改成"任何一件实体，只要不是被后面几条当锚点的那台机器"：断言的是"名字不
  // 存在要按名拒"，用哪件实体试不影响这句话。
  const anyChestOrBelt = () => {
    const lists = [R.in_chest, R.in_chests, R.belts];
    for (const l of lists) {
      const v = Array.isArray(l) ? l[0] : l;
      if (v) return v;
    }
    return null;
  };
  const chestIdx = anyChestOrBelt();
  c = m(); c.entities[E(chestIdx)].name = "definitely-not-an-entity";
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
  c.entities[E(chestIdx) === E(R.machines[0]) ? E(R.belts[0]) : E(chestIdx)].position = { x: f0.x, y: f0.y };
  expectReject("lint 拒掉重叠实体", c, "OVERLAP");
  c = m(); c.entities[E(R.machines[0])].position = { x: 40, y: 40 };
  expectReject("lint 拒掉够不着机器的线", c, "MACHINE_NO_ARM");
  // 零箱子的卡没有 out 口（口是箱子留下的），所以这一格要自己造一个指向不存在实体的口来试 ——
  // 断言的是"口指到没有的东西上要按名拒"，卡本来有没有口与这句话无关。
  c = m();
  c.ports = { in: asArr((c.ports || {}).in), out: asArr((c.ports || {}).out) };
  c.ports.out.push({ entity: 999, item: "iron-plate" });
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
// 默认线头就是裸带（带箱子的排法删了），而台架现在按股道喂料 —— 所以这张卡【开得了工】。这里只问"接不接
// 得下"：真产出东西、量出来的率和牌上写得对不对，是 dev/belt_line_produces.js 那扇门的事（它要等作业跑完）。
const beltHeadCard = call("card_example", { recipe: "electronic-circuit", machines: 3,
  heads: "belt", force: "player" });
const labBelt = call("card_lab", { card: (beltHeadCard.data || {}), seconds: 6 });
check("台架接得住一张零箱子的裸带卡（从前它连喂哪一格都不知道，只能拒）",
  labBelt.ok === true, `${labBelt.code} ${String(labBelt.msg || "").slice(0, 90)}`);
call("lab_stop", {});
// 认股道不等于什么都开工：一张既没有口、也没有带子的卡，量出来必然是 0，而 0 会被读成"这条线太慢"而不是
// "这张卡压根没喂"。按名拒才是诚实的答案，这一格留的就是那句话。
const labNoLane = call("card_lab", { card: { name: "no-lane-no-port",
  entities: [{ name: "assembling-machine-1", position: { x: 0.5, y: 0.5 } }] }, seconds: 6 });
check("既没有口也没有股道的卡仍按名拒，不是量出 0 当成结论",
  labNoLane.ok === false && ["CARD_NO_PORTS", "CARD_NO_FEEDS", "CARD_DOES_NOT_LINT"].includes(labNoLane.code),
  `${labNoLane.code} ${String(labNoLane.msg || "").slice(0, 90)}`);

// ---------------------------------------------------------------- 6. 压线与撤回
const press = call("helmod_ghosts", {
  into: "ground", surface: "nauvis", origin: { x: 3000, y: 3000 }, width: 40,
  plan: [{ name: "assembling-machine-3", count: 4, recipe: "electronic-circuit" }],
});
const pd = press.data || {};
// 带子改成"够用就好"之后，同一张 4 台计划可能落成 2 条线（一条带的两股装不下这么多流量就多铺一条），
// 这正是玩家要的那笔交换：省下的不是线数，是润滑剂。所以这里钉的不是"几条线"，而是**计划里的机器一台
// 都不能少**、每条线都喂得齐、铺出来的件数对得上。
const pressMachines = asArr(pd.lanes).reduce((a, l) => a + (Number(l.machines) || 0), 0);
check("压一页（这里是手写 plan 那一形状）铺出的是带臂机器，不是散件",
  press.ok === true && (pd.lanes || []).length >= 1 && (pd.ghosts || 0) > 20
  && pd.fed === true && pressMachines === 4,
  JSON.stringify([press.code, (pd.lanes || []).length, pd.ghosts, pd.fed, pressMachines]));
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
// 刷新那一格的三条事实都是玩家用手指头量出来的那一条 bug 的另一面：下拉是一列展开的选项，重建它
// 等于把弹窗关掉，所以他每次展开都会在大约一秒内被合上，最后永远只能停在第 1 行。于是
// —— 列表没变：一个部件都不许碰（`row_untouched`，比的是部件引用）；列表真变了：要重画并且那一行
// 确实有两行；而两种情况下下面那段答案都不许被擦掉。
const ar = sd.auto_refresh || {};
check("自动刷新：没窗口时什么都不做；列表没变时那一行一个部件都不碰，答案也不擦",
  ar.no_window === "false" && (ar.open === "same" || ar.open === "true")
    && (ar.open !== "same" || ar.row_untouched === "true")
    && Number(ar.report_before) > 0 && ar.report_before === ar.report_after_refresh,
  JSON.stringify(ar));
check("...而 helmod 真多出一页时它就重画：列表多出那一行，行尾那颗「复制」也多一颗（数一旦不等就是有一行点了没反应）",
  ar.redraw_when_list_changes === "true" && ar.same_when_unchanged === "same"
    && Number(ar.list_rows) === 1 && Number(ar.copy_buttons) === 1,
  JSON.stringify([ar.redraw_when_list_changes, ar.same_when_unchanged, ar.list_rows, ar.copy_buttons]));
// 顶行那颗「刷新」按下去的两种结果（2026-10-13 他第 2 条）。这一格从前只有自动刷新那条路被量过，
// 手动那一按是"整扇窗重建"：列表滚动回顶、答案区擦成空白 —— 也就是说玩家每一次主动刷新都在丢自己刚读到的东西。
check("...而顶行那颗「刷新」也是无感的：helmod 没变就一个部件都不碰，真变了重建也不擦答案",
  ar.click_refresh_verb === "refreshed" && ar.click_refresh_untouched === "true"
    && ar.click_refresh_keeps_answer === "true",
  JSON.stringify([ar.click_refresh_verb, ar.click_refresh_untouched, ar.click_refresh_keeps_answer]));
// 答案区默认那一档"要让人看得懂"（2026-10-13 他第 6 条）不能只是一句意图，得数得出：
// 拿一发**真的**压线答案交给窗口自己那只渲染器（`render_answer`），数默认留下几行、"详细"那一档藏了几行。
// 两条都要钉：① 默认那一档 ≈ 一句总结 + 每条线一行（多出来的必须是"玩家要处理的"那种，比如换了机器）；
// ② 藏起来的那一堆必须**真的存在** —— 那个「详细」开关如果底下没有任何一行可藏，它就是一颗假控件。
{
  const press = call("helmod_ghosts", { into: "string", heads: "belt", surface: "nauvis",
    origin: { x: 900, y: 900 }, width: 60,
    plan: [{ name: "assembling-machine-3", count: 3, recipe: "electronic-circuit" }] });
  const shown = call("gui_selftest", { render_answer: { cmd: "helmod", name: "", res: press } });
  const an = (shown.data || {}).answer_live || {};
  check("答案区默认那一档：一句总结 + 每条线一行，其余收在「详细」里（开关背后确实有东西可藏）",
    press.ok === true && Number(an.shown) >= 1 && Number(an.shown) <= 2 + 2 * Number(an.lane_rows || 1)
      && Number(an.hidden) >= 1,
    JSON.stringify([press.ok, an.shown, an.hidden, (an.lines || []).length]));
  // 总结那一句的第一个数必须是这一发真的几条线 —— 从前那里读的是 `d.kinds`，而那一格走"复制这一页"
  // 时永远是 0，玩家读到的第一句就是"0 kind(s)"（一个永远为零的数写在第一句，比不写更坏）。
  const first = String((an.lines || []).find((l) => !l.tech) ? {} : "");
  check("...而第一句里那个线数不是零（零行数写在第一句就是这句假话的形状）",
    /architect\.n-hm\|/.test(String(((an.lines || [])[0] || {}).line || ""))
      && !/^architect\.n-hm\|0\|/.test(String(((an.lines || [])[0] || {}).line || "")),
    String(((an.lines || [])[0] || {}).line || "").slice(0, 90));
}

// 重画之后树里只能有一块列表：从前 `G.helmod_row` 一边遍历 children 一边 destroy，每删一个跳过一个，
// 旧列表留在树上 —— 真引擎看不出来，替身一次就露馅（2026-10-13 在他的档上读出 10 行真数据、same 永远不绿）。
check("...重画那一格之后树里只留一块列表（旧的不许站在原地让后面每次都读它）",
  Number(ar.panes_after_grow) === 1, JSON.stringify(ar.panes_after_grow));
check("...而这一页没有计划时那一格说得出是哪一种“没有”，不是一片空白",
  ar.said_why_no_page === "true", JSON.stringify(ar.said_why_no_page));
check("...列表每一行背后那个 id 读得回来（页 id 就写在行尾按钮的名字里，两处各记一套就会复制错页）",
  ar.row_button_ids === "model_selftest",
  JSON.stringify([ar.row_button_ids, ar.copy_buttons, ar.list_rows]));
check("自动刷新那一格在窗口树里（不在就没人能把它打开）",
  String(sd.tree || "").includes("arch-auto-refresh"), String(sd.tree || "").slice(0, 160));
// 这一格开没开，窗口和 `on_nth_tick` 必须读同一句。分家那天窗口是亮的、列表永远不动，而且一声不响 ——
// 所以把它单独量一条：没表过态 = 开着，亲手关掉 = 关。
check("...而它开没开只由一处判：没表过态=开着、关掉=关（窗口与计时器读同一句）",
  ar.on_when_silent === "true" && ar.on_when_off === "false",
  JSON.stringify([ar.on_when_silent, ar.on_when_off]));
// 图标那一格的提示语（2026-10-14 审出来的最要命的一条）：`NM` 交回的是游戏自己那份翻译，而它是**一张表**，
// 拿 `..` 拼它整扇窗就建不起来 —— 玩家看到的是"点了按钮没窗"，而替身里 `prototypes` 也在，所以这一条
// 在自测里就会红。列表那一行现在带真形状（机器 + 产物 + 原料），所以画的出图这件事也是量的，不是猜的。
check("图标提示语把「游戏自己的翻译」和「×N」接成一句合法的话（拼本地化串表就会整扇窗建不起来）",
  ar.tip_is_localisable === "true", JSON.stringify(ar.tip_is_localisable));
check("...而带机器与产料的那一行真的建得出来（图标画的是引擎图库那一路，不是空白也不是名字）",
  Number(ar.grew_rows) === 2 && ar.icons_laid === "true",
  JSON.stringify([ar.grew_rows, ar.icons_laid, ar.panes_after_grow]));
// 记住的行号越界会把整扇窗弄没那一格，随总线一起删了：今天两个下拉的行号是 `word_index` 从
// 名单里数出来的，构造上不会越界 —— 没有会越界的那一手，就不留一条永远绿的断言（留一条打在空气上的
// 断言，是这一周里被指过两次的那类谎）。
// 真建一次窗（§2c 那条最大的坑只有真客户端能证）：**列表每秒被连根重建，滚动位置每秒回顶**。
// 替身里这条永远是绿的 —— 替身的控件是 Lua 表，而真控件是 userdata（rawget 那一手就是这么只在真窗口炸）。
// 所以这里要求：这台服上有玩家 ⟹ 真窗口必须建得出列表、有行、第二次刷新返回 same；
// 没有玩家 ⟹ 方法必须自己说"这一步在这台机器上做不了"，而不是不出这一格（不出=假绿）。
const realPress = call("gui_selftest", { real: true });
const rb = ((realPress.data || {}).real_build) || null;
const noPlayer = /没有玩家/.test(String(rb && rb.why));
check("真建一次窗：有玩家就把列表钉住，没玩家就把话说出来",
  realPress.ok === true && rb !== null && (noPlayer
    || (rb.ok === true && rb.pane === true && Number(rb.rows) >= 1 && rb.holds_scroll === true)),
  JSON.stringify([realPress.code, rb && [rb.ok, rb.pane, rb.rows, rb.refresh_again, rb.holds_scroll, rb.why]]).slice(0, 240));

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
