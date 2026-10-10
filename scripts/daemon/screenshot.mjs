// The small picture of the page that goes with results (never while a saved password shows),
// and pairbrowse_click_at, which clicks a spot in the latest one.
//
// A picture is taken only once a result is on its way out, and kept nowhere: the result carries
// it, and what stays per participant is how the latest picture's pixels map onto the page (for
// pairbrowse_click_at) and a hash of its bytes. A picture whose bytes equal the last one's is
// not sent again (the result says the page looks the same): a wait, a key press or a tab list
// that changed nothing costs no image. The map goes stale with the page: another address, a
// scroll, a resize or a tab that closed, and a click on the old picture is refused.
import { createHash } from "node:crypto";
import { redact } from "../secrets.mjs";
import { sleep, within, pageLoaded } from "../util.mjs";
import { strongSignal } from "../clickrule.mjs";
import { withHelpers, buttonLabel, clickRisk, clickContext } from "./page.mjs";

const LOAD_WAIT_MS = 4000;
// One frame of a screencast: the compositor scales it, so the page is never re-laid out for the
// picture (a scaled screenshot makes it flicker), and it costs Claude a third of a full-size one.
const SHOT = { format: "jpeg", quality: 55, maxWidth: 820, maxHeight: 820 };
const FIRST_FRAME_MS = 3000;
// A page that has stalled never answers its debugger: give up on the screenshot after this.
const CDP_WAIT_MS = 3000;
// The first frame can be the last one already drawn, from before a popup closed: keep taking
// frames this long and use the newest.
const NEWEST_FRAME_MS = 80; // about five frames: results wait for a quiet page before this (serve.mjs tidy)
const FRAME_QUIET_MS = 40; // no newer frame for this long: the last one is current
// A picture older than this is no map of the page any more (pages move on their own).
const SHOT_MAX_AGE_MS = 120_000;
// The scroll may differ this much (CSS px) from the picture's: sub-pixel and rounding.
const SCROLL_SLACK_PX = 2;

export const CLICK_AT_TOOL = {
  name: "pairbrowse_click_at",
  description: "Click a spot by its position in the latest screenshot (x, y in that image's pixels), for what the page structure doesn't name well: an icon-only close button, a map, a canvas. Prefer browser_click with a ref when there is one. Pay, publish, submit and delete buttons, and anything inside a frame, can't be clicked this way.",
  inputSchema: {
    type: "object",
    required: ["x", "y", "element"],
    properties: { x: { type: "number" }, y: { type: "number" }, element: { type: "string", description: "What you're clicking, as you see it" } },
  },
};

// The width of a JPEG, from its frame header.
function jpegWidth(buf) {
  for (let i = 2; i < buf.length - 9;) {
    if (buf[i] !== 0xff) return 0;
    const marker = buf[i + 1];
    if (marker >= 0xc0 && marker <= 0xc3) return buf.readUInt16BE(i + 7);
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return 0;
}

// What a frame shows that a password could be in: field values, shadow DOM text, the page text.
function shownText() {
  const values = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (values.length > 2000) return;
      if ((el.tagName === "INPUT" && el.type !== "password") || el.tagName === "TEXTAREA") values.push(String(el.value || "").slice(0, 1000));
      if (el.shadowRoot) { values.push((el.shadowRoot.textContent || "").slice(0, 20000)); walk(el.shadowRoot); }
    }
  };
  walk(document);
  values.push((document.body?.innerText || "").slice(0, 100000));
  return values;
}

// Where the page stands now: its scroll and viewport, compared with the picture's.
const viewNow = () => [Math.round(scrollX), Math.round(scrollY), innerWidth, innerHeight];

// What's under a spot, read by the helper: the click guard needs a label it can check.
const hitAt = withHelpers(([px, py]) => {
  let el = document.elementFromPoint(px, py);
  // Into shadow DOM, down to the element really there.
  for (let i = 0; el?.shadowRoot && i < 10; i++) {
    const inner = el.shadowRoot.elementFromPoint(px, py);
    if (!inner || inner === el) break;
    el = inner;
  }
  if (!el) return null;
  if (["IFRAME", "FRAME", "EMBED", "OBJECT"].includes(el.tagName)) return { frame: true };
  const target = el.closest('button, a, [role="button"], input, select, label, summary, [onclick], [tabindex]');
  if (!target) return { label: (el.innerText || "").length <= 80 ? (el.innerText || "").trim() : "" }; // plain page area
  return { label: buttonLabel(target), risk: clickContext(target).risk };
}, buttonLabel, clickRisk, clickContext);

