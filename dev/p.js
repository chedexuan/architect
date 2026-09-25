// One connection, many probes.
//
// Where the minutes actually go: `dev/lua.js` and `dev/call.js` each spawn a node process, open a
// fresh TCP connection, authenticate, run ONE command and tear it down -- and `lua.js` sends a
// warm-up command first on top of that. Measured on this box, that is 2-4 seconds of setup per
// probe against a reply that takes milliseconds. A debugging pass that asks thirty questions pays
// that thirty times, which is most of an hour.
//
// This asks thirty questions on one connection.
//
//   node dev/p.js probes.lua                 # every @@-labelled block, in order
//   node dev/p.js -e 'rcon.print(game.tick)' # one-off, still one warm-up total
//   node dev/p.js --json probes.lua          # one {"name":..,"out":..} line per block
//
// A block is Lua statements plus whatever `rcon.print` calls it wants to make; its printed output is
// the answer, and a block that raises reports `LUA_ERROR: <msg>` rather than ending the run -- a
// probe that dies halfway is the common case, and the other twenty answers are still worth having.
// A block that only `return`s something is also allowed, and the value is printed.
//
//   @@ clock
//   rcon.print("speed=" .. game.speed)
//   @@ tiles
//   return game.surfaces["nauvis"].count_entities_filtered{ name = "iron-ore" }
//
// Every reply is closed by its own sentinel, so a lost or half-delivered answer is blamed on the
// block that asked for it rather than looking like the next one answered late.
const fs = require("fs");
const net = require("net");

const HOST = process.env.RCON_HOST || "127.0.0.1";
const PORT = parseInt(process.env.RCON_PORT || "27015", 10);
const PW = process.env.RCON_PW || "m0pw";
const IDLE_MS = parseInt(process.env.RCON_IDLE_MS || "8000", 10);
// A shared wall-clock budget for the whole run, not one per block: a server that has stopped
// answering should cost a minute, not a minute times thirty.
const BUDGET_MS = parseInt(process.env.RCON_BUDGET_MS || "90000", 10);

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const blocks = [];
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === "--json") continue;
  if (a === "-e") { blocks.push({ name: `expr${blocks.length + 1}`, body: argv[++i] }); continue; }
  let cur = null;
  for (const line of fs.readFileSync(a, "utf8").split(/\r?\n/)) {
    const m = /^@@\s*([A-Za-z0-9_.-]+)\s*$/.exec(line);
    if (m) { cur = { name: m[1], body: "" }; blocks.push(cur); continue; }
    if (cur) cur.body += line + "\n";
    else if (line.trim() && !line.trim().startsWith("--")) {
      console.error(`p.js: text before the first @@ label is ignored: ${line.trim().slice(0, 60)}`);
    }
  }
}
if (!blocks.length) {
  console.error("usage: node dev/p.js <file.lua> | -e '<lua>'   (see the header for the block format)");
  process.exit(2);
}

const frame = (id, type, body) => {
  const bytes = Buffer.byteLength(body, "utf8");
  const b = Buffer.alloc(4 + 8 + bytes + 2);
  let o = 0;
  b.writeInt32LE(10 + bytes, o); o += 4;
  b.writeInt32LE(id, o); o += 4;
  b.writeInt32LE(type, o); o += 4;
  b.write(body, o, "utf8"); o += bytes;
  b[o++] = 0;
  b[o] = 0;
  return b;
};

// `/c <statements>` is how the console runs Lua at all, so a block is wrapped rather than prefixed:
// `return` is not a legal statement in that position, and an error in one block has to come back as
// text instead of ending the session.
const wrap = (body, sentinel) => {
  // Every block runs as a function body, so `return <value>` works from any position in it -- printing
  // only what the wrapped call hands back, and only when there is something to print. A block that
  // prints for itself is equally fine, which is why both spellings go through here.
  const t = body.trim();
  return `/c local __ok, __v = pcall(function() ${t} end) `
    + `if not __ok then rcon.print("LUA_ERROR: " .. tostring(__v)) `
    + `elseif __v ~= nil then rcon.print(__v) end `
    + `rcon.print("${sentinel}")`;
};

const sock = new net.Socket();
sock.setNoDelay(true);
let acc = Buffer.alloc(0);
let body = "";
let idle = null;
let nextId = 10;
// -1 while the achievement-confirmation gate is being paid for; 0..n-1 per block; n when finished.
let phase = -2;
let sentinel = "";
let ended = false;

const report = (text, err) => {
  const b = blocks[phase] || blocks[blocks.length - 1];
  const one = String(text || "").replace(/\s+$/, "");
  if (json) console.log(JSON.stringify({ name: b.name, out: one, err: err || null }));
  else console.log(`@@ ${b.name}\t${one === "" && !err ? "(no output)" : one}${err ? `\t[!] ${err}` : ""}`);
};

const bail = (code) => {
  if (ended) return;
  ended = true;
  if (idle) clearTimeout(idle);
  clearTimeout(budget);
  sock.destroy();
  process.exit(code);
};

const ask = (what) => {
  phase = what;
  body = "";
  sentinel = what < 0 ? "@@P-warmup@@" : `@@P${what}@@`;
  const cmd = what < 0 ? `/c rcon.print("${sentinel}")` : wrap(blocks[what].body, sentinel);
  sock.write(frame(nextId++, 2, cmd));
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (phase < 0) { console.error("p.js: the server did not answer the warm-up at all"); return bail(4); }
    report(body, `no sentinel after ${IDLE_MS}ms of silence (${body.length} bytes) -- `
      + "if the server is mid-warp it cannot answer; raise RCON_IDLE_MS");
    if (phase + 1 >= blocks.length) return bail(5);
    ask(phase + 1);
  }, IDLE_MS);
};

const budget = setTimeout(() => {
  console.error(`p.js: ${BUDGET_MS}ms budget spent after ${phase < 0 ? 0 : phase + 1} of ${blocks.length} block(s)`);
  bail(6);
}, BUDGET_MS);

sock.connect(PORT, HOST, () => sock.write(frame(1, 3, PW)));

sock.on("data", (d) => {
  acc = Buffer.concat([acc, d]);
  for (;;) {
    if (acc.length < 4) return;
    const size = acc.readInt32LE(0);
    if (acc.length < size + 4) return;
    const id = acc.readInt32LE(4);
    const type = acc.readInt32LE(8);
    const payload = acc.subarray(12, size + 4 - 2).toString("utf8");
    acc = acc.subarray(size + 4);
    if (type === 2) {
      if (id === -1) {
        console.error("RCON auth failed (wrong password, or that port is not the rcon port)");
        return bail(2);
      }
      // The first command of a fresh server session is eaten by the achievement-confirmation gate,
      // so it is paid for once here -- which is most of what this file saves per debugging pass.
      return ask(-1);
    }
    if (type !== 0) continue;
    body += payload;
    const cut = body.indexOf(sentinel);
    if (cut < 0) continue;
    const out = body.slice(0, cut);
    clearTimeout(idle);
    if (phase < 0) {
      if (out.includes("LUA_ERROR") || out.includes("Error")) console.error("p.js: warm-up complained:", out.trim());
      ask(0);
      return;
    }
    report(out);
    if (phase + 1 >= blocks.length) return bail(0);
    ask(phase + 1);
    return;
  }
});

sock.on("error", (e) => { console.error("rcon error:", e.message); bail(3); });
