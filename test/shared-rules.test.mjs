// Shared sessions, the owner's rules: agents across computers take turns in a tab; typing and
// clicking pause agents, moving and scrolling never; where each person reads shows on the other
// side; a payment form's submit is a final action by structure; card values never leave a stale
// or echoed value. Pure parts here; the in-page parts in a headless browser (PAIRBROWSE_TEST_RUNTIME).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { readOps, stateForJoiner, readPointers, readView, turnLeft, TURN_MAX_MS, createFormSync } from "../scripts/tabsync.mjs";
import { createPresence } from "../scripts/daemon/presence.mjs";
import { clickRisk } from "../scripts/daemon/page.mjs";
import { finalAction, finalKind } from "../scripts/guard.mjs";
import { applyFields, readFields } from "../scripts/daemon/forms.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("an agent's turn crosses with how long it holds, bounded, both ways", () => {
  assert.equal(turnLeft(-5), 0);
  assert.equal(turnLeft("abc"), 0);
  assert.equal(turnLeft(1e12), TURN_MAX_MS);
  assert.equal(turnLeft(1234.4), 1234);
  const ids = new Set(["0000000a"]);
  assert.deepEqual(readOps({ ops: [{ op: "agent", id: "0000000a", who: "Alice · Codex", color: "#112233", left: 90_000 }] }, ids).ops,
    [{ op: "agent", id: "0000000a", who: "Alice · Codex", color: "#112233", left: 90_000 }]);
  const tabs = [
    { id: "0000000a", url: "https://a.example/x", title: "A", agent: "Bob · Claude Code", color: "#112233", left: 30_000 },
    { id: "0000000b", url: "https://b.example/y", title: "B", agent: "Carol · Codex", left: 0 },
  ];
  const out = stateForJoiner({ tabs }, { drive: true }).tabs;
  assert.equal(out[0].left, 30_000, "a held turn says how long");
  assert.equal(out[1].left, undefined, "an agent only showing there holds nothing");
});

test("presence: typing and clicking pause agents in that tab, moving and scrolling never, here or there", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 3_000_000 });
  try {
    const presence = createPresence({ host: "Bob", readEvents: async () => [], pages: () => [], paused: () => true,
      onUsed() {}, onStale() {}, applyBar() {}, refreshTabs() {} });
    const page = {};
    presence.userDid([{ kind: "wheel", t: Date.now() }, { kind: "move", t: Date.now() }], page);
    assert.equal(presence.actingIn(page), null, "scrolling holds nobody up");
    assert.equal(presence.personIn(page), "Bob", "but they show in the tab");
    presence.userDid([{ kind: "click", t: Date.now(), what: "Gift wrap" }], page);
    assert.equal(presence.actingIn(page), "Bob", "a click pauses agents there");
    mock.timers.tick(2100);
    assert.equal(presence.actingIn(page), null, "until they've been idle a moment");
    presence.userDid([{ kind: "type", t: Date.now(), what: "Notes" }], page);
    assert.equal(presence.actingIn(page), "Bob", "typing too");
    assert.match(presence.userNote(page), /clicked "Gift wrap"[^\n]*typed in "Notes"[^\n]*\n[^\n]*Fields people filled: "Notes"/, "told what happened, names only");
    const there = {};
    presence.elsewhere(there, "Alice", ["scrolled"]);
    assert.equal(presence.actingIn(there), null, "scrolling in the other browser holds nobody up");
    presence.elsewhere(there, "Alice", ['clicked "Next"']);
    assert.equal(presence.actingIn(there), "Alice", "a click there does");
  } finally {
    mock.timers.reset();
  }
});

test("scroll presence: a view crosses as a known tab, a clamped position and height, nothing else", () => {
  const ids = new Set(["0000000a"]);
  assert.deepEqual(readView({ id: "0000000a", y: 1200, h: 800, under: "secret" }, ids), { id: "0000000a", x: 0, y: 1200, h: 800, v: 1 });
  assert.equal(readView({ id: "0000000b", y: 1, h: 1 }, ids), null, "an unknown tab");
  assert.equal(readView({ id: "0000000a", y: "x", h: 1 }, ids), null);
  assert.deepEqual(readView({ id: "0000000a", y: -4, h: 1e12, who: "Alice", color: "#abcdef" }, ids), { id: "0000000a", x: 0, y: 0, h: 1_000_000, v: 1, who: "Alice", color: "#abcdef" });
  assert.deepEqual(readPointers({ view: { id: "0000000a", y: 40, h: 600 } }, ids).view, { id: "0000000a", x: 0, y: 40, h: 600, v: 1 });
  assert.equal(readPointers({}, ids).view, null);
});

