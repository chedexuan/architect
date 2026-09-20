// Harness: node call.js <method> ['<json-args>']
// JSON is re-emitted as a Lua table literal because remote.call receives Lua, not JSON.
const { execFileSync } = require("child_process");
const path = require("path");

const PORT = process.env.RCON_PORT || "27015";
const PW = process.env.RCON_PW || "m0pw";

const method = process.argv[2] || "ping";
const rawArgs = process.argv[3] || "{}";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Reserved words (in, end, local...) and numeric-looking keys are not valid Lua
// identifiers; a bare key for them is a compile error, which RCON reports as silence.
const LUA_KEYWORDS = new Set(("and break do else elseif end false for function if in local nil not or repeat return "
  + "then true until while goto").split(" "));
const luaKey = (k) => (IDENT.test(k) && !LUA_KEYWORDS.has(k) && !/^[0-9]+$/.test(k))
  ? k : `["${k}"]`;

const toLua = (v) => {
  if (v === null) return "nil";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "{" + v.map(toLua).join(",") + "}";
  const parts = Object.entries(v).map(([k, val]) => `${luaKey(k)}=${toLua(val)}`);
  return "{" + parts.join(",") + "}";
};

let parsed;
try { parsed = JSON.parse(rawArgs); } catch (e) {
  console.error("args must be valid JSON:", e.message); process.exit(1);
}

const SENTINEL = "@@END-a7c3@@";
const cmd = `/c local ok,res=pcall(function() return remote.call("arch","call",${JSON.stringify(method)},${toLua(parsed)}) end) `
  + `rcon.print(ok and (tostring(res) .. "\\n${SENTINEL}") or ("BRIDGE_ERROR: " .. tostring(res) .. "\\n${SENTINEL}"))`;

const send = (warmup) => {
  try {
    return execFileSync(process.execPath, [path.join(__dirname, "rcon.js"), PORT, PW, warmup ? "/c return 1" : cmd], {
      encoding: "utf8", maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, RCON_SENTINEL: warmup ? "" : SENTINEL },
      stdio: ["ignore", "pipe", warmup ? "ignore" : "inherit"],
    });
  } catch (e) { return ""; }
};

send(true); // arms the achievements confirmation gate the first time per session
// No blind retry: a duplicate send would re-execute mutating methods.
const out = send();

const text = out.trim();
if (!text || text === "(empty response)") {
  console.error("(empty response — the mod is probably not loaded; check the server log)");
  process.exit(3);
}
try {
  const obj = JSON.parse(text);
  if (process.env.RAW === "1") { console.log(text); process.exit(0); }
  const bytes = Buffer.byteLength(text, "utf8");
  if (!obj.ok) {
    console.error(`FAILED [${obj.code}] ${obj.msg}`);
    if (obj.detail && obj.detail.prerequisites && obj.detail.prerequisites.length) {
      console.error("  prerequisites:");
      for (const p of obj.detail.prerequisites) {
        console.error(`    - ${p.technology}  → unlocks ${p.unlocks}  (needed for ${p.for_item})`);
      }
    } else if (obj.detail) console.error("  detail:", JSON.stringify(obj.detail));
    if (obj.known) console.error("  known methods:", obj.known.join(", "));
    process.exit(4);
  }
  console.error(`<= ${bytes} bytes | ~${Math.round(bytes / 3.6)} tokens | cost ${obj.cost_ticks} ticks`);
  console.log(JSON.stringify(obj.data, null, 2));
} catch (e) {
  console.log(text);
}
