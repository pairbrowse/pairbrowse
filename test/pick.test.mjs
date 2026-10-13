// The person's session choices from PairBrowse's own pages (daemon/pick.mjs): the picker at start,
// the switcher and the new tab page's chips while a session is open, Settings' Delete, and the
// answer to a join code's address question.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPick, readPick } from "../scripts/daemon/pick.mjs";

// A stand-in for context.mjs and follow.mjs that records what was asked of it.
function setup({ picking = false, session = "work", agents = [], busy = null, join = { text: "Asked Bob to let Ann in (drive). They have to approve first. Then ..." }, decide = null } = {}) {
  const calls = [];
  const notes = [];
  const state = { picking };
  const context = {
    picking: () => state.picking,
    sessionName: () => session,
    pickSession: async (op) => { calls.push(["pickSession", op]); state.picking = false; return { text: "picked" }; },
    pickedJoin: (text) => { calls.push(["pickedJoin", text]); state.picking = false; },
    switchForPerson: async (op) => { calls.push(["switchForPerson", op]); return op.name === "missing" ? { text: 'No session "missing".', error: true } : { text: "Opening." }; },
    sessionCommand: async (op) => { calls.push(["sessionCommand", op]); return op.name === session ? { text: "That session is in use. Switch to another one first.", error: true } : { text: `Deleted session "${op.name}" and its logins.` }; },
  };
  const follow = {
    command: async (args, who) => { calls.push(["join", args, who]); return typeof join === "function" ? join(args) : join; },
    decideHost: async (op) => { calls.push(["decideHost", op]); return decide || { ok: true, text: "Joined. Then ...", owner: "picker", joined: true, host: "t.example.net" }; },
  };
  const picks = createPick({ context, follow, activeAgents: () => agents, busy: () => busy, hostNote: (t) => notes.push(t) });
  return { picks, calls, notes, state };
}

test("readPick: only the fields each action takes, each checked", () => {
  assert.deepEqual(readPick({ action: "use", name: "work" }), { op: { action: "use", name: "work" } });
  assert.deepEqual(readPick({ action: "use", name: "work", confirm: true }), { op: { action: "use", name: "work", confirm: true } });
  assert.deepEqual(readPick({ action: "new" }), { op: { action: "new" } });
  assert.deepEqual(readPick({ action: "join", code: " pb-join:abc ", joinName: "Ann" }), { op: { action: "join", code: "pb-join:abc", joinName: "Ann" } });
  assert.deepEqual(readPick({ action: "delete", name: "old" }), { op: { action: "delete", name: "old" } });
  for (const bad of [null, [], "use", {}, { action: "steal" }, { action: "use" }, { action: "use", name: "../x" }, { action: "use", name: "a".repeat(41) },
    { action: "use", name: "work", extra: 1 }, { action: "new", name: "x" }, { action: "new", confirm: "yes" }, { action: "join" }, { action: "join", code: "" },
    { action: "join", code: "x".repeat(4001) }, { action: "join", code: "pb-join:x", joinName: "x".repeat(41) }, { action: "join", code: "pb-join:x", confirm: true },
    { action: "delete", name: "old", confirm: true }, { action: "__proto__" }, { action: "toString" }]) {
    assert.ok(readPick(bad).error, JSON.stringify(bad));
  }
});

test("with the picker showing, use and new answer it as before", async () => {
  const { picks, calls } = setup({ picking: true });
  assert.deepEqual(await picks.pick({ action: "use", name: "work" }), { text: "picked" });
  assert.deepEqual(calls, [["pickSession", { action: "use", name: "work" }]]);
});

test("a session open: the switcher switches, after the checks, and the agents hear it", async () => {
  const { picks, calls, notes } = setup();
  assert.deepEqual(await picks.pick({ action: "use", name: "work" }), { text: 'You\'re in session "work" already.' }, "the open one: nothing to do");
  assert.equal(calls.length, 0);
  assert.deepEqual(await picks.pick({ action: "use", name: "home" }), { text: "Opening." });
  assert.deepEqual(calls.at(-1), ["switchForPerson", { action: "use", name: "home" }]);
  assert.match(notes.at(-1), /switched the browser to session "home".*browser_tabs list/);
  assert.deepEqual(await picks.pick({ action: "new" }), { text: "Opening." });
  assert.deepEqual(calls.at(-1), ["switchForPerson", { action: "new", name: undefined }]);
  assert.match(notes.at(-1), /fresh, throwaway session/);
  const r = await picks.pick({ action: "use", name: "missing" });
  assert.equal(r.error, true);
  assert.equal(notes.length, 2, "a refused switch tells no agent anything");
});

test("a session open: refused while people are in it, a recording runs or an approval waits", async () => {
  const { picks, calls } = setup({ busy: "People are in this session; switch once they have left." });
  assert.deepEqual(await picks.pick({ action: "use", name: "home", confirm: true }), { text: "People are in this session; switch once they have left.", error: true });
  assert.equal(calls.length, 0, "a confirm doesn't get past it");
});

