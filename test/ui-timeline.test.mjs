// The timeline page (ui/timeline, DESIGN.md B7) over the fake helper's timeline routes: the current
// (newest) picture first and ringed, then the history oldest to newest, the Live pill only while the agent drives, pictures
// fetched with the owner key for the visible cards and released when scrolled away or hidden,
// notes, the card menu (pin, delete in words), the keyboard, and the off state. The common checks
// stay in test/ui.test.mjs.
import assert from "node:assert/strict";
import { pageTest } from "./helpers/ui-page.mjs";

// An 8x8 JPEG from a Playwright screenshot (about:blank, quality 50).
const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKAAD//Z";

const hex = (i) => i.toString(16).padStart(12, "0");
const cardFx = (i, over = {}) => ({ id: hex(i), t: 1_700_000_000_000 + i * 60_000, caption: `Step ${i}`, step: { url: `https://shop.example/${i}`, title: `Page ${i}` }, who: "Claude", pinned: false, note: false, ...over });
const CARDS = Array.from({ length: 30 }, (_, i) => cardFx(i));
const pictures = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [hex(i), JPEG]));
const noteCard = (text) => cardFx(40, { caption: text, step: null, note: true });
const cardById = (id) => CARDS.find((c) => c.id === id) || cardFx(0, { id });
const replies = {
  timeline: (body, rest) => (rest[0] === "note" ? { status: 200, body: noteCard(body.text) } : { status: 200, body: { ...cardById(rest[0]), pinned: body.on !== false } }),
};
const opts = (over = {}) => ({ viewport: { width: 1300, height: 125 }, fixtures: { timeline: { cards: CARDS }, pictures }, replies, ...over });

// In the page: every fetch from here on, as [url, method].
const logFetches = () => { window.__fetches = []; const f = window.fetch; window.fetch = (u, o) => { window.__fetches.push([String(u), o?.method || "GET"]); return f(u, o); }; };
// until(...) arguments: the page function is serialized, so the count goes in as its argument.
const drawn = (n) => document.querySelectorAll("li.card:not(.add)").length === n && document.body.dataset.state === "list";
const card = (id) => `li.card[data-id="${id}"]`;

pageTest("timeline", opts(), async ({ until, inPage, helper, harness }) => {
  await until("30 cards", drawn, 30);
  const order = await inPage(() => [...document.querySelectorAll("li.card:not(.add)")].map((li) => li.dataset.id));
  const last = CARDS.at(-1).id;
  assert.deepEqual(order, [last, ...CARDS.slice(0, -1).map((c) => c.id)], "current first, then oldest to newest");
  assert.deepEqual(await inPage(() => [...document.querySelectorAll('[aria-current="true"]')].map((face) => face.closest("li").dataset.id)), [last], "the newest picture is current");
  assert.equal(await inPage((s) => document.querySelector(`${s} .face`).tagName, card(last)), "BUTTON", "the card's face is a button");
  assert.equal(await inPage((s) => !!document.querySelector(`${s} .face .more`), card(last)), false, "More sits beside the face, not in it");
  assert.match(await inPage((s) => document.querySelector(`${s} .face`).getAttribute("aria-label"), card(last)), /, current$/, "current in words, in the face's name");
  assert.deepEqual(await inPage((s) => [...document.querySelectorAll("li.card:not(.add) .face")].filter((f) => !f.closest(s) && f.getAttribute("aria-label").includes("current")).length, card(last)), 0, "no other card says current");
  assert.equal(await inPage(() => document.getElementById("cards").lastElementChild.id), "add", "Add note last");
  assert.equal(await inPage(() => document.getElementById("add").checkVisibility()), true, "Add note shows in the list state");
  // Loading and "Waiting for PairBrowse" are the page as served: Add note starts hidden.
  const served = await inPage(async () => (await fetch(location.href)).text());
  assert.match(served, /<body [^>]*data-state="loading"/, "the page as served is loading");
  assert.match(served, /<li class="card add" id="add" hidden>/, "no Add note before the list");
  assert.equal(await inPage((s) => document.querySelector(`${s} .more`).getAttribute("aria-controls"), card(last)), "menu", "More points at the menu it opens");
  assert.equal(await inPage((s) => document.querySelector(`${s} .live-pill`).hidden, card(last)), true, "no Live pill while idle");
  assert.equal(await inPage(() => document.body.dataset.driving), "false");
  const accents = (sel) => (getComputedStyle(document.querySelector(sel)).boxShadow.match(/50, 133, 246/g) || []).length;
  assert.equal(await inPage(accents, card(last)), 1, "the 2 px --accent ring, always on the current card");
  helper.push("activity", [{ t: Date.now(), who: "Claude", text: "Clicked **Continue**" }]);
  await until("the Live pill", (s) => !document.querySelector(`${s} .live-pill`).hidden && document.body.dataset.driving === "true", card(last));
  assert.equal(await inPage(() => document.querySelectorAll(".live-pill:not([hidden])").length), 1, "on the current card only");
  assert.ok(await inPage(accents, card(last)) >= 3, "the ring gains the accent glow while driving");
  const pill = await inPage((s) => {
    const li = document.querySelector(s), p = li.querySelector(".live-pill");
    return { left: p.getBoundingClientRect().left - li.getBoundingClientRect().left, dot: getComputedStyle(p.querySelector(".live")).backgroundColor };
  }, card(last));
  assert.ok(Math.abs(pill.left - 8) <= 1, `the Live pill at the top-left (${pill.left})`);
  assert.equal(pill.dot, "rgb(239, 100, 104)", "a red Live dot");
  const live = await harness.live();
  assert.equal(live.eventSources, 1);
  assert.equal(live.timeouts, 1, "the one drive timeout");
  assert.equal(live.intervals + live.frames + live.observers, 0);
});

