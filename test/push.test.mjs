import { test } from "node:test";
import assert from "node:assert/strict";
import { createPush } from "../scripts/liveview/push.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A joiner's agents wait while the host's person uses a shared tab, for 2 s after they last heard
// of them: the tabs keep going out while someone is there, even when nothing else changed.
async function tabsSent(person) {
  const sent = [];
  let closed = () => {};
  const conn = { send: (raw) => { const m = JSON.parse(raw); if (m.event === "tabs") sent.push(m.data); }, onClose(cb) { closed = cb; }, close() { closed(); } };
  const push = createPush({
    getContext: async () => ({ pages: () => [] }), idOf: () => "t1", joinerKey: () => "k", secretDomains: () => [], shared: { showPointers() {} }, tabMeta: () => ({}),
    tabsFor: async () => ({ tabs: [{ id: "t1", url: "https://example.com/", title: "Example", ...(person ? { person } : {}) }] }),
  });
  try {
    await push.open({ name: "Sam" }, conn);
    await sleep(2600);
  } finally {
    push.close();
  }
  return sent;
}

test("the shared tabs go out again while a person uses one, and only once when nothing changes", async () => {
  const [busy, idle] = await Promise.all([tabsSent("Mac"), tabsSent("")]);
  assert.ok(busy.length >= 3, `sent ${busy.length} times while Mac was there`);
  assert.equal(idle.length, 1);
});

// A joiner whose connection stopped reading (a laptop asleep, the connection still open) gets no
// more pictures while it's behind, and is cut when far behind, instead of every frame piling up here.
test("a joiner that stopped reading gets no pictures, then is cut", async () => {
  let buffered = 0, closed = false, onClose = () => {};
  const frames = [];
  const conn = { get buffered() { return buffered; }, send: (raw) => { const m = JSON.parse(raw); if (m.event === "screen") frames.push(m.data); }, onClose(cb) { onClose = cb; }, close() { closed = true; onClose(); } };
  const push = createPush({
    getContext: async () => ({ pages: () => [] }), idOf: () => "t1", joinerKey: () => "k", secretDomains: () => [], shared: { showPointers() {} }, tabMeta: () => ({}),
    tabsFor: async () => ({ tabs: [] }),
  });
  try {
    await push.open({ name: "Sam" }, conn);
    push.broadcast("screen", { op: "frame", id: "t1", img: "a" });
    buffered = 2 << 20;
    push.broadcast("screen", { op: "frame", id: "t1", img: "b" });
    push.broadcast("screen", { op: "state", id: "t1", state: "x" });
    assert.deepEqual(frames.map((f) => f.img || f.state), ["a", "x"], "behind: pictures wait, other news still goes");
    assert.ok(!closed);
    buffered = 32 << 20;
    push.broadcast("screen", { op: "frame", id: "t1", img: "c" });
    assert.ok(closed, "far behind: cut");
    buffered = 0;
    push.broadcast("screen", { op: "frame", id: "t1", img: "d" });
    assert.equal(frames.length, 2, "a cut stream gets nothing more");
  } finally {
    push.close();
  }
});
