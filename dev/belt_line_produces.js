// 一条零箱子的线，真的在生产吗？—— 由模自己的台架回答，不是由形状层的一句注释回答。
//
// 为什么必须有这一条：玩家的要求是「可选排列样式的前提是先满足产线能正常生产」。带箱子的四种排法删掉
// 之后，台架原来那套「往线头的箱子里灌料」对**任何**一条本模铺得出的线都不成立了 —— 裸带线头没有
// in-port。于是台架学会了做玩家自己那个动作：在每根进料带的最西一格，把牌上点了名的那种料插进对应的
// 那一股（`card_lab` 的 `rig.lane_feeds`），并在成品带东头接一只取货臂与一只收箱去读产物（那是台架的
// 管道，和 gens 同一类，收尾一起拆）。
//
// 这一条断言的是那扇门真的量得到东西：起得来、喂得进、做得出、判得下，而且收摊之后地上不留零件。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("belt_line_produces");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "20000" };
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 200) }; }
};
const lua = (src) => execFileSync("node", [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV }).trim();
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 400)}`);
  ok ? pass++ : fail++;
};

// 牌要电路科技；这是世界状态，借了要还（和别的套件同一写法）。
const netWas = /^true$/.test(lua(`local t = game.forces.player.technologies["circuit-network"]
  rcon.print(t and tostring(t.researched) or "absent")`));
lua(`local f = game.forces.player local t = f.technologies["circuit-network"]
if t then t.researched = true end rcon.print("ok")`);

const bench = (card, seconds, on_running) => {
  call("lab_reset");
  const started = call("card_lab", { card, seconds: seconds || 150, speed: 20 });
  if (!started.ok) return { started: started };
  let status = {};
  // 读地上那一手要赶在拆台之前，而窗口是快进跑的（state 很快就不是 running），所以不挑状态：
  // 起手读一次、每轮询读一次、收尾前再读一次，读到算数（`splitRead` 自己报 true 就不再读）。
  let probed = false;
  const tryProbe = () => { if (on_running && !probed && on_running() === true) probed = true; };
  tryProbe();
  for (let i = 0; i < 20; i++) {
    sleep(2000);
    status = call("lab_status", {}).data || {};
    tryProbe();
    if (status.state !== "running") break;
  }
  tryProbe();
  const stopped = call("lab_stop", {});
  // 窗口自己跑完时 `lab_stop` 会说「没东西可停」，那份判定留在作业记录里由 `lab_status` 交出来 ——
  // 两条路都要读得到，否则这条门禁会红在一次正常的收尾上。
  const done = (stopped.ok && stopped.data) ? stopped.data : status;
  call("lab_reset");
  return { started: started.data, done: done };
};

const ex = call("card_example", { recipe: "iron-plate", machines: 6, heads: "belt", force: "player" });
const d = ex.data || {};
const feedLines = asArr(d.entities).filter((e) => e.role === "feed_line");
const productLines = asArr(d.entities).filter((e) => e.role === "product_line");
// 成品有两种走法：独占一根带子（`role == "product_line"`），或者借某根进料行离机器远的那一股
// （带子上打着 `product_lane`/`product_item`，`dev/shared_row_probe.js` 量的那条律）。这一发落到了
// 后一种，所以"有没有成品可读"必须两种都认，否则这条门禁会把一条正在出料的线判成缺件。
const sharedLines = asArr(d.entities).filter((e) => e.product_lane !== undefined && e.product_lane !== null);
console.log(`== card: ${d.style}，${asArr(d.entities).length} 件，箱子 ${(d.parts || {}).chests}，`
  + `进料带 ${feedLines.length} 件 / 成品带 ${productLines.length} 件 / 借来的成品股 ${sharedLines.length} 件，`
  + `牌上 ${asArr((d.head || {}).lanes).length} 种料`);
check("这张卡是零箱子的：没有 in-port 可灌，但进料带按行编了号，成品也有一股可走（独占的行或借来的股）",
  ex.ok === true && (d.parts || {}).chests === 0 && asArr((d.ports || {}).in).length === 0
  && feedLines.length > 0 && (productLines.length + sharedLines.length) > 0
  && feedLines.every((e) => Number(e.line) >= 1),
  JSON.stringify([ex.code, ex.msg, d.parts, (d.ports || {}).in, feedLines.length,
    productLines.length, sharedLines.length]).slice(0, 240));

// 共用那一行的股道，要**常速**读得到：快进那一档（speed 20）里 rcon 的读数赶不上世界，
// 三趟读回来都是"地上没有带子"（试过，写在这免得下一个人又照快进那趟改）。所以这一趟单独走：
// 20 个游戏秒、倍速 1，每 2 秒读一次，读到两股各有货那一格为止。
let laneSplit = null;
const splitRead = () => {
  // 按**类型**数带子，不按型号名：这一发的带子是哪一档由挑带子那一遍决定（`components.belt`），
  // 写死 "transport-belt" 会在别的档上读出零 —— 那是仪器的错，不是地上的事实。
  const out = lua(`local s = game.surfaces["arch-lab"] or game.surfaces["arch-sandbox"]
