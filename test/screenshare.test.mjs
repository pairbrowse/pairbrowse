// Shared browser mode's checks: the picture's size, what a joiner's input may be, the files a
// joiner's agent may name, and whose a field is after a joiner typed in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameFor, readInput, createScreenShare } from "../scripts/daemon/screenshare.mjs";
import { pathsIn, withPaths } from "../scripts/daemon/serve.mjs";
import { fieldOwner } from "../scripts/daemon/fields.mjs";
import { preflight } from "../scripts/runner.mjs";

test("the picture keeps the tab's shape, at most 1920 a side, in even pixels", () => {
  assert.deepEqual(frameFor(1366, 900, 2), { w: 1920, h: 1266 });
  assert.deepEqual(frameFor(800, 600, 1), { w: 800, h: 600 });
  assert.deepEqual(frameFor(500, 1500, 2), { w: 640, h: 1920 });
});

test("a joiner's input: places inside the tab, known kinds, keys as one press, never the host's clipboard", () => {
  const view = { w: 1000, h: 500 };
  assert.deepEqual(readInput({ t: "mouse", a: "mousePressed", nx: 0.5, ny: 0.2, b: "left", bs: 1, c: 1, m: 0 }, view), { type: "mouse", action: "mousePressed", x: 500, y: 100, button: "left", buttons: 1, clickCount: 1, modifiers: 0 });
  assert.equal(readInput({ t: "mouse", a: "mouseMoved", nx: 0.1, ny: 0.1, b: "none", bs: 1 }, view).button, "left", "a move with the button down is a drag");
  assert.equal(readInput({ t: "mouse", a: "mousePressed", nx: 1.5, ny: 0.2 }, view), null, "outside the tab");
  assert.equal(readInput({ t: "evaluate", code: "x" }, view), null);
  assert.deepEqual(readInput({ t: "key", a: "down", key: "a", code: "KeyA", kc: 65, m: 0 }, view), { type: "rawkey", action: "down", key: "a", code: "KeyA", keyCode: 65, text: "a", location: 0, repeat: false, modifiers: 0 });
  assert.equal(readInput({ t: "key", a: "down", key: "v", code: "KeyV", m: 4 }, view), null, "Cmd+V would paste the host's clipboard");
  assert.equal(readInput({ t: "key", a: "down", key: "c", code: "KeyC", m: 2 }, view), null, "Ctrl+C would copy into it");
  assert.equal(readInput({ t: "key", a: "down", key: "x".repeat(40) }, view), null);
  assert.equal(readInput({ t: "text", text: "y".repeat(5000) }, view).text.length, 2000);
  assert.equal(readInput({ t: "wheel", nx: 0.5, ny: 0.5, dx: 0, dy: 99999 }, view).dy, 5000);
});

test("the files a call names, and the same call naming where they landed", () => {
  assert.deepEqual(pathsIn("pairbrowse_upload", { files: ["/a.png"] }), ["/a.png"]);
  assert.deepEqual(pathsIn("browser_file_upload", { paths: ["/b.pdf"] }), ["/b.pdf"]);
  assert.deepEqual(pathsIn("pairbrowse_run", { steps: [{ fill: { A: "x" } }, { upload: { Photo: "/c.jpg" } }] }), ["/c.jpg"]);
  assert.deepEqual(pathsIn("browser_click", { target: "e1" }), []);
  const map = new Map([["/c.jpg", "/host/joiner-x/1/c.jpg"]]);
  assert.deepEqual(withPaths("pairbrowse_run", { steps: [{ upload: { Photo: "/c.jpg" } }] }, map).steps[0].upload.Photo, "/host/joiner-x/1/c.jpg");
});

test("a field a joiner typed in (shared browser) is theirs, not the host's", () => {
  const now = 10_000_000;
  const byRemote = (t) => (t > now - 2000 ? "Alice" : null);
  assert.deepEqual(fieldOwner({ times: [now - 1000], name: "Note" }, { host: "Bob", byRemote, now }), { who: "Alice", local: false, name: "Note" });
  assert.deepEqual(fieldOwner({ times: [now - 3000], name: "Note" }, { host: "Bob", byRemote, now }), { who: "Bob", local: true, name: "Note" });
});

