// pairbrowse_run whose first step is go, called while the agent's tab is one of the browser's own
// pages: the run opens its own web tab (runOpensTab) instead of being refused, and on an untouched
// new tab page it goes there in place, as browser_navigate does (refuse.mjs tabRefusal).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { runOpensTab, tabRefusal } from "../scripts/daemon/serve/refuse.mjs";
import { BROWSER_PAGE_RULE } from "../scripts/rules/policy.mjs";

const page = (url) => ({ url: () => url });
const run = (...steps) => ({ steps });
const REFUSED = `${BROWSER_PAGE_RULE} Open a web page with browser_tabs new (url) or pick another tab with browser_tabs list and select.`;

test("runOpensTab: a run starting with go on a browser page other than an untouched new tab opens its own tab", () => {
  for (const url of ["chrome://pairbrowse/picker", "pairbrowse://settings", "chrome://pairbrowse/sessions"]) {
    assert.equal(runOpensTab("pairbrowse_run", run({ go: "https://httpbin.org/forms/post" }, { fill: { A: "b" } }), page(url)), "https://httpbin.org/forms/post", url);
  }
});

test("runOpensTab: nothing to open elsewhere", () => {
  const settings = page("pairbrowse://settings");
  // An untouched new tab page: the run's go takes it in place (tabRefusal lets it through).
  assert.equal(runOpensTab("pairbrowse_run", run({ go: "https://a.example/" }), page("chrome://pairbrowse/newtab")), null);
  assert.equal(runOpensTab("pairbrowse_run", run({ go: "https://a.example/" }), page("chrome://newtab/")), null);
  // A web page, no tab, a first step that isn't go, a go that isn't text, a saved playbook, another tool.
  assert.equal(runOpensTab("pairbrowse_run", run({ go: "https://a.example/" }), page("https://b.example/")), null);
  assert.equal(runOpensTab("pairbrowse_run", run({ go: "https://a.example/" }), null), null);
  assert.equal(runOpensTab("pairbrowse_run", run({ fill: { A: "b" } }, { go: "https://a.example/" }), settings), null);
  assert.equal(runOpensTab("pairbrowse_run", run({ go: { url: "https://a.example/" } }), settings), null);
  assert.equal(runOpensTab("pairbrowse_run", { playbook: "signup" }, settings), null);
  assert.equal(runOpensTab("pairbrowse_run", {}, settings), null);
  assert.equal(runOpensTab("browser_navigate", { url: "https://a.example/" }, settings), null);
});

test("tabRefusal: a run starting with go may leave an untouched new tab page; every other run there is refused", () => {
  const start = page("chrome://pairbrowse/newtab");
  assert.equal(tabRefusal("pairbrowse_run", run({ go: "https://a.example/" }), { here: start }), null);
  assert.equal(tabRefusal("pairbrowse_run", run({ fill: { A: "b" } }), { here: start }), REFUSED);
  assert.equal(tabRefusal("pairbrowse_run", { playbook: "signup" }, { here: start }), REFUSED);
  // Any other browser page stays refused here: runOpensTab moves the run to a tab of its own first.
  assert.equal(tabRefusal("pairbrowse_run", run({ go: "https://a.example/" }), { here: page("chrome://pairbrowse/picker") }), REFUSED);
  assert.equal(tabRefusal("browser_snapshot", {}, { here: start }), REFUSED);
});
