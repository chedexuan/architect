// Static gate: every GUI key the mod writes must exist in the installed 2.0 API.
//
// A headless server cannot build a widget, so "does the engine accept this spec" is
// untestable without a client. What IS testable is whether the name exists at all in the
// authoritative local API -- which is how `element.style.horizontally_stretch` (a 1.1 idiom,
// absent from 2.0's docs entirely) got caught before anyone opened the window.
//
// Runs in dev/cycle.sh: a rebuild fails on an unknown GUI key instead of a player finding it.
const fs = require("fs");
const path = require("path");

const DOC = process.env.FACTORIO_DOC || path.join(__dirname, "..", "doc-html");
const j = JSON.parse(fs.readFileSync(path.join(DOC, "runtime-api.json"), "utf8"));
const cls = (n) => j.classes.find((c) => c.name === n);
const gui = cls("LuaGuiElement");
const attrs = new Set((gui.attributes || []).map((a) => a.name));
const methods = new Set((gui.methods || []).map((m) => m.name));
const addParams = new Set(((gui.methods.find((m) => m.name === "add") || {}).parameters || []).map((p) => p.name));

// `add{...}` accepts the generic params plus any writable attribute (the engine applies the
// table as attribute writes after constructing by `type`), and `name` is always fine.
const legal = new Set([...addParams, ...attrs, ...methods, "children", "parent", "type"]);
// attributes the mod sets on the element itself: must be writable attributes in the docs
const writable = new Set((gui.attributes || [])
  .filter((a) => a.write_type && !(Array.isArray(a.write_type) && a.write_type.length === 0))
  .map((a) => a.name));

const file = path.join(__dirname, "..", "src", "architect", "gui.lua");
const src = fs.readFileSync(file, "utf8");

const problems = [];
const addBlocks = src.match(/\badd\s*\{([^}]*)\}/g) || [];
for (const block of addBlocks) {
  const body = block.slice(block.indexOf("{") + 1, -1);
  for (const m of body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) {
    const key = m[1];
    if (key === "return" || key === "true" || key === "false") continue;
    if (!legal.has(key) && !writable.has(key)) {
      problems.push(`add{} key "${key}" is not in the 2.0 LuaGuiElement API`);
    }
  }
}
// The `type` value itself. The key check above cannot see a wrong widget name: `type = "drodownlist"`
// is a legal key with an illegal value, and the only thing that notices is a player whose panel fails
// to build. The authoritative list is the `GuiElementType` concept in this same file -- read from it
// rather than remembered, because 2.0 renamed half of these (`drop-down`, not the 1.1-era typo).
const elementTypeConcept = (j.concepts || []).find((c) => c.name === "GuiElementType");
const elementTypes = new Set(((elementTypeConcept || {}).type || {}).options
  ? (elementTypeConcept.type.options || []).map((o) => o.value) : []);
if (elementTypes.size === 0) {
  problems.push("GuiElementType is missing from runtime-api.json -- the type check below proves nothing");
} else {
  for (const m of src.matchAll(/\btype\s*=\s*"([a-z-]+)"/g)) {
    if (!elementTypes.has(m[1])) {
      problems.push(`widget type "${m[1]}" is not a GuiElementType (known: ${[...elementTypes].sort().join(", ")})`);
    }
  }
}

