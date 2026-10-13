// The joiner's picture page (ui/screen/) over the pages' harness: in the build (window.pairbrowse
// present) it asks for the helper once and calls no route; its title carries the host's name; the
// hold watch stops while hidden; its glyphs are nodes (Trusted Types); the file card is a keyboard
// dialog; the Live dot is the one pulse, still under reduced motion. Driven through
// window.pbScreen, as the joiner's helper drives it. The common checks stay in test/ui.test.mjs.
// Built as test/ui-panel.test.mjs's pageTest is, with a name for each case.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { patchright } from "./live.mjs";
import { openPage, runtime } from "./helpers/ui-page.mjs";
import { startFakeHelper, merge } from "./helpers/fake-helper.mjs";
import { defaultFixture } from "./helpers/pairbrowse-shim.mjs";

const VIEWPORT = { width: 1200, height: 760 };
const SHOTS = process.env.PAIRBROWSE_TEST_SHOTS;

function screenTest(title, opts, fn) {
  test(`screen page: ${title}`, { skip: !runtime, timeout: 60_000 }, async () => {
    const browser = await patchright(runtime).chromium.launch();
    let helper = null, ctx = null;
    try {
      helper = await startFakeHelper({ pageOrigin: null });
      ctx = await openPage(browser, "screen", { helper, fixture: merge(defaultFixture(), {}), viewport: VIEWPORT, reducedMotion: opts.reducedMotion });
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

screenTest("renders over the fake helper and asks the build for its helper once, calling no route", {}, async (ctx) => {
  await ctx.inPage(() => window.pbScreen.info({ title: "Shop", url: "https://shop.example/cart", who: "Bob" }));
  await sendFrame(ctx);
  await ctx.inPage(() => window.pbScreen.pointers([{ k: "sam", who: "Sam", color: "#2fb6d9", nx: 0.5, ny: 0.5 }]));
  await ctx.inPage(() => window.pbScreen.who({ person: "Sam", personColor: "#2fb6d9" }));
  assert.deepEqual(ctx.errors, []);
  assert.deepEqual(await bad(ctx), []);
  const calls = (await ctx.shim.calls()).filter((c) => c.iface === "session" && c.method === "helper");
  assert.equal(calls.length, 1, "session.helper() once");
  assert.equal(ctx.helper.posts.length, 0, "no route called");
  assert.equal((await ctx.harness.live()).eventSources, 0, "no stream opened");
  const st = await ctx.inPage(() => window.pbScreen.state());
  assert.equal(st.host, "pairbrowse");
  assert.equal(st.helper, true);
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