test("form sync: a card number replacing a plain value there leaves no stale value here, and nothing echoes back", () => {
  let t = 1_000_000;
  const sync = createFormSync({ now: () => t });
  const url = "https://shop.example/checkout";
  const plain = { f: "top", k: "#pay", t: "text", v: "" };
  sync.local("a", url, [plain]); // as the page loaded
  sync.remote("a", { url, fields: [{ ...plain, v: "abc" }] });
  sync.applied("a", sync.toApply("a", url));
  t += 5000;
  assert.deepEqual(sync.local("a", url, [{ ...plain, v: "abc" }]), [], "the applied value doesn't go back");
  sync.remote("a", { url, fields: [{ f: "top", k: "#pay", t: "text", m: 1, filled: true }] });
  const masked = sync.toApply("a", url);
  assert.deepEqual(masked, [{ f: "top", k: "#pay", t: "text", m: 1, filled: true, was: "abc" }], "the card shows as filled, replacing the value both had");
  sync.applied("a", masked);
  t += 5000;
  assert.deepEqual(sync.local("a", url, [{ ...plain, v: "" }]), [], "its stale value, cleared here, isn't sent back as an empty field");
  t += 5000;
  assert.deepEqual(sync.local("a", url, [{ ...plain, v: "typed here" }]).map((x) => x.v), ["typed here"], "a value typed here afterwards goes");
});

test("final actions by what they do: commits are asked for in any wording or language, steps and links aren't", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://pairbrowse.test/", (r) => r.fulfill({ contentType: "text/html", body: "<title>t</title>" }));
    await page.goto("http://pairbrowse.test/"); // relative addresses resolve against a web page
    await page.setContent(`
      <form id="checkout" method="post"><input autocomplete="cc-number" id="cc"><input id="note"><button id="order">Submit order</button><button type="button" id="apply">Apply coupon</button></form>
      <form id="ship" method="post"><input autocomplete="shipping street-address"><input type="submit" id="go" value="Continue"></form>
      <form id="luhn" method="post"><input value="4242 4242 4242 4242"><button id="done">Done</button></form>
      <form id="stripe" method="post"><iframe src="https://js.stripe.com/v3/elements"></iframe><button id="ok">OK</button></form>
      <form id="wizard" method="post"><input id="first"><input id="last"><button id="next">Next →</button></form>
      <form id="wizard-de" method="post"><input><input><button id="weiter">Weiter</button></form>
      <form id="wizard-ja" method="post"><input><input><button id="tsugi">次へ</button></form>
      <form id="signup" method="post"><input id="email"><input id="name"><input type="password" autocomplete="new-password"><button id="join">Create account</button></form>
      <form id="scripted"><input id="title"><input id="body"><button id="save">Save</button></form>
      <form id="signin" method="post"><input id="user"><input type="password" id="pw"><button id="in">Sign in</button></form>
      <form id="find" method="get" action="/search"><input id="q"><button id="s">Search</button></form>
      <form id="find2" method="post"><input type="search" id="q2"><button id="s2">Go</button></form>
      <form id="del" method="post" action="/account/delete"><button id="bye">Goodbye</button></form>
      <a id="link" href="/products">Products</a> <a id="dellink" href="/posts/7/delete">Trash</a> <a id="pay" href="https://www.paypal.com/checkoutnow">PayPal</a>
      <button id="tab" role="tab">Details</button> <button id="more" aria-expanded="false">More</button> <button id="cart">Add to cart</button>
      <button id="erase" style="background:#d92d20;color:#fff">🗑</button>
      <div role="alertdialog" id="dlg"><p>This can't be undone.</p><button id="yes" style="background:#d92d20;color:#fff">Yes</button><button id="no">Cancel</button><button id="sure">OK</button></div>
      <div role="dialog" id="pop"><p>Choose</p><button id="pick">Confirm</button></div>`);
    const at = async (sel, kind = "click", prev = "") => page.locator(sel).evaluate((el, [k, p, src]) => new Function(`return (${src})`)()(el, k, p), [kind, prev, clickRisk.toString()]);
    const is = async (sel, level, word, kind, prev) => { const r = await at(sel, kind, prev); assert.deepEqual([r.level, r.word], [level, word], `${sel} ${kind || ""}: ${JSON.stringify(r)}`); };
    await is("#order", "strong", "pay");
    await is("#go", "strong", "pay");
    await is("#done", "strong", "pay");
    await is("#ok", "strong", "pay");
    await is("#note", "strong", "pay", "enter");
    await is("#note", "safe", "", "space");
    await is("#apply", "safe", "");
    await is("#next", "safe", "");
    await is("#weiter", "safe", "");
    await is("#tsugi", "safe", "");
    await is("#first", "safe", "", "enter");
    await is("#join", "commit", "submit");
    await is("#save", "commit", "submit");
    await is("#title", "commit", "submit", "enter");
    await is("#in", "safe", "");
    await is("#s", "safe", "");
    await is("#s2", "safe", "");
    await is("#bye", "strong", "delete");
    await is("#link", "safe", "");
    await is("#dellink", "commit", "delete");
    await is("#pay", "commit", "pay");
    await is("#tab", "safe", "");
    await is("#more", "safe", "");
    await is("#cart", "safe", "");
    await is("#erase", "commit", "delete");
    await is("#yes", "strong", "delete");
    await is("#no", "safe", "");
    await is("#sure", "commit", "delete");
    await is("#pick", "safe", "");
    await is("#pick", "strong", "delete", "click", "delete");
  } finally {
    await browser.close();
  }
});

