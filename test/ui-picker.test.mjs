// The session picker (ui/picker/) over the pages' harness: the 44 px rows with the people as a
// stack at the right end, More sessions and its search, start fresh, the join form and the
// address question (B6 card), a pick in the browser build (window.pairbrowse, no chrome.*), the
// refresh paused while hidden and run at once on return, the keyboard path, reduced motion, and
// framed as the session switcher in the real strip (the harness lets same-origin pages frame the
// picker only, as the native build will), where the parent gets only a same-origin "picked" or
// "close" notice and closes the switcher on it.
// The common checks (names, focus ring, nothing while hidden, CSP) stay in test/ui.test.mjs;
// test/picker.test.mjs keeps pinning the markup, the sheet's rules and the extension host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageTest, runtime, openPage } from "./helpers/ui-page.mjs";
import { startFakeHelper } from "./helpers/fake-helper.mjs";
import { patchright, inPage } from "./live.mjs";

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
  assert.deepEqual(await run(msg), { text: "Starting a fresh session.", kind: "ok" });
});

// Agents at work (the helper's 428 { confirm, agents }): asked in the page's own card, never a
// confirm() dialog; agents the question doesn't name are listed; Cancel sends nothing more, a
// row's own press drops the question, Switch anyway resends the same pick with confirm: true.
const AT_WORK = (body) => (body.confirm === true ? { status: 200, body: { text: "Opening session \"shop\"." } }
  : { status: 428, body: { text: "Agents are using the browser.", error: true, confirm: "Claude is using the browser. Switching closes every tab for them. Switch anyway?", agents: ["Claude", "Codex"] } });
pageTest("picker", { fixtures: { sessions: STATE }, replies: { pick: AT_WORK } }, async ({ page, helper, until, inPage: run, harness, errors }) => {
  await until("the rows", ready);
  await run(() => { window.__dialogs = 0; window.confirm = () => { window.__dialogs++; return true; }; });
  await page.click("#sessions > li:nth-child(2) button");
  await until("the question", () => !document.getElementById("switch-ask").hidden);
  const ask = await run(() => {
    const box = document.getElementById("switch-ask"), s = getComputedStyle(box);
    return { q: box.querySelector("strong").textContent, agents: box.querySelector(".agents")?.textContent ?? null,
      buttons: [...box.querySelectorAll("button")].map((b) => `${b.textContent}:${b.className}`), focus: document.activeElement.textContent,
      s: document.body.dataset.s, msg: document.getElementById("msg").textContent, shadow: s.boxShadow };
  });
  assert.deepEqual({ ...ask, shadow: undefined }, { q: "Claude is using the browser. Switching closes every tab for them. Switch anyway?", agents: "At work: Claude, Codex",
    buttons: ["Switch anyway:primary", "Cancel:secondary"], focus: "Cancel", s: "ready", msg: "", shadow: undefined });
  assert.match(ask.shadow, /rgb\(244, 180, 93\)/, "the warn edge of an approval card");
  await page.keyboard.press("Enter");
  await until("cancelled", () => document.getElementById("switch-ask").hidden);
  assert.deepEqual(await run(msg), { text: "Not switched.", kind: "" });
  assert.deepEqual(posted(helper, "pick"), [{ action: "use", name: "shop" }]);

  // Asked again; a press on another choice drops the question and asks for that one.
  await page.click("#sessions > li:nth-child(2) button");
  await until("asked", () => !document.getElementById("switch-ask").hidden);
  await page.click("#fresh");
  await until("asked for the fresh one", () => !document.getElementById("switch-ask").hidden && document.getElementById("msg").textContent === "");
  assert.deepEqual(posted(helper, "pick").slice(1), [{ action: "use", name: "shop" }, { action: "new" }]);
  await page.click("#switch-ask .primary");
  await until("done", () => document.body.dataset.s === "done");
  assert.deepEqual(posted(helper, "pick").at(-1), { action: "new", confirm: true });
  assert.equal(await run(() => window.__dialogs), 0, "never a confirm() dialog");
  assert.deepEqual(bad(await harness.log()), []);
  assert.deepEqual(errors, []);
});

