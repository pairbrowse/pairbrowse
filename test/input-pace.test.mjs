// The adaptive input pace (server-mode spec, step 51): fast wherever nothing scores the input, an
// everyday person's rhythm on a page with a verification or scoring widget (read from its frames,
// scripts or container, a late one too) and in a sign-in, sign-up or payment form; and the two
// sets of humanized moves one page swaps between without the pointer jumping.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decidePace, formKind, inputPaceOf, paceFor, paceLine, paceWords } from "../scripts/native/pace.mjs";
import { installPacedHumanize, motionPace, useMotion } from "../scripts/native/paced-motion.mjs";
import { paceSets } from "../scripts/native-engine.mjs";

test("inputPace is adaptive unless config says fast or human", () => {
  assert.equal(inputPaceOf({}), "adaptive");
  assert.equal(inputPaceOf(undefined), "adaptive");
  assert.equal(inputPaceOf({ pairbrowse: { inputPace: "fast" } }), "fast");
  assert.equal(inputPaceOf({ pairbrowse: { inputPace: "human" } }), "human");
  assert.equal(inputPaceOf({ pairbrowse: { inputPace: "slow" } }), "adaptive");
});

test("the decision: a widget or a sensitive form asks for the everyday pace, nothing else does; fast and human are fixed", () => {
  assert.deepEqual(decidePace("adaptive", {}), { pace: "fast", why: "" });
  assert.deepEqual(decidePace("adaptive", { widget: true }), { pace: "human", why: "widget" });
  assert.deepEqual(decidePace("adaptive", { form: "sign-in" }), { pace: "human", why: "sign-in" });
  assert.deepEqual(decidePace("adaptive", { widget: true, form: "payment" }), { pace: "human", why: "widget" });
  assert.deepEqual(decidePace("fast", { widget: true, form: "sign-in" }), { pace: "fast", why: "inputPace" });
  assert.deepEqual(decidePace("human", {}), { pace: "human", why: "inputPace" });
});

// Hints as the page scan reads each field: type, autocomplete, inputmode, name, id, aria-label, label, placeholder.
test("a form's kind comes from its fields' structure: password, new password, card, one-time code, user name", () => {
  assert.equal(formKind(["email username email  email   Email "]), "sign-in", "a user name field");
  assert.equal(formKind(["email email  email   Email ", "password current-password  password   Password "]), "sign-in");
  assert.equal(formKind(["email email  email   ", "password new-password  pw   Choose a password "]), "sign-up");
  assert.equal(formKind(["password   pw   Password ", "password   pw2   Repeat password "]), "sign-up", "two password fields");
  assert.equal(formKind(["text cc-number numeric cardnumber  Card number  "]), "payment");
  assert.equal(formKind(["text  numeric num   Card number  "]), "payment", "a card field named so, without a token");
  assert.equal(formKind(["text one-time-code numeric code   Code  maxlength6"]), "one-time code");
  assert.equal(formKind(["text  numeric otp-1     maxlength1"]), "one-time code");
  assert.equal(formKind(["text  numeric iban   IBAN  "]), "sensitive");
  assert.equal(formKind(["search  search q  Search  Search the site"]), "", "a search box");
  assert.equal(formKind(["text  text first   First name  ", "text  text last   Last name  ", "textarea   notes   Notes  "]), "", "a contact form");
  assert.equal(formKind(["text  text promo   Promo code  "]), "", "a promo code");
  assert.equal(formKind([]), "");
  assert.equal(formKind(null), "");
});

