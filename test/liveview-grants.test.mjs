// The live view's hand-off grant server (liveview/grants.mjs, routes/turn.mjs; spec server-mode
// B-AP1, B3, B4, B5): the landing page a link preview may open without using anything up, the one
// tap that does, the view key's one stream, its routes and refusals, what it gets (its own tabs
// only, as they are) and the picture pinned to its tabs. Fake tabs, no browser.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLiveView, createInvites } from "../scripts/liveview.mjs";
import { createGrants } from "../scripts/daemon/grants.mjs";
import { createAudit } from "../scripts/daemon/audit.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(10)) if (await fn()) return true; return false; };
const eventsIn = (text, name) => text.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));

// Tabs with addresses, openers and CDP sessions that answer stills and count what they're asked.
function fakeTabs(urls) {
  const sessions = [];
  const ctx = Object.assign(new EventEmitter(), { pages: () => pages, newPage: async () => { throw new Error("no new tabs here"); } });
  const tab = (url, opener = null) => {
    const p = Object.assign(new EventEmitter(), {
      url: () => url, title: async () => `Title of ${url}`, context: () => ctx, bringToFront: async () => {}, evaluate: async () => null,
      opener: async () => opener, isClosed: () => !pages.includes(p),
    });
    return p;
  };
  const pages = urls.map((u) => tab(u));
  ctx.newCDPSession = async (page) => {
    const cdp = Object.assign(new EventEmitter(), { calls: [], detached: false, page });
    cdp.send = async (method, params) => { cdp.calls.push([method, params]); return method === "Page.captureScreenshot" ? { data: Buffer.from(`STILL ${page.url()}`).toString("base64") } : {}; };
    cdp.detach = async () => { cdp.detached = true; };
    sessions.push(cdp);
    return cdp;
  };
  // A new tab that page opened (a pop-up), announced as the browser does.
  const open = (url, opener) => { const p = tab(url, opener); pages.push(p); ctx.emit("page", p); return p; };
  const close = (p) => { pages.splice(pages.indexOf(p), 1); p.emit("close"); };
  const sessionOf = (page) => sessions.filter((s) => s.page === page).at(-1);
  return { ctx, pages, sessions, open, close, sessionOf };
}

