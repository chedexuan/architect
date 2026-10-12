// 两种液体进的线：铺得出、而且**真的在产**（`LANE_FEEDS_ONE_FLUID` 那一簇的门禁）。
//
// 这一把钉的是三件事，每一件都只能在地上量：
//   1. 形状是"一口一列"（`fluid-through` + 每台机器每种液体一根柱子），列与列**隔 2 格以上** ——
//      两张贴管的管子一挨就是一段管网，那是一条线喝出一份混合物，不是两种料。格号是从原型读回来的
//      （`dev/two_fluid_ports.js`：chemical-plant 北面 -1/+1、foundry 南面 -1/+1、oil-refinery 南面 -1/+1），
//      柱子之间的间距是形状自己抬的（`gap = fw + 1`）。
//   2. 台架喂得进去：这条线**只有两种料都到了机器**才会动（缺一种就永远不开始工艺），所以"在产"这两个字
//      同时证明了第二根柱子接的是另一种液体、也证明了那两根没有并成一段（并段的话引擎只让一种液体进去，
//      另一台机器就饿着）。这是这一簇最便宜也最硬的验收。
//   3. 两种料进 + 一种液体出的那条（重油裂解：水 + 重油 → 轻油）：柱子与成品那一行管子**各在一面**，
//      两面都要铺得出来；量到的成品数从卡自己那一行管子里读（`dev/fluid_drain_probe.js` 那把尺子）。
//   4. 两种料进**又**吃固体料的那一条（锂）：列占住喝水那一面，固体两族整体挪到**没有管道**那一面、
//      共用一行臂（`S.item_side`）。这一格 2026-10-10 之前是按名拒，挪面之后铺得出来 —— 判它的是"带子
//      与管子在机器两侧"＋"两族的臂站同一行"＋"这条线真的在产"。
//
// 借研究照旧按**读回来的原值**还（§0 那条坑），而且机器的放置配方也在名单里：可用性读的是
// `force.recipes[unlock_recipe].enabled`，光把技术置真引擎不跑"研究完成时解锁配方"那一步。
//
// 两个开发用的旋钮（不影响门禁口径）：`MFP_FAST=1` 只跑第一条（改台架时来回跑快）、
// `MFP_N=2` 换硫酸那一条的台数。
//
// 2026-10-11 加的一条口径：这几发**点名机器**（chemical-plant / oil-refinery）。理由不是好看 ——
// 借的那份名单里带着机器件，一借就把 `cryogenic-plant` 那台 5×5 也开了，梯子按速度挑机器会换一台，
// 于是同一张配方在地上是两种几何、两种供料结果（化工厂 347.6/分、0 条问题；低温厂 3 条问题全是石油气）。
// 门禁要问的是"这一手几何喂不喂得进"，那就得钉住是哪一台；**不点名 = 读数随借窗口漂**。
// 漂出来的那条真问题（低温厂那一列石油气到底喂不喂得进）另开一条，写在 `dev/待办.md` §0。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("multi_fluid_probe");
const { onExit } = require("./suite-guard.js");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "30000" };
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 300) }; }
};
const lua = (src) => execFileSync("node", [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 500)}`);
  ok ? pass++ : fail++;
};

// 配方名 + 机器的放置件名：两类都要借，缺一样台架就是另一种说法的 0。
// 借的名单**必须连台架自己要用的硬件一起点名**（2026-10-11 那一趟学到的）：这张表从前只点配方与机器，
// 于是存档"碰巧开着"快速带、长手臂、管子、储罐时这套门禁才绿 —— 而 tail 那几套把开放集还薄之后，
// 四条台架读数一律变空（牌照样铺得出，看起来像"液体线不产了"，实际是台架自己没件可用）。
// 判据与 `fluid_drain_probe` / `pipe_row_flow` 同一手：这一套要用什么，就借什么，按原值还。
const GRANT_RECIPES = ["sulfur", "heavy-oil-cracking", "solid-fuel-from-ammonia", "lithium",
  "ammonia-rocket-fuel", "concrete-from-molten-iron", "fluoroketone",
  "casting-low-density-structure", "chemical-plant", "oil-refinery", "foundry", "biochamber",
  "cryogenic-plant",
  "assembling-machine-3", "assembling-machine-4",
  "empty-water-barrel", "lubricant", "display-panel",
  "pipe", "storage-tank", "pump", "fast-transport-belt", "transport-belt",
  "fast-inserter", "long-handed-inserter", "bulk-inserter", "loader",
  "express-transport-belt", "turbo-transport-belt"];
const asLuaList = (xs) => `{${xs.map((x) => `"${x}"`).join(",")}}`;
// 借哪几门科技不硬写名字：从 `prototypes.technology` 里按"哪个科技的 effects 开了这批 recipe"读回来
// （与模组自己那份 `tech_for_recipe` 同一手）。
const neededTechs = () => lua(`local want = {}
for _, n in ipairs(${asLuaList(GRANT_RECIPES)}) do want[n] = true end
local out = {}
for tname, t in pairs(prototypes.technology) do
  local ok, eff = pcall(function() return t.effects end)
  for _, e in ipairs((ok and eff) or {}) do
    if e.type == "unlock-recipe" and e.recipe and want[e.recipe] then out[tname] = true end
  end
