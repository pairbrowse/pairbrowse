// The Web Store is the person's (rules/policy.mjs isWebStore): agents read it, never act there
// (a tool call's tab refusal, a fast-mode step). Its buttons' words: test/integration/web-store.test.mjs.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { isWebStore, WEB_STORE_RULE, HAND_TOOLS } from "../scripts/rules/policy.mjs";
import { tabRefusal } from "../scripts/daemon/serve/refuse.mjs";
import { stepsIn } from "../scripts/runner/steps.mjs";

test("the store's addresses, old and new; nothing else", () => {
  for (const u of ["https://chromewebstore.google.com/", "https://chromewebstore.google.com/detail/x/abcdefghijklmnopabcdefghijklmnop", "https://chrome.google.com/webstore/detail/x", "https://chrome.google.com/webstore"]) assert.equal(isWebStore(u), true, u);
  for (const u of ["http://chromewebstore.google.com/", "https://chromewebstore.google.com.evil.example/", "https://chrome.google.com/webstorex", "https://www.google.com/", "not a url", "", null]) assert.equal(isWebStore(u), false, String(u));
});

test("an agent's hands are refused on the store; reading and leaving it are not", () => {
  const here = { url: () => "https://chromewebstore.google.com/detail/x/abcdefghijklmnopabcdefghijklmnop" };
  for (const name of HAND_TOOLS) assert.equal(tabRefusal(name, { element: "Add to PairBrowse", ref: "e1" }, { here }), WEB_STORE_RULE, name);
  for (const name of ["browser_snapshot", "browser_find", "browser_navigate", "browser_navigate_back", "browser_wait_for", "pairbrowse_scroll", "browser_hover"]) assert.equal(tabRefusal(name, {}, { here }), null, name);
  assert.equal(tabRefusal("browser_click", { ref: "e1" }, { here: { url: () => "https://example.com/" } }), null);
  assert.match(WEB_STORE_RULE, /only they install extensions/);
});

test("a run reads the store and leaves it, never acts there", async () => {
  const page = { url: () => "https://chromewebstore.google.com/detail/x/abcdefghijklmnopabcdefghijklmnop" };
  const r = await stepsIn(page, [{ click: "Add to PairBrowse" }], {});
  assert.equal(r.ok, false);
  assert.equal(r.why, WEB_STORE_RULE);
  for (const step of [{ fill: { Search: "x" } }, { press: "Enter" }, { check: "x" }, { select: { a: "b" } }]) assert.equal((await stepsIn(page, [step], {})).why, WEB_STORE_RULE, JSON.stringify(step));
});

test("an agent's hands act only in web tabs: never in the browser's own pages or an extension's", async () => {
  const { NOT_WEB_RULE } = await import("../scripts/rules/policy.mjs");
  for (const url of ["chrome://extensions/", "chrome://flags/", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html", "chrome://history"]) {
    const here = { url: () => url };
    assert.equal(tabRefusal("browser_click", { ref: "e1" }, { here }), NOT_WEB_RULE, url);
    assert.equal(tabRefusal("pairbrowse_run", { steps: [{ click: "Developer mode" }] }, { here }), NOT_WEB_RULE, url);
    assert.equal(tabRefusal("pairbrowse_run", { steps: [{ go: "https://example.com/" }] }, { here }), null, "a run that goes elsewhere first");
    assert.equal(tabRefusal("browser_snapshot", {}, { here }), null, "reading");
    assert.equal((await stepsIn(here, [{ click: "Load unpacked" }], {})).why, NOT_WEB_RULE);
  }
  assert.equal(tabRefusal("browser_click", { ref: "e1" }, { here: { url: () => "about:blank" } }), null);
});

test("an error page says to load the address again, not that the tab is the browser's own", async () => {
  const { ERROR_PAGE_RULE } = await import("../scripts/rules/policy.mjs");
  assert.equal(tabRefusal("browser_click", { ref: "e1" }, { here: { url: () => "chrome-error://chromewebdata/" } }), ERROR_PAGE_RULE);
  assert.equal((await stepsIn({ url: () => "chrome-error://chromewebdata/" }, [{ click: "Reload" }], {})).why, ERROR_PAGE_RULE);
});
