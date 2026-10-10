// 一条吐液体的线，铺到地上之后：它真的把硫酸吐到那一行管子里吗？
//
// 这一趟是 `fluid-through` 那一档形状的实地验收。它钉三件事，每件都必须从**地上**读，不能从答案里读：
//   1. 台架量得到成品（`verdicts` 里那条 fluid 的 measured_per_min > 0）；
//   2. 成品真的进了形状自己铺的那一行管子（读地上管子的 fluidbox，并把它和进料那一行分开）；
//   3. 进料那一行与成品那一行**没有并网**（`get_fluid_segment_id` 两个不同的段）。
// 第 3 条是这一档形状唯一一种"铺错了也看不出来"的错：两面管道一旦贴在一起就成了同一张管网，两种
// 液体在里面混，而机器照样转、照样出货 —— 只有段号会说谎被揭穿。
//
// 用法：bash dev/test.sh node dev/fluid_drain_probe.js
const { execFileSync } = require("child_process");
const path = require("path");
const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw", RCON_IDLE_MS: process.env.RCON_IDLE_MS || "30000" };
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 }).trim());
  } catch (e) { return { ok: false, code: "HARNESS", msg: String(e.stdout || e.message).slice(0, 300) }; }
};
const lua = (src) => execFileSync("node", [path.join(__dirname, "lua.js"), src],
  { encoding: "utf8", env: ENV }).trim();
const sleep = (ms) => execFileSync("sleep", [String(ms / 1000)]);
const asArr = (v) => (Array.isArray(v) ? v : Object.values(v || {}));
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 500)}`);
  ok ? pass++ : fail++;
};

// 牌子要电路科技（牌上是组合器发的股道清单），而台架往零箱子的线里插料就靠那份清单 —— 借了要还。
const netWas = /^true$/.test(lua(`local t = game.forces.player.technologies["circuit-network"]
rcon.print(t and tostring(t.researched) or "absent")`));
lua(`local t = game.forces.player.technologies["circuit-network"]
if t then t.researched = true end rcon.print("granted")`);

console.log("== card: sulfuric-acid, 3 chemical plants (2 solids + water in, acid out)");
const ex = call("card_example", { recipe: "sulfuric-acid", machines: 3, heads: "belt", force: "player" });
const d = ex.data || {};
check("这一发铺得出，形状是那一档两面各空一行给管道的",
  ex.ok === true && d.style === "fluid-through",
  JSON.stringify([ex.ok, ex.code, ex.msg, d.style]).slice(0, 400));
const pipes = asArr(d.entities).filter((e) => e.name === "pipe");
const inPort = asArr(d.entities).find((e) => e.role === "fluid_in");
const outPort = asArr(d.entities).find((e) => e.role === "fluid_out");
check("两面各有一行管子，两个自由端各标着自己的方向（一端进、一端出）",
  pipes.length >= 6 && !!inPort && !!outPort && (d.fluid_in || []).length === 1
  && (d.fluid_out || []).length === 1,
  JSON.stringify([pipes.length, !!inPort, !!outPort, d.fluid_in, d.fluid_out]).slice(0, 400));
check("成品那一行的口子在机器**出**的那一面，而不是进料那一面",
  (d.fluid_in || [{}])[0].face !== (d.fluid_out || [{}])[0].face
  && (d.fluid_out || [{}])[0].fluid === "sulfuric-acid",
  JSON.stringify([(d.fluid_in || [])[0], (d.fluid_out || [{}])[0]]).slice(0, 300));
check("这张卡的契约里有液体成品那一份（每分钟几单位），固体那份是空的",
  JSON.stringify(d.contract || {}).indexOf("sulfuric-acid") >= 0
  && Object.keys((d.contract || {}).outputs || {}).length === 0,
  JSON.stringify(d.contract).slice(0, 300));

call("lab_reset", {});
const started = call("card_lab", { card: d, seconds: 150, speed: 20 });
check("台架接得上这种线（不再按「没有端口」拒），作业起得来",
  !!(started.ok && started.data && started.data.state),
  JSON.stringify([started.code, started.msg]).slice(0, 300));
let status = {};
// 地上那一手读的是**作业自己**在窗口里从那一行管子里抽到的数（`fluid_drain_rows`）：段号是
// `get_fluid_segment_id` 从活管件上读回来的，而"这一行有没有别种流体"就是"两排管子并网了没有"。
// 为什么不在这里再抽一次地上的管子：收口每一拍都在抽这一行（那正是它替代"从机器嘴里抽"的那一手），
// 从 rcon 采样到的永远是一行空管子 —— 那种零会被读成"管子没接到机器"，而它是接上的。
for (let i = 0; i < 30; i++) {
  sleep(2000);
  status = call("lab_status", {}).data || {};
  if (status.state !== "running") break;
}
const stopped = call("lab_stop", {});
const done = (stopped.ok && stopped.data) ? stopped.data : status;
const rows = asArr(done.fluid_drain_rows);
console.log("  drain rows: " + JSON.stringify(rows));
const verdicts = asArr(done.verdicts);
const fluidV = verdicts.find((v) => v.kind === "fluid");
check("台架量到了这条线吐出来的液体（不是零，也不是固体那一份）",
  !!fluidV && Number(fluidV.measured_per_min) > 0,
  JSON.stringify([verdicts, done.produced, done.measured_per_min]).slice(0, 400));
check("喂进去的固体没有被一手挡回来（臂越过管道那一格，真的放进了机器）",
  Number(done.fed || 0) > 0 && Number(done.fed_blocked || 0) === 0,
  JSON.stringify([done.fed, done.fed_blocked, done.diagnostics]).slice(0, 300));
check("这份液体是从**卡自己铺的那一行管子**里读到的（收口在、carried 为真、段号是引擎给的）",
  rows.length === 1 && rows[0].carried === true && Number(rows[0].units) > 0
  && Array.isArray(rows[0].segments) && rows[0].segments.length >= 1,
  JSON.stringify(rows).slice(0, 400));
check("成品那一行里没有第二种流体 —— 两排管子没有并成一张管网",
  rows.length === 1 && rows[0].merged_with === undefined,
  JSON.stringify(rows).slice(0, 400));
check("液体成品的数就是从那一行管子里来的（两处读数相等，没有再从机器嘴里抽一遍）",
  rows.length === 1 && Number((done.fluid_yields || {}).sulfuric_acid
    || (done.fluid_yields || {})["sulfuric-acid"]) === Number(rows[0].units),
  JSON.stringify([done.fluid_yields, rows]).slice(0, 300));
call("lab_reset", {});
if (!netWas) lua(`local t = game.forces.player.technologies["circuit-network"]
if t then t.researched = false end rcon.print("restored")`);
const paused = lua("rcon.print(tostring(game.tick_paused))");
check("世界时钟解开（这把探针不欠一条暂停的世界）", /false/.test(paused), paused);
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