end
local ks = {} for k in pairs(out) do ks[#ks + 1] = k end
table.sort(ks)
rcon.print(table.concat(ks, ","))`);
// 切回话按逗号**或空白**切，只认合法名字：`dev/lua.js` 在末尾打了一行 OK。
const ALL_TECHS = String(neededTechs()).split(/[,\s]+/).filter((x) => /^[a-z][a-z0-9_-]*$/.test(x));
const luaTable = (obj) => `{${Object.entries(obj).map(([k, v]) => `["${k}"]=${v ? "true" : "false"}`).join(",")}}`;
const readState = () => lua(`local f = game.forces.player
local out = {}
for _, n in ipairs(${asLuaList(ALL_TECHS)}) do
  local t = f.technologies[n]
  out[#out + 1] = "t:" .. n .. "=" .. tostring(t ~= nil and t.researched or false)
end
for _, n in ipairs(${asLuaList(GRANT_RECIPES)}) do
  local r = f.recipes[n]
  out[#out + 1] = "r:" .. n .. "=" .. tostring(r ~= nil and r.enabled or false)
end
rcon.print(table.concat(out, " "))`);
const writeState = (pairs) => lua(`local f = game.forces.player
local set = ${luaTable(pairs)}
for key, val in pairs(set) do
  local kind, name = key:sub(1, 1), key:sub(3)
  if kind == "t" then
    local t = f.technologies[name] if t then t.researched = val end
  else
    local r = f.recipes[name] if r then r.enabled = val end
  end
end
rcon.print("ok")`);
const parseState = (line) => {
  const out = {};
  for (const tok of String(line).trim().split(/\s+/)) {
    const i = tok.indexOf("=");
    if (i > 0) out[tok.slice(0, i)] = tok.slice(i + 1) === "true";
  }
  return out;
};
const before = parseState(readState());
console.log(`  借的技术：${ALL_TECHS.join(",")}`);
const grant = (on) => {
  const next = {};
  for (const k of Object.keys(before)) next[k] = on ? true : before[k];
  return writeState(next);
};
// 借的技术/配方被 kill 也要还：下一趟读回来的"0/分"常常就是这一手没还造成的（0.94.0 那一晚两次假读数）。
onExit(() => { grant(false); });
const benchOne = (card, seconds) => {
  call("lab_reset", {});
  const started = call("card_lab", { card, seconds: seconds || 120, speed: 20 });
  if (!started.ok) return { started: null, code: started.code, msg: started.msg };
  let status = {};
  for (let i = 0; i < 24; i++) {
    sleep(2000);
    status = call("lab_status", {}).data || {};
    if (status.state !== "running") break;
  }
  const stopped = call("lab_stop", {});
  const done = (stopped.ok && stopped.data) ? stopped.data : status;
  // 这一行是这一把探针的**说真话的那一格**。台架有三种收场，从前在这里全被打成同一个"0/分"：
  //   done            —— 窗口跑完了，verdicts 里就是这条线的速率；
  //   supply_unproven —— 台架**没能证明供料**（它自己不肯开窗口，elapsed 远不到 9000 tick 就收场），
  //                     这时 verdicts 是空的，说的是"我没证成"，不是"这条线不生产"；
  //   LAB_BUSY 等     —— 作业根本没起来。
  // 2026-10-11 那四条红就是把第二种读成了第一种：点名化工厂复验 347.6/分、0 条问题，而梯子换到低温厂
  // 时 3 条问题全是石油气 —— 线没变，是台架不肯证。所以这里把 state 与没证明成的那几股一起打出来。
  const probs = asArr(done.supply_problems).map((x) => x.fluid + ":" + x.why).join(" ");
  const vd = asArr(done.verdicts).map((x) => (x.item || x.fluid) + "=" + x.measured_per_min).join(" ");
  console.log("  台架收场: state=" + done.state + " 跑了 " + done.elapsed_ticks + "/"
    + Number((done.elapsed_ticks || 0) + (done.remaining_ticks || 0)) + " tick"
    + " 没证明的料[" + (probs || "无") + "] 读数[" + (vd || "无") + "]");
  return { started: started.data, done };
};

grant(true);
try {
  // ---- 1) 两种料进 → 一件固体出（水 + 石油气 → 硫酸，化工厂）
  const s = call("card_example", { recipe: "sulfur", machines: Number(process.env.MFP_N || 3), force: "player", machine: "chemical-plant" });
  const sd = s.data || {};
  const ins = asArr(sd.fluid_in);
  // 把"这一发用的是哪台机器、口子在哪一面"打在**读数之前**：昨晚那四条空读数就是栽在"同一张牌的机器
  // 换了台、面换了一侧"上，而门禁里先前只打台架那本账，牌那一侧长什么样全靠事后猜（`face:"south"`、
  // `row:49..57` 那几行其实是隔壁作业的 —— 没有这一行打印，我把它当成了硫酸这张卡的读数）。
  console.log("  硫酸这张牌: 机器=" + JSON.stringify(sd.machine || (sd.components || {}).machine)
    + " style=" + sd.style + " 件数=" + asArr(sd.entities).length
    + " 进料面=" + JSON.stringify(ins.map((e) => [e.fluid, e.face, e.off]))
    + " 带=" + JSON.stringify(sd.belt || (sd.components || {}).belt));
  const colsOf = (e) => asArr(e.ports).map((p) => Math.floor(p.position.x));
  check("水 + 石油气 → 硫酸这一发铺得出，形状是两面各空一行的那一档",
    s.ok && sd.style === "fluid-through", JSON.stringify([s.code, s.msg, sd.style]).slice(0, 300));
  check("两种进料各报一条，每条一台机器一根柱子（3 台 = 3 个口）",
    ins.length === 2 && ins.every((e) => e.machines === 3 && asArr(e.ports).length === 3),
    JSON.stringify(ins.map((e) => [e.fluid, e.machines, asArr(e.ports).length, e.face, e.off])));
  const allCols = ins.flatMap(colsOf).sort((a, b) => a - b);
  let minGap = 99;
  for (let i = 1; i < allCols.length; i++) minGap = Math.min(minGap, allCols[i] - allCols[i - 1]);
  check("柱与柱之间至少隔 2 格（隔 1 就是一张管网，两种料在里面混）",
    minGap >= 2, `列 ${JSON.stringify(allCols)} 最小差 ${minGap}`);
  check("两种料在**同一面**、格号差 2（原型读回来的那一手，不是并到两面去糊过去的）",
    ins.every((e) => e.face === ins[0].face) && Math.abs(ins[0].off - ins[1].off) === 2,
    JSON.stringify(ins.map((e) => [e.fluid, e.face, e.off])));
  const sb = benchOne(sd, 150);
  const sv = asArr((sb.done || {}).verdicts);
  const dbg = (k) => JSON.stringify((sb.done || {})[k]);
  console.log("  台架 verdicts: " + JSON.stringify(sv).slice(0, 300)
    + " | " + JSON.stringify([sb.code, sb.msg]).slice(0, 200));
  console.log("  台架那本账: fed=" + dbg("fed") + " fed_blocked=" + dbg("fed_blocked")
    + " unwired=" + String(dbg("unwired")).slice(0, 260)
    + " working=" + dbg("working") + " starved=" + dbg("starved_furnaces")
    + " 别的键=" + Object.keys(sb.done || {}).join(","));
  console.log("  machine_status=" + String(dbg("machine_status")).slice(0, 420)
    + " | supply_faces=" + String(dbg("supply_faces")).slice(0, 260)
    + " | probed=" + String(dbg("probed")).slice(0, 260));
  console.log("  diagnostics=" + String(dbg("diagnostics")).slice(0, 520)
    + " | delivered=" + String(dbg("delivered")).slice(0, 200)
    + " | pay_fraction=" + String(dbg("pay_fraction")).slice(0, 120));
  console.log("  supply_faces=" + String(dbg("supply_faces")).slice(0, 520)
    + " | supply_problems=" + String(dbg("supply_problems")).slice(0, 420));
  console.log("  drain=" + String(dbg("drain")).slice(0, 520)
    + " | missing_entities=" + String(dbg("missing_entities")).slice(0, 200)
    + " | produced=" + String(dbg("produced")).slice(0, 200));
  check("...而且这条线真的在产（两种料都到了机器才会开始工艺 —— 少一种就一直是 0）",
    sv.some((v) => v.kind === "item" && Number(v.measured_per_min) > 0 && Number(v.ratio) >= 0.9),
    JSON.stringify([sb.code, sb.msg, sv]).slice(0, 420));
  console.log("  硫酸这条稳态 " + String((sv[0] || {}).measured_per_min) + "/分 对声称 "
    + String((sv[0] || {}).claimed_per_min) + "/分（台架那本账 drain="
    + JSON.stringify((sb.done || {}).drain || {}) + "）");

  // ---- 1b) **同一发硫酸、点名低温厂**（5×5、南面三只口）：这一发是 #29 那一手的验收。
  // 从前这里铺得出、台架永远回 `CARD_ROW_NOT_FED`（2026-10-11 量到的原话：三种问题全是石油气，
  // 而隔壁那一列水进去了）。原因不是灌量、不是气体压力，是**分口**：原型写"三只箱、各占一格"，
  // 建起来之后运行时只有 2 只箱，其中第一只自己占 south −2 与 south 0 **两格**
  // （`dev/port_groups_probe.js`）。牌照原型排 ⟹ 两种液体落到同一只箱体 ⟹ 一只箱同一时刻只装一种液体。
  // 现在分口按建起来的机器分：gas 应当改到 **+2** 那一格（另一只箱），两种液体各有一只自己的箱。
  const cy = call("card_example", { recipe: "sulfur", machines: 3, force: "player",
    machine: "cryogenic-plant" });
  const cyd = cy.data || {};
  const cyIn = asArr(cyd.fluid_in);
  const offs = cyIn.map((e) => e.off);
  check("低温厂这一发：两种液体分到**两只不同的箱体**（各自的格号不同，且都在南面）",
    cy.ok && cyIn.length === 2 && new Set(offs).size === 2
    && cyIn.every((e) => e.face === cyIn[0].face && asArr(e.ports).length === 3),
    JSON.stringify([cy.code, cy.msg, cyIn.map((e) => [e.fluid, e.face, e.off])]).slice(0, 340));
  const cb2 = benchOne(cyd, 150);
  const cd2 = cb2.done || {};
  const cv2 = asArr(cd2.verdicts);
  const ms2 = asArr(cd2.machine_status);
  const bothIn = ms2.filter((m) => {
    const fl = asArr(m.boxes).map((b) => b.fluid);
    return fl.includes("water") && fl.includes("petroleum-gas");
  }).length;
  check("...而且这台机器**两种液体都喝到了**（每台自己的两只箱体里各有那一种）",
    cd2.state === "done" && bothIn === ms2.length && ms2.length === 3,
    JSON.stringify([cd2.state, cd2.reason, bothIn, ms2.map((m) => asArr(m.boxes)
      .map((b) => b.fluid + "/" + b.units).join("+"))]).slice(0, 420));
  // 速率这一条只要"> 0"：从前它是 0（牌死了）。到 87.6% 而不是 96% 的那一截是**运力**问题
  // （`per_arm_min=150` 至今是拍的 —— #24），不是这一手分口的问题，别把它混进来当同一个红灯。
  check("...这条线**在产**（从前这张牌铺得出、台架量到 0）",
    cv2.some((v) => Number(v.measured_per_min) > 0),
    JSON.stringify([cd2.state, cd2.reason, cv2]).slice(0, 320));
  const cd2out = (cd2.drain || {}).card_outlet || {};
  console.log("  低温厂这条稳态 " + String((cv2[0] || {}).measured_per_min) + "/分 对声称 "
    + String((cv2[0] || {}).claimed_per_min) + "/分（比率 " + String((cv2[0] || {}).ratio)
    + "）｜台架收口 " + JSON.stringify((cd2.drain || {}).arm || "fast-inserter") + "×"
    + String((cd2.drain || {}).arms) + "=" + String((cd2.drain || {}).ceiling_per_min)
    + " 对牌自己的出口 " + String(cd2out.arms) + "×" + String(cd2out.arm) + "="
    + String(cd2out.per_min) + "/分 逐档=" + JSON.stringify(cd2out.per_tier));
  // §0 第十六条那一条误读的防线：**读数旁边必须挂着这张卡自己的出口**，否则拿 `measured_per_min` 的人
  // 会把台架那套更快的收口当成这条线的速率（同一发低温厂：台架 630.4/分，牌自己那 6 只臂报的却是 432/分）。
  // 2026-10-11 夜追到底：那 432 是**算错的价**，不是这条线的上限 —— 形状按 `by_reach[e]` 放第 e 条成品行的臂，
  // 而 `arm_ceiling` 从前拿 caller 挑的**那一档**乘全部臂。现在 `per_tier` 逐档给数（打印在上面这行）。
  // 只钉"永远在的那两格"（臂档与只数）。`per_min`/`binds` 要**复位之后量过臂**才有数 —— 那是 #30 的口径
  // （`lab_reset` 按设计忘掉实测缓存），把它混进这条断言，套件就变成在测"谁恰好先量过臂"。
  check("...台架的 `drain` 旁边交出**这张卡自己的出口**（臂档与只数，不是台架那两只）",
    cd2out.arm === "long-handed-inserter" && Number(cd2out.arms) === 6,
    JSON.stringify([cd2.drain, (cd2.verdicts || [{}])[0]]).slice(0, 420));

  // ---- 2) 两种料进 + 一种液体出（水 + 重油 → 轻油）：柱子在一面，成品行在对面
  if (!process.env.MFP_FAST) {
  const h = call("card_example", { recipe: "heavy-oil-cracking", machines: 3, force: "player", machine: "chemical-plant" });
  const hd = h.data || {};
  check("水 + 重油 → 轻油：柱子与成品那一行管子各在**相对的两面**",
    h.ok && asArr(hd.fluid_in).length === 2 && hd.fluid_out
    && asArr(hd.fluid_in).every((e) => e.face !== hd.fluid_out.face),
    JSON.stringify([h.code, (asArr(hd.fluid_in).map((e) => [e.fluid, e.face])), hd.fluid_out
      && [hd.fluid_out.fluid, hd.fluid_out.face]]).slice(0, 300));
  const hb = benchOne(hd, 150);
  const hv = asArr((hb.done || {}).verdicts);
  const hrows = asArr((hb.done || {}).fluid_drain_rows);
  console.log("  裂解 verdicts: " + JSON.stringify(hv).slice(0, 260)
    + " | 成品行: " + JSON.stringify(hrows).slice(0, 220));
  check("...这条也从**卡自己铺的那一行管子**量到了轻油（不是从机器嘴里抽）",
    hv.some((v) => v.kind === "fluid" && v.fluid === "light-oil" && Number(v.measured_per_min) > 0)
    && hrows.length === 1 && hrows[0].carried === true && asArr(hrows[0].segments).length >= 1,
    JSON.stringify([hb.code, hb.msg, hv, hrows]).slice(0, 420));

  // ---- 3) 另一种两件都齐的线（氨 + 原油 → 固体燃料）：进料面只有列，固体成品走对面那条带子
  const c = call("card_example", { recipe: "solid-fuel-from-ammonia", machines: 2, force: "player", machine: "chemical-plant" });
  const cd = c.data || {};
  check("氨 + 原油 → 固体燃料铺得出，两口在同面差 2（这台机器一件固体料都不吃）",
    c.ok && asArr(cd.fluid_in).length === 2
    && asArr(cd.fluid_in).every((e) => e.face === asArr(cd.fluid_in)[0].face)
    && Math.abs(asArr(cd.fluid_in)[0].off - asArr(cd.fluid_in)[1].off) === 2,
    JSON.stringify([c.code, c.msg, (asArr(cd.fluid_in).map((e) => [e.fluid, e.face, e.off]))]).slice(0, 320));
  const cb = benchOne(cd, 150);
  const cv = asArr((cb.done || {}).verdicts);
  console.log("  固体燃料 verdicts: " + JSON.stringify(cv).slice(0, 260));
  check("...这条也在产（成品是固体，从那条成品带子上收 —— 两种料都进了机器才动）",
    cv.some((v) => v.kind === "item" && Number(v.measured_per_min) > 0),
    JSON.stringify([cb.code, cb.msg, cv]).slice(0, 420));

  // ---- 3b) 两种液体进**又**吃固体料：列占住喝水那一面，固体两族整体挪到**没有管道**那一面、共用一行臂。
  // 这一格先前按名拒（`STEMS_AND_FEED_ROWS`），2026-10-10 做掉了：律与 `fluid-back` 同一式（成品排里、
  // 进料排外、臂各占一列），只是"水在背面那一行管"换成"水在一排列"。挪得对不对**只能在地上量**：这条线
  // 要两种液体 + 一件固体料**都到了机器**才开始工艺，而成品要那条成品带子收得走才算数 —— 少任何一行，
  // 量到的就是 0。
  const mixed = call("card_example", { recipe: "lithium", machines: 2, force: "player", machine: "chemical-plant" });
  const md = mixed.data || {};
  const mIns = asArr(md.fluid_in);
  check("锂这条（两种液体进 + 一件固体进 + 一件固体出）铺得出，形状还是两面各空地的那一档",
    mixed.ok && md.style === "fluid-through" && mIns.length === 2
    && mIns.every((e) => asArr(e.ports).length === 2),
    JSON.stringify([mixed.code, mixed.msg, mIns.map((e) => [e.fluid, e.face])]).slice(0, 320));
  // 几何那一判从**铺出来的件**里读，不信牌上那句自报：管子那一面与带子那一面必须在机器箱体的两侧，
  // 而两族的臂必须站在**同一行**（共用一行臂 = 这一档挪面的全部意思）。
  const mEnts = asArr(md.entities);
  const mYs = (re) => [...new Set(mEnts.filter((e) => re.test(String(e.name)))
    .map((e) => Math.floor(e.position.y)))];
  const body = mEnts.filter((e) => !/pipe|transport-belt|inserter|chest|lamp|combinator|panel/.test(String(e.name)));
  const bodyYs = body.map((e) => Math.floor(e.position.y)).sort((a, b) => a - b);
  const mid = bodyYs.length ? (bodyYs[0] + bodyYs[bodyYs.length - 1]) / 2 : null;
  const sideOf = (ys) => ys.every((y) => y < mid) ? "north" : ys.every((y) => y > mid) ? "south" : "mixed";
  const beltYs = mYs(/transport-belt/), pipeYs = mYs(/^pipe$/), armYs = mYs(/inserter/);
  // 这一判要钉的是**两侧**，不是"管子只占两行"：0.93.0 起同一种液体在喝水那一面连成一段（他提的第 2 条），
  // 管子因此多占几行（第一位补一行 + 连接行，第二位再往下错三格走穿地管）。原来写成 `pipeYs.length === 2`
  // 是把"一台一根柱子、各自两格深"那件旧事实当成了几何规矩。
  check("...带子与管子各在机器的一侧（列占住喝水那一面，固体两族在对面）",
    bodyYs.length > 0 && beltYs.length === 2 && pipeYs.length >= 2
    && sideOf(beltYs) !== "mixed" && sideOf(pipeYs) !== "mixed"
    && sideOf(beltYs) !== sideOf(pipeYs),
    JSON.stringify([bodyYs, { beltYs, pipeYs, armYs }]).slice(0, 420));
  check("...两族共用**同一行**臂：进料臂与成品臂站同一格深、各占一列",
    armYs.length === 1 && sideOf(armYs) === sideOf(beltYs),
    JSON.stringify({ armYs, beltYs, mid }).slice(0, 300));
  const mb = benchOne(md, 150);
  const mv = asArr((mb.done || {}).verdicts);
  console.log("  锂 verdicts: " + JSON.stringify(mv).slice(0, 300)
    + " | " + JSON.stringify([mb.code, mb.msg]).slice(0, 160));
  check("...而且这条线真的在产（两种液体与那件固体料都到了机器、成品收得上来才不为 0）",
    mv.some((v) => v.kind === "item" && Number(v.measured_per_min) > 0 && Number(v.ratio) >= 0.9),
    JSON.stringify([mb.code, mb.msg, mv, (mb.done || {}).machine_status]).slice(0, 420));
  // 同一手另外两条（同一种挪面，机器不同）：只问牌铺不铺得出、带子是不是真在**没有管道**那一面 ——
  // 台架那一条已经量过律了，四条各跑一遍台架在这一台 1.9G 的机上是自找的假失败。
  for (const rec of ["ammonia-rocket-fuel", "casting-low-density-structure"]) {
    const x = call("card_example", { recipe: rec, machines: 2, force: "player" });
    const xd = x.data || {};
    const xe = asArr(xd.entities);
    const xb = xe.filter((e) => !/pipe|transport-belt|inserter|chest|lamp|combinator|panel/.test(String(e.name)))
      .map((e) => Math.floor(e.position.y)).sort((a, b) => a - b);
    const xmid = xb.length ? (xb[0] + xb[xb.length - 1]) / 2 : null;
    const ys = (re) => [...new Set(xe.filter((e) => re.test(String(e.name))).map((e) => Math.floor(e.position.y)))];
    const sOf = (v) => v.every((y) => y < xmid) ? "north" : v.every((y) => y > xmid) ? "south" : "mixed";
    check(`${rec} 也走同一手：铺得出，带子在空的那一面、列在喝水的那一面`,
      x.ok && xd.style === "fluid-through" && asArr(xd.fluid_in).length === 2
      && ys(/transport-belt/).length >= 1 && sOf(ys(/transport-belt/)) !== "mixed"
      && sOf(ys(/^pipe$/)) !== "mixed" && sOf(ys(/transport-belt/)) !== sOf(ys(/^pipe$/)),
      JSON.stringify([rec, x.code, x.msg, { belts: ys(/transport-belt/), pipes: ys(/^pipe$/) }]).slice(0, 380));
  }
  // `concrete-from-molten-iron` 也在这 6 条里，但**这一发（2 台）装不进那一面**：它一台出 10 件混凝土，
  // 2 台这一发成品折成 **2** 条带，加上 1 条进料带 = 共用那一行臂要 3 档，而这台安装只有 reach 1、2。
  // **同一张牌按 4 台问就铺得出**（带的档位随台数换，行数是从流量折的）—— 覆盖率那把尺按 4 台数，
  // 它因此进了"铺得出"那 285 条。所以这里钉的是"2 台那一发拒在哪一格"，不是"这条线永远铺不出"，
  // 下面第二条就把 4 台那一发一起钉住，免得这一条被读成后者。
  // `concrete-from-molten-iron` 也在这 6 条里，但**这一发（2 台）装不进那一面**：它一台出 10 件混凝土，
  // 2 台这一档流量把成品折成 **2** 条带，加上 1 条进料带 = 共用那一行臂要 3 档，而这台安装只有 reach 1、2。
  // 同一张牌按 4 台问就铺得出来了（覆盖率那一把尺按 4 台数，它因此进了"铺得出"那 285 条）—— 行数是从
  // **流量**折出来的，所以这里钉的是"2 台那一发拒在哪一格"，不是"这条线永远铺不出"。
  const wide = call("card_example", { recipe: "concrete-from-molten-iron", machines: 2, force: "player" });
  const wd = wide.detail || {};
  const wantsThree = Number(wd.need_reach) === 3 || asArr(wd.needs).map(Number).includes(3);
  check("熔融铁→混凝土按 2 台问时要的是第 3 档臂（这台安装只有 reach 1、2），拒因换成了臂档",
    !wide.ok && wide.code === "ARM_TIER_MISSING" && wantsThree,
    JSON.stringify([wide.code, wide.msg, { need_reach: wd.need_reach, needs: wd.needs,
      tiers: wd.arm_reach_tiers || wd.tiers, F: wd.F, P: wd.P }]).slice(0, 320));
  // 同一张牌按 4 台问，在**这个借窗口**里还是要第 3 档臂（上面那条就是 4 台那一发读到的）。
  // 而覆盖率那一把尺（`coverage_sweep` 把 252 项研究全打开）把它算进"铺得出"的 285 条 —— 两处不是矛盾：
  // 带子档位越高，成品折成的行数越少，共用那一行臂要的档数就越少。**所以这一条的账要按开放集说，
  // 不只按台数说** —— 这里不再断言"4 台就铺得出"（那句是我从全研究那一趟反推的，借窗口窄时就假了）。

  // ---- 3d) 两面**都**被管道占住的那一发（fluoroketone：两种液体进 + 一种液体出 + 两种固体料）。
  // 这一档**仍是按名拒**，而且这里把"为什么拒"钉成一条核对得动的断言：跨过去那一手（列从固体行底下走：
  // 贴机器一只穿地管 + 固体行外面一只）两扇门都量通了 —— `dev/port_to_ground_probe.js`（贴口的穿地管与
  // 机器口算接上：连接数 1，与普通管基线同一格；不调成对 API 也自己成对）、`dev/pipe_cross_probe.js`
  // （背对背一对隔 2..8 都成对，被跨的格站着整排带子也不挡水）—— 但把列真做成跨的那一版，台架量到
  // `measured_per_min=0`、`carried=false`：牌铺得出、机器收不到料。一张不生产的牌比一句按名拒坏，
  // 所以照旧拒，先量明白"跨过去的列到底喂不喂得进"（`dev/待办.md` §0 第 28 条）。
  const hop = call("card_example", { recipe: "fluoroketone", machines: 2, force: "player" });
  check("两面都被管道占住的那一发按名拒，拒因说的是「列与固体行抢同一片地」（跨那一手没放开）",
    !hop.ok && (hop.code === "STEMS_AND_FEED_ROWS" || hop.code === "STEMS_AND_PRODUCT_ROWS"),
    JSON.stringify([hop.code, hop.msg]).slice(0, 340));
  // ---- 3c) 三种液体一起出（炼油：水 + 原油 → 重油 / 轻油 / 石油气）。这一发是第四簇的全部意思：
  // 从前它被 `LANE_DRAINS_ONE_FLUID` 无条件拒，那句"一条线只吐一种液体"说的其实是我只会铺一行管子；
  // 一口一列那一手反过来用在出料面，三只口（同面差 2 格）就天生三段 —— 与他在真档里数到的 377/382/365
  // 同一种"从头到尾没并过"。
  const three_out = call("card_example", { recipe: "advanced-oil-processing", machines: 2, force: "player", machine: "oil-refinery" });
  const td = three_out.data || {};
  const tout = asArr(td.fluid_out);
  check("炼油两种液体进 + 三种液体出：出料那一侧每一种各报一条、每台一根柱子",
    three_out.ok && tout.length === 3 && tout.every((e) => e.machines === 2
      && asArr(e.ports).length === 2 && e.face === tout[0].face)
    && asArr(td.fluid_in).length === 2,
    JSON.stringify([three_out.code, three_out.msg, tout.map((e) => [e.fluid, e.face, e.off])]).slice(0, 340));
  const tb = benchOne(td, 150);
  const trows = asArr((tb.done || {}).fluid_drain_rows);
  const tv = asArr((tb.done || {}).verdicts);
  console.log("  炼油 verdicts: " + JSON.stringify(tv).slice(0, 320)
    + " | 三行柱子: " + JSON.stringify(trows).slice(0, 300));
  // 出料那一侧**也并了**（2026-10-12 他补的那一句："先把出料侧也并了吧"）。于是这一发台架读到的是
  // 三种液体**各一处**收口，每一处后面站着两台机器：`shared` 说"这一处的量是分不回来的总数"，
  // `columns` 是两台各自柱头的读数（这一格里有没有这种液体、段号是不是接口那一个），`columns_all`
  // 才是"两台都真接进了这张管网"那一句 —— 并管之后唯一还分得清"台"的证据，读的是柱头而不是抽液口。
  // 从前那一版（每台每料一段、六处收口）没有丢：`fluid_merge=in` 点得到，答案级那一发由
  // `dev/fluid_manifold_probe.js` 钉着。
  check("...台架读到三种成品各**一处**收口（出料侧并了），而每一处后面两台的柱头都湿、都与接口同一段号",
    trows.length === 3 && trows.every((r) => r.carried === true && r.shared === true
      && asArr(r.columns).length === 2 && r.columns_all === true
      && asArr(r.segments).length >= 1 && r.merged_with === undefined)
    && (() => {
      const seen = {};
      for (const r of trows) for (const s of asArr(r.segments)) {
        if (seen[s] && seen[s] !== r.fluid) return false;
        seen[s] = r.fluid;
      }
      return new Set(trows.flatMap((r) => asArr(r.segments))).size === 3;
    })(),
    JSON.stringify([tb.code, tb.msg, trows.map((r) => [r.fluid, r.shared, r.columns_all,
      asArr(r.columns).map((c) => [c.wet, c.same, c.segment]), asArr(r.segments)])]).slice(0, 460));
  check("...三种液体各自的读数都在（不是把三份当成一份数）",
    ["heavy-oil", "light-oil", "petroleum-gas"].every((f) =>
      tv.some((v) => v.kind === "fluid" && v.fluid === f && Number(v.measured_per_min) > 0)),
    JSON.stringify(tv).slice(0, 420));

  // ---- 4) 点名一种没有这一格的形状时，按名拒说的得是真话（不是"液体进不了线"）
  const named = call("card_example", { recipe: "sulfur", machines: 4, style: "stacked", force: "player", machine: "chemical-plant" });
  check("点名 stacked 时按名拒，拒的是「这一档那一面留给带子、插不进列」，不是「液体铺不出」",
    !named.ok && named.code === "LANE_FEEDS_ONE_FLUID"
    && String((named.detail || {}).style || "") === "stacked"
    && (named.detail || {}).shape_that_can === "fluid-through",
    JSON.stringify([named.code, named.detail]).slice(0, 320));
  }
} finally {
  grant(false);   // 按读回来的那一份还，不是清零
}

console.log("  还回去之后: " + lua(`local f = game.forces.player
rcon.print(table.concat({ "oil-refinery=" .. tostring((f.recipes["oil-refinery"] and f.recipes["oil-refinery"].enabled)),
  "chemical-plant=" .. tostring((f.recipes["chemical-plant"] and f.recipes["chemical-plant"].enabled)) }, " "))`)
  + " | before=" + JSON.stringify(before));
const paused = lua("rcon.print(tostring(game.tick_paused))");
check("世界时钟解开（这把探针不欠一条暂停的世界）", /false/.test(paused), paused);
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
