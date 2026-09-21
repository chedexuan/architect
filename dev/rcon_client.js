// A minimal, reusable RCON loop client: one socket, many commands, awaited.
//
// dev/rcon.js spawns a process per command, which is fine for one-shot calls but caps the
// sampling rate below what a in-game measurement needs. Factorio's RCON handshake is not the
// standard Source ordering (the password goes out as EXEC_COMMAND, commands then go out as
// AUTH packets, replies arrive as RESPONSE_VALUE without reliable id pairing), so a reply is
// resolved by silence -- exactly what dev/rcon.js does.
const net = require("net");

const HOST = process.env.RCON_HOST || "127.0.0.1";
const PORT = parseInt(process.env.RCON_PORT || "27015", 10);
const PW = process.env.RCON_PW || "m0pw";

module.exports = function connect() {
  const sock = new net.Socket();
  sock.setNoDelay(true);
  let id = 1;
  let acc = Buffer.alloc(0);
  let resolver = null;
  let body = "";
  let idleTimer = null;
  let authed;
  const authGate = new Promise((r) => { authed = r; });

  const arm = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!resolver) return;
      const r = resolver;
      resolver = null;
      idleTimer = null;
      r(body.trim());
    }, 25);
  };

  sock.on("data", (d) => {
    acc = Buffer.concat([acc, d]);
    for (;;) {
      if (acc.length < 12) return;
      const size = acc.readInt32LE(0);
      if (acc.length < size + 4) return;
      const rid = acc.readInt32LE(4);
      const type = acc.readInt32LE(8);
      const payload = acc.slice(12, size + 4 - 2).toString("utf8");
      acc = acc.slice(size + 4);
      if (type === 2) {
        if (rid === -1) { console.error("rcon auth failed"); process.exit(2); }
        authed();
        continue;
      }
      if (type === 0 && resolver) {
        body += payload;
        arm();
      }
    }
  });

  const packet = (rid, type, text) => {
    const bytes = Buffer.byteLength(text, "utf8");
    const b = Buffer.alloc(4 + 8 + bytes + 2);
    let o = 0;
    b.writeInt32LE(10 + bytes, o); o += 4;
    b.writeInt32LE(rid, o); o += 4;
    b.writeInt32LE(type, o); o += 4;
    b.write(text, o, "utf8"); o += bytes;
    b[o++] = 0; b[o] = 0;
    return b;
  };

  const cmd = (src) => new Promise((resolve, reject) => {
    if (resolver) return reject(new Error("another command is in flight"));
    body = "";
    resolver = resolve;
    sock.write(packet(id++, 2, `/c ${src}`));
    setTimeout(() => { if (resolver === resolve) { resolver = null; reject(new Error("rcon timeout")); } }, 8000);
  });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  sock.connect(PORT, HOST, () => sock.write(packet(1, 3, PW)));

  return {
    ready: () => authGate,
    cmd,
    sleep,
    close: () => sock.end(),
    // Run the game for `ms` of wall time at `speed`, then pause again -- except while someone is in
    // the game, because a paused world freezes a human tester where they stand, and they have no way
    // to tell that from a crash. The rig pauses on purpose for its own windows; a connected player is
    // the signal that the server is not the probe's alone right now.
    async runFor(ms, speed) {
      await cmd(`game.tick_paused=false game.speed=${speed || 60} return 1`);
      await sleep(ms);
      await cmd("game.tick_paused=(#game.connected_players == 0) game.speed=1 return 1");
    },
  };
};