pageTest("timeline", opts({ fixtures: { timeline: { cards: CARDS }, pictures, activity: [{ t: Date.now() - 20_000, who: "Claude", text: "Typed" }] } }), async ({ until, inPage, harness }) => {
  await until("30 cards", drawn, 30);
  assert.equal(await inPage(() => document.querySelectorAll(".live-pill:not([hidden])").length), 0, "an action 20 s old is not driving");
  assert.equal(await inPage(() => document.body.dataset.driving), "false");
  assert.equal((await harness.live()).timeouts, 0, "no timer for an old action");
});

pageTest("timeline", opts(), async ({ until, inPage, helper }) => {
  const blob = (ids) => ids.every((id) => { const img = document.querySelector(`li.card[data-id="${id}"] img`); return img.src.startsWith("blob:") && img.complete && img.naturalWidth > 0; });
  const none = (ids) => ids.every((id) => !document.querySelector(`li.card[data-id="${id}"] img`).src);
  // At the start: the current card and the oldest ones; the newest of the history is far away.
  await until("the first cards' pictures", blob, [CARDS.at(-1).id, ...CARDS.slice(0, 8).map((c) => c.id)]);
  assert.equal(await inPage(none, CARDS.slice(20, 29).map((c) => c.id)), true, "far cards have no picture");
  assert.ok(Number(await inPage(() => document.body.dataset.held)) <= 16);
  await inPage(logFetches);
  await inPage(() => { const s = document.getElementById("strip"); s.scrollLeft = s.scrollWidth; });
  await until("the end cards' pictures", blob, CARDS.slice(22, 29).map((c) => c.id));
  await until("the first cards released", none, CARDS.slice(0, 6).map((c) => c.id));
  const held = Number(await inPage(() => document.body.dataset.held));
  assert.ok(held > 0 && held <= 20, `held ${held}`); // 104 px cards: about 12 in view, plus the margins
  const fetches = await inPage(() => window.__fetches);
  assert.ok(fetches.length > 0);
  for (const [url, method] of fetches) {
    assert.equal(method, "GET");
    assert.ok(url.startsWith(helper.base + "timeline/") && url.endsWith(".jpg"), url);
  }
});

pageTest("timeline", opts(), async ({ until, inPage, helper, harness, page }) => {
  await until("pictures", () => Number(document.body.dataset.held) > 0);
  await harness.setHidden(true);
  assert.equal(await inPage(() => document.body.dataset.held), "0", "nothing held while hidden");
  assert.equal(await inPage(() => document.querySelectorAll('img.thumb[src^="blob:"]').length), 0);
  await inPage(logFetches);
  const added = cardFx(30);
  helper.push("timeline", { op: "add", card: added });
  await until("the added card", (s) => !!document.querySelector(s), card(added.id));
  await page.waitForTimeout(300);
  assert.deepEqual(await inPage(() => window.__fetches), [], "no fetch while hidden");
  const live = await harness.live();
  assert.equal(live.timeouts + live.intervals + live.frames + live.observers, 0, JSON.stringify(live));
  await harness.setHidden(false);
  await until("the new card's picture", (s) => document.querySelector(`${s} img`).src.startsWith("blob:") && window.__fetches.length > 0, card(added.id));
});

