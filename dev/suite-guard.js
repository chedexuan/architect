// Refuse to run a mutating suite against the server a client is connected to.
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
const MAIN_PORT = process.env.MAIN_RCON_PORT || "27015";

const guardMain = (name) => {
  const port = process.env.RCON_PORT || MAIN_PORT;
  if (port !== MAIN_PORT || process.env.ALLOW_MAIN_SUITE === "1") return port;
  console.error(
    `${name}: refusing to run against RCON ${port}, which is the server a client is connected to.\n` +
    `  Prefix the command with \`bash dev/test.sh\` to run it against the throwaway instance, or set\n` +
    `  ALLOW_MAIN_SUITE=1 if you really mean to mutate the player's world.`
  );
  process.exit(2);
};

module.exports = { guardMain };
