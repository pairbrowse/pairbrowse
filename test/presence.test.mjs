import "./helpers/home.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createPresence, sentAgo, stateAgo } from "../scripts/daemon/presence.mjs";
import { stateForJoiner } from "../scripts/sharing/tabsync.mjs";
import { hostPeople } from "../scripts/daemon/follow.mjs";

test("lastPersonAt: when a person last used any tab; an agent's own input doesn't count", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 3_000_000 });
  try {
    const presence = createPresence({ host: "You", readEvents: async () => [], pages: () => [], paused: () => true,
      onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
    const a = {}, b = {};
    assert.equal(presence.lastPersonAt(), 0, "never");
    const done = presence.busyStart();
    presence.userDid([{ kind: "key", t: Date.now(), what: "Tab" }], a);
    done();
    assert.equal(presence.lastPersonAt(), 0, "the agent's key press");
    mock.timers.tick(2000);
    presence.userDid([{ kind: "click", t: Date.now() - 100, what: "Continue" }], a);
    assert.equal(presence.lastPersonAt(), 3_001_900);
    mock.timers.tick(1000);
    presence.userDid([{ kind: "wheel", t: Date.now() }], b);
    assert.equal(presence.lastPersonAt(), 3_003_000, "any tab, any input (reading along too)");
    presence.userDid([{ kind: "click", t: Date.now() + 60_000 }], b);
    assert.equal(presence.lastPersonAt(), 3_003_000, "never a time in the future");
  } finally {
    mock.timers.reset();
  }
});

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
    // Taken once it arrives (at about 2.1 s; a busy computer runs timers late, so wait up to 6 s).
    for (let i = 0; i < 60 && presence.actingIn(page) !== "Bob"; i++) await new Promise((r) => setTimeout(r, 100));
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
    mock.timers.tick(5000);
    // The agent's own wheel turns (a scroll, a run with a scroll step) are its own; a wheel
    // while it does something else (fills a form) is a person reading along.
    presence.userNote(page); // reading the note takes it
    done = presence.busyStart("no-keys wheel");
    presence.userDid([{ kind: "wheel", t: Date.now(), what: "" }], page);
    assert.equal(presence.userNote(page), "", "the agent's own scrolling");
    done();
    mock.timers.tick(5000);
    done = presence.busyStart();
    presence.userDid([{ kind: "wheel", t: Date.now(), what: "" }], page);
    assert.match(presence.userNote(page), /scrolled/, "a person's wheel while the agent types");
    done();
  } finally {
    mock.timers.reset();
  }
});

test("a press the page calls far is still the agent's inside a box PairBrowse declared it would press (for longer than a cursor), a person's elsewhere", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 3_500_000 });
  try {
    const presence = createPresence({ host: "Bob", readEvents: async () => [], pages: () => [], paused: () => true,
      onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {}, onPauseButton() {} });
    const page = {};
    // The popup closer declares its button (hud.onPress -> agentPointed, press: true), 300 by 40 at (500, 300).
    presence.agentPointed(page, { x: 650, y: 320, w: 300, h: 40, t: Date.now(), press: true });
    let done = presence.busyStart("popup");
    mock.timers.tick(5000); // a humanized press takes its time
    presence.userDid([{ kind: "click", t: Date.now(), what: "Accept", far: true, x: 790, y: 335 }], page);
    assert.equal(presence.actingIn(page), null, "the press landed in the declared box: PairBrowse's own");
    assert.equal(presence.userNote(page), "");
    presence.userDid([{ kind: "click", t: Date.now(), what: "Menu", far: true, x: 100, y: 900 }], page);
    assert.equal(presence.actingIn(page), "Bob", "a press away from every declared box is the person's");
    assert.match(presence.userNote(page), /clicked "Menu"/);
    done();
    mock.timers.tick(5000);
    // A cursor's own point (no declaration) counts for a shorter while.
    presence.agentPointed(page, { x: 650, y: 320, w: 300, h: 40, t: Date.now() });
    done = presence.busyStart();
    mock.timers.tick(5000);
    presence.userDid([{ kind: "click", t: Date.now(), what: "Accept", far: true, x: 790, y: 335 }], page);
    assert.equal(presence.actingIn(page), "Bob", "a cursor sent 5 s ago says nothing about this press");
    done();
  } finally {
    mock.timers.reset();
  }
});