test("the word list: the fast path, with the gaps filled and other languages, routine phrases left alone", () => {
  for (const label of ["Submit order", "Erase all data", "Remove member", "Reset store", "Send", "Post", "Confirm", "Jetzt kaufen", "Löschen", "Supprimer", "Eliminar", "Acquista", "Verwijderen", "削除", "删除", "提交"]) assert.ok(finalAction(label, { confirm: [], neverConfirm: [] }), label);
  for (const label of ["Next", "Continue", "Order history", "Reset filters", "Post code", "Send code", "Confirm email", "Weiter", "Products"]) assert.equal(finalAction(label, { confirm: [], neverConfirm: [] }), null, label);
  assert.equal(finalAction("Submit form", { confirm: [], neverConfirm: ["submit"] }), null, "neverConfirm turns one down");
  assert.equal(finalKind("löschen"), "delete");
  assert.equal(finalKind("kaufen"), "pay");
  assert.equal(finalKind("submit"), "");
});

test("form values in the page: a card replacing a plain value clears it here; a card typed here is never overwritten", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("https://shop.example/pay", (r) => r.fulfill({ contentType: "text/html", body: `<label>Pay with <input id="pay"></label><label>Other <input id="other"></label><label>Notes <input id="notes"></label>` }));
    await page.goto("https://shop.example/pay");
    const value = (id) => page.locator(`#${id}`).inputValue();
    await applyFields(page, [{ f: "top", k: "#pay", t: "text", v: "abc" }], "Bob");
    assert.equal(await value("pay"), "abc");
    await applyFields(page, [{ f: "top", k: "#pay", t: "text", m: 1, filled: true }], "Bob");
    assert.equal(await value("pay"), "", "the stale value went");
    assert.match(await page.locator("#pay").getAttribute("placeholder"), /filled by Bob/, "and it says it's filled there");
    await page.fill("#other", "4111111111111111");
    await applyFields(page, [{ f: "top", k: "#other", t: "text", v: "older" }], "Bob");
    assert.equal(await value("other"), "4111111111111111", "a card typed here stays");
    await page.fill("#pay", "mine");
    await applyFields(page, [{ f: "top", k: "#pay", t: "text", m: 1, filled: true }], "Bob");
    assert.equal(await value("pay"), "mine", "a value typed here, never shared, is never cleared");
    await page.fill("#notes", "shared");
    await applyFields(page, [{ f: "top", k: "#notes", t: "text", m: 1, filled: true, was: "shared" }], "Bob");
    assert.equal(await value("notes"), "", "a value both sides had, replaced there by a card, is cleared");
    const read = await readFields(page);
    assert.ok(read.fields.some((x) => x.k === "#pay" && x.v === "mine"));
  } finally {
    await browser.close();
  }
});

test("scroll presence in the page: the person's own scrolling is their view, an agent's isn't; another's view draws as a named mark", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("playwright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.addInitScript({ content: source });
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: `<div style="height:6000px">long</div>` }));
    await page.goto("http://pairbrowse.test/");
    const tick = () => page.evaluate(() => window.__pbtest("tok", "", "tick"));
    assert.equal((await tick()).view, null, "nothing before they read");
    await page.mouse.move(100, 100);
    await page.mouse.wheel(0, 1200);
    await page.waitForFunction(() => scrollY >= 1200);
    await page.waitForTimeout(100);
    const v = (await tick()).view;
    assert.ok(v && v.y >= 1196 && v.h === 600, JSON.stringify(v));
    // An agent's action scrolls the page (a button brought into view): not the person's view.
    await page.waitForTimeout(1600);
    await page.evaluate(() => { window.__pbtest("tok", JSON.stringify({ x: 5, y: 5, act: "click" }), "cursor"); scrollTo(0, 4000); });
    await page.waitForTimeout(100);
    assert.equal((await tick()).view.y, v.y, "the agent's scrolling isn't theirs");
    await page.evaluate(() => window.__pbtest("tok", JSON.stringify([{ k: "a:view", v: 1, who: "Alice", color: "#38bdf8", x: 0, y: 3000, h: 600 }]), "cursors"));
    await page.waitForTimeout(200);
    // The right edge, about halfway down (3000 of 6000 px): the mark shows there, then goes.
    const edge = () => page.screenshot({ clip: { x: 780, y: 250, width: 20, height: 120 } });
    const withMark = await edge();
    await page.evaluate(() => window.__pbtest("tok", "[]", "cursors"));
    await page.waitForTimeout(100);
    assert.ok(!withMark.equals(await edge()), "a mark was drawn at the right edge");
  } finally {
    await browser.close();
  }
});
