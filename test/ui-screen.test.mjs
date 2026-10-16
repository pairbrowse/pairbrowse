// The joiner's picture page (ui/screen/) over the pages' harness: in the build (window.pairbrowse
// present) it asks for the helper once and calls no route; its title carries the host's name; the
// hold watch stops while hidden; its glyphs are nodes (Trusted Types); the file card is a keyboard
// dialog; the Live dot is the one pulse, still under reduced motion. Driven through
// window.pbScreen, as the joiner's helper drives it. The common checks stay in test/ui.test.mjs.
// Built as test/helpers/ui-page.mjs's pageTest is, with a name for each case.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { patchright } from "./helpers/live.mjs";
import { openPage, runtime } from "./helpers/ui-page.mjs";
import { startFakeHelper, merge } from "./helpers/fake-helper.mjs";
import { defaultFixture } from "./helpers/pairbrowse-shim.mjs";

const VIEWPORT = { width: 1200, height: 760 };
const UI = join(import.meta.dirname, "..", "ui");
const SHOTS = process.env.PAIRBROWSE_TEST_SHOTS;

function screenTest(title, opts, fn) {
  test(`screen page: ${title}`, { skip: !runtime, timeout: 60_000 }, async () => {
    const browser = await patchright(runtime).chromium.launch();
    let helper = null, ctx = null;
    try {
      helper = await startFakeHelper({ pageOrigin: null });
      ctx = await openPage(browser, "screen", { helper, fixture: merge(defaultFixture(), {}), viewport: opts.viewport || VIEWPORT, reducedMotion: opts.reducedMotion, native: opts.native ?? true, bridge: opts.bridge ?? true });
      await fn({ ...ctx, helper });
    } finally {
      await ctx?.close();
      await helper?.close();
      await browser.close();
    }
  });
}

// A picture as the helper sends one (a 320x200 JPEG), and the wait until the page shows frames.
async function sendFrame(ctx) {
  const before = await ctx.inPage(() => window.__frames || 0);
  await ctx.inPage(() => {
    const c = document.createElement("canvas"); c.width = 320; c.height = 200;
    const g = c.getContext("2d");
    g.fillStyle = "#f4f7fb"; g.fillRect(0, 0, 320, 200);
    g.fillStyle = "#3285f6"; g.fillRect(0, 0, 320, 28);
    g.fillStyle = "#192a3d"; g.fillRect(24, 52, 180, 14); g.fillRect(24, 76, 120, 10); g.fillRect(24, 140, 90, 26);
    window.__frames = (window.__frames || 0) + 1;
    window.pbScreen.frame(c.toDataURL("image/jpeg").split(",")[1]);
  });
  await ctx.until("frames shown", () => window.pbScreen.state().view === "frames" && !!document.getElementById("still").width);
  return before + 1;
}
const bad = async (ctx) => (await ctx.harness.log()).filter((e) => ["csp", "pageerror", "error", "rejection"].includes(e.kind));
// A PNG for reviews, once the fades (--t) are done.
const shot = async (ctx, name) => { if (!SHOTS) return; await ctx.page.waitForTimeout(300); await ctx.page.screenshot({ path: join(SHOTS, name) }).catch(() => {}); };

screenTest("renders over the fake helper, never asking for the helper's key and calling no route", {}, async (ctx) => {
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }));
  await sendFrame(ctx);
  await ctx.inPage(() => window.pbScreen.pointers([{ k: "sam", who: "Sam", color: "#2fb6d9", nx: 0.5, ny: 0.5 }]));
  await ctx.inPage(() => window.pbScreen.who({ person: "Sam", personColor: "#2fb6d9" }));
  assert.deepEqual(ctx.errors, []);
  assert.deepEqual(await bad(ctx), []);
  const calls = (await ctx.shim.calls()).filter((c) => c.iface === "session" && c.method === "helper");
  assert.equal(calls.length, 0, "no session.helper(): the page keeps no owner key");
  assert.equal(ctx.helper.posts.length, 0, "no route called");
  assert.equal((await ctx.harness.live()).eventSources, 0, "no stream opened");
  const st = await ctx.inPage(() => window.pbScreen.state());
  assert.equal(st.host, "pairbrowse");
  assert.equal("helper" in st, false);
  assert.equal(st.view, "frames");
});

