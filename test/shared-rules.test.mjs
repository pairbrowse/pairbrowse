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
import { clickRisk, clickContext, buttonLabel } from "../scripts/daemon/page.mjs";
import { readFileSync, existsSync } from "node:fs";
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

test("final actions by what they do, by structure only: commits are asked for in any wording or language, steps and links aren't", { skip: !runtime, timeout: 60_000 }, async () => {
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
      <form id="sepa" method="post"><input value="DE89 3704 0044 0532 0130 00"><button id="sepa-ok">OK</button></form>
      <form id="stripe" method="post"><iframe allow="payment *" srcdoc="<p>card</p>"></iframe><button id="ok">OK</button></form>
      <form id="wizard" method="post"><ol><li aria-current="step">1</li><li>2</li><li>3</li></ol><input id="first"><input id="last"><button id="next">→</button></form>
      <form id="wizard-last" method="post"><ol><li>1</li><li>2</li><li aria-current="step">3</li></ol><input><input><button id="finish">→</button></form>
      <form id="wizard-bar" method="post"><progress value="1" max="4"></progress><input><input><button id="weiter">Weiter</button></form>
      <form id="wizard-sets" method="post"><fieldset><input></fieldset><fieldset hidden><input></fieldset><button id="tsugi">次へ</button></form>
      <form id="plain" method="post"><input><input><button id="nextish">Next</button></form>
      <form id="signup" method="post"><input id="email"><input id="name"><input type="password" autocomplete="new-password"><button id="join">Create account</button></form>
      <form id="scripted"><input id="title"><input id="body"><button id="save">Save</button></form>
      <form id="signin" method="post"><input id="user"><input type="password" id="pw"><button id="in">Sign in</button></form>
      <form id="find" method="get" action="/search"><input id="q"><button id="s">Search</button></form>
      <form id="find2" method="post"><input type="search" id="q2"><button id="s2">Go</button></form>
      <form id="del" method="post" action="/x"><input type="hidden" name="_method" value="delete"><button id="bye">Goodbye</button></form>
      <a id="link" href="/products">Products</a> <a id="dellink" href="/posts/7/delete">Trash</a> <a id="pay" href="https://www.paypal.com/checkoutnow">PayPal</a>
      <a id="rails" href="/posts/7" data-method="delete">Trash</a> <button id="hx" hx-post="/like">♥</button>
      <button id="tab" role="tab">Details</button> <button id="more" aria-expanded="false">More</button> <button id="cart">Add to cart</button>
      <button id="erase" style="background:#d92d20;color:#fff">🗑</button>
      <div role="alertdialog" id="dlg"><p>?</p><button id="yes" style="background:#d92d20;color:#fff">Yes</button><button id="no">Cancel</button><button id="sure">OK</button></div>
      <div role="alertdialog" id="dlg2"><p>?</p><button id="a1">A</button><button id="a2">B</button></div>
      <div role="dialog" id="pop"><p>Choose</p><button id="pick">Confirm</button></div>
      <div role="dialog" id="cookies"><p>Cookies</p><button id="c1" style="background:#1a73e8;color:#fff">Accept all</button><button id="c2">Reject</button></div>`);
    const at = async (sel, kind = "click", prev = "", hints = {}) => page.locator(sel).evaluate((el, [k, p, h, src]) => new Function(`return (${src})`)()(el, k, p, h), [kind, prev, hints, clickRisk.toString()]);
    const is = async (sel, level, word, kind, prev, hints) => { const r = await at(sel, kind, prev, hints); assert.deepEqual([r.level, r.word], [level, word], `${sel} ${kind || ""}: ${JSON.stringify(r)}`); };
    // A card form submit asks as a payment, whatever its button says.
    await is("#order", "strong", "pay");
    await is("#go", "strong", "pay");
    await is("#done", "strong", "pay");
    await is("#sepa-ok", "strong", "pay");
    await is("#ok", "strong", "pay");
    await is("#note", "strong", "pay", "enter");
    await is("#join", "strong", "pay", "click", "", { payFrame: true });
    await is("#note", "safe", "", "space");
    await is("#apply", "safe", "");
    // Multi-step forms by their markup: a step in the middle goes, the last step and unmarked forms ask.
    await is("#next", "safe", "");
    assert.equal((await at("#next")).unclear, undefined, "a marked step is clear: it goes");
    await is("#finish", "commit", "submit");
    await is("#weiter", "safe", "");
    await is("#tsugi", "safe", "");
    await is("#nextish", "commit", "submit");
    await is("#first", "safe", "", "enter");
    await is("#join", "commit", "submit");
    await is("#save", "commit", "submit");
    await is("#title", "commit", "submit", "enter");
    // A search form and a sign-in commit nothing.
    await is("#in", "safe", "");
    await is("#s", "safe", "");
    await is("#s2", "safe", "");
    await is("#bye", "strong", "delete");
    // Links only go somewhere, whatever their address says; an HTTP method on one is a commit.
    await is("#link", "safe", "");
    await is("#dellink", "safe", "");
    await is("#pay", "safe", "");
    await is("#rails", "commit", "delete");
    await is("#hx", "commit", "submit");
    await is("#tab", "safe", "");
    await is("#more", "safe", "");
    await is("#cart", "safe", "");
    assert.equal((await at("#cart")).unclear, true);
    // A danger button and a confirmation dialog: the plain button beside a filled one dismisses it.
    await is("#erase", "commit", "delete");
    await is("#yes", "strong", "delete");
    await is("#no", "safe", "");
    await is("#sure", "safe", "");
    await is("#a1", "commit", "submit");
    await is("#pick", "safe", "");
    await is("#pick", "strong", "delete", "click", "delete");
    // The shared context: page, form (names and kinds, never values), what the control does.
    await page.fill("#first", "Ada");
    const ctx = await page.locator("#next").evaluate((el, src) => new Function("el", `${src.join("\n")}\nreturn clickContext(el)`)(el), [clickContext.toString(), clickRisk.toString(), buttonLabel.toString()]);
    assert.equal(ctx.form.step, "middle");
    assert.equal(ctx.control.does, "submits a form");
    assert.equal(ctx.form.fields.length, 2);
    assert.equal(JSON.stringify(ctx).includes("Ada"), false, "no field values");
    // A dialog that isn't a confirmation (a cookie banner) asks nothing.
    await is("#c1", "safe", "");
    await is("#c2", "safe", "");
  } finally {
    await browser.close();
  }
});

test("no word lists: the click guard's code holds no wording to match in any language", () => {
  // Structure decides (fields, roles, styles, markup); a list of button or dialog words, in any
  // language, must not come back. Class names ("pay", "delete", "submit", "publish") and HTTP
  // methods are PairBrowse's own protocol, not page wording.
  const files = ["scripts/guard.mjs", "scripts/policy.mjs", "scripts/daemon/serve.mjs", "scripts/runner.mjs", "scripts/daemon/page.mjs", "scripts/daemon/screenshot.mjs", "scripts/upload.mjs"];
  const words = ["checkout", "purchase", "kaufen", "bestellen", "löschen", "supprimer", "eliminar", "verwijderen", "削除", "删除", "提交", "确认", "weiter", "suivant", "siguiente", "次へ", "are you sure", "can't be undone", "cancel subscription", "place order", "send message", "submit for review", "go live", "veröffentlichen", "close account", "confirm payment"];
  const root = new URL("..", import.meta.url).pathname;
  for (const f of files) {
    const code = readFileSync(join(root, f), "utf8").split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n").toLowerCase();
    for (const w of words) assert.ok(!code.includes(w), `${f} matches page wording: "${w}"`);
  }
});

test("the agent judges unclear clicks; strong signals stay the user's, whatever the agent says", async () => {
  const { clickRule, dialogRule, describeContext, strongSignal } = await import("../scripts/clickrule.mjs");
  const { UNREADABLE } = await import("../scripts/runner.mjs");
  const pay = { level: "strong", word: "pay", why: ["card fields"] };
  const del = { level: "commit", word: "delete", why: ["a DELETE request"] };
  const submit = { level: "commit", word: "submit", why: ["it submits a form"] };
  const script = { level: "safe", word: "", why: [], unclear: true };
  // A strong signal plus "Safe:" (or the wrong class) is still refused until named; named, the hook asks.
  for (const label of ["Safe: Continue", "Continue", "Submit: Continue", "Send: Continue"]) assert.equal(clickRule(pay, label, { seen: true }), "name", label);
  assert.equal(clickRule(pay, "Pay: Continue"), "go");
  assert.equal(clickRule(del, "Safe: Remove", { seen: true }), "name", "a DELETE method or danger styling can't be called safe");
  assert.equal(clickRule(UNREADABLE, "Safe: x", { seen: true }), "name", "unreadable counts as a final action");
  assert.equal(strongSignal({ level: "strong", word: "submit" }), true);
  // Unclear: refused once with its context, then "Safe:" goes; a class goes on to the hook.
  assert.equal(clickRule(script, "Remove"), "judge");
  assert.equal(clickRule(script, "Remove", { seen: true }), "go", "shown once");
  assert.equal(clickRule(script, "Safe: Load more"), "go", "structure and agent agree");
  assert.equal(clickRule(script, "Pay: Buy"), "go");
  assert.equal(clickRule(submit, "Save"), "judge");
  assert.equal(clickRule(submit, "Safe: Save"), "judge", "a form submit is judged from its context first");
  assert.equal(clickRule(submit, "Safe: Save", { seen: true }), "go");
  assert.equal(clickRule(submit, "Save", { seen: true }), "judge", "a commit by structure still needs a name");
  assert.equal(clickRule(submit, "Submit: Save"), "go");
  assert.equal(clickRule(submit, "Save", { lifted: true }), "go", "neverConfirm origins");
  assert.equal(clickRule({ level: "safe", word: "", why: [] }, "Next"), "go", "plain safe clicks never stop");
  // Page dialogs: after a delete or payment, OK is that final action; otherwise the agent judges it.
  assert.equal(dialogRule(true, "delete", "Safe: OK", { seen: true }), "name");
  assert.equal(dialogRule(true, "delete", "Delete: OK"), "go");
  assert.equal(dialogRule(true, "pay", "Submit: OK"), "name");
  assert.equal(dialogRule(true, "", "OK"), "judge");
  assert.equal(dialogRule(true, "", "Safe: OK"), "judge", "shown its text first");
  assert.equal(dialogRule(true, "", "Safe: OK", { seen: true }), "go");
  assert.equal(dialogRule(true, "", "Send: OK"), "go");
  assert.equal(dialogRule(false, "delete", ""), "go", "dismissing is always fine");
  // The context the agent reads: names and kinds, never values.
  const text = describeContext({ task: "Status: tidy the team", page: { title: "Team", origin: "https://app.example", headings: ["Members"] },
    control: { label: "Remove", does: "runs the page's scripts" }, form: { method: "post", step: "", fields: [{ name: "Email", type: "email", autocomplete: "email" }] }, prev: "", value: "secret-value" });
  assert.match(text, /tidy the team.*"Team" at https:\/\/app\.example.*"Remove" runs the page's scripts.*method post, fields Email \(email, email\)/);
  assert.equal(text.includes("secret-value"), false);
});

test("nothing about a click leaves the computer: no model, API key or network in the judging", () => {
  const root = new URL("..", import.meta.url).pathname;
  for (const f of ["scripts/clickrule.mjs", "scripts/guard.mjs", "scripts/daemon/serve.mjs", "scripts/daemon/page.mjs", "scripts/runner.mjs", "scripts/paths.mjs"]) {
    const code = readFileSync(join(root, f), "utf8");
    assert.doesNotMatch(code, /from "node:(https?|net|tls|http2|dgram)"|\bfetch\(|api\.anthropic|clickjudge|clickJudge|API_KEY/, f);
  }
  assert.equal(existsSync(join(root, "scripts/clickjudge.mjs")), false);
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
