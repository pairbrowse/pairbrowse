// The approval card page (ui/approve/, DESIGN.md B6): what it shows from the helper's stream, and
// that only a person's armed click answers. The data contract is approve.js's header; the two
// click items come from test/fixtures/ui-approve.json (its review copy is scripts/dev/look/approve.json,
// kept equal by test/ui.test.mjs). The common checks stay in test/ui.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { patchright } from "./live.mjs";
import { openPage, runtime } from "./helpers/ui-page.mjs";
import { startFakeHelper } from "./helpers/fake-helper.mjs";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/ui-approve.json", import.meta.url), "utf8"));
const [OLDER, NEWER] = FIXTURE.push.map(([, d]) => d.item);
const SETTLE = 1000; // the 160 ms open, the observer's 100 ms delay and the 600 ms arm
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const add = (helper, item) => helper.push("approval", { op: "add", item });
const bodies = (helper, route) => helper.posts.filter((p) => p.route === route).map((p) => p.body);
async function realClick(page, sel) {
  const box = await page.locator(sel).boundingBox();
  assert.ok(box, `${sel} is on screen`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
async function press(page, sel, key) { await page.focus(sel); await page.keyboard.press(key); }
const text = (ctx, id) => ctx.inPage((i) => document.getElementById(i).textContent, id);
const shown = (ctx, target) => ctx.until(`the card showing ${target}`, (t) => !document.getElementById("card").hidden && document.getElementById("target").textContent === t, target);
// A token's computed color, through a probe.
const token = (ctx, name) => ctx.inPage((n) => {
  const p = document.createElement("span");
  p.style.color = `var(--${n})`;
  document.body.append(p);
  const c = getComputedStyle(p).color;
  p.remove();
  return c;
}, name);

// pageTest's harness (helpers/ui-page.mjs) under a title of the test's own: opts { replies,
// reducedMotion }; fn gets openPage's context and the helper.
function named(title, opts, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  test(`approve page: ${title}`, { skip: !runtime, timeout: 60_000 }, async () => {
    const browser = await patchright(runtime).chromium.launch();
    let helper = null, ctx = null;
    try {
      helper = await startFakeHelper({ replies: opts.replies });
      ctx = await openPage(browser, "approve", { helper, reducedMotion: opts.reducedMotion });
      await fn({ ...ctx, helper });
    } finally {
      await ctx?.close();
      await helper?.close();
      await browser.close();
    }
  });
}

named("renders the oldest pending click and counts the rest", async (ctx) => {
  const { helper, inPage } = ctx;
  // The newer first: the order on screen is by `at`, not by arrival.
  add(helper, NEWER);
  add(helper, OLDER);
  await shown(ctx, "Place order");
  await sleep(300);
  assert.equal(await text(ctx, "who"), "Claude");
  assert.equal(await text(ctx, "verb"), "wants to click");
  assert.equal(await text(ctx, "where"), "In the tab on shop.example");
  assert.equal(await text(ctx, "reason"), "\"Place order\" pays: a final action (pay)");
  assert.equal(await text(ctx, "count"), "1 more");
  const m = await inPage(() => {
    const cs = (q) => getComputedStyle(document.querySelector(q));
    const av = document.querySelector("#avatar-slot .avatar");
    return {
      pending: document.body.dataset.pending, focus: document.activeElement.id,
      countLabel: document.getElementById("count").getAttribute("aria-label"),
      whoWeight: cs("#who").fontWeight, avRole: av.getAttribute("role"), avLabel: av.getAttribute("aria-label"), avBg: getComputedStyle(av).backgroundColor, avText: av.textContent,
      width: cs("#card").width, padding: cs("#card").paddingTop, radius: cs("#card").borderTopLeftRadius, border: `${cs("#card").borderTopWidth} ${cs("#card").borderTopStyle} ${cs("#card").borderTopColor}`,
      bg: cs("#card").backgroundColor, shadow: cs("#card").boxShadow,
      target: `${cs("#target").borderTopWidth} ${cs("#target").borderTopColor}`, reason: cs("#reason").color,
      allow: [cs("#allow").backgroundColor, cs("#allow").color], deny: [cs("#deny").backgroundColor, cs("#deny").borderTopWidth, cs("#deny").borderTopColor], more: cs("#more").color,
    };
  });
  const [edge, elevated, ink2, accent, bg] = await Promise.all(["edge", "elevated", "ink-2", "accent", "bg"].map((n) => token(ctx, n)));
  assert.deepEqual(m, {
    pending: "2", focus: "card", countLabel: "1 more waiting",
    whoWeight: "600", avRole: "img", avLabel: "Claude", avBg: "rgb(233, 118, 63)", avText: "C",
    width: "360px", padding: "16px", radius: "12px", border: `1px solid ${edge}`,
    bg: elevated, shadow: "rgba(0, 0, 0, 0.4) 0px 12px 32px 0px",
    target: `1px ${edge}`, reason: ink2,
    allow: [accent, bg], deny: [elevated, "1px", edge], more: ink2,
  });
  assert.deepEqual(helper.posts, []);
});

named("only a trusted pointer click answers, and only once armed", async (ctx) => {
  const { page, helper, inPage } = ctx;
  add(helper, OLDER);
  add(helper, NEWER);
  await shown(ctx, "Place order");
  await sleep(SETTLE);
  await inPage(() => {
    const allow = document.getElementById("allow");
    allow.click();
    allow.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  await sleep(300);
  assert.deepEqual(helper.posts, [], "a synthetic click posts nothing");
  assert.equal(await text(ctx, "hint"), "", "and says nothing");

  helper.posts.length = 0;
  // A fresh card: dismiss and bring the next one, then click at once.
  await realClick(page, "#dismiss");
  await shown(ctx, "Publish");
  await realClick(page, "#allow");
  await sleep(200);
  assert.deepEqual(helper.posts, [], "a click before the card is armed posts nothing");
  assert.equal(await text(ctx, "hint"), "Not yet: the card just appeared. Click again.");
  await sleep(SETTLE);
  await realClick(page, "#allow");
  await ctx.until("the approve post", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "approve"), [{ id: NEWER.id, answer: "allow" }]);
});

named("a covered card is not armed (IntersectionObserver v2)", async (ctx) => {
  const { page, helper, inPage } = ctx;
  add(helper, OLDER);
  await shown(ctx, "Place order");
  await sleep(SETTLE);
  // Something over the card that lets the click through: the browser no longer reports it fully visible.
  await inPage(() => {
    const veil = document.createElement("div");
    veil.id = "veil";
    Object.assign(veil.style, { position: "fixed", inset: "0", background: "rgb(0 0 0 / 0.01)", pointerEvents: "none" });
    document.body.append(veil);
  });
  await sleep(400);
  await realClick(page, "#allow");
  await sleep(200);
  assert.deepEqual(helper.posts, [], "a click through a cover posts nothing");
  assert.equal(await text(ctx, "hint"), "Something is over the card: answer in the terminal.");
  await inPage(() => document.getElementById("veil").remove());
  await sleep(SETTLE);
  await realClick(page, "#allow");
  await ctx.until("the post", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "approve"), [{ id: OLDER.id, answer: "allow" }]);
});

named("a real armed click answers and shows the next", async (ctx) => {
  const { page, helper } = ctx;
  add(helper, OLDER);
  add(helper, NEWER);
  await shown(ctx, "Place order");
  await sleep(SETTLE);
  await realClick(page, "#allow");
  await shown(ctx, "Publish");
  assert.deepEqual(bodies(helper, "approve"), [{ id: OLDER.id, answer: "allow" }]);
  assert.equal(await ctx.inPage(() => document.getElementById("count").hidden), true, "the chip goes");
  assert.equal(await text(ctx, "who"), "Alice · Codex");
});

named("Deny by Enter, Allow never by key, Escape nothing", async (ctx) => {
  const { page, helper } = ctx;
  add(helper, OLDER);
  await shown(ctx, "Place order");
  await sleep(SETTLE);
  await press(page, "#allow", "Enter");
  await press(page, "#allow", " ");
  await sleep(200);
  assert.deepEqual(helper.posts, []);
  assert.equal(await text(ctx, "hint"), "Allow with a click: a key press can't allow.");
  await ctx.inPage(() => document.getElementById("card").focus());
  await page.keyboard.press("Escape");
  await press(page, "#deny", "Escape");
  await realClick(page, "#more");
  await page.keyboard.press("Escape");
  await sleep(200);
  assert.deepEqual(helper.posts, [], "Escape answers nothing");
  assert.equal(await ctx.inPage(() => document.body.dataset.pending), "1", "and removes nothing");
  await press(page, "#deny", "Enter");
  await ctx.until("the deny post", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "approve"), [{ id: OLDER.id, answer: "deny" }]);
});

named("Tab order from the card", async (ctx) => {
  const { page, helper } = ctx;
  add(helper, OLDER);
  await shown(ctx, "Place order");
  assert.equal(await ctx.inPage(() => document.activeElement.id), "card", "the card itself has focus first");
  const ring = await token(ctx, "accent");
  const order = [];
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Tab");
    order.push(await ctx.inPage(() => { const s = getComputedStyle(document.activeElement); return `${document.activeElement.id} ${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`; }));
  }
  assert.deepEqual(order, ["dismiss", "allow", "deny", "more"].map((id) => `${id} solid 2px ${ring}`));
  assert.deepEqual(helper.posts, []);
});

