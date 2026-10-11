// The session picker (ui/picker/) over the pages' harness: the 44 px rows with the people as a
// stack at the right end, More sessions and its search, start fresh, the join form and the
// address question (B6 card), a pick in the browser build (window.pairbrowse, no chrome.*), the
// refresh paused while hidden and run at once on return, the keyboard path, reduced motion, and
// framed as the strip's session switcher (scripts/dev/frame-proxy.mjs: the harness forbids
// framing), where the parent gets only a same-origin "picked" or "close" notice.
// The common checks (names, focus ring, nothing while hidden, CSP) stay in test/ui.test.mjs;
// test/picker.test.mjs keeps pinning the markup, the sheet's rules and the extension host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageTest, runtime } from "./helpers/ui-page.mjs";
import { startFakeHelper, merge } from "./helpers/fake-helper.mjs";
import { startUiServer } from "./helpers/ui-server.mjs";
import { defaultFixture } from "./helpers/pairbrowse-shim.mjs";
import { patchright, inPage } from "./live.mjs";
import { startFrameProxy } from "../scripts/dev/frame-proxy.mjs";

// The helper's picker data (as test/picker.test.mjs): five sessions, most recently used first.
const STATE = {
  picking: true,
  sessions: [
    { name: "work", tabs: 3, sites: ["shop.example", "docs.example"], current: true,
      live: [{ who: "Sam", app: "Claude Code", kind: "guest" }],
      people: [{ who: "You", kind: "you", computer: "Mac" }, { who: "Sam", app: "Claude Code", kind: "guest" }] },
    { name: "shop", tabs: 1, sites: ["shop.example"],
      people: [{ who: "You", kind: "you", computer: "Mac" }, { who: "Claude", app: "Claude Code", kind: "agent" }, { who: "Alice", computer: "Linux", kind: "guest" }] },
    { name: "default", tabs: 0, sites: [], people: [] },
    { name: "travel", tabs: 2, sites: ["trips.example"], people: [] },
    { name: "research", tabs: 5, sites: ["papers.example"], people: [] },
  ],
};
// Two rows both Last used and Live, the second with a long name: the tight case in both hosts.
const TIGHT = { picking: false, sessions: [
  { name: "research", tabs: 3, sites: ["papers.example"], current: true,
    live: [{ who: "Sam", app: "Claude Code", kind: "guest" }],
    people: [{ who: "You", kind: "you", computer: "Mac" }, { who: "Sam", app: "Claude Code", kind: "guest" }, { who: "Alice", computer: "Linux", kind: "guest" }] },
  { name: "quarterly-planning-session", tabs: 1, sites: ["docs.example"], current: true,
    live: [{ who: "Sam", app: "Claude Code", kind: "guest" }],
    people: [{ who: "You", kind: "you", computer: "Mac" }, { who: "Alice", computer: "Linux", kind: "guest" }, { who: "Bo", computer: "Mac", kind: "guest" }] },
] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const posted = (helper, route) => helper.posts.filter((p) => p.route === route).map((p) => p.body);
const bad = (log) => log.filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind));
const msg = () => ({ text: document.getElementById("msg").textContent, kind: document.getElementById("msg").dataset.kind });
const ready = () => document.body.dataset.s === "ready";

