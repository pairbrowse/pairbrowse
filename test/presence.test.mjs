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