test("a saved tab coming back (restoring) is nobody going there; a load by hand is the user's", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 4_000_000 });
  try {
    let restoring = true;
    const presence = createPresence({ host: "Bob", readEvents: async () => [], pages: () => [], paused: () => true,
      onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {}, restoring: () => restoring });
    const handlers = {};
    let url = "about:blank";
    const page = { url: () => url, on: (ev, fn) => { handlers[ev] = fn; } };
    presence.watchUser(page);
    url = "https://shop.example/account";
    handlers.load();
    assert.equal(presence.userNote(page), "", "a restored tab's load is nobody's");
    restoring = false;
    url = "https://shop.example/orders?page=2";
    handlers.load();
    assert.match(presence.userNote(page), /The user used this tab meanwhile: went to https:\/\/shop.example\/orders\./);
  } finally {
    mock.timers.reset();
  }
});

// One open wait per frame: a frame still answering isn't asked again, a frame without the page
// script is asked again only after a while, and a late answer is still used.
test("one wait per frame, a frame without the page script backs off, a late answer still counts", async () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 3_000_000 });
  try {
    const asked = [];
    const pending = new Map();
    const frame = (name) => ({ name, evaluate() {} });
    const page = (frames) => ({ isClosed: () => false, frames: () => frames, url: () => "https://a.example/" });
    const slow = frame("slow"), blank = frame("blank"), quick = frame("quick");
    const pages = [page([slow, blank, quick])];
    const presence = createPresence({ host: "You", pages: () => pages, paused: () => false,
      readEvents: (f, waitMs) => {
        asked.push(f.name);
        assert.equal(waitMs, 5000, "the wait's time goes to the page");
        if (f === blank) return Promise.resolve(undefined); // no page script there
        if (f === quick) return Promise.resolve([]);
        return new Promise((resolve) => pending.set(f, resolve));
      },
      onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
    // A tick of the clock, then the round's promises (setImmediate isn't mocked).
    const tick = async (ms) => { for (let i = 0; i < ms / 100; i++) { mock.timers.tick(100); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); } };
    await tick(500);
    assert.deepEqual(asked.sort(), ["blank", "quick", "slow"], "every frame asked once");
    asked.length = 0;
    await tick(1000);
    assert.ok(asked.includes("quick") && !asked.includes("slow") && !asked.includes("blank"), `the slow frame is still answering, the blank one is left alone for a while: ${asked}`);
    asked.length = 0;
    await tick(2000);
    assert.ok(asked.includes("blank"), "the blank frame is asked again after a while");
    assert.ok(!asked.includes("slow"), "never two waits in one frame");
    // The slow frame answers 3 s late with a click: the person counts as using the tab from then.
    pending.get(slow)([{ t: Date.now() - 100, kind: "click", what: "Submit" }]);
    await tick(100);
    assert.equal(presence.personIn(pages[0]), "You", "the late click still counts");
  } finally {
    mock.timers.reset();
  }
});

test("onActing says when agents start acting and when the last action ends, once each", () => {
  const seen = [];
  const presence = createPresence({ host: "You", readEvents: async () => [], pages: () => [], paused: () => true,
    onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {}, onActing: (on) => seen.push(on) });
  const a = presence.busyStart();
  const b = presence.busyStart("no-keys");
  assert.deepEqual(seen, [true], "the second span opens nothing new");
  a();
  assert.deepEqual(seen, [true], "one span still runs");
  b();
  assert.deepEqual(seen, [true, false]);
  b();
  assert.deepEqual(seen, [true, false], "ending twice says nothing more");
});

