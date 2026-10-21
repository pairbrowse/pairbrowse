// A hand-off link from anywhere (spec server-mode step 21b, U2, handoff.publicLink): the public
// address of the hand-off's own tunnel reaches the live view's guest port and serves a grant's
// routes alone (liveview/public-turn.mjs), with the stream over a WebSocket; the tunnel runs only
// while a hand-off is open (daemon/sharing.mjs, tunnel-pool.mjs); and when it can't start, the
// message goes out on the private route with a sentence saying so (notify/message.mjs,
// daemon/yourturn.mjs). Fake tabs and a stand-in tunnel, no browser and no network.
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
import { connect } from "../scripts/ws.mjs";
import { PUBLIC_ROUTES, socketStream } from "../scripts/liveview/public-turn.mjs";
import { messageProblem, messageText, PRIVATE_ONLY } from "../scripts/daemon/notify/message.mjs";
import { createSharing } from "../scripts/daemon/sharing.mjs";
import { createYourTurn } from "../scripts/daemon/yourturn.mjs";
import { createTunnelPool } from "../scripts/daemon/tunnel-pool.mjs";

const PUB = "words-like-these.trycloudflare.com";
const ORIGIN = `https://${PUB}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(10)) { const v = await fn(); if (v) return v; } return null; };

function fakeTabs(urls) {
  const ctx = Object.assign(new EventEmitter(), { pages: () => pages, newPage: async () => { throw new Error("no new tabs here"); } });
  const tab = (url) => {
    const p = Object.assign(new EventEmitter(), { url: () => url, title: async () => `Title of ${url}`, context: () => ctx, bringToFront: async () => {}, evaluate: async () => null, opener: async () => null, isClosed: () => !pages.includes(p) });
    return p;
  };
  const pages = urls.map(tab);
  ctx.newCDPSession = async (page) => Object.assign(new EventEmitter(), { send: async (m) => (m === "Page.captureScreenshot" ? { data: Buffer.from(`STILL ${page.url()}`).toString("base64") } : {}), detach: async () => {} });
  return { ctx, pages };
}

function request(port, method, path, { body, host = PUB, origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, ...(origin ? { origin } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
// The turn stream as the viewer opens it on the public address: a WebSocket, its events by name.
async function socket(port, viewKey, { host = PUB, origin = ORIGIN } = {}) {
  const conn = await connect(`http://127.0.0.1:${port}/${viewKey}/events`, { headers: { host, ...(origin ? { origin } : {}) }, timeoutMs: 5000 });
  let text = "";
  conn.onMessage((m) => { text += m; });
  return { conn, events: (name) => text.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6))) };
}

