// The person's own tabs (a file they opened from Downloads): agents never read their address,
// title or content, and never act in, select or close them (daemon/output.mjs hidePersonTabs,
// daemon/serve.mjs tabRefusal, daemon/toolstab.mjs createPersonTabs).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { hidePersonTabs, PERSON_TAB_RULE, PERSON_TAB_LINE } from "../scripts/daemon/output.mjs";
import { tabRefusal } from "../scripts/daemon/serve/refuse.mjs";
import { createPersonTabs } from "../scripts/daemon/toolstab.mjs";
import { CHROME_PAGE_RULE } from "../scripts/rules/policy.mjs";

const page = (url) => ({ url: () => url });

test("hidePersonTabs: the person's tab lines say only that; every other line is unchanged", () => {
  const list = [
    "### Open tabs",
    "- 0: [Shop](https://shop.example/)",
    "- 1: (current) [Bank](https://bank.example/login)",
    "- 2: [invoice (1).pdf](file:///Users/x/Downloads/invoice%20(1).pdf)",
    "- 3: [Secret marker PB-PERSON-ONLY](https://ignored.example/)",
    "- 4: (current) [note.txt](file:///Users/x/Downloads/note.txt)",
  ].join("\n");
  const out = hidePersonTabs(list, [3]);
  assert.equal(out, [
    "### Open tabs",
    "- 0: [Shop](https://shop.example/)",
    "- 1: (current) [Bank](https://bank.example/login)",
    `- 2: ${PERSON_TAB_LINE}`,
    `- 3: ${PERSON_TAB_LINE}`,
    `- 4: ${PERSON_TAB_LINE}`,
  ].join("\n"));
  assert.equal(hidePersonTabs("- 2: [invoice (1).pdf](file:///Users/x/Downloads/invoice%20(1).pdf)"), "- 2: the person's tab (a downloaded file)");
  // A page block about a file: tab: no address, no title.
  const page = "### Page\n- Page URL: file:///Users/x/Downloads/note.txt\n- Page Title: note.txt\n- Console: 0";
  assert.equal(hidePersonTabs(page), `### Page\n- Page URL: (${PERSON_TAB_LINE})\n- Console: 0`);
  // Untouched: a web page block, text that merely mentions file:, indices of other tabs.
  const web = "### Page\n- Page URL: https://a.example/\n- Page Title: A\nThe word file: in text\n- 7: [x](https://x.example/)";
  assert.equal(hidePersonTabs(web, [1, 2]), web);
});

test("tabRefusal: chrome pages keep today's sentences; person tabs are refused for every acting tool", () => {
  const chrome = page("chrome://pairbrowse/newtab");
  const web = page("https://shop.example/");
  const set = createPersonTabs();
  const mine = page("about:blank");
  set.add(mine);
  const personTab = (p) => set.has(p);
  // The browser's own pages: byte-identical to the sentences before.
  assert.equal(tabRefusal("browser_click", { target: "e1" }, { here: chrome, personTab }), `${CHROME_PAGE_RULE} Open a web page with browser_tabs new (url) or pick another tab with browser_tabs list and select.`);
  assert.equal(tabRefusal("browser_tabs", { action: "select", index: 0 }, { pages: [chrome], personTab }), `Tab 0 is the browser's own page. ${CHROME_PAGE_RULE} Use browser_tabs list.`);
  const tools = ["browser_click", "browser_type", "browser_snapshot", "browser_find", "browser_navigate", "browser_navigate_back", "browser_press_key", "browser_wait_for", "browser_hover", "browser_fill_form",
    "browser_select_option", "browser_drag", "browser_drop", "browser_file_upload", "browser_handle_dialog", "pairbrowse_click_at", "pairbrowse_scroll", "pairbrowse_upload", "pairbrowse_run"];
  const fileTab = page("file:///Users/x/Downloads/a.pdf"); // not in the set: its address says so
  for (const here of [mine, fileTab]) {
    for (const name of tools) {
      assert.equal(tabRefusal(name, {}, { here, personTab }), `${PERSON_TAB_RULE} Open a web page with browser_tabs new (url) or pick another tab with browser_tabs list and select.`, name);
    }
    for (const name of ["browser_tabs", "browser_close", "pairbrowse_status", "pairbrowse_session"]) assert.equal(tabRefusal(name, { action: "list" }, { here, personTab }), null, name);
  }
  const pages = [web, mine, fileTab];
  for (const action of ["select", "close"]) {
    assert.equal(tabRefusal("browser_tabs", { action, index: 1 }, { pages, personTab }), `Tab 1 is the person's own tab (a downloaded file they opened). ${PERSON_TAB_RULE} Use browser_tabs list.`);
    assert.equal(tabRefusal("browser_tabs", { action, index: 2 }, { pages, personTab }), `Tab 2 is the person's own tab (a downloaded file they opened). ${PERSON_TAB_RULE} Use browser_tabs list.`);
    assert.equal(tabRefusal("browser_tabs", { action, index: 0 }, { pages, personTab }), null);
  }
  for (const action of ["list", "new"]) assert.equal(tabRefusal("browser_tabs", { action, url: "https://a.example/" }, { here: mine, pages, personTab }), null, action);
  assert.equal(tabRefusal("browser_click", {}, { here: web, personTab }), null);
  assert.equal(tabRefusal("browser_click", {}, { here: null, personTab }), null);
});

