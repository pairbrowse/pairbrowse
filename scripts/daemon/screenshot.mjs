// The small picture of the page that goes with results (never while a saved password shows),
// and pairbrowse_click_at, which clicks a spot in the latest one.
import { redact } from "../secrets.mjs";
import { sleep, within } from "../util.mjs";
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

// secrets(): the saved passwords ({ values }). log(text).
// hidePeers(page, hidden): other participants' pointers off (true) or back on, around a picture.
export function createScreenshots({ secrets, log, hidePeers = async () => {} }) {
  const shots = new Map(); // per participant: the page of its latest screenshot and how its pixels map to the page's

  // { data } (a base64 JPEG), { skipped: why }, or null.
  async function take(page, participant) {
    try {
      if (!page || page.isClosed() || !/^https?:/.test(page.url())) return null;
      await within(LOAD_WAIT_MS, page.waitForLoadState("load").catch(() => {})); // settled already, usually
      // Pictures can't be masked like text: no picture while a saved password shows on the page.
      // Every frame, and fields inside shadow DOM too. No answer from a frame: no picture.
      const { values } = secrets();
      const frames = page.frames().slice(0, 20);
      const shown = await Promise.all(frames.map((f) => within(1500, f.evaluate(shownText).catch(() => null))));
      if (shown[0] === null) return null;
      if (Object.keys(values).length && shown.some((v, i) => v === null && !frames[i].isDetached())) return { skipped: "No screenshot this time: part of the page didn't answer the password check." };
      if (shown.flat().some((v) => v && redact(v, values) !== v)) return { skipped: "No screenshot this time: a saved password is visible on the page." };
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
    {
      const opening = page.context().newCDPSession(page);
      const cdp = await within(CDP_WAIT_MS, opening);
      if (!cdp) { opening.then((late) => late.detach().catch(() => {}), () => {}); return null; } // one that comes late still goes
      let latest = null, latestAt = 0;
      const first = new Promise((ok) => cdp.on("Page.screencastFrame", (fr) => { cdp.send("Page.screencastFrameAck", { sessionId: fr.sessionId }).catch(() => {}); latest = fr; latestAt = Date.now(); ok(fr); }));
      if ((await within(CDP_WAIT_MS, cdp.send("Page.startScreencast", SHOT).then(() => true))) !== true) { cdp.detach().catch(() => {}); return null; }
      await within(FIRST_FRAME_MS, first);
      // Frames come only when the picture changes: done once none came for a moment.
      for (const until = Date.now() + NEWEST_FRAME_MS; Date.now() < until && Date.now() - latestAt < FRAME_QUIET_MS;) await sleep(15);
      const f = latest;
      await cdp.send("Page.stopScreencast").catch(() => {});
      cdp.detach().catch(() => {});
      const width = f && jpegWidth(Buffer.from(f.data, "base64"));
      if (!f || !width) return null;
      shots.set(participant, { page, toCss: f.metadata.deviceWidth / width }); // what pairbrowse_click_at maps onto
      return { data: f.data };
    }
  }

  // pairbrowse_click_at. Returns { text, error } or { text, page }.
  async function clickAt({ x, y }, participant) {
    const shot = shots.get(participant);
    if (!shot || shot.page.isClosed()) return { text: "No screenshot to click on yet. Take a browser_snapshot first.", error: true };
    const { page, toCss } = shot;
    const cx = Number(x) * toCss, cy = Number(y) * toCss;
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return { text: "x and y must be numbers.", error: true };
    const hit = await page.evaluate(hitAt, [cx, cy]).catch(() => null);
    if (!hit) return { text: "Nothing at that spot.", error: true };
    if (hit.frame) return { text: "That spot is inside a frame. Use browser_click with the element's ref from browser_snapshot.", error: true };
    // Strong signals (payment, danger, DELETE, a confirmation after one): only browser_click asks the user.
    if (hit.risk && strongSignal(hit.risk)) return { text: `Refused: that spot commits something (${(hit.risk.why || []).join(", ") || hit.risk.word}). Use browser_click with its ref so the user confirms.`, error: true };
    await page.mouse.click(cx, cy);
    return { text: `Clicked "${hit.label.slice(0, 80) || "the spot"}" at ${Math.round(cx)},${Math.round(cy)} on the page.`, page };
  }

  return { take, clickAt, forget: (participant) => shots.delete(participant) };
}