named("More actions: site by a click, terminal by a key", async (ctx) => {
  const { page, helper, inPage } = ctx;
  add(helper, OLDER);
  add(helper, NEWER);
  await shown(ctx, "Place order");
  await sleep(SETTLE);
  await realClick(page, "#more");
  const opened = await inPage(() => ({
    expanded: document.getElementById("more").getAttribute("aria-expanded"), hidden: document.getElementById("menu").hidden,
    items: [...document.querySelectorAll("#menu button")].map((b) => [b.textContent, b.dataset.answer]), focus: document.activeElement.dataset.answer,
  }));
  assert.deepEqual(opened, { expanded: "true", hidden: false, items: [["Allow for this site", "site"], ["Ask in the terminal only", "terminal"]], focus: "site" });
  await page.keyboard.press("Enter");
  await sleep(200);
  assert.deepEqual(helper.posts, [], "a key press on site posts nothing");
  assert.equal(await text(ctx, "hint"), "Allow with a click: a key press can't allow.");
  await realClick(page, '#menu [data-answer="site"]');
  await shown(ctx, "Publish");
  assert.deepEqual(bodies(helper, "approve"), [{ id: OLDER.id, answer: "site" }]);

  await sleep(SETTLE);
  await realClick(page, "#more");
  await press(page, '#menu [data-answer="terminal"]', "Enter");
  await ctx.until("the terminal post", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "approve").at(-1), { id: NEWER.id, answer: "terminal" });

  add(helper, { ...OLDER, id: "ap-99999999" });
  await shown(ctx, "Place order");
  await realClick(page, "#more");
  assert.equal(await inPage(() => document.getElementById("menu").hidden), false);
  await page.keyboard.press("Shift+Tab"); // to More actions: still open
  assert.equal(await inPage(() => document.getElementById("menu").hidden), false);
  await page.keyboard.press("Shift+Tab"); // to Deny: focus left the menu
  assert.deepEqual(await inPage(() => [document.getElementById("menu").hidden, document.getElementById("more").getAttribute("aria-expanded")]), [true, "false"]);
});