screenTest("the tab's title carries the host's name in the build", {}, async (ctx) => {
  const title = () => ctx.page.evaluate(() => document.title);
  assert.equal(await title(), "Shared tab", "before any info");
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "" }));
  assert.equal(await title(), "Shop", "no host named: the page's title alone");
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }));
  assert.equal(await title(), "Bob's tab · Shop");
  await ctx.inPage(() => window.pbScreen.who({ person: "Sam", personColor: "#2fb6d9" }));
  assert.equal(await title(), "Sam · Bob's tab · Shop");
  assert.equal((await ctx.inPage(() => window.pbScreen.inTab())).title, "Sam · Bob's tab · Shop");
  await ctx.inPage(() => window.pbScreen.who({ agent: "Claude", agentColor: "#e9763f" }));
  assert.equal(await title(), "✦ Claude · Bob's tab · Shop");
  await ctx.inPage(() => window.pbScreen.who({}));
  assert.equal(await title(), "Bob's tab · Shop", "nobody in it: whose tab and the title");
});

screenTest("on the slower route the helper's word on the channel drives the hold, never a quiet spell", {}, async (ctx) => {
  await ctx.inPage(() => { window.pbScreen.holdAfter(300, 1000); window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }); });
  await sendFrame(ctx);
  assert.equal(await ctx.inPage(() => window.pbScreen.link("up")), true);
  assert.equal((await ctx.harness.live()).intervals, 0, "no watch while the channel is up");
  await ctx.page.waitForTimeout(800);
  assert.deepEqual(await ctx.inPage(() => window.pbScreen.hold()), { shown: false, text: "", dimmed: false }, "a quiet host page on a healthy channel: no wait");
  await ctx.inPage(() => window.pbScreen.link("down"));
  assert.deepEqual(await ctx.inPage(() => window.pbScreen.hold()), { shown: true, text: "Reconnecting to Bob…", dimmed: true }, "the channel down: said at once");
  await ctx.inPage(() => window.pbScreen.link("up"));
  assert.equal((await ctx.inPage(() => window.pbScreen.hold())).shown, false, "the channel up again: taken down");
  await ctx.inPage(() => window.pbScreen.link("down"));
  await sendFrame(ctx);
  assert.equal((await ctx.inPage(() => window.pbScreen.hold())).shown, false, "a picture takes it down");
  await ctx.page.waitForTimeout(800);
  assert.equal((await ctx.inPage(() => window.pbScreen.hold())).shown, false, "and a picture means the channel is up");
  assert.equal(await ctx.inPage(() => window.pbScreen.link("sideways")), false, "only up or down");
});

screenTest("hidden pauses the hold watch and return resumes it", {}, async (ctx) => {
  await ctx.inPage(() => { window.pbScreen.holdAfter(300, 1000); window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }); });
  await sendFrame(ctx);
  assert.equal((await ctx.harness.live()).intervals, 1, "the watch runs while frames show");
  await ctx.harness.setHidden(true);
  assert.deepEqual(await ctx.harness.live(), { timeouts: 0, intervals: 0, frames: 0, observers: 0, eventSources: 0 }, "nothing live while hidden");
  const fires0 = await ctx.harness.hiddenFires();
  await ctx.page.waitForTimeout(500);
  assert.equal(await ctx.harness.hiddenFires(), fires0, "no callback ran while hidden");
  assert.deepEqual(await ctx.inPage(() => window.pbScreen.hold()), { shown: false, text: "", dimmed: false });
  assert.equal(await ctx.page.evaluate(() => document.getElementById("top").classList.contains("on")), false, "the tag is down while hidden");
  await ctx.harness.setHidden(false);
  assert.equal((await ctx.harness.live()).intervals, 1, "the watch again");
  assert.deepEqual(await ctx.inPage(() => window.pbScreen.hold()), { shown: false, text: "", dimmed: false }, "a lapse while hidden shows nothing on return");
  await ctx.until("a fresh lapse while visible", () => !document.getElementById("hold").hidden);
  assert.deepEqual(await ctx.inPage(() => window.pbScreen.hold()), { shown: true, text: "Reconnecting to Bob…", dimmed: true }, "a fresh lapse while visible shows the stop");
  await shot(ctx, "ui-screen-hold.png");
  await sendFrame(ctx);
  assert.deepEqual(await ctx.inPage(() => window.pbScreen.hold()), { shown: false, text: "Reconnecting to Bob…", dimmed: false }, "a frame takes it down");
  // The video takes over: the watch stops. The offer is a real one (a second connection in the
  // same page) and the page answers it; the connection then reports "connected" through its own
  // event, since a test machine may carry no UDP between two connections.
  const answered = await ctx.inPage(async () => {
    const Base = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Base { constructor(...a) { super(...a); window.__joinerPc = this; } };
    const c = document.createElement("canvas"); c.width = 320; c.height = 200; c.getContext("2d").fillRect(0, 0, 320, 200);
    const pc = new RTCPeerConnection();
    window.__hostPc = pc;
    pc.addTrack(c.captureStream(10).getVideoTracks()[0]);
    pc.createDataChannel("input");
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((r) => { if (pc.iceGatheringState === "complete") r(); pc.addEventListener("icegatheringstatechange", () => pc.iceGatheringState === "complete" && r()); setTimeout(r, 2000); });
    const sdp = await window.pbScreen.offer({ sdp: pc.localDescription.sdp, peer: "p1", doc: window.pbScreen.state().doc });
    if (!sdp) return false;
    await pc.setRemoteDescription({ type: "answer", sdp });
    window.RTCPeerConnection = Base;
    const joiner = window.__joinerPc;
    Object.defineProperty(joiner, "connectionState", { configurable: true, get: () => "connected" });
    joiner.dispatchEvent(new Event("connectionstatechange"));
    return true;
  });
  assert.equal(answered, true);
  await ctx.until("the direct connection", () => window.pbScreen.state().conn === "connected" && window.pbScreen.state().view === "video");
  assert.equal((await ctx.harness.live()).intervals, 0, "no watch while the video shows");
  await ctx.inPage(() => { window.__hostPc.close(); window.pbScreen.close(); });
});

