import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createInputReplayer, clamp, readViewerInput, charOf } from "../scripts/liveview/input.mjs";

// The shown tab: a CDP session that records what it's sent, and a page that records navigation.
function shownTab() {
  const cdp = new EventEmitter();
  cdp.sent = [];
  cdp.send = async (method, params) => { cdp.sent.push([method, params]); };
  const page = { visited: [], goto: async (u) => { page.visited.push(u); }, goBack: async () => page.visited.push("back"), goForward: async () => page.visited.push("forward"), reload: async () => page.visited.push("reload") };
  return { cdp, page };
}
const methods = (cdp) => cdp.sent.map(([m, p]) => (p?.type ? `${m}:${p.type}` : m));

test("a click is a press and a release, with drag interception around it", async () => {
  const r = createInputReplayer();
  const tab = shownTab();
  await r.replay(tab, { type: "mouse", action: "mousePressed", x: 10, y: 20, button: "left", buttons: 1, clickCount: 1 });
  await r.replay(tab, { type: "mouse", action: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 1 });
  assert.deepEqual(methods(tab.cdp), ["Input.setInterceptDrags", "Input.dispatchMouseEvent:mousePressed", "Input.dispatchMouseEvent:mouseReleased", "Input.setInterceptDrags"]);
  assert.deepEqual(tab.cdp.sent[1][1], { type: "mousePressed", x: 10, y: 20, modifiers: 0, button: "left", buttons: 1, clickCount: 1 });
  assert.deepEqual(tab.cdp.sent.filter(([m]) => m === "Input.setInterceptDrags").map(([, p]) => p.enabled), [true, false]);
});

test("an HTML drag the page starts is carried to where the viewer lets go", async () => {
  const r = createInputReplayer();
  const tab = shownTab();
  await r.attach(tab.cdp);
  await r.replay(tab, { type: "mouse", action: "mouseMoved", x: 5, y: 6 });
  tab.cdp.emit("Input.dragIntercepted", { data: { items: [{ mimeType: "text/plain", data: "x" }] } });
  await new Promise((resolve) => setImmediate(resolve));
  await r.replay(tab, { type: "mouse", action: "mouseMoved", x: 50, y: 60 });
  await r.replay(tab, { type: "mouse", action: "mouseReleased", x: 70, y: 80 });
  await r.replay(tab, { type: "mouse", action: "mouseMoved", x: 90, y: 90 });
  const drags = tab.cdp.sent.filter(([m]) => m === "Input.dispatchDragEvent").map(([, p]) => `${p.type}@${p.x},${p.y}`);
  assert.deepEqual(drags, ["dragEnter@5,6", "dragOver@50,60", "drop@70,80"]);
  assert.equal(methods(tab.cdp).at(-1), "Input.dispatchMouseEvent:mouseMoved", "after the drop, moves are plain moves again");
});

test("text is capped, and only the listed keys and editing commands are sent", async () => {
  const r = createInputReplayer();
  const tab = shownTab();
  await r.replay(tab, { type: "text", text: "x".repeat(5000) });
  assert.equal(tab.cdp.sent[0][1].text.length, 2000);
  tab.cdp.sent.length = 0;
  await r.replay(tab, { type: "key", key: "Enter" });
  await r.replay(tab, { type: "key", key: "Tab", modifiers: 8 });
  await r.replay(tab, { type: "key", key: "F12" });
  await r.replay(tab, { type: "key", key: "constructor" });
  await r.replay(tab, { type: "command", command: "undo", modifiers: 4 });
  await r.replay(tab, { type: "command", command: "copy" });
  await r.replay(tab, { type: "command", command: "toString" });
  await r.replay(tab, { type: "eval", code: "1" });
  assert.deepEqual(methods(tab.cdp), ["Input.dispatchKeyEvent:keyDown", "Input.dispatchKeyEvent:keyUp", "Input.dispatchKeyEvent:rawKeyDown", "Input.dispatchKeyEvent:keyUp", "Input.dispatchKeyEvent:rawKeyDown", "Input.dispatchKeyEvent:keyUp"]);
  assert.equal(tab.cdp.sent[0][1].text, "\r", "Enter types a return");
  assert.deepEqual(tab.cdp.sent[2][1], { type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: 8 });
  assert.deepEqual(tab.cdp.sent[4][1], { type: "rawKeyDown", key: "z", code: "KeyZ", windowsVirtualKeyCode: 90, modifiers: 4, commands: ["undo"] });
});