// The mockup's sizes (2026-10-13): time and caption at 10 px (--fs-0), so "Filled workspace name"
// shows in full; the cards start 17 px in from the strip's left edge.
pageTest("timeline", opts({ fixtures: { timeline: { cards: [cardFx(0, { caption: "Filled workspace name" }), cardFx(1)] }, pictures } }), async ({ until, inPage }) => {
  await until("2 cards", drawn, 2);
  const m = await inPage((s) => {
    const li = document.querySelector(s), time = li.querySelector(".time"), cap = li.querySelector(".cap");
    return { time: getComputedStyle(time).fontSize, cap: getComputedStyle(cap).fontSize, text: cap.textContent, fits: cap.scrollWidth <= cap.clientWidth, sw: cap.scrollWidth, cw: cap.clientWidth, font: getComputedStyle(cap).fontFamily, first: document.querySelector("li.card").getBoundingClientRect().left - document.getElementById("strip").getBoundingClientRect().left, next: li.getBoundingClientRect().left - document.querySelector("li.card").getBoundingClientRect().right, capRight: cap.getBoundingClientRect().right - li.getBoundingClientRect().right };
  }, card(hex(0)));
  assert.deepEqual([m.time, m.cap], ["10px", "10px"]);
  assert.equal(m.text, "Filled workspace name");
  assert.equal(m.fits, true, `the caption has no ellipsis: ${JSON.stringify(m)}`);
  assert.equal(m.first, 17, "the first card 17 px in");
  assert.equal(m.next, 10, "10 px between cards");
  assert.ok(m.capRight <= 6, "a caption runs at most 6 px into the 10 px gap");
});

pageTest("timeline", opts({ fixtures: { timeline: { cards: [cardFx(0), cardFx(1, { caption: "Check the VAT field", step: null, note: true })] }, pictures } }), async ({ until, inPage }) => {
  await until("2 cards", drawn, 2);
  const n = await inPage((s) => { const li = document.querySelector(s); return { text: li.querySelector(".note-text")?.textContent, img: !!li.querySelector("img"), label: li.querySelector(".face").getAttribute("aria-label"), time: li.querySelector(".time").textContent, current: li.querySelector(".face").getAttribute("aria-current") }; }, card(hex(1)));
  assert.equal(n.text, "Check the VAT field");
  assert.equal(n.img, false);
  assert.match(n.label, /note/);
  assert.ok(n.time.length > 0);
  // Hours and minutes only (common.js shortClock) on a 24-hour clock ("10:24", the mockup), no seconds.
  const want = await inPage((t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), cardFx(1).t);
  assert.equal(n.time, want, "HH:MM");
  assert.doesNotMatch(n.time, /\d+:\d+:\d+/, "no seconds");
  assert.ok(n.label.startsWith(want), "the card's name starts with the same time");
  // Captions in --ink-2 at 400; Add note shows a 16 px "+" above its label and keeps its name.
  const look = await inPage(() => {
    const probe = document.createElement("i"); probe.style.color = "var(--ink-soft)"; document.body.append(probe); const ink2 = getComputedStyle(probe).color; probe.remove();
    const cap = getComputedStyle(document.querySelector(".card:not(.add) .cap"));
    const btn = document.getElementById("add-btn"), plus = btn.querySelector("svg.plus"), label = btn.querySelector("span");
    const pr = plus.getBoundingClientRect(), lr = label.getBoundingClientRect();
    return { capColor: cap.color, ink2, capWeight: cap.fontWeight, plus: [pr.width, pr.height], above: pr.bottom <= lr.top, hidden: plus.getAttribute("aria-hidden"), name: btn.textContent.trim() };
  });
  assert.equal(look.capColor, look.ink2, "captions are --ink-soft (the mockup's light captions)");
  assert.equal(look.capWeight, "400");
  assert.deepEqual(look.plus, [18, 18]);
  assert.equal(look.above, true, "the + sits above the label");
  assert.equal(look.hidden, "true");
  assert.equal(look.name, "Add note", "the accessible name stays Add note");
  assert.equal(n.current, null, "a note is never current");
  assert.equal(await inPage((s) => document.querySelector(`${s} .face`).getAttribute("aria-current"), card(hex(0))), "true");
});

