// W1 (dev/underground_pair_probe.js) says "a pair of underground belts placed by name + cell + direction
// does not link". It was measured with 1.1 names -- it wrote `belt_to_ground_type` (read-only here, and
// correctly refused) and asked for `linked_belt` (does not exist). 2.0 documents a different pair of names
// for the same job: `linked_belt_type` (writable), `linked_belt_neighbour`, `connect_linked_belts()`. None
// of those were ever tried, so W1 was a measurement of my vocabulary. This file re-asks the belt question
// with the 2.0 spelling, and asks the fluid half of it, which was never asked at all: `LuaFluidBox
// .add_linked_connection` is how a script would author a pipe tunnel, and his own refinery pattern leans
// on one (each product goes underground two tiles after leaving the machine).
//
// What it settles, measured 2026-10-09 on 2.0.77:
//   belts   -- W1 STANDS, for a better reason than the one on file: the 2.0 linked-belt API is present but
//             an `underground-belt` answers "Entity is not linked-belt" to every one of its three names,
//             and `defines.linked_belt_type` is nil in this build. So there is nothing to set and nothing
//             to call. (Untested still: a blueprint RECORD carrying `type`/`index`, which is how a pasted
//             tunnel pairs -- that is the path his four-material bundle would have to travel by.)
//   pipes   -- NOT a wall. Two `pipe-to-ground` joined by `add_linked_connection` come back in ONE fluid
//             segment and carry fluid end to end -- but only with the two ends facing AWAY from each other
//             along the run (the entry end faces upstream, the exit end faces downstream). The other three
//             facing combinations stay in two segments and move nothing. And a ptg's surface opening is on
//             the side it faces, which is what the run has to be plumbed against.
const { execFileSync } = require("child_process");
const path = require("path");
require("./suite-guard.js").guardMain("linked_pair_probe");

const ENV = { ...process.env, RCON_PORT: process.env.RCON_PORT || "27016",
  RCON_PW: process.env.RCON_PW || "testpw" };
const lua = (src) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "lua.js"), src],
      { encoding: "utf8", env: ENV, maxBuffer: 1 << 26 }).trim();
  } catch (e) { return "PROBE-FAIL " + String((e && e.stderr) || e).slice(0, 300); }
};
const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
const ask = (src, tries) => {
  let out = lua(src);
  for (let n = 1; n <= (tries || 5) && (!out.trim() || /PROBE-FAIL|TRUNCATED|no output/.test(out)); n++) {
    console.log(`  (no reply, asking again in 4 s -- attempt ${n})`);
    sleep(4000);
    out = lua(src);
  }
  return out;
};
let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "\n  " + String(detail).slice(0, 500)}`);
  ok ? pass++ : fail++;
};

const BX = 7700, BY = 7700;   // belt rig
const PX = 7900, PY = 7700;   // pipe rigs, one per facing combination, 12 cells apart

// ---------------------------------------------------------------- the 2.0 names, on belts
console.log("\n-- 1) 地架带：2.0 那三个名字到底给不给");
const belts = ask(`local s = game.surfaces["arch-lab"]
local bx, by = ${BX}, ${BY}
s.request_to_generate_chunks({bx, by}, 2) s.force_generate_chunk_requests()
for _, e in ipairs(s.find_entities_filtered{area = {{bx - 4, by - 4}, {bx + 14, by + 4}}}) do e.destroy() end
local mk = function(name, x, y, dir)
  return s.create_entity({name = name, position = {x = x + 0.5, y = y + 0.5}, direction = dir,
    force = "player", raise_built = true}) end
