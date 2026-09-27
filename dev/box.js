// Where a suite may put a box, asked of the server instead of remembered in a literal.
//
// The rule this exists to enforce: a box that only measures (`build = false`) is arithmetic and may
// name any rectangle it likes; a box that LAYS GHOSTS needs ground, and the only ground this mod
// guarantees is the painted, swept pad of `arch-sandbox` -- outside it the tiles belong to whatever
// the save's map generator made, including "nothing" past the map edge.
//
// Which is not a hypothetical: a 57.0-era suite wrote `x: 300` because the pad looked infinite, and the
// card fitted there right up until the chunk did not exist, at which point the answer became a fact
// about this save's map radius. Re-running the suites in a different order changed which of them saw
// it -- the generated region grows as other suites push chunks into existence. So the coordinates come
// from `sandbox().usable` now, and a box that does not fit the pad is an error HERE rather than a
// refusal three calls later.
//
// Usage:
//   const { padBox } = require("./box.js")(call);
//   const area = padBox(41, 41);        // next free 41x41 square inside the pad
//
// Boxes are handed out from a shelf pack, so two calls never overlap and the order in the file is the
// layout. Nothing here resets the world: a suite that lays ghosts still owes the pad a cleanup.
let state = null;

const pack = (w, h) => {
  if (!state) throw new Error('box.js needs a sandbox() call first -- use require("./box.js")(call)');
  if (!(w >= 1) || !(h >= 1)) throw new Error(`padBox(${w}, ${h}): a box has to have sides`);
  // Corners are inclusive on both axes, because that is what every caller here assumes: a 200-wide box
  // reads as `right_bottom.x - left_top.x === 199`.
  const at = (x, y) => ({ left_top: { x: x, y: y }, right_bottom: { x: x + w - 1, y: y + h - 1 } });
  const fits = (b) => b.right_bottom.x <= state.maxX && b.right_bottom.y <= state.maxY;
  let box = at(state.x, state.y);
  if (!fits(box)) {
    if (w > state.width || h > state.height) {
      throw new Error(`padBox(${w}, ${h}) is bigger than the prepared pad `
        + `(${state.width}x${state.height}); lay it on a surface of its own, or measure without building`);
    }
    state.y += state.tallest + 1; state.x = state.minX; state.tallest = 0;
    box = at(state.x, state.y);
    if (!fits(box)) throw new Error(`the pad (${state.width}x${state.height}) has no room left for ${w}x${h}`);
  }
  state.x += w + 1;
  state.tallest = Math.max(state.tallest, h);
  return box;
};

module.exports = (call) => {
  if (!state) {
    const r = call("sandbox", {});
    const u = (r && r.data && r.data.usable) || null;
    if (!u) throw new Error("sandbox() answered without a usable box; the bench is not ready");
    const lt = u.left_top, rb = u.right_bottom;
    state = { minX: lt.x, minY: lt.y, maxX: rb.x, maxY: rb.y,
              width: rb.x - lt.x + 1, height: rb.y - lt.y + 1,
              x: lt.x, y: lt.y, tallest: 0 };
  }
  return { padBox: pack, usable: state };
};
