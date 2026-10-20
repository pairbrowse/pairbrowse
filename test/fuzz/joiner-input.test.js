// Property-based fuzzing of a joiner's keys in shared browser mode: whatever names a key arrives
// with (key, code, key code) and whatever modifiers, nothing that reads or writes the host's
// clipboard reaches the page.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { readInput } from "../../scripts/daemon/screenshare.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
// A fixed seed: every run tries the same cases, so a failure repeats (set PAIRBROWSE_FUZZ_SEED to explore).
const SEED = Number(process.env.PAIRBROWSE_FUZZ_SEED) || 20261015;
const check = (property) => fc.assert(property, { numRuns: RUNS, seed: SEED });
const view = { w: 1000, h: 800 };

const key = fc.oneof(
  fc.constantFrom("c", "C", "x", "X", "v", "V", "q", "a", "z", "Insert", "Delete", "Copy", "Cut", "Paste", "Enter", "Tab", "Control", "Meta", "Shift", "", "ç", "√"),
  fc.string({ maxLength: 4 }),
);
const code = fc.oneof(
  fc.constantFrom("KeyC", "KeyX", "KeyV", "KeyQ", "KeyA", "Insert", "Delete", "Numpad0", "NumpadDecimal", "Copy", "Cut", "Paste", "Digit1", ""),
  fc.string({ maxLength: 8 }),
);
const kc = fc.oneof(fc.constantFrom(67, 86, 88, 45, 46, 81, 65, 0, -1, 300, "86", 86.5), fc.integer({ min: -5, max: 300 }));
const mods = fc.oneof(fc.integer({ min: 0, max: 15 }), fc.constantFrom(-1, 16, 2 ** 31, "2", null, 6.5));

// What the page and the engine's editing could read as copy, cut or paste.
function clipboard(ev) {
  const m = ev.modifiers;
  const names = [ev.key, ev.code];
  if (names.some((n) => ["Copy", "Cut", "Paste"].includes(n))) return "Copy/Cut/Paste key";
  if (m & 6 && (/^[cxv]$/i.test(ev.key) || ["KeyC", "KeyX", "KeyV"].includes(ev.code) || [67, 86, 88].includes(ev.keyCode))) return "Ctrl/Cmd + C/X/V";
  const insert = ev.key === "Insert" || ev.code === "Insert" || ev.keyCode === 45;
  const del = ev.key === "Delete" || ev.code === "Delete" || ev.keyCode === 46;
  if (insert && m & 14) return "Shift/Ctrl/Cmd + Insert";
  if (del && m & 8) return "Shift + Delete";
  return null;
}

test("no key a joiner sends copies, cuts or pastes with the host's clipboard", () => {
  check(fc.property(fc.constantFrom("down", "up"), key, code, kc, mods, (a, k, c, n, m) => {
    const ev = readInput({ t: "key", a, key: k, code: c, kc: n, m }, view);
    if (!ev) return;
    assert.equal(clipboard(ev), null, JSON.stringify({ k, c, n, m, ev }));
    // With Ctrl or Cmd, the key code is the one worked out here, never the one sent.
    if (ev.modifiers & 6 && n !== ev.keyCode) assert.ok(![67, 86, 88].includes(ev.keyCode));
  }));
});

