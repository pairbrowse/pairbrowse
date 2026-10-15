// The joiner port (scripts/liveview/joiner-server.mjs): what the sharing tunnel reaches. Join code
// keys only, never the owner's key or a link's; no browser pages (any Origin is refused); nothing
// but the approval request until the host lets that joiner in; then each route's role, mode, size
// and rate limits. Started here on 127.0.0.1 with the real invites and approvals and a fake live
// view behind it.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { createJoinerServer, joinerKeyOf, recentlySeen } from "../scripts/liveview/joiner-server.mjs";
import { createInvites } from "../scripts/liveview/invites.mjs";
import { createApprovals } from "../scripts/sharing/join.mjs";
import { BODY_MAX } from "../scripts/liveview/http.mjs";
import { connect } from "../scripts/ws.mjs";

const newId = () => randomBytes(16).toString("hex");

// A joiner port with its own invites, approvals and a fake live view that records what reached it.
async function start({ tunnelHost = () => "abc.trycloudflare.com", live: liveOver = {} } = {}) {
  const key = randomBytes(32).toString("hex");
  const invites = createInvites();
  const approvals = createApprovals();
  const joiners = new Map();
  const calls = [];
  const requests = [];
  const hold = { tabs: null }; // a promise tabsFor waits on, when set
  const live = {
    tabsFor: async (j) => { calls.push(["tabsFor", j.joinerId]); if (hold.tabs) await hold.tabs; return { tabs: [] }; },
    applyTabs: async (body) => { calls.push(["applyTabs", body]); return body?.bad ? { problem: "bad ops" } : { ok: true }; },
    pointersFor: async (body) => { calls.push(["pointersFor", body]); return { ok: true }; },
    say: (body) => { calls.push(["say", body]); return { ok: true }; },
    screen: async (body) => { calls.push(["screen", body]); return { ok: true }; },
    agent: async (body) => { calls.push(["agent", body]); return { ok: true }; },
    file: (body) => { calls.push(["file", body]); return { ok: true }; },
    approval: (body) => { calls.push(["approval", body]); return { code: 200, body: { answered: true } }; },
    openStream: (j, conn) => { calls.push(["openStream", j.joinerId]); live.conn = conn; },
    stopScreens: async (j) => { calls.push(["stopScreens", j.joinerId]); },
    changed: () => calls.push(["changed"]),
    ...liveOver,
  };
  const s = createJoinerServer({ key, invites, approvals, joiners, tunnelHost, live, onJoinRequest: (e) => requests.push(e), log: () => {} });
  await s.listen(0);
  const port = s.server.address().port;
  // A request as the joiner's PairBrowse sends it (no Origin), headers overridable.
  const call = (method, path, { headers = {}, body, raw } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on("error", reject);
    if (raw !== undefined) req.write(raw);
    else if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
  const who = (joinerId, name = "Jo") => ({ "x-pairbrowse-joiner": joinerId, "x-pairbrowse-name": encodeURIComponent(name), "x-pairbrowse-app": "claude-code", "x-pairbrowse-computer": "Mac" });
  // A joiner the host let in: their invite, id and headers.
  const admitted = async (opts = { role: "drive", share: "code" }) => {
    const invite = invites.create(opts);
    const joinerId = newId();
    const first = await call("GET", `/${invite.key}/tabs`, { headers: who(joinerId) });
    assert.equal(first.status, 403);
    approvals.approve(joinerId);
    return { invite, joinerId, headers: who(joinerId) };
  };
  return { key, invites, approvals, joiners, calls, requests, hold, live, port, call, who, admitted, close: () => s.close(), server: s };
}

test("joinerKeyOf and recentlySeen", () => {
  assert.equal(joinerKeyOf("ab12cd34", "f".repeat(32)), `ab12cd34:${"f".repeat(32)}`);
  assert.equal(recentlySeen({ seen: Date.now() }), true);
  assert.equal(recentlySeen({ seen: Date.now() - 6000 }), false, "a joiner silent for over 5 s isn't there");
  assert.equal(recentlySeen({ seen: 0 }), false);
});

test("only join code keys work here: never the owner's key, a link's, an unknown or an ended one", async () => {
  const h = await start();
  try {
    const link = h.invites.create({ role: "drive" });
    const code = h.invites.create({ role: "drive", share: "code" });
    const joinerId = newId();
    for (const [what, k] of [["owner", h.key], ["link", link.key], ["unknown", "0".repeat(64)], ["empty", ""]]) {
      const r = await h.call("GET", `/${k}/tabs`, { headers: h.who(joinerId) });
      assert.equal(r.status, 404, what);
      assert.match(r.json.error, /doesn't work any more/, what);
    }
    assert.equal(h.requests.length, 0, "nothing reached the host");
    // Extra path parts after the route: refused like a wrong key.
    assert.equal((await h.call("GET", `/${code.key}/tabs/x`, { headers: h.who(joinerId) })).status, 404);
    // Revoked and expired codes stop at once.
    h.invites.revoke(code.id);
    assert.equal((await h.call("GET", `/${code.key}/tabs`, { headers: h.who(joinerId) })).status, 404, "revoked");
    // Every answer is JSON and never cached or sniffed.
    const r = await h.call("GET", `/${h.key}/`);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
    assert.equal(r.headers["content-type"], "application/json");
  } finally { h.close(); }
});

test("any Origin is refused, and only loopback or the tunnel's own names as Host", async () => {
  const h = await start({ tunnelHost: () => ["abc.trycloudflare.com", "standby.example.com"] });
  try {
    const { invite, headers } = await h.admitted();
    const path = `/${invite.key}/tabs`;
    assert.equal((await h.call("GET", path, { headers })).status, 200, "admitted, plain");
    for (const origin of ["https://evil.example", "http://127.0.0.1", "null"]) {
      const r = await h.call("GET", path, { headers: { ...headers, origin } });
      assert.equal(r.status, 403, origin);
      assert.match(r.json.error, /through PairBrowse only/);
    }
    for (const host of ["abc.trycloudflare.com", "ABC.trycloudflare.com:443", "standby.example.com", "localhost:9", "[::1]:80"]) {
      assert.equal((await h.call("GET", path, { headers: { ...headers, host } })).status, 200, host);
    }
    for (const host of ["evil.example", "abc.trycloudflare.com.evil.example", "abc.trycloudflare.com:8443", "x.abc.trycloudflare.com"]) {
      assert.equal((await h.call("GET", path, { headers: { ...headers, host } })).status, 403, host);
    }
  } finally { h.close(); }
  // No tunnel yet: loopback only.
  const bare = await start({ tunnelHost: () => null });
  try {
    const { invite, headers } = await bare.admitted();
    assert.equal((await bare.call("GET", `/${invite.key}/tabs`, { headers: { ...headers, host: "abc.trycloudflare.com" } })).status, 403);
    assert.equal((await bare.call("GET", `/${invite.key}/tabs`, { headers })).status, 200);
  } finally { bare.close(); }
});

test("nothing of the session before the host says yes: waiting, denied, removed, a bad id", async () => {
  const h = await start();
  try {
    const invite = h.invites.create({ role: "drive", share: "code" });
    const path = `/${invite.key}/tabs`;
    for (const bad of [undefined, "", "abc", "G".repeat(32), "a".repeat(31)]) {
      const r = await h.call("GET", path, { headers: bad === undefined ? {} : { "x-pairbrowse-joiner": bad } });
      assert.equal(r.status, 400, String(bad));
    }
    const jo = newId();
    const wait = await h.call("GET", path, { headers: h.who(jo, "Jo <b>") });
    assert.equal(wait.status, 403);
    assert.equal(wait.json.waiting, true);
    assert.equal(h.requests.length, 1, "the host hears one request");
    assert.equal(h.requests[0].name, "Jo b", "the name is cleaned");
    assert.equal(h.requests[0].computer, "Mac");
    await h.call("GET", path, { headers: h.who(jo) });
    assert.equal(h.requests.length, 1, "asking again isn't a new request");
    // Posting changes before approval reaches nothing either.
    assert.equal((await h.call("POST", `/${invite.key}/tabs`, { headers: h.who(jo), body: { ops: [] } })).status, 403);
    assert.ok(!h.calls.some(([c]) => c === "tabsFor" || c === "applyTabs"), "the live view was never asked");
    h.approvals.deny(jo);
    const denied = await h.call("GET", path, { headers: h.who(jo) });
    assert.deepEqual([denied.status, denied.json.denied], [403, true]);
    // Approved, then taken out: out at once, for good with this code.
    const { invite: i2, joinerId, headers } = await h.admitted();
    assert.equal((await h.call("GET", `/${i2.key}/tabs`, { headers })).status, 200);
    h.approvals.remove(joinerId);
    const removed = await h.call("GET", `/${i2.key}/tabs`, { headers });
    assert.deepEqual([removed.status, removed.json.removed], [403, true]);
    // An approval is bound to the joiner's id: the same code from another id asks anew.
    const other = await h.call("GET", `/${i2.key}/tabs`, { headers: h.who(newId()) });
    assert.equal(other.json.waiting, true);
  } finally { h.close(); }
});

test("too many waiting at once: 429, and the host isn't flooded", async () => {
  const h = await start();
  try {
    const invite = h.invites.create({ role: "drive", share: "code" });
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await h.call("GET", `/${invite.key}/tabs`, { headers: h.who(newId()) })).status);
    assert.deepEqual(codes, [403, 403, 403, 403, 403, 429, 429]);
    assert.equal(h.requests.length, 5);
  } finally { h.close(); }
});

