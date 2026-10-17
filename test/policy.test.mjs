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
  // The engine's settings page holds PairBrowse's own settings (its PairBrowse section, 580): the
  // browser's own at every section, under either spelling.
  for (const url of ["chrome://settings", "chrome://settings/", "chrome://settings/pairbrowse#report", "CHROME://settings/appearance", "pairbrowse://settings/pairbrowse"]) {
    assert.equal(isBrowserPage(url), true, url);
    assert.equal(hiddenFromLiveView(url), true, url);
    assert.match(navigationProblem(url), /browser's own/, url);
  }
  assert.equal(hideBrowserTabs("- 0: [Settings](chrome://settings/pairbrowse)\n- 1: [Shop](https://shop.example/)"), "- 1: [Shop](https://shop.example/)");
  // Every other chrome: address stays refused as not a web page, as before.
  for (const url of ["chrome://version", "chrome://settingsx", "chrome://history"]) {
    const other = navigationProblem(url);
    assert.notEqual(other, null, url);
    assert.equal(isBrowserPage(url), false, url);
    assert.match(other, /only opens web pages/, url);
  }
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

test("browser_tabs: a list the browser's own pages were taken out of says so, and what to do", async () => {
  const { hiddenTabsNote } = await import("../scripts/daemon/output.mjs");
  const only = "### Result\n- 0: (current) [New tab](chrome://pairbrowse/newtab)\n";
  assert.equal(hiddenTabsNote(only), "- 1 tab not listed: it is the browser's own page, which no agent reads or acts in. Your current tab is that page: open a web page with browser_tabs new (url).");
  const some = "### Result\n- 0: [A](http://a/)\n- 1: [Choose a session](chrome://pairbrowse/picker)\n- 2: (current) [Settings](pairbrowse://settings)\n";
  assert.equal(hiddenTabsNote(some), "- 2 tabs not listed: they are the browser's own pages, which no agent reads or acts in. Your current tab is one of them: open a web page with browser_tabs new (url) or select a listed tab.");
  assert.equal(hiddenTabsNote("### Result\n- 0: [A](http://a/)\n- 1: [Strip](chrome://pairbrowse.top-chrome/strip)\n"), "- 1 tab not listed: it is the browser's own page, which no agent reads or acts in.");
  assert.equal(hiddenTabsNote("### Result\n- 0: (current) [A](http://a/)\n"), "");
  assert.equal(hiddenTabsNote(""), "");
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
  for (const u of ["pairbrowse://settings", "pairbrowse://settings/pairbrowse#report", "pairbrowse://browser-settings", "pairbrowse://browser-newtab", "pairbrowse://browser-signin", "pairbrowse://chrome-urls",
    "PAIRBROWSE://about", " pairbrowse://newtab/", "pairbrowse:sessions"]) {
    assert.equal(isBrowserPage(u), true, u);
    assert.equal(hiddenFromLiveView(u), true, u);
    assert.equal(navigationProblem(u.trim()), `${BROWSER_PAGE_RULE} Open a web page (http or https) instead.`, u);
  }
  assert.equal(isBrowserScreenPage("pairbrowse://screen/"), true);
  assert.equal(hiddenFromLiveView("pairbrowse://screen/"), false, "a joiner's picture page shows, as chrome://pairbrowse/screen/ does");
  assert.equal(hideBrowserTabs("- 0: [Settings](pairbrowse://settings)\n- 1: [Shop](https://shop.example/)"), "- 1: [Shop](https://shop.example/)");
  assert.equal(isBrowserPage("https://pairbrowse.com/"), false);
});

// A field sensitive by its own kind (pageread.mjs sensitiveValues reads its hints: type,
// autocomplete, inputmode, name, id, aria-label, label, placeholder).
test("fields sensitive by their kind: password type, card and one-time-code autocomplete, card labels; never a ZIP or the name on the card", async () => {
  const { sensitiveHints } = await import("../scripts/rules/policy.mjs");
  for (const h of ["password  pw", "text cc-number numeric cn", "text cc-csc  cv", "text cc-exp", "text one-time-code numeric", "text   cvc", "tel   Card number", "text    Expiration date MM / YY", "text  iban", "tel    PIN", "password    PIN", "text    PIN code"]) assert.equal(sensitiveHints(h), true, h);
  for (const h of ["text postal-code  zip  ZIP code", "text cc-name   Name on card", "text name   Cardholder name", "email email", "text    Promo code", "number    Quantity", "text    Pin location", "text    Expires", "text    Card title", "text    Gift card"]) assert.equal(sensitiveHints(h), false, h);
});

// A one-time code's boxes, named but unlabeled ("otp", "code", "digit-3"), with a numeric kind or a
// short maxlength (pageread.mjs and covers.mjs add "maxlength<N>" last).
test("one-time code boxes by their name with a numeric kind or a short maxlength; not a phone's country code or a promo code", async () => {
  const { sensitiveHints, readSensitiveLabel } = await import("../scripts/rules/policy.mjs");
  for (const h of ["text  numeric otp", "text  numeric  totp-input", "text   code   maxlength6", "tel   digit-3  ", "text   sms_code  maxlength1", "text  numeric  verifyCode", "number   code", "text   pin  maxlength4", "text    digit_1 maxlength1"]) assert.equal(sensitiveHints(h), true, h);
  for (const h of ["text   code", "tel   country_code  Country code maxlength4", "text  numeric  area-code", "text   promo_code  Promo code maxlength8", "text   coupon-code maxlength8", "text  numeric zip  ZIP code maxlength5", "text   codename  maxlength6", "text   barcode maxlength8", "text  numeric  quantity maxlength2"]) assert.equal(sensitiveHints(h), false, h);
  for (const l of ["Digit 1", "digit 3 of 6"]) assert.equal(readSensitiveLabel(l), true, l);
  assert.equal(readSensitiveLabel("Digit counter"), false);
});

test("values that couldn't all be read: every field's and every typed value masked for a joiner's agent", async () => {
  const { maskForAgent, UNKNOWN_VALUES } = await import("../scripts/rules/policy.mjs");
  const text = '- textbox "Search" [ref=e1]: shoes\n- textbox "Name" [ref=e2]: Ada\n- textbox [ref=e3]: <secret>SHOP_PASSWORD</secret>\n- button "Go" [ref=e4]\n```js\nawait page.getByRole(\'textbox\', { name: \'Name\' }).fill(\'Ada\');\n```';
  const out = maskForAgent(text, UNKNOWN_VALUES);
  assert.match(out, /"Search" \[ref=e1\]: ••••/);
  assert.match(out, /"Name" \[ref=e2\]: ••••/);
  assert.match(out, /<secret>SHOP_PASSWORD<\/secret>/, "a saved password's name stays");
  assert.match(out, /\.fill\('••••'\)/);
  assert.equal(maskForAgent(text, []), text, "values known, none sensitive: as it is");
});
