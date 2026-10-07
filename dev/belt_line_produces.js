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

const bench = (card, seconds) => {
  call("lab_reset");
  const started = call("card_lab", { card, seconds: seconds || 150, speed: 20 });
  if (!started.ok) return { started: started };
  let status = {};
  for (let i = 0; i < 20; i++) {
    sleep(2000);
    status = call("lab_status", {}).data || {};
    if (status.state !== "running") break;
  }
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
console.log(`== card: ${d.style}，${asArr(d.entities).length} 件，箱子 ${(d.parts || {}).chests}，`
  + `进料带 ${feedLines.length} 件 / 成品带 ${productLines.length} 件，牌上 ${asArr((d.head || {}).lanes).length} 种料`);
check("这张卡是零箱子的：没有 in-port 可灌，但有按行编号的进料带与成品带",
  ex.ok === true && (d.parts || {}).chests === 0 && asArr((d.ports || {}).in).length === 0
  && feedLines.length > 0 && productLines.length > 0
  && feedLines.every((e) => Number(e.line) >= 1),
  JSON.stringify([ex.code, ex.msg, d.parts, (d.ports || {}).in, feedLines.length,
    productLines.length]).slice(0, 240));

const run = bench(d);
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

// 反面对照：一根成品带都没有的卡，台架读不到产物 —— 它必须按名拒，而不是量出一个零当成结论。
const noProduct = JSON.parse(JSON.stringify(d));
noProduct.entities = asArr(d.entities).filter((e) => e.role !== "product_line");
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