screenTest("the lock, the note and the pointers are DOM nodes (Trusted Types clean)", {}, async (ctx) => {
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }));
  await sendFrame(ctx);
  const addr = () => ctx.inPage(() => window.pbScreen.address());
  const state = () => ctx.page.evaluate(() => { const st = document.getElementById("addr-state"); return { svg: !!st.querySelector("svg path"), note: st.querySelector(".note")?.textContent || "" }; });
  assert.deepEqual(await addr(), { shown: true, text: "shop.example/cart", lock: true, warn: false });
  assert.deepEqual(await state(), { svg: true, note: "" });
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "http://shop.example/cart", who: "Bob" }));
  assert.deepEqual(await addr(), { shown: true, text: "shop.example/cart", lock: false, warn: true });
  assert.deepEqual(await state(), { svg: true, note: "Not secure" });
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }));
  await ctx.inPage(() => window.pbScreen.pointers([{ k: "sam", who: "Sam", color: "#2fb6d9", nx: 0.75, ny: 0.3 }]));
  const p = await ctx.page.evaluate(() => { const el = document.querySelector(".p"); return { fill: el.querySelector("svg path").getAttribute("fill"), stroke: el.querySelector("svg path").getAttribute("stroke"), name: el.querySelector("span").textContent, ink: getComputedStyle(el.querySelector("span")).color }; });
  assert.deepEqual(p, { fill: "#2fb6d9", stroke: "#fff", name: "Sam", ink: "rgb(11, 20, 33)" });
  // An agent's pointer (host-agent:<id>, <joiner>:a<n>): white, a 1.4 px edge in its color, 22 px; a person's stays filled.
  await ctx.inPage(() => window.pbScreen.pointers([{ k: "sam", who: "Sam", color: "#2fb6d9", nx: 0.75, ny: 0.3 }, { k: "host-agent:3", who: "Codex", color: "#7088f0", nx: 0.25, ny: 0.3 }, { k: "j1:a0", who: "Gemini", color: "#4fd1e8", nx: 0.5, ny: 0.6 }]));
  const ps = await ctx.page.evaluate(() => [...document.querySelectorAll(".p")].map((el) => { const path = el.querySelector("svg path"); return { cls: el.className, fill: path.getAttribute("fill"), stroke: path.getAttribute("stroke"), sw: path.getAttribute("stroke-width"), w: el.querySelector("svg").getBoundingClientRect().width, vb: el.querySelector("svg").viewBox.baseVal.width, pill: getComputedStyle(el.querySelector("span")).backgroundColor }; }));
  // The rendered edge, not the attribute: stroke-width times the svg's scale is 1.4 px for an agent.
  for (const q of ps.filter((x) => x.cls === "p a")) assert.ok(Math.abs(Number(q.sw) * q.w / q.vb - 1.4) < 0.02, `a 1.4 px edge: ${Number(q.sw) * q.w / q.vb}`);
  for (const q of ps) delete q.vb;
  assert.deepEqual(ps, [
    { cls: "p", fill: "#2fb6d9", stroke: "#fff", sw: "1.6", w: 18, pill: "rgb(47, 182, 217)" },
    { cls: "p a", fill: "#fff", stroke: "#7088f0", sw: "1.53", w: 22, pill: "rgb(112, 136, 240)" },
    { cls: "p a", fill: "#fff", stroke: "#4fd1e8", sw: "1.53", w: 22, pill: "rgb(79, 209, 232)" },
  ]);
  await ctx.inPage(() => window.pbScreen.who({ person: "Sam", personColor: "#2fb6d9" }));
  assert.match(await ctx.page.evaluate(() => document.querySelector('link[rel="icon"]')?.href || ""), /^data:image\/png;base64,/);
  assert.deepEqual(await bad(ctx), [], "no CSP or Trusted Types entry");
  if (SHOTS) {
    await ctx.inPage(() => { document.getElementById("pick-input").click = () => {}; });
    await ctx.inPage(() => { window.pbScreen.pick({ multiple: false }); });
    await shot(ctx, "ui-screen-live.png");
  }
});

