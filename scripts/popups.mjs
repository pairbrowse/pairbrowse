// Popups the browser handles by itself, so Claude (and Codex) don't get stuck on them:
// - Page dialogs: alerts and "leave this page?" are answered right away and reported. A confirm
//   that pays, deletes, cancels or submits, and a prompt that asks for text, are left for Claude
//   (browser_handle_dialog), which asks the user.
// - New tabs a page opens (sign-in and consent popups, target=_blank links): Claude is told which
//   tab opened, and when it closes again. Tabs brought back at startup aren't announced.
// - Overlays inside the page that interrupt (cookie banners, newsletter, discount and app
//   popups): closed with the page's own dismiss button. Only interruptions, never a dialog Claude
//   opened, and only dismiss buttons, never subscribe, sign up, buy or a final action.
// - CAPTCHAs and bot checks are the user's: the user is told right away (onYourTurn).
// What happened is collected as notes and added to the next tool result.
import { REVIEW_WORDS, CONFIRM_WORDS, escapeRegExp } from "./guard.mjs";
import { within } from "./util.mjs";

// The "Your turn" text while a CAPTCHA is up (the daemon takes it down once the check is gone).
export const CHALLENGE_TURN = "Solve the check on this page, then Claude continues";

const RISKY = new RegExp(`(^|[^a-z])(${[...REVIEW_WORDS, ...CONFIRM_WORDS, "cancel", "remove", "unsubscribe", "close account"].map(escapeRegExp).join("|")})([^a-z]|$)`, "i");
const CHALLENGE = /(recaptcha|hcaptcha|challenges\.cloudflare\.com|turnstile|arkoselabs|funcaptcha|captcha-delivery|geo\.captcha)/i;

const CONSENT_FRAME = /consent|cookie|privacy|cmp|onetrust|sourcepoint|didomi|trustarc|quantcast|usercentrics|cookiebot|iubenda|termly|osano|sp_message/i;
// null after ms, or on an error: a page or frame that never answers must not hold anything up.
const settle = (ms, work) => within(ms, work.catch(() => null));