test("the known ways around a key-only check are refused", () => {
  const no = (ev, why) => assert.equal(readInput({ t: "key", a: "down", ...ev }, view), null, why);
  no({ key: "q", code: "KeyQ", kc: 86, m: 2 }, "Ctrl + key code V");
  no({ key: "q", code: "KeyV", kc: 81, m: 4 }, "Cmd + code KeyV");
  no({ key: "Insert", code: "Insert", kc: 45, m: 8 }, "Shift+Insert pastes");
  no({ key: "q", code: "KeyQ", kc: 45, m: 8 }, "Shift + key code Insert");
  no({ key: "Insert", code: "Insert", kc: 45, m: 2 }, "Ctrl+Insert copies");
  no({ key: "Delete", code: "Delete", kc: 46, m: 8 }, "Shift+Delete cuts");
  no({ key: "Delete", code: "NumpadDecimal", kc: 46, m: 8 }, "Shift+Delete on the keypad");
  no({ key: "Paste", code: "Paste", m: 0 }, "the Paste key");
  no({ key: "q", code: "Copy", m: 0 }, "the Copy key by code");
  no({ key: "Cut", code: "", m: 0 }, "the Cut key by name");
  // A key code worked out from the character: "-" is 45 (Insert), "." 46 (Delete). Found by fuzzing.
  assert.equal(readInput({ t: "key", a: "down", key: "-", code: "KeyC", kc: -1, m: 8 }, view).keyCode, 189, "Shift + '-' is never sent as Shift+Insert (45)");
  no({ key: "-", code: "KeyC", kc: -1, m: 4 }, "Cmd + physical C");
  no({ key: "-", code: "KeyC", kc: -1, m: 2 }, "Ctrl + physical C");
  assert.equal(readInput({ t: "key", a: "down", key: "-", code: "Minus", kc: 0, m: 8 }, view).keyCode, 189, "Shift + '-' is the minus key");
  assert.equal(readInput({ t: "key", a: "down", key: ".", code: "Period", kc: 0, m: 8 }, view).keyCode, 190, "Shift + '.' is the period key, not Delete");
  assert.equal(readInput({ t: "key", a: "down", key: "toString", code: "", kc: 0, m: 2 }, view).keyCode, 0, "names off the prototype are no key codes");
  assert.equal(readInput({ t: "key", a: "down", key: "constructor", code: "", kc: 0, m: 0 }, view).keyCode, 0);
  // What keeps working: plain typing, shortcuts that aren't the clipboard's, Delete and Insert alone.
  assert.equal(readInput({ t: "key", a: "down", key: "v", code: "KeyV", kc: 86, m: 0 }, view).text, "v");
  assert.equal(readInput({ t: "key", a: "down", key: "z", code: "KeyW", kc: 90, m: 2 }, view).keyCode, 90, "Ctrl+Z on AZERTY is still undo");
  assert.equal(readInput({ t: "key", a: "down", key: "a", code: "KeyA", kc: 86, m: 4 }, view), null, "a key code that says V is refused");
  assert.equal(readInput({ t: "key", a: "down", key: "Delete", code: "Delete", kc: 46, m: 0 }, view).keyCode, 46);
  assert.equal(readInput({ t: "key", a: "down", key: "Delete", code: "Delete", kc: 46, m: 2 }, view).keyCode, 46, "Ctrl+Delete deletes a word");
  assert.equal(readInput({ t: "key", a: "down", key: "Insert", code: "Insert", kc: 45, m: 0 }, view).keyCode, 45);
});