named("nothing counts while an agent is driving", async (ctx) => {
  const { page, helper } = ctx;
  add(helper, OLDER);
  await shown(ctx, "Place order");
  await sleep(SETTLE);
  helper.push("driving", { on: true });
  await ctx.until("driving", () => document.body.dataset.driving === "true");
  await realClick(page, "#allow");
  await sleep(200);
  assert.deepEqual(helper.posts, []);
  assert.equal(await text(ctx, "hint"), "An agent is acting in the browser: wait, then click again.");
  helper.push("driving", { on: false });
  await ctx.until("not driving", () => document.body.dataset.driving === "false");
  await realClick(page, "#allow");
  await ctx.until("the post", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "approve"), [{ id: OLDER.id, answer: "allow" }]);
});

named("withdraw removes the card and × dismisses locally", async (ctx) => {
  const { page, helper, harness, inPage } = ctx;
  add(helper, OLDER);
  await shown(ctx, "Place order");
  assert.equal((await harness.live()).observers, 1);
  helper.push("approval", { op: "withdraw", item: { id: OLDER.id } });
  await ctx.until("the empty state", () => document.getElementById("card").hidden);
  assert.deepEqual(await inPage(() => [document.getElementById("empty").hidden, document.body.dataset.pending]), [false, "0"]);
  assert.equal((await harness.live()).observers, 0);

  add(helper, OLDER);
  add(helper, NEWER);
  await shown(ctx, "Place order");
  await realClick(page, "#dismiss");
  await shown(ctx, "Publish");
  helper.push("join", []);
  add(helper, NEWER);
  await sleep(300);
  assert.equal(await text(ctx, "target"), "Publish", "the dismissed item stays out");
  assert.equal(await inPage(() => document.body.dataset.pending), "1");
  assert.deepEqual(helper.posts, [], "× posts nothing");
});