test("the pace in a few words, and one line for a form's fields", () => {
  assert.equal(paceWords({ pace: "fast", why: "" }), "fast");
  assert.equal(paceWords({ pace: "fast", why: "inputPace" }), "fast (inputPace)");
  assert.equal(paceWords({ pace: "human", why: "widget" }), "everyday (verification widget on the page)");
  assert.equal(paceWords({ pace: "human", why: "sign-in" }), "everyday (sign-in form)");
  const fast = { pace: "fast", why: "" }, signIn = { pace: "human", why: "sign-in" };
  assert.equal(paceLine([{ label: "Search", decision: fast }]), "Pace: fast.");
  assert.equal(paceLine([{ label: "Email", decision: signIn }, { label: "Password", decision: signIn }]), "Pace: everyday (sign-in form).");
  assert.equal(paceLine([{ label: "Name", decision: fast }, { label: "Email", decision: signIn }, { label: "Password", decision: signIn }]), "Pace: everyday for Email, Password (sign-in form); fast for the rest.");
  assert.equal(paceLine([]), "");
  // Every field everyday, for different reasons: no "fast for the rest" (none went fast).
  const payment = { pace: "human", why: "payment" };
  assert.equal(paceLine([{ label: "Email", decision: { pace: "human", why: "sign-up" } }, { label: "Card number", decision: payment }]), "Pace: everyday for Email (sign-up form); everyday for Card number (payment form).");
  // Moves that couldn't take the decided pace are said so.
  assert.equal(paceLine([{ label: "browser_click", decision: signIn, moves: "fast" }]), "Pace: everyday (sign-in form); moves stayed fast.");
  assert.equal(paceLine([{ label: "browser_click", decision: signIn, moves: "human" }]), "Pace: everyday (sign-in form).");
  assert.equal(paceLine([{ label: "Name", decision: fast, moves: "fast" }, { label: "Card number", decision: payment, moves: "fast" }]), "Pace: everyday for Card number (payment form; moves stayed fast); fast for the rest.");
  assert.equal(paceLine([{ label: "Email", decision: signIn, moves: "fast" }, { label: "Password", decision: signIn }]), "Pace: everyday for Email (sign-in form; moves stayed fast); everyday for Password (sign-in form).");
});

// A page as the driver shows it: its frames' addresses and its main frame's address; a field whose
// in-page scan answers what the page holds around it.
function fakePage(url, frames = []) {
  const page = { url: () => url, frames: () => [{ url: () => url }, ...frames.map((u) => ({ url: () => u }))], mainFrame: () => ({ url: () => url }) };
  return {
    page,
    go(next) { url = next; frames = []; },
    load(frame) { frames.push(frame); },
    drop() { frames = []; },
  };
}
const field = (answer) => ({ evaluate: async (fn, arg) => { assert.equal(typeof fn, "function"); assert.ok(arg.source && arg.boxes, "the widget's makers and containers go into the page"); return answer; } });

test("a page without a widget and a plain field go fast; a widget's frame, invisible ones too, or one the scan finds goes at the everyday pace", async () => {
  const plain = fakePage("https://shop.test/search");
  assert.deepEqual(await paceFor(plain.page, field({ widget: false, hints: ["search  search q  Search  "] })), { pace: "fast", why: "" });
  assert.deepEqual(await paceFor(plain.page, null), { pace: "fast", why: "" }, "no element: the page alone");
  // Score-based reCAPTCHA's invisible anchor frame, and non-interactive Turnstile's.
  for (const frame of ["https://www.google.com/recaptcha/api2/anchor?ar=1&k=key&size=invisible", "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc/0x4AAA/auto/fbE/new/normal/auto/"]) {
    const scored = fakePage("https://shop.test/checkout", [frame]);
    assert.deepEqual(await paceFor(scored.page, null), { pace: "human", why: "widget" }, frame);
  }
  // A widget's script or container in the field's document (no frame yet).
  assert.deepEqual(await paceFor(fakePage("https://news.test/").page, field({ widget: true, hints: ["text  text q    "] })), { pace: "human", why: "widget" });
  // A page that doesn't answer: nothing found there.
  const silent = { evaluate: () => new Promise(() => {}) };
  const t = Date.now();
  assert.deepEqual(await paceFor(fakePage("https://slow.test/").page, silent), { pace: "fast", why: "" });
  assert.ok(Date.now() - t < 2500, "the scan is bounded");
});

