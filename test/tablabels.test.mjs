// The agent names on the tab strip (daemon/tablabels.mjs): short, one per tab, gone when it leaves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shortLabel, createTabLabels } from "../scripts/daemon/tablabels.mjs";

test("tab names name the agent, or whose agent it is, briefly", () => {
  assert.equal(shortLabel("Claude (Mac) · Claude Code"), "Claude (Mac)");
  assert.equal(shortLabel("Linux · Claude Code"), "Linux · Claude");
  assert.equal(shortLabel("Ann · Codex"), "Ann · Codex");
  assert.equal(shortLabel("Codex 3066"), "Codex 3066");
  assert.equal(shortLabel(""), "Agent");
});

test("each tab an agent works in shows its name; two in one tab: the last to act; a tab it left gets its title back", async () => {
  const page = (n) => ({ n, isClosed: () => false });
  const a = page("a"), b = page("b");
  const labels = { m: "Claude (Mac) · Claude Code", l: "Linux · Claude Code", x: "Codex 1" };
  let sparks = [{ id: "m", page: a }, { id: "l", page: b }, { id: "x", page: a }];
  let last = null;
  const shown = new Map();
  const names = createTabLabels({ sparks: () => sparks, labelOf: (id) => labels[id], lastIn: (p) => (p === a ? last : null), name: async (p, text) => { shown.set(p.n, text); } });
  await names.apply();
  assert.deepEqual(Object.fromEntries(shown), { a: "Claude (Mac)", b: "Linux · Claude" });
  last = { who: "Codex 1" };
  await names.apply();
  assert.equal(shown.get("a"), "Codex 1");
  sparks = [{ id: "l", page: b }];
  await names.apply();
  assert.deepEqual(Object.fromEntries(shown), { a: "", b: "Linux · Claude" });
});

test("agents read the page's own title: the names in front are taken off", async () => {
  const p = { isClosed: () => false };
  const names = createTabLabels({ sparks: () => [{ id: "m", page: p }], labelOf: () => "Claude (Mac) · Claude Code", name: async () => {} });
  await names.apply();
  assert.equal(names.strip("- Page Title: Claude (Mac) · Inbox\n- 0: (current) [Claude (Mac) · Inbox](https://x/)"), "- Page Title: Inbox\n- 0: (current) [Inbox](https://x/)");
  assert.equal(names.strip("Done: 1 steps in 0.1s.\nPage: Claude (Mac) · Inbox <https://x/>"), "Done: 1 steps in 0.1s.\nPage: Inbox <https://x/>");
  assert.equal(names.strip("Text that mentions Claude (Mac) · elsewhere"), "Text that mentions Claude (Mac) · elsewhere");
});
