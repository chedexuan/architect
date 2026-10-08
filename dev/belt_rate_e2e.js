// 带子的真数：`belt_rate` 那一格。
//
// 这个门存在的理由是一句玩家的怀疑："helmod 里选的传送带偏好，它算的量和你算的量不一样"。那句话
// 两边各说什么都不算 —— 带子能走多少件是**跑起来**才回答的：一条 10 格的带子，西头脚本塞、东头
// 脚本取，数一分钟过几件。同步的探针量不到它（`insert_at_back` 你给它几件它就"塞进"几件，
// 它不看密度也不背压），所以这个 rig 是 tick-runner 那一族的第五个。
//
// 它钉的是：每一档都真的过了件；一股与两股之比在 0.65 以下（『每股只走半条带子』这条律的凭据，
// `lane_demand` 里那个 `/2` 就靠它）；**绝对值只当上限**（一条 10 格的股上挤进 256 件 —— 一格 25 件，
// 物理上不可能，所以这些数不许被拿去当额定量）；快的确实走得多；第二次问读缓存不重跑。
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("belt_rate_e2e");

const ENV = { ...process.env, RAW: "1" };
const call = (m, a) => {
  try {
    return JSON.parse(execFileSync("node", [path.join(__dirname, "call.js"), m, JSON.stringify(a || {})],
      { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"], env: ENV }));
  } catch (e) { return { ok: false, code: "BRIDGE", msg: String(e.stdout || e.message).slice(0, 200) }; }
};
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 320)}`);
  ok ? pass++ : fail++;
};
const asArr = (v) => (Array.isArray(v) ? v : (v && typeof v === "object" ? Object.values(v) : []));
// `dev/call.js` 把门的答案包在 `{ ok, method, data }` 里；下面读的都是那一层里面的东西。
const unwrap = (r) => (r && r.data ? r.data : r || {});

// 起一次，然后读回来。轮询而不是睡死：窗口跑完的秒数随这台机器的负载走，而一个把时钟留在 20 倍
// 的存档会把后面每一套都变成赛跑。
const started = unwrap(call("belt_rate", { seconds: 4, speed: 20, refresh: true }));
check("台架起得来，说的是它要量哪几档带子", started.state === "running" && asArr(started.belts).length >= 1,
  JSON.stringify([started.state, started.belts, started.code, started.msg]));
let rec = null;
for (let i = 0; i < 40 && !rec; i++) {
  execFileSync("sleep", ["3"]);
  const raw = call("belt_rate", { seconds: 4, speed: 20 });
  if (raw.ok === false) { rec = raw; check("台架跑的过程里没有把 tick runner 炸死", false,
    JSON.stringify([raw.code, raw.msg, raw.detail])); }
  else { const r = unwrap(raw); if (r.state !== "running") rec = r; }
}
check("一扇窗口跑完，每一档带子都有一个数", !!rec && !rec.fail && asArr(rec.belts).length >= 2
  && asArr(rec.belts).every((b) => (b.both_lanes_per_min || 0) > 0 && (b.one_lane_per_min || 0) > 0),
  JSON.stringify(rec && { code: rec.code, msg: rec.msg, belts: asArr((rec || {}).belts || []).map((b) => [b.belt, b.one_lane_per_min, b.both_lanes_per_min]) }).slice(0, 400));
const rows = asArr((rec || {}).belts || []);
check("每一档都过件，且两股一定比一股多（一股不可能走得比两条一起还多）",
  rows.length > 0 && rows.every((b) => b.both_lanes_per_min > b.one_lane_per_min && !b.error),
  JSON.stringify(rows.map((b) => [b.belt, b.one_lane_per_min, b.both_lanes_per_min, b.error])).slice(0, 320));
check("一股确实是半条带子：每一档的『一股 ÷ 两股』都在 0.65 以下（`lane_demand` 那个 /2 的凭据）",
  rows.length > 0 && rows.every((b) => b.one_lane_per_min / b.both_lanes_per_min <= 0.65),
  JSON.stringify(rows.map((b) => [b.belt, +(b.one_lane_per_min / b.both_lanes_per_min).toFixed(3)])));
// 这条**不给模型背书**，它给的是相反的那句：脚本塞得比一格能挤的快，所以这些数是上限不是额定量。
// 量到过多少件挤在一条 10 格的股上？256 件 —— 一格 25.6 件，而模型的记忆值是"一格 8 件"。
// 把这个写在门里，是因为下一次有人拿 `both_lanes_per_min` 去替 `belt_ceiling` 时，这一条会拦住他；
// 真正能 lean 的只有上面那个"一股 ÷ 两股"之比。
check("而这些绝对值只当上限：一条 10 格的股上挤进了远超 8 件/格的量（所以它不是额定量）",
  rows.length > 0 && rows.every((b) => (b.peak_one_lane_items || 0) > 10 * 8),
  JSON.stringify(rows.map((b) => [b.belt, b.peak_one_lane_items, b.peak_both_items])));
check("而模型的额定值不会高于量到的上限（若高于，那是模型把带子说大了）",
  rows.length > 0 && rows.every((b) => b.model_per_min > 0 && b.both_lanes_per_min >= b.model_per_min * 0.9),
  JSON.stringify(rows.map((b) => [b.belt, b.model_per_min, Math.round(b.both_lanes_per_min)])));
check("快的带子真的走得多：按模型值排序的顺序与量到的顺序一致",
  rows.length >= 2 && rows.slice().sort((a, b) => a.model_per_min - b.model_per_min)
    .every((b, i, s) => i === 0 || b.both_lanes_per_min >= s[i - 1].both_lanes_per_min - 1),
  JSON.stringify(rows.map((b) => [b.belt, b.model_per_min, Math.round(b.both_lanes_per_min)])));
check("绝对值这一格自己承认是上限（它量到的是塞进去的密度，不是带子的物理密度）",
  /insert_at_back/.test(String((rec || {}).caveat || "")), String((rec || {}).caveat || "").slice(0, 200));
const again = unwrap(call("belt_rate", { seconds: 4, speed: 20 }));
check("第二次问不重跑：同一个台架读回缓存，并说 cached", again.cached === true && again.state === undefined,
  JSON.stringify([again.cached, again.state, again.measured_tick]));

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