pageTest("picker", { fixtures: { sessions: STATE }, viewport: { width: 1200, height: 760 } }, async ({ page, until, inPage: run, harness }) => {
  await until("the rows", ready);
  const rows = await run(() => [...document.querySelectorAll("#sessions > li")].map((li) => {
    const button = li.querySelector(".choice"), text = li.querySelector("strong"), chips = li.querySelector(".chips");
    const a = li.querySelector(".choice > .avatar");
    return {
      name: li.querySelector(".name").textContent, height: button.getBoundingClientRect().height,
      badges: [...li.querySelectorAll("strong em")].map((e) => e.textContent),
      chips: [...li.querySelectorAll(".chip")].map((c) => c.title),
      right: chips ? chips.getBoundingClientRect().left >= text.getBoundingClientRect().right : null,
      words: [...li.querySelectorAll(".chip-text")].map((t) => { const r = t.getBoundingClientRect(); return r.width <= 1 && r.height <= 1; }),
      avatar: { role: a.getAttribute("role"), label: a.getAttribute("aria-label") },
      text: button.textContent,
    };
  }));
  assert.deepEqual(rows.map((r) => r.name), ["work", "shop", "Default"]);
  for (const r of rows) assert.equal(r.height, 44, `${r.name}: a 44 px row`);
  assert.deepEqual(rows[0].badges, ["Last used", "Live · 1 other"]);
  assert.equal(rows[0].chips.length, 2);
  assert.match(rows[0].chips[0], /in this session now$/);
  assert.equal(rows[0].right, true, "the people sit right of the name");
  assert.equal(rows[1].right, true);
  assert.equal(rows[2].right, null, "nobody used Default: no stack");
  assert.ok(rows[0].words.length && rows[0].words.every(Boolean), "the chips show initials, the words stay out of sight");
  assert.match(rows[0].text, /Sam · Claude Code/, "the names stay in the row's text");
  assert.deepEqual(rows[0].avatar, { role: "img", label: "Sam" });
  const snap = await page.locator("#sessions > li:first-child button").ariaSnapshot();
  assert.match(snap, /Sam · Claude Code/, "the names stay in the row's accessible name");
  const layout = await run(() => ({
    host: document.documentElement.dataset.host, main: document.querySelector("main").getBoundingClientRect().width,
    logo: document.querySelector(".logo").getBoundingClientRect().width,
    h1: [getComputedStyle(document.querySelector("h1")).fontSize, getComputedStyle(document.querySelector("h1")).fontWeight],
    secondary: [document.getElementById("fresh"), document.getElementById("join")].map((e) => e.getBoundingClientRect().height),
  }));
  assert.equal(layout.host, "page");
  assert.ok(layout.main <= 480, `the card is at most 480 px (${layout.main})`);
  assert.equal(layout.logo, 56);
  assert.deepEqual(layout.h1, ["20px", "600"]);
  assert.deepEqual(layout.secondary, [44, 44], "Start fresh and Join as 44 px secondary rows");
  assert.deepEqual(bad(await harness.log()), []);
  assert.equal((await harness.live()).intervals, 1, "the one refresh");
});

// The tight rows in the page host's 480 px card: both pills whole, in their words, beside the name.
pageTest("picker", { fixtures: { sessions: { ...TIGHT, picking: true } }, viewport: { width: 1200, height: 760 } }, async ({ until, inPage: run, harness }) => {
  await until("the rows", ready);
  const rows = await run(() => [...document.querySelectorAll("#sessions .choice")].map((b) => ({
    badges: [...b.querySelectorAll("strong em")].map((e) => e.textContent),
    pills: [...b.querySelectorAll("strong em")].every((e) => e.scrollWidth <= e.clientWidth),
    meta: b.querySelector("small").textContent,
  })));
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.deepEqual(r.badges, ["Last used", "Live · 1 other"]);
    assert.equal(r.pills, true, "no pill fragments");
    assert.doesNotMatch(r.meta, /^Last used/, "the page host keeps Last used as a pill");
  }
  assert.deepEqual(bad(await harness.log()), []);
});

pageTest("picker", { fixtures: { sessions: STATE } }, async ({ page, until, inPage: run }) => {
  await until("the rows", ready);
  await page.click("#more-btn");
  assert.deepEqual(await run(() => ({ expanded: document.getElementById("more-btn").getAttribute("aria-expanded"), label: document.getElementById("more-label").textContent,
    top: document.getElementById("sessions").hidden, focus: document.activeElement.id })), { expanded: "true", label: "Fewer sessions", top: true, focus: "filter" });
  await page.keyboard.type("sho");
  assert.deepEqual(await run(() => [...document.querySelectorAll("#more-list > li")].filter((li) => !li.hidden).map((li) => li.dataset.name)), ["shop"]);
  await page.keyboard.type("zz");
  assert.equal(await run(() => document.getElementById("none").hidden), false, "No session by that name.");
});

