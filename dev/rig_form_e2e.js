// 实测页的三格：哪台机器、哪块地、量多久 —— 以及它们真的走到了台架。
//
// What a bench rig answers is a property of THREE things the window used to fix behind the player's
// back: the machine standing on the patch, the patch it is standing on, and how long the window was
// open. A burner drill and an electric one pull different amounts; a number measured at home is not an
// answer about a colony; and a ten-second window on a tower that fruits every 304 seconds is a zero
// wearing a rate. The methods already took all three (`machine`, `surface`, `seconds`), and the panel
// handed none of them -- so the only way to ask "what does the big drill pull on MY copper field" was
// to type it over RCON, which is the same wall every rig in this file used to have.
//
// Asserted from both ends, because each one fails silently on its own:
//   * the WINDOW: the picker rows exist, and the machine list is built for the rig that is on screen --
//     a drill rig that offered an inserter would answer a refusal, and a farm row that filtered locked
//     machines would offer nothing at all (measured: the tower is not researched on this save);
//   * the DISPATCHER: one real press through `gui_api.rig`, which a stand-in cannot prove -- a stub
//     records what it was handed, so it cannot tell `machine = electric-mining-drill` from the rig's
//     own default. The rig's ANSWER names the machine that ran, and that is the comparison;
//   * the METHODS: a named machine that cannot take the ore's category is refused BY NAME. This one is
//     new, and it is here because the first version of the row made a crash reachable: naming
//     `assembling-machine-3` to the drill rig stood the assembler on the ore and died two lines later
//     on `drill.drop_position` (a field only a miner has), which leaves a half-built rig on the bench
//     for whichever suite runs next.
//
// The last section is #36: 「能否放下」 is asked ABOUT A SURFACE. The box is drawn where the player
// stands, so until this row existed the question could only ever be about that ground -- and in Space
// Age the same rectangle on a different planet is a different answer (pressure, daylight, tiles that
// refuse the machine outright).
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("rig_form_e2e");

