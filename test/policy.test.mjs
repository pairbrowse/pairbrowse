// The browser's own pages (chrome://pairbrowse...): never an agent's to open, list or act in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { navigationProblem, isChromePage, CHROME_PAGE_RULE, CHROME_PAGE_ORIGINS } from "../scripts/policy.mjs";
import { hideChromeTabs } from "../scripts/daemon/output.mjs";

const OWN = ["chrome://pairbrowse/picker", "chrome://pairbrowse.top-chrome/strip", "chrome://PairBrowse/x?y#z", "  chrome://pairbrowse"];

test("the browser's own pages are refused with the sentence naming their rule", () => {
  for (const url of OWN) assert.match(navigationProblem(url), /browser's own/, url);
  assert.equal(navigationProblem("chrome://pairbrowse/picker"), CHROME_PAGE_RULE);
  // Every other chrome: address stays refused as not a web page, as before.
  const settings = navigationProblem("chrome://settings");
  assert.notEqual(settings, null);
  assert.doesNotMatch(settings, /browser's own/);
  assert.match(settings, /only opens web pages/);
  assert.equal(navigationProblem("https://x.com"), null);
  assert.deepEqual(CHROME_PAGE_ORIGINS, ["chrome://pairbrowse", "chrome://pairbrowse.top-chrome"]);
});

test("isChromePage matches the browser's own pages and nothing that looks like them", () => {
  for (const url of OWN) assert.equal(isChromePage(url), true, url);
  for (const url of ["chrome://pairbrowse.evil/", "chrome://xpairbrowse/", "https://pairbrowse/", "chrome-extension://abc/picker.html", "about:blank", "", undefined, null, "not a url", "chrome://pairbrowse-x/", "chrome://pairbrowse.top-chrome.evil/"]) {
    assert.equal(isChromePage(url), false, String(url));
  }
});

test("browser_tabs lists without the browser's own pages, every other tab keeping its number", () => {
  const input = "### Result\n- 0: [A](http://a/)\n- 1: (current) [Choose a session](chrome://pairbrowse/picker)\n- 2: [Strip](chrome://pairbrowse.top-chrome/strip)\n- 3: [B](https://b/)\n";
  const out = hideChromeTabs(input);
  assert.equal(out, "### Result\n- 0: [A](http://a/)\n- 3: [B](https://b/)\n");
  assert.doesNotMatch(out, /\(current\)/);
  const plain = "### Result\n- 0: (current) [A](http://a/)\n- 1: [B](https://b/)\n\n### Page\n- Page URL: https://b/\n";
  assert.equal(hideChromeTabs(plain), plain);
});