pageTest("timeline", opts(), async ({ until, inPage, helper, page }) => {
  await until("30 cards", drawn, 30);
  await page.click("#add-btn");
  assert.equal(await inPage(() => document.activeElement.id), "note");
  assert.equal(await inPage(() => document.querySelector("#note-form .hint").textContent), "Enter to add · Esc to cancel");
  assert.equal(await inPage(() => document.getElementById(document.getElementById("note").getAttribute("aria-describedby"))?.textContent), "Enter to add · Esc to cancel", "the field names its hint");
  await page.keyboard.press("Escape");
  assert.equal(await inPage(() => document.activeElement.id), "add-btn", "Escape cancels");
  assert.equal(helper.posts.length, 0);
  await page.click("#add-btn");
  await page.keyboard.type("Call the bank");
  // Enter that ends an input method's composition picks the words: no note posts, the field stays.
  await inPage(() => document.getElementById("note").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true })));
  await page.waitForTimeout(100);
  assert.equal(helper.posts.length, 0, "an IME Enter posts nothing");
  assert.equal(await inPage(() => !document.getElementById("note-form").hidden && document.getElementById("note").value), "Call the bank");
  await page.keyboard.press("Enter");
  const note = noteCard("Call the bank");
  await until("the note card", (s) => !!document.querySelector(s), card(note.id));
  assert.deepEqual(helper.posts[0], { route: "timeline", rest: ["note"], body: { text: "Call the bank" } });
  helper.push("timeline", { op: "add", card: note });
  await page.waitForTimeout(200);
  assert.equal(await inPage((s) => document.querySelectorAll(s).length, card(note.id)), 1, "added once");
  assert.equal(await inPage(() => document.activeElement.id), "add-btn");
  assert.equal(await inPage(() => document.getElementById("said").textContent), "Note added");
});

pageTest("timeline", opts(), async ({ until, inPage, helper, page }) => {
  await until("30 cards", drawn, 30);
  const id = CARDS.at(-1).id;
  await page.click(`${card(id)} .more`);
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await until("the Pinned chip", (s) => !document.querySelector(`${s} .pin-chip`).hidden, card(id));
  assert.deepEqual(helper.posts[0], { route: "timeline", rest: [id, "pin"], body: { on: true } });
  assert.match(await inPage((s) => document.querySelector(`${s} .face`).getAttribute("aria-label"), card(id)), /pinned/);
  await page.click(`${card(id)} .more`);
  await page.getByRole("menuitem", { name: "Unpin", exact: true }).click();
  await until("the chip gone", (s) => document.querySelector(`${s} .pin-chip`).hidden, card(id));
  assert.deepEqual(helper.posts[1], { route: "timeline", rest: [id, "pin"], body: { on: false } });
});

pageTest("timeline", opts(), async ({ until, inPage, helper, page }) => {
  await until("30 cards", drawn, 30);
  const id = CARDS.at(-2).id;
  // The newest of the history sits at the end (the current picture is first): scrolled there first,
  // since a scroll closes the menu.
  await inPage(() => { const s = document.getElementById("strip"); s.scrollLeft = s.scrollWidth; });
  await page.waitForTimeout(100);
  await page.click(`${card(id)} .more`);
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  assert.match(await inPage(() => document.getElementById("menu").textContent), /Delete this picture\?/);
  assert.equal(await inPage(() => document.getElementById("menu").getAttribute("aria-label")), "Delete this picture?", "the menu is named by its question");
  assert.deepEqual(await inPage(() => [...document.querySelectorAll('#menu [role="menuitem"]')].map((b) => document.getElementById(b.getAttribute("aria-describedby"))?.textContent)), ["Delete this picture?", "Delete this picture?"], "both answers point at it");
  await page.getByRole("menuitem", { name: "Keep", exact: true }).click();
  assert.equal(await inPage(() => document.getElementById("menu").getAttribute("aria-label")), "Card menu");
  assert.equal(await inPage(() => document.getElementById("menu").hidden), true);
  assert.equal(helper.fixtures.timeline.cards.length, 30, "Keep sends nothing");
  await page.click(`${card(id)} .more`);
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
  await until("the card gone", (s) => !document.querySelector(s), card(id));
  assert.equal(helper.fixtures.timeline.cards.length, 29);
  assert.equal(await inPage(() => document.querySelectorAll("li.card:not(.add)").length), 29);
});

pageTest("timeline", opts({ fixtures: { timeline: null, pictures } }), async ({ until, inPage }) => {
  await until("the off state", () => document.body.dataset.state === "off");
  assert.equal(await inPage(() => document.getElementById("line-text").textContent), "The timeline is off");
  assert.equal(await inPage(() => document.getElementById("line-more").textContent), "", "a bare 404 claims no reason");
  assert.equal(await inPage(() => document.querySelectorAll("li.card:not(.add)").length), 0);
  assert.equal(await inPage(() => document.getElementById("add").checkVisibility()), false, "no Add note card");
  assert.equal(await inPage(() => document.body.dataset.held), "0");
});