// cookieChoice: "accept" (default) or "reject" for cookie banners.
export function createPopups({ log = () => {}, onYourTurn = () => {}, onCleared = () => {}, quiet = () => false, cookieChoice = "accept" } = {}) {
  const notes = [];
  const described = new Set(); // overlays already described to Claude, by page and text
  const note = (text) => { notes.push(text); if (notes.length > 20) notes.shift(); };
  let challengeOn = null; // the page currently showing a CAPTCHA

  function watchPage(page, ctx) {
    page.on("dialog", async (dialog) => {
      const type = dialog.type();
      const message = dialog.message().replace(/\s+/g, " ").slice(0, 300);
      try {
        if (type === "alert" || type === "beforeunload") {
          await dialog.accept();
          note(type === "alert" ? `The page showed an alert and PairBrowse closed it: "${message}"` : "The page asked to confirm leaving; PairBrowse confirmed.");
        } else if (type === "confirm" && !RISKY.test(message)) {
          await dialog.accept();
          note(`The page asked "${message}" and PairBrowse answered OK.`);
        } else {
          note(`The page is waiting on a ${type} dialog: "${message}". Decide with the user, then answer it with browser_handle_dialog.`);
        }
      } catch (e) {
        log("dialog", e?.message || e);
      }
    });
    page.opener().then((opener) => {
      if (!opener || quiet()) return;
      const index = () => ctx.pages().indexOf(page);
      setTimeout(() => {
        if (page.isClosed()) return;
        note(`The page opened a new tab (tab ${index()}): ${page.url() || "(loading)"}. If it's a sign-in or consent page, switch to it with browser_tabs select ${index()}.`);
      }, 800);
      page.once("close", () => note(`That tab closed again. Switch back with browser_tabs select ${ctx.pages().indexOf(opener)} if you were in it.`));
    }).catch(() => {});
  }

  // After each action: a CAPTCHA or bot check on the page is the user's job.
  async function checkChallenge(page) {
    if (!page || page.isClosed()) return;
    // Only a check you can see and click counts: invisible reCAPTCHA and Turnstile run in the
    // background on many pages and need nothing from the user.
    const candidates = page.frames().filter((f) => CHALLENGE.test(f.url()) && !/size=invisible|[?&]render=/.test(f.url())).slice(0, 4);
    let found = false;
    for (const f of candidates) {
      const box = await settle(800, f.frameElement().then((el) => el.boundingBox()));
      if (box && box.width >= 150 && box.height >= 65) { found = true; break; }
    }
    if (found && challengeOn !== page) {
      challengeOn = page;
      note("This page shows a CAPTCHA or bot check. PairBrowse told the user. Wait for it to clear (browser_wait_for), don't try to solve it.");
      onYourTurn(CHALLENGE_TURN);
    } else if (!found && challengeOn === page) {
      challengeOn = null;
      note("The CAPTCHA or bot check is gone; carry on.");
      onCleared();
    }
  }

  // After each action: close an interrupting overlay on the page, if there is one.
  // closeOffers: also close upsell and newsletter popups by their close button. Only when nothing
  // Claude clicked could have opened them (after loading a page, or while waiting).
  // markOwn: right after Claude's click, mark the overlays on screen as Claude's (never closed as offers).
  async function dismissOverlay(page, { closeOffers = false, markOwn = false } = {}) {
    if (markOwn && page && !page.isClosed()) {
      await settle(800, page.evaluate(() => document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="alertdialog"], body > *, body > * > *, body > * > * > *').forEach((el) => {
        if (!el.matches('[role="dialog"], [aria-modal="true"], [role="alertdialog"]') && getComputedStyle(el).position !== "fixed") return;
        const r = el.getBoundingClientRect(), st = getComputedStyle(el);
        // Only what's actually showing: hidden popup templates may be the page's later offer.
        if (r.width > 40 && r.height > 20 && st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05 && el.innerText.trim()) el.setAttribute("data-pairbrowse-own", "");
      })).catch(() => {}));
    }
    if (!page || page.isClosed()) return;
    // The page itself, then only frames from consent providers (cookie banners often live there).
    const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame() && CONSENT_FRAME.test(f.url()))].slice(0, 6);
    const deadline = Date.now() + 2500;
    for (const frame of frames) {
      if (Date.now() > deadline) return;
      if (await settle(1000, dismissIn(frame, closeOffers))) return;
    }
  }
  async function dismissIn(frame, closeOffers) {
    const found = await frame.evaluate(([acceptFirst, inConsentFrame, closeOffers]) => {
      const COOKIE = /cookie|consent|privacy|gdpr/i;
      const INTERRUPTION = /cookie|consent|privacy (settings|choices)|gdpr|newsletter|subscribe to|sign up for (our|updates)|get \d+% off|discount|special offer|download (our|the) app|get the app|turn on notifications|allow notifications/i;
      const REJECT = /^(reject|decline) all$|^reject$|^decline$|necessary|essential only|only essential|continue without/i;
      const CLOSE = /^(close|dismiss|no,? thanks?|not now|maybe later|skip|×|✕|✖|x)$/i;
      const ACCEPT = /^(accept( all)?( cookies)?|accept and (close|continue)|agree( and (close|continue))?|i agree|i accept|yes,? i('| a)m happy|got it|ok(ay)?|allow( all)?( cookies)?)$/i;
      // Overlays must be a real box; buttons can be small (a "×").
      const visible = (el, min = 40) => { const r = el.getBoundingClientRect(); const st = getComputedStyle(el); return r.width > min && r.height > Math.min(min, 20) && st.visibility !== "hidden" && st.display !== "none" && Number(st.opacity) > 0.05; };
      const candidates = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="alertdialog"], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [class*="modal" i], [class*="popup" i], [class*="newsletter" i]')]
        .filter((el) => visible(el) && ["fixed", "sticky"].includes(getComputedStyle(el).position) || el.matches('[role="dialog"], [aria-modal="true"], [role="alertdialog"]'))
        .filter((el) => visible(el) && !el.closest("[data-pairbrowse-own]") && INTERRUPTION.test((el.innerText || "").slice(0, 2000)));
      // Also any fixed box near <body> about cookies or consent, whatever its size or class names.
      for (const el of document.querySelectorAll("body > *, body > * > *, body > * > * > *")) {
        if (candidates.length > 8) break;
        if (candidates.includes(el) || el.closest("[data-pairbrowse-own]") || getComputedStyle(el).position !== "fixed" || !visible(el)) continue;
        if (COOKIE.test((el.innerText || "").slice(0, 1500))) candidates.push(el);
      }
      // In a consent provider's own frame the whole document is the banner.
      if (inConsentFrame && !candidates.length && document.body) candidates.push(document.body);
      const label = (b) => (b.getAttribute("aria-label") || b.innerText || b.value || "").trim().replace(/\s+/g, " ").slice(0, 60);
      for (const box of candidates) {
        // Buttons, and things styled as one: a short label with a pointer cursor ("GOT IT" in a div).
        const real = 'button, [role="button"], a[href="#"], input[type="button"]';
        const buttons = [...box.querySelectorAll(`${real}, div, span, a`)].filter((b) => visible(b, 4) && (b.matches(real) ||
          (getComputedStyle(b).cursor === "pointer" && !b.querySelector(real + ", a") && (b.innerText || "").trim().length <= 30 && !(b.tagName === "A" && b.getAttribute("href") && b.getAttribute("href") !== "#"))));
        const cookie = COOKIE.test(box.innerText || "");
        const order = cookie ? (acceptFirst ? [ACCEPT, REJECT, CLOSE] : [REJECT, CLOSE, ACCEPT]) : [CLOSE];
        for (const want of order) {
          // "OK" and "Allow" are only taken for a box that's about cookies, not any consent dialog.
          const hit = buttons.find((b) => want.test(label(b)) && (want !== ACCEPT || !/^(ok(ay)?|allow( all)?)$/i.test(label(b)) || /cookie/i.test(box.innerText || "")));
          if (hit) {
            hit.setAttribute("data-pairbrowse-dismiss", "");
            return { label: label(hit) || "close", what: cookie ? "cookie banner" : "popup" };
          }
        }
      }
      // Labels this list doesn't know (any language, any wording): describe the overlay so Claude,
      // which reads the page, picks the button. Found by size and position, not by words; a
      // dialog with fields to fill is the user's or Claude's own work and is left alone.
      const vw = innerWidth, vh = innerHeight;
      const covers = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height >= vw * vh * 0.25 || (r.width >= vw * 0.9 && r.height >= 60 && r.bottom >= vh - 4); };
      // Overlays sit near <body>: three levels down is enough, and keeps this quick on big pages.
      const overlays = inConsentFrame && document.body ? [document.body] : [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [role="alertdialog"], body > *, body > * > *, body > * > * > *')]
        .filter((el) => getComputedStyle(el).position === "fixed" || el.matches('[role="dialog"], [aria-modal="true"], [role="alertdialog"]'))
        .filter((el) => visible(el) && covers(el) && !el.closest("[data-pairbrowse-own]") && !el.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select'));
      // The close button of a popup, found by shape and place, not by its words (any language):
      // a small button (an × or icon; any words in it are for screen readers) at the top right
      // of the popup's box.
      const atCorner = (b, overlay) => {
        const br = b.getBoundingClientRect();
        if (br.width > 80 || br.height > 80) return false;
        for (let el = b.parentElement; el && overlay.contains(el); el = el.parentElement) {
          const r = el.getBoundingClientRect();
          // A popup card, not a full-screen app layout (its corner buttons are the app's own).
          if (r.width >= 200 && r.height >= 100 && (r.width < vw * 0.95 || r.height < vh * 0.95) && br.right >= r.right - 80 && br.right <= r.right + 4 && br.top <= r.top + 80 && br.top >= r.top - 4) return true;
        }
        return false;
      };
      if (closeOffers) for (const box of overlays.filter((el) => !el.closest("[data-pairbrowse-own]"))) {
        const close = [...box.querySelectorAll('button, [role="button"], a, [aria-label]')].find((b) => visible(b, 4) && atCorner(b, box));
        if (close) {
          close.setAttribute("data-pairbrowse-dismiss", "");
          return { label: label(close) || "×", what: "popup" };
        }
      }
      for (const box of overlays) {
        const labels = [...box.querySelectorAll('button, [role="button"], a[href="#"], input[type="button"]')].filter((b) => visible(b, 4)).map(label).filter(Boolean);
        if (!labels.length || labels.length > 12) continue;
        return { unresolved: true, text: (box.innerText || "").trim().replace(/\s+/g, " ").slice(0, 160), buttons: [...new Set(labels)].slice(0, 8) };
      }
      return null;
    }, [cookieChoice !== "reject", frame !== frame.page().mainFrame(), closeOffers]).catch(() => null);
    if (found?.unresolved) {
      const key = `${frame.page().url()} ${found.text}`;
      if (!described.has(key)) {
        described.add(key);
        note(`Something covers the page: "${found.text}" (buttons: ${found.buttons.map((b) => `"${b}"`).join(", ")}). ` +
          `If it's a cookie or consent banner, click the button that ${cookieChoice === "reject" ? "accepts only necessary cookies" : "accepts"}; otherwise close it if it's in the way. Never a subscribe, pay or sign-up button.`);
      }
      return false;
    }
    if (!found || RISKY.test(found.label)) return false;
    const button = frame.locator("[data-pairbrowse-dismiss]").first();
    const ok = await button.click({ timeout: 3000 }).then(() => true, () => false);
    if (ok) note(`Closed a ${found.what} on the page (pressed "${found.label}").`);
    // The button is usually gone with its overlay; clear the marker without waiting for it.
    await frame.evaluate(() => document.querySelectorAll("[data-pairbrowse-dismiss]").forEach((b) => b.removeAttribute("data-pairbrowse-dismiss"))).catch(() => {});
    return ok;
  }

  // Notes since the last tool result, as one block to append, or "".
  function drain() {
    if (!notes.length) return "";
    const text = `\n### PairBrowse\n${notes.map((n) => `- ${n}`).join("\n")}`;
    notes.length = 0;
    return text;
  }

  return { watchPage, checkChallenge, dismissOverlay, drain };
}
