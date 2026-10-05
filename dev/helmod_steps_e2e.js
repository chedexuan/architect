// 逐步判断日志的门禁（玩家 2026-10-06 要求：出问题他能指出是哪一步的逻辑不对）。
//
// 这里断言的不是"某个形状对不对"，而是"每一步有没有留下可指认的一行"：编号连续、每步带着它用的数字、
// 关键几步（配方 / 形状候选 / 线卡 / 拆线 / 落一条线 / 出件）都在，服务器日志里也能 grep 到同一批行。
// 形状本身对不对由 layout_ledger 与 belt_head_e2e 管；这套管的是"说不清楚"这件事本身。
//
// 压线一律 `into = "string"`：同一条判断链、同样的步骤，但不往地上铺虚影 —— 门禁不该给下一套留垃圾。
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
require("./suite-guard.js").guardMain("helmod_steps_e2e");

const ROOT = path.join(__dirname, "..");
const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const call = (method, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method, JSON.stringify(args || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 26 });
    return JSON.parse(out.trim());
  } catch (e) {
    return { ok: false, code: "HARNESS", msg: String((e && e.stdout) || e).slice(0, 200) };
  }
};
const asArr = (v) => (Array.isArray(v) ? v : []);
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 400)}`);
  ok ? pass++ : fail++;
};
const ORIGIN = { x: 9100, y: 9100 }; // 沙盒里没人走的角；into=string 不铺地上，双保险
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

// ---------------------------------------------------------------- 一次真会铺生产线的压线
// 红板三种料 —— 正是玩家连说两轮的那条线。
const press = call("helmod_ghosts", {
  plan: [{ name: "assembling-machine-3", count: 4, recipe: "advanced-circuit" }],
  into: "string", surface: "arch-sandbox", origin: ORIGIN, width: 300,
});
const d = press.data || {};
const steps = asArr(d.steps);
console.log(`  答案里 ${steps.length} 行，steps_count=${d.steps_count}，lanes=${asArr(d.lanes).length}`);
for (const s of steps) console.log(`    ${s.slice(0, 200)}`);

check("压一次线就留下一串可指认的步骤（不是只回一个蓝图）",
  press.ok && steps.length >= 8,
  `${press.code} ${press.msg} / ${steps.length} 行`);
check("每行前面有稳定编号，从 01 开始连续往上加",
  steps.length > 0 && /^01 /.test(steps[0]) && steps.every((l, i) =>
    l.startsWith(String(i + 1).padStart(2, "0"))),
  steps.map((l) => l.slice(0, 2)).join(","));
check("answer.steps_count 就是行数，不是中途的快照（第一版就是这里少了一步）",
  Number(d.steps_count) === steps.length, JSON.stringify([d.steps_count, steps.length]));

const findStep = (needle) => steps.filter((l) => l.includes(needle));
// 每"步"要带着它用的数字 —— 一行只有名字等于没写：他说"第 6 步不对"的时候，那一行得自证它在拿什么算。
check("配方那步带着料种数和每次工艺吃的东西",
  findStep("配方：").some((l) => /料种数=3/.test(l) && /plastic-barx2/.test(l) && /copper-cablex4/.test(l)),
  JSON.stringify(findStep("配方：")));
check("形状那步带着完整候选链（点名时也必须看得见）",
  findStep("形状候选").some((l) => /阶梯=/.test(l) && /→/.test(l) && /料种数=3/.test(l)),
  JSON.stringify(findStep("形状候选")));
check("试过的每个形状都单独留一行（被跳过的和被接受的分得开）",
  findStep("  试 ").length >= 1 && findStep("  试 ").some((l) => /结果=接受/.test(l) && /footprint=\d+x\d+/.test(l)),
  JSON.stringify(findStep("  试 ")));
const ledger = findStep("线卡：")[0] || "";
check("线卡那步带着件数、臂档、每股运力与一行喂几台",
  /带=\d+/.test(ledger) && /臂=\d+/.test(ledger) && /箱=\d+/.test(ledger)
    && /臂档=[\w-]+/.test(ledger) && /reach=\d+/.test(ledger)
    && /每股运力\/分=[\d.ni-]+/.test(ledger) && /一行可喂台数=\d+/.test(ledger),
  ledger.slice(0, 300));
// 这条断言是给玩家看的：他现在能在第 6 步直接读出"这形状还在用箱子、成品带根本没有"。
check("线卡那步诚实到能指出问题：现在的形状若还在用箱子，就必须写出来而不是藏起来",
  /箱=\d+/.test(ledger), ledger.slice(0, 200));
check("拆线那步同时给出两个上限和哪个绑住了",
  findStep("拆线：").some((l) => /带子喂得动=\d+/.test(l) && /地宽放得下=[\d.ni-]+/.test(l)
    && /一条线定成=[\d.]+/.test(l) && /会拆成几条=\d+/.test(l)),
  JSON.stringify(findStep("拆线：")));
check("落一条线那步带着落点与占地（说「这块地放不下」时能对上坐标）",
  findStep("落一条线").some((l) => /放在=\d+,\d+/.test(l) && /占=\d+x\d+/.test(l) && /台数=\d+/.test(l)),
  JSON.stringify(findStep("落一条线")));
check("出件那步带着字节数与引擎回读件数（少件是看得见的，不是「应该没事」）",
  findStep("出件").some((l) => /字节=\d+/.test(l) && /引擎回读=\d+/.test(l)),
  JSON.stringify(findStep("出件")));
check("小一次压线不会被步数上限截断（截断了要如实写 steps_dropped）",
  d.steps_dropped === undefined || d.steps_dropped === null, JSON.stringify(d.steps_dropped));

// ---------------------------------------------------------------- 日志文件里 grep 得到同一批行
// `log()` 落在 write-data 的 factorio-current.log / server.out 里，不是 dev/call.js 读的那份 console 文件
// （实测：server-console.log 一条都没有）。用 SERVER_OUT（dev/test.sh 会指到 .factorio-test/server.out）。
const LOG_CANDIDATES = [process.env.SERVER_OUT,
  path.join(ROOT, ENV.RCON_PORT === "27015" ? ".factorio-data" : ".factorio-test", "server.out")]
  .filter(Boolean);
const lineIn = (f, needle) => {
  try {
    return fs.readFileSync(f, "utf8").split("\n").some((l) => l.includes(needle));
  } catch (e) { return false; }
};
const marker = steps.length > 0 ? steps[steps.length - 1].slice(0, 60) : "出件";
check(`服务器日志里 grep 得到 arch-helmod-step（手机上 tail + grep 也能用）：${LOG_CANDIDATES.join(" ")}`,
  LOG_CANDIDATES.some((f) => lineIn(f, "arch-helmod-step") && lineIn(f, marker)),
  "最后一步的那行没在日志里");

// ---------------------------------------------------------------- 回看上一次压线
const back = call("helmod_last_steps", {});
check("helmod_last_steps 回读的就是刚才那一串（不用重跑压线）",
  back.ok && asArr(back.data.lines).length === steps.length
    && asArr(back.data.lines).join("|") === steps.join("|"),
  back.ok ? `${asArr(back.data.lines).length} vs ${steps.length}` : `${back.code} ${back.msg}`);
check("回读带着是哪一页/哪个来源，光看步骤不会认错是哪次压的",
  back.ok && back.data.source === d.source, JSON.stringify([back.data && back.data.source, d.source]));

// 点名要哪一页：整计划那按会逐页覆盖"上一次"，所以指错页必须拒，而不是把另一页的步骤当答案交出去。
// 这条同时也是 refusals 门禁要的那个 fixture —— 一个码不能只靠"到不了"的名单活着。
const wrongPage = call("helmod_last_steps", { page: "model_没有压过的那一页" });
check("点名了一页而上一次压的不是它：按名拒，并把两页的名字都交出来",
  !wrongPage.ok && wrongPage.code === "NO_STEPS"
    && wrongPage.detail && wrongPage.detail.asked === "model_没有压过的那一页"
    && wrongPage.detail.last_page !== undefined,
  JSON.stringify([wrongPage.code, wrongPage.detail && wrongPage.detail.last_page]));

// ---------------------------------------------------------------- 拒的时候也要带步骤
// 没有玩家的手（headless 服务器就是这样）时，NO_PLAYER 那一拒必须把走到的步骤一起交回来：
// 玩家描述故障的时候，"铺完了但交不到手上"和"根本没铺出来"是两件完全不同的事。
const noHand = call("helmod_ghosts", {
  plan: [{ name: "assembling-machine-3", count: 3, recipe: "electronic-circuit" }],
  into: "cursor", surface: "arch-sandbox", origin: ORIGIN,
});
check("交不到手上的拒也带回已经走过的步骤",
  !noHand.ok && asArr(noHand.detail && noHand.detail.steps).length >= 3,
  JSON.stringify([noHand.code, noHand.detail && noHand.detail.steps_count]));

// 配方不存在的行不该被静默吞掉：它落成散件，并且第 07 步那行会说为什么。
const bad = call("helmod_ghosts", {
  plan: [{ name: "assembling-machine-3", count: 2, recipe: "no-such-recipe-here" }],
  into: "string", surface: "arch-sandbox", origin: ORIGIN,
});
const badSteps = asArr((bad.data || {}).steps);
check("铺不成线的行会写进步骤，并说它落成散件",
  bad.ok && badSteps.some((l) => /没铺成线|落成散件/.test(l)),
  JSON.stringify([bad.code, badSteps.filter((l) => /散件|拒/.test(l))]));

// ---------------------------------------------------------------- 整计划那按：每页各有一套
// `helmod_blueprints` 是对 `helmod_ghosts` 的循环（同一份读页/形状/出件逻辑），所以每一步也得在每页里
// —— 出蓝图的那页带 steps，被拒的那页也要带，否则"这页没出东西"和"这页第 6 步就拒了"读起来一样。
// 模型的结构照 helmod 自己写的来（dev/helmod_ghosts_e2e.js 顶部那段注释是出处）：配方行在 block 的
// children 里，形状是 {name=配方, count, factory={name=机器, amount, count}}，机器袋在 summary_global。
const pageModel = {
  model_7: {
    class: "Model", id: "model_7",
    block_root: {
      class: "Block", name: "步骤门禁页",
      summary_global: { factories: { a: { name: "assembling-machine-3", type: "entity", count: 4 } } },
      children: {
        1: { name: "advanced-circuit", count: 4,
          factory: { name: "assembling-machine-3", amount: 1, count: 4 } },
      },
    },
  },
};
const onePage = call("helmod_ghosts", { models: pageModel, into: "string",
  surface: "arch-sandbox", origin: ORIGIN, width: 300 });
const op = onePage.data || {};
check("helmod 的一页（不是手写的 plan）也走同一条判断链，并带出线卡那一步",
  onePage.ok && asArr(op.steps).some((l) => /线卡：advanced-circuit/.test(l))
    && asArr(op.lanes).length >= 1,
  JSON.stringify([onePage.code, onePage.msg, asArr(op.steps).length, asArr(op.lanes).length]));

const all = call("helmod_blueprints", { models: pageModel, into: "string",
  surface: "arch-sandbox", origin: ORIGIN, width: 300 });
const ad = all.data || {};
const anySteps = asArr(ad.blueprints).concat(asArr(ad.made)).some((b) => asArr(b.steps).length > 0)
  || asArr(ad.refused).some((b) => asArr(b.steps).length > 0);
check("整计划那按给每一页都带 steps（出的或拒的都带）",
  anySteps, JSON.stringify({ keys: Object.keys(ad).slice(0, 12),
    made: asArr(ad.blueprints || ad.made).length, refused: asArr(ad.refused).length,
    code: all.code, msg: all.msg }));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
