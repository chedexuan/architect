// Two refusals, both earned the hard way.
//
// 1) Refuse to run a mutating suite against the server a client is connected to.
//
// Twice now a suite was started without `dev/test.sh` in front of it, and because `dev/call.js`
// defaults to RCON 27015, the suite did exactly what it does to the throwaway world: froze cards,
// laid ghosts, ran measurement drills that eat ore -- and a graceful server shutdown writes the
// result back into `.factorio-data/saves/m0.zip`, the file a player loads. Nothing in the output
// looks different, because both instances run the same mod on the same save seed.
//
// So the check belongs in the suite, not in the shell function that happens to call it: a suite that
// can be run by hand is a suite that will be run by hand.
//
// Read-only probes are unaffected -- this guards the suites that import it, and `ping`/`cards` do not.
//
// 2) Refuse to run a second suite while one is still on the bench (2026-10-11: this one is mine).
//
// Every mutating suite drives ONE bench surface (`arch-lab`) and a handful of world-scoped records:
// the rig places a card at a free spot, then reads its own rows back by entity index. Two suites on
// the same server therefore read each other's cards: last night four "台架读数全空" and a
// `face:"south"` card that was never the recipe's own came from exactly that, and I spent a while
// writing it up as a bench bug before noticing I had started the second run on top of the first.
// A 1.9 GB box makes it worse -- the first suite is still polling `lab_status` long after its shell
// looked finished -- so "I checked and it was empty" is not a control, and this file makes it one.
//
// The lock is the port, not the file being run: two suites against 27016 collide, while a read-only
// probe against the other instance does not. It is released on exit (including a thrown error), and
// a lock whose process is gone is treated as no lock at all, so a `kill -9` never bricks the bench.
// Deliberately overlapping is still possible -- `ALLOW_CONCURRENT_SUITES=1` says so out loud.
const fs = require("fs");
const path = require("path");
const os = require("os");

const MAIN_PORT = process.env.MAIN_RCON_PORT || "27015";

const lockPath = (port) => path.join(os.tmpdir(), `architect-suite-${port}.lock`);
const heldBy = (file) => {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); } catch (e) { return null; }
  const m = /^(\d+):(.*)$/.exec(raw.trim());
  if (!m) return null;
  const pid = Number(m[1]);
  try { process.kill(pid, 0); } catch (e) { return null; }   // stale: the holder is gone
  return { pid, name: m[2] };
};

const guardMain = (name) => {
  const port = process.env.RCON_PORT || MAIN_PORT;
  if (port === MAIN_PORT && process.env.ALLOW_MAIN_SUITE !== "1") {
    console.error(
      `${name}: refusing to run against RCON ${port}, which is the server a client is connected to.\n` +
      `  Prefix the command with \`bash dev/test.sh\` to run it against the throwaway instance, or set\n` +
      `  ALLOW_MAIN_SUITE=1 if you really mean to mutate the player's world.`
    );
    process.exit(2);
  }
  const file = lockPath(port);
  const busy = heldBy(file);
  if (busy && process.env.ALLOW_CONCURRENT_SUITES !== "1") {
    console.error(
      `${name}: refusing to start -- suite "${busy.name}" (pid ${busy.pid}) is still on RCON ${port}.\n` +
      `  One suite at a time: they share the bench surface and read each other's cards, which shows up\n` +
      `  as empty readings on a recipe that measures fine alone (dev/待办.md §0 第十二条).\n` +
      `  Wait for it, or set ALLOW_CONCURRENT_SUITES=1 if you mean to overlap them anyway.`
    );
    process.exit(2);
  }
  try {
    fs.writeFileSync(file, `${process.pid}:${name}\n`);
    process.on("exit", () => {
      try { if (heldBy(file) && heldBy(file).pid === process.pid) fs.unlinkSync(file); } catch (e) { /* gone anyway */ }
    });
  } catch (e) { /* a box where /tmp is read-only must not lose the port guard over a lock */ }
  return port;
};

// 借了东西的套件要还，**被 kill 也要还**（2026-10-12 一晚撞了两次：一把探针把 `game.tick_paused` 留在 true、
// 另一套把 `circuit-network` 关掉之后没还 —— 下一趟读回来是"面板铺不出 / 一秒都没跑"，长得和功能坏了
// 一模一样，而坏的其实是上一套的收尾）。`finally` 只管走到底的那一趟，所以这里挂的是 `exit` 与信号：
// `node` 收 SIGTERM 默认**不跑** exit 钩子，因此信号自己也要接一次再退。钩子必须同步（exit 那一刻不能再
// 来一次异步往返），而套件的归还本来就是一条同步 `/c`。
const exitHooks = [];
const runExitHooks = () => {
  for (const fn of exitHooks) {
    try { fn(); } catch (e) { /* 一件没还得动别件，更不该把整趟拖成第二个错 */ }
  }
};
let signalsArmed = false;
const onExit = (fn) => {
  exitHooks.push(fn);
  if (signalsArmed) return;
  signalsArmed = true;
  process.on("exit", runExitHooks);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { runExitHooks(); process.exit(1); });
  }
};

module.exports = { guardMain, lockPath, onExit };
