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

// The host's agents hold their tab work while a joiner's channel is down but not gone (serve.mjs
// asks reconnecting()): only for a joiner still in, never for one who left or was taken out, and
// never counted against that joiner's own forwarded calls.
test("reconnecting() names a joiner whose channel dropped while in, not one who left, not to themselves", async () => {
  const joiners = new Set(["a", "b"]);
  const connFor = () => { let closed = () => {}; return { send() {}, onClose(cb) { closed = cb; }, close() { closed(); } }; };
  const push = createPush({
    getContext: async () => ({ pages: () => [] }), idOf: () => "t1", joinerKey: (j) => j.key, secretDomains: () => [], shared: { showPointers() {} }, tabMeta: () => ({}),
    tabsFor: async () => ({ tabs: [] }), isIn: (key) => joiners.has(key),
  });
  try {
    const alice = connFor(), bob = connFor();
    await push.open({ name: "Alice", key: "a" }, alice);
    await push.open({ name: "Bob", key: "b" }, bob);
    assert.equal(push.reconnecting(), null, "both channels up");
    alice.close();
    assert.equal(push.reconnecting(), "Alice", "Alice's channel dropped while she is in");
    assert.equal(push.reconnecting("a"), null, "not for Alice's own calls");
    assert.equal(push.reconnecting("b"), "Alice");
    const again = connFor();
    await push.open({ name: "Alice", key: "a" }, again);
    assert.equal(push.reconnecting(), null, "back: nothing to wait for");
    again.close();
    joiners.delete("a"); // left just then
    assert.equal(push.reconnecting(), null, "a joiner who left is gone, not reconnecting");
    bob.close();
    joiners.delete("b");
    assert.equal(push.reconnecting(), null);
    push.end("b");
  } finally {
    push.close();
  }
});

// The host's person acting: the state carries when (at), compared as it is, sent as an ago.
test("a person's acting time goes out as an ago, and an unchanged time is no news", async () => {
  const sent = [];
  let closed = () => {};
  const conn = { send: (raw) => { const m = JSON.parse(raw); if (m.event === "tabs") sent.push({ data: m.data, t: Date.now() }); }, onClose(cb) { closed = cb; }, close() { closed(); } };
  let at = Math.ceil(Date.now() / 1000) * 1000 - 1000;
  const push = createPush({
    getContext: async () => ({ pages: () => [] }), idOf: () => "t1", joinerKey: () => "k", secretDomains: () => [], shared: { showPointers() {} }, tabMeta: () => ({}),
    tabsFor: async () => ({ tabs: [{ id: "t1", url: "https://example.com/", title: "Example", person: "Bob", acting: true, at }] }),
  });
  try {
    await push.open({ name: "Sam" }, conn);
    await sleep(60);
    const before = sent.length;
    for (let i = 0; i < 10; i++) { push.changed(); await sleep(30); }
    assert.equal(sent.length, before, "ten rounds within 900 ms with the same time: nothing new went out");
    for (const { data, t } of sent) {
      assert.ok(!("at" in data.tabs[0]), "at never crosses");
      assert.ok(Math.abs(data.tabs[0].ago - (t - at)) <= 50, `ago ${data.tabs[0].ago} measured as it left`);
    }
    at += 1000; // Bob typed again
    push.changed();
    await sleep(60);
    assert.equal(sent.length, before + 1, "a new time is news at once");
  } finally {
    push.close();
  }
});

// Shared browser mode: a joiner sees a picture of the host's tab itself, so a pointer drawn in the
// tab reaches them in that picture. Their own is never drawn there (they saw a copy trailing their
// own mouse, a moment late), and what is drawn there (a follow joiner's) isn't sent to them again.
test("pointers: a shared browser joiner's own never in the host's tab, never twice, never back to them", async () => {
  const page = { isClosed: () => false, url: () => "https://example.com/" };
  const drawn = []; // what the host's tab draws, each time
  const got = new Map(); // joiner key -> the last pointers sent to them
  const connFor = (key) => { let closed = () => {}; return { send: (raw) => { const m = JSON.parse(raw); if (m.event === "pointers") got.set(key, m.data); }, onClose(cb) { closed = cb; }, close() { closed(); } }; };
  const push = createPush({
    getContext: async () => ({ pages: () => [page] }), idOf: () => "t1", joinerKey: (j) => j.key, secretDomains: () => [], tabMeta: () => ({}),
    shared: { host: "Bob", showPointers: (p, list) => drawn.push(list.map((x) => x.who)), readForm: async () => null, toView: (p, x, y) => ({ nx: x / 1000, ny: y / 1000 }) },
    tabsFor: async () => ({ tabs: [] }),
  });
  const alice = { name: "Alice", key: "i1:a", invite: { mode: "shared" } }; // works in the host's tab through its picture
  const carol = { name: "Carol", key: "i1:c", invite: { mode: "shared" } };
  const dan = { name: "Dan", key: "i2:d", invite: { mode: "follow" } }; // his own copy of the tab
  try {
    for (const j of [alice, carol, dan]) await push.open(j, connFor(j.key));
    for (const j of [alice, carol, dan]) await push.fromJoiner({ me: { id: "t1", x: 100, y: 200 } }, j);
    await sleep(120);
    assert.deepEqual(drawn.at(-1), ["Dan"], "the host's tab draws the follow joiner's pointer only");
    const whos = (key) => (got.get(key) || []).map((p) => p.who).sort();
    assert.deepEqual(whos("i1:a"), ["Carol"], "Alice: never her own; Dan's is in her picture already");
    assert.deepEqual(whos("i1:c"), ["Alice"], "Carol: Alice's, drawn over her picture");
    assert.deepEqual(whos("i2:d"), ["Alice", "Carol"], "Dan, in his copy: both, never his own");
    assert.ok((got.get("i1:a") || []).every((p) => typeof p.nx === "number"), "over the picture: places in the tab's view");
  } finally {
    push.close();
  }
});

