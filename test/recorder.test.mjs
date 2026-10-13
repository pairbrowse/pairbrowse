// Recording the browser (daemon/recorder.mjs): starting, following agents, and saving the file the
// browser encoded, piece by piece, under a new name in Downloads.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecorder, recordingName } from "../scripts/daemon/recorder.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for the extension's worker: pbRecord answers as record.js does.
function fakeBrowser(bytes) {
  const calls = [];
  const call = async (_fn, arg) => {
    calls.push(arg);
    if (arg?.op === "start") return { type: "video/mp4", w: 1280, h: 840 };
    if (arg?.op === "labels") return { ms: 10, full: false };
    if (arg?.op === "show") return true;
    if (arg?.op === "stop") return { size: bytes.length, type: "video/mp4", ms: 65_000 };
    if (arg?.op === "chunk") return bytes.subarray(arg.offset, arg.offset + arg.size).toString("base64");
    if (arg?.op === "clear") return true;
    return { error: "unknown" };
  };
  return { call, calls };
}

test("recording names say when it started and never repeat", () => {
  const at = new Date(2026, 9, 7, 23, 41, 5).getTime();
  assert.equal(recordingName(at, "video/mp4"), "PairBrowse recording 2026-10-07 23.41.05.mp4");
  assert.equal(recordingName(at, "video/webm", 2), "PairBrowse recording 2026-10-07 23.41.05 (2).webm");
});

test("a recording is saved whole, in pieces, beside an earlier one with the same name", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rec-"));
  try {
    const bytes = Buffer.alloc(9 * 1024 * 1024 + 123, 7); // more than two pieces
    const { call, calls } = fakeBrowser(bytes);
    const states = [];
    const savedCalls = [];
    const rec = createRecorder({ call, dir: () => dir, changed: (s) => states.push(s.recording), onSaved: (x) => savedCalls.push(x) });
    const started = await rec.start();
    assert.match(started.text, /Recording the browser \(1280x840\)/);
    assert.equal(rec.state().recording, true);
    assert.match((await rec.start()).text, /Already recording/);
    // The same second's name already taken: the new one goes beside it.
    writeFileSync(join(dir, recordingName(rec.state().since, "video/mp4")), "older");
    const since = rec.state().since;
    const saved = await rec.stop();
    assert.match(saved.text, /Saved the recording \(1 min 5 s, 9\.4 MB\)/);
    assert.deepEqual(savedCalls, [{ path: saved.path, at: since, ms: 65000, size: bytes.length }], "the Tools tab hears of it once");
    assert.match(saved.path, / \(1\)\.mp4$/);
    assert.deepEqual(readFileSync(saved.path), bytes);
    assert.equal((statSync(saved.path).mode & 0o777).toString(8), "600");
    assert.equal(readdirSync(dir).length, 2);
    assert.equal(calls.filter((c) => c.op === "chunk").length, 3);
    assert.equal(calls.at(-1).op, "clear");
    assert.deepEqual(states, [true, false]);
    assert.equal((await rec.stop()).error, true, "nothing left to stop");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("onSaved is not called when the browser's stop fails, and its throw never fails a save", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rec-"));
  try {
    const { call } = fakeBrowser(Buffer.from("abc"));
    let calls = 0;
    const failing = async (fn, arg, ms) => (arg?.op === "stop" ? { error: "boom" } : call(fn, arg, ms));
    const rec = createRecorder({ call: failing, dir: () => dir, onSaved: () => { calls++; } });
    await rec.start();
    assert.equal((await rec.stop()).error, true);
    assert.equal(calls, 0, "nothing saved, nothing told");
    const rec2 = createRecorder({ call, dir: () => dir, onSaved: () => { throw new Error("index full"); } });
    await rec2.start();
    const saved = await rec2.stop();
    assert.ok(saved.path && !saved.error, "the save still answers with its file");
    assert.deepEqual(readFileSync(saved.path), Buffer.from("abc"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("following agents shows the tab an agent works in, holding each a few seconds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rec-"));
  try {
    const { call, calls } = fakeBrowser(Buffer.from("x"));
    let act = null;
    const page = (id) => ({ id, isClosed: () => false, context: () => ({ newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: `t${id}` } }), detach: async () => {} }) }) });
    const tabCall = async (fn, arg, ms) => (typeof arg === "string" && arg.startsWith("t") ? Number(arg.slice(1)) : call(fn, arg, ms));
    const rec = createRecorder({ call: tabCall, dir: () => dir, onActivity: (fn) => { act = fn; return () => { act = null; }; } });
    await rec.start("agents");
    assert.equal(calls[0].follow, "agents");
    const a = page(1), b = page(2);
    act("Drew a stroke", "Claude (Mac)", a);
    await sleep(50);
    act("Drew a stroke", "Claude (Linux)", b); // too soon: waits its turn
    await sleep(50);
    assert.deepEqual(calls.filter((c) => c.op === "show").map((c) => c.tabId), [1]);
    await sleep(4100);
    assert.deepEqual(calls.filter((c) => c.op === "show").map((c) => c.tabId), [1, 2]);
    await rec.stop();
    assert.equal(act, null, "it stops following when the recording ends");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("nothing to capture with (a PairBrowse build without its capture page): recording is refused, nothing asked", async () => {
  let asked = 0;
  const rec = createRecorder({ call: async () => { asked++; return null; }, dir: () => tmpdir(), capture: { kind: () => null, record: async () => { asked++; }, tabRef: async () => { asked++; } } });
  const r = await rec.start();
  assert.equal(r.error, true);
  assert.equal(r.text, "Recording isn't available in this PairBrowse browser yet: it needs the browser's capture page, which comes with a later build. Nothing was recorded.");
  assert.equal(asked, 0);
  assert.equal(rec.state().recording, false);
});

test("with the browser's own capture page, the file comes over in 1 MB pieces", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rec-"));
  try {
    const bytes = Buffer.alloc(2 * 1024 * 1024 + 5, 3);
    const { call, calls } = fakeBrowser(bytes);
    let extension = 0;
    const rec = createRecorder({ call: async () => { extension++; return null; }, dir: () => dir, capture: { kind: () => "page", record: (arg) => call(null, arg), tabRef: async () => "T1" } });
    await rec.start();
    const saved = await rec.stop();
    assert.deepEqual(readFileSync(saved.path), bytes);
    assert.deepEqual(calls.filter((c) => c.op === "chunk").map((c) => c.size), [1048576, 1048576, 1048576]);
    assert.equal(extension, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