test("an admitted joiner: GET tabs with their role, and the participant list changes once", async () => {
  const h = await start();
  try {
    const { invite, joinerId, headers } = await h.admitted({ role: "watch", share: "code" });
    const r = await h.call("GET", `/${invite.key}/tabs`, { headers });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.role, r.json.name], ["watch", "Jo"]);
    await h.call("GET", `/${invite.key}/tabs`, { headers });
    assert.equal(h.calls.filter(([c]) => c === "changed").length, 1, "changed only when they arrive, not on every poll");
    const j = h.joiners.get(joinerKeyOf(invite.id, joinerId));
    assert.equal(j.computer, "Mac");
    assert.equal(j.app, "Claude Code");
    assert.equal((await h.call("GET", `/${invite.key}/`, { headers })).status, 404, "no page here");
    assert.equal((await h.call("PUT", `/${invite.key}/tabs`, { headers, body: {} })).status, 404);
    assert.equal((await h.call("POST", `/${invite.key}/nothing`, { headers, body: {} })).status, 404);
  } finally { h.close(); }
});

test("routes by role and mode: a watcher only points and talks; follow codes have no screen, agent, file or approval", async () => {
  const h = await start();
  try {
    const watch = await h.admitted({ role: "watch", share: "code" });
    const post = (w, route, body) => h.call("POST", `/${w.invite.key}/${route}`, { headers: w.headers, body });
    assert.equal((await post(watch, "tabs", { ops: [] })).status, 403, "watch: no tab changes");
    assert.equal((await post(watch, "pointer", { me: null })).status, 200);
    assert.equal((await post(watch, "say", { text: "hi" })).status, 200);
    const drive = await h.admitted({ role: "drive", share: "code" });
    assert.equal((await post(drive, "tabs", { ops: [1, 2] })).status, 200);
    const bad = await post(drive, "tabs", { bad: true });
    assert.deepEqual([bad.status, bad.json.error], [400, "bad ops"], "the live view's problem as a 400");
    const follow = await h.admitted({ role: "drive", share: "code", mode: "follow" });
    for (const route of ["screen", "agent", "file", "approval"]) assert.equal((await post(follow, route, {})).status, 403, `follow ${route}`);
    const shared = await h.admitted({ role: "drive", share: "code", mode: "shared" });
    for (const route of ["screen", "agent", "file"]) assert.equal((await post(shared, route, {})).status, 200, `shared ${route}`);
    const answer = await post(shared, "approval", { id: "a1", allow: true });
    assert.deepEqual([answer.status, answer.json], [200, { answered: true }], "answered where the role is read again");
    // Not JSON: 400, never reaching the live view.
    const before = h.calls.length;
    const notJson = await h.call("POST", `/${drive.invite.key}/say`, { headers: drive.headers, raw: "{nope" });
    assert.equal(notJson.status, 400);
    assert.equal(h.calls.length, before);
  } finally { h.close(); }
});