const SNAPSHOT_FIRST = "Take a browser_snapshot first (its screenshot is the one to click on).";

// secrets(): the saved passwords ({ values }). log(text).
// hidePeers(page, hidden): other participants' pointers off (true) or back on, around a picture.
// now(): the clock (tests pass their own).
export function createScreenshots({ secrets, log, hidePeers = async () => {}, now = Date.now }) {
  // Per participant: the page of its latest screenshot, how its pixels map to the page's, where
  // the page stood (url, scroll, viewport), when, and the hash of its bytes. Never the bytes.
  const shots = new Map();
  // { data } (a base64 JPEG), { same: true } (the picture equals the participant's last one),
  // { skipped: why }, or null.
  async function take(page, participant) {
    try {
      if (!page || page.isClosed() || !/^https?:/.test(page.url())) return null;
      // Settled already, usually. Asked, not waited for: a page restored by Back fires no load
      // event again, and waiting for one took the whole LOAD_WAIT_MS on every browser_navigate_back.
      await pageLoaded(page, { maxMs: LOAD_WAIT_MS });
      // Pictures can't be masked like text: no picture while a saved password shows on the page.
      // Every frame, and fields inside shadow DOM too. No answer from a frame: no picture. The
      // reading (the whole page's text, in every frame) is for pages with saved passwords only.
      const { values } = secrets();
      if (Object.keys(values).some((k) => values[k] && values[k].length >= 4)) {
        const frames = page.frames().slice(0, 20);
        const shown = await Promise.all(frames.map((f) => within(1500, f.evaluate(shownText).catch(() => null))));
        if (shown[0] === null) return null;
        if (shown.some((v, i) => v === null && !frames[i].isDetached())) return { skipped: "No screenshot this time: part of the page didn't answer the password check." };
        if (shown.flat().some((v) => v && redact(v, values) !== v)) return { skipped: "No screenshot this time: a saved password is visible on the page." };
      }
      await hidePeers(page, true);
      try {
        return await capture(page, participant);
      } finally {
        hidePeers(page, false).catch(() => {});
      }
    } catch (e) {
      log(`screenshot failed: ${e?.message || e}`);
      return null;
    }
  }
  async function capture(page, participant) {
    const opening = page.context().newCDPSession(page);
    const cdp = await within(CDP_WAIT_MS, opening);
    if (!cdp) { opening.then((late) => late.detach().catch(() => {}), () => {}); return null; } // one that comes late still goes
    let latest = null, latestAt = 0;
    let first;
    const firstFrame = new Promise((ok) => { first = ok; });
    cdp.on("Page.screencastFrame", (fr) => { cdp.send("Page.screencastFrameAck", { sessionId: fr.sessionId }).catch(() => {}); latest = fr; latestAt = Date.now(); first(fr); });
    try {
      if ((await within(CDP_WAIT_MS, cdp.send("Page.startScreencast", SHOT).then(() => true))) !== true) return null;
      await within(FIRST_FRAME_MS, firstFrame);
      // Frames come only when the picture changes: done once none came for a moment.
      for (const until = Date.now() + NEWEST_FRAME_MS; Date.now() < until && Date.now() - latestAt < FRAME_QUIET_MS;) await sleep(15);
    } finally {
      // Stopped and let go whatever happened above: a session kept open keeps its frames coming.
      // (One session per tab, kept, was measured: no faster; the first frame and the quiet wait
      // are the cost, not the attach.)
      cdp.send("Page.stopScreencast").catch(() => {}).finally(() => cdp.detach().catch(() => {}));
    }
    const f = latest;
    if (!f) return null;
    const bytes = Buffer.from(f.data, "base64");
    const width = jpegWidth(bytes);
    if (!width) return null;
    const m = f.metadata || {};
    const hash = createHash("sha256").update(bytes).digest("hex");
    const prev = shots.get(participant);
    // What pairbrowse_click_at maps onto: the page as it stood when this picture was drawn.
    shots.set(participant, { page, toCss: m.deviceWidth / width, url: page.url(), scrollX: Math.round(m.scrollOffsetX ?? 0), scrollY: Math.round(m.scrollOffsetY ?? 0), width: m.deviceWidth, height: m.deviceHeight, at: now(), hash });
    if (prev && prev.page === page && prev.hash === hash) return { same: true };
    return { data: f.data };
  }

  // Why the participant's latest picture is no map of the page any more, or "" while it is.
  async function stale(shot, current) {
    if (shot.page.isClosed()) return "The tab of the last screenshot has closed.";
    if (current && shot.page !== current) return "The last screenshot was of another tab, not this one.";
    if (now() - shot.at > SHOT_MAX_AGE_MS) return `The last screenshot is ${Math.round((now() - shot.at) / 1000)} s old.`;
    const url = shot.page.url();
    if (url !== shot.url) return `The page moved on since the last screenshot (now at ${url.slice(0, 120)}).`;
    const view = await within(1500, shot.page.evaluate(viewNow).catch(() => null));
    if (!view) return "The page didn't answer.";
    const [sx, sy, w, h] = view;
    if (Math.abs(sx - shot.scrollX) > SCROLL_SLACK_PX || Math.abs(sy - shot.scrollY) > SCROLL_SLACK_PX) return "The page has scrolled since the last screenshot.";
    if (shot.width && Math.abs(w - shot.width) > 1) return "The window changed size since the last screenshot.";
    void h;
    return "";
  }

  // pairbrowse_click_at. Returns { text, error } or { text, page }.
  // current: the tab the agent works in now (a screenshot of another tab is no map of this one).
  // cursor(x, y): shows the agent's cursor at the spot before the press (daemon/hud.mjs).
  async function clickAt({ x, y }, participant, { current = null, cursor = null } = {}) {
    const shot = shots.get(participant);
    if (!shot) return { text: `No screenshot to click on yet. ${SNAPSHOT_FIRST}`, error: true };
    const why = await stale(shot, current);
    if (why) return { text: `${why} ${SNAPSHOT_FIRST}`, error: true };
    const { page, toCss } = shot;
    const cx = Number(x) * toCss, cy = Number(y) * toCss;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { text: "x and y must be numbers.", error: true };
    if (cx < 0 || cy < 0 || (shot.width && cx > shot.width) || (shot.height && cy > shot.height)) return { text: "That spot is outside the last screenshot.", error: true };
    const hit = await within(2000, page.evaluate(hitAt, [cx, cy]).catch(() => null));
    if (!hit) return { text: "Nothing at that spot.", error: true };
    if (hit.frame) return { text: "That spot is inside a frame. Use browser_click with the element's ref from browser_snapshot.", error: true };
    // Strong signals (payment, danger, DELETE, a confirmation after one): only browser_click asks the user.
    if (hit.risk && strongSignal(hit.risk)) return { text: `Refused: that spot commits something (${(hit.risk.why || []).join(", ") || hit.risk.word}). Use browser_click with its ref so the user confirms.`, error: true };
    await cursor?.(cx, cy);
    await page.mouse.click(cx, cy);
    const label = hit.label.length > 80 ? hit.label.slice(0, 80).replace(/\s+\S*$/, "") + "..." : hit.label;
    return { text: `Clicked "${label || "the spot"}" at ${Math.round(cx)},${Math.round(cy)} on the page.`, page };
  }

  return {
    take,
    clickAt,
    // The participant left: nothing of theirs stays.
    forget: (participant) => shots.delete(participant),
    // A tab closed: no map onto it stays (the page object would).
    forgetPage: (page) => { for (const [p, s] of shots) if (s.page === page) shots.delete(p); },
    // Tests: what's kept per participant (no image bytes).
    held: () => new Map([...shots].map(([p, s]) => [p, { url: s.url, hash: s.hash, at: s.at }])),
  };
}