test("a field in a sign-in, sign-up or payment form goes at the everyday pace; the same page's search box doesn't", async () => {
  const site = fakePage("https://mail.test/login");
  assert.deepEqual(await paceFor(site.page, field({ widget: false, hints: ["email username email  email   Email ", "password current-password  password   Password "] })), { pace: "human", why: "sign-in" });
  assert.deepEqual(await paceFor(site.page, field({ widget: false, hints: ["password new-password  pw   Password "] })), { pace: "human", why: "sign-up" });
  assert.deepEqual(await paceFor(site.page, field({ widget: false, hints: ["text cc-number numeric cardnumber  Card number  "] })), { pace: "human", why: "payment" });
  assert.deepEqual(await paceFor(site.page, field({ widget: false, hints: ["search  search q  Search  "] })), { pace: "fast", why: "" });
});

test("a widget that loads later switches the page from then on, also once its frame is gone, until the page goes elsewhere", async () => {
  const site = fakePage("https://forum.test/post");
  const box = field({ widget: false, hints: ["textarea   body   Message  "] });
  assert.equal((await paceFor(site.page, box)).pace, "fast", "before the widget");
  site.load("https://www.google.com/recaptcha/api2/anchor?k=key&size=invisible");
  assert.deepEqual(await paceFor(site.page, box), { pace: "human", why: "widget" }, "as soon as it is there");
  site.drop();
  assert.equal((await paceFor(site.page, box)).pace, "human", "it scored what came before; it stays for this page");
  site.go("https://forum.test/thread/2");
  assert.equal((await paceFor(site.page, box)).pace, "fast", "another page");
});

test("inputPace fast and human never read the page", async () => {
  const site = fakePage("https://shop.test/", ["https://www.google.com/recaptcha/api2/anchor?k=k&size=invisible"]);
  const untouched = { evaluate: async () => { throw new Error("read"); } };
  assert.deepEqual(await paceFor(site.page, untouched, "fast"), { pace: "fast", why: "inputPace" });
  assert.deepEqual(await paceFor(fakePage("https://x.test/").page, untouched, "human"), { pace: "human", why: "inputPace" });
});

// The pack's humanized input as it takes a page over (its context hook, synchronously): its own
// methods on the page, mouse and keyboard; each move a path from where it believes the pointer is,
// through the middle, to the point, by the mouse.move it found when it took the page over.
function fakePack() {
  const install = (scope, options) => {
    scope.on("page", (page) => {
      if (page.__pairbrowseHumanized) return;
      page.__pairbrowseHumanized = true;
      const at = { x: 300 + (options.motion === "combined" ? 7 : 0), y: 200 }; // its own start, unplaced
      const f = page.mouse.move.bind(page.mouse);
      page.mouse.move = async (x, y) => { await f((at.x + x) / 2, (at.y + y) / 2); await f(x, y); at.x = x; at.y = y; };
      page.mouse.click = async () => { page.clicks.push(options.motion); };
      page.keyboard.type = async () => { page.typed.push(options.typingPace); };
      page.click = async () => { page.clicks.push(options.motion); };
      page._pairbrowsePersona = { seed: options.seed };
      page._pairbrowseHumanized = true;
    });
  };
  return install;
}
class Mouse { constructor(page) { this.page = page; } async move(x, y) { this.page.moves.push([x, y]); } async click() {} }
class Keyboard { async type() {} }
function fakeContext() {
  const pages = [];
  const listeners = [];
  const newPage = () => {
    const page = { moves: [], clicks: [], typed: [], isClosed: () => false };
    page.mouse = new Mouse(page);
    page.keyboard = new Keyboard();
    pages.push(page);
    for (const l of listeners) l(page);
    return page;
  };
  return { context: { browser: () => ({}), addInitScript: async () => {}, on: (event, l) => { if (event === "page") listeners.push(l); }, pages: () => [...pages] }, newPage };
}