test("a person's input in the other browser counts from when they did it, however late the news crosses", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 3_000_000 });
  try {
    const make = (host) => createPresence({ host, readEvents: async () => [], pages: () => [], paused: () => true, onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
    const joiner = make("Alice"), host = make("Bob");
    const copy = {}, tab = {};
    // Alice types in her copy of the tab, at t0.
    const t0 = Date.now();
    joiner.userDid([{ kind: "type", t: t0, what: "Comments" }], copy);
    mock.timers.tick(1200);
    // The joiner's round puts its news together 1.2 s later: when she typed, not how long ago yet.
    const person = joiner.sharedPerson(copy);
    assert.equal(person.at, t0, "the time she typed, not an age that goes stale");
    const op = { op: "person", id: "x", did: [], acting: true, at: person.at };
    // A busy computer: the round sends it 1.3 s later still (its forms read slowly).
    mock.timers.tick(1300);
    const sent = sentAgo(op);
    assert.deepEqual(sent, { op: "person", id: "x", did: [], acting: true, ago: 2500 }, "ago measured as it leaves; at never crosses");
    // On the host it waits in line behind other input for 400 ms before it's applied.
    const heardAt = Date.now();
    mock.timers.tick(400);
    host.elsewhere(tab, "Alice", sent.did, sent.acting, sent.ago, heardAt);
    assert.equal(host.actingIn(tab), null, "a keystroke 2.9 s old holds the host's agents no longer: a run starting now goes on");
    // Measured when the op was put together (1.2 s) and applied as if it had just arrived, the
    // same keystroke would have held them until 2 s after the news landed.
    const late = make("Bob");
    late.elsewhere(tab, "Alice", [], true, 1200);
    assert.equal(late.actingIn(tab), "Alice", "the old way: old input made new");
    // Fresh news still holds them, from when she did it.
    host.elsewhere(tab, "Alice", [], true, 300, Date.now() - 100);
    assert.equal(host.actingIn(tab), "Alice");
    mock.timers.tick(1500);
    assert.equal(host.actingIn(tab), "Alice", "1.9 s after she typed");
    mock.timers.tick(200);
    assert.equal(host.actingIn(tab), null, "2.1 s after: idle");
    const form = { op: "form", id: "x" };
    assert.equal(sentAgo(form), form, "other changes go as they are");
  } finally {
    mock.timers.reset();
  }
});

// The other direction (host -> joiner): the host's tabs say a person there is acting. Without a
// time, every resend of the state (each 900 ms while the person is there) made it new on the
// joiner's side, so the joiner's agents waited for as long as the resends went on, past the 2 s.
test("a person acting in the host's browser holds the joiner's agents from when they acted, however often the state comes again", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 5_000_000 });
  try {
    const make = (host) => createPresence({ host, readEvents: async () => [], pages: () => [], paused: () => true, onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
    const host = make("Bob"), joiner = make("Ann"), oldWay = make("Ann");
    const tab = {}, copy = {}, oldCopy = {};
    const t0 = Date.now();
    host.userDid([{ kind: "type", t: t0, what: "Comments" }], tab);
    // The host's round, as liveview.mjs tabsFor and push.mjs build it: at rounded up to the
    // second, the state compared with at in it, sent with at as an ago.
    const round = () => {
      const p = host.sharedPerson(tab);
      const at = p?.acting && Number.isFinite(p.at) ? Math.ceil(p.at / 1000) * 1000 : null;
      return stateForJoiner({ tabs: [{ id: "x", url: "https://example.com/", title: "Example", person: p?.who || "", acting: !!p?.acting, at }] }, { name: "Ann" });
    };
    const first = round();
    assert.equal(first.tabs[0].at, t0, "the host's time, in the state it compares");
    mock.timers.tick(600);
    assert.equal(JSON.stringify(round()), JSON.stringify(first), "unchanged while they keep still: no news, the dedupe holds");
    // Resent every 900 ms while Bob is there; each copy crosses 300 ms late and waits 100 ms here.
    let heldUntil = 0;
    for (let sent = 900; sent <= 1800; sent += 900) {
      mock.timers.tick(sent - (Date.now() - t0));
      const out = stateAgo(round());
      assert.ok(!("at" in out.tabs[0]), "at never crosses");
      assert.equal(out.tabs[0].ago, sent, "ago measured as it leaves");
      mock.timers.tick(300);
      const heardAt = Date.now();
      mock.timers.tick(100);
      joiner.elsewhere(copy, out.tabs[0].person, [], out.tabs[0].acting, out.tabs[0].ago, heardAt);
      oldWay.elsewhere(oldCopy, out.tabs[0].person, [], out.tabs[0].acting);
      if (joiner.actingIn(copy)) heldUntil = Date.now();
    }
    assert.ok(heldUntil > 0, "the joiner's agents wait while Bob types");
    // Each copy holds them from Bob's keystroke plus the 300 ms it took to cross (unknowable without
    // a shared clock), the same moment for both copies: 2 s after that they go on.
    mock.timers.tick(t0 + 2350 - Date.now());
    assert.equal(joiner.actingIn(copy), null, "2.3 s after Bob's keystroke the joiner's agents go on");
    assert.equal(oldWay.actingIn(oldCopy), "Bob", "the old way: the last resend made his keystroke new again");
    // A state from a host without the time still holds them (from arrival, as before).
    const plain = stateAgo({ tabs: [{ id: "x", person: "Bob", acting: true }] });
    assert.equal(plain.tabs[0].ago, undefined);
    const t = {};
    joiner.elsewhere(t, "Bob", [], true, plain.tabs[0].ago ?? 0, Date.now());
    assert.equal(joiner.actingIn(t), "Bob");
  } finally {
    mock.timers.reset();
  }
});

