// Shared browser mode's checks: the picture's size, what a joiner's input may be, the files a
// joiner's agent may name, and whose a field is after a joiner typed in it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { frameFor, readInput } from "../scripts/daemon/screenshare.mjs";
import { pathsIn, withPaths } from "../scripts/daemon/serve.mjs";
import { fieldOwner } from "../scripts/daemon/fields.mjs";

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
