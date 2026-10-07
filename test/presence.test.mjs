import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createPresence } from "../scripts/daemon/presence.mjs";

test("an agent's own input read late is still the agent's, a person's is a person's", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 1_000_000 });
  try {
    const presence = createPresence({ host: "You", readEvents: async () => [], pages: () => [], paused: () => true,
      onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
    const page = {};
    const done = presence.busyStart(); // the agent presses a key
    const pressedAt = Date.now() + 10;
    mock.timers.tick(200);
    done();
    mock.timers.tick(5000); // a busy computer: the page's events are read 5 s later
    presence.userDid([{ kind: "key", t: pressedAt, what: "Tab" }], page);
    assert.equal(presence.personIn(page), null, "the agent's key press doesn't make a person busy in the tab");
    presence.userDid([{ kind: "click", t: Date.now() - 100, what: "Continue" }], page);
    assert.equal(presence.personIn(page), "You", "a click outside any agent action is a person's");
  } finally {
    mock.timers.reset();
  }
});

test("pointer moves hold nobody up; clicks and typing do, the pause button is never page input, and filled fields are named", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 2_000_000 });
  try {
    const pressed = [];
    const presence = createPresence({ host: "Bob", readEvents: async () => [], pages: () => [], paused: () => true,
      onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {}, onPauseButton: (k) => pressed.push(k) });
    const page = {};
    presence.userDid([{ kind: "move", t: Date.now() }], page);
    assert.equal(presence.actingIn(page), null, "moving the pointer pauses nothing");
    assert.equal(presence.personIn(page), "Bob", "but they are shown in the tab");
    presence.userDid([{ kind: "pause", t: Date.now() }], page);
    assert.deepEqual(pressed, ["pause"]);
    assert.equal(presence.actingIn(page), null, "the button isn't input in the page");
    const done = presence.busyStart();
    presence.userDid([{ kind: "resume", t: Date.now() }], page);
    assert.deepEqual(pressed, ["pause"], "an agent can't resume");
    presence.userDid([{ kind: "pause", t: Date.now() }], page);
    done();
    assert.deepEqual(pressed, ["pause", "pause"], "pausing works while an agent is mid-action (when a person needs it most)");
    mock.timers.tick(3000);
    presence.userDid([{ kind: "type", t: Date.now(), what: "Delivery instructions" }], page);
    assert.equal(presence.actingIn(page), "Bob");
    presence.elsewhere(page, "Alice", ['typed in "Gift note"']);
    const note = presence.userNote(page);
    assert.match(note, /Fields people filled: "Delivery instructions" \(the user\), "Gift note" \(Alice\)/);
    assert.equal(presence.userNote(page), "", "once");
    const other = {};
    presence.elsewhere(other, "Alice", []);
    assert.equal(presence.actingIn(other), null, "only there: nothing waits");
    presence.elsewhere(other, "Alice", [], true);
    assert.equal(presence.actingIn(other), "Alice", "scrolling there: page changes wait");
  } finally {
    mock.timers.reset();
  }
});

test("each person's steps are named as theirs, from the reader's side", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 3_000_000 });
  try {
    const presence = createPresence({ host: "Kees", readEvents: async () => [], pages: () => [], paused: () => true,
      onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
    const page = {};
    presence.userDid([{ kind: "type", t: Date.now(), what: "Email" }, { kind: "click", t: Date.now(), what: "Continue" }], page);
    presence.elsewhere(page, "Sven", ["clicked \"Board\""]);
    // A joiner's agent: Kees's steps are Kees's, Sven's own are "the user".
    const forSven = presence.userNote(page, "Sven");
    assert.match(forSven, /^- Kees used this tab meanwhile: typed in "Email", clicked "Continue"\.$/m);
    assert.match(forSven, /^- The user used this tab meanwhile: clicked "Board"\. Look at the page again/m);
    assert.match(forSven, /"Email" \(Kees\)/);
    // The host's agent: the other way round.
    presence.userDid([{ kind: "click", t: Date.now(), what: "Share" }], page);
    presence.elsewhere(page, "Sven", ["clicked \"Board\""]);
    const forKees = presence.userNote(page);
    assert.match(forKees, /^- The user used this tab meanwhile: clicked "Share"\.$/m);
    assert.match(forKees, /^- Sven used this tab meanwhile: clicked "Board"\./m);
  } finally {
    mock.timers.reset();
  }
});

test("input read late from a busy page is still taken (a read empties the page's list), and a slow frame isn't read twice at once", async () => {
  const frame = {};
  const page = { isClosed: () => false, frames: () => [frame] };
  let reads = 0;
  // The first read answers 1.6 s later (past the poll's 1 s wait): its click must not be lost.
  const readEvents = () => { reads++; return reads === 1 ? new Promise((r) => setTimeout(() => r([{ kind: "click", t: Date.now(), what: "Go" }]), 1600)) : Promise.resolve([]); };
  let stopped = false; // the poll stops after the test (its read waits keep the process alive)
  const presence = createPresence({ host: "Bob", readEvents, pages: () => [page], paused: () => stopped, onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
  try {
    // Polls at 0.5 s (the read, answered at 2.1 s), 1 s and 1.5 s (that frame still answering).
    await new Promise((r) => setTimeout(r, 1800));
    assert.equal(reads, 1, "a frame still answering is skipped");
    assert.equal(presence.actingIn(page), null);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(presence.actingIn(page), "Bob", "the late click counts");
    assert.match(presence.userNote(page), /The user used this tab meanwhile: clicked "Go"/);
  } finally {
    stopped = true;
  }
});

test("during an agent's action, a person's press away from its target and their typing while it doesn't type are theirs", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 3_000_000 });
  try {
    const presence = createPresence({ host: "Bob", readEvents: async () => [], pages: () => [], paused: () => true,
      onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {}, onPauseButton() {} });
    const page = {};
    // A drag (keyless): its own press is near its target, so it stays the agent's.
    let done = presence.busyStart("no-keys");
    presence.userDid([{ kind: "click", t: Date.now(), what: "" }], page);
    assert.equal(presence.actingIn(page), null, "the agent's own press");
    presence.userDid([{ kind: "click", t: Date.now(), what: "", far: true }], page);
    assert.equal(presence.actingIn(page), "Bob", "a press away from the agent's target is the person's");
    done();
    mock.timers.tick(5000);
    done = presence.busyStart("no-keys");
    presence.userDid([{ kind: "type", t: Date.now(), what: "Search" }], page);
    assert.equal(presence.actingIn(page), "Bob", "typing while the agent only draws");
    done();
    mock.timers.tick(5000);
    done = presence.busyStart();
    presence.userDid([{ kind: "type", t: Date.now(), what: "Search" }], page);
    assert.equal(presence.actingIn(page), null, "typing while the agent types: the agent's");
    done();
  } finally {
    mock.timers.reset();
  }
});
