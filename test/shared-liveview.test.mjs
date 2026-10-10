import test from "node:test";
import assert from "node:assert/strict";
import { startLiveView, createInvites } from "../scripts/liveview.mjs";

const context = { pages: () => [] };

async function live(options = {}) {
  const view = await startLiveView({
    getContext: async () => context,
    currentUrl: async () => "about:blank",
    ...options,
  });
  const base = view.url;
  return { view, base, key: base.split("/").at(-2) };
}

test("live view exposes collaboration state in initial events and state.json", async () => {
  const invites = createInvites();
  const { view, base } = await live({ invites, journal: () => ({ name: "r", status: "in progress", done: ["secret line"], yourTurn: [], left: [], updatedAt: "" }) });
  try {
    view.setCollaboration({ participants: [{ id: "a", label: "Alice" }], owner: { id: "a", label: "Alice" }, active: null, humanUntil: 123 });
    const events = await fetch(`${base}events?panel`);
    const reader = events.body.getReader();
    const chunks = [];
    while (!chunks.join("").includes("event: collaboration\ndata:")) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(new TextDecoder().decode(next.value));
    }
    await reader.cancel();
    const text = chunks.join("");
    assert.match(text, /event: collaboration\ndata: .*Alice/);
    const state = await fetch(`${base}state.json`).then((r) => r.json());
    assert.equal(state.collaboration.owner.label, "Alice");
    assert.equal("journal" in state, false, "the goal log never rides on state.json");
    // A guest gets the state as before, and never the goal log.
    const d = invites.create({ role: "drive", label: "D" });
    const guestBase = `http://127.0.0.1:${new URL(base).port}/${d.key}/`;
    const guestState = await fetch(`${guestBase}state.json`).then((r) => r.json());
    assert.equal("journal" in guestState, false);
    assert.equal((await fetch(`${guestBase}journal.json`)).status, 403);
  } finally { view.close(); }
});

test("viewport input does not signal human control; real input does, in FIFO order", async () => {
  const calls = [];
  const { view, base, key } = await live({
    onHumanInput: async () => {
      calls.push("start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      calls.push("end");
    },
  });
  try {
    const post = (body, k = key) => fetch(`http://127.0.0.1:${new URL(base).port}/${k}/input`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await post({ type: "viewport", on: true, w: 800, h: 600 });
    assert.deepEqual(calls, []);
    await Promise.all([post({ type: "wheel", x: 1, y: 1, dy: 1 }), post({ type: "text", text: "x" })]);
    assert.deepEqual(calls, ["start", "end", "start", "end"]);
    await post({ type: "wheel", x: 1, y: 1, dy: 1 }, "wrong");
    assert.deepEqual(calls, ["start", "end", "start", "end"]);
  } finally { view.close(); }
});