test("stateAgo: only tabs with a time change; at becomes a whole, never negative ago", () => {
  const none = { tabs: [{ id: "a", person: "Bob" }], activity: [] };
  assert.equal(stateAgo(none, 10_000), none, "nothing to convert: the same state");
  assert.equal(stateAgo(null), null);
  const out = stateAgo({ tabs: [{ id: "a", acting: true, at: 9_000.4 }, { id: "b", acting: true, at: 11_000 }, { id: "c", at: null }, { id: "d" }], people: [] }, 10_000);
  assert.deepEqual(out.tabs, [{ id: "a", acting: true, ago: 1000 }, { id: "b", acting: true, ago: 0 }, { id: "c" }, { id: "d" }]);
  // stateForJoiner carries at only while the person acts, and never the joiner's own.
  const s = stateForJoiner({ tabs: [{ id: "a", url: "https://e.com/", title: "E", person: "Bob", acting: true, at: 5000 }, { id: "b", url: "https://e.com/b", title: "B", person: "Bob", acting: false, at: 5000 },
    { id: "c", url: "https://e.com/c", title: "C", person: "Ann", acting: true, at: 5000 }, { id: "d", url: "https://e.com/d", title: "D", person: "Bob", acting: true, at: "soon" }] }, { name: "Ann" });
  assert.deepEqual(s.tabs.map((t) => [t.id, t.acting, t.at]), [["a", true, 5000], ["b", undefined, undefined], ["c", undefined, undefined], ["d", true, undefined]]);
});

test("a state from the host heard 1.2 s late with ago 300 ms counts the person from 1.5 s back", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 6_000_000 });
  try {
    const joiner = createPresence({ host: "Ann", readEvents: async () => [], pages: () => [], paused: () => true, onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
    const copy = {};
    // The state arrived (heardAt), then waited 1.2 s here behind other changes before it's applied.
    const heardAt = Date.now();
    mock.timers.tick(1200);
    joiner.elsewhere(copy, "Bob", [], true, 300, heardAt);
    assert.equal(joiner.actingIn(copy), "Bob", "1.5 s after he typed: still acting");
    mock.timers.tick(499);
    assert.equal(joiner.actingIn(copy), "Bob", "1.999 s after");
    mock.timers.tick(2);
    assert.equal(joiner.actingIn(copy), null, "2 s after he typed, not 2 s after it was applied");
    // A heardAt in the future (a confused caller) never makes news newer than now.
    const later = {};
    joiner.elsewhere(later, "Bob", [], true, 0, Date.now() + 60_000);
    mock.timers.tick(2001);
    assert.equal(joiner.actingIn(later), null);
  } finally {
    mock.timers.reset();
  }
});

