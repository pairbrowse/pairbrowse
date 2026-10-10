// The screenshot in results and pairbrowse_click_at (scripts/daemon/screenshot.mjs), on a fake
// page: the password reading runs only with saved passwords, an unchanged picture isn't sent
// twice, a stale picture (another address, a scroll, a closed tab, too old) can't be clicked on,
// the debugger session is let go every time, and nothing of a participant or a tab stays.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createScreenshots } from "../scripts/daemon/screenshot.mjs";

// A JPEG header with a frame of the given width (jpegWidth reads it).
const jpeg = (width, salt = 0) => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x00, width >> 8, width & 0xff, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, salt & 0xff]).toString("base64");

// A page: what its scripts answer, the frames it shows and a debugger that sends one frame.
function fakePage({ url = "https://a.example/x", view = [0, 0, 820, 600], text = ["hello"], frameWidth = 820, frames = 1, noFrame = false, hit = { label: "Count" } } = {}) {
  const state = { url, view, text, closed: false, evaluated: [], sessions: [], clicks: [], frameWidth, noFrame, hit, salt: 0, closeHandlers: [] };
  const evaluate = async (fn) => {
    const src = String(fn);
    state.evaluated.push(src);
    if (src.includes("readyState")) return "complete";
    if (src.includes("scrollX")) return state.view;
    if (src.includes("elementFromPoint")) return state.hit;
    if (src.includes("innerText")) return state.text;
    return null;
  };
  const frame = (i) => ({ evaluate, isDetached: () => false, index: i });
  const page = {
    state,
    isClosed: () => state.closed,
    url: () => state.url,
    frames: () => Array.from({ length: frames }, (_, i) => frame(i)),
    evaluate,
    waitForLoadState: async () => {},
    mouse: { click: async (x, y) => state.clicks.push([x, y]) },
    once: (ev, fn) => { if (ev === "close") state.closeHandlers.push(fn); },
    context: () => ({
      newCDPSession: async () => {
        const handlers = {};
        const cdp = {
          sent: [], detached: false,
          on: (ev, fn) => { handlers[ev] = fn; },
          send: async (method) => {
            cdp.sent.push(method);
            if (method === "Page.startScreencast" && !state.noFrame) setTimeout(() => handlers["Page.screencastFrame"]?.({ data: jpeg(state.frameWidth, state.salt), sessionId: 1, metadata: { deviceWidth: state.view[2], deviceHeight: state.view[3], scrollOffsetX: state.view[0], scrollOffsetY: state.view[1] } }), 5);
            return {};
          },
          detach: async () => { cdp.detached = true; },
        };
        state.sessions.push(cdp);
        return cdp;
      },
    }),
  };
  return page;
}

const make = (values = {}, extra = {}) => {
  const log = [];
  const peers = [];
  const shots = createScreenshots({ secrets: () => ({ values }), log: (t) => log.push(t), hidePeers: async (p, hidden) => peers.push(hidden), ...extra });
  return { shots, log, peers };
};

test("screenshot: no password reading without saved passwords, a picture, then 'same' for the same bytes", async () => {
  const page = fakePage();
  const { shots, peers } = make();
  const first = await shots.take(page, "p1");
  assert.ok(first?.data, "a picture");
  assert.ok(!page.state.evaluated.some((s) => s.includes("innerText")), "the page's text isn't read when no password is saved");
  assert.deepEqual(peers, [true, false], "other pointers hidden for the picture and shown again");
  assert.deepEqual(await shots.take(page, "p1"), { same: true }, "the same bytes again: no new picture");
  page.state.salt = 1;
  assert.ok((await shots.take(page, "p1"))?.data, "different bytes: a picture");
  assert.ok((await shots.take(page, "p2"))?.data, "another participant's first picture is sent to them");
  assert.ok(page.state.sessions.every((c) => c.detached), "every debugger session let go");
  assert.ok(page.state.sessions.every((c) => c.sent.includes("Page.stopScreencast")), "every screencast stopped");
  // Two participants' pictures of one tab at once: each on a session of its own, both get one.
  const both = await Promise.all([shots.take(page, "a"), shots.take(page, "b")]);
  assert.ok(both.every((r) => r?.data), "both get a picture");
  assert.ok(page.state.sessions.every((c) => c.detached));
});

