// Minimal Source RCON client, zero deps. Usage: node rcon.js <port> <password> <command...>
// Framing: Factorio splits large replies across several RESPONSE_VALUE packets sharing one
// request id, so an idle timeout alone can hand back truncated JSON. When RCON_SENTINEL is
// set we only finish on seeing that marker, and report truncation otherwise.
const net = require("net");

const [, , portArg, pw, ...cmdParts] = process.argv;
const command = cmdParts.join(" ");
const host = process.env.RCON_HOST || "127.0.0.1";
const port = parseInt(portArg || "27015", 10);
const SENTINEL = process.env.RCON_SENTINEL || "";
const IDLE_MS = parseInt(process.env.RCON_IDLE_MS || (SENTINEL ? 5000 : 1200), 10);
const HARD_MS = parseInt(process.env.RCON_HARD_MS || (SENTINEL ? 120000 : 15000), 10);

const buf = (id, type, body) => {
  const bytes = Buffer.byteLength(body, "utf8");
  // size field covers: id(4) + type(4) + body + 2 null terminators
  const b = Buffer.alloc(4 + 8 + bytes + 2);
  let o = 0;
  b.writeInt32LE(10 + bytes, o); o += 4;
  b.writeInt32LE(id, o); o += 4;
  b.writeInt32LE(type, o); o += 4;
  b.write(body, o, "utf8"); o += bytes;
  b[o++] = 0; b[o] = 0;
  return b;
};

const sock = new net.Socket();
sock.setNoDelay(true);

let acc = Buffer.alloc(0);
let body = "";
let idle = null;
let hard = null;

const finish = (err) => {
  if (idle) clearTimeout(idle);
  if (hard) clearTimeout(hard);
  if (err) { console.error(err); sock.destroy(); process.exit(5); }
  const cut = SENTINEL ? body.indexOf(SENTINEL) : -1;
  const payload = cut >= 0 ? body.slice(0, cut) : body;
  if (payload.trim()) process.stdout.write(payload.replace(/\n$/, "") + "\n");
  else console.error("(empty response)");
  sock.destroy();
  process.exit(0);
};

const arm = () => {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (SENTINEL) finish(`TRUNCATED: got ${body.length} bytes in ${IDLE_MS}ms of silence, no sentinel`);
    else finish();
  }, IDLE_MS);
};

hard = setTimeout(() => finish(`TIMEOUT: ${body.length} bytes received, no sentinel within ${HARD_MS}ms`), HARD_MS);

sock.connect(port, host, () => sock.write(buf(1, 3, pw)));

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
        console.error("RCON auth failed (wrong password or not an rcon port)");
        sock.destroy();
        process.exit(2);
      }
      sock.write(buf(3, 2, command));
      arm();
      continue;
    }
    if (type === 0) {
      body += payload;
      if (SENTINEL && body.includes(SENTINEL)) { finish(); return; }
      arm();
    }
  }
});

sock.on("error", (e) => { console.error("rcon connect error:", e.message); process.exit(3); });
