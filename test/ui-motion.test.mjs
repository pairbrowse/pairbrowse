// DESIGN.md Part I (interaction and motion): results appear where the person acted, nothing jumps,
// one motion language from ui/tokens.css, feedback within 100 ms, focus into what opened and back
// to the trigger, Escape closes the topmost. The sheet's tokens and rules are read as text; the
// rest runs the pages in the harness (test/helpers/ui-page.mjs), one page at a time.
import "./helpers/home.mjs";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageTest, sleep } from "./helpers/ui-page.mjs";

const TOKENS = readFileSync(new URL("../ui/tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const root = Object.fromEntries([...TOKENS.match(/^:root\s*\{([^}]*)\}/m)[1].matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));

test("one motion language: the sheet's tokens", () => {
  assert.equal(root["dur-open"], "160ms");
  assert.equal(root["dur-close"], "120ms", "closing is quicker than opening");
  assert.equal(root["t-open"], "var(--dur-open) var(--ease-out)");
  assert.equal(root["t-close"], "var(--dur-close) var(--ease-in)");
  assert.equal(root.t, "var(--t-open)", "the older --t is the open timing");
  assert.equal(root.rise, "4px", "a small translate");
  assert.ok(Number(root.shrink) >= 0.95 && Number(root.shrink) < 1, "a small scale");
  // No bounce: neither curve leaves 0..1 (a y control point outside it overshoots).
  for (const k of ["ease-out", "ease-in"]) {
    const [, y1, , y2] = root[k].match(/cubic-bezier\(([^)]+)\)/)[1].split(",").map(Number);
    assert.ok(y1 >= 0 && y1 <= 1 && y2 >= 0 && y2 <= 1, `--${k}: no overshoot`);
  }
});

test("popovers, folds and panes use the tokens, and reduced motion makes each instant", () => {
  for (const sel of [".m-pop", ".m-fold", ".m-pane:not([hidden])"]) {
    const rule = TOKENS.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`));
    assert.ok(rule, `${sel} has a rule`);
    assert.match(rule[1], /var\(--t-open\)/, `${sel} opens with --t-open`);
  }
  assert.match(TOKENS, /\.m-pop\[hidden\]\s*\{[^}]*var\(--t-close\)/, "a popover closes with --t-close");
  assert.match(TOKENS, /\.m-fold\[hidden\]\s*\{[^}]*var\(--t-close\)/, "a fold closes with --t-close");
  const reduced = TOKENS.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(reduced, /\.m-pop[^{]*\.m-fold[^{]*\.m-pane[^{]*\{\s*transition: none !important;/, "reduced motion: no transition at all");
  assert.match(reduced, /\[aria-busy="true"\]::after\s*\{[^}]*animation: none !important/, "reduced motion: the busy bar stands still");
  // The busy bar waits 300 ms (a quick answer shows nothing) and fills once (nothing endless).
  assert.match(TOKENS, /\[aria-busy="true"\]::after\s*\{[^}]*animation: busy \d+ms var\(--ease-out\) 300ms both/);
  assert.doesNotMatch(TOKENS, /infinite/);
});

// ---- the strip's Share opens its card in the agent panel, under Share ----
describe("the agent panel hosts the strip's Share card under Share", () => pageTest("right", { viewport: { width: 346, height: 900 } }, async ({ page, inPage, until, settle, shim }) => {
  await until("live", () => document.body.dataset.s === "live");
  await inPage(() => new Promise((r) => setTimeout(r, 100))); // windows.list has answered
  await inPage(() => { window.__heard = []; const ch = new BroadcastChannel("pairbrowse-share"); ch.onmessage = (e) => window.__heard.push(e.data); window.__strip = ch; });
  // Another window's ask is not this dock's.
  await inPage(() => window.__strip.postMessage({ open: "share", window: 2, anchor: { right: 100 } }));
  await page.waitForTimeout(150);
  assert.equal(await inPage(() => document.getElementById("share-card").hidden), true);
  // This window's: the card opens at the dock's top right (under Share), its caret under Share's
  // centre (100 px from the window's right edge: 320 - (100 - 8) = 228 px into the card), focus in it.
  await inPage(() => window.__strip.postMessage({ open: "share", window: 1, anchor: { right: 100 } }));
  await until("the card", () => !document.getElementById("share-card").hidden);
  // It opens downward from its caret: the first frame sits above where it lands.
  const first = await inPage(() => getComputedStyle(document.getElementById("share-card")).translate);
  assert.match(first, /^0px -[1-4]/, `opens from above: ${first}`);
  await settle();
  const card = await inPage(() => {
    const c = document.getElementById("share-card"), r = c.getBoundingClientRect();
    return { top: r.top, right: innerWidth - r.right, w: r.width, caret: c.style.getPropertyValue("--caret-x"), parent: c.parentElement.tagName, focus: document.activeElement?.name, close: document.getElementById("share-close").checkVisibility() };
  });
  assert.deepEqual(card, { top: 8, right: 8, w: 320, caret: "228px", parent: "BODY", focus: "share", close: true });
  await until("told the strip", () => window.__heard.some((m) => m.opened === "share"));
  assert.deepEqual(await inPage(() => window.__heard), [{ opened: "share", window: 1 }]);
  // Escape closes the topmost (the card), not the dock; the focus goes to the Agent tab, not lost.
  await page.keyboard.press("Escape");
  await until("closed", () => document.getElementById("share-card").hidden);
  assert.equal(await inPage(() => document.activeElement?.id), "tab-agent", "focus returns into the dock");
  assert.equal(await inPage(() => document.documentElement.dataset.dock), "open");
  await until("told closed", () => window.__heard.some((m) => m.closed === "share"));
  // The strip's second click asks to close it.
  await inPage(() => window.__strip.postMessage({ open: "share", window: 1, anchor: { right: 100 } }));
  await until("open again", () => !document.getElementById("share-card").hidden);
  await inPage(() => window.__strip.postMessage({ close: "share", window: 1 }));
  await until("closed by the strip", () => document.getElementById("share-card").hidden);
  // The × closes it too.
  await inPage(() => window.__strip.postMessage({ open: "share", window: 1 }));
  await until("open once more", () => !document.getElementById("share-card").hidden);
  await settle();
  await page.click("#share-close");
  await until("closed by ×", () => document.getElementById("share-card").hidden);
  // Asked while the dock is a rail (the strip's open has not landed yet): it opens once the dock is open.
  await shim.layout({ right: 1 });
  await until("the rail", () => document.documentElement.dataset.dock === "rail");
  await inPage(() => window.__strip.postMessage({ open: "share", window: 1, anchor: { right: 100 } }));
  await page.waitForTimeout(150);
  assert.equal(await inPage(() => document.getElementById("share-card").hidden), true, "no card in a rail");
  await shim.layout({ right: 2 });
  await until("the card once open", () => document.documentElement.dataset.dock === "open" && !document.getElementById("share-card").hidden);
  // A rail again closes it (nothing floats over a 44 px dock).
  await shim.layout({ right: 1 });
  await until("closed with the rail", () => document.getElementById("share-card").hidden);
  await inPage(() => window.__strip.close());
}));

// ---- feedback in place: busy, then the failure said in the card ----
describe("Pause says busy and a failure in the agent card", () => pageTest("right", {
  viewport: { width: 330, height: 900 },
  fixtures: { pause: { paused: false, can: true }, board: { people: [{ who: "Claude", kind: "agent", color: "#e9763f", status: "working" }], messages: [] } },
  replies: { pause: async () => { await sleep(700); return { status: 500, body: { error: "The helper is busy." } }; } },
}, async ({ page, inPage, until }) => {
  await until("Pause", () => !document.getElementById("pause").hidden && !document.getElementById("agent").hidden);
  await page.click("#pause-btn");
  assert.equal(await inPage(() => document.getElementById("pause-btn").getAttribute("aria-busy")), "true", "busy at once (within 100 ms)");
  // The bar waits 300 ms, so a quick answer shows nothing.
  assert.deepEqual(await inPage(() => { const s = getComputedStyle(document.getElementById("pause-btn"), "::after"); return [s.animationName, s.animationDelay]; }), ["busy", "0.3s"]);
  await until("the failure", () => document.getElementById("agent-msg").textContent !== "");
  assert.deepEqual(await inPage(() => ({ text: document.getElementById("agent-msg").textContent, kind: document.getElementById("agent-msg").dataset.kind, role: document.getElementById("agent-msg").getAttribute("role"), busy: document.getElementById("pause-btn").getAttribute("aria-busy"), focus: document.activeElement.id })),
    { text: "Couldn't pause: The helper is busy.", kind: "error", role: "status", busy: null, focus: "pause-btn" });
}));

// ---- lists: rows enter and leave instead of jumping; a focused control keeps the focus ----
describe("the agent panel's rows enter, leave and keep the focus", () => pageTest("right", {
  viewport: { width: 330, height: 900 },
  fixtures: { pause: { paused: false, can: true, perAgent: true }, board: { people: [{ who: "Claude", kind: "agent", color: "#e9763f", status: "working" }, { who: "Codex", kind: "agent", color: "#9b7bfa", status: "working", tab: "docs.example" }], messages: [] } },
}, async ({ page, inPage, until, helper }) => {
  await until("the Codex row", () => !!document.querySelector('#people li[data-key="who:Codex"] .pause-one'));
  await page.focus('#people li[data-key="who:Codex"] .pause-one');
  // The board again with a new agent: the Codex row is drawn anew in place, the focus stays on its
  // Take control, and the new row grows in.
  helper.push("board", { people: [{ who: "Claude", kind: "agent", color: "#e9763f", status: "working" }, { who: "Codex", kind: "agent", color: "#9b7bfa", status: "working", tab: "docs.example" }, { who: "Gemini", kind: "agent", color: "#4b8ffb", status: "working", tab: "mail.example" }], messages: [] });
  await until("Gemini", () => !!document.querySelector('#people li[data-key="who:Gemini"]'));
  const after = await inPage(() => ({ focus: document.activeElement?.getAttribute("aria-label"), growing: document.querySelector('#people li[data-key="who:Gemini"]').getAnimations().length > 0 }));
  assert.deepEqual(after, { focus: "Take control from Codex", growing: true });
  // Gemini leaves: its row folds away (out of reach meanwhile), then is gone.
  helper.push("board", { people: [{ who: "Claude", kind: "agent", color: "#e9763f", status: "working" }, { who: "Codex", kind: "agent", color: "#9b7bfa", status: "working", tab: "docs.example" }], messages: [] });
  await until("leaving", () => document.querySelector('#people li[data-key="who:Gemini"]')?.dataset.leaving === "true");
  assert.equal(await inPage(() => document.querySelector('#people li[data-key="who:Gemini"]').inert), true);
  await until("gone", () => !document.querySelector('#people li[data-key="who:Gemini"]'));
}));

// ---- tabs: the pane comes in from the side of the tab chosen; reduced motion: at once ----
describe("a tab's pane slides in from its side", () => pageTest("right", { viewport: { width: 330, height: 900 } }, async ({ page, inPage, until, settle }) => {
  // Clicked and read in one task, so a busy machine cannot let the 160 ms run out in between.
  const moving = await inPage(() => { document.getElementById("tab-tools").click(); return document.getElementById("pane-tools").getAnimations().map((a) => a.transitionProperty).sort(); });
  assert.deepEqual(moving, ["opacity", "translate"], "the pane fades and slides in");
  assert.equal(await inPage(() => document.querySelector("main").dataset.from), "end", "Tools is right of Agent");
  assert.equal(await inPage(() => document.querySelectorAll("#pane-tools .m-fold").length > 0 && [...document.querySelectorAll("#pane-tools .m-fold")].every((f) => f.getAnimations().length === 0)), true, "its open sections are drawn open, not grown anew");
  await settle();
  await page.click("#tab-page");
  assert.equal(await inPage(() => document.querySelector("main").dataset.from), "start", "Page is left of Tools");
  await until("Page", () => document.body.dataset.tab === "page");
  // The underline grows in under the tab chosen.
  assert.ok(await inPage(() => { document.getElementById("tab-agent").click(); return document.getAnimations().some((a) => a.effect?.target === document.getElementById("tab-agent") && a.effect.pseudoElement === "::after"); }), "the underline moves");
}));
describe("reduced motion: tabs, folds and the share card are instant", () => pageTest("right", { viewport: { width: 330, height: 900 }, reducedMotion: "reduce" }, async ({ page, inPage, until, harness }) => {
  await page.click("#tab-tools");
  await page.mouse.move(300, 800); // off the tabs: right.css keeps a 1 ms hover color under reduced motion
  await page.waitForTimeout(50);
  assert.deepEqual(await harness.animations(), []);
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("pane-tools")).opacity), "1", "the pane is there at once");
  await page.click("#tab-agent");
  await until("live", () => document.body.dataset.s === "live");
  await inPage(() => new Promise((r) => setTimeout(r, 100)));
  await inPage(() => { const ch = new BroadcastChannel("pairbrowse-share"); ch.postMessage({ open: "share", window: 1 }); ch.close(); });
  await until("the card", () => !document.getElementById("share-card").hidden);
  await page.waitForTimeout(50);
  assert.deepEqual(await harness.animations(), []);
  await page.keyboard.press("Escape");
  assert.equal(await inPage(() => getComputedStyle(document.getElementById("share-card")).display), "none", "gone at once");
}));

// ---- the timeline: a picture shown in the agent panel says so at the card ----
const CARDS = [1, 2, 3].map((i) => ({ id: `a1b2c3d4000${i}`, t: Date.now() - (4 - i) * 60000, caption: `Step ${i}`, step: null, who: "Claude", pinned: false, note: false }));
describe("the timeline says where a picture went, at the card", () => pageTest("timeline", { viewport: { width: 900, height: 125 }, fixtures: { timeline: { cards: CARDS } } }, async ({ page, inPage, until, helper }) => {
  await until("the cards", () => document.querySelectorAll("li.card:not(.add)").length === 3);
  await page.click('li.card[data-id="a1b2c3d40001"] .face');
  await until("marked", () => document.querySelector('li.card[data-id="a1b2c3d40001"]')?.dataset.shown === "true");
  const where = await inPage(() => { const n = document.getElementById("where"), r = n.getBoundingClientRect(), c = document.querySelector('li.card[data-id="a1b2c3d40001"]').getBoundingClientRect(); return { shown: !n.hidden, text: n.textContent.trim(), under: Math.round(r.left) === Math.round(c.left) && r.top >= c.top + 90, said: document.getElementById("said").textContent }; });
  assert.deepEqual(where, { shown: true, text: "Shown large in the agent panel →", under: true, said: "Shown large in the agent panel" });
  assert.deepEqual(helper.posts.filter((p) => p.route === "timeline").map((p) => p.rest), [["a1b2c3d40001", "show"]]);
  // Another card moves the mark; one mark at a time.
  await page.click('li.card[data-id="a1b2c3d40002"] .face');
  await until("moved", () => document.querySelector('li.card[data-id="a1b2c3d40002"]')?.dataset.shown === "true");
  assert.equal(await inPage(() => document.querySelectorAll("li.card[data-shown]").length), 1);
  // A deleted card folds away (out of reach meanwhile), then is gone; its mark and note go with it.
  helper.push("timeline", { op: "remove", card: CARDS[1] });
  await until("leaving", () => document.querySelector('li.card[data-id="a1b2c3d40002"]')?.dataset.leaving === "true");
  assert.equal(await inPage(() => document.getElementById("where").hidden), true);
  await until("gone", () => !document.querySelector('li.card[data-id="a1b2c3d40002"]'));
}));

// ---- the strip: a new tab grows in, a closed one folds away and hands the focus on ----
describe("tabs grow in and fold away", () => pageTest("strip", { viewport: { width: 1200, height: 47 } }, async ({ page, inPage, until, shim }) => {
  await until("tabs", () => document.querySelectorAll("#tabs li").length === 3);
  await shim.createTab({ id: 14, index: 3, window: 1, title: "Mail", url: "https://mail.example/", favicon: null, defaultFavicon: true, networkState: 0, pinned: false, active: false, targetId: "T14" });
  await until("the new tab", () => !!document.querySelector('#tabs li[data-id="14"]'));
  assert.ok(await inPage(() => document.querySelector('#tabs li[data-id="14"]').getAnimations().length > 0), "it grows in");
  await page.focus('#tabs li[data-id="11"]');
  await page.keyboard.press("Delete");
  await until("folding", () => document.querySelector('#tabs li[data-id="11"]')?.dataset.leaving === "true");
  await until("gone", () => !document.querySelector('#tabs li[data-id="11"]'));
  assert.match(await inPage(() => document.activeElement?.closest?.("#tabs li")?.dataset.id || ""), /^\d+$/, "the focus stays in the tab row");
}));

// ---- the framed switcher opens at its trigger: under the Sessions row (served without the browser's
// API; in the browser the row opens the browser's bubble beside it, test/ui-left.test.mjs) ----
describe("the left dock's switcher opens at its trigger", () => pageTest("left", { viewport: { width: 420, height: 936 }, native: false }, async ({ page, inPage, until, settle }) => {
  await until("live", () => document.body.dataset.s === "live");
  await until("the layout", () => document.body.dataset.dock === "open");
  await page.click("#nav-sessions");
  await until("open", () => !document.getElementById("switcher").hidden);
  await settle();
  const under = await inPage(() => ({ top: document.getElementById("switcher").getBoundingClientRect().top, row: document.getElementById("nav-sessions").getBoundingClientRect().bottom }));
  assert.equal(under.top, under.row + 8, "under the Sessions row");
}));