// 1.1 里 `element.style.<属性>` 调的是单件样式，2.0 的文档把 `style` 说成"样式名字（字符串）"，
// 所以这一族曾被认为是必错。**2026-10-13 在 2.0.77 上用真实 GUI（有玩家的那台）实测推翻了这条**：
// `sp.style.minimal_height = 300` 写得进、读得回 300/300，`vertical_scroll_policy` 同理
// —— 这一格的 `style` 是 LuaStyle 那张表，不是名字。所以禁掉整个写法会把唯一的定尺寸手段一起禁掉
// （面板改成固定宽高的滑动列表靠的就是这一格）。
// 禁改成"校验属性名"：属性名必须在 runtime-api 的 `LuaStyle` 里存在。这条比原规则更严 ——
// 它照样抓住 `horizontally_stretch` 那种拼错/1.1 遗留（不在 LuaStyle 的属性表里），
// 同时不再拦住合法属性。
const styleAttrs = new Set(((cls("LuaStyle") || {}).attributes || []).map((a) => a.name));
for (const m of src.matchAll(/\.\s*style\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
  if (!styleAttrs.has(m[1])) {
    problems.push(`"${m[1]}" set via element.style.<attr>: not an attribute of LuaStyle in this install's `
      + `runtime-api.json (量过：2.0.77 上 element.style 就是 LuaStyle 那张表，写得进也读得回，`
      + `所以这一格的错只能是属性名本身)`)
  }
}

const ROOT_NAME = (src.match(/local ROOT = "(\w+)"/) || [, "arch"])[1];

// 窗口上每一颗按钮都得有人接着（2026-10-13 他第 5 条删掉"压这页/选这页/放进背包/撤销"那一串之后，
// `arch-undo` 那颗**还在建**，而点击处理里派发它的那一栏已经删了 —— 玩家按下去什么都不会发生）。
// 这类事只有"把窗口按一遍"才看得见，所以这里先按源码静态对一遍，再由 `gui_selftest` 真按一次：
//   ① 窗口建出来的每一颗 `name = "arch-..."`，必须出现在 `G.COMMAND_BUTTONS`、或点击处理里
//     `element_name == "arch-..."` / 前缀派发（`arch-hf-copy:` 那种带参数的名字）之中；
//   ② `COMMAND_BUTTONS` 里点名的每一颗，必须真的被建出来（名单与窗口不许各记一份）。
const buttonsBuilt = new Set();
// 只看**玩家能按的东西**：flow / frame / label / scroll-pane 挂着名字是给自测与套件找零件用的，
// 不是一颗会失灵的按钮。所以按 `add{}` 那一块的 `type` 筛，而不是手列一份"哪些名字算容器"的清单
// —— 清单会随窗口改一遍就落后，落后的清单会把没做的事说成做了。
const INTERACTIVE = /^(button|sprite-button|checkbox|checkbox-switch|switch|toggle|slider|textfield|input-text|drop-down|select|textbox-list|checkbox_flow)$/;
const addBlocksAll = src.match(/\badd\s*\{([^}]*)\}/g) || [];
for (const block of addBlocksAll) {
  const body = block.slice(block.indexOf("{") + 1, -1);
  const type = (body.match(/type\s*=\s*"([a-z_-]+)"/) || [, ""])[1];
  const nm = (body.match(/name\s*=\s*"(arch-[A-Za-z0-9_-]+)/) || [, ""])[1];
  if (!nm || !INTERACTIVE.test(type)) continue;
  buttonsBuilt.add(nm);
}
const commandList = (src.match(/G\.COMMAND_BUTTONS\s*=\s*\{([^}]*)\}/s) || [, ""])[1];
const commandNames = new Set((commandList.match(/"arch-[A-Za-z0-9_-]+"/g) || []).map((x) => x.slice(1, -1)));
const verbList = (src.match(/local VERB = \{([^}]*)\}/s) || [, ""])[1];
const verbNames = new Set((verbList.match(/"(arch-[A-Za-z0-9_-]+)"/g) || []).map((x) => x.slice(1, -1)));
const dispatchNames = new Set();
for (const m of src.matchAll(/"(arch-[A-Za-z0-9_-]+)/g)) dispatchNames.add(m[1]);
// 一个名字只要"窗口建它的那一句"之外还有地方读它，就算有人接着：派发里比较 `element_name`、
// 前缀匹配、`G.find(frame, "...")`、自测点名，都算。
// 带参数的名字（行尾那颗「复制」= `arch-hf-<动词>:<页 id>`）不靠字面量派发：`gui.lua` 里 `hf_split`
// 用的是 Lua 模式 `^arch%-hf%-(%a+):(.+)$`。所以单独认这一族 —— 但认的是"那条模式真的在文件里"，
// 不是我随口给一个前缀放行（随口放行等于把门禁写成"我记得的样子"）。
const hfDispatched = /^arch%-hf%-\(%a\+\):/m.test(src) || src.includes('"^arch%-hf%-(%a+):(.+)$"');
const handers = (n) => commandNames.has(n) || verbNames.has(n)
  || src.split(`"${n}`).length - 1 >= 2 || src.split(`'${n}`).length - 1 >= 2
  || (n.startsWith("arch-hf-") && hfDispatched);
for (const n of buttonsBuilt) {
  if (!handers(n)) {
    problems.push(`"${n}" is a control the window builds, but no other line in gui.lua names it: a button `
      + `the player can press and that does nothing (this is how arch-undo stayed on the window after `
      + `its dispatch was deleted, 2026-10-13 他第 5 条那一串)`);
  }
}
for (const n of commandNames) {
  // 这里的豁免只有"行尾那颗带页 id 的按钮"（名字在运行时拼出来，静态扫不到）。`arch-bus-` 那条跟着
  // 总线一起删了：留着一个窗口里已经没有的家族名当豁免，就是给下一颗按下去不会有任何反应的键开后门。
  if (!buttonsBuilt.has(n) && !n.startsWith("arch-hf-")) {
    problems.push(`"${n}" is in G.COMMAND_BUTTONS but the window never builds it as a control (self-test `
      + `would press a name that is not there, and the player never sees it either)`);
  }
}

const seen = new Set();
const uniq = problems.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
if (uniq.length) {
  console.error("gui API check FAILED:\n  " + uniq.join("\n  "));
  process.exit(1);
}
console.log(`gui API ok (${addBlocks.length} add{} sites, ${attrs.size} documented attributes)`);
