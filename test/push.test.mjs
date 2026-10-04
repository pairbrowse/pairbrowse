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