pageTest("picker", { fixtures: { sessions: STATE } }, async ({ page, helper, until, inPage: run }) => {
  await until("the rows", ready);
  await page.click("#fresh");
  await until("done", () => document.body.dataset.s === "done");
  assert.deepEqual(posted(helper, "pick"), [{ action: "new" }]);
  assert.deepEqual(await run(msg), { text: "Done.", kind: "ok" });
});

pageTest("picker", { fixtures: { sessions: STATE }, replies: { pick: { error: true, hostAsk: { id: "a1", host: "share.example" } } } }, async ({ page, helper, until, inPage: run }) => {
  await until("the rows", ready);
  await page.click("#join summary");
  await until("focus in the code field", () => document.activeElement?.id === "code");
  await page.keyboard.type("x");
  await page.keyboard.press("Enter");
  assert.deepEqual(await run(msg), { text: "A join code starts with pb-join:", kind: "error" });
  assert.deepEqual(posted(helper, "pick"), [], "nothing sent for a bad code");

  await page.fill("#code", "pb-join:https://share.example/abc");
  await page.click("#join-form .primary");
  await until("the address question", () => !document.getElementById("host-ask").hidden);
  assert.deepEqual(posted(helper, "pick"), [{ action: "join", code: "pb-join:https://share.example/abc", joinName: "" }]);
  const ask = await run(() => {
    const box = document.getElementById("host-ask"), s = getComputedStyle(box);
    return {
      text: box.querySelector("strong").textContent, host: box.querySelector("code.host")?.textContent,
      hostBox: box.querySelector("code.host") && getComputedStyle(box.querySelector("code.host")).borderTopWidth,
      buttons: [...box.querySelectorAll("button")].map((b) => `${b.textContent}:${b.className}`), focus: document.activeElement.textContent,
      shadow: s.boxShadow, padding: s.padding, radius: s.borderRadius,
    };
  });
  assert.equal(ask.text, "This code leads to share.example, not a PairBrowse address. Join through it?");
  assert.equal(ask.host, "share.example");
  assert.equal(ask.hostBox, "1px", "the address in a 1 px box");
  assert.deepEqual(ask.buttons, ["Allow once:primary", "Always allow:secondary", "Cancel:secondary"]);
  assert.equal(ask.focus, "Allow once");
  assert.match(ask.shadow, /rgb\(244, 180, 93\)/, "the warn edge");
  assert.match(ask.shadow, /0px 12px 32px/, "the card's shadow");
  assert.equal(ask.padding, "16px");
  assert.equal(ask.radius, "12px");

  helper.replies.joinhost = { joined: true, text: "Asked to join." };
  await page.click("#host-ask .primary");
  await until("done", () => document.body.dataset.s === "done");
  assert.deepEqual(posted(helper, "joinhost"), [{ op: "allow", id: "a1", always: false }]);
  assert.deepEqual(await run(msg), { text: "Asked to join.", kind: "ok" });
});

pageTest("picker", { fixtures: { sessions: STATE }, bridge: false }, async ({ page, helper, until, inPage: run, harness }) => {
  await until("the rows", ready);
  assert.equal(await run(() => window.chrome?.storage), undefined, "no extension API in the build");
  await page.click("#sessions > li:first-child button");
  await until("done", () => document.body.dataset.s === "done");
  assert.deepEqual(posted(helper, "pick"), [{ action: "use", name: "work" }], "the pick, with the key from session.helper()");
  assert.deepEqual(bad(await harness.log()), []);
});

pageTest("picker", { fixtures: { sessions: STATE }, timeout: 90_000 }, async ({ page, helper, until, inPage: run, harness }) => {
  await until("the rows", ready);
  assert.equal((await harness.live()).intervals, 1);
  await harness.setHidden(true);
  assert.equal((await harness.live()).intervals, 0, "no refresh while hidden");
  const fires = await harness.hiddenFires();
  await page.waitForTimeout(4500);
  assert.equal(await harness.hiddenFires(), fires, "nothing ran while hidden");
  helper.set("sessions", { sessions: STATE.sessions.slice(1) });
  await harness.setHidden(false);
  let first = null;
  for (let i = 0; i < 40 && first !== "shop"; i++) { first = await run(() => document.querySelector("#sessions > li")?.dataset.name); if (first !== "shop") await page.waitForTimeout(50); }
  assert.equal(first, "shop", "one refresh at once on return");
  assert.equal((await harness.live()).intervals, 1, "the refresh is back");
});

