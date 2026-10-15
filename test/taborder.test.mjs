// The tab order in a PairBrowse build with its own pages (daemon/taborder.mjs, strip source):
// read from the tab strip's report, never from the side panel's worker.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTabOrder } from "../scripts/daemon/taborder.mjs";
import { readTabOrder } from "../scripts/liveview.mjs";

const T = (n) => String(n).repeat(32).slice(0, 32).toUpperCase();
const fakePage = (url, target) => ({ url: () => url, isClosed: () => false, context: () => ({ newCDPSession: async () => ({ send: async () => ({ targetInfo: { targetId: target.toLowerCase() } }), detach: async () => {} }) }) });

function setup(snapshot) {
  const a = fakePage("https://a.example/", T(1)), b = fakePage("https://b.example/", T(2)), c = fakePage("https://c.example/", T(3));
  const arranged = [];
  let workerCalls = 0;
  const order = createTabOrder({
    call: async () => { workerCalls++; throw new Error("no worker here"); },
    getContext: async () => ({ pages: () => [a, b, c] }),
    strip: { chrome: () => true, snapshot: () => snapshot, arrange: (targets) => arranged.push(targets) },
  });
  return { order, a, b, c, arranged, worker: () => workerCalls };
}

test("from the strip's report: order, strip, front and focus; arrange asks the strip; the worker is never asked", async () => {
  const snap = readTabOrder({ tabs: [{ target: T(3), window: 1, index: 0, active: false }, { target: T(1), window: 1, index: 1, active: true }, { target: T(2), window: 2, index: 0, active: true }], focused: 2, last: 2 });
  const { order, a, b, c, arranged, worker } = setup(snap);
  assert.deepEqual(await order.order([a, b, c]), [c, a, b], "window, then place");
  assert.deepEqual(await order.strip([b, a]), [a, b]);
  assert.equal(await order.front(), b, "the focused window's active tab");
  assert.equal(await order.focused(), true);
  snap.focused = -1; snap.last = 1;
  assert.equal(await order.front(), a, "no window focused: the last one focused");
  assert.equal(await order.focused(), false);
  assert.equal(await order.arrange([b, c, a]), true);
  assert.deepEqual(arranged, [[T(2), T(3), T(1)]]);
  assert.equal(JSON.parse((await order.testCommand({ action: "list" })).text).length, 3);
  assert.equal(worker(), 0);
});

test("no report from the strip yet: unknown everywhere, quietly, and still no worker call", async () => {
  const { order, a, b, worker } = setup(null);
  assert.equal(await order.front(), null);
  assert.equal(await order.focused(), null);
  assert.equal(await order.order([a, b]), null);
  assert.equal(await order.strip([a, b]), null);
  assert.equal(await order.arrange([a, b]), false);
  assert.equal(worker(), 0);
});

test("the strip's report is checked: target ids, places, focus", () => {
  assert.deepEqual(readTabOrder({ tabs: [{ target: "ab".repeat(16), window: 1, index: 0, active: true }], focused: 1, last: 1 }).tabs[0].target, "AB".repeat(16));
  for (const bad of [null, [], { tabs: [], focused: "1", last: 1 }, { tabs: [{ target: "x", window: 1, index: 0, active: true }], focused: 1, last: 1 },
    { tabs: [{ target: T(1), window: 1, index: -1, active: true }], focused: 1, last: 1 }, { tabs: [{ target: T(1), window: 1.5, index: 0, active: true }], focused: 1, last: 1 },
    { tabs: [{ target: T(1), window: 1, index: 0, active: "yes" }], focused: 1, last: 1 }, { tabs: Array.from({ length: 501 }, () => ({ target: T(1), window: 1, index: 0, active: true })), focused: 1, last: 1 }]) {
    assert.equal(readTabOrder(bad), null, JSON.stringify(bad)?.slice(0, 80));
  }
});