screenTest("the file card is a keyboard dialog, the sound button has the ring", {}, async (ctx) => {
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }));
  await sendFrame(ctx);
  const ring = await ctx.page.evaluate(() => { const s = document.createElement("span"); s.style.color = "var(--accent)"; document.body.appendChild(s); const c = getComputedStyle(s).color; s.remove(); return c; });
  const focused = () => ctx.page.evaluate(() => { const el = document.activeElement; const s = getComputedStyle(el); return { id: el.id, ring: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}` }; });
  // The file chooser itself is the browser's (a headless one cancels it at once): kept closed here.
  await ctx.inPage(() => { document.getElementById("pick-input").click = () => {}; });
  await ctx.inPage(() => { window.__picked = null; window.pbScreen.pick({ multiple: false }).then((v) => { window.__picked = v; }); });
  const card = await ctx.page.evaluate(() => { const el = document.getElementById("pick"); return { hidden: el.hidden, role: el.getAttribute("role"), modal: el.getAttribute("aria-modal"), by: el.getAttribute("aria-labelledby") }; });
  assert.deepEqual(card, { hidden: false, role: "dialog", modal: "true", by: "pick-text" });
  assert.equal((await focused()).id, "pick-go", "focus lands on Choose files");
  await ctx.page.keyboard.press("Tab");
  assert.deepEqual(await focused(), { id: "pick-no", ring: `solid 2px ${ring}` });
  await ctx.page.keyboard.press("Shift+Tab");
  assert.deepEqual(await focused(), { id: "pick-go", ring: `solid 2px ${ring}` });
  // The card is modal: Tab stays inside it, even with the sound button up.
  await ctx.inPage(() => { document.getElementById("sound").hidden = false; });
  await ctx.page.keyboard.press("Shift+Tab");
  assert.deepEqual(await focused(), { id: "pick-no", ring: `solid 2px ${ring}` }, "Shift+Tab from Choose files lands on Cancel");
  await ctx.page.keyboard.press("Tab");
  assert.equal((await focused()).id, "pick-go");
  await ctx.page.keyboard.press("Escape");
  await ctx.until("the card resolves", () => Array.isArray(window.__picked));
  assert.deepEqual(await ctx.inPage(() => window.__picked), [], "Escape cancels");
  assert.equal(await ctx.page.evaluate(() => document.getElementById("pick").hidden), true);
  assert.equal((await focused()).id, "sound", "focus goes back to the sound button");
  // The sound button keeps its ring when focused directly.
  await ctx.page.evaluate(() => { document.activeElement.blur(); document.getElementById("sound").focus(); });
  assert.deepEqual(await focused(), { id: "sound", ring: `solid 2px ${ring}` }, "the sound button, ringed");
  assert.equal(await ctx.page.evaluate(() => document.getElementById("sound").textContent.trim()), "Turn on sound");
  assert.deepEqual(await ctx.inPage(() => window.pbScreen.takeInput()), [], "no key reached the host");
  assert.deepEqual(await bad(ctx), []);
});

// The file card: nothing reaches the host while it's up (clicks, wheel, keys, paste); a pick past
// the limits (one file over 50 MB, over 50 MB in all, over 20 files) is refused on the card, which
// stays up to choose again; a pick within them comes back as base64.
screenTest("the file card blocks input to the host and refuses a pick past the limits", {}, async (ctx) => {
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }));
  await sendFrame(ctx);
  await ctx.inPage(() => window.pbScreen.takeInput());
  await ctx.inPage(() => { document.getElementById("pick-input").click = () => {}; });
  await ctx.inPage(() => { window.__picked = null; window.pbScreen.pick({ multiple: true }).then((v) => { window.__picked = v; }); });
  // Input on the picture beside the card, and a paste: none of it goes to the host.
  await ctx.page.mouse.click(60, 700);
  await ctx.page.mouse.move(80, 650);
  await ctx.page.mouse.wheel(0, 200);
  await ctx.page.keyboard.press("a");
  await ctx.page.evaluate(() => { const d = new DataTransfer(); d.setData("text/plain", "secret"); document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: d, bubbles: true, cancelable: true })); });
  await ctx.page.waitForTimeout(100);
  assert.deepEqual(await ctx.inPage(() => window.pbScreen.takeInput()), [], "nothing reached the host while the card is up");

  const choose = (sizes) => ctx.page.evaluate((list) => {
    const d = new DataTransfer();
    list.forEach((n, i) => d.items.add(new File([new Uint8Array(n).fill(65)], `f${i}.bin`)));
    const input = document.getElementById("pick-input");
    input.files = d.files;
    input.dispatchEvent(new Event("change"));
  }, sizes);
  const card = () => ctx.page.evaluate(() => ({ up: !document.getElementById("pick").hidden, msg: document.getElementById("pick-msg").hidden ? "" : document.getElementById("pick-msg").textContent }));
  const MB = 1024 * 1024;
  await choose([51 * MB]);
  assert.deepEqual(await card(), { up: true, msg: "f0.bin is over 50 MB. Choose a smaller file." });
  await choose([20 * MB, 20 * MB, 20 * MB]);
  assert.deepEqual(await card(), { up: true, msg: "These files come to 60 MB, over 50 MB in all. Choose fewer." });
  await choose(Array(21).fill(1));
  assert.deepEqual(await card(), { up: true, msg: "That's 21 files. Choose up to 20 at a time." });
  assert.equal(await ctx.inPage(() => window.__picked), null, "still waiting for a pick");
  await choose([3, 5]);
  await ctx.until("the pick resolves", () => Array.isArray(window.__picked));
  assert.deepEqual(await ctx.inPage(() => window.__picked), [{ name: "f0.bin", b64: "QUFB" }, { name: "f1.bin", b64: "QUFBQUE=" }]);
  assert.equal((await card()).up, false);
  // The card is down: input reaches the host again.
  await ctx.page.mouse.click(600, 380);
  assert.ok((await ctx.inPage(() => window.pbScreen.takeInput())).some((e) => e.a === "mousePressed"), "a click after the card goes to the host");
  assert.deepEqual(await bad(ctx), []);
});

screenTest("the Live dot pulses only while the tag shows", {}, async (ctx) => {
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }));
  await sendFrame(ctx);
  const name = () => ctx.page.evaluate(() => getComputedStyle(document.querySelector("#tag .live")).animationName);
  assert.equal(await ctx.page.evaluate(() => document.getElementById("top").classList.contains("on")), true);
  assert.equal(await name(), "pulse");
  await ctx.page.evaluate(() => document.getElementById("top").classList.remove("on"));
  assert.equal(await name(), "none", "still once the tag fades");
});

screenTest("under reduced motion the Live dot is still and nothing transitions", { reducedMotion: "reduce" }, async (ctx) => {
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }));
  await sendFrame(ctx);
  assert.equal(await ctx.page.evaluate(() => document.getElementById("top").classList.contains("on")), true);
  assert.equal(await ctx.page.evaluate(() => getComputedStyle(document.querySelector("#tag .live")).animationName), "none");
  assert.deepEqual(await ctx.harness.animations(), []);
  const t = await ctx.page.evaluate(() => ["top", "status", "sound"].map((id) => getComputedStyle(document.getElementById(id)).transitionDuration));
  assert.deepEqual(t, ["0s", "0s", "0s"]);
});

// The joiner's own pointer (and their agents') is the mouse they hold: the helper names who the
// page is for, and a pointer keyed by that joiner id is never drawn, whatever the host sends.
screenTest("never draws the joiner's own pointer, only the others'", {}, async (ctx) => {
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }));
  await sendFrame(ctx);
  const me = "0123456789abcdef0123456789abcdef";
  const drawn = () => ctx.page.evaluate(() => [...document.querySelectorAll("#pointers .p")].map((el) => el.querySelector("span").textContent));
  await ctx.inPage((self) => window.pbScreen.pointers([
    { k: `inv1:${self}:me`, who: "Alice", color: "#22c55e", nx: 0.4, ny: 0.4 },
    { k: `inv1:${self}:a0`, who: "Claude", color: "#a78bfa", nx: 0.45, ny: 0.4 },
    { k: "host", who: "Bob", color: "#2fb6d9", nx: 0.6, ny: 0.5 },
    { k: "inv1:fedcba9876543210fedcba9876543210:me", who: "Carol", color: "#f472b6", nx: 0.2, ny: 0.7 },
  ], self), me);
  assert.deepEqual(await drawn(), ["Bob", "Carol"], "the host's and another joiner's, never Alice's own or her agent's");
  // Without a self (an older helper): everything sent is drawn, as before.
  await ctx.inPage(() => window.pbScreen.pointers([{ k: "inv1:x:me", who: "Alice", color: "#22c55e", nx: 0.4, ny: 0.4 }]));
  assert.deepEqual(await drawn(), ["Alice"]);
  assert.deepEqual(await bad(ctx), []);
});

// ---- the page as a plain page serves it (no window.pairbrowse, no chrome.*): from test/screen.test.mjs ----
const PLAIN = { native: false, bridge: false, viewport: { width: 640, height: 400 } };
const holdUntil = async (ctx, ok) => {
  const hold = () => ctx.inPage(() => window.pbScreen.hold());
  for (let i = 0; i < 80; i++) { const h = await hold(); if (ok(h)) return h; await ctx.page.waitForTimeout(50); }
  return hold();
};
// A picture a frame at a time, as the helper sends them (no wait: the hold's clock is the point).
const plainFrame = (ctx) => ctx.inPage(() => {
  const c = document.createElement("canvas"); c.width = 320; c.height = 200;
  const g = c.getContext("2d"); g.fillStyle = "#4a90d9"; g.fillRect(0, 0, 320, 200); g.fillStyle = "#fff"; g.fillRect(40, 40, 240, 40);
  window.pbScreen.frame(c.toDataURL("image/jpeg").split(",")[1]);
});

screenTest("pictures that stop coming show 'Reconnecting to Bob…' over the last one, gone with the next picture", PLAIN, async (ctx) => {
  const hold = () => ctx.inPage(() => window.pbScreen.hold());
  // Short waits, but with room: on a busy machine a round trip to the page can take a good part of
  // a second, so the hold comes 600 ms after the last picture here and the longer wording at 1.8 s,
  // and the test waits for each state rather than for a fixed time.
  await ctx.inPage(() => { window.pbScreen.holdAfter(600, 1800); window.pbScreen.info({ title: "Shop", url: "https://shop.example", who: "Bob" }); });
  assert.deepEqual(await hold(), { shown: false, text: "", dimmed: false }, "nothing before the first picture");
  await plainFrame(ctx);
  await ctx.page.waitForTimeout(80);
  await plainFrame(ctx);
  await ctx.page.waitForTimeout(80);
  assert.equal((await hold()).shown, false, "nothing while pictures keep coming");
  assert.deepEqual(await holdUntil(ctx, (h) => h.shown), { shown: true, text: "Reconnecting to Bob…", dimmed: true });
  const style = await ctx.page.evaluate(() => { const s = getComputedStyle(document.getElementById("hold")); return { pointer: s.pointerEvents, bg: s.backgroundColor }; });
  assert.equal(style.pointer, "none", "never takes a click from the picture");
  assert.match(style.bg, /rgba\(11, 20, 33, 0\.35\)/, "translucent over the last picture");
  assert.equal(await ctx.page.evaluate(() => document.getElementById("still").hidden), false, "the last picture stays");
  await shot(ctx, "screen-reconnecting.png");
  assert.equal((await holdUntil(ctx, (h) => /Still/.test(h.text))).text, "Still reconnecting to Bob…", "longer: said so, in the same words");
  assert.doesNotMatch(await ctx.page.evaluate(() => document.body.textContent), /tunnel|cloudflare|pool/i);
  await plainFrame(ctx);
  await ctx.page.waitForTimeout(80);
  assert.deepEqual(await hold(), { shown: false, text: "Still reconnecting to Bob…", dimmed: false }, "the next picture takes it down");
  // A fresh stop starts the count anew: "Reconnecting", not "Still".
  assert.deepEqual(await holdUntil(ctx, (h) => h.shown), { shown: true, text: "Reconnecting to Bob…", dimmed: true });
  assert.deepEqual(ctx.errors, []);
});

screenTest("on the slower route, down for long says so; a picture means the channel is up", PLAIN, async (ctx) => {
  const hold = () => ctx.inPage(() => window.pbScreen.hold());
  await ctx.inPage(() => { window.pbScreen.holdAfter(300, 1000); window.pbScreen.info({ title: "Shop", url: "https://shop.example", who: "Bob" }); });
  await plainFrame(ctx);
  assert.equal(await ctx.inPage(() => window.pbScreen.link("up")), true);
  await ctx.page.waitForTimeout(1200);
  assert.deepEqual(await hold(), { shown: false, text: "", dimmed: false }, "a quiet host page on a healthy channel: no wait");
  await ctx.inPage(() => window.pbScreen.link("down"));
  assert.deepEqual(await hold(), { shown: true, text: "Reconnecting to Bob…", dimmed: true }, "the channel down: said at once");
  assert.equal((await holdUntil(ctx, (h) => /Still/.test(h.text))).text, "Still reconnecting to Bob…", "down for long: said so");
  await ctx.inPage(() => window.pbScreen.link("up"));
  assert.equal((await hold()).shown, false, "the channel up again: taken down");
  await ctx.inPage(() => window.pbScreen.link("down"));
  await plainFrame(ctx);
  assert.equal((await holdUntil(ctx, (h) => !h.shown)).shown, false, "a picture takes it down");
  await ctx.page.waitForTimeout(800);
  assert.equal((await hold()).shown, false, "and a picture means the channel is up");
  assert.equal(await ctx.inPage(() => window.pbScreen.link("sideways")), false, "only up or down");
});

test("the picture page keeps its ids, its words, its timers and a flat sheet", () => {
  const html = readFileSync(join(UI, "screen/index.html"), "utf8"), css = readFileSync(join(UI, "screen/screen.css"), "utf8"), js = readFileSync(join(UI, "screen/screen.js"), "utf8");
  for (const id of ["v", "still", "pointers", "status", "status-text", "hold", "hold-text", "top", "tag", "tag-text", "who", "who-text", "addr", "addr-state", "addr-text", "addr-host", "addr-rest", "sound", "pick", "pick-text", "pick-go", "pick-no", "pick-input"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1, `#${id}`);
  }
  for (const text of ["Connecting to the shared tab…", "Turn on sound", "The page asks for a file.", "Choose files", "Cancel"]) assert.ok(html.includes(text), text);
  const hold = css.match(/#hold \{([^}]*)\}/)[1];
  assert.ok(hold.includes("rgb(11 20 33 / 0.35)") && hold.includes("pointer-events: none"), "the hold scrim never takes a click");
  for (const text of ["`Reconnecting to ${who}…`", "`Still reconnecting to ${who}…`", "`${host}'s tab · live`", '"Shared tab · live"', "`Connecting to ${host || \"the host\"}'s tab…`"]) assert.ok(js.includes(text), text);
  const n = (w) => js.split(w).length - 1;
  // The approval card (the approve role): one observer (fully visible before it arms) and one timer
  // (its buttons back when the helper didn't take a click).
  assert.deepEqual([n("setTimeout("), n("setInterval("), n("requestAnimationFrame("), n("new IntersectionObserver(")], [3, 1, 1, 1], "no new timer");
  assert.doesNotMatch(css, /backdrop-filter|gradient\(/);
  // B11 allows one endless animation, the Live dot's 2 s pulse; the connecting dot is static and
  // the hold spinner became a warn dot with the words.
  assert.equal(css.split("@keyframes").length - 1, 1, "the Live dot's pulse only");
  assert.doesNotMatch(css, /box-shadow: 0 0 0 3px/, "no halo rings");
});

screenTest("who works in the host's tab shows in words on the picture, with a dot in their color", PLAIN, async (ctx) => {
  const { page, inPage } = ctx;
  await inPage(() => {
    window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" });
    const c = document.createElement("canvas"); c.width = 320; c.height = 200;
    c.getContext("2d").fillRect(0, 0, 320, 200);
    window.pbScreen.frame(c.toDataURL("image/jpeg").split(",")[1]);
  });
  await ctx.until("frames shown", () => window.pbScreen.state().view === "frames");
  const pill = () => inPage(() => window.pbScreen.whoPill());
  const dot = () => page.evaluate(() => getComputedStyle(document.querySelector("#who .dot")).backgroundColor);
  assert.deepEqual(await pill(), { shown: false, text: "" }, "nobody yet");
  await inPage(() => window.pbScreen.who({ person: "Sam", personColor: "#2fb6d9" }));
  assert.deepEqual(await pill(), { shown: true, text: "Sam is in this tab" });
  assert.equal(await dot(), "rgb(47, 182, 217)");
  assert.equal(await page.evaluate(() => document.getElementById("top").classList.contains("on")), true, "shown with whose tab it is");
  assert.match((await inPage(() => window.pbScreen.inTab())).title, /^Sam · Shop$/);
  const box = await page.evaluate(() => { const s = getComputedStyle(document.getElementById("who")); return { h: document.getElementById("who").getBoundingClientRect().height, shadow: s.boxShadow, blur: s.backdropFilter }; });
  assert.equal(box.h, 28, "a 28 px pill");
  assert.doesNotMatch(box.shadow, /0px 0px 0px 3px/, "no halo");
  await inPage(() => window.pbScreen.who({ agent: "Claude", agentColor: "#e9763f" }));
  assert.deepEqual(await pill(), { shown: true, text: "Claude (agent) is working in it" });
  assert.equal(await dot(), "rgb(233, 118, 63)");
  await inPage(() => window.pbScreen.who({ person: "Sam", personColor: "nope", agent: "Claude", agentColor: "#e9763f" }));
  assert.deepEqual(await pill(), { shown: true, text: "Sam · Claude (agent) working" });
  assert.equal(await dot(), "rgb(233, 118, 63)", "the agent's color when the person's is not a color");
  await inPage(() => window.pbScreen.who({}));
  assert.deepEqual(await pill(), { shown: false, text: "" }, "nobody: gone");
  await inPage(() => window.pbScreen.pointers([{ k: "sam", who: "Sam", color: "#2fb6d9", nx: 0.5, ny: 0.5 }]));
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".p span")).color), "rgb(11, 20, 33)", "dark ink on a pointer's name");
  assert.deepEqual(ctx.errors, []);
});