pageTest("picker", { fixtures: { sessions: STATE } }, async ({ page, until, inPage: run }) => {
  await until("the rows", ready);
  const focused = () => run(() => { const a = document.activeElement; return a?.id || a?.closest("li")?.dataset.name || a?.tagName; });
  const order = [];
  for (let i = 0; i < 4; i++) { await page.keyboard.press("Tab"); order.push(await focused()); }
  assert.deepEqual(order, ["work", "shop", "default", "more-btn"]);
  assert.deepEqual(await run(() => [getComputedStyle(document.activeElement).outlineStyle, getComputedStyle(document.activeElement).outlineWidth]), ["solid", "2px"]);
  for (let i = 0; i < 5 && (await focused()) !== "SUMMARY"; i++) await page.keyboard.press("Tab");
  assert.equal(await focused(), "SUMMARY");
  await page.keyboard.press("Enter");
  await until("focus in the code field", () => document.activeElement?.id === "code");
});

pageTest("picker", { fixtures: { sessions: STATE }, reducedMotion: "reduce" }, async ({ page, until, inPage: run, harness }) => {
  await until("the rows", ready);
  assert.equal(await run(() => getComputedStyle(document.querySelector(".choice")).transitionDuration), "0s");
  await page.hover("#sessions > li:first-child button");
  await page.waitForTimeout(100);
  assert.deepEqual(await harness.animations(), []);
});