pageTest("timeline", opts(), async ({ until, inPage, helper, harness }) => {
  await until("30 cards", drawn, 30);
  await harness.setHidden(true);
  await inPage(() => {
    const f = window.fetch;
    window.fetch = (u, o) => (String(u).endsWith("/timeline.json") ? Promise.resolve(new Response("The timeline is off (timeline: false in ~/.pairbrowse/config.json).", { status: 404 })) : f(u, o));
  });
  for (const s of helper.streams) s.res.destroy();
  await until("the stream dropped", () => document.body.dataset.s !== "live");
  await harness.setHidden(false);
  await until("the off state", () => document.body.dataset.state === "off");
  assert.equal(await inPage(() => document.getElementById("line-text").textContent), "The timeline is off");
  assert.equal(await inPage(() => document.getElementById("line-more").textContent), "(timeline: false in ~/.pairbrowse/config.json)");
  assert.equal(await inPage(() => document.querySelectorAll("li.card:not(.add)").length), 0);
});

pageTest("timeline", opts(), async ({ until, inPage, helper, page }) => {
  await until("30 cards", drawn, 30);
  const ids = CARDS.map((c) => c.id);
  const active = () => inPage(() => (document.activeElement.classList.contains("face") ? document.activeElement.closest("li").dataset.id : document.activeElement.id));
  assert.equal(await inPage((s) => document.querySelector(`${s} .face`).tabIndex, card(ids.at(-1))), 0, "the current (first) card takes Tab");
  await page.focus(`${card(ids.at(-1))} .face`);
  assert.equal(await inPage(() => document.querySelectorAll('.more[tabindex="0"]').length), 1, "only the focused card's More is a Tab stop");
  await page.keyboard.press("Tab");
  assert.equal(await inPage((s) => document.activeElement === document.querySelector(`${s} .more`), card(ids.at(-1))), true, "Tab: the card's More");
  await page.waitForTimeout(150);
  const ring = await inPage(() => {
    const cs = getComputedStyle(document.activeElement);
    const probe = document.createElement("i");
    probe.style.color = "var(--accent)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    return { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor, accent, opacity: cs.opacity };
  });
  assert.deepEqual(ring, { style: "solid", width: "2px", color: ring.accent, accent: ring.accent, opacity: "1" }, "More shows with the ring");
  await page.keyboard.press("Tab");
  assert.equal(await active(), "add-btn", "Tab again: Add note");
  await page.focus(`${card(ids.at(-1))} .face`);
  await page.keyboard.press("ArrowRight");
  assert.equal(await active(), ids[0], "after the current card: the oldest");
  assert.equal(await inPage((s) => document.querySelector(`${s} .more`).tabIndex, card(ids[0])), 0, "More roves with the face");
  assert.equal(await inPage(() => document.querySelectorAll('.more[tabindex="0"]').length), 1);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await active(), ids.at(-1), "back to the current card");
  await page.keyboard.press("End");
  assert.equal(await active(), "add-btn");
  await page.keyboard.press("Home");
  assert.equal(await active(), ids.at(-1), "Home: the current card");
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await active(), ids.at(-2), "the newest of the history, before Add note");
  await page.keyboard.press("Home");
  assert.equal(await active(), ids.at(-1));
  await inPage(logFetches);
  // Part H: with the agent panel a rail, showing a picture opens it first.
  await inPage(() => window.__pairbrowse.layout.set({ right: 1 }));
  await page.keyboard.press("Enter");
  await until("the show post", (u) => window.__fetches.some(([url, m]) => url === u && m === "POST"), `${helper.base}timeline/${ids.at(-1)}/show`);
  await until("the panel opened", () => window.__pairbrowse.calls.some((c) => c.iface === "layout" && c.method === "set" && c.args[0]?.right === 2));
  await page.waitForTimeout(200);
  // Shown large in the agent panel (another part of the window until 530's bubble): the card says
  // so where it was clicked, a ring and a line under it (DESIGN.md Part I).
  await until("marked shown", (id) => document.querySelector(`li.card[data-id="${id}"]`)?.dataset.shown === "true" && !document.getElementById("where").hidden, ids.at(-1));
  assert.equal(await inPage(() => document.querySelectorAll("[data-shown]").length), 1, "one card marked shown");
  await page.keyboard.press("Delete");
  assert.match(await inPage(() => document.getElementById("menu").textContent), /Delete this picture\?/);
  await page.keyboard.press("Escape");
  assert.equal(await inPage(() => document.getElementById("menu").hidden), true);
  assert.equal(await active(), ids.at(-1));
  await page.keyboard.press("Shift+F10");
  assert.equal(await inPage(() => document.activeElement.textContent), "Pin");
  await page.keyboard.press("ArrowDown");
  assert.equal(await inPage(() => document.activeElement.textContent), "Delete");
  await page.keyboard.press("Escape");
  assert.equal(await active(), ids.at(-1));
  assert.equal(helper.fixtures.timeline.cards.length, 30);
});