function request(port, method, path, { body, host = `127.0.0.1:${port}`, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, ...(origin ? { origin } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => { const bytes = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, text: bytes.toString("utf8"), bytes }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
// An event stream kept open: its text so far, its status, whether the server ended it.
function readStream(port, path, { host = `127.0.0.1:${port}`, origin } = {}) {
  return new Promise((resolve) => {
    let text = "", ended = false;
    const req = http.get({ host: "127.0.0.1", port, path, headers: { host, ...(origin ? { origin } : {}) } }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => { ended = true; });
      resolve({ status: res.statusCode, text: () => text, ended: () => ended, close: () => req.destroy() });
    });
    req.on("error", () => {});
  });
}

// A live view with a grant table on clocks the test moves, an audit file, and card covers that
// mark what they cover.
async function setup({ urls = ["https://shop.example/pay", "https://other.example/"], agentAt = 1, hosts = [], inviteOrigin = null, tools = null } = {}) {
  const tabs = fakeTabs(urls);
  const clock = { t: 1_800_000_000_000, m: 1_000 };
  const file = join(mkdtempSync(join(tmpdir(), "pb-lvgrants-")), "audit.jsonl");
  const audit = createAudit({ file, now: () => clock.t });
  const grants = createGrants({ now: () => clock.t, mono: () => clock.m, audit, timers: { set: () => null, clear: () => {} } });
  const invites = createInvites();
  let agentUrl = urls[agentAt];
  const covers = { want: () => {}, picture: async (_page, img) => `COVERED-${img}` };
  const view = await startLiveView({ getContext: async () => tabs.ctx, currentUrl: async () => agentUrl, invites, grants, covers, hosts, inviteOrigin, ...(tools ? { tools: typeof tools === "function" ? tools(tabs) : tools } : {}) });
  view.setSession({ name: "default", where: "Local" });
  const key = view.url.split("/").at(-2);
  const audited = () => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const mint = (page = tabs.pages[0], action = "payment") => grants.mint({ session: "default", page, action });
  // Mints and taps: the grant and its view key.
  const taken = async (page) => {
    const g = mint(page);
    const r = await request(view.port, "POST", `/${g.redeemKey}/redeem`, { body: {} });
    assert.equal(r.status, 200, r.text);
    const { view: at } = JSON.parse(r.text);
    return { ...g, viewKey: at.slice(1, -1) };
  };
  return { ...tabs, clock, grants, invites, view, key, audited, mint, taken, setAgent: (u) => { agentUrl = u; }, port: view.port };
}

test("a preview-bot GET leaves the grant valid; the tap consumes it; a second tap is refused", async () => {
  const s = await setup();
  try {
    const g = s.mint(s.pages[0], "login");
    // A chat app's link preview fetches the link, maybe more than once: the landing page, nothing used up.
    for (let i = 0; i < 3; i++) {
      const page = await request(s.port, "GET", `/${g.redeemKey}/`);
      assert.equal(page.status, 200);
      assert.match(page.text, /Sign in on shop\.example/);
      assert.match(page.text, /Take over/);
      assert.match(page.headers["content-security-policy"], /script-src 'self'/);
      assert.equal(page.text.includes(g.redeemKey), false, "the page never repeats its key");
    }
    assert.equal((await request(s.port, "GET", `/${g.redeemKey}`)).status, 308, "its files load relative to the slash");
    assert.equal((await request(s.port, "GET", `/${g.redeemKey}/assets/liveview-redeem.js`)).status, 200);
    assert.equal((await request(s.port, "GET", `/${g.redeemKey}/assets/liveview-redeem.css`)).status, 200);
    assert.equal(s.grants.open()[0].redeemed, false, "nothing was used up");
    // The tap.
    const tap = await request(s.port, "POST", `/${g.redeemKey}/redeem`, { body: {} });
    assert.equal(tap.status, 200);
    const { view } = JSON.parse(tap.text);
    assert.match(view, /^\/[0-9a-f]{64}\/$/);
    assert.equal(s.grants.open()[0].redeemed, true);
    // A second tap, or the landing page again: as a link never made, and audited as reuse.
    assert.equal((await request(s.port, "POST", `/${g.redeemKey}/redeem`, { body: {} })).status, 404);
    assert.equal((await request(s.port, "GET", `/${g.redeemKey}/`)).status, 404);
    assert.ok(s.audited().some((l) => l.kind === "reuse" && l.detail === "redeem-key"));
    // The view key opens the viewer as role turn (liveview.js then loads the phone viewer, liveview-turn.js).
    const page = await request(s.port, "GET", view);
    assert.equal(page.status, 200);
    assert.match(page.text, /<body data-role="turn" /);
  } finally { s.view.close(); }
});

test("role turn is refused tab, pause, profile, journal, invite, tools, config and nav go; role redeem may only GET the page and POST redeem", async () => {
  const s = await setup();
  try {
    const g = s.mint();
    const k = g.redeemKey;
    // Before the tap: the landing page and its tap, nothing else.
    for (const [method, path, body] of [["GET", "events"], ["GET", "thumb.jpg"], ["GET", "state.json"], ["POST", "input", { type: "char", text: "a" }], ["POST", "turn-done", {}], ["POST", "turn", { show: "00000000" }],
      ["POST", "tab", { i: 0 }], ["POST", "pause", { paused: true }], ["GET", "profile.json"], ["GET", "journal.json"], ["POST", "invite", { share: "link" }], ["GET", "downloads.json"], ["GET", "config.json"]]) {
      assert.equal((await request(s.port, method, `/${k}/${path}`, { body })).status, 403, `redeem: ${method} /${path}`);
    }
    assert.equal(s.grants.open()[0].redeemed, false);
    const t = await s.taken(s.pages[0]);
    const v = t.viewKey;
    for (const [method, path, body] of [["POST", "tab", { i: 1 }], ["POST", "tab", { new: true }], ["POST", "pause", { paused: true }], ["GET", "profile.json"], ["GET", "journal.json"],
      ["POST", "invite", { share: "link" }], ["GET", "invites.json"], ["GET", "downloads.json"], ["GET", "handoffs.json"], ["GET", "config.json"], ["POST", "config", {}], ["POST", "session", { op: "save" }],
      ["GET", "layout.json"], ["GET", "approvals.json"], ["POST", "turn-revoke", { id: t.id }], ["POST", "redeem", {}]]) {
      const r = await request(s.port, method, `/${v}/${path}`, { body });
      assert.ok(r.status === 403 || (path === "redeem" && r.status === 404), `turn: ${method} /${path} is ${r.status}`);
    }
    // Nav go is dropped; back, forward and reload replay.
    const events = await readStream(s.port, `/${v}/events`);
    try {
      await until(() => eventsIn(events.text(), "turn").at(-1)?.state === "on");
      const cdp = s.sessionOf(s.pages[0]);
      let went = false;
      s.pages[0].goto = async () => { went = true; };
      let reloaded = false;
      s.pages[0].reload = async () => { reloaded = true; };
      assert.equal((await request(s.port, "POST", `/${v}/input`, { body: { type: "nav", action: "go", url: "https://evil.example/" } })).status, 204);
      assert.equal((await request(s.port, "POST", `/${v}/input`, { body: [{ type: "nav", action: "reload" }, { type: "char", text: "7" }] })).status, 204);
      await until(() => reloaded && cdp.calls.some(([m, p]) => m === "Input.dispatchKeyEvent" && p.text === "7"));
      assert.equal(went, false, "a hand-off never types an address");
      assert.equal(reloaded, true);
    } finally { events.close(); }
  } finally { s.view.close(); }
});

test("a turn POST from another Origin or Host is refused; a grant key on the join-code port is 404", async () => {
  const s = await setup({ hosts: ["box.tail.example"], inviteOrigin: "https://box.tail.example" });
  try {
    const g = s.mint();
    // Another site posting the tap: refused, nothing used up, audited.
    assert.equal((await request(s.port, "POST", `/${g.redeemKey}/redeem`, { body: {}, origin: "https://evil.example" })).status, 403);
    assert.equal(s.grants.open()[0].redeemed, false);
    assert.ok(s.audited().some((l) => l.kind === "input-refused" && l.detail === "not-allowed" && l.grant === g.id));
    // Another Host (DNS rebinding): refused before any key is read.
    assert.equal((await request(s.port, "GET", `/${g.redeemKey}/`, { host: "evil.example" })).status, 403);
    // The join-code port never takes a grant key.
    assert.equal((await request(s.view.guestPort, "GET", `/${g.redeemKey}/`)).status, 404);
    assert.equal((await request(s.view.guestPort, "POST", `/${g.redeemKey}/redeem`, { body: {} })).status !== 200, true);
    // From the tailnet name and its origin, as invite links.
    const tap = await request(s.port, "POST", `/${g.redeemKey}/redeem`, { body: {}, host: "box.tail.example", origin: "https://box.tail.example" });
    assert.equal(tap.status, 200);
    const v = JSON.parse(tap.text).view.slice(1, -1);
    assert.equal((await request(s.port, "POST", `/${v}/turn-done`, { body: {}, origin: "https://evil.example" })).status, 403);
    // A stream another site opens would hold the one stream: refused and audited.
    const foreign = await readStream(s.port, `/${v}/events`, { origin: "https://evil.example" });
    assert.equal(foreign.status, 403);
    foreign.close();
    assert.ok(s.audited().some((l) => l.kind === "stream-refused" && l.detail === "other-origin"));
    // Any other GET from another site (the landing page, a still): refused, and not called a stream.
    const g2 = s.mint(s.pages[1]);
    assert.equal((await request(s.port, "GET", `/${g2.redeemKey}/`, { origin: "https://evil.example" })).status, 403);
    assert.equal((await request(s.port, "GET", `/${v}/thumb.jpg`, { origin: "https://evil.example" })).status, 403);
    assert.deepEqual(s.audited().filter((l) => l.kind === "request-refused").map((l) => [l.grant, l.detail]), [[g2.id, "other-origin"], [g.id, "other-origin"]]);
    assert.equal(s.grants.open()[1].redeemed, false, "nothing was used up");
    assert.equal(s.audited().filter((l) => l.kind === "stream-refused").length, 1, "only the event stream is audited as one");
    assert.equal((await request(s.view.guestPort, "GET", `/${v}/events`)).status, 404);
    assert.equal(s.grants.open().length, 2, "the grants are still there");
  } finally { s.view.close(); }
});

test("a second concurrent stream is 409; a reconnect after a drop works within the grant's life", async () => {
  const s = await setup();
  try {
    const t = await s.taken(s.pages[0]);
    const first = await readStream(s.port, `/${t.viewKey}/events`);
    assert.equal(first.status, 200);
    const second = await readStream(s.port, `/${t.viewKey}/events`);
    assert.equal(second.status, 409);
    second.close();
    assert.ok(s.audited().some((l) => l.kind === "stream-refused" && l.detail === "second-stream"));
    first.close(); // the phone's network drops
    await until(() => !s.grants.open()[0].streaming);
    s.clock.t += 5 * 60_000; s.clock.m += 5 * 60_000;
    const again = await readStream(s.port, `/${t.viewKey}/events`);
    assert.equal(again.status, 200, "the same device comes back with the same key");
    await until(() => eventsIn(again.text(), "turn").length);
    const turn = eventsIn(again.text(), "turn")[0];
    assert.deepEqual(Object.keys(turn).sort(), ["action", "expiresAt", "host", "id", "savedCard", "scope", "state"]);
    assert.equal(turn.savedCard, false, "no saved card: the viewer offers no Fill saved card");
    assert.equal(turn.host, "shop.example");
    assert.equal(turn.action, "payment");
    again.close();
  } finally { s.view.close(); }
});

test("at expiry the stream gets turn-ended and later input is 404", async () => {
  const s = await setup();
  try {
    const t = await s.taken(s.pages[0]);
    const stream = await readStream(s.port, `/${t.viewKey}/events`);
    await until(() => eventsIn(stream.text(), "turn").length);
    s.clock.t += 16 * 60_000; s.clock.m += 16 * 60_000;
    s.grants.sweep(); // the grant's own timer, at its deadline
    assert.ok(await until(() => stream.ended()), "the stream closes");
    assert.deepEqual(eventsIn(stream.text(), "turn-ended"), [{ reason: "expired" }]);
    assert.equal((await request(s.port, "POST", `/${t.viewKey}/input`, { body: { type: "char", text: "1" } })).status, 404);
    assert.equal((await request(s.port, "GET", `/${t.viewKey}/events`)).status, 404);
  } finally { s.view.close(); }
});

test("owner revoke and invites revoke_all end the grant; Done ends it as done", async () => {
  const s = await setup();
  try {
    let t = await s.taken(s.pages[0]);
    let stream = await readStream(s.port, `/${t.viewKey}/events`);
    await until(() => eventsIn(stream.text(), "turn").length);
    assert.equal((await request(s.port, "POST", `/${s.key}/turn-revoke`, { body: { id: "00000000" } })).status, 404);
    assert.equal((await request(s.port, "POST", `/${s.key}/turn-revoke`, { body: { id: t.id } })).status, 200);
    assert.ok(await until(() => stream.ended()));
    assert.deepEqual(eventsIn(stream.text(), "turn-ended"), [{ reason: "revoked" }]);

    t = await s.taken(s.pages[0]);
    stream = await readStream(s.port, `/${t.viewKey}/events`);
    await until(() => eventsIn(stream.text(), "turn").length);
    s.invites.revokeAll(); // pairbrowse_invite revoke_all
    assert.ok(await until(() => stream.ended()));
    assert.deepEqual(eventsIn(stream.text(), "turn-ended"), [{ reason: "revoked" }]);
    assert.equal(s.grants.open().length, 0);

    t = await s.taken(s.pages[0]);
    stream = await readStream(s.port, `/${t.viewKey}/events`);
    await until(() => eventsIn(stream.text(), "turn").length);
    assert.equal((await request(s.port, "POST", `/${t.viewKey}/turn-done`, { body: {} })).status, 200);
    assert.ok(await until(() => stream.ended()));
    assert.deepEqual(eventsIn(stream.text(), "turn-ended"), [{ reason: "done" }]);
    assert.ok(s.audited().some((l) => l.kind === "ended" && l.detail === "done"));
  } finally { s.view.close(); }
});

test("a key presented while another session is open ends the grant", async () => {
  const s = await setup();
  try {
    const t = await s.taken(s.pages[0]);
    s.view.setSession({ name: "work", where: "Local" });
    assert.equal((await request(s.port, "GET", `/${t.viewKey}/state.json`)).status, 404);
    assert.equal(s.grants.open().length, 0);
    assert.ok(s.audited().some((l) => l.kind === "ended" && l.detail === "session-switched"));
  } finally { s.view.close(); }
});

test("frames, thumb, state and tabs come only from scope", async () => {
  const s = await setup();
  const w = s.invites.create({ role: "watch", label: "W" });
  const streams = [];
  try {
    const t = await s.taken(s.pages[0]);
    const turn = await readStream(s.port, `/${t.viewKey}/events`);
    const guest = await readStream(s.port, `/${w.key}/events`);
    const owner = await readStream(s.port, `/${s.key}/events`);
    streams.push(turn, guest, owner);
    // The picture moves to the handed-over tab although the agent works in the other one.
    assert.ok(await until(() => s.sessionOf(s.pages[0]) && eventsIn(turn.text(), "turn").at(-1)?.state === "on"));
    const frame = (page, img) => s.sessionOf(page).emit("Page.screencastFrame", { data: img, metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 1 });
    frame(s.pages[0], "SCOPE-1");
    await until(() => eventsIn(guest.text(), "frame").length && eventsIn(turn.text(), "frame").length);
    assert.deepEqual(eventsIn(turn.text(), "frame").map((f) => f.img), ["SCOPE-1"], "the person sees the card field they type into");
    assert.deepEqual(eventsIn(guest.text(), "frame").map((f) => f.img), ["COVERED-SCOPE-1"], "another guest keeps card covers");
    // Tabs: the turn stream lists only its own.
    const listed = eventsIn(turn.text(), "tabs").at(-1);
    assert.deepEqual(listed.map((x) => x.url), ["https://shop.example/pay"]);
    assert.equal(eventsIn(owner.text(), "tabs").at(-1).length, 2, "the owner sees every tab");
    let state = JSON.parse((await request(s.port, "GET", `/${t.viewKey}/state.json`)).text);
    assert.deepEqual(state.tabs.map((x) => x.url), ["https://shop.example/pay"]);
    const still = await request(s.port, "GET", `/${t.viewKey}/thumb.jpg`);
    assert.equal(still.status, 200);
    assert.equal(still.bytes.toString(), "STILL https://shop.example/pay", "its still as it is");
    // The owner shows the other tab: no frame, still or input reaches the hand-off from it.
    assert.equal((await request(s.port, "POST", `/${s.key}/tab`, { body: { i: 1 } })).status, 204);
    await until(() => s.sessionOf(s.pages[1]));
    frame(s.pages[1], "OTHER-1");
    await until(() => eventsIn(owner.text(), "frame").some((f) => f.img === "OTHER-1"));
    assert.equal(turn.text().includes("OTHER-1"), false);
    assert.equal((await request(s.port, "GET", `/${t.viewKey}/thumb.jpg`)).status, 409);
    const refused = await request(s.port, "POST", `/${t.viewKey}/input`, { body: { type: "char", text: "4" } });
    assert.equal(refused.status, 409);
    assert.match(refused.text, /That tab isn't on screen/);
    assert.ok(s.audited().some((l) => l.kind === "input-refused" && l.detail === "out-of-scope"));
    assert.equal(s.sessionOf(s.pages[1]).calls.some(([m]) => m === "Input.dispatchKeyEvent"), false);
    // Switching to a tab outside the grant: refused; to its own: shown.
    assert.equal((await request(s.port, "POST", `/${t.viewKey}/turn`, { body: { show: "00000000" } })).status, 409);
    const own = eventsIn(turn.text(), "turn").at(-1).scope[0].id;
    assert.equal((await request(s.port, "POST", `/${t.viewKey}/turn`, { body: { show: own } })).status, 200);
    assert.ok(await until(() => eventsIn(turn.text(), "turn").at(-1)?.state === "on"));
    state = JSON.parse((await request(s.port, "GET", `/${t.viewKey}/state.json`)).text);
    assert.deepEqual(state.tabs.map((x) => x.url), ["https://shop.example/pay"]);
  } finally { for (const x of streams) x.close(); s.view.close(); }
});

test("the cast stays pinned while the agent's URL changes elsewhere", async () => {
  const s = await setup({ urls: ["https://shop.example/pay", "https://a.example/", "https://b.example/"] });
  try {
    const t = await s.taken(s.pages[0]);
    const turn = await readStream(s.port, `/${t.viewKey}/events`);
    const shownUrl = async () => JSON.parse((await request(s.port, "GET", `/${s.key}/state.json`)).text).tabs.find((x) => x.shown)?.url;
    assert.ok(await until(async () => (await shownUrl()) === "https://shop.example/pay"));
    s.setAgent("https://b.example/");
    await s.view.follow();
    assert.equal(await shownUrl(), "https://shop.example/pay", "the agent's next tab doesn't move the hand-off's picture");
    // Once the stream is gone the picture follows the agent again.
    turn.close();
    await until(() => !s.grants.open()[0].streaming);
    s.setAgent("https://a.example/");
    await s.view.follow();
    assert.equal(await shownUrl(), "https://a.example/");
  } finally { s.view.close(); }
});

test("a tab opened by the grant tab joins scope; another does not", async () => {
  const s = await setup();
  try {
    const t = await s.taken(s.pages[0]);
    s.view.watchGrants();
    await wait(20);
    const turn = await readStream(s.port, `/${t.viewKey}/events`);
    await until(() => eventsIn(turn.text(), "turn").length);
    const popup = s.open("https://bank.example/3ds", s.pages[0]);
    const stray = s.open("https://elsewhere.example/", s.pages[1]);
    assert.ok(await until(() => s.grants.inScope(popup, t.id)), "the 3-D Secure pop-up joins");
    assert.equal(s.grants.inScope(stray, t.id), false);
    assert.ok(await until(() => eventsIn(turn.text(), "turn").at(-1)?.scope.length === 2), "the viewer hears its new tab");
    // The pop-up closing leaves the scope; the handed-over tab closing ends the grant.
    s.close(popup);
    assert.equal(s.grants.inScope(popup, t.id), false);
    s.close(s.pages[0]);
    assert.ok(await until(() => turn.ended()));
    assert.deepEqual(eventsIn(turn.text(), "turn-ended"), [{ reason: "tab-closed" }]);
  } finally { s.view.close(); }
});

test("a tab closing while the tab list is built never lets another tab into a hand-off's list", async () => {
  const s = await setup({ urls: ["https://earlier.example/", "https://shop.example/pay", "https://other.example/"], agentAt: 2 });
  try {
    const t = await s.taken(s.pages[1]);
    // The earlier tab answers its title slowly and closes meanwhile: every later tab's number shifts.
    const earlier = s.pages[0];
    let asked = null;
    earlier.title = () => new Promise((r) => { asked = r; });
    const state = request(s.port, "GET", `/${t.viewKey}/state.json`);
    assert.ok(await until(() => asked));
    s.close(earlier);
    asked("Earlier");
    const tabs = JSON.parse((await state).text).tabs;
    assert.deepEqual(tabs.map((x) => x.url), ["https://shop.example/pay"], "only the handed-over tab, by its own id");
  } finally { s.view.close(); }
});

test("after Done the picture goes back to the agent's tab although its address never changed", async () => {
  const s = await setup();
  try {
    const t = await s.taken(s.pages[0]);
    const turn = await readStream(s.port, `/${t.viewKey}/events`);
    const tabsNow = async () => JSON.parse((await request(s.port, "GET", `/${s.key}/state.json`)).text).tabs;
    const shownUrl = async () => (await tabsNow()).find((x) => x.shown)?.url;
    assert.ok(await until(async () => (await shownUrl()) === "https://shop.example/pay"));
    await s.view.follow(); // the agent stays at https://other.example/ the whole time
    assert.equal(await shownUrl(), "https://shop.example/pay");
    assert.equal((await tabsNow()).find((x) => x.claude)?.url, "https://other.example/", "the agent's tab stays marked during the pin");
    assert.equal((await request(s.port, "POST", `/${t.viewKey}/turn-done`, { body: {} })).status, 200);
    assert.ok(await until(() => turn.ended()));
    assert.ok(await until(async () => (await shownUrl()) === "https://other.example/"), "the picture follows the agent again");
  } finally { s.view.close(); }
});

// "Add a saved card" (spec server-mode B12): the browser's payment methods page is the one browser
// page the live view shows, and only as a person's own tab, to the owner's streams only.
test("cast: a person's own tab at the payment methods page is shown; the same address in another tab, other settings pages and PairBrowse's own pages stay hidden", async () => {
  const { createCast } = await import("../scripts/liveview/cast.mjs");
  const ctx = { pages: () => [] };
  ctx.newCDPSession = async (page) => Object.assign(new EventEmitter(), { page, send: async () => ({}), detach: async () => {} });
  const tab = (url) => Object.assign(new EventEmitter(), { url: () => url, context: () => ctx, bringToFront: async () => {}, isClosed: () => false });
  const person = new Set();
  const mine = (url) => { const p = tab(url); person.add(p); return p; };
  const cast = createCast({ getContext: async () => ctx, currentUrl: async () => "", personTab: (p) => person.has(p), replayer: { attach: async () => {}, startCast: async () => {}, resetFit() {} },
    broadcast: () => {}, tabsInfo: async () => [], viewers: new Set(), watching: () => false, isClosed: () => false, log: () => {} });
  const shows = async (page) => { await cast.show(page); return cast.state.shown?.page === page; };
  assert.equal(await shows(tab("https://shop.example/")), true, "a web tab");
  assert.equal(await shows(mine("chrome://settings/payments")), true, "the person's own payment methods tab");
  assert.equal(await shows(mine("chrome://settings/payments/")), true);
  for (const [why, page] of [
    ["the same address in a tab that isn't the person's", tab("chrome://settings/payments")],
    ["another settings page, the person's own", mine("chrome://settings/passwords")],
    ["the settings start page", mine("chrome://settings/")],
    ["an address that only starts the same", mine("chrome://settings/paymentsx")],
    ["PairBrowse's own page", mine("pairbrowse://sessions/")],
    ["PairBrowse's own page, the other spelling", mine("chrome://pairbrowse/sessions/")],
  ]) assert.equal(await shows(page), false, why);
  cast.close();
});

test("the payment methods tab's frames reach the owner's streams only: never an invite guest or a hand-off viewer", async () => {
  const person = new Set();
  let cardTab = null;
  const s = await setup({ tools: (tabs) => ({
    personTab: (p) => person.has(p),
    savedCard: () => ({ asked: true, on: true, store: "key-file", line: "Saved card: on" }),
    openTab: async (url) => { cardTab = tabs.open(url, null); person.add(cardTab); return { ok: true, page: cardTab }; },
  }) });
  const w = s.invites.create({ role: "watch", label: "W" });
  const streams = [];
  const frame = (page, img) => s.sessionOf(page).emit("Page.screencastFrame", { data: img, metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 1 });
  try {
    const owner = await readStream(s.port, `/${s.key}/events`);
    const guest = await readStream(s.port, `/${w.key}/events`);
    streams.push(owner, guest);
    assert.ok(await until(() => s.sessionOf(s.pages[1])), "the agent's tab on screen first");
    assert.equal((await request(s.port, "POST", `/${w.key}/saved-card`, { body: {} })).status, 403, "the owner's only");
    assert.equal((await request(s.port, "POST", `/${s.key}/saved-card`, { body: {} })).status, 200);
    assert.ok(cardTab && await until(() => s.sessionOf(cardTab)), "shown");
    frame(cardTab, "CARD-1");
    assert.ok(await until(() => eventsIn(owner.text(), "frame").some((f) => f.img === "CARD-1")), "the owner sees the page they add the card on");
    await wait(50);
    assert.equal(guest.text().includes("CARD-1"), false, "never an invite guest, covered or not");
    // A hand-off viewer: its stream gets no frame of the person's tab either, though it is on screen.
    const t = await s.taken(s.pages[0]);
    const turn = await readStream(s.port, `/${t.viewKey}/events`);
    streams.push(turn);
    assert.ok(await until(() => eventsIn(turn.text(), "turn").length));
    assert.equal((await request(s.port, "POST", `/${s.key}/saved-card`, { body: {} })).status, 200, "a second tap brings the same tab forward");
    assert.ok(await until(() => s.sessionOf(cardTab) && !s.sessionOf(cardTab).detached));
    frame(cardTab, "CARD-2");
    await wait(80);
    for (const x of [guest, turn]) assert.equal(/CARD-/.test(x.text()), false);
    assert.equal(s.sessions.filter((c) => c.page === cardTab).some((c) => c.calls.some(([m]) => m === "Input.dispatchKeyEvent")), false, "no input reached it");
  } finally { for (const x of streams) x.close(); s.view.close(); }
});