// Framed: the switcher in a same-origin frame of a stand-in parent, a session already open.
test("picker framed as the session switcher", { skip: !runtime, timeout: 90_000 }, async () => {
  const browser = await patchright(runtime).chromium.launch();
  const helper = await startFakeHelper({ fixtures: { sessions: { ...STATE, picking: false } } });
  const ui = await startUiServer({ helper, fixture: merge(defaultFixture(), {}) });
  const proxy = await startFrameProxy({ ui });
  helper.setPageOrigin(proxy.origin);
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 360, height: 520 } });
    await page.goto(proxy.frameUrl("picker"), { waitUntil: "load" });
    let frame = null;
    for (let i = 0; i < 60 && !frame; i++) { frame = page.frames().find((f) => f.url().includes("/picker/index.html")) || null; if (!frame) await sleep(50); }
    assert.ok(frame, "the frame loaded");
    for (let i = 0; i < 100 && (await inPage(frame, () => document.body?.dataset.s)) !== "ready"; i++) await sleep(50);
    assert.equal(await inPage(frame, () => document.body.dataset.s), "ready", "the list shows with a session open");
    return { page, frame };
  };
  try {
    const { page, frame } = await open();
    const look = await inPage(frame, () => {
      const main = document.querySelector("main"), s = getComputedStyle(main);
      return {
        host: document.documentElement.dataset.host, padding: getComputedStyle(document.body).padding,
        width: main.getBoundingClientRect().width, border: s.borderTopStyle, shadow: s.boxShadow,
        logo: document.querySelector(".logo").checkVisibility(), brand: document.querySelector(".brand").checkVisibility(),
        sub: document.getElementById("sub").textContent, rows: document.querySelectorAll("#sessions > li").length,
        scroll: document.documentElement.scrollWidth,
        clipped: [...document.querySelectorAll("#fresh small, #join summary small")].some((e) => e.scrollWidth > e.clientWidth),
      };
    });
    assert.deepEqual(look, { host: "frame", padding: "0px", width: 360, border: "none", shadow: "none", logo: false, brand: false,
      sub: "Switch to another session, or start one.", rows: 3, scroll: 360, clipped: false });
    await frame.click("#sessions > li:first-child button");
    for (let i = 0; i < 60 && (await inPage(frame, () => document.body.dataset.s)) !== "done"; i++) await sleep(50);
    assert.deepEqual(posted(helper, "pick"), [{ action: "use", name: "work" }]);
    assert.deepEqual(await inPage(page, () => window.__notes), [{ source: "pairbrowse-picker", op: "picked" }], "the parent told, nothing more");
    assert.deepEqual(bad(await inPage(frame, () => window.__harness.log)), []);
    await page.close();

    const second = await open();
    await second.frame.click("h1");
    await second.page.keyboard.press("Escape");
    for (let i = 0; i < 20 && !(await inPage(second.page, () => window.__notes.length)); i++) await sleep(50);
    assert.deepEqual(await inPage(second.page, () => window.__notes), [{ source: "pairbrowse-picker", op: "close" }], "Escape closes the switcher");
    await second.frame.click("#more-btn");
    await second.page.keyboard.type("sho");
    await second.page.keyboard.press("Escape");
    assert.equal((await inPage(second.page, () => window.__notes)).length, 1, "the first Escape clears the search");
    assert.deepEqual(bad(await inPage(second.frame, () => window.__harness.log)), []);
    await second.page.close();

    // Escape on the address question is its Cancel: the question answered, the switcher kept.
    helper.replies.pick = { error: true, hostAsk: { id: "a1", host: "share.example" } };
    helper.replies.joinhost = {};
    const third = await open();
    await third.frame.click("#join summary");
    await third.frame.fill("#code", "pb-join:https://share.example/abc");
    await third.frame.click("#join-form .primary");
    for (let i = 0; i < 60 && (await inPage(third.frame, () => document.getElementById("host-ask").hidden)); i++) await sleep(50);
    assert.equal(await inPage(third.frame, () => document.getElementById("host-ask").hidden), false, "the address question shows");
    await third.page.keyboard.press("Escape");
    for (let i = 0; i < 60 && !posted(helper, "joinhost").length; i++) await sleep(50);
    assert.deepEqual(posted(helper, "joinhost"), [{ op: "cancel", id: "a1" }], "Escape cancels the question");
    await sleep(200);
    assert.deepEqual(await inPage(third.page, () => window.__notes), [], "and does not close the switcher");
    assert.deepEqual(bad(await inPage(third.frame, () => window.__harness.log)), []);
    await third.page.close();

    // The tight row: Last used and Live with three people at 360 px. No pill fragments: Last used
    // moves to the start of the meta line, Live keeps its pill whole, the name keeps ten
    // characters and more, the stack shows the people in it now and "+N", and nothing reaches
    // into the stack's column.
    helper.fixtures.sessions = TIGHT;
    const fourth = await open();
    const tight = await inPage(fourth.frame, () => [...document.querySelectorAll("#sessions .choice")].map((b) => {
      const name = b.querySelector(".name"), strong = b.querySelector("strong");
      const font = parseFloat(getComputedStyle(name).fontSize);
      return {
        // Whole, or at least ten characters shown when the name is longer.
        text: name.textContent, whole: name.scrollWidth <= name.clientWidth, tenChars: name.scrollWidth <= name.clientWidth || name.clientWidth >= 10 * font * 0.5,
        badges: [...b.querySelectorAll("strong em")].map((e) => e.textContent),
        pills: [...b.querySelectorAll("strong em")].every((e) => e.scrollWidth <= e.clientWidth),
        lastUsed: b.querySelector("small").textContent.startsWith("Last used · "),
        clear: b.querySelector(".chips").getBoundingClientRect().left >= strong.getBoundingClientRect().right,
        chips: [...b.querySelectorAll(".chips > .chip")].map((c) => c.classList.contains("more-chip") ? c.textContent : "o"),
      };
    }));
    assert.deepEqual(tight, [
      { text: "research", whole: true, tenChars: true, badges: ["Live · 1 other"], pills: true, lastUsed: true, clear: true, chips: ["o", "+2"] },
      { text: "quarterly-planning-session", whole: false, tenChars: true, badges: ["Live · 1 other"], pills: true, lastUsed: true, clear: true, chips: ["o", "+3"] },
    ]);
    assert.deepEqual(bad(await inPage(fourth.frame, () => window.__harness.log)), []);
    await fourth.page.close();
  } finally {
    await proxy.close();
    await ui.close();
    await helper.close();
    await browser.close();
  }
});