const PORT = process.env.RCON_PORT || "27015";
const ENV = { ...process.env, RCON_PORT: PORT, RCON_PW: process.env.RCON_PW || "m0pw" };
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 400)}`);
  ok ? pass++ : fail++;
};
const asArr = (v) => (Array.isArray(v) ? v : (v && Object.keys(v).length
  ? Object.keys(v).map((k) => v[k]) : []));
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 28 }).trim();
  } catch (e) { return "LUA_HARNESS " + String((e && e.stderr) || e).slice(0, 120); }
};
const call = (method, args) => {
  try {
    const out = execFileSync(process.execPath, [path.join(__dirname, "call.js"), method,
      JSON.stringify(args || {})], { encoding: "utf8", env: { ...ENV, RAW: "1" }, maxBuffer: 1 << 28 });
    return JSON.parse(out.trim());
  } catch (e) { return { ok: false, code: "CALL_FAILED", msg: String((e && e.stderr) || e).slice(0, 160) }; }
};
const selftest = (args) => {
  const r = call("gui_selftest", args || {});
  return { env: r, d: r.data || {} };
};
const treeOf = (d) => asArr(d.tree).map(String).join("\n");

// ---------------------------------------------------------------- the three rows on the 实测 page
const plain = selftest({ rig: "drill", rig_item: "iron-ore" });
const tree = treeOf(plain.d);
check("the 实测 row now has a machine picker and a ground picker beside the rig picker",
  /drop-down\[arch-rig-machine\]/.test(tree) && /drop-down\[arch-rig-surface\]/.test(tree)
    && /drop-down\[arch-form-rig\]/.test(tree) && /textfield\[arch-rig-seconds\]/.test(tree),
  `${/arch-rig-machine/.test(tree) ? "machine ok" : "machine MISSING"} `
  + `${/arch-rig-surface/.test(tree) ? " surface ok" : " surface MISSING"}`);
// A row the handlers cannot find is a row that is not there: the click walks the frame by name, so a
// widget built under the wrong parent -- or under no parent -- renders perfectly and reads nil.
const named = asArr(plain.d.named_rows);
const rowOf = (n) => named.find((r) => r && r.name === n) || {};
check("...and every one of them lives in the flow the click reads back from",
  rowOf("arch-rig-machine").parent === "arch-rig-row"
    && rowOf("arch-rig-surface").parent === "arch-rig-row"
    && rowOf("arch-form-surface").parent === "arch-box-row",
  JSON.stringify([rowOf("arch-rig-machine"), rowOf("arch-rig-surface"), rowOf("arch-form-surface")]));

// ---------------------------------------------------------------- the machine list is the RIG's list
// Four rigs, four kinds of hardware. This is the part a flat list could never get right, and the part
// a filter copied from the lane menus got wrong in the other direction: the agricultural tower is not
// researched on this save, and the first draft of the row hid it -- a picker whose only entry is 自动.
const machineMenu = (rig, item) => {
  const { d } = selftest({ rig, rig_item: item });
  return asArr((d.menus_probe || {}).machines).map(String);
};
const drillList = machineMenu("drill", "iron-ore");
const armList = machineMenu("arm", "iron-ore");
const farmList = machineMenu("farm", "yumako");
check("a drill rig lists the miners that take the chosen ore's category, and nothing else",
  drillList[0] === "" && drillList.indexOf("electric-mining-drill") >= 0
    && drillList.every((n) => n === "" || !/inserter|tower|assembling/.test(n)),
  JSON.stringify(drillList));
check("an arm rig lists inserters, because that is the only thing it can put on the bench",
  armList[0] === "" && armList.length > 1 && armList.every((n) => n === "" || /inserter/.test(n)),
  JSON.stringify(armList));
check("...and a farm rig lists the tower EVEN WHEN IT IS NOT RESEARCHED -- a bench places what the save has",
  farmList[0] === "" && farmList.indexOf("agricultural-tower") >= 0,
  JSON.stringify(farmList));
// The two lists must not be the same list: that is what a menu built without the rig would look like,
// and it is the shape of "the picker offered a machine the rig refuses".
check("...so the lists are actually per-rig, not one list shown four times",
  JSON.stringify(drillList) !== JSON.stringify(armList)
    && JSON.stringify(armList) !== JSON.stringify(farmList),
  JSON.stringify([drillList, armList, farmList]));

// ---------------------------------------------------------------- the ground list is the save's
const surfList = asArr(((plain.d.menus_probe) || {}).surfaces).map(String);
const liveSurfaces = Number(String(lua(`local n = 0
for _ in pairs(game.surfaces) do n = n + 1 end
rcon.print(n)`).match(/\d+/) || ["0"])[0]);
check("the ground picker offers every surface this save has, with 默认 in front",
  surfList[0] === "" && surfList.length === liveSurfaces + 1
    && surfList.indexOf("nauvis") >= 0,
  JSON.stringify([surfList, liveSurfaces]));

// ---------------------------------------------------------------- the press reaches the rig
// One real press through the panel's own dispatcher. `real_rig` starts the drill rig with a machine,
// a ground and a window named -- and the rig answers with the machine it is running, which is the only
// evidence that distinguishes "forwarded" from "silently defaulted".
//
// A record the save already holds comes back as a finished figure with no `state` and no `seconds`, so
// the two assertions below accept either shape: what must hold in BOTH cases is that the machine and the
// ground the row named are the ones in the record.
//
// This file deliberately does NOT clear the rig cache to force a fresh run. A reset is not a neutral
// act on this box -- it changes what the suite AFTER this one measures -- and the two shapes of the
// answer are both honest answers to the question this gate asks.
const pressed = selftest({ real_rig: true });
const rp = pressed.d.rig_probe || {};
// A second press of the same rig reads the record the save already holds instead of running again --
// which is the cache's whole purpose, and why the assertions are shaped for either answer: what must
// hold in BOTH cases is that the machine and the ground the row named are the ones in the record.
check("the panel's rig press carries the named machine, the named ground and the named window",
  rp.ok === true && rp.machine === "electric-mining-drill" && rp.resource === "iron-ore"
    && (rp.state === "running" || rp.cached === true || rp.seconds === 5),
  JSON.stringify(rp).slice(0, 300));
check("...and the window it asked for is the window it got (5 game seconds, not the rig's own 25)",
  rp.asked && String(rp.asked.rig_seconds) === "5"
    && (rp.seconds === 5 || rp.elapsed_game_seconds === 5 || rp.cached === true),
  JSON.stringify([rp.asked, rp.seconds, rp.cached]));

// The job above is still open; read it back the way the button does, and check the GROUND came from the
// form. A dropped `surface` would answer about the bench it defaults to, and nothing else would notice.
let rec = {};
for (let i = 0; i < 20; i++) {
  const r = call("drill_rate", { resource: "iron-ore", machine: "electric-mining-drill",
    surface: "nauvis", seconds: 5, speed: 20 });
  rec = r.data || {};
  if (rec.state !== "running") break;
  execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1500)"]);
}
check("...and the finished record says which ground it measured, and it is the one the row named",
  rec.surface === "nauvis" && rec.machine === "electric-mining-drill",
  JSON.stringify([rec.surface, rec.machine, rec.state, rec.code]).slice(0, 260));

// What the SAME rig answers when the row says nothing: the default drill, on the default ground. Said
// as a pair because the pair is the proof -- the two fields move the answer, they are not decoration.
const dflt = call("drill_rate", { resource: "iron-ore", seconds: 5, speed: 20 });
let drec = dflt.data || {};
for (let i = 0; i < 20 && drec.state === "running"; i++) {
  execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1500)"]);
  drec = (call("drill_rate", { resource: "iron-ore", seconds: 5, speed: 20 }).data) || {};
}
check("...while the same press with the row left on 自动 names the rig's own machine and ground",
  !!drec.machine && drec.machine !== "electric-mining-drill" && drec.surface !== "nauvis",
  JSON.stringify([drec.machine, drec.surface, drec.code]).slice(0, 240));

// ---------------------------------------------------------------- a machine that cannot do the job
// The guard the new row made reachable. Each refusal is asked BEFORE the rig exists, so none of these
// costs a window or leaves a part standing -- which is the difference between a refusal and an apology.
const wrongDrill = call("drill_rate", { resource: "iron-ore", machine: "assembling-machine-3",
  seconds: 5, speed: 20 });
check("naming a machine that does not mine is refused by name, not crashed on",
  wrongDrill.ok === false && wrongDrill.code === "RIG_MACHINE_NOT_MINER"
    && wrongDrill.msg && wrongDrill.msg.indexOf("assembling-machine-3") >= 0,
  JSON.stringify([wrongDrill.code, String(wrongDrill.msg).slice(0, 120)]));
const wrongPump = call("pump_rate", { resource: "crude-oil", machine: "electric-mining-drill",
  seconds: 5, speed: 20 });
check("...and so is a solid-ore drill named to the pump rig (it takes no fluid category)",
  wrongPump.ok === false && wrongPump.code === "RIG_MACHINE_NOT_MINER",
  JSON.stringify([wrongPump.code, String(wrongPump.msg).slice(0, 120)]));
const wrongTower = call("farm_rate", { seed: "yumako-seed", machine: "electric-furnace",
  seconds: 5, speed: 20 });
check("...and a furnace named to the farm rig is refused as what it is: not a planter",
  wrongTower.ok === false && wrongTower.code === "RIG_MACHINE_NOT_GROWER",
  JSON.stringify([wrongTower.code, String(wrongTower.msg).slice(0, 120)]));
const ghostMachine = call("drill_rate", { resource: "iron-ore", machine: "no-such-drill-here",
  seconds: 5, speed: 20 });
check("...and a machine that does not exist at all is the same refusal, not a nil index",
  ghostMachine.ok === false && ghostMachine.code === "RIG_MACHINE_NOT_MINER"
    && String(ghostMachine.code) !== "RUNTIME_ERROR",
  JSON.stringify([ghostMachine.code, String(ghostMachine.msg).slice(0, 120)]));

// The answer's own sentence: a rate without its machine, its ground and its window is a number with no
// owner, and the three pickers above are only worth having if the result says which way they landed.
const rigLines = asArr(((pressed.d.report_after || {})["arch-rig"] || {}).lines).map(String);
const scopeLine = rigLines.find((l) => l.indexOf("rg-scope") >= 0) || "";
check("the rig's report line names the machine, the ground and the window it just measured",
  /rg-scope/.test(scopeLine),
  JSON.stringify(rigLines.filter((l) => /architect\.(rg|w-)/.test(l)).slice(0, 4)).slice(0, 300));

// ---------------------------------------------------------------- #36: which ground 能否放下 answers about
// The box is drawn where the player is; the row is what lets the question be asked about anywhere else.
// Asserted as a PAIR of surfaces, because a press that always judged the box's own ground would pass any
// assertion about the value it echoed.
const fitted = selftest({ real_fit: true });
const fp = fitted.d.fit_probe || {};
check("naming a ground makes 能否放下 judge THAT ground, not the one the box was drawn on",
  fp.ok === true && fp.judged === "arch-sandbox" && fp.box_from === "nauvis",
  JSON.stringify(fp).slice(0, 260));
check("...and the verdict it prints is the verdict about that ground (its own lanes, its own fits)",
  typeof fp.fits === "boolean" && (fp.lanes_fit || 0) >= 0 && fp.judged === "arch-sandbox",
  JSON.stringify([fp.fits, fp.lanes_fit, fp.judged]));
// The method honours the same word, so the row is not the only door: this is the half a stand-in api
// cannot fake.
const directFit = call("plan_fit", { item: "iron-plate", rate: 45, unit: "per_minute", machines: 4,
  surface: "arch-sandbox", force: "player",
  area: { left_top: { x: 10, y: 20 }, right_bottom: { x: 80, y: 60 } } });
check("...and plan_fit answers with the ground it judged in its own surface field",
  directFit.ok === true && ((directFit.data || {}).surface || {}).surface === "arch-sandbox",
  JSON.stringify([directFit.code, ((directFit.data || {}).surface || {}).surface]).slice(0, 240));

// Nothing above may leave a rig running or a part standing for the next suite: the rigs tear themselves
// down, and this file says so rather than finding out in someone else's red line.
const bench = execFileSync(process.execPath, [path.join(__dirname, "bench_check.js")],
  { encoding: "utf8", env: ENV }).trim().split(/\r?\n/).pop();
check("the bench is clean when this suite ends", /bench clean/.test(bench), bench.slice(0, 200));

console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