test("screenshot: with a saved password the page's text is read, and a visible one means no picture", async () => {
  const page = fakePage({ text: ["Password: hunter22"] });
  const { shots } = make({ SITE_PASSWORD: "hunter22" });
  const r = await shots.take(page, "p1");
  assert.match(r.skipped, /saved password is visible/);
  assert.ok(page.state.evaluated.some((s) => s.includes("innerText")), "the text was read");
  page.state.text = ["nothing to see"];
  assert.ok((await shots.take(page, "p1"))?.data);
});

test("screenshot: a page that sends no frame still gets its debugger session let go", { timeout: 10_000 }, async () => {
  const page = fakePage({ noFrame: true });
  const { shots } = make();
  assert.equal(await shots.take(page, "p1"), null);
  assert.equal(page.state.sessions.length, 1);
  await new Promise((r) => setImmediate(r));
  assert.ok(page.state.sessions[0].detached);
});

test("click_at: clicks map onto the page the picture showed, and refuse a stale picture", async () => {
  let t = 1_000_000;
  const page = fakePage({ view: [0, 0, 1640, 1200], frameWidth: 820 }); // a 2x picture
  const { shots } = make({}, { now: () => t });
  assert.match((await shots.clickAt({ x: 10, y: 10 }, "p1")).text, /No screenshot to click on yet/);
  await shots.take(page, "p1");
  let r = await shots.clickAt({ x: 10, y: 20 }, "p1", { current: page });
  assert.equal(r.error, undefined, r.text);
  assert.deepEqual(page.state.clicks, [[20, 40]], "picture pixels times the scale");
  assert.match(r.text, /Clicked "Count" at 20,40/);
  // Another tab now.
  r = await shots.clickAt({ x: 10, y: 20 }, "p1", { current: fakePage() });
  assert.match(r.text, /another tab/);
  // The page moved on.
  page.state.url = "https://a.example/y";
  r = await shots.clickAt({ x: 10, y: 20 }, "p1", { current: page });
  assert.match(r.text, /moved on since the last screenshot/);
  page.state.url = "https://a.example/x";
  // Scrolled.
  page.state.view = [0, 300, 1640, 1200];
  r = await shots.clickAt({ x: 10, y: 20 }, "p1", { current: page });
  assert.match(r.text, /scrolled since/);
  page.state.view = [0, 0, 1640, 1200];
  // Resized.
  page.state.view = [0, 0, 1000, 1200];
  r = await shots.clickAt({ x: 10, y: 20 }, "p1", { current: page });
  assert.match(r.text, /changed size/);
  page.state.view = [0, 0, 1640, 1200];
  // Too old.
  t += 121_000;
  r = await shots.clickAt({ x: 10, y: 20 }, "p1", { current: page });
  assert.match(r.text, /is 121 s old/);
  t -= 121_000;
  // Outside the picture.
  r = await shots.clickAt({ x: 900, y: 20 }, "p1", { current: page });
  assert.match(r.text, /outside the last screenshot/);
  // Closed.
  page.state.closed = true;
  r = await shots.clickAt({ x: 10, y: 20 }, "p1", { current: page });
  assert.match(r.text, /has closed/);
  assert.equal(page.state.clicks.length, 1, "only the one click went to the page");
});

test("click_at: a spot in a frame, a paying spot and nothing at all are refused", async () => {
  const page = fakePage({ hit: { frame: true } });
  const { shots } = make();
  await shots.take(page, "p1");
  assert.match((await shots.clickAt({ x: 1, y: 1 }, "p1")).text, /inside a frame/);
  page.state.hit = { label: "Pay now", risk: { kind: "pay", word: "pay", why: ["payment"], strong: true } };
  const r = await shots.clickAt({ x: 1, y: 1 }, "p1");
  assert.ok(r.error);
  page.state.hit = null;
  assert.match((await shots.clickAt({ x: 1, y: 1 }, "p1")).text, /Nothing at that spot/);
});

test("screenshot: a participant who left and a tab that closed leave nothing behind", async () => {
  const a = fakePage(), b = fakePage({ url: "https://b.example/" });
  const { shots } = make();
  await shots.take(a, "p1");
  await shots.take(b, "p2");
  assert.deepEqual([...shots.held().keys()], ["p1", "p2"]);
  for (const [, h] of shots.held()) assert.ok(h.hash && h.url && !("data" in h), "no image bytes are kept");
  shots.forget("p1");
  assert.deepEqual([...shots.held().keys()], ["p2"]);
  shots.forgetPage(b);
  assert.equal(shots.held().size, 0);
  assert.match((await shots.clickAt({ x: 1, y: 1 }, "p2")).text, /No screenshot to click on yet/);
});
