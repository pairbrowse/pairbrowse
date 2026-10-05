// The join prompt's helper side (daemon/joinprompt.mjs): where it shows, and which answers count.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApprovals, newJoinerId } from "../scripts/join.mjs";
import { createJoinPrompt, ARM_MS } from "../scripts/daemon/joinprompt.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakePage = (name) => ({ name, closed: false, isClosed() { return this.closed; } });

function setup({ front = null, byPerson = () => true } = {}) {
  const approvals = createApprovals();
  const calls = [];
  const answers = new Map(); // page -> the chain the page script would hand over
  const show = async (page, value, kind) => {
    calls.push({ page: page.name, value, kind });
    if (kind === "join") return true;
    if (kind === "join-answers") { const a = answers.get(page) || null; answers.delete(page); return { a, open: 1 }; }
    return true;
  };
  const prompt = createJoinPrompt({ approvals, front: async () => front, show, byPerson });
  const ask = (name = "Sam", role = "drive") => approvals.check({ id: "i1", role }, newJoinerId(), name, "claude-code").entry.id;
  return { approvals, calls, answers, prompt, ask };
}

test("a request shows once, in the tab in front, with who asks and how", async () => {
  const front = fakePage("front");
  const { calls, prompt, ask } = setup({ front });
  const id = ask("Sam", "watch");
  await prompt.refresh();
  const shown = calls.filter((c) => c.kind === "join");
  assert.deepEqual(shown, [{ page: "front", value: { id, who: "Sam (Claude Code)", role: "watch" }, kind: "join" }]);
  await prompt.refresh();
  assert.equal(calls.filter((c) => c.kind === "join").length, 1, "never shown twice");
});

test("no tab in front: nothing shown (the side panel still asks)", async () => {
  const { calls, prompt, ask } = setup({ front: null });
  ask();
  await prompt.refresh();
  assert.equal(calls.length, 0);
  assert.deepEqual(prompt.shown(), []);
});

test("only a person's click, in that tab, once armed, for a waiting request, answers it", async () => {
  const front = fakePage("front"), other = fakePage("other");
  let person = true;
  const { approvals, prompt, ask } = setup({ front, byPerson: () => person });
  const id = ask();
  await prompt.refresh();
  const now = Date.now();
  assert.equal(prompt.answer("join-allow", id, front, now), null, "too soon after it showed");
  await sleep(ARM_MS + 50);
  assert.equal(prompt.answer("join-allow", id, other, Date.now()), null, "another tab");
  assert.equal(prompt.answer("join-allow", "r000000", front, Date.now()), null, "another request");
  assert.equal(prompt.answer("approve", id, front, Date.now()), null, "an unknown kind");
  person = false;
  assert.equal(prompt.answer("join-allow", id, front, Date.now()), null, "an agent's or replayed click");
  person = true;
  assert.equal(prompt.answer("join-allow", id, front, Date.now() + 60_000)?.state, "approved", "a time from the future counts as now");
  assert.equal(approvals.pending().length, 0, "let in");
  assert.equal(approvals.list()[0].state, "approved");
  assert.equal(prompt.answer("join-deny", id, front, Date.now()), null, "answered already");
});

test("answered elsewhere: the prompt comes down; a Deny from it turns them away", async () => {
  const front = fakePage("front");
  const { approvals, calls, answers, prompt, ask } = setup({ front });
  const a = ask("Ann"), b = ask("Bo");
  await prompt.refresh();
  approvals.approve(a); // the side panel's Allow
  await prompt.refresh();
  assert.ok(calls.some((c) => c.kind === "join-off" && c.value === a));
  await sleep(ARM_MS + 50);
  // The page hands over a Deny (as hud.js records it): read by the helper's poll.
  answers.set(front, { t: Date.now(), kind: "join-deny", what: b, next: null });
  await sleep(700);
  assert.equal(approvals.list().find((r) => r.id === b).state, "denied");
  await prompt.refresh();
  assert.ok(calls.some((c) => c.kind === "join-off" && c.value === b));
  assert.deepEqual(prompt.shown(), []);
});