local a = mk("underground-belt", bx + 2, by, 4)
local b = mk("underground-belt", bx + 5, by, 4)
local out = {}
local function rd(label, fn)
  local ok, v = pcall(fn)
  out[#out+1] = label .. "=" .. (ok and tostring(v) or ("ERR:" .. tostring(v)))
end
rd("defines.linked_belt_type", function() return defines.linked_belt_type end)
rd("A.linked_belt_type", function() return a.linked_belt_type end)
rd("A.linked_belt_neighbour", function() return a.linked_belt_neighbour end)
rd("A.connect_linked_belts(B)", function() return a.connect_linked_belts(b) end)
rd("写A.linked_belt_type", function() a.linked_belt_type = "output" return a.linked_belt_type end)
rd("写A.belt_to_ground_type", function() a.belt_to_ground_type = "output" return a.belt_to_ground_type end)
rd("A.belt_to_ground_type读", function() return a.belt_to_ground_type end)
rd("B.belt_to_ground_type读", function() return b.belt_to_ground_type end)
rd("proto.type", function() return prototypes.entity["underground-belt"].type end)
rcon.print(table.concat(out, "\\n"))`);
console.log(belts.split("\n").map((l) => "   " + l).join("\n"));
const notLinkedBelt = (key) => new RegExp(key + "=ERR:Entity is not linked-belt").test(String(belts));
check("2.0 那三个名字在这台机上都在，但对 underground-belt 一律回“Entity is not linked-belt”（W1 结论留着，理由换成实测的那条）",
  notLinkedBelt("A\\.linked_belt_type") && notLinkedBelt("A\\.linked_belt_neighbour")
    && notLinkedBelt("A\\.connect_linked_belts\\(B\\)"), belts);
check("`defines.linked_belt_type` 这台机没有（所以连「该写成哪个值」都无从问起）",
  /defines\.linked_belt_type=nil/.test(String(belts)), belts);
check("`belt_to_ground_type` 仍是只读，两只都停在 input —— 脚本放的地架带不成对",
  /写A\.belt_to_ground_type=ERR:.*read only/.test(String(belts))
    && /A\.belt_to_ground_type读=input/.test(String(belts)) && /B\.belt_to_ground_type读=input/.test(String(belts)),
  belts);

// ---------------------------------------------------------------- the pipe tunnel, four facings
console.log("\n-- 2) 穿地管：add_linked_connection 能不能把液体送过去（四种朝向各测一遍）");
// d1 = 入口那只朝哪，d2 = 出口那只朝哪。12=西、4=东；两只之间空 3 格。
const dirs = [12, 4];
const pipes = ask(`local s = game.surfaces["arch-lab"]
local px, py = ${PX}, ${PY}
local AR2 = { [0]="北", [4]="东", [8]="南", [12]="西" }
local mk = function(name, x, y, dir)
  return s.create_entity({name = name, position = {x = x + 0.5, y = y + 0.5}, direction = dir,
    force = "player", raise_built = true}) end
local out = {}
local ci = 0
for _, d1 in ipairs({12, 4}) do
  for _, d2 in ipairs({12, 4}) do
    ci = ci + 1
    local ox = px + ci * 12
    s.request_to_generate_chunks({ox, py}, 2) s.force_generate_chunk_requests()
    for _, e in ipairs(s.find_entities_filtered{area = {{ox - 4, py - 4}, {ox + 9, py + 4}}}) do e.destroy() end
    local g1 = mk("pipe-to-ground", ox, py, d1)
    local g2 = mk("pipe-to-ground", ox + 4, py, d2)
    -- 两只的四边各放一根管：哪一边真接得上，由"连几件"和"哪根里有水"说
    local function ring(cx)
      local r = {}
      for _, d in ipairs({ {0,-1,"北"}, {1,0,"东"}, {0,1,"南"}, {-1,0,"西"} }) do
        r[#r+1] = { mk("pipe", cx + d[1], py + d[2], 0), d[3] }
      end
      return r
    end
    local r1, r2 = ring(ox), ring(ox + 4)
    local okl, rl = pcall(function() return g1.fluidbox.add_linked_connection(1, g2, 1) end)
    local okw, rw = pcall(function() g1.fluidbox[1] = {name = "water", amount = 60} return "wrote" end)
    game.ticks_to_run = 200
    local function seg(e)
      local r = {}
      pcall(function() r[#r+1] = tostring(e.fluidbox.get_fluid_segment_id(1)) end)
      pcall(function() local c = e.fluidbox.get_connections(1) r[#r+1] = "连" .. tostring(c and #c) end)
      return table.concat(r, "")
    end
    local wet1, wet2 = {}, {}
    for _, p in ipairs(r1) do local b = p[1].fluidbox[1] if b and b.name then wet1[#wet1+1] = p[2] .. tostring(b.name) end end
    for _, p in ipairs(r2) do local b = p[1].fluidbox[1] if b and b.name then wet2[#wet2+1] = p[2] .. tostring(b.name) end end
    out[#out+1] = string.format("%s|%s link=%s 写=%s 段g1=%s 段g2=%s 近 wet[%s] 远 wet[%s]",
      AR2[d1], AR2[d2], tostring(okl), tostring(okw), seg(g1), seg(g2),
      table.concat(wet1, ","), table.concat(wet2, ","))
  end
end
rcon.print(table.concat(out, "\\n"))`);
console.log(pipes.split("\n").map((l) => "   " + l).join("\n"));
const rowOf = (a, b) => new RegExp("^" + a + "\\|" + b + " ", "m").test(String(pipes))
  ? String(pipes).split("\n").find((l) => l.startsWith(a + "|" + b + " ")) : "";
const away = rowOf("西", "东");
const sameDir = rowOf("东", "东");
const towards = rowOf("东", "西");
const segOf = (line) => {
  const m = /段g1=(\d+).*段g2=(\d+)/.exec(line);
  return m ? { a: m[1], b: m[2] } : null;
};
check("add_linked_connection 每发都落得了记录（四种朝向都 link=true 写=true）",
  (String(pipes).match(/link=true 写=true/g) || []).length === 4, pipes);
check("入口朝上游、出口朝下游（西|东）那一对真的并网：同一液体段，且对面环管里出现水",
  (() => { const sg = segOf(away); return sg && sg.a === sg.b && /远 wet\[[^\]]*water/.test(away); })(), away || pipes);
check("同向那一对（东|东）不成：两段各走各的，对面环里没有水",
  (() => { const sg = segOf(sameDir); return sg && sg.a !== sg.b && !/远 wet\[[^\]]*water/.test(sameDir); })(), sameDir || pipes);
check("对脸那一对（东|西）也不成 —— 所以「朝向」是这条形状的硬条件，不是随便一对都行",
  (() => { const sg = segOf(towards); return sg && sg.a !== sg.b && !/远 wet\[[^\]]*water/.test(towards); })(), towards || pipes);
check("穿地管的地面接口在它**朝的那一面**（西|东 那发：近侧只有西、远侧只有东有水）",
  /近 wet\[西water\]/.test(away) && /远 wet\[东water/.test(away), away || pipes);

for (const [x, y] of [[BX, BY], [PX, PY]]) {
  ask(`local s = game.surfaces["arch-lab"]
for _, e in ipairs(s.find_entities_filtered{area = {{${x - 6}, ${y - 6}}, {${x + 60}, ${y + 6}}}}) do e.destroy() end
rcon.print("cleared")`, 3);
}
// 快进用的是 `game.ticks_to_run`：它把世界停在暂停里再走若干 tick，走完不复位。借了世界就得还 ——
// 链上下一套等"世界自己在走"的台架（arm_pair_probe / arm_rate_e2e）读到一屏零，长得跟"摆法不成立"一样。
ask(`game.tick_paused = false rcon.print("unpaused=" .. tostring(not game.tick_paused))`, 3);
console.log(`${fail ? "FAILED" : "ALL PASS"}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