test("the adaptive pace has the pack take each page over twice; the fast set moves until the everyday one is asked for", async () => {
  const { context, newPage } = fakeContext();
  const lines = [];
  installPacedHumanize(context, fakePack(), { humanize: true, showCursor: false, seed: "s" }, paceSets({}), (l) => lines.push(l));
  const page = newPage();
  assert.equal(motionPace(page), "fast");
  assert.equal(page._pairbrowseHumanized, true);
  assert.equal(page.__pairbrowseHumanized, true);
  await page.click();
  await page.keyboard.type("x");
  assert.deepEqual(page.clicks, ["fast"]);
  assert.deepEqual(page.typed, [0.2], "the fast set types at typingPace");
  assert.equal(await useMotion(page, "human"), "human", "useMotion says the pace its moves go at now");
  assert.equal(motionPace(page), "human");
  await page.click();
  await page.keyboard.type("x");
  assert.deepEqual(page.clicks, ["fast", "combined"]);
  assert.deepEqual(page.typed, [0.2, 1], "the everyday set types as an everyday typist");
  await useMotion(page, "fast");
  await page.click();
  assert.deepEqual(page.clicks, ["fast", "combined", "fast"]);
  assert.deepEqual(lines, []);
});

test("a swap never jumps the pointer: the set taking over follows it first, its own moves reaching no page", async () => {
  const { context, newPage } = fakeContext();
  installPacedHumanize(context, fakePack(), { humanize: true, seed: "s" }, paceSets({}));
  const page = newPage();
  await page.mouse.move(100, 100); // the fast set: from its own start to (100, 100)
  assert.deepEqual(page.moves.at(-1), [100, 100]);
  const before = page.moves.length;
  await useMotion(page, "human");
  assert.equal(page.moves.length, before, "following the pointer moved nothing on the page");
  await page.mouse.move(200, 200);
  assert.deepEqual(page.moves.slice(before), [[150, 150], [200, 200]], "the everyday set's first path starts where the pointer was, not at its own start");
  // Back to fast a moment later: the fast set has followed meanwhile (or follows at the swap).
  await new Promise((r) => setTimeout(r, 250));
  await useMotion(page, "fast");
  const now = page.moves.length;
  await page.mouse.move(300, 100);
  assert.deepEqual(page.moves.slice(now), [[250, 150], [300, 100]]);
});

test("a swap that can't happen keeps the pace the page has, and says so", async () => {
  const { context, newPage } = fakeContext();
  installPacedHumanize(context, fakePack(), { humanize: true, seed: "s" }, paceSets({}));
  const page = newPage();
  page.isClosed = () => true;
  assert.equal(await useMotion(page, "human"), "fast");
  assert.equal(motionPace(page), "fast");
  assert.equal(await useMotion({ mouse: {}, keyboard: {} }, "human"), null, "a page with one set only");
});

test("fast, human, or humanize off: the pack takes the context once, as before", () => {
  for (const [inputPace, motion] of [["fast", "fast"], ["human", "combined"]]) {
    const calls = [];
    const { context } = fakeContext();
    installPacedHumanize(context, (scope, options) => calls.push({ scope, options }), { humanize: true, seed: "s" }, paceSets({ inputPace }));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].scope, context);
    assert.equal(calls[0].options.motion, motion);
  }
  const calls = [];
  const { context } = fakeContext();
  installPacedHumanize(context, (scope, options) => calls.push({ scope, options }), { humanize: false, seed: "s" }, paceSets({}));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, context);
});

test("a pack that takes no page hook keeps one pace, said once in the log", () => {
  const calls = [], lines = [];
  const { context } = fakeContext();
  installPacedHumanize(context, (scope, options) => calls.push({ scope, options }), { humanize: true, seed: "s" }, paceSets({}), (l) => lines.push(l));
  assert.equal(calls.length, 3, "two tries, then the context once");
  assert.equal(calls[2].scope, context);
  assert.equal(calls[2].options.motion, "fast");
  assert.match(lines.join("\n"), /one pace only/);
});