// Part H: a refused pick offers Report a problem while the helper relays reports.
pageTest("picker", { fixtures: { sessions: STATE, config: { report: true } }, replies: { pick: { error: true, text: "A session is already chosen." } } }, async ({ page, until, inPage: run }) => {
  await until("the rows", ready);
  await page.click("#fresh");
  await until("the offer", () => !!document.querySelector("#msg a.report-offer"));
  assert.deepEqual(await run(() => { const a = document.querySelector("#msg a"); return [document.getElementById("msg").textContent, a.getAttribute("href"), a.target]; }),
    ["A session is already chosen. Report a problem", "chrome://pairbrowse/settings#report", "_blank"]);
});
pageTest("picker", { fixtures: { sessions: STATE }, replies: { pick: { error: true, text: "A session is already chosen." } } }, async ({ page, until, inPage: run }) => {
  await until("the rows", ready);
  await page.click("#fresh");
  await until("the refusal", () => document.getElementById("msg").textContent === "A session is already chosen.");
  await page.waitForTimeout(300);
  assert.equal(await run(() => !!document.querySelector("#msg a")), false, "no relay, no offer");
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
  // The question folds open in place (.m-fold, DESIGN.md Part I): read it where it lands.
  await until("the address question", () => { const b = document.getElementById("host-ask"); return !b.hidden && b.getAnimations().length === 0; });
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

// Framed: the switcher in the real strip's same-origin frame, a session already open. The
// strip's main world records every same-origin notice it gets (window.__notes).
test("picker framed as the session switcher", { skip: !runtime, timeout: 90_000 }, async () => {
  const browser = await patchright(runtime).chromium.launch();
  const helper = await startFakeHelper({ fixtures: { sessions: { ...STATE, picking: false } } });
  let ctx = null;
  try {
    ctx = await openPage(browser, "strip", { helper, viewport: { width: 1536, height: 640 } });
    const { page } = ctx;
    await inPage(page, () => { window.__notes = []; addEventListener("message", (e) => { if (e.origin === location.origin) window.__notes.push(e.data); }); });
    const notes = () => inPage(page, () => window.__notes);
    const closed = () => inPage(page, () => ({ hidden: document.getElementById("switcher").hidden, src: document.getElementById("picker").getAttribute("src"), focus: document.activeElement?.id || "" }));
    const openSwitcher = async () => {
      if (await inPage(page, () => document.getElementById("switcher").hidden)) await page.click("#switch");
      let frame = null;
      for (let i = 0; i < 100; i++) {
        frame = page.frames().find((f) => f.url().includes("/picker/index.html")) || null;
        if (frame && (await inPage(frame, () => document.body?.dataset.s).catch(() => null)) === "ready") break;
        await sleep(50);
      }
      assert.ok(frame, "the frame loaded");
      assert.equal(await inPage(frame, () => document.body.dataset.s), "ready", "the list shows with a session open");
      return frame;
    };
    const closeSwitcher = async () => { if (!(await inPage(page, () => document.getElementById("switcher").hidden))) await page.click("#switch"); };

    const frame = await openSwitcher();
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
    assert.deepEqual(bad(await inPage(frame, () => window.__harness.log)), []);
    await frame.click("#sessions > li:first-child button");
    for (let i = 0; i < 60 && !posted(helper, "pick").length; i++) await sleep(50);
    assert.deepEqual(posted(helper, "pick"), [{ action: "use", name: "work" }]);
    const afterPick = await inPage(frame, () => window.__harness.log).catch(() => []);
    assert.deepEqual(bad(afterPick), [], "the framed picker logged nothing on the pick");
    for (let i = 0; i < 60 && !(await notes()).length; i++) await sleep(50);
    assert.deepEqual(await notes(), [{ source: "pairbrowse-picker", op: "picked" }], "the parent told, nothing more");
    // The frame unloads once the switcher has faded out (DESIGN.md Part I).
    for (let i = 0; i < 60 && ((await closed()).src !== null || !(await closed()).hidden); i++) await sleep(50);
    assert.deepEqual(await closed(), { hidden: true, src: null, focus: "switch" }, "the strip closed the switcher");

    await inPage(page, () => { window.__notes = []; });
    const second = await openSwitcher();
    await second.click("h1");
    await page.keyboard.press("Escape");
    for (let i = 0; i < 20 && !(await notes()).length; i++) await sleep(50);
    assert.deepEqual(await notes(), [{ source: "pairbrowse-picker", op: "close" }], "Escape closes the switcher");
    for (let i = 0; i < 60 && ((await closed()).src !== null || !(await closed()).hidden); i++) await sleep(50);
    assert.deepEqual(await closed(), { hidden: true, src: null, focus: "switch" });
    const again = await openSwitcher();
    await again.click("#more-btn");
    await page.keyboard.type("sho");
    await page.keyboard.press("Escape");
    await sleep(100);
    assert.equal((await notes()).length, 1, "the first Escape clears the search");
    assert.equal((await closed()).hidden, false, "and the switcher stays open");
    assert.deepEqual(bad(await inPage(again, () => window.__harness.log)), []);

    // Escape on the address question is its Cancel: the question answered, the switcher kept.
    helper.replies.pick = { error: true, hostAsk: { id: "a1", host: "share.example" } };
    helper.replies.joinhost = {};
    await closeSwitcher();
    await inPage(page, () => { window.__notes = []; });
    const third = await openSwitcher();
    await third.click("#join summary");
    await third.fill("#code", "pb-join:https://share.example/abc");
    await third.click("#join-form .primary");
    for (let i = 0; i < 60 && (await inPage(third, () => document.getElementById("host-ask").hidden)); i++) await sleep(50);
    assert.equal(await inPage(third, () => document.getElementById("host-ask").hidden), false, "the address question shows");
    await page.keyboard.press("Escape");
    for (let i = 0; i < 60 && !posted(helper, "joinhost").length; i++) await sleep(50);
    assert.deepEqual(posted(helper, "joinhost"), [{ op: "cancel", id: "a1" }], "Escape cancels the question");
    await sleep(200);
    assert.deepEqual(await notes(), [], "and does not close the switcher");
    assert.equal((await closed()).hidden, false);
    assert.deepEqual(bad(await inPage(third, () => window.__harness.log)), []);

    // The tight row: Last used and Live with three people at 360 px. No pill fragments: Last used
    // moves to the start of the meta line, Live keeps its pill whole, the name keeps ten
    // characters and more, the stack shows the people in it now and "+N", and nothing reaches
    // into the stack's column.
    helper.fixtures.sessions = TIGHT;
    await closeSwitcher();
    const fourth = await openSwitcher();
    const tight = await inPage(fourth, () => [...document.querySelectorAll("#sessions .choice")].map((b) => {
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
    assert.deepEqual(bad(await inPage(fourth, () => window.__harness.log)), []);
    assert.deepEqual(ctx.errors, []);
  } finally {
    await ctx?.close();
    await helper.close();
    await browser.close();
  }
});

// ---- no helper, or none reached: the resting state, never the question nor an error ----
// The words of DESIGN.md B4 (common.js NO_AGENT and noAgentLine), muted: no list, no wait claimed
// (only the helper's `picking` says an agent waits), nothing in red, no refresh while there is
// no helper to ask.
const NO_AGENT = "No agent connected";
const SESSIONS_LINE = "Ask Claude Code or Codex to use PairBrowse. Your sessions show here.";
const resting = () => {
  const probe = (v) => { const i = document.createElement("i"); i.style.color = `var(--${v})`; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; };
  const reds = [probe("bad"), probe("bad-ink")];
  return {
    s: document.body.dataset.s, title: document.getElementById("title").textContent, sub: document.getElementById("sub").textContent,
    subInk2: getComputedStyle(document.getElementById("sub")).color === probe("ink-2"),
    list: document.getElementById("choices").checkVisibility(), msg: document.getElementById("msg").textContent,
    red: [...document.querySelectorAll("body *")].filter((e) => e.checkVisibility() && e.textContent.trim() && reds.includes(getComputedStyle(e).color)).map((e) => e.id || e.className),
    waits: document.body.textContent.includes("Your agent waits"),
  };
};
const RESTING = { s: "none", title: NO_AGENT, sub: SESSIONS_LINE, subInk2: true, list: false, msg: "", red: [], waits: false };

pageTest("picker", { fixtures: { sessions: STATE }, shim: { helper: null }, bridge: false }, async ({ until, inPage: run, harness, helper }) => {
  // The browser started without a helper: session.helper() answers no address.
  await until("the resting state", () => document.body.dataset.s === "none");
  assert.deepEqual(await run(resting), RESTING);
  assert.equal((await harness.live()).intervals, 0, "nothing refreshes with no helper to ask");
  assert.deepEqual(helper.gets, [], "nothing asked");
  assert.deepEqual(bad(await harness.log()), []);
});

pageTest("picker", { fixtures: { sessions: STATE }, native: false, bridge: false }, async ({ until, inPage: run, harness }) => {
  // Neither the browser's API nor the extension's storage (a page opened bare): the same state.
  await until("the resting state", () => document.body.dataset.s === "none");
  assert.deepEqual(await run(resting), RESTING);
  assert.deepEqual(bad(await harness.log()), []);
});

// The wait is said only while the helper reports a pick pending; with a session open the page is
// done and claims no wait.
pageTest("picker", { fixtures: { sessions: { ...STATE, picking: false } } }, async ({ until, inPage: run }) => {
  await until("done", () => document.body.dataset.s === "done");
  assert.deepEqual(await run(() => ({ title: document.getElementById("title").textContent, sub: document.getElementById("sub").textContent, waits: document.body.textContent.includes("Your agent waits") })),
    { title: "Which session?", sub: "", waits: false });
});
pageTest("picker", { fixtures: { sessions: STATE } }, async ({ until, inPage: run }) => {
  await until("the rows", ready);
  assert.deepEqual(await run(() => [document.getElementById("title").textContent, document.getElementById("sub").textContent]), ["Which session?", "Your agent waits until you pick one."]);
});

// The helper not reached (its address known, nothing answering): the resting state, no red; once
// it answers, the list replaces it on the page's own refresh (visible only), with no reload.
pageTest("picker", { fixtures: { sessions: STATE }, down: true, timeout: 90_000 }, async ({ until, inPage: run, helper, harness }) => {
  await until("the resting state", () => document.body.dataset.s === "none");
  assert.deepEqual(await run(resting), RESTING);
  const marker = await run(() => { window.__same = true; return true; });
  helper.setDown(false);
  for (let i = 0; i < 120 && !(await run(ready)); i++) await sleep(50);
  assert.equal(await run(ready), true, "the list replaced the resting state");
  assert.deepEqual(await run(() => ({ same: window.__same === true, title: document.getElementById("title").textContent, sub: document.getElementById("sub").textContent, rows: document.querySelectorAll("#sessions > li").length, msg: document.getElementById("msg").textContent })),
    { same: marker, title: "Which session?", sub: "Your agent waits until you pick one.", rows: 3, msg: "" });
  assert.deepEqual(bad(await harness.log()), []);
});

// 530 E2 B1: the switcher bubble is the picker page itself (#bubble), with its own Session, so it
// reaches the helper (a frame gets no bindings); laid out as the popover, and a pick closes the bubble
// through the browser (which puts the focus back on the logo).
pageTest("picker", { fixtures: { sessions: STATE }, shim: { bubbles: true }, viewport: { width: 360, height: 560 } }, async ({ page, helper, until, inPage: run }) => {
  const url = `${page.url().split("#")[0]}#bubble`;
  await page.goto("about:blank");
  await page.goto(url, { waitUntil: "load" });
  await until("the rows", ready);
  assert.deepEqual(await run(() => [document.documentElement.dataset.host, document.documentElement.dataset.bubble]), ["frame", "native"]);
  // The browser sizes the bubble to the page (120 up to 560 px): the card is its contents' height,
  // never the viewport's, so three sessions leave no empty space under the card.
  const fit = await run(() => {
    const main = document.querySelector("main").getBoundingClientRect().height;
    // The body's own height (the document's scroll height never drops below this test's fixed
    // viewport; in the bubble the viewport follows the body).
    return { main: Math.round(main), doc: Math.round(document.body.getBoundingClientRect().height), view: innerHeight };
  });
  assert.ok(fit.main < fit.view - 40, `the card keeps its contents' height: ${JSON.stringify(fit)}`);
  assert.ok(Math.abs(fit.doc - fit.main) <= 1, `the page is the card's height: ${JSON.stringify(fit)}`);
  assert.equal(await run(() => document.getElementById("all").checkVisibility()), false, "no All sessions while an agent waits for this pick");
  await page.click("#fresh");
  await until("the bubble closed", () => window.__pairbrowse.calls.some((c) => c.iface === "bubbles" && c.method === "close" && c.args[0] === 0));
  assert.deepEqual(posted(helper, "pick"), [{ action: "new" }]);
});

// No saved session (a first start, the look harness's scene): neither the "Continue where you
// left off" heading over an empty list nor the "Or" before the two choices.
pageTest("picker", { fixtures: { sessions: { picking: true, sessions: [] } }, viewport: { width: 1200, height: 760 } }, async ({ until, inPage: run }) => {
  await until("ready", ready);
  const shown = await run(() => ["continue-h", "or-h", "fresh"].map((id) => !!document.getElementById(id).getClientRects().length));
  assert.deepEqual(shown, [false, false, true]);
});

// "All sessions…", the switcher's last item (2026-10-14). As the first tab's question it isn't there
// (no session open to manage yet), nor while the helper waits for a pick. In the browser's bubble (no Tabs of its own) it asks the dock over
// the pairbrowse-sessions channel and closes once the dock says the page is open; with no dock
// holding the opener lock (nobody would answer) it says so in place at once and the bubble stays.
pageTest("picker", { fixtures: { sessions: STATE }, viewport: { width: 1200, height: 760 } }, async ({ until, inPage: run }) => {
  await until("the rows", ready);
  assert.equal(await run(() => document.getElementById("all").checkVisibility()), false, "not on the first tab's question");
});
pageTest("picker", { fixtures: { sessions: { ...STATE, picking: false } }, shim: { bubbles: true }, viewport: { width: 360, height: 560 } }, async ({ page, helper, until, inPage: run }) => {
  const url = `${page.url().split("#")[0]}#bubble`;
  await page.goto("about:blank");
  await page.goto(url, { waitUntil: "load" });
  await until("the rows", ready);
  const item = await run(() => { const a = document.getElementById("all"), r = a.getBoundingClientRect(), last = [...document.querySelectorAll(".choices > *")].filter((n) => n.checkVisibility()).at(-1);
    return { shown: a.checkVisibility(), href: a.getAttribute("href"), text: a.querySelector("strong").textContent, last: last === a, height: r.height >= 44 }; });
  assert.deepEqual(item, { shown: true, href: "../sessions/", text: "All sessions…", last: true, height: true });
  const closes = () => run(() => window.__pairbrowse.calls.filter((c) => c.iface === "bubbles" && c.method === "close").length);
  // No dock holds the opener lock: the item says so where it was clicked; the bubble stays.
  await run(() => { const ch = new BroadcastChannel("pairbrowse-sessions"); window.__unheld = []; ch.onmessage = (e) => window.__unheld.push(e.data); window.__quiet = ch; });
  await page.click("#all");
  await until("the note", () => document.getElementById("msg").dataset.kind === "error");
  assert.deepEqual(await run(() => (window.__quiet.close(), window.__unheld)), [], "nothing asked of nobody");
  assert.equal(await run(() => document.getElementById("msg").textContent), "Couldn't open the sessions list from here. Open pairbrowse://sessions in a tab.");
  assert.equal(await closes(), 0);
  assert.equal(await run(() => document.getElementById("all").hasAttribute("aria-busy")), false);
  // The dock that opened the bubble answers: the bubble closes, nothing was picked.
  await run(() => { navigator.locks.request("pairbrowse-switcher-opener", () => new Promise(() => {})); const ch = new BroadcastChannel("pairbrowse-sessions"); window.__asked = []; ch.onmessage = (e) => { window.__asked.push(e.data); if (e.data?.open === "sessions") ch.postMessage({ opened: "sessions" }); }; window.__dock = ch; });
  await page.click("#all");
  assert.equal(await run(() => document.getElementById("all").getAttribute("aria-busy")), "true", "busy while the dock answers");
  await until("the bubble closed", () => window.__pairbrowse.calls.some((c) => c.iface === "bubbles" && c.method === "close" && c.args[0] === 0));
  assert.deepEqual(await run(() => window.__asked), [{ open: "sessions" }]);
  assert.equal(await run(() => document.getElementById("msg").textContent), "");
  assert.deepEqual(posted(helper, "pick"), []);
  assert.equal(page.url(), url, "the bubble's page stays where it is");
});
