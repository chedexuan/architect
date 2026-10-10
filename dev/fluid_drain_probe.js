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
if t then t.researched = true end
local dp = game.forces.player.recipes["display-panel"] if dp then dp.enabled = true end
rcon.print("granted")`);

console.log("== card: sulfuric-acid, 3 chemical plants (2 solids + water in, acid out)");
const ex = call("card_example", { recipe: "sulfuric-acid", machines: 3, heads: "belt", force: "player" });
const d = ex.data || {};
if (!ex.ok) {
  console.log(`FAIL card :: ${ex.code} ${ex.msg || ""} ${JSON.stringify(ex.detail || {}).slice(0, 400)}`);
  process.exit(1);
}
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
  JSON.stringify(d.contract || null).slice(0, 300));

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
// 这条线量到的是**声称的两成**，而且这不是仪器的事：三台机器的水都从**同一行管子的同一个自由端**进来，
// 一行 1×1 的管子送不动 9000/分（量到 1860/分 ⟹ 比率 0.207，两次跑一样的数）。所以这里不假装 met：
// 牌现在会许诺一个它自己的管子送不到的速率，那是 §6 底下记着的一件**没做的**事（"进料那一行的流量上限"
// 还没有量过的律，所以既不拒也不打折 —— 拿一个没量的数去打折比不打折更坏）。
console.log("  进料那一行的流量上限: 声称 " + String(fluidV && fluidV.claimed_per_min) + "/分，量到 "
  + String(fluidV && fluidV.measured_per_min) + "/分（比率 " + String(fluidV && fluidV.ratio)
  + "）—— 已知未量，见 dev/待办.md §0 第十条");
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
// ---- 另外两种排法：一件固体都不过的线，与固体液体各走一边的线 ----
//
// 上面那一例是"两种固体 + 水进 → 硫酸出"。这一档形状还有两种边界，都得真量：
//   * 纯液体线（重油 → 润滑油）：进料与成品都是管道，带子 0 条、臂 0 只。它同时是那句旧谎的照合 ——
//     `lane_demand` 从前把"没有固体料"也折成 1 条带，这一档就照着铺一条空带、牌上写一个不存在的股号。
//   * 混合线（灌水桶：满桶进 → 空桶出 + 水出）：固体的进出各走一条带，液体走那一排管子，两份账一起下判。
// 两条配方在这个存档里都没研究，所以照 `layout_ledger` 的规矩借了再还 —— 而"还"必须按**读回来的那一份**还：
// 这个存档里有些项本来就已经开着（`oil-processing` 在 m0-test 是研究的），一律写 false 就是替后面每一套
// 套件关掉一项它没关过的东西，那时"哪条配方能铺"会因为一个没人写下的原因漂掉。
// 牌那一格也要借：写 `technology.researched = true` 并不会替引擎跑一遍"研究完成时解锁配方"那一步
// （实测：circuit-network 置真之后 `display-panel` 的 recipe 仍然 enabled=false），所以牌子那一对手
// 与液体那几项一起点名，并且都按读回来的原值还。
const GRANT_TECHS = ["circuit-network", "automation-2", "barrelling", "oil-processing", "lubricant"];
// `oil-refinery` 那台机器也点名借：可用性读的是 `force.recipes[unlock_recipe].enabled`，光把
// `oil-processing` 的技术置真不会替引擎跑解锁那一步（同上一条 display-panel 那个坑）。
const GRANT_RECIPES = ["empty-water-barrel", "water-barrel", "lubricant", "display-panel", "oil-refinery"];
const asLuaList = (xs) => `{${xs.map((x) => `"${x}"`).join(",")}}`;
// 借哪些科技**不硬写名字**，按原型读回来：`prototypes.technology` 里哪个科技的 effects 开了这些 recipe，
// 就借那个科技。我原先写死的 `barrelling` 并不是这一存档里 `empty-water-barrel` 的那扇门（那扇是
// `fluid-handling`），于是牌铺得出来、台架却按 `RECIPE_NOT_RESEARCHED` 拒 —— 报出来像"液体那一档
// 量不到"，实际是我借错了门。模组自己判这件事用的是同一份读数（control.lua 里 `tech_for_recipe`）。
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
// 切回话要按**逗号或空白**切，并且只认合法科技名：`dev/lua.js` 在回话末尾打了一行 `OK`，照逗号切会把
// 最后一个名字连 `\nOK` 一起当成名字，插进下一段 Lua 就变成"字符串里换行"（unfinished string），
// 于是 readState 编译不过、`before={}`、整个借窗口空转 —— 报出来像液体那一档量不到。
const ALL_TECHS = Array.from(new Set([...GRANT_TECHS,
  ...String(neededTechs()).split(/[,\s]+/).filter((x) => /^[a-z][a-z0-9_-]*$/.test(x))]));
// Lua 的字面量表用**带引号的键**写：`t:name` 里有冒号，不是合法标识符，裸键会编译错（而编译错在这一仓库里
// 长得跟"没有回话"一样）。
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
console.log("  borrowed techs: " + ALL_TECHS.join(",") + " / recipes: " + GRANT_RECIPES.join(","));
const grant = (on) => {
  const next = {};
  for (const k of Object.keys(before)) next[k] = on ? true : before[k];
  return writeState(next);
};

const benchOne = (card, seconds) => {
  call("lab_reset", {});
  const started = call("card_lab", { card, seconds: seconds || 120, speed: 20 });
  if (!started.ok) return { started: null, code: started.code, msg: started.msg };
  let status = {};
  for (let i = 0; i < 20; i++) {
    sleep(2000);
    status = call("lab_status", {}).data || {};
    if (status.state !== "running") break;
  }
  const stopped = call("lab_stop", {});
  return { started: started.data, done: (stopped.ok && stopped.data) ? stopped.data : status };
};

grant(true);
try {
  // 三种液体成品的炼油：**0.88.0 起铺得出了**（一口一列反过来用在出料面，三只口同面差 2 格 ⟹ 三列
  // 天生三段）。这一条从前钉的是"液体成品铺不出"，后来钉的是"一面只走得了种液体"，两句现在都假的 ——
  // 台架那侧的真凭据（三段互不相交）在 `dev/multi_fluid_probe.js`，这里只钉形状那一格与按名拒的说法。
  const three = call("card_example", { recipe: "advanced-oil-processing", machines: 2, force: "player" });
  check("三种液体成品的炼油铺得出：出料那一面每一种各一列柱子",
    three.ok && three.data.style === "fluid-through" && asArr(three.data.fluid_out).length === 3,
    JSON.stringify([three.code, three.msg, (three.data || {}).style,
      asArr((three.data || {}).fluid_out).map((e) => [e.fluid, e.face, e.off])]).slice(0, 300));
  const threeNamed = call("card_example", { recipe: "advanced-oil-processing", machines: 2,
    style: "stacked", force: "player" });
  check("点名没有这一格的形状时才按名拒，说的是「这一档给不出每只出口一列」",
    !threeNamed.ok && threeNamed.code === "LANE_DRAINS_ONE_FLUID"
    && asArr((threeNamed.detail || {}).fluids).length === 3
    && (threeNamed.detail || {}).shape_that_can === "fluid-through",
    JSON.stringify([threeNamed.code, threeNamed.detail]).slice(0, 300));

  const pure = call("card_example", { recipe: "lubricant", machines: 3, force: "player" });
  const pd = pure.data || {};
  check("纯液体那一条线（重油→润滑油）：带子 0 条、臂 0 只，两面各一排管子，一件固体都不过",
    pure.ok && pd.style === "fluid-through" && (pd.parts || {}).belts === 0
    && (pd.parts || {}).arms === 0 && ((pd.parts || {}).pipes || 0) >= 6,
    JSON.stringify([pure.code, pd.style, pd.parts, (pd.feed_plan || {}).lane_rows]).slice(0, 300));
  const pb = benchOne(pd, 120);
  const pv = asArr((pb.done || {}).verdicts);
  check("...这条一根带子都没有的线在出料，而且量到的数与卡声称的是同一个量级",
    pv.length === 1 && pv[0].kind === "fluid" && Number(pv[0].measured_per_min) > 0
    && pv[0].met === true,
    JSON.stringify([pv, (pb.done || {}).fluid_drain_rows]).slice(0, 400));

  console.log("  state now: " + lua(`local f = game.forces.player