// The approve role: the host's approval card on the picture page. Allow takes only a person's
// pointer click once the card was fully visible for 600 ms; nothing on the card reaches the host's
// page; a key press never allows; × hides it here only. The others get a notice in words.
screenTest("the host's approval card: armed person clicks only, nothing of it reaches the host's page", PLAIN, async (ctx) => {
  const { page, inPage } = ctx;
  await sendFrame(ctx);
  const ID = `ap-${"a".repeat(32)}`;
  assert.equal(await inPage((id) => window.pbScreen.approval({ id, who: "Bob's Claude Code", color: "#e9763f", target: "Place order", reason: "\"Pay: Place order\" pays: a final action (pay)", site: "shop.example", host: "Bob" }), ID), true);
  assert.equal(await inPage(() => window.pbScreen.approval({ id: "nope" })), false, "a malformed id shows nothing");
  const st = (await inPage(() => window.pbScreen.approvalState()))[0];
  await shot(ctx, "screen-approval.png");
  assert.equal(st.who, "Bob's Claude Code");
  assert.equal(st.site, "In Bob's tab on shop.example");
  await inPage(() => window.pbScreen.takeInput()); // whatever the frame left
  // At once: not armed.
  await page.mouse.click(st.allow.x, st.allow.y);
  let got = await inPage(() => window.pbScreen.approvalAnswers());
  assert.equal(got.a, null, "too soon after it showed");
  await page.waitForTimeout(900);
  // A script's click: nothing.
  await inPage(() => document.getElementById("ap-allow").click());
  // Enter on Allow: never an Allow.
  await page.focus("#ap-allow");
  await page.keyboard.press("Enter");
  got = await inPage(() => window.pbScreen.approvalAnswers());
  assert.equal(got.a, null, "neither a script's click nor a key press allows");
  assert.match(await inPage(() => document.getElementById("ap-hint").textContent), /a key press can't allow/);
  assert.deepEqual((await inPage(() => window.pbScreen.approvalState()))[0].allow, st.allow, "the hint moved nothing");
  await page.mouse.click(st.allow.x, st.allow.y);
  got = await inPage(() => window.pbScreen.approvalAnswers());
  assert.equal(got.a?.kind, "approval-allow");
  assert.equal(got.a?.what, ID);
  assert.equal(got.ids, ID);
  assert.deepEqual(await inPage(() => window.pbScreen.takeInput()), [], "no click or key on the card reached the host's page");
  assert.equal(await inPage((id) => window.pbScreen.approvalOff(id), ID), true);
  assert.deepEqual(await inPage(() => window.pbScreen.approvalState()), []);
  // × hides it here only, and says so to the helper.
  const ID2 = `ap-${"b".repeat(32)}`;
  await inPage((id) => window.pbScreen.approval({ id, who: "Bob's Claude Code", target: "Send", host: "Bob" }), ID2);
  const st2 = (await inPage(() => window.pbScreen.approvalState()))[0];
  await page.mouse.click(st2.close.x, st2.close.y);
  got = await inPage(() => window.pbScreen.approvalAnswers());
  assert.equal(got.dismissed, `,${ID2}`);
  assert.equal(got.a, null);
  // The notice for those who can't answer: words only, takes no click.
  await inPage(() => window.pbScreen.notice("Waiting for Bob to approve: Pay: Place order"));
  assert.equal(await inPage(() => window.pbScreen.noticeText()), "Waiting for Bob to approve: Pay: Place order");
  await shot(ctx, "screen-notice.png");
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById("notice")).pointerEvents), "none");
  await inPage(() => window.pbScreen.notice(""));
  assert.equal(await inPage(() => window.pbScreen.noticeText()), "");
  assert.deepEqual(ctx.errors, []);
  assert.deepEqual(await bad(ctx), []);
});