test("no approval route on the live view: 404", async () => {
  const h = await start({ live: { approval: undefined } });
  try {
    const shared = await h.admitted({ role: "drive", share: "code" });
    assert.equal((await h.call("POST", `/${shared.invite.key}/approval`, { headers: shared.headers, body: {} })).status, 404);
  } finally { h.close(); }
});

test("size caps: the whole body, and each route's own", async () => {
  const h = await start();
  try {
    const d = await h.admitted({ role: "drive", share: "code" });
    const post = (route, raw) => h.call("POST", `/${d.invite.key}/${route}`, { headers: d.headers, raw });
    const big = (n) => JSON.stringify({ pad: "x".repeat(n) });
    assert.equal((await post("tabs", big(BODY_MAX.input + 10))).status, 413, "over the body cap: never read whole");
    assert.equal((await post("pointer", big(4000))).status, 413);
    assert.equal((await post("pointer", big(3900))).status, 200);
    assert.equal((await post("say", big(20_000))).status, 413);
    assert.equal((await post("screen", big(120_000))).status, 413);
    assert.equal((await post("approval", big(1000))).status, 413);
    assert.equal((await post("agent", big(190_000))).status, 200);
  } finally { h.close(); }
});

test("rate limits: messages a second, approval answers a minute, tab changes a minute", async () => {
  const h = await start();
  try {
    const d = await h.admitted({ role: "drive", share: "code" });
    const post = (route, body) => h.call("POST", `/${d.invite.key}/${route}`, { headers: d.headers, body });
    const statuses = async (route, n, body = {}) => { const out = []; for (let i = 0; i < n; i++) out.push((await post(route, body)).status); return out; };
    // Sequential requests inside one second: the cap is the count, the next is 429.
    const says = await statuses("say", 6);
    assert.deepEqual(says.slice(0, 4), [200, 200, 200, 200]);
    assert.ok(says.slice(4).includes(429), `says ${says}`);
    const answers = await statuses("approval", 11);
    assert.deepEqual(answers.slice(0, 10), Array(10).fill(200));
    assert.equal(answers[10], 429, "11th answer within a minute");
    // Tab changes count each op: one request with more ops than the minute allows is refused whole.
    assert.equal((await post("tabs", { ops: Array(3001).fill(0) })).status, 429);
    assert.equal((await post("tabs", { ops: Array(3000).fill(0) })).status, 200);
    assert.equal((await post("tabs", { ops: [0] })).status, 429, "the minute's budget is spent");
  } finally { h.close(); }
});

