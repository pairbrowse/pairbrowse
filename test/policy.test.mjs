// The browser's own pages (chrome://pairbrowse...): never an agent's to open, list or act in.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { navigationProblem, isBrowserPage, hiddenFromLiveView, BROWSER_PAGE_RULE, BROWSER_PAGE_ORIGINS } from "../scripts/rules/policy.mjs";
import { hideBrowserTabs } from "../scripts/daemon/output.mjs";

const OWN = ["chrome://pairbrowse/picker", "chrome://pairbrowse.top-chrome/strip", "chrome://PairBrowse/x?y#z", "  chrome://pairbrowse"];

test("the browser's own pages are refused with the sentence naming their rule", () => {
  for (const url of OWN) assert.match(navigationProblem(url), /browser's own/, url);
  assert.equal(navigationProblem("chrome://pairbrowse/picker"), `${BROWSER_PAGE_RULE} Open a web page (http or https) instead.`);
  // Every other chrome: address stays refused as not a web page, as before.
  const settings = navigationProblem("chrome://settings");
  assert.notEqual(settings, null);
  assert.doesNotMatch(settings, /browser's own/);
  assert.match(settings, /only opens web pages/);
  assert.equal(navigationProblem("https://x.com"), null);
  assert.deepEqual(BROWSER_PAGE_ORIGINS, ["chrome://pairbrowse", "chrome://pairbrowse.top-chrome"]);
});

test("isBrowserPage matches the browser's own pages and nothing that looks like them", () => {
  for (const url of OWN) assert.equal(isBrowserPage(url), true, url);
  for (const url of ["chrome://pairbrowse.evil/", "chrome://xpairbrowse/", "https://pairbrowse/", "chrome-extension://abc/picker.html", "about:blank", "", undefined, null, "not a url", "chrome://pairbrowse-x/", "chrome://pairbrowse.top-chrome.evil/"]) {
    assert.equal(isBrowserPage(url), false, String(url));
  }
});

test("the live view keeps out the browser's own pages, a joiner's picture page excepted", () => {
  for (const url of OWN) assert.equal(hiddenFromLiveView(url), true, url);
  for (const url of ["chrome://pairbrowse/screen/#0a1b2c3d", "chrome://pairbrowse/screen/"]) assert.equal(hiddenFromLiveView(url), false, url);
  for (const url of ["chrome://pairbrowse/screenx/", "chrome://pairbrowse/screen", "chrome://pairbrowse.top-chrome/screen/", "chrome://pairbrowse/picker#screen/"]) assert.equal(hiddenFromLiveView(url), true, url);
  for (const url of ["https://x.com/", "about:blank"]) assert.equal(hiddenFromLiveView(url), false, url);
  // Agents' rules are unchanged: the picture page is still the browser's own page to them.
  assert.equal(navigationProblem("chrome://pairbrowse/screen/#0a1b2c3d"), `${BROWSER_PAGE_RULE} Open a web page (http or https) instead.`);
});

test("browser_tabs lists without the browser's own pages, every other tab keeping its number", () => {
  const input = "### Result\n- 0: [A](http://a/)\n- 1: (current) [Choose a session](chrome://pairbrowse/picker)\n- 2: [Strip](chrome://pairbrowse.top-chrome/strip)\n- 3: [B](https://b/)\n";
  const out = hideBrowserTabs(input);
  assert.equal(out, "### Result\n- 0: [A](http://a/)\n- 3: [B](https://b/)\n");
  assert.doesNotMatch(out, /\(current\)/);
  const plain = "### Result\n- 0: (current) [A](http://a/)\n- 1: [B](https://b/)\n\n### Page\n- Page URL: https://b/\n";
  assert.equal(hideBrowserTabs(plain), plain);
});

// A downloaded file shows in the person's own tab only through the Downloads list; agents' file:
// navigation stays refused.
test("agents never open file: addresses, a downloaded file's included", () => {
  for (const url of ["file:///Users/x/Downloads/a.pdf", "FILE:///etc/passwd"]) {
    const problem = navigationProblem(url);
    assert.notEqual(problem, null, url);
    assert.match(problem, /only opens web pages/, url);
  }
});

test("pairbrowse:// addresses are the browser's own, as chrome://pairbrowse ones: refused, hidden, never an agent's", async () => {
  const { isBrowserPage, isBrowserScreenPage, hiddenFromLiveView, navigationProblem, BROWSER_PAGE_RULE } = await import("../scripts/rules/policy.mjs");
  const { hideBrowserTabs } = await import("../scripts/daemon/output.mjs");
  for (const u of ["pairbrowse://settings", "pairbrowse://browser-settings", "PAIRBROWSE://about", " pairbrowse://newtab/", "pairbrowse:sessions"]) {
    assert.equal(isBrowserPage(u), true, u);
    assert.equal(hiddenFromLiveView(u), true, u);
    assert.equal(navigationProblem(u.trim()), `${BROWSER_PAGE_RULE} Open a web page (http or https) instead.`, u);
  }
  assert.equal(isBrowserScreenPage("pairbrowse://screen/"), true);
  assert.equal(hiddenFromLiveView("pairbrowse://screen/"), false, "a joiner's picture page shows, as chrome://pairbrowse/screen/ does");
  assert.equal(hideBrowserTabs("- 0: [Settings](pairbrowse://settings)\n- 1: [Shop](https://shop.example/)"), "- 1: [Shop](https://shop.example/)");
  assert.equal(isBrowserPage("https://pairbrowse.com/"), false);
});
