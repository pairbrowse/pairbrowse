import { test } from "node:test";
import assert from "node:assert/strict";
import { isBrowser } from "../scripts/focus.mjs";

// The front app is "<pid> <bundle id>": both PairBrowse browsers count, other apps don't.
test("isBrowser: the Chromium-based and the native PairBrowse browser, nothing else", () => {
  assert.equal(isBrowser("123 dev.pairbrowse.browser"), true);
  assert.equal(isBrowser("123 app.pairbrowse.browser"), true);
  assert.equal(isBrowser("123 com.apple.Terminal"), false);
  assert.equal(isBrowser("123 app.pairbrowse.browser.helper"), false);
  assert.equal(isBrowser(""), false);
});
