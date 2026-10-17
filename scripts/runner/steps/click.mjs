// A click step: click the control its text names, unless the page's structure makes it the user's to confirm.
import { clickClass, strongSignal } from "../../rules/clicks.mjs";
import { addressOnly } from "../../log.mjs";
import { bounded, sleep, within } from "../../util.mjs";
import { buttonLabel, busyNow, whileBusy } from "../../daemon/page.mjs";
import { contextAt, riskReason } from "../risk.mjs";
import { clickable, exactlyClickable, unfold } from "../locate.mjs";
import { dialogStop } from "./common.mjs";

export async function click({ page, arg, hooks, fail }) {
  // A step the agent named as a final action ("Send: Reply") goes through browser_click, which asks the user.
  if (clickClass(arg)) return fail(`"${arg}" is named as a final action. Run the steps before it, then use browser_click on it so the user confirms.`);
  // Named exactly first. One named exactly but folded away (in a narrow window's hamburger
  // menu) is unfolded and clicked, never traded for a shown control that only holds the name
  // ("Installing Python modules" for "modules").
  let el = await exactlyClickable(page, String(arg));
  let u;
  if (!el) {
    u = await unfold(page, String(arg), () => exactlyClickable(page, String(arg)), hooks, { exact: true });
    el = u.el || null;
    if (!el && u.scan?.hidden) return fail(`"${arg}" doesn't show${u.note ? `.${u.note}` : " at this window size, and nothing on the page opens it."}${u.scan.href ? ` Its link goes to ${u.scan.href}: open that with browser_navigate.` : ""}`);
  }
  if (!el) el = await clickable(page, String(arg));
  if (!el) {
    u = await unfold(page, String(arg), () => clickable(page, String(arg)), hooks);
    if (!u.el) return fail(`Nothing to click named "${arg}"${u.note ? " shows." : "."}${u.note || ` A click step takes a button's, link's, tab's, menu item's, grid cell's (a calendar day) or option's name, its text, "#id", or its data-test id.`}`);
    el = u.el;
  }
  await hooks.beforeStep?.("click", el);
  // What the matched element does, by the page's structure, whatever it says: strong signals
  // (payment, danger, DELETE, unreadable) make it the user's to confirm; ordinary submits go.
  const real = String(await el.evaluate(buttonLabel, undefined, { timeout: 2000 }).catch(() => ""));
  let { risk } = await contextAt(page, el, "click");
  // What the press lands on: the element at the middle of the matched one (a calendar day or a
  // grid cell, an option, may hold its own button: a "Book" or "Delete" in the cell), read too.
  if (!strongSignal(risk)) {
    const at = await pointTarget(el);
    if (at) {
      const inner = (await contextAt(page, at, "click")).risk;
      at.dispose().catch(() => {});
      if (strongSignal(inner)) risk = inner;
    }
  }
  if (strongSignal(risk)) return fail(`"${arg}" is the "${real.slice(0, 60)}" button: ${riskReason(risk)}. Run the steps before it, then use browser_click on it so the user confirms.`);
  // Whether the click should take the page elsewhere: a link (same tab) to another document.
  const urlBefore = page.url();
  const goes = await within(1500, el.evaluate((n) => {
    const a = n.closest("a[href]");
    if (!a || (a.target && a.target !== "_self") || /^\s*(#|javascript:)/i.test(a.getAttribute("href") || "") || a.hasAttribute("download")) return null;
    try { const u = new URL(a.href), l = new URL(location.href); u.hash = ""; l.hash = ""; return u.href === l.href ? null : { role: "link", to: u.origin + u.pathname }; } catch { return null; }
  }).catch(() => null));
  await hooks.cursor?.(el, "click"); // sent before the press, which puts it on the click
  // A link that hands over a file (the server says so, not the markup): the page stays, and that is its success.
  let downloaded = null;
  const onDownload = (d) => { downloaded = d; };
  page.on?.("download", onDownload);
  const busyBefore = typeof page.evaluate === "function" ? String((await bounded(page.evaluate(busyNow, null), "", 400)) || "") : "";
  try {
    return await press();
  } finally {
    page.off?.("download", onDownload);
  }

  async function press() {
    try {
      // A click that opens the page's own confirm or prompt never returns while the page
      // waits on it: stop as soon as the dialog is up instead of waiting the click out.
      let watching = true;
      const dialogUp = new Promise((resolve) => { const tick = () => { if (!watching) return; if (hooks.dialogOpen?.()) resolve("dialog"); else setTimeout(tick, 100); }; setTimeout(tick, 100); });
      const r = await Promise.race([el.click({ timeout: 5000 }).then(() => "clicked"), dialogUp]).finally(() => { watching = false; });
      if (r === "dialog") return { ...fail(dialogStop(hooks.dialogOpen(), "This step")), dialog: true };
    } catch (e) {
      const asked = hooks.dialogOpen?.();
      if (asked) return { ...fail(dialogStop(asked, "This step")), dialog: true };
      if (!/Timeout|intercepts pointer events|not visible|outside of the viewport/i.test(String(e?.message))) throw e;
      return fail(`"${arg}" is on the page but couldn't be clicked (hidden, covered or not ready): look at the screenshot, close what covers it or wait, then try again.`);
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    // A link to another page that left the page where it was: no "Done" for it. Said with what
    // was clicked, so the agent sees what happened and corrects it.
    if (goes) {
      for (let t = 0; t < 15 && page.url() === urlBefore && !downloaded; t++) await sleep(200);
      if (downloaded) {
        const name = String((() => { try { return downloaded.suggestedFilename(); } catch { return ""; } })()).slice(0, 80);
        hooks.activity(`Clicked **${arg}**: it downloaded ${name ? `**${name}**` : "a file"}`);
        return;
      }
      if (page.url() === urlBefore) return fail(`Clicked ${goes.role} "${real.replace(/\s+/g, " ").trim().slice(0, 80)}" for "${arg}", which links to ${goes.to}, but the page stayed on ${addressOnly(urlBefore)}. Look at the screenshot: if that wasn't the control you meant, click it by its ref with browser_click.`);
    }
    // A page still at work on the click ("Saving…" on its button, a busy region): waited for, at
    // most BUSY_MAX_MS, so the next step and the outline see what it did.
    const busy = await whileBusy(page, el, BUSY_MAX_MS, busyBefore);
    hooks.activity(`Clicked **${arg}**`);
    // Still at work when the time is up: the steps after it would act on a page in the middle of it.
    if (busy.still) return fail(`Clicked "${arg}", and the page is still busy after ${Math.round(BUSY_MAX_MS / 1000)} s ("${busy.what.slice(0, 40)}"): nothing after it was done. Wait for what it shows when it's done (a waitFor step or browser_wait_for), then run the remaining steps.`);
  }
}
const BUSY_MAX_MS = 5000;

// The element a press in the middle of el lands on, when it's another one inside el (brought into
// view first, as the press would): a handle, or null. Bounded.
async function pointTarget(el) {
  await within(1500, Promise.resolve().then(() => el.scrollIntoViewIfNeeded({ timeout: 1000 })).catch(() => {}));
  const h = await within(1500, Promise.resolve().then(() => el.evaluateHandle((n) => {
    const r = n.getBoundingClientRect();
    let hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    for (let i = 0; hit?.shadowRoot && i < 10; i++) { const inner = hit.shadowRoot.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); if (!inner || inner === hit) break; hit = inner; }
    return hit && hit !== n && n.contains(hit) ? hit : null;
  })).catch(() => null));
  const one = h?.asElement?.() || null;
  if (!one) h?.dispose?.().catch(() => {});
  return one;
}