test("createPersonTabs: add, has, delete; any file: tab counts", () => {
  const set = createPersonTabs();
  const p = page("about:blank");
  assert.equal(set.has(p), false);
  set.add(p);
  assert.equal(set.has(p), true);
  set.delete(p);
  assert.equal(set.has(p), false);
  assert.equal(set.has(page("file:///tmp/x.txt")), true);
  assert.equal(set.has(page("FILE:///tmp/x.txt")), true);
  assert.equal(set.has(page("https://a.example/")), false);
  assert.equal(set.has(null), false);
  assert.equal(set.has({ url: () => { throw new Error("closed"); } }), false);
});

test("the four cases: a file: tab the person opened, by index, an agent's tab navigated to file:, and the tabs list", async () => {
  const { HIDDEN_TOOLS } = await import("../scripts/rules/policy.mjs");
  const set = createPersonTabs(); // the helper never added any of these tabs
  const personTab = (p) => set.has(p);
  const refusal = `${PERSON_TAB_RULE} Open a web page with browser_tabs new (url) or pick another tab with browser_tabs list and select.`;
  const everyBrowserTool = [...HIDDEN_TOOLS, "browser_click", "browser_type", "browser_snapshot", "browser_find", "browser_navigate", "browser_navigate_back", "browser_press_key",
    "browser_wait_for", "browser_hover", "browser_fill_form", "browser_select_option", "browser_drag", "browser_drop", "browser_file_upload", "browser_handle_dialog",
    "browser_pdf_save", "browser_mouse_click_xy", "browser_mouse_move_xy", "browser_mouse_drag_xy", "browser_a_future_tool"].filter((n) => n !== "browser_close");
  // (a) A file: tab the person opened themselves (typed the address, dragged a file in): refused for every browser_* tool.
  const theirs = page("file:///Users/x/Desktop/private.pdf");
  assert.equal(set.has(theirs), true, "its address alone makes it theirs");
  for (const name of everyBrowserTool) assert.equal(tabRefusal(name, { element: "x", ref: "e1" }, { here: theirs, personTab }), refusal, name);
  // (b) browser_tabs select and close by its index: refused.
  const web = page("https://shop.example/");
  for (const action of ["select", "close"]) {
    assert.equal(tabRefusal("browser_tabs", { action, index: 1 }, { pages: [web, theirs], personTab }), `Tab 1 is the person's own tab (a downloaded file they opened). ${PERSON_TAB_RULE} Use browser_tabs list.`, action);
    assert.equal(tabRefusal("browser_tabs", { action, index: "1" }, { pages: [web, theirs], personTab }), `Tab 1 is the person's own tab (a downloaded file they opened). ${PERSON_TAB_RULE} Use browser_tabs list.`, `${action} "1"`);
  }
  // (c) An agent's own tab the person navigated to file:: refused from then on (read at call time).
  let at = "https://shop.example/cart";
  const agents = { url: () => at };
  assert.equal(tabRefusal("browser_click", {}, { here: agents, personTab }), null, "a web page: the agent acts");
  at = "file:///Users/x/Downloads/statement.pdf";
  for (const name of everyBrowserTool) assert.equal(tabRefusal(name, {}, { here: agents, personTab }), refusal, `navigated: ${name}`);
  assert.equal(tabRefusal("browser_tabs", { action: "close", index: 0 }, { pages: [agents], personTab }), `Tab 0 is the person's own tab (a downloaded file they opened). ${PERSON_TAB_RULE} Use browser_tabs list.`);
  // (d) browser_tabs list: no address or title for either, by index (as serve.mjs reads it) or by its file: link.
  const pages = [web, theirs, agents];
  const indices = pages.flatMap((p, i) => (personTab(p) ? [i] : []));
  assert.deepEqual(indices, [1, 2]);
  const listed = ["### Result", "- 0: [Shop](https://shop.example/)", "- 1: [Private PB-TITLE-1](file:///Users/x/Desktop/private.pdf)",
    "- 2: (current) [Statement PB-TITLE-2](file:///Users/x/Downloads/statement.pdf)"].join("\n");
  for (const out of [hidePersonTabs(listed, indices), hidePersonTabs(listed)]) {
    assert.equal(out, ["### Result", "- 0: [Shop](https://shop.example/)", `- 1: ${PERSON_TAB_LINE}`, `- 2: ${PERSON_TAB_LINE}`].join("\n"));
    assert.ok(!/PB-TITLE|file:|private\.pdf|statement\.pdf/i.test(out), out);
  }
});

// plans/555 Risk 1: the start tab is now PairBrowse's new tab page. browser_navigate may take an
// untouched one to a web page (as it took the about:blank start tab before); nothing else acts in
// it, and any other browser page stays refused even for browser_navigate.
test("tabRefusal: browser_navigate may leave an untouched new tab page, nothing else may act in it", () => {
  const personTab = () => false;
  for (const url of ["chrome://pairbrowse/newtab/", "chrome://newtab/"]) {
    const start = page(url);
    assert.equal(tabRefusal("browser_navigate", { url: "https://example.com" }, { here: start, personTab }), null, url);
    for (const name of ["browser_snapshot", "browser_click", "browser_type", "browser_navigate_back", "pairbrowse_run"]) {
      if (url.startsWith("chrome://pairbrowse")) assert.match(tabRefusal(name, {}, { here: start, personTab }) || "", /chrome:\/\/pairbrowse pages/, name);
    }
  }
  for (const url of ["chrome://pairbrowse/picker/", "chrome://pairbrowse/settings/", "chrome://pairbrowse/newtab/more"]) {
    assert.match(tabRefusal("browser_navigate", { url: "https://example.com" }, { here: page(url), personTab }) || "", /chrome:\/\/pairbrowse pages/, url);
  }
});