// An agent's cursor here is drawn in the host's tab (hud.js), so a shared browser joiner already
// sees it in their picture of the tab: it goes on its own only to joiners with copies of the tab
// (follow mode). Each pointer reaches each joiner exactly once.
test("pointers: the host's agent cursor goes to follow joiners only, never twice to a shared browser joiner", async () => {
  const page = { isClosed: () => false, url: () => "https://example.com/" };
  const got = new Map();
  const connFor = (key) => { let closed = () => {}; return { send: (raw) => { const m = JSON.parse(raw); if (m.event === "pointers") got.set(key, m.data); }, onClose(cb) { closed = cb; }, close() { closed(); } }; };
  const push = createPush({
    getContext: async () => ({ pages: () => [page] }), idOf: () => "t1", joinerKey: (j) => j.key, secretDomains: () => [],
    tabMeta: () => ({ agent: { label: "Claude Code", color: "#e9763f" } }),
    shared: { host: "Bob", showPointers() {}, readForm: async () => null, toView: (p, x, y) => ({ nx: x / 1000, ny: y / 1000 }) },
    tabsFor: async () => ({ tabs: [] }),
  });
  const alice = { name: "Alice", key: "i1:a", invite: { mode: "shared" } };
  const dan = { name: "Dan", key: "i2:d", invite: { mode: "follow" } };
  try {
    for (const j of [alice, dan]) await push.open(j, connFor(j.key));
    push.agentPointed(page, { x: 300, y: 400, t: Date.now() });
    push.pointed(page, { me: { x: 10, y: 20, t: Date.now() }, agent: { x: 300, y: 400, t: Date.now() } });
    await sleep(120);
    const keys = (key) => (got.get(key) || []).map((p) => p.k).sort();
    assert.deepEqual(keys("i2:d"), ["host", "host-agent:t1"], "Dan, in his copy: the host's pointer and the agent's cursor");
    assert.deepEqual(keys("i1:a"), ["host"], "Alice: the host's pointer only; the agent's cursor is in her picture");
  } finally {
    push.close();
  }
});

// 530 F1: a shared browser joiner's pointer, never drawn in the host's tab, goes to the browser's
// own overlay over the page card, as the place they point at in their picture of the tab; a follow
// joiner's (drawn in the tab) never does; only changes go, and one gone empties it.
test("overlay: shared browser joiners' pointers, as places in the tab's view, only on a change", async () => {
  const page = { isClosed: () => false, url: () => "https://example.com/" };
  const drawn = [];
  const overlays = [];
  const conn = () => { let closed = () => {}; return { send() {}, onClose(cb) { closed = cb; }, close() { closed(); } }; };
  const joiners = new Set(["i1:a", "i2:d"]);
  const push = createPush({
    getContext: async () => ({ pages: () => [page] }), idOf: () => "t1", joinerKey: (j) => j.key, secretDomains: () => [], tabMeta: () => ({}),
    shared: { host: "Bob", showPointers: (p, list) => drawn.push(list.map((x) => x.who)), readForm: async () => null, toView: () => null,
      overlay: (entries) => overlays.push(entries.map(({ page: p, pointers }) => ({ same: p === page, pointers }))) },
    tabsFor: async () => ({ tabs: [] }), isIn: (key) => joiners.has(key),
  });
  const alice = { name: "Alice", key: "i1:a", invite: { mode: "shared" } };
  const dan = { name: "Dan", key: "i2:d", invite: { mode: "follow" } };
  try {
    for (const j of [alice, dan]) await push.open(j, conn());
    await push.fromJoiner({ me: { id: "t1", x: 100, y: 200 } }, alice, { x: 0.25, y: 0.5 });
    await push.fromJoiner({ me: { id: "t1", x: 300, y: 400 } }, dan);
    await sleep(120);
    assert.deepEqual(drawn.at(-1), ["Dan"], "the tab draws the follow joiner's only");
    const last = overlays.at(-1);
    assert.equal(last.length, 1);
    assert.ok(last[0].same);
    assert.deepEqual(last[0].pointers.map(({ fresh, ...p }) => p), [{ k: "i1:a:me", who: "Alice", color: last[0].pointers[0].color, x: 0.25, y: 0.5 }]);
    assert.ok(last[0].pointers[0].fresh > 2500 && last[0].pointers[0].fresh <= 3000, "how long it stays without a move");
    const before = overlays.length;
    await push.fromJoiner({ me: { id: "t1", x: 300, y: 410 } }, dan); // only Dan moved
    await sleep(80);
    assert.equal(overlays.length, before, "no change for the overlay: nothing sent");
    await push.fromJoiner({ me: { id: "t1", x: 120, y: 200 } }, alice, { x: 0.3, y: 0.5 });
    await sleep(80);
    assert.equal(overlays.at(-1)[0].pointers[0].x, 0.3, "Alice moved: sent");
    joiners.delete("i1:a"); // she left
    await push.fromJoiner({ me: { id: "t1", x: 300, y: 420 } }, dan);
    await sleep(80);
    assert.deepEqual(overlays.at(-1), [], "gone: the overlay empties");
    // Bad places never reach it.
    joiners.add("i1:a");
    await push.fromJoiner({ me: { id: "t1", x: 100, y: 200 } }, alice, { x: 2, y: 0.5 });
    await sleep(80);
    assert.deepEqual(overlays.at(-1), [], "a place outside the view is dropped");
  } finally {
    push.close();
  }
});
