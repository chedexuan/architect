# The mod's own toolbar art, written out rather than edited by hand.
#
# A shortcut prototype needs a FILE (mods may not reference base game art), and the two sizes the
# toolbar asks for have to agree with each other. So they are the same drawing computed from `size`:
# a plan seen from above -- dark ground, two lanes running east, the machine cells and one arm's hand.
#
#   python3.11 dev/make_icon.py        # writes src/architect/graphics/icons/architect-{32,24}.png
import os, struct, zlib


def px_row(w, fn):
    return [fn(x) for x in range(w)]


def build(size):
    # A plan seen from above: a dark ground, three lanes running east, and the two arms that fill them.
    # Everything is computed from `size` so the 32 and the 24 are the same drawing, not two hand-made
    # files that can disagree.
    S = size
    blue = (27, 58, 92, 255)        # ground
    lane = (127, 196, 232, 255)     # a belt lane
    machine = (203, 230, 246, 255)  # a machine cell
    arm = (255, 209, 102, 255)      # an arm's hand
    clear = (0, 0, 0, 0)

    def inside(x, y):
        # A rounded square: a pixel that is short of both edges lies in a corner quadrant, and it
        # survives only inside that corner's radius.
        r = max(2, S // 8)
        cx = r if x < r else (S - 1 - r if x > S - 1 - r else None)
        cy = r if y < r else (S - 1 - r if y > S - 1 - r else None)
        if cx is not None and cy is not None:
            return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
        return True

    lane_rows = {int(S * f) for f in (0.30, 0.34, 0.62, 0.66)}
    cols = {int(S * 0.14), int(S * 0.50), int(S * 0.86)}

    def colour(x, y):
        if not inside(x, y):
            return clear
        if y in lane_rows or x in cols:
            return lane
        # two machine cells, one above the lanes and one below
        for my in (int(S * 0.14), int(S * 0.80)):
            if abs(y - my) <= max(1, S // 12) and abs(x - int(S * 0.5)) <= max(1, S // 6):
                return machine
        # the arm's hand sits on the middle lane, east of the machine
        if abs(y - int(S * 0.5)) <= max(1, S // 12) and abs(x - int(S * 0.72)) <= max(1, S // 10):
            return arm
        return blue

    return [px_row(S, lambda x: colour(x, y)) for y in range(S)]


def write_png(path, pixels):
    h, w = len(pixels), len(pixels[0])
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in row) for row in pixels)

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    blob = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(blob)
    return len(blob)


# 排法那一颗钮的脸（2026-10-14 深夜他第 5 条要"图标选项"，而他 10-15 指出我还是给了字）。
# 不画艺术，只把这一档**俯看是几条横带**画出来：带子=浅色横条，机器=中间那一坨方块，
# 液体档用蓝带。四档长得不一样是因为横带的**数量与位置**不一样 —— 玩家要的是"选之前看得出差别"。
STYLE_ROWS = {
  # 一行一个标记：f 进料带、p 成品带、F 进料管、P 出料管、m 机器、空=地。
  # 四档长得不一样，是因为带子与机器行**各有几条、排在第几行**。
  "stacked":       ["", "f", "m", "m", "m", "p", "", ""],
  "two-row":       ["", "f", "m", "p", "m", "f", "", ""],
  "fluid-back":    ["", "F", "m", "m", "m", "p", "", ""],
  "fluid-through": ["", "F", "m", "m", "m", "P", "", ""],
}

COLORS = {
  "":  (24, 26, 30, 255),        # 地
  "f": (196, 186, 150, 255),     # 固体带
  "p": (206, 196, 160, 255),
  "F": (56, 132, 200, 255),      # 管子里的料
  "P": (72, 152, 220, 255),
  "m": (27, 58, 92, 255),        # 机器那一格
}
EDGE = (120, 112, 88, 255)


def style_build(which, size):
  """把 8×8 的格子放大到 size×size：一行一个标记，横向按格取色。"""
  rows = STYLE_ROWS[which]
  px = []
  for y in range(size):
    gy = y * 8 // size
    tag = rows[gy] if gy < len(rows) else ""
    line = []
    for x in range(size):
      gx = x * 8 // size
      if tag == "m":
        c = COLORS["m"] if gx in (1, 2, 3, 4, 5) else COLORS[""]
      elif tag in ("f", "p", "F", "P"):
        c = EDGE if gx % 4 == 3 else COLORS[tag]
      else:
        c = COLORS[""]
      line.append(c)
    px.append(line)
  return px


if __name__ == "__main__":
    out = os.environ.get("ICON_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)),
      "..", "src", "architect", "graphics", "icons"))
    os.makedirs(out, exist_ok=True)
    for which in sorted(STYLE_ROWS):
        p2 = os.path.join(out, "style-%s-24.png" % which)
        print("%s %d bytes" % (p2, write_png(p2, style_build(which, 24))))
    for size in (32, 24):
        p = os.path.join(out, "architect-%d.png" % size)
        n = write_png(p, build(size))
        print("%s %d bytes" % (p, n))