test("at most four requests at once per joiner", async () => {
  const h = await start();
  try {
    const d = await h.admitted({ role: "drive", share: "code" });
    let release;
    h.hold.tabs = new Promise((r) => (release = r));
    const slow = Array.from({ length: 4 }, () => h.call("GET", `/${d.invite.key}/tabs`, { headers: d.headers }));
    for (let i = 0; i < 100 && h.calls.filter(([c]) => c === "tabsFor").length < 4; i++) await new Promise((r) => setTimeout(r, 10));
    const fifth = await h.call("GET", `/${d.invite.key}/tabs`, { headers: d.headers });
    assert.equal(fifth.status, 429);
    release();
    assert.deepEqual((await Promise.all(slow)).map((r) => r.status), [200, 200, 200, 200]);
    h.hold.tabs = null;
    assert.equal((await h.call("GET", `/${d.invite.key}/tabs`, { headers: d.headers })).status, 200, "free again");
  } finally { h.close(); }
});

test("leave: the joiner and their approval go, their screens stop; joining again asks again", async () => {
  const h = await start();
  try {
    const d = await h.admitted({ role: "drive", share: "code" });
    assert.equal((await h.call("GET", `/${d.invite.key}/tabs`, { headers: d.headers })).status, 200);
    assert.equal(h.joiners.size, 1);
    assert.equal((await h.call("POST", `/${d.invite.key}/leave`, { headers: d.headers })).status, 200);
    assert.equal(h.joiners.size, 0);
    assert.ok(h.calls.some(([c, id]) => c === "stopScreens" && id === d.joinerId));
    assert.equal(h.approvals.get(d.invite.id, d.joinerId), null);
    assert.equal((await h.call("GET", `/${d.invite.key}/tabs`, { headers: d.headers })).json.waiting, true);
    // Leave with the owner's key: refused like any other route.
    assert.equal((await h.call("POST", `/${h.key}/leave`, { headers: d.headers })).status, 404);
  } finally { h.close(); }
});