// The live view's input path (an invite link's viewer driving the host's tab): the same rules.
test("an invited viewer's live view input: places inside the picture, no clipboard, known kinds only", async () => {
  const { readViewerInput } = await import("../../scripts/liveview/input.mjs");
  const frame = { w: 1200, h: 800 };
  const anyEv = fc.record({
    type: fc.constantFrom("mouse", "touch", "wheel", "text", "char", "nav", "viewport", "command", "key", "evaluate", ""),
    action: fc.constantFrom("mousePressed", "mouseMoved", "touchStart", "touchEnd", "go", "back", "x"),
    x: fc.oneof(fc.double({ min: -5000, max: 5000, noNaN: false }), fc.constant("10")), y: fc.double({ min: -5000, max: 5000 }),
    command: fc.constantFrom("cut", "selectAll", "undo", "redo", "copy", "paste", "__proto__"),
    key: fc.constantFrom("Delete", "Enter", "v", "Insert", "Backspace", "toString"),
    modifiers: fc.oneof(fc.integer({ min: -2, max: 40 }), fc.constant("8")),
    text: fc.string({ maxLength: 3000 }), url: fc.string({ maxLength: 40 }), on: fc.boolean(),
  }, { requiredKeys: ["type"] });
  check(fc.property(anyEv, (ev) => {
    const out = readViewerInput(ev, { frame, role: "drive" });
    if (!out) return;
    assert.ok(["mouse", "touch", "wheel", "text", "char", "nav", "command", "key"].includes(out.type), out.type);
    if ("x" in out && out.type !== "touch") assert.ok(out.x >= 0 && out.x <= frame.w && out.y >= 0 && out.y <= frame.h, JSON.stringify(out));
    if (out.type === "command") assert.notEqual(out.command, "cut");
    if (out.type === "key") assert.ok(!(out.key === "Delete" && out.modifiers & 8), "Shift+Delete cuts");
    if (out.type === "text") assert.ok(out.text.length <= 2000);
    if (out.type === "char") assert.ok([...out.text].length === 1 && (out.modifiers === 0 || out.modifiers === 8), JSON.stringify(out));
    if ("modifiers" in out) assert.ok(Number.isInteger(out.modifiers) && out.modifiers >= 0 && out.modifiers <= 15);
  }));
  assert.equal(readViewerInput({ type: "command", command: "cut" }, { role: "drive" }), null);
  assert.deepEqual(readViewerInput({ type: "command", command: "cut", modifiers: 4 }, { role: "owner" }), { type: "command", command: "cut", modifiers: 4 }, "the owner's own cut stays");
  assert.equal(readViewerInput({ type: "viewport", on: true, w: 10, h: 10 }, { role: "drive" }), null);
  assert.equal(readViewerInput({ type: "mouse", action: "mousePressed", x: 1300, y: 10 }, { frame, role: "drive" }), null, "outside the picture");
});

// A hand-off viewer's type box (one `char` per character): whatever text and modifiers arrive, what
// reaches the page is one key press of one printable character, with Shift or nothing held, and
// never a key code that is Insert or Delete (Shift + either pastes or cuts).
test("char never carries more than one character or a modifier other than Shift", async () => {
  const { readViewerInput, createInputReplayer } = await import("../../scripts/liveview/input.mjs");
  const sent = [];
  const tab = { page: {}, cdp: { send: async (method, params) => { sent.push([method, params]); } } };
  const replayer = createInputReplayer();
  const text = fc.oneof(
    fc.string({ maxLength: 4 }), fc.string({ unit: "grapheme", maxLength: 3 }), fc.string({ unit: "binary", maxLength: 3 }),
    fc.constantFrom("v", "c", "x", "-", ".", " ", "\r", "\n", "\t", "\b", "\u007f", "\u0085", "\ud83d", "\ud83d\ude00", "e\u0301", "Insert", "Delete"),
    fc.constantFrom(null, 7, ["a"], { toString: () => "a" }),
  );
  check(fc.asyncProperty(text, mods, fc.constantFrom("owner", "drive", "turn"), async (t, m, role) => {
    const out = readViewerInput({ type: "char", text: t, modifiers: m }, { role });
    if (!out) return;
    assert.equal(out.type, "char");
    assert.equal([...out.text].length, 1, JSON.stringify(out));
    assert.ok(out.text.codePointAt(0) >= 0x20 && out.text !== "\u007f", JSON.stringify(out));
    assert.ok(out.modifiers === 0 || out.modifiers === 8, JSON.stringify(out));
    sent.length = 0;
    await replayer.replay(tab, out, role);
    assert.deepEqual(sent.map(([method, p]) => `${method}:${p.type}`), ["Input.dispatchKeyEvent:keyDown", "Input.dispatchKeyEvent:keyUp"]);
    for (const [, p] of sent) {
      assert.ok(!(p.modifiers & 7), JSON.stringify(p));
      assert.ok(![45, 46].includes(p.windowsVirtualKeyCode), JSON.stringify(p));
      assert.ok(!p.commands, "no editing command rides along");
    }
    assert.equal(sent[0][1].text, out.text);
  }));
});