named("the observer goes while hidden and re-arms when back", async (ctx) => {
  const { page, helper, harness } = ctx;
  add(helper, OLDER);
  await shown(ctx, "Place order");
  await sleep(SETTLE);
  await harness.setHidden(true);
  assert.equal((await harness.live()).observers, 0);
  const fires = await harness.hiddenFires();
  await sleep(500);
  assert.equal(await harness.hiddenFires(), fires);
  await harness.setHidden(false);
  assert.equal((await harness.live()).observers, 1);
  await realClick(page, "#allow");
  await sleep(200);
  assert.deepEqual(helper.posts, [], "re-armed: not at once");
  await sleep(SETTLE);
  await realClick(page, "#allow");
  await ctx.until("the post", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "approve"), [{ id: OLDER.id, answer: "allow" }]);
});

named("a gone request says so; a failed post re-enables", { replies: { approve: () => ({ status: 404, body: { ok: false } }) } }, async (ctx) => {
  const { page, helper, inPage } = ctx;
  add(helper, OLDER);
  add(helper, NEWER);
  await shown(ctx, "Place order");
  await sleep(SETTLE);
  await realClick(page, "#allow");
  await ctx.until("the gone hint", () => document.getElementById("hint").textContent === "That request is gone (answered, or it timed out).");
  assert.deepEqual(await inPage(() => ["allow", "deny", "more"].map((id) => document.getElementById(id).disabled)), [true, true, true]);
  helper.replies.approve = () => ({ status: 500 });
  await realClick(page, "#dismiss");
  await shown(ctx, "Publish");
  await sleep(SETTLE);
  await realClick(page, "#allow");
  await ctx.until("the failed hint", () => document.getElementById("hint").textContent === "Couldn't reach PairBrowse. Try again.");
  assert.deepEqual(await inPage(() => ["allow", "deny", "more"].map((id) => document.getElementById(id).disabled)), [false, false, false]);
  assert.equal(await inPage(() => document.body.dataset.pending), "1");
});

