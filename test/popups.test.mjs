import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createPopups } from "../scripts/popups.mjs";
import { inPage } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("dialogs, popup windows and CAPTCHAs are handled or handed over", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    let turn = null, cleared = false;
    const popups = createPopups({ onYourTurn: (t) => { turn = t; }, onCleared: () => { cleared = true; } });
    ctx.on("page", (p) => popups.watchPage(p, ctx));
    const page = await ctx.newPage();
    await page.setContent(`<button id="a" onclick="alert('Saved!')">a</button>
      <button id="c" onclick="window.r = confirm('Continue to step 2?')">c</button>
      <button id="d" onclick="window.d = confirm('Delete your account?')">d</button>
      <button id="w" onclick="window.open('about:blank', 'signin', 'popup')">w</button>`);

    await page.click("#a");
    const notes = popups.drain();
    assert.match(notes, /alert.*"Saved!"/);

    // Every confirm is left for Claude (whose OK asks the user), whatever it says: no word list.
    for (const [id, text] of [["#c", "Continue to step 2\\?"], ["#d", "Delete your account\\?"]]) {
      const shown = page.waitForEvent("dialog");
      page.click(id).catch(() => {});
      const dialog = await shown;
      await wait(100);
      assert.match(popups.drain(), new RegExp(`waiting on a confirm dialog.*${text}`));
      await dialog.dismiss();
    }

    await page.click("#w");
    await wait(1200);
    assert.match(popups.drain(), /opened a new tab \(tab 1\)/);

    await page.setContent(`<iframe src="https://www.google.com/recaptcha/api2/anchor?k=test" width="304" height="78"></iframe><iframe src="https://www.google.com/recaptcha/api2/anchor?k=x&size=invisible" width="256" height="60"></iframe>`);
    await wait(300);
    await popups.checkChallenge(page);
    assert.match(turn, /Solve the check/);
    assert.match(popups.drain(), /CAPTCHA/);
    await page.setContent(`<p>done</p>`);
    await popups.checkChallenge(page);
    assert.equal(cleared, true);
  } finally {
    await browser.close();
  }
});