local function st(n) local t = f.technologies[n] return n .. "=" .. tostring(t and t.researched) end
rcon.print(table.concat({ st("circuit-network"), st("automation-2"), st("oil-processing"), st("lubricant"),
  "panel-recipe=" .. tostring(f.recipes["display-panel"] and f.recipes["display-panel"].enabled) }, " ")
  .. " water-barrel-recipe=" .. tostring(f.recipes["empty-water-barrel"] and f.recipes["empty-water-barrel"].enabled))`)
    + " | before=" + JSON.stringify(before));
  const mixed = call("card_example", { recipe: "empty-water-barrel", machines: 2, force: "player" });
  const md = mixed.data || {};
  check("混合那一条（满桶进 → 空桶出 + 水出）：固体走带、液体走那一排管子，两份账都在契约里",
    mixed.ok && md.style === "fluid-through" && ((md.parts || {}).belts || 0) > 0
    && ((md.parts || {}).pipes || 0) >= 3
    && Object.keys((md.contract || {}).outputs || {}).length === 1
    && Object.keys((md.contract || {}).fluid_outputs || {}).length === 1,
    JSON.stringify([mixed.code, md.style, md.parts, md.contract]).slice(0, 300));
  console.log("  mixed card: parts=" + JSON.stringify(md.parts)
    + " head=" + JSON.stringify((md.head || {}).lanes || null).slice(0, 160)
    + " sign_missing=" + JSON.stringify((md.head || {}).sign_missing || null));
  const mb = benchOne(md, 120);
  if (!mb.started) console.log("  mixed lab refused: " + JSON.stringify([mb.started, mb.code, mb.msg]).slice(0, 300));
  const mv = asArr((mb.done || {}).verdicts);
  const rowsM = asArr((mb.done || {}).fluid_drain_rows);
  check("...两种产物各自被量到了：空桶从带子上收，水从**卡自己那一排管子**里收（段号是引擎给的）",
    mv.length === 2 && mv.some((v) => v.kind === "item" && v.item === "barrel")
    && mv.some((v) => v.kind === "fluid" && v.fluid === "water" && Number(v.measured_per_min) > 0)
    && rowsM.length === 1 && rowsM[0].carried === true && rowsM[0].merged_with === undefined,
    JSON.stringify([mb.code, mb.msg, mv, rowsM]).slice(0, 420));
} finally {
  grant(false);   // 按读回来的那一份还，不是清零
}

const paused = lua("rcon.print(tostring(game.tick_paused))");
check("世界时钟解开（这把探针不欠一条暂停的世界）", /false/.test(paused), paused);
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
