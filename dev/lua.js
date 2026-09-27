// Raw Lua probe: node lua.js '<lua body>'   (body without the leading /c)
// Errors are surfaced instead of swallowed, and the reply is sentinel-framed.
const { execFileSync } = require("child_process");
const path = require("path");

const PORT = process.env.RCON_PORT || "27015";
const PW = process.env.RCON_PW || "m0pw";
const SENTINEL = "@@END-a7c3@@";

const body = process.argv.slice(2).join(" ");
if (!body) { console.error("usage: node lua.js '<lua>'"); process.exit(1); }

// The body goes on its own line, and the closer too. A snippet that ends in a `-- comment` used to
// swallow `end) rcon.print(...)` -- same line, still a comment -- and the server answered
// "'end' expected (to close 'function' at line 1)": the command never ran, the reply was empty, and
// the suite reported it as whatever the missing value happened to break first, three frames away.
const cmd = `/c local ok,err=pcall(function()\n${body}\nend) `
  + `rcon.print(ok and "OK" or ("LUA_ERROR: " .. tostring(err))) rcon.print("${SENTINEL}")`;

const send = (extra, warm) => {
  const command = warm ? "/c return 1" : (extra || cmd);
  if (process.env.DEBUG) console.error("CMD:", JSON.stringify(command));
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "rcon.js"), PORT, PW, command], {
      encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, RCON_SENTINEL: warm ? "" : SENTINEL },
      // The warm-up command prints nothing on purpose, so rcon.js answers its request with
      // `(empty response)` on stderr. Left inherited it lands in a suite's output as four lines of
      // noise per run, which reads exactly like a broken server -- and it is a broken server only in
      // the real send, where the sentinel says whether the reply arrived.
      stdio: ["ignore", "pipe", warm ? "ignore" : "inherit"],
    }).trim();
  } catch (e) { return ""; }
};

send(null, true); // arms the achievements confirmation gate the first time per session
const out = send();
if (out) console.log(out);
else console.error("(no output — check that the mod is loaded and the server is up)");
