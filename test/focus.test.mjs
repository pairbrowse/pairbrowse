import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isBrowser, isOwnBrowser, childPids, keepFocus, setQuietTabs } from "../scripts/focus.mjs";

test("isBrowser: the open build's and the native PairBrowse browser (release and dev), nothing else", () => {
  assert.equal(isBrowser("123 dev.pairbrowse.browser"), true);
  assert.equal(isBrowser("123 app.pairbrowse.browser"), true);
  assert.equal(isBrowser("123 app.pairbrowse.browser.dev"), true);
  assert.equal(isBrowser("123 com.apple.Terminal"), false);
  assert.equal(isBrowser("123 app.pairbrowse.browser.helper"), false);
  assert.equal(isBrowser(""), false);
});

test("focus follows this helper's own browser by its process: another helper's PairBrowse window is any other app", () => {
  const own = childPids(" 500   42\n 501 42\n 502 7\n bad line\n", 42);
  assert.deepEqual([...own], [500, 501]);
  assert.equal(isOwnBrowser("500 app.pairbrowse.browser", own), true);
  assert.equal(isOwnBrowser("502 app.pairbrowse.browser", own), false, "another instance's browser");
  assert.equal(isOwnBrowser("502 app.pairbrowse.browser.dev", own), false);
  assert.equal(isOwnBrowser("77 com.anthropic.claudefordesktop", own), false);
  // ps failed: the bundle ids decide, as before.
  assert.equal(isOwnBrowser("502 app.pairbrowse.browser.dev", new Set()), true);
  assert.equal(isOwnBrowser("77 com.apple.Terminal", new Set()), false);
});

test("keepFocus: a build whose tab changes never come in front (quietTabs) runs the change alone", async () => {
  let asked = 0;
  const children = async () => { asked++; return new Set(); };
  setQuietTabs(true);
  try {
    assert.equal(await keepFocus(async () => "done", { children }), "done");
    assert.equal(asked, 0, "nothing asked about the app in front");
  } finally { setQuietTabs(false); }
});