named("join, dev-share and host asks render in the same card and post to their own routes", async (ctx) => {
  const { page, helper, inPage } = ctx;
  const border = () => inPage(() => getComputedStyle(document.getElementById("card")).borderTopColor);
  const [accent, warn] = await Promise.all([token(ctx, "accent"), token(ctx, "warn")]);

  helper.push("join", [{ id: "j1", name: "Sam", app: "Claude Code", role: "drive" }, { id: "j0", name: "Old", state: "approved" }]);
  await shown(ctx, "Shared browser, can drive");
  assert.deepEqual([await text(ctx, "who"), await text(ctx, "verb")], ["Sam (Claude Code)", "wants to join"]);
  assert.equal(await border(), accent);
  assert.equal(await inPage(() => document.getElementById("more").hidden), true);
  assert.equal(await inPage(() => document.body.dataset.pending), "1", "a person already let in is no request");
  await sleep(SETTLE);
  await realClick(page, "#allow");
  await ctx.until("the join answer", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "approve"), [{ id: "j1", allow: true }]);

  helper.push("dev", { asks: [{ id: "d1", who: "Claude", port: 3000 }] });
  await shown(ctx, "localhost:3000");
  assert.equal(await text(ctx, "verb"), "wants to share a dev server");
  assert.equal(await border(), warn);
  await sleep(SETTLE);
  await realClick(page, "#deny");
  await ctx.until("the dev answer", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "dev"), [{ op: "answer", id: "d1", allow: false }]);

  helper.push("joinhost", { asks: [{ id: "h1", host: "relay.example", who: "Sam" }] });
  await shown(ctx, "relay.example");
  assert.equal(await border(), warn);
  assert.equal(await text(ctx, "allow"), "Allow once");
  assert.equal(await text(ctx, "deny"), "Cancel");
  assert.equal(await text(ctx, "reason"), "This code leads to relay.example, not a PairBrowse address. The code came from Sam. Only you can allow an address.");
  assert.equal(await inPage(() => document.getElementById("avatar-slot").hidden), true);
  await sleep(SETTLE);
  await realClick(page, "#more");
  await page.keyboard.press("Enter");
  await sleep(200);
  assert.deepEqual(bodies(helper, "joinhost"), [], "Always allow takes a click");
  await realClick(page, '#menu [data-answer="always"]');
  await ctx.until("the host answer", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "joinhost"), [{ op: "allow", id: "h1", always: true }]);

  helper.push("joinhost", { asks: [{ id: "h2", host: "relay.example" }] });
  await shown(ctx, "relay.example");
  await sleep(SETTLE);
  await press(page, "#deny", "Enter");
  await ctx.until("the cancel", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "joinhost").at(-1), { op: "cancel", id: "h2" });
});

named("reduced motion: the card appears without animation and still arms", { reducedMotion: "reduce" }, async (ctx) => {
  const { page, helper, harness } = ctx;
  add(helper, OLDER);
  await shown(ctx, "Place order");
  await sleep(100);
  assert.deepEqual(await harness.animations(), []);
  await sleep(SETTLE);
  await realClick(page, "#allow");
  await ctx.until("the post", () => document.body.dataset.pending === "0");
  assert.deepEqual(bodies(helper, "approve"), [{ id: OLDER.id, answer: "allow" }]);
});

test("approve page: the pending list loads from approvals.json on connect", { skip: !runtime, timeout: 60_000 }, async () => {
  const helper = await startFakeHelper({ fixtures: { approvals: { pending: [OLDER] } } });
  let browser = null, ctx = null;
  try {
    const r = await fetch(helper.base + "approvals.json");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { pending: [OLDER] });
    browser = await patchright(runtime).chromium.launch();
    ctx = await openPage(browser, "approve", { helper });
    await shown(ctx, "Place order");
    assert.equal(await ctx.inPage(() => document.body.dataset.pending), "1");
  } finally {
    await ctx?.close();
    await browser?.close();
    await helper.close();
  }
});