test("other agents at work: the page must say the person chose to anyway", async () => {
  const { picks, calls, notes } = setup({ agents: ["Sam · Claude Code", "Codex", "Codex"] });
  const r = await picks.pick({ action: "use", name: "home" });
  assert.equal(r.error, true);
  assert.deepEqual(r.agents, ["Sam · Claude Code", "Codex"]);
  assert.match(r.confirm, /^Sam · Claude Code and Codex are using the browser\. .*Switch anyway\?$/);
  assert.equal(calls.length, 0, "nothing closed");
  assert.deepEqual(await picks.pick({ action: "use", name: "home", confirm: false }), r, "confirm: false is no");
  assert.deepEqual(await picks.pick({ action: "use", name: "home", confirm: true }), { text: "Opening." });
  assert.equal(calls.length, 1);
  assert.match(notes.at(-1), /while you were working/);
  const one = await setup({ agents: ["Codex"] }).picks.pick({ action: "new" });
  assert.match(one.confirm, /^Codex is using the browser/);
});

test("join: from the picker it answers the pick; with a session open the agents hear it", async () => {
  const p = setup({ picking: true });
  assert.deepEqual(await p.picks.pick({ action: "join", code: "pb-join:abc", joinName: "Ann" }), { text: "Asked Bob to let Ann in (drive). They have to approve first." });
  assert.deepEqual(p.calls[0], ["join", { action: "join", code: "pb-join:abc", name: "Ann" }, { owner: "picker", app: "PairBrowse" }]);
  assert.equal(p.calls[1][0], "pickedJoin", "waiting agents go on");
  const o = setup();
  assert.ok(!(await o.picks.pick({ action: "join", code: "pb-join:abc" })).error, "no longer 'A session is already chosen'");
  assert.ok(!o.calls.some(([c]) => c === "pickedJoin"));
  assert.match(o.notes[0], /joined a shared session from the browser/);
  const named = setup({ join: { needsName: true, error: true, text: "x" } });
  assert.match((await named.picks.pick({ action: "join", code: "pb-join:abc" })).text, /Type your name too/);
  const asked = setup({ picking: true, join: { text: "Join through it?", error: true, hostAsk: { id: "q1", host: "t.example.net" } } });
  const r = await asked.picks.pick({ action: "join", code: "pb-join:abc" });
  assert.deepEqual(r.hostAsk, { id: "q1", host: "t.example.net" }, "the address question goes back to the page");
  assert.equal(asked.state.picking, true, "the pick still waits for the answer");
});

test("Allow on a join address the picker asked about answers the pick (H3.3)", async () => {
  const p = setup({ picking: true });
  const r = await p.picks.hostDecision({ op: "allow", id: "q1", always: false });
  assert.equal(r.joined, true, "the page reads joined");
  assert.deepEqual(p.calls[0], ["decideHost", { op: "allow", id: "q1", always: false }]);
  assert.equal(p.calls[1][0], "pickedJoin");
  assert.match(p.calls[1][1], /after allowing its address t\.example\.net: Joined\./);
  assert.equal(p.state.picking, false, "agents waiting for the pick go on");
  // From the switcher (a session open): the agents hear it instead.
  const o = setup();
  await o.picks.hostDecision({ op: "allow", id: "q1" });
  assert.ok(!o.calls.some(([c]) => c === "pickedJoin"));
  assert.match(o.notes[0], /after allowing its address t\.example\.net/);
  // An agent's question (the side panel), a Cancel, a failed join: the pick is not answered.
  for (const decide of [{ ok: true, joined: true, owner: "agent", host: "h", text: "x" }, { ok: true, owner: "picker", host: "h" }, { ok: false, joined: false, owner: "picker", host: "h", text: "no" }]) {
    const s = setup({ picking: true, decide });
    await s.picks.hostDecision({ op: "allow", id: "q" });
    assert.ok(!s.calls.some(([c]) => c === "pickedJoin"), JSON.stringify(decide));
    assert.equal(s.notes.length, 0);
  }
});

test("delete: a saved session, never the open one or a clean one; the agents hear it", async () => {
  const { picks, calls, notes } = setup();
  assert.deepEqual(await picks.pick({ action: "delete", name: "old" }), { text: 'Deleted session "old" and its logins.' });
  assert.deepEqual(calls[0], ["sessionCommand", { action: "delete", name: "old" }]);
  assert.match(notes[0], /deleted the browser session "old"/);
  assert.equal((await picks.pick({ action: "delete", name: "work" })).error, true, "the open one");
  assert.equal((await picks.pick({ action: "delete", name: "clean-123" })).error, true, "a clean one goes by itself");
  assert.equal(calls.length, 2);
  assert.equal(notes.length, 1);
});
