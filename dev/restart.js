// Save the world and load it back, for gates that ask what a SECOND process would see.
//
// The reason this is a shared file and not a few lines in each gate: a mod bug that only shows up in a
// process which LOADS the game -- a joining client, a server after a restart -- cannot be reproduced by
// any amount of single-process poking, and the two gates that need it (a measurement in flight, a
// placement waiting to be undone) are otherwise tempted to skip the hard part and assert on the easy
// one. `stop.sh` is deliberately not used here: it `kill -9`s, which is right for a dev cycle that must
// come back to the on-disk world and wrong for a gate that needs the save to have happened.
//
// Usage: const r = require("./restart.js")({ root: __dirname + "/.." , rconPort: 27016,
//          save: process.env.TEST_SAVE || "m0-test", log: ".../server.out" });
//        if (!r.stopAndSave().saved) ... ; r.startAndPing();
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

module.exports = (cfg) => {
  const ROOT = cfg.root;
  const ENV = { ...process.env, ...(cfg.env || {}) };
  const LOG = cfg.log;
  const SAVE = path.join(ROOT, ".factorio-test/saves", (cfg.save || "m0-test") + ".zip");
  const sleep = (ms) => execFileSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);
  const pid = () => {
    try {
      return execFileSync("bash", ["-c",
        `ss -ltnp "sport = :${cfg.rconPort}" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2`],
        { encoding: "utf8" }).trim();
    } catch (e) { return ""; }
  };

  return {
    // SIGTERM, then wait for the process to be gone AND for the log to say it wrote the file -- a save
    // that did not happen turns "the reloaded process" into "the same old world", which is how the
    // first version of the lab gate "found" a bug that was its own harness.
    stopAndSave(timeoutSeconds) {
      const target = pid();
      if (!target) return { saved: false, why: "no server listening on " + cfg.rconPort };
      const mark = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
      const mtime = fs.existsSync(SAVE) ? fs.statSync(SAVE).mtimeMs : 0;
      process.kill(Number(target), "SIGTERM");
      for (let i = 0; i < (timeoutSeconds || 90); i++) {
        sleep(1000);
        if (fs.existsSync(`/proc/${target}`)) continue;
        const tail = fs.existsSync(LOG) ? fs.readFileSync(LOG).slice(mark).toString("utf8") : "";
        const wrote = /Saving map as/.test(tail);
        const fresh = fs.existsSync(SAVE) && fs.statSync(SAVE).mtimeMs > mtime;
        return { saved: wrote && fresh, wrote, fresh, pid: target, log: tail.slice(0, 300) };
      }
      return { saved: false, why: "still alive after " + (timeoutSeconds || 90) + "s" };
    },
    startAndPing(waitSeconds) {
      const out = fs.openSync(cfg.stdout || path.join(ROOT, ".factorio-test/server.out"), "a");
      const child = spawn("bash", [cfg.launcher || path.join(ROOT, "dev/server-test.sh")],
        { cwd: ROOT, env: ENV, stdio: ["ignore", out, out], detached: true });
      child.unref();
      for (let i = 0; i < (waitSeconds || 40); i++) {
        sleep(3000);
        try {
          const ok = execFileSync(process.execPath, [path.join(__dirname, "call.js"), "ping", "{}"],
            { encoding: "utf8", env: { ...ENV, RAW: "1" }, timeout: 20000 });
          if (/"ok":\s*true/.test(ok)) return true;
        } catch (e) { /* not up yet */ }
      }
      return false;
    },
  };
};