local belts, split, mixed, seen = 0, 0, 0, 0
for _, b in ipairs(s.find_entities_filtered{ type = "transport-belt", limit = 500 }) do
  belts = belts + 1
  local l1, l2 = {}, {}
  pcall(function() for _, it in ipairs(b.get_transport_line(1).get_contents()) do l1[it.name] = (l1[it.name] or 0) + it.count end end)
  pcall(function() for _, it in ipairs(b.get_transport_line(2).get_contents()) do l2[it.name] = (l2[it.name] or 0) + it.count end end)
  local ore1, pla1 = (l1["iron-ore"] or 0) > 0, (l1["iron-plate"] or 0) > 0
  local ore2, pla2 = (l2["iron-ore"] or 0) > 0, (l2["iron-plate"] or 0) > 0
  if (ore1 or pla1) and (ore2 or pla2) then
    seen = seen + 1
    if (ore1 and pla1) or (ore2 and pla2) then mixed = mixed + 1 else split = split + 1 end
  end
end
rcon.print("belts=" .. belts .. " seen=" .. seen .. " split=" .. split .. " mixed=" .. mixed)`);
  laneSplit = String(out).split("\n")[0];
  console.log("   (股道读数) " + laneSplit);
  return /seen=[1-9]/.test(laneSplit);
};
const run = bench(d);
(function laneRun() {
  call("lab_reset");
  const started = call("card_lab", { card: d, seconds: 20, speed: 1 });
  if (started.ok) {
    for (let i = 0; i < 12 && splitRead() !== true; i++) sleep(2000);
    call("lab_stop", {});
  } else {
    console.log("   (常速那一趟起不来) " + started.code + " " + String(started.msg || "").slice(0, 80));
  }
  call("lab_reset");
})();
const done = run.done || {};
check("台架接得上这种线：不再按「没有端口」拒，作业起得来",
  !!(run.started && run.started.state),
  JSON.stringify([run.started && run.started.code, run.started && run.started.msg]).slice(0, 200));
check("...喂进去的东西没有一手被挡回来（fed_blocked 是零）",
  Number(done.fed || 0) > 0 && Number(done.fed_blocked || 0) === 0,
  JSON.stringify([done.fed, done.fed_blocked, done.produced]).slice(0, 200));
check("...这条线真的做出了成品",
  Number(done.produced || 0) > 0,
  JSON.stringify([done.produced, done.state, done.measured_per_min]).slice(0, 200));
const verdicts = asArr(done.verdicts);
// 共用那一行的那一股真分开没有：窗口还在跑的时候读了地上的带子，钉的是"同一格上矿与板分在两条 line"，
// 而不是它们挤在同一股里。这里**不**钉"成品在第几号"—— 那个号随带子朝向换（`dev/lane_side_probe.js`
// 量的正是这件事），牌上的号与地上那股的关系另有 `layout_ledger` 那一条按奇偶钉。
check("...而这一行两样料各占一股：同一格上矿与板分在两条 line，没有一格把它们挤进同一股",
  /seen=[1-9]/.test(String(laneSplit)) && /split=[1-9]/.test(String(laneSplit))
  && /mixed=0\b/.test(String(laneSplit)),
  String(laneSplit));
check("...台架按这张卡自己的契约下了判定（每条 claim 都被量过，不是空表）",
  verdicts.length >= 1 && verdicts.every((v) => typeof v.met === "boolean"
    && Number(v.claimed_per_min) > 0 && v.measured_per_min !== undefined),
  JSON.stringify(verdicts.map((v) => [v.item, v.claimed_per_min, v.measured_per_min, v.met]))
    .slice(0, 260));
// 形状层说「这条线一分钟出多少」，台架量的是「跑起来真出了多少」。这里不钉一个绝对数 —— 窗口长度、
// 臂的实测速率与电力都是存档的事；钉的是同一件事的两种说法在同一个量级上。
check("...量出来的速率与这张卡声称的是同一个量级（不是零，也不是它的两倍）",
  Number(done.expected_per_min || 0) > 0
  && Number(done.measured_per_min || 0) >= Number(done.expected_per_min) * 0.3
  && Number(done.measured_per_min) <= Number(done.expected_per_min) * 2.2,
  JSON.stringify([done.measured_per_min, done.expected_per_min,
    done.ratio_measured_over_expected, done.delivered, done.pay_fraction]).slice(0, 240));

// 反面对照：成品一处可走的卡（独占的成品行抽掉、借来的那一股也抹掉标记），台架读不到产物 ——
// 它必须按名拒，而不是量出一个零当成结论。
const noProduct = JSON.parse(JSON.stringify(d));
noProduct.entities = asArr(d.entities)
  .filter((e) => e.role !== "product_line")
  .map((e) => ({ ...e, product_lane: undefined, product_item: undefined }));
const refused = bench(noProduct);
check("抽掉成品带之后台架按名拒（而不是量出一条零产率的线当成结论）",
  refused.started && refused.started.ok === false
  && ["CARD_NO_PORTS", "CARD_NO_FEEDS", "CARD_DOES_NOT_LINT"].includes(refused.started.code)
  && Number((refused.done || {}).produced || 0) === 0,
  JSON.stringify([refused.started && refused.started.ok, refused.started && refused.started.code,
    refused.started && refused.started.msg]).slice(0, 240));

const bs = (call("bench_state", {}).data) || {};
const pads = Object.keys(bs.surfaces || {}).map((k) => Number((bs.surfaces[k] || {}).pad_entities || 0));
check("台架收干净：作业结束之后两张台架地上都不留零件",
  pads.length >= 1 && pads.every((n) => n === 0),
  JSON.stringify([pads, bs.surfaces]).slice(0, 220));

if (!netWas) lua(`local f = game.forces.player local t = f.technologies["circuit-network"]
if t then t.researched = false end rcon.print("ok")`);
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