test("char replays keyDown with text and keyUp; Ctrl or Meta dropped", async () => {
  const r = createInputReplayer();
  const tab = shownTab();
  for (const ev of [{ text: "7" }, { text: "Q", modifiers: 8 }, { text: " " }, { text: "-", modifiers: 8 }, { text: "é" }, { text: "😀" }]) {
    const one = readViewerInput({ type: "char", ...ev }, { role: "turn" });
    assert.ok(one, JSON.stringify(ev));
    await r.replay(tab, one, "turn");
  }
  assert.deepEqual(methods(tab.cdp), Array(6).fill(["Input.dispatchKeyEvent:keyDown", "Input.dispatchKeyEvent:keyUp"]).flat());
  assert.deepEqual(tab.cdp.sent[0][1], { type: "keyDown", key: "7", code: "Digit7", windowsVirtualKeyCode: 55, modifiers: 0, text: "7", unmodifiedText: "7" }, "a one-time-code box that moves on keydown sees the digit");
  assert.deepEqual(tab.cdp.sent[1][1], { type: "keyUp", key: "7", code: "Digit7", windowsVirtualKeyCode: 55, modifiers: 0 });
  assert.deepEqual(tab.cdp.sent[2][1], { type: "keyDown", key: "Q", code: "KeyQ", windowsVirtualKeyCode: 81, modifiers: 8, text: "Q", unmodifiedText: "Q" });
  assert.deepEqual(tab.cdp.sent[5][1], { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, modifiers: 0 }, "Space ticks a focused checkbox on its key up");
  assert.equal(tab.cdp.sent[6][1].windowsVirtualKeyCode, 189, "Shift + '-' is the minus key, never Shift+Insert (45)");
  assert.deepEqual([tab.cdp.sent[8][1], tab.cdp.sent[10][1]].map((p) => [p.text, p.code, p.windowsVirtualKeyCode]), [["é", "", 0], ["😀", "", 0]]);

  // Refused when read: Ctrl, Cmd or Alt held, more than one character, control characters, junk.
  for (const ev of [{ text: "v", modifiers: 2 }, { text: "v", modifiers: 4 }, { text: "a", modifiers: 10 }, { text: "c", modifiers: 1 }, { text: "ab" }, { text: "" }, { text: "\r" }, { text: "\t" }, { text: "\u007f" }, { text: "\u0085" }, { text: "\ud800" }, { text: 7 }, {}]) {
    assert.equal(readViewerInput({ type: "char", ...ev }, { role: "owner" }), null, JSON.stringify(ev));
  }
  // And again when replayed, whatever reaches the replayer.
  tab.cdp.sent.length = 0;
  for (const ev of [{ text: "v", modifiers: 4 }, { text: "v", modifiers: 2 }, { text: "abc" }, { text: "\n" }]) await r.replay(tab, { type: "char", ...ev });
  assert.deepEqual(tab.cdp.sent, []);
  assert.equal(charOf("x", 8), "x");
  assert.equal(charOf("x", 6), null);
});

test("touch, wheel and back/forward/reload reach the tab", async () => {
  const r = createInputReplayer();
  const tab = shownTab();
  await r.replay(tab, { type: "touch", action: "touchStart", x: 1, y: 2 });
  await r.replay(tab, { type: "touch", action: "touchEnd", x: 1, y: 2 });
  await r.replay(tab, { type: "wheel", x: 3, y: 4, dy: 120 });
  assert.deepEqual(tab.cdp.sent.map(([, p]) => p.touchPoints?.length ?? p.deltaY), [1, 0, 120]);
  for (const action of ["back", "forward", "reload"]) await r.replay(tab, { type: "nav", action });
  assert.deepEqual(tab.page.visited, ["back", "forward", "reload"]);
});

test("viewers open web pages only, and invited ones never this computer's network", async () => {
  const r = createInputReplayer();
  const tab = shownTab();
  for (const url of ["example.com/docs", "file:///etc/passwd", "javascript:alert(1)", "chrome://settings", ""]) await r.replay(tab, { type: "nav", action: "go", url });
  assert.deepEqual(tab.page.visited, ["https://example.com/docs"]);
  await r.replay(tab, { type: "nav", action: "go", url: "localhost:3000" }, "guest");
  await r.replay(tab, { type: "nav", action: "go", url: "http://192.168.1.1/" }, "guest");
  assert.deepEqual(tab.page.visited, ["https://example.com/docs"]);
  await r.replay(tab, { type: "nav", action: "go", url: "localhost:3000" }, "owner");
  assert.deepEqual(tab.page.visited, ["https://example.com/docs", "http://localhost:3000"]);
});

test("Fit to pane takes the viewer's size within limits, and a new tab gets it too", async () => {
  const r = createInputReplayer();
  const tab = shownTab();
  await r.replay(tab, { type: "viewport", on: true, w: 100, h: 99999, dpr: 9 });
  assert.deepEqual(tab.cdp.sent[0], ["Emulation.setDeviceMetricsOverride", { width: 320, height: 3000, deviceScaleFactor: 3, mobile: false }]);
  assert.deepEqual(tab.cdp.sent.slice(1).map(([m]) => m), ["Page.stopScreencast", "Page.startScreencast"]);
  assert.deepEqual(tab.cdp.sent[2][1], { format: "jpeg", quality: 60, maxWidth: 320, maxHeight: 1920 });
  const next = shownTab();
  await r.attach(next.cdp);
  assert.equal(next.cdp.sent[0][0], "Emulation.setDeviceMetricsOverride");
  await r.replay(tab, { type: "viewport", on: false });
  assert.equal(tab.cdp.sent.at(-3)[0], "Emulation.clearDeviceMetricsOverride");
  assert.deepEqual(tab.cdp.sent.at(-1)[1], { format: "jpeg", quality: 60, maxWidth: 1600, maxHeight: 1600 });
  r.resetFit();
  const after = shownTab();
  await r.attach(after.cdp);
  assert.deepEqual(after.cdp.sent, []);
});

test("events with no tab shown are dropped", async () => {
  const r = createInputReplayer();
  await assert.doesNotReject(r.replay(null, { type: "mouse", action: "mousePressed", x: 1, y: 1 }));
});

test("clamp rounds into range, and junk becomes the low end", () => {
  assert.equal(clamp(10.6, 0, 20), 11);
  assert.equal(clamp(-5, 0, 20), 0);
  assert.equal(clamp(50, 0, 20), 20);
  assert.equal(clamp("abc", 320, 3000), 320);
  assert.equal(clamp(undefined, 240, 3000), 240);
});