pageTest("timeline", opts({ reducedMotion: "reduce" }), async ({ until, helper, harness }) => {
  await until("30 cards", drawn, 30);
  helper.push("activity", [{ t: Date.now(), who: "Claude", text: "Clicked" }]);
  await until("the Live pill", () => document.querySelectorAll(".live-pill:not([hidden])").length === 1);
  assert.deepEqual(await harness.animations(), []);
});

pageTest("timeline", opts({ replies: { timeline: (body, rest) => (rest[0] === "note" ? { status: 409, body: { error: "Too long." } } : replies.timeline(body, rest)) } }), async ({ until, inPage, page }) => {
  await until("30 cards", drawn, 30);
  await inPage(() => { const s = document.getElementById("strip"); s.scrollLeft = s.scrollWidth; });
  await until("scrolled to the end", () => { const s = document.getElementById("strip"); return s.scrollLeft > 0 && s.scrollLeft + s.clientWidth >= s.scrollWidth - 1; });
  const before = await inPage(() => document.querySelector("li.card:not(.add)").getBoundingClientRect().left);
  await page.click("#add-btn");
  await page.keyboard.type("A note");
  await page.keyboard.press("Enter");
  await until("the error line", () => !document.getElementById("line").hidden);
  const line = await inPage(() => { const l = document.getElementById("line"); const r = l.getBoundingClientRect(); return { text: l.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, visible: l.checkVisibility() }; });
  assert.equal(line.text, "Too long.");
  assert.equal(line.visible, true);
  assert.ok(line.left >= 0 && line.right <= 1300 && line.top >= 0 && line.bottom <= 125, `on screen: ${JSON.stringify(line)}`);
  assert.equal(await inPage(() => document.querySelector("li.card:not(.add)").getBoundingClientRect().left), before, "no card moved");
  assert.equal(await inPage(() => document.querySelectorAll("li.card:not(.add)").length), 30, "no card added");
});

const PINNED = [...CARDS.slice(0, -1), { ...CARDS.at(-1), pinned: true }];
pageTest("timeline", opts({ fixtures: { timeline: { cards: PINNED }, pictures } }), async ({ until, inPage, page, helper }) => {
  await until("30 cards", drawn, 30);
  const id = CARDS.at(-1).id;
  helper.push("activity", [{ t: Date.now(), who: "Claude", text: "Clicked" }]);
  await until("the Live pill", (s) => !document.querySelector(`${s} .live-pill`).hidden, card(id));
  const chip = (s) => getComputedStyle(document.querySelector(`${s} .pin-chip`)).right;
  await page.mouse.move(5, 125);
  await page.waitForTimeout(250);
  assert.equal(await inPage(chip, card(id)), "12px", "Pinned at the top-right while More is away");
  await page.focus(`${card(id)} .face`);
  await page.keyboard.press("Shift+F10");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(250);
  assert.equal(await inPage(() => document.activeElement.getAttribute("role")), "menuitem", "focus is in the menu, not the card");
  const at = await inPage((s) => {
    const li = document.querySelector(s), p = li.querySelector(".live-pill"), m = li.querySelector(".more");
    return { left: getComputedStyle(p).left, right: p.getBoundingClientRect().right, more: m.getBoundingClientRect().left };
  }, card(id));
  assert.equal(at.left, "8px", "the Live pill stays at the top-left");
  assert.ok(at.right <= at.more, "clear of the More button");
  assert.equal(await inPage(chip, card(id)), "32px", "the Pinned chip steps aside while the menu is open");
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 125);
  await inPage(() => document.activeElement?.blur?.());
  await page.waitForTimeout(250);
  assert.equal(await inPage(chip, card(id)), "12px", "back once the menu is closed");
});

pageTest("timeline", opts(), async ({ until, inPage, helper, page }) => {
  await until("30 cards", drawn, 30);
  assert.equal(await inPage(() => document.getElementById("strip").scrollLeft), 0, "the strip opens at the current picture");
  // Focus on a card that moves when a new picture arrives stays on it.
  const keep = CARDS[0].id;
  await page.focus(`${card(keep)} .face`);
  const added = cardFx(30);
  helper.push("timeline", { op: "add", card: added });
  await until("the new picture first", (id) => document.querySelector("li.card:not(.add)").dataset.id === id, added.id);
  assert.equal(await inPage(() => document.getElementById("strip").scrollLeft), 0, "kept at the start");
  assert.equal(await inPage((s) => document.activeElement === document.querySelector(`${s} .face`), card(keep)), true, "the focus stays on its card");
  assert.equal(await inPage(() => document.querySelectorAll('[aria-current="true"]').length), 1);
  assert.equal(await inPage((s) => document.querySelector(`${s} .face`).getAttribute("aria-current"), card(added.id)), "true");
});