test("interrupting overlays inside the page are closed, other dialogs are left alone", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const popups = createPopups();
    await page.setContent(`
      <div id="cookies" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#eee">
        We use cookies to improve your experience.
        <button onclick="this.parentNode.remove(); window.choice='accept'">Accept all</button>
        <button onclick="this.parentNode.remove(); window.choice='reject'">Reject all</button>
      </div>`);
    // Only the click itself is PairBrowse's own input; a look that finds nothing clicks nothing.
    // The button is declared to the page (its box) before the press, so that press is PairBrowse's.
    let clicks = 0;
    const declared = [];
    const clicking = () => { clicks++; return () => {}; };
    const declare = async (p, el) => { declared.push({ clicked: clicks, box: await el.boundingBox(), text: await el.textContent() }); };
    // Two looks at once (a tidy pass and a late check) click the one banner once: the second skips.
    await Promise.all([popups.dismissOverlay(page, { clicking, declare }), popups.dismissOverlay(page, { clicking, declare })]);
    assert.equal(await inPage(page, () => window.choice), "accept", "accepts by default");
    assert.equal(clicks, 1, "its click is marked as PairBrowse's, once");
    assert.equal(declared.length, 1, "declared once, before the click");
    assert.equal(declared[0].clicked, 0, "declared before the press");
    assert.equal(declared[0].text.trim(), "Accept all");
    assert.ok(declared[0].box && declared[0].box.width > 0, "with the button's box");
    await popups.dismissOverlay(page, { clicking, declare });
    assert.equal(clicks, 1, "nothing to close: nothing marked, a person's click meanwhile stays theirs");
    assert.equal(declared.length, 1, "nothing declared either");
    assert.match(popups.drain(), /cookie banner.*Accept all/);

    // Wording no list knows: Claude is told what covers the page and which buttons it has.
    await inPage(page, () => { window.choice = undefined; });
    await page.setContent(`
      <div style="position:fixed;bottom:0;left:0;right:0;height:140px;background:#eee">Wir respektieren Ihre Daten.
        <button onclick="window.choice='accept'">Passt schon</button> <button>Einstellungen</button>
      </div>`);
    await popups.dismissOverlay(page);
    assert.equal(await inPage(page, () => window.choice), undefined, "unknown labels are never pressed by PairBrowse");
    assert.match(popups.drain(), /covers the page.*"Passt schon", "Einstellungen"/);
    await popups.dismissOverlay(page);
    assert.equal(popups.drain(), "", "described once per page");

    // An offer that shows up on its own: closed by its wordless × (only when Claude didn't open it).
    const offer = `
      <div id="offer" style="position:fixed;left:10%;right:10%;bottom:0;height:300px;background:#fff">
        <button style="position:absolute;top:8px;right:8px;width:32px;height:32px" onclick="this.parentNode.remove()"><svg width="16" height="16"><path d="M0 0L16 16M16 0L0 16" stroke="#000"/></svg></button>
        <h2>Jetzt alle Artikel freischalten</h2><button onclick="window.subscribed=true">Jetzt 4 Wochen für 1 € testen</button>
      </div>`;
    await page.setContent(offer);
    await popups.dismissOverlay(page, { markOwn: true }); // on screen when Claude's click returned
    await popups.dismissOverlay(page, { closeOffers: true });
    assert.equal(await page.locator("#offer").count(), 1, "a popup Claude may have opened stays");
    popups.drain();
    await page.setContent(offer); // shows up later on its own
    await popups.dismissOverlay(page, { closeOffers: true });
    assert.equal(await page.locator("#offer").count(), 0, "closed by its ×");
    assert.equal(await inPage(page, () => !!window.subscribed), false, "never takes the offer");
    assert.match(popups.drain(), /Closed a popup/);

    const rejecting = createPopups({ cookieChoice: "reject" });
    await inPage(page, () => { window.choice = undefined; });
    await page.setContent(`
      <div class="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;height:120px;background:#eee">We use cookies.
        <button onclick="window.choice='accept'">Accept all</button>
        <button onclick="this.parentNode.remove(); window.choice='necessary'">Reject all</button>
      </div>`);
    await rejecting.dismissOverlay(page);
    assert.equal(await inPage(page, () => window.choice), "necessary", 'cookieChoice "reject" picks necessary only');

    await page.setContent(`
      <div role="dialog" aria-modal="true" style="position:fixed;inset:20%;background:#fff">
        Get 10% off! Subscribe to our newsletter.
        <button onclick="window.subscribed=true">Subscribe</button>
        <button aria-label="Close" onclick="this.parentNode.remove()">×</button>
      </div>`);
    await popups.dismissOverlay(page);
    assert.equal(await inPage(page, () => !!window.subscribed), false, "never presses Subscribe");
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    assert.match(popups.drain(), /popup.*Close/);

    await page.setContent(`
      <div role="dialog" aria-modal="true" style="position:fixed;inset:20%;background:#fff">
        Create project <input placeholder="Name"> <button>Cancel</button> <button>Create</button>
      </div>`);
    await popups.dismissOverlay(page);
    assert.equal(await page.locator('[role="dialog"]').count(), 1, "a dialog Claude opened stays");
    assert.equal(popups.drain(), "");
  } finally {
    await browser.close();
  }
});

// A fake tab: popups.watchPage needs its dialog handler, its opener and whether it's closed.
function fakePage() {
  const handlers = {};
  const page = { closed: false, on: (ev, fn) => { handlers[ev] = fn; }, opener: async () => null, isClosed: () => page.closed };
  page.alert = (message) => handlers.dialog({ type: () => "alert", message: () => message, accept: async () => {} });
  return page;
}

test("notes are drained per tab: a result about one tab leaves the other tabs' notes for their agents", async () => {
  const popups = createPopups();
  const ctx = { pages: () => [] };
  const a = fakePage(), b = fakePage();
  popups.watchPage(a, ctx);
  popups.watchPage(b, ctx);
  await a.alert("Saved in A");
  await b.alert("Saved in B");
  assert.doesNotMatch(popups.drain(b), /Saved in A/, "A's note isn't B's");
  assert.equal(popups.drain(b), "", "B's note went with B's result");
  assert.match(popups.drain(a), /Saved in A/, "A's note waits for A's result");
  // No tab given: every note goes.
  await a.alert("Later in A");
  await b.alert("Later in B");
  assert.match(popups.drain(), /Later in A[\s\S]*Later in B/);
  assert.equal(popups.drain(), "");
  // A note on a closed tab goes to whoever reads next.
  await a.alert("Last in A");
  a.closed = true;
  assert.match(popups.drain(b), /Last in A/);
});