test("fast mode's drag: 2 to 200 points inside the page, and it has to move", () => {
  assert.equal(preflight([{ press: "r" }, { drag: [[0.4, 0.48], [0.6, 0.8]] }]), null);
  assert.match(preflight([{ drag: [[0.4, 0.4]] }]), /2 to 200 points/);
  assert.match(preflight([{ drag: [[0.4, 0.4], [1.2, 0.5]] }]), /fractions 0-1/);
  assert.match(preflight([{ drag: [[0.4, 0.4], [0.401, 0.4]] }]), /has to move/);
});

test("the slower route lets go of a tab that closed: nothing reopens on it, nothing is kept", async () => {
  let sessions = 0, onClose = () => {};
  const sent = [];
  const cdp = { send: async (m) => { sent.push(m); return {}; }, on() {}, off() {}, detach: async () => {} };
  const page = { isClosed: () => false, once: (e, cb) => { if (e === "close") onClose = cb; }, context: () => ({ newCDPSession: async () => { sessions++; return cdp; } }), evaluate: async () => [800, 600, 1, 0, 0] };
  const share = createScreenShare({ call: async () => null });
  await share.frames(page, "joiner-a", () => {});
  assert.equal(sessions, 1);
  page.isClosed = () => true;
  onClose();
  await share.frames(page, "joiner-a", null); // the joiner's "frames off" after the tab closed
  await share.stopAll("joiner-a|");
  assert.equal(sessions, 1, "no new session on a closed tab");
  await share.close();
});

test("nothing to capture a tab with: an offer is refused as NO_CAPTURE, and the slower route still works", async () => {
  const sent = [];
  const cdp = { send: async (m) => { sent.push(m); return {}; }, on() {}, off() {}, detach: async () => {} };
  const page = { isClosed: () => false, once() {}, context: () => ({ newCDPSession: async () => cdp }), evaluate: async () => [800, 600, 1, 0, 0] };
  let asked = 0;
  const share = createScreenShare({ call: async () => { asked++; return null; }, capture: { kind: () => null, share: async () => { asked++; }, tabRef: async () => { asked++; } } });
  assert.equal(share.available(), false);
  await assert.rejects(share.offer(page, "j|t|1", { role: "drive" }), (e) => e.code === "NO_CAPTURE");
  assert.equal(asked, 0, "nothing asked of the extension or a capture page");
  await share.frames(page, "joiner-a", () => {});
  assert.ok(sent.includes("Page.startScreencast"), "pictures through the channel");
  await share.frames(page, "joiner-a", null);
  await share.close();
  assert.equal(createScreenShare({ call: async () => null }).available(), true, "no capture given: as before");
});

test("with the browser's own capture page, share calls go to it with the tab's target id", async () => {
  const shared = [];
  const cdp = { send: async () => ({}), on() {}, off() {}, detach: async () => {} };
  const page = { isClosed: () => false, once() {}, context: () => ({ newCDPSession: async () => cdp }), evaluate: async () => [800, 600, 1, 0, 0] };
  let extension = 0;
  const capture = { kind: () => "page", tabRef: async () => "0123456789ABCDEF0123456789ABCDEF", share: async (arg) => { shared.push(arg); return arg.op === "offer" ? { sdp: "v=0" } : arg.op === "take" ? [] : true; } };
  const share = createScreenShare({ call: async () => { extension++; return null; }, capture });
  const r = await share.offer(page, "j|t|1", { role: "watch" });
  assert.equal(r.sdp, "v=0");
  assert.equal(shared[0].op, "offer");
  assert.equal(shared[0].tabId, "0123456789ABCDEF0123456789ABCDEF");
  assert.equal(extension, 0);
  await share.close();
});

test("the picture page's addresses: the extension's, the browser's own, and the name it shows", async () => {
  const { isScreenPage } = await import("../scripts/daemon/follow.mjs");
  assert.equal(isScreenPage(`chrome-extension://${"a".repeat(32)}/screen.html#ab12`), true);
  assert.equal(isScreenPage("chrome://pairbrowse/screen/#ab12"), true);
  assert.equal(isScreenPage("pairbrowse://screen/#ab12"), true);
  assert.equal(isScreenPage("chrome://pairbrowse/settings"), false);
  assert.equal(isScreenPage("https://evil.example/screen.html"), false);
  assert.equal(isScreenPage("chrome-extension://xyz/screen.html"), false);
});