pageTest("timeline", opts({ fixtures: { timeline: { cards: CARDS }, pictures: { ...pictures } } }), async ({ until, inPage, helper, harness }) => {
  await until("pictures", () => Number(document.body.dataset.held) > 0);
  await inPage(logFetches);
  // Hidden releases every picture; the helper then has none, and showing the strip asks once.
  await harness.setHidden(true);
  for (const k of Object.keys(helper.fixtures.pictures)) delete helper.fixtures.pictures[k];
  await harness.setHidden(false);
  await until("the pictures asked once", () => window.__fetches.length > 0);
  await inPage(() => new Promise((r) => setTimeout(r, 200)));
  const first = await inPage(() => window.__fetches.length);
  await inPage(() => { const s = document.getElementById("strip"); for (let i = 0; i < 5; i++) s.dispatchEvent(new Event("scroll")); window.dispatchEvent(new Event("resize")); });
  await inPage(() => new Promise((r) => setTimeout(r, 200)));
  assert.equal(await inPage(() => window.__fetches.length), first, "a picture the helper has not is not asked again on scroll");
});

pageTest("timeline", opts({ fixtures: { timeline: { cards: "not a list" }, pictures } }), async ({ until, inPage, helper, harness }) => {
  await until("the error state", () => document.body.dataset.state === "error");
  assert.equal(await inPage(() => document.getElementById("line-text").textContent), "Couldn't reach PairBrowse.");
  assert.equal(await inPage(() => document.getElementById("add").checkVisibility()), false, "no Add note in the error state");
  assert.equal(await inPage(() => document.body.dataset.s), "live", "the stream stayed up");
  helper.fixtures.timeline = { cards: CARDS };
  await harness.setHidden(true);
  await harness.setHidden(false);
  await until("30 cards after the strip shows again", drawn, 30);
  assert.equal(await inPage(() => document.getElementById("line").hidden), true);
  assert.equal(await inPage(() => document.getElementById("add").checkVisibility()), true, "Add note back with the list");
});

// 530 E2 B3: with the browser's bubbles a card's click shows its picture in a bubble above the card
// (bubbles.open with the face's rect and the card's id), not in the agent panel (no show post, no
// "Shown large" note); a second click closes it; the browser closing it by Escape (or the bubble's
// own page) gives the focus back to the card; a click outside that lands on the same card is that
// close, not a new open.
pageTest("timeline", opts({ shim: { bubbles: true } }), async ({ page, until, inPage, settle }) => {
  await until("30 cards", drawn, 30);
  const id = CARDS.at(-1).id;
  await inPage(logFetches);
  const opens = () => window.__pairbrowse.calls.filter((c) => c.iface === "bubbles" && c.method === "open").map((c) => c.args);
  await page.click(`${card(id)} .face`);
  await until("the open", () => window.__pairbrowse.calls.some((c) => c.iface === "bubbles" && c.method === "open"));
  const [kind, rect, arg] = (await inPage(opens))[0];
  assert.equal(kind, 2, "BubbleKind.kPicture");
  assert.equal(arg, id);
  const face = await inPage((s) => { const r = document.querySelector(`${s} .face`).getBoundingClientRect(); return { x: Math.floor(r.left), y: Math.floor(r.top), right: Math.ceil(r.right), bottom: Math.ceil(r.bottom) }; }, card(id));
  assert.deepEqual(rect, { x: face.x, y: face.y, width: face.right - face.x, height: face.bottom - face.y }, "the face's rect, rounded outward");
  assert.equal(await inPage((s) => document.querySelector(`${s} .face`).getAttribute("aria-expanded"), card(id)), "true");
  await page.waitForTimeout(200);
  assert.deepEqual(await inPage(() => window.__fetches.filter(([u]) => u.endsWith("/show"))), [], "no show post");
  assert.equal(await inPage(() => document.getElementById("where").hidden), true, "no note under the card");
  // A second click closes it.
  await page.click(`${card(id)} .face`);
  await until("the close", () => window.__pairbrowse.calls.some((c) => c.iface === "bubbles" && c.method === "close" && c.args[0] === 2));
  await until("collapsed", (s) => document.querySelector(`${s} .face`).getAttribute("aria-expanded") === "false", card(id));
  // Opened again; the browser closes it by Escape: the focus comes back to the card's face.
  await page.click(`${card(id)} .face`);
  await until("open again", () => window.__pairbrowse.bubbles.open === 2);
  await inPage(() => { document.activeElement.blur(); window.__pairbrowse.bubbles.closed(2, true); });
  await until("the focus on the card", (s) => document.activeElement === document.querySelector(`${s} .face`), card(id));
  // A click outside closed it (not by Escape): a click on the same card right then does not reopen it.
  await page.click(`${card(id)} .face`);
  await until("open once more", () => window.__pairbrowse.bubbles.open === 2);
  const before = (await inPage(opens)).length;
  await inPage(() => window.__pairbrowse.bubbles.closed(2, false));
  await page.click(`${card(id)} .face`);
  await page.waitForTimeout(100);
  assert.equal((await inPage(opens)).length, before, "the closing click opens nothing");
  // Another card opens its own picture.
  const other = CARDS.at(-2).id;
  await page.click(`${card(other)} .face`);
  await until("the other", (o) => window.__pairbrowse.calls.filter((c) => c.iface === "bubbles" && c.method === "open").at(-1)?.args[2] === o, other);
  await settle();
});