test("a live view that throws: 500 with a plain sentence, the server keeps going", async () => {
  const h = await start({ live: { say: () => { throw new Error("boom /secret/path"); } } });
  try {
    const d = await h.admitted({ role: "drive", share: "code" });
    const r = await h.call("POST", `/${d.invite.key}/say`, { headers: d.headers, body: {} });
    assert.equal(r.status, 500);
    assert.doesNotMatch(r.json.error, /boom|secret/);
    assert.equal((await h.call("GET", `/${d.invite.key}/tabs`, { headers: d.headers })).status, 200);
  } finally { h.close(); }
});

test("the push channel: the same checks, events only, and replies by request number", async () => {
  const h = await start();
  const url = (k, route = "events") => `http://127.0.0.1:${h.port}/${k}/${route}`;
  try {
    const d = await h.admitted({ role: "drive", share: "code" });
    const refused = async (u, headers) => { try { const c = await connect(u, { headers, timeoutMs: 5000 }); c.close(); return 101; } catch (e) { return e.status; } };
    assert.equal(await refused(url(h.key), d.headers), 404, "owner key");
    assert.equal(await refused(url(d.invite.key, "tabs"), d.headers), 404, "not events");
    assert.equal(await refused(url(d.invite.key), { ...d.headers, origin: "https://evil.example" }), 403, "an Origin");
    assert.equal(await refused(url(d.invite.key), h.who(newId())), 403, "not approved yet");
    assert.ok(!h.calls.some(([c]) => c === "openStream"));
    const conn = await connect(url(d.invite.key), { headers: d.headers, timeoutMs: 5000 });
    try {
      const replies = new Map();
      conn.onMessage((raw) => { const m = JSON.parse(raw); if (m.event === "reply") replies.set(m.data.n, m.data); });
      for (let i = 0; i < 100 && !h.calls.some(([c]) => c === "openStream"); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(h.calls.some(([c, id]) => c === "openStream" && id === d.joinerId));
      conn.send(JSON.stringify({ n: 1, route: "tabs", body: { ops: [1] } }));
      conn.send(JSON.stringify({ n: 2, route: "nothing", body: {} }));
      conn.send(JSON.stringify({ n: 3, route: "screen", body: { op: "want" } }));
      conn.send("not json"); // ignored
      conn.send(JSON.stringify({ n: 4, route: "pointer", body: { pad: "x".repeat(5000) } }));
      for (let i = 0; i < 200 && replies.size < 4; i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(replies.get(1).code, 200);
      assert.equal(replies.get(2).code, 404);
      assert.equal(replies.get(3).code, 200);
      assert.equal(replies.get(4).code, 413, "the same caps as a plain request");
    } finally { conn.close(); }
  } finally { h.close(); }
});

test("listen: a taken port falls back to any free one, on loopback only", async () => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const taken = blocker.address().port;
  const s = createJoinerServer({ key: "k".repeat(64), invites: createInvites(), approvals: createApprovals(), joiners: new Map(), tunnelHost: () => null, live: {}, onJoinRequest() {}, log() {} });
  try {
    await s.listen(taken);
    const got = s.server.address();
    assert.notEqual(got.port, taken);
    assert.equal(got.address, "127.0.0.1", "loopback only");
  } finally { s.close(); blocker.close(); }
});