async function setup({ pub = PUB, shared = false } = {}) {
  const tabs = fakeTabs(["https://shop.example/pay", "https://other.example/"]);
  const file = join(mkdtempSync(join(tmpdir(), "pb-pubturn-")), "audit.jsonl");
  const audit = createAudit({ file });
  const grants = createGrants({ audit });
  const invites = createInvites();
  let host = pub;
  const view = await startLiveView({ getContext: async () => tabs.ctx, currentUrl: async () => tabs.pages[0].url(), invites, grants, publicHost: () => host,
    ...(shared ? { publicShared: () => true, tunnelHost: () => [PUB] } : {}) });
  view.setSession({ name: "default", where: "Local" });
  const audited = () => { try { return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { ...tabs, grants, invites, view, port: view.guestPort, ownerKey: view.url.split("/").at(-2), audited, setHost: (h) => { host = h; },
    mint: () => grants.mint({ session: "default", page: tabs.pages[0], action: "login" }) };
}

test("the public address serves a grant's routes alone: landing page, Take over, the viewer and its routes; owner, pages, invite and join keys and every other route are 404", async () => {
  const s = await setup();
  try {
    const g = s.mint();
    // Every other key on the public address: as a key never made.
    const link = s.invites.create({ role: "drive", label: "Ann", share: "link" });
    const code = s.invites.create({ role: "drive", label: "Bea", share: "code" });
    for (const k of [s.ownerKey, s.view.pagesKey, link.key, code.key, "ab".repeat(32)]) {
      for (const path of ["/", "/config.json", "/events", "/state.json", "/tabs"]) assert.equal((await request(s.port, "GET", `/${k}${path}`)).status, 404, `${path} with another key`);
    }
    // The landing page: a link preview uses nothing up, as often as it comes.
    for (let i = 0; i < 2; i++) {
      const landing = await request(s.port, "GET", `/${g.redeemKey}/`);
      assert.equal(landing.status, 200);
      assert.match(landing.text, /Take over/);
    }
    assert.equal((await request(s.port, "GET", `/${g.redeemKey}/assets/liveview-redeem.js`)).status, 200);
    assert.equal(s.grants.open()[0].redeemed, false);
    // The redeem key reaches nothing else.
    for (const [m, r] of [["GET", "events"], ["GET", "state.json"], ["POST", "input"], ["POST", "turn-done"], ["GET", "config.json"]]) {
      assert.equal((await request(s.port, m, `/${g.redeemKey}/${r}`, m === "POST" ? { body: {}, origin: ORIGIN } : {})).status, 404, `${m} ${r} with the redeem key`);
    }
    // Take over from another site's page: refused and audited; from the page's own origin: once.
    assert.equal((await request(s.port, "POST", `/${g.redeemKey}/redeem`, { body: {}, origin: "https://evil.example" })).status, 403);
    assert.ok(s.audited().some((l) => l.kind === "input-refused" && l.detail === "not-allowed"));
    const tap = await request(s.port, "POST", `/${g.redeemKey}/redeem`, { body: {}, origin: ORIGIN });
    assert.equal(tap.status, 200, tap.text);
    const viewKey = JSON.parse(tap.text).view.slice(1, -1);
    assert.equal((await request(s.port, "POST", `/${g.redeemKey}/redeem`, { body: {}, origin: ORIGIN })).status, 404, "a second tap");
    // The viewer: its stream is a WebSocket here, and its policy names the address's wss: origin.
    const page = await request(s.port, "GET", `/${viewKey}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-stream="ws"/);
    assert.match(page.text, /data-role="turn"/);
    assert.match(page.headers["content-security-policy"], new RegExp(`connect-src 'self' wss://${PUB.replace(/\./g, "\\.")}`));
    assert.equal((await request(s.port, "GET", `/${viewKey}/assets/liveview-turn.js`)).status, 200);
    assert.equal((await request(s.port, "GET", `/${viewKey}/state.json`)).status, 200);
    assert.equal((await request(s.port, "GET", `/${viewKey}/thumb.jpg`)).status, 200);
    // Never the owner's routes, Pause, tab changes, settings or the event stream as server-sent events.
    for (const [m, r] of [["POST", "pause"], ["POST", "tab"], ["GET", "config.json"], ["POST", "config"], ["GET", "journal.json"], ["POST", "invite"], ["GET", "handoffs.json"], ["POST", "turn-revoke"], ["GET", "events"], ["GET", "nothing"]]) {
      assert.equal((await request(s.port, m, `/${viewKey}/${r}`, m === "POST" ? { body: {}, origin: ORIGIN } : {})).status, 404, `${m} ${r} with the view key`);
    }
    // The list itself: nothing beyond the viewer's and the landing page's own routes.
    assert.deepEqual([...PUBLIC_ROUTES.redeem].sort(), ["GET ", "GET assets", "POST redeem"]);
    for (const r of PUBLIC_ROUTES.turn) assert.doesNotMatch(r, /pause|tab$|config|revoke|invite|profile|session|tools/);
    // Done ends it; the view key is then 404 like the rest.
    assert.equal((await request(s.port, "POST", `/${viewKey}/turn-done`, { body: {}, origin: ORIGIN })).status, 200);
    assert.equal((await request(s.port, "GET", `/${viewKey}/`)).status, 404);
  } finally { s.view.close(); }
});

test("the turn stream on the public address: a WebSocket that holds the one stream, hears its turn and turn-ended; another site's page is refused; a reconnect after a drop works", async () => {
  const s = await setup();
  try {
    const g = s.mint();
    const viewKey = JSON.parse((await request(s.port, "POST", `/${g.redeemKey}/redeem`, { body: {}, origin: ORIGIN })).text).view.slice(1, -1);
    // Another site's page can't hold the hand-off's one stream.
    await assert.rejects(socket(s.port, viewKey, { origin: "https://evil.example" }), (e) => e.status === 403);
    assert.ok(s.audited().some((l) => l.kind === "stream-refused" && l.detail === "other-origin"));
    const one = await socket(s.port, viewKey);
    const turn = await until(() => one.events("turn").at(-1));
    assert.equal(turn.action, "login");
    assert.equal(turn.host, "shop.example");
    assert.ok(one.events("tabs").length >= 1, "the stream's first events, as on the private route");
    // A second at once: 409, the hand-off is open elsewhere.
    await assert.rejects(socket(s.port, viewKey), (e) => e.status === 409);
    // The phone drops; the same view key comes back.
    one.conn.close();
    const two = await until(async () => socket(s.port, viewKey).catch(() => null));
    assert.ok(two, "a reconnect after a drop");
    await until(() => two.events("turn").length);
    s.grants.end(g.id, "done");
    assert.deepEqual(await until(() => two.events("turn-ended")[0]), { reason: "done" });
    assert.ok(await until(() => two.conn.closed), "the stream closes after turn-ended");
  } finally { s.view.close(); }
});

test("a grant key on the guest port is 404 while no hand-off tunnel is up, and plain loopback requests still reach join codes", async () => {
  const s = await setup({ pub: null });
  try {
    const g = s.mint();
    for (const host of [`127.0.0.1:${s.port}`, PUB]) assert.equal((await request(s.port, "GET", `/${g.redeemKey}/`, { host })).status, host === PUB ? 403 : 404);
    assert.equal(s.grants.open()[0].redeemed, false);
    s.setHost(PUB);
    // Up: through the tunnel's name, or loopback (cloudflared may pass either), the grant's routes.
    assert.equal((await request(s.port, "GET", `/${g.redeemKey}/`, { host: `127.0.0.1:${s.port}` })).status, 200);
    // A join code on loopback is still the join server's (it asks who is joining).
    const code = s.invites.create({ role: "drive", label: "Bea", share: "code" });
    const r = await request(s.port, "GET", `/${code.key}/tabs`, { host: `127.0.0.1:${s.port}` });
    assert.equal(r.status, 400, r.text);
  } finally { s.view.close(); }
});

// The user's own tunnel (one address) carries both the hand-off and join codes: on that name a
// grant's routes are served as on a hand-off's own, and every other key is left to the join server,
// so join codes, their push channel and joiners keep working while a hand-off is open.
test("a hand-off on the join codes' own tunnel: grant keys served there, join code requests and their push channel still reach the join server", async () => {
  const s = await setup({ shared: true });
  try {
    const g = s.mint();
    assert.equal((await request(s.port, "GET", `/${g.redeemKey}/`)).status, 200, "the landing page on the shared name");
    const code = s.invites.create({ role: "drive", label: "Bea", share: "code" });
    // The join server's own answer (it asks who is joining), never the public address's 404.
    const r = await request(s.port, "GET", `/${code.key}/tabs`);
    assert.equal(r.status, 400, r.text);
    await assert.rejects(connect(`http://127.0.0.1:${s.port}/${code.key}/events`, { headers: { host: PUB }, timeoutMs: 5000 }), (e) => e.status === 400);
    // Keys no one made: the join server's 404, as without a hand-off.
    const none = await request(s.port, "GET", `/${"ab".repeat(32)}/tabs`);
    assert.equal(none.status, 404);
    assert.match(none.text, /join code/);
    // The owner's key still never works there.
    assert.equal((await request(s.port, "GET", `/${s.ownerKey}/config.json`)).status, 404);
  } finally { s.view.close(); }
});

test("socketStream: a refused stream answers the upgrade with its code and body; an accepted one sends each write as a message", async () => {
  const server = http.createServer();
  const answers = [];
  server.on("upgrade", (req, sock, head) => {
    const { res } = socketStream(req, sock, head);
    if (req.url === "/no") { res.writeHead(409, {}); res.end(JSON.stringify({ error: "open somewhere else" })); return; }
    res.writeHead(200, {});
    res.write("event: a\ndata: 1\n\n");
    res.once("close", () => answers.push("closed"));
    setTimeout(() => res.end(), 50);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    await assert.rejects(connect(`http://127.0.0.1:${port}/no`), (e) => e.status === 409 && e.body.error === "open somewhere else");
    const c = await connect(`http://127.0.0.1:${port}/yes`);
    let got = "";
    c.onMessage((m) => { got += m; });
    assert.ok(await until(() => c.closed));
    assert.equal(got, "event: a\ndata: 1\n\n");
    assert.ok(await until(() => answers.includes("closed")));
  } finally { server.closeAllConnections?.(); server.close(); }
});

// The tunnel's life with the hand-off: started by the first public link, the same address for the
// reminder, stopped once no hand-off is open; when it can't start, the private link with privateOnly.
function sharingFor(config, startHandoff, grants) {
  const hostNote = () => {};
  hostNote.drop = () => {};
  const live = { url: "http://127.0.0.1:4123/ownerkey/", port: 4123, guestPort: 4999, setStatus() {}, setSession() {}, setCollaboration() {}, setDev() {}, close() {}, watchGrants() {} };
  const view = { currentUrl: () => "about:blank", getContext: async () => ({ pages: () => [] }), status: () => ({}), session: () => null, collaboration: () => ({}), secretDomains: () => [], grants };
  let opts = null;
  const sharing = createSharing({ config, log: () => {}, host: "Me", view, notify() {}, hostNote, startLive: async (o) => { opts = o; return live; }, startHandoff, handoffStopMs: 30 });
  return { sharing, opts: () => opts };
}

test("the hand-off tunnel starts with the first public link, serves the reminder on the same address, and stops when the last hand-off ends", async () => {
  const tunnels = [];
  const start = async (port) => { const t = { url: `https://t${tunnels.length}.trycloudflare.com`, host: `t${tunnels.length}.trycloudflare.com`, port, stopped: false, stop() { t.stopped = true; } }; tunnels.push(t); return t; };
  const grants = createGrants({});
  const page = { url: () => "https://shop.example/" };
  const { sharing, opts } = sharingFor({ handoff: { publicLink: true } }, start, grants);
  try {
    const a = grants.mint({ session: "default", page, action: "login" });
    assert.equal(await sharing.handoffLink(a.redeemKey), `https://t0.trycloudflare.com/${a.redeemKey}/`);
    assert.equal(tunnels.length, 1);
    assert.equal(tunnels[0].port, 4999, "to the guest port, never the owner's");
    assert.equal(opts().publicHost(), "t0.trycloudflare.com", "the live view serves grants on that name");
    const b = grants.mint({ session: "default", page: { url: () => "https://other.example/" }, action: "2fa" });
    assert.equal(await sharing.handoffLink(b.redeemKey), `https://t0.trycloudflare.com/${b.redeemKey}/`, "one tunnel for every open hand-off");
    grants.end(a.id, "done");
    await wait(80);
    assert.equal(tunnels[0].stopped, false, "another hand-off is still open");
    grants.end(b.id, "expired");
    assert.ok(await until(() => tunnels[0].stopped), "stopped once none is open");
    assert.equal(opts().publicHost(), null, "nothing served on a public name between hand-offs");
    // The next hand-off starts a new one.
    const c = grants.mint({ session: "default", page, action: "other" });
    assert.equal(await sharing.handoffLink(c.redeemKey), `https://t1.trycloudflare.com/${c.redeemKey}/`);
    sharing.endAll();
    assert.equal(tunnels[1].stopped, true, "the window closing stops it too");
  } finally { sharing.endAll(); }
  // Off: the private route, no tunnel.
  const off = sharingFor({}, async () => { throw new Error("never started"); }, createGrants({}));
  try { assert.equal(await off.sharing.handoffLink("ab".repeat(32)), `http://127.0.0.1:4123/${"ab".repeat(32)}/`); } finally { off.sharing.endAll(); }
});

// The user's own tunnel taken into the pool while a hand-off uses it: the pool's stop (the idle keep
// running out after the last code, revoke_all) lets it go back to the hand-off instead of stopping
// it, and it stops with the last hand-off.
test("the user's own tunnel shared with join codes: the pool's stop keeps it while a hand-off is open; the hand-off's end stops it", async () => {
  const made = [];
  const startHandoff = async (port) => { const t = { url: "https://share.example.com", host: "share.example.com", port, stopped: false, stop() { t.stopped = true; } }; made.push(t); return t; };
  const pool = createTunnelPool({ config: { sharing: { tunnel: { kind: "tailscale" } } }, log: () => {}, hostNote: () => {}, save: () => {}, startHandoff });
  const t = await pool.ensureHandoff(4999);
  assert.equal(pool.handoffShared(), false, "its own until a code needs it");
  assert.equal(await pool.ensureTunnel({ guestPort: 4999 }), t, "a join code takes the same tunnel");
  assert.equal(pool.handoffShared(), true, "join codes use the hand-off's name now");
  pool.releaseTunnel();
  pool.stopTunnel(); // as the idle keep does when it runs out, and revoke_all
  assert.equal(t.stopped, false, "a hand-off is still open on it");
  assert.equal(pool.handoffHost(), "share.example.com");
  assert.equal(pool.handoffShared(), false, "the hand-off's alone again");
  assert.deepEqual(pool.pool, []);
  pool.stopHandoff();
  assert.equal(t.stopped, true, "the last hand-off ended");
  assert.equal(pool.handoffHost(), null);
  assert.equal(made.length, 1);
  // A shared pool tunnel with no hand-off on it stops with the pool as before.
  const u = await pool.ensureHandoff(4999);
  await pool.ensureTunnel({ guestPort: 4999 });
  pool.stopHandoff();
  assert.equal(u.stopped, false, "join codes still use it");
  pool.stopTunnel();
  assert.equal(u.stopped, true);
});

// "Stop the public link": the setting turned off stops the hand-off tunnel at once, with a hand-off
// still open; its next link (the reminder) is the private one.
test("the public link turned off with a hand-off open: its tunnel stops at once and the next link is the private one", async () => {
  const tunnels = [];
  const start = async (port) => { const t = { url: `https://t${tunnels.length}.trycloudflare.com`, host: `t${tunnels.length}.trycloudflare.com`, port, stopped: false, stop() { t.stopped = true; } }; tunnels.push(t); return t; };
  const grants = createGrants({});
  const config = { handoff: { publicLink: true } };
  const { sharing, opts } = sharingFor(config, start, grants);
  try {
    const a = grants.mint({ session: "default", page: { url: () => "https://shop.example/" }, action: "login" });
    assert.equal(await sharing.handoffLink(a.redeemKey), `https://t0.trycloudflare.com/${a.redeemKey}/`);
    sharing.publicLinkChanged(); // still on: nothing changes
    assert.equal(tunnels[0].stopped, false);
    config.handoff.publicLink = false;
    sharing.publicLinkChanged();
    assert.equal(tunnels[0].stopped, true, "stopped while the hand-off is still open");
    assert.equal(opts().publicHost(), null, "nothing served on the public name");
    assert.equal(grants.open().length, 1, "the hand-off itself stays open (the window, the private route)");
    assert.equal(await sharing.handoffLink(a.redeemKey), `http://127.0.0.1:4123/${a.redeemKey}/`);
    assert.equal(tunnels.length, 1, "no new tunnel");
  } finally { sharing.endAll(); }
});

test("a public link that can't start: the private link with privateOnly, and nothing left running", async () => {
  const grants = createGrants({});
  const g = grants.mint({ session: "default", page: { url: () => "https://shop.example/" }, action: "login" });
  const failing = sharingFor({ handoff: { publicLink: true } }, async () => { throw new Error("too many fresh sharing connections"); }, grants);
  try {
    assert.deepEqual(await failing.sharing.handoffLink(g.redeemKey), { link: `http://127.0.0.1:4123/${g.redeemKey}/`, privateOnly: true });
    assert.equal(failing.opts().publicHost(), null);
  } finally { failing.sharing.endAll(); }
});

test("the fallback sentence: a message with privateOnly says the link works only on the private route; the rule refuses it without a link", () => {
  const base = { kind: "turn", id: "3fa1c2d9", action: "login", host: "shop.example", link: "http://127.0.0.1:4123/" + "ab".repeat(32) + "/", expiresAt: Date.UTC(2026, 9, 21, 14, 35) };
  assert.equal(messageProblem({ ...base, privateOnly: true }), "");
  assert.equal(messageProblem({ ...base, privateOnly: false }), "");
  assert.match(messageProblem({ ...base, privateOnly: "yes" }), /privateOnly/);
  assert.match(messageProblem({ ...base, link: null, privateOnly: true }), /privateOnly/);
  assert.match(messageProblem({ kind: "ended", id: base.id, action: base.action, host: base.host, link: null, expiresAt: base.expiresAt, reason: "done", privateOnly: true }), /privateOnly/);
  const { text } = messageText({ ...base, privateOnly: true });
  assert.ok(text.includes(base.link));
  assert.ok(text.includes(PRIVATE_ONLY));
  assert.match(PRIVATE_ONLY, /only on your private route/);
  assert.match(PRIVATE_ONLY, /PairBrowse window/);
  assert.ok(!messageText(base).text.includes(PRIVATE_ONLY));
});

test("yourturn: when the public link couldn't start the message still goes, with privateOnly, and the reminder says it again", async () => {
  const grants = createGrants({});
  const sent = [];
  const notifier = { usable: () => [{ type: "webhook" }], send: async (m) => { assert.equal(messageProblem(m), ""); sent.push(m); return { sent: ["webhook"], failed: [], withheld: [] }; } };
  const timers = [];
  const page = Object.assign(new EventEmitter(), { url: () => "https://shop.example/login", isClosed: () => false, context: () => ({ pages: () => [page] }) });
  const yt = createYourTurn({ config: { handoff: { enabled: true, grantMinutes: 15, remindMinutes: 10 } }, grants, notifier, sends: () => true, handoffs: { set() {}, delete() {} }, journal: { status() {}, flushNow: async () => {} }, hud: { setBadge() {}, setBadgeFor() {} }, sessionName: () => "default",
    linkFor: async (key) => ({ link: `http://127.0.0.1:4123/${key}/`, privateOnly: true }), timers: { set: (fn) => { timers.push(fn); return null; }, clear() {} } });
  const r = await yt.onStatus("p1", { kind: "you", text: "sign in", step: "login" }, page);
  assert.match(r, /Your turn sent \(webhook\)/);
  assert.equal(sent[0].kind, "turn");
  assert.equal(sent[0].privateOnly, true);
  assert.ok(messageText(sent[0]).text.includes(PRIVATE_ONLY));
  await timers[0]();
  assert.ok(await until(() => sent.find((m) => m.kind === "reminder")));
  assert.equal(sent.find((m) => m.kind === "reminder").privateOnly, true);
  yt.stop?.().catch?.(() => {});
});