// The picture bubble's own page (timeline/#picture=<id>): the picture, its time and caption (also the
// title that names the bubble), the focus on the x, Pin, Delete asked first and then the bubble
// closed; the x closes it.
pageTest("timeline", opts({ shim: { bubbles: true }, viewport: { width: 424, height: 400 } }), async ({ page, until, inPage, helper }) => {
  const id = CARDS[3].id;
  const url = `${page.url().split("#")[0]}#picture=${id}`;
  await page.goto("about:blank");
  await page.goto(url, { waitUntil: "load" });
  await until("the picture", () => document.body.dataset.mode === "picture" && !!document.getElementById("pic-img").getAttribute("src"));
  const s = await inPage(() => ({ title: document.title, cap: document.getElementById("pic-cap").textContent, focus: document.activeElement.id, strip: document.getElementById("strip").checkVisibility(), width: document.getElementById("picture").getBoundingClientRect().width }));
  assert.match(s.title, /, Step 3$/);
  assert.equal(s.cap, "Step 3");
  assert.equal(s.focus, "pic-close", "the focus starts on the x");
  assert.equal(s.strip, false, "the strip is not shown");
  assert.equal(s.width, 424);
  await page.click("#pic-pin");
  await until("unpin", () => document.getElementById("pic-pin").textContent === "Unpin");
  await page.click("#pic-delete");
  assert.equal(await inPage(() => [document.getElementById("pic-ask").hidden, document.activeElement.id]).then((x) => x.join()), "false,pic-no", "asked first, the focus on Keep");
  await page.click("#pic-yes");
  await until("closed after the delete", () => window.__pairbrowse.calls.some((c) => c.iface === "bubbles" && c.method === "close" && c.args[0] === 2));
  assert.equal(await inPage(async ([b, x]) => (await (await fetch(b + "timeline.json")).json()).cards.some((c) => c.id === x), [helper.base, id]), false, "deleted");
  await page.click("#pic-close");
  assert.ok((await inPage(() => window.__pairbrowse.calls.filter((c) => c.iface === "bubbles" && c.method === "close").length)) >= 2, "the x closes it");
});

// A helper address that never answers (none running, or gone before the strip opened): the
// resting line "No agent connected", not the error state and nothing in red; once it answers, the
// stream opens on its own and the cards replace the line (one read on open, no poll).
pageTest("timeline", opts({ down: true, timeout: 90_000 }), async ({ until, inPage, helper, errors }) => {
  const look = () => {
    const probe = (v) => { const i = document.createElement("i"); i.style.color = `var(--${v})`; document.body.append(i); const c = getComputedStyle(i).color; i.remove(); return c; };
    const reds = [probe("bad"), probe("bad-ink")];
    return { state: document.body.dataset.state, line: document.getElementById("line").hidden ? "" : document.getElementById("line-text").textContent, add: document.getElementById("add").checkVisibility(),
      red: [...document.querySelectorAll("body *")].filter((e) => e.checkVisibility() && e.textContent.trim() && reds.includes(getComputedStyle(e).color)).map((e) => e.id || e.className) };
  };
  await until("the resting line", () => !document.getElementById("line").hidden);
  const at = await inPage(look);
  assert.notEqual(at.state, "error");
  assert.deepEqual({ line: at.line, add: at.add, red: at.red }, { line: "No agent connected", add: false, red: [] });
  helper.setDown(false);
  for (let i = 0; i < 160 && !(await inPage(drawn, 30)); i++) await inPage(() => new Promise((r) => setTimeout(r, 50)));
  assert.equal(await inPage(drawn, 30), true, "the cards replaced the line");
  assert.equal(await inPage(() => document.getElementById("line").hidden), true);
  assert.deepEqual(errors, []);
});