// What people did in a host tab (its did entries) crossed with no time and counted from when the
// joiner applied the state: each entry now carries its own, counted back from arrival.
test("the joiner applies the host's state late: what the person did there counts from when they did it (hostPeople)", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 7_000_000 });
  try {
    const make = (host) => createPresence({ host, readEvents: async () => [], pages: () => [], paused: () => true, onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
    const host = make("Bob"), joiner = make("Ann"), oldWay = make("Ann");
    const tab = {}, copy = {}, oldCopy = {};
    const t0 = Date.now();
    host.userDid([{ kind: "click", t: t0, what: "Save" }], tab);
    const p = host.sharedPerson(tab);
    const did = host.feedAfter(tab);
    assert.equal(did.at(-1).t, t0);
    // The host's round 400 ms later: its did entries keep their time (at), then leave as an ago.
    mock.timers.tick(400);
    const state = stateForJoiner({ tabs: [{ id: "x", url: "https://example.com/", title: "Example", person: p.who, acting: p.acting, at: p.at, did }] }, { name: "Ann" });
    assert.equal(state.tabs[0].did[0].at, t0, "the time crosses inside the host's own state");
    const sent = stateAgo(state);
    assert.ok(!("at" in sent.tabs[0].did[0]), "at never crosses");
    assert.equal(sent.tabs[0].did[0].ago, 400);
    // It crosses in 200 ms, then waits 1 s behind other changes before the joiner applies it.
    mock.timers.tick(200);
    const heardAt = Date.now();
    mock.timers.tick(1000);
    hostPeople(joiner, copy, sent.tabs[0], sent.tabs[0].did, "Bob", heardAt);
    // The old way: no ago, counted from when it was applied.
    hostPeople(oldWay, oldCopy, { person: "Bob" }, [{ n: 1, who: "Bob", line: sent.tabs[0].did[0].line }], "Bob");
    assert.equal(joiner.actingIn(copy), "Bob", "1.6 s after his click: the joiner's agents wait");
    assert.match(joiner.userNote(copy), /Bob used this tab meanwhile/);
    mock.timers.tick(600); // 2.2 s after his click: counted from it plus the 200 ms crossing (unknowable without a shared clock)
    assert.equal(joiner.actingIn(copy), null, "2 s after that they go on");
    assert.equal(oldWay.actingIn(oldCopy), "Bob", "the old way: held until 2 s after the late apply");
    // An older host: no ago anywhere, counted from arrival.
    const older = {};
    const arrived = Date.now();
    mock.timers.tick(500);
    hostPeople(joiner, older, { person: "Bob", acting: true }, [], "Bob", arrived);
    mock.timers.tick(1501);
    assert.equal(joiner.actingIn(older), null, "2 s after arrival");
  } finally {
    mock.timers.reset();
  }
});

// Whose a pointer move was: the live view replays the owner's input (the host's person) and an
// invite link's viewer's (someone else: never the host's pointer for joiners), an agent's actions
// and a shared browser joiner's input are never the host's either.
test("othersMove: an invite viewer's replayed move is not the host's; the owner's live view move is", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 3_000_000 });
  try {
    const presence = createPresence({ host: "You", readEvents: async () => [], pages: () => [], paused: () => true,
      onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
    assert.equal(presence.othersMove(Date.now()), false, "nothing replayed: the host's own");
    let done = presence.replayStart(); // the owner's live view
    const owner = Date.now();
    mock.timers.tick(100);
    done();
    assert.equal(presence.othersMove(owner), false, "the owner is the host's person");
    mock.timers.tick(1000);
    done = presence.replayStart("Dana (by hand)"); // an invite link's viewer
    const viewer = Date.now();
    mock.timers.tick(100);
    done();
    assert.equal(presence.othersMove(viewer), true, "an invite viewer's move is theirs");
    assert.equal(presence.byPerson(viewer), false, "and never an answer to a join prompt");
    mock.timers.tick(1000);
    assert.equal(presence.othersMove(Date.now()), false, "after it, the host's again");
    done = presence.remoteStart("Eve");
    assert.equal(presence.othersMove(Date.now()), true, "a joiner's replayed input");
    done();
    mock.timers.tick(1000);
    done = presence.busyStart();
    assert.equal(presence.othersMove(Date.now()), true, "an agent's action");
    done();
  } finally {
    mock.timers.reset();
  }
});
