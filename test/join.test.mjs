import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { encodeJoinCode, parseJoinCode, createApprovals, stripUrl, stripText, newJoinerId, personLabel, appName, displayName, cleanName } from "../scripts/join.mjs";
import { readAccount } from "../scripts/util.mjs";
import { startJoin } from "../scripts/relay.mjs";
import { acceptKey } from "../scripts/ws.mjs";

// A dead joiner is noticed in a few seconds here (push.mjs reads these as it loads).
process.env.PAIRBROWSE_TEST_SILENT_MS = "1500";
process.env.PAIRBROWSE_TEST_GONE_MS = "500";
const { startLiveView, createInvites } = await import("../scripts/liveview.mjs");
import { TabClaims } from "../scripts/collaboration.mjs";

const KEY = "a".repeat(64);
const TUNNEL = "https://quiet-river-tested-jump.trycloudflare.com";
const pack = (obj) => `pb-join:${Buffer.from(JSON.stringify(obj)).toString("base64url")}`;

test("join codes: one string that round-trips", () => {
  const code = encodeJoinCode({ url: `${TUNNEL}/`, key: KEY, role: "drive", label: "Bob <b>" });
  assert.match(code, /^pb-join:[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseJoinCode(`  ${code}\n`), { url: TUNNEL, host: new URL(TUNNEL).host, key: KEY, role: "drive", label: "Bob b", mode: "follow" });
  // A shared browser code says so; codes from before modes follow.
  assert.equal(parseJoinCode(encodeJoinCode({ url: TUNNEL, key: KEY, role: "drive", label: "Bob", mode: "shared" })).mode, "shared");
  assert.equal(parseJoinCode(pack({ v: 1, u: TUNNEL, k: KEY, r: "drive", l: "Bob" })).mode, "follow");
  // A host without a participantName is "the host" (older codes said "PairBrowse").
  assert.equal(parseJoinCode(encodeJoinCode({ url: TUNNEL, key: KEY, role: "watch", label: "" })).label, "the host");
  assert.equal(parseJoinCode(pack({ v: 1, u: TUNNEL, k: KEY, r: "watch", l: "PairBrowse" })).label, "the host");
});

test("join codes are validated strictly", () => {
  const ok = { v: 1, u: TUNNEL, k: KEY, r: "watch", l: "Bob" };
  assert.equal(parseJoinCode(pack(ok)).role, "watch");
  const bad = {
    "not https": { ...ok, u: TUNNEL.replace("https", "http") },
    "another host": { ...ok, u: "https://evil.example.com" },
    "lookalike host": { ...ok, u: "https://x.trycloudflare.com.evil.example" },
    "a port": { ...ok, u: `${TUNNEL}:8443` },
    "a path": { ...ok, u: `${TUNNEL}/x` },
    "a query": { ...ok, u: `${TUNNEL}/?a=1` },
    "credentials": { ...ok, u: "https://u:p@quiet-river.trycloudflare.com" },
    "javascript": { ...ok, u: "javascript:alert(1)" },
    "short key": { ...ok, k: "a".repeat(63) },
    "key with other characters": { ...ok, k: "A".repeat(64) },
    "role": { ...ok, r: "owner" },
    "version": { ...ok, v: 2 },
    "local without the test switch": { ...ok, u: "http://127.0.0.1:4000" },
  };
  for (const [why, v] of Object.entries(bad)) assert.throws(() => parseJoinCode(pack(v)), Error, why);
  for (const junk of ["", "pb-join:", "pb-join:@@@", "hello", `pb-join:${"A".repeat(2000)}`, "pb-join:bm90IGpzb24"]) assert.throws(() => parseJoinCode(junk), Error, junk);
  assert.equal(parseJoinCode(pack({ ...ok, u: "https://share.example.org" }), { hosts: ["share.example.org"] }).url, "https://share.example.org", "a host you listed");
  assert.equal(parseJoinCode(pack({ ...ok, u: "http://127.0.0.1:4000" }), { allowLocal: true }).url, "http://127.0.0.1:4000");
  assert.throws(() => parseJoinCode(pack({ ...ok, u: "http://10.0.0.1:4000" }), { allowLocal: true }));
});

test("approvals: pending until the host says yes, bound to that joiner, capped and rate-limited", () => {
  let t = 1_000_000;
  const a = createApprovals({ now: () => t, maxPending: 2, maxNew: 3, windowMs: 60_000 });
  const inv = { id: "i1", role: "watch" };
  const alice = newJoinerId();
  const first = a.check(inv, alice, "Alice", "claude-code");
  assert.equal(first.state, "pending");
  assert.equal(first.isNew, true);
  assert.equal(first.entry.app, "Claude Code");
  assert.equal(a.check(inv, alice, "Alice").isNew, undefined, "asking again isn't a new request");
  assert.equal(a.check(inv, "not-an-id", "X").state, "bad");
  assert.equal(a.approve(first.entry.id).state, "approved");
  assert.equal(a.check(inv, alice, "Alice").state, "approved");
  const mallory = newJoinerId();
  assert.equal(a.check(inv, mallory, "Alice").state, "pending", "the same code from someone else asks again");
  assert.equal(a.check({ id: "i2", role: "watch" }, alice, "Alice").state, "pending", "an approval is per invite");
  assert.equal(a.check(inv, newJoinerId(), "C").state, "full", "at most maxPending waiting");
  a.deny(mallory);
  assert.equal(a.check(inv, mallory, "M").state, "denied");
  assert.equal(a.approve(mallory), null, "a turned-away joiner can't be approved later");
  assert.equal(a.check(inv, newJoinerId(), "D").state, "busy", "rate-limited after maxNew requests");
  t += 61_000;
  assert.equal(a.check(inv, newJoinerId(), "E").state, "pending");
  a.leave("i1", alice);
  assert.equal(a.check(inv, alice, "Alice").state, "full", "leaving ends the approval");
  a.forget(["i1", "i2"]);
  assert.deepEqual(a.list(), []);
});

test("joiners see addresses without query strings or fragments", () => {
  assert.equal(stripUrl("https://shop.example.com/orders/12?token=abc#x"), "https://shop.example.com/orders/12");
  assert.equal(stripUrl("about:blank"), "about:blank");
  assert.equal(stripText("Opened https://a.example/p?q=secret#f and http://b.example/?x=1"), "Opened https://a.example/p and http://b.example/");
  assert.equal(personLabel("Alice", appName("codex-mcp-client")), "Alice · Codex");
  assert.equal(personLabel("Alice"), "Alice (by hand)");
});

test("addresses in text lose their query string even after brackets, and on IPv6 hosts", () => {
  assert.equal(stripText("see https://en.wikipedia.org/wiki/Foo_(bar)?token=s1 now"), "see https://en.wikipedia.org/wiki/Foo_(bar) now");
  assert.equal(stripText("(https://a.example/?q=(b)&token=s1)"), "(https://a.example/)");
  assert.equal(stripText("http://[::1]:8080/a?token=s1"), "http://[::1]:8080/a");
  assert.equal(stripUrl("not a url?token=s1\nmore"), "not a url");
});

test("names lose every formatting character and never end in half a character", () => {
  assert.equal(cleanName("Al؜ice￹­᠎"), "Alice");
  assert.equal(cleanName(`${"a".repeat(39)}😀`), "a".repeat(39));
  assert.equal(cleanName("\ud800"), "Guest");
  assert.equal(cleanName(JSON.parse('{"toString":""}')), "Guest");
});

test("a person's default name: participantName, PAIRBROWSE_PARTICIPANT, the account's full name, the login; never a stand-in", () => {
  const account = { fullName: "Ada Lovelace", username: "ada" };
  assert.equal(displayName({ configured: "Bob", env: "Carol", ...account }), "Bob");
  assert.equal(displayName({ configured: null, env: "Carol", ...account }), "Carol");
  assert.equal(displayName({ configured: "", env: "You", ...account }), "Ada Lovelace", "an agent's \"You\" names nobody");
  assert.equal(displayName({ configured: "Host", env: undefined, fullName: "", username: "ada" }), "ada");
  assert.equal(displayName({ configured: "PairBrowse", fullName: "Guest" }), "PairBrowse", "only stand-ins: still something");
  assert.equal(displayName({ configured: `<b>${"x".repeat(60)}`, ...account }), "b" + "x".repeat(39), "cleanName's limits");
  assert.equal(displayName({}), "");

  const passwd = () => "root:x:0:0:root:/root:/bin/sh\nada:x:1000:1000:Ada Lovelace,,,:/home/ada:/bin/bash\nbob:x:1001:1001:& Smith:/home/bob:/bin/sh\n";
  const none = () => { throw new Error("not here"); };
  assert.deepEqual(readAccount({ platform: "darwin", user: () => ({ username: "ada" }), run: (cmd, args) => (cmd === "id" && args[0] === "-F" ? "Ada Lovelace\n" : "") }), { fullName: "Ada Lovelace", username: "ada" });
  assert.deepEqual(readAccount({ platform: "darwin", user: () => ({ username: "ada" }), run: none }), { fullName: "", username: "ada" });
  assert.deepEqual(readAccount({ platform: "linux", user: () => ({ username: "ada" }), passwd, run: none }), { fullName: "Ada Lovelace", username: "ada" });
  assert.deepEqual(readAccount({ platform: "linux", user: () => ({ username: "bob" }), passwd, run: none }), { fullName: "Bob Smith", username: "bob" });
  assert.deepEqual(readAccount({ platform: "linux", user: () => ({ username: "eve" }), passwd, run: (cmd, args) => (cmd === "getent" && args[1] === "eve" ? "eve:*:2000:2000:Eve Adams:/home/eve:/bin/sh" : "") }), { fullName: "Eve Adams", username: "eve" }, "directory accounts");
  assert.deepEqual(readAccount({ platform: "win32", user: () => ({ username: "ada" }), run: none, passwd: none }), { fullName: "", username: "ada" });
  assert.deepEqual(readAccount({ platform: "linux", user: none, run: none, passwd: none }), { fullName: "", username: "" });
});

test("tab turns: one agent per tab, expiry, release, one tab per agent", () => {
  let t = 0;
  const c = new TabClaims({ ttlMs: 1000, now: () => t });
  const A = {}, B = {};
  assert.equal(c.claim(A, "x", "Alice · Codex").ok, true);
  const refused = c.claim(A, "y", "Bob · Claude Code");
  assert.equal(refused.ok, false);
  assert.equal(refused.holder.label, "Alice · Codex");
  assert.equal(c.claim(B, "y", "Bob").ok, true, "another tab is free");
  t = 999;
  assert.equal(c.claim(A, "x", "Alice").ok, true, "renewed by its own action");
  t = 1998;
  assert.equal(c.claim(A, "y", "Bob").ok, false);
  t = 2000;
  assert.equal(c.claim(A, "y", "Bob").ok, true, "expired after idling");
  assert.equal(c.holder(B), null, "acting in a new tab ends the old turn");
  c.release("y");
  assert.equal(c.holder(A), null);
  c.claim(B, "x", "Alice");
  c.drop(B);
  assert.equal(c.holder(B), null, "a closed tab's turn ends");
});

test("tab turns: a held tab is shared only on request; both act there, and leaving or releasing ends it", () => {
  let t = 0;
  const c = new TabClaims({ ttlMs: 1000, now: () => t });
  const A = {}, B = {};
  c.claim(A, "x", "Alice · Codex");
  assert.equal(c.claim(A, "y", "Bob").ok, false, "never by chance");
  const s = c.share(A, "y", "Bob · Claude Code");
  assert.deepEqual(s.with.map((m) => m.label), ["Alice · Codex"]);
  assert.equal(c.claim(A, "y", "Bob").ok, true);
  assert.equal(c.claim(A, "x", "Alice").ok, true, "the holder still acts there");
  assert.deepEqual(c.members(A).map((m) => m.id), ["x", "y"]);
  assert.equal(c.claim(A, "z", "Carol").ok, false, "a third agent that wasn't told to share is refused");
  c.release("x");
  assert.equal(c.holder(A).id, "y", "the holder released: the one it shared with holds it");
  c.share(A, "x", "Alice");
  c.claim(B, "y", "Bob");
  assert.deepEqual(c.members(A).map((m) => m.id), ["x"], "acting in another tab leaves the shared one");
  c.share(B, "x", "Alice");
  t = 1500;
  c.claim(B, "x", "Alice");
  assert.deepEqual(c.members(B).map((m) => m.id), ["x"], "an idle member's turn runs out");
  assert.equal(c.holder(A), null);
});

// ---- the guest port, in process ------------------------------------------------------------

// Tabs that load addresses, so the host side of shared tabs runs without a browser.
function fakeBrowser(urls) {
  const pages = [];
  const ctx = { pages: () => pages.filter((p) => !p.closed), newPage: async () => tab("about:blank") };
  function tab(url) {
    const page = new EventEmitter();
    Object.assign(page, { u: url, closed: false, url: () => page.u, title: async () => `Title of ${page.u}`, context: () => ctx, bringToFront: async () => {},
      isClosed: () => page.closed, evaluate: async () => null, goto: async (u) => { page.u = u; }, close: async () => { page.closed = true; } });
    pages.push(page);
    return page;
  }
  for (const u of urls) tab(u);
  return { ctx, pages };
}

function request(port, method, path, { host = `127.0.0.1:${port}`, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, text, json }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}
const who = (id, name = "Alice", app = "claude-code") => ({ "x-pairbrowse-joiner": id, "x-pairbrowse-name": name, "x-pairbrowse-app": app });

async function setup(extra = {}) {
  const invites = createInvites();
  const requests = [];
  const people = [];
  const { ctx, pages } = fakeBrowser(["https://shop.example.com/pay?order=991&token=abc#card", "http://localhost:5173/", "https://bank.example/home?acct=1"]);
  const view = await startLiveView({
    getContext: async () => ctx, currentUrl: async () => pages[0].url(), invites, tunnelHost: () => "quiet-river.trycloudflare.com",
    onJoinRequest: (e) => requests.push(e), secretDomains: () => ["bank.example"],
    onJoinerPerson: (page, name, did, acting, changed) => people.push({ url: page.url(), name, did, ...(changed ? { changed } : {}) }),
    ...extra,
  });
  return { view, invites, requests, people, pages, gport: view.guestPort, port: view.port, ownerKey: view.url.split("/").at(-2) };
}

test("join code keys: nothing before approval, owner approves, bound per joiner, owner key never through the tunnel", async () => {
  const s = await setup();
  try {
    const w = s.invites.create({ role: "watch", label: "Wes", share: "code" });
    const d = s.invites.create({ role: "drive", label: "Dee", share: "code" });
    const alice = newJoinerId(), mallory = newJoinerId(), dee = newJoinerId();
    // Not on the owner's port at all.
    assert.equal((await request(s.port, "GET", `/${w.key}/`)).status, 404);
    assert.equal((await request(s.port, "GET", `/${w.key}/state.json`)).status, 404);
    // The owner's key doesn't work on the guest port, under any host name.
    for (const host of ["quiet-river.trycloudflare.com", `127.0.0.1:${s.gport}`]) {
      assert.equal((await request(s.gport, "GET", `/${s.ownerKey}/tabs`, { host, headers: who(alice) })).status, 404, host);
    }
    assert.equal((await request(s.gport, "GET", `/${w.key}/tabs`, { host: "evil.example", headers: who(alice) })).status, 403, "other host names");
    assert.equal((await request(s.gport, "GET", `/${w.key}/tabs`, { headers: { ...who(alice), origin: "https://quiet-river.trycloudflare.com" } })).status, 403, "browser pages");
    assert.equal((await request(s.gport, "GET", `/${w.key}/tabs`)).status, 400, "no joiner id");
    // First contact: a request for the host, and no content.
    const first = await request(s.gport, "GET", `/${w.key}/tabs`, { host: "quiet-river.trycloudflare.com", headers: who(alice) });
    assert.equal(first.status, 403);
    assert.equal(first.json.waiting, true);
    assert.doesNotMatch(first.text, /shop\.example|Title|tabs/);
    assert.equal(s.requests.length, 1);
    assert.equal(s.requests[0].name, "Alice");
    const pending = await request(s.port, "GET", `/${s.ownerKey}/joins.json`);
    assert.equal(pending.json[0].id, s.requests[0].id);
    // The owner's live view lets Alice in; an invite key can't.
    assert.equal((await request(s.port, "POST", `/${w.key}/approve`, { body: { id: s.requests[0].id, allow: true } })).status, 404);
    assert.equal((await request(s.port, "POST", `/${s.ownerKey}/approve`, { headers: { origin: "https://evil.example" }, body: { id: s.requests[0].id, allow: true } })).status, 403);
    assert.equal((await request(s.port, "POST", `/${s.ownerKey}/approve`, { body: { id: s.requests[0].id, allow: true } })).status, 200);
    const inside = await request(s.gport, "GET", `/${w.key}/tabs`, { headers: who(alice) });
    assert.equal(inside.status, 200);
    assert.equal(inside.json.role, "watch");
    assert.deepEqual(inside.json.tabs.map((t) => t.url), ["https://shop.example.com/pay", "https://bank.example/home"], "watch: origin and path; nothing local");
    assert.ok(!("title" in inside.json.tabs[1]), "a site with saved passwords: the address only");
    assert.doesNotMatch(inside.text, /localhost|token|icon|frame|img/);
    // The old routes (frames, input, an agent acting here) are gone.
    for (const [m, r] of [["GET", "poll"], ["POST", "input"], ["POST", "tab"], ["POST", "mcp"]]) assert.equal((await request(s.gport, m, `/${w.key}/${r}`, { headers: who(alice), ...(m === "POST" ? { body: {} } : {}) })).status, 404, r);
    // Someone else with the same code asks again; turned away, they stay out.
    assert.equal((await request(s.gport, "GET", `/${w.key}/tabs`, { headers: who(mallory, "Alice") })).json.waiting, true);
    await request(s.port, "POST", `/${s.ownerKey}/approve`, { body: { id: s.requests[1].id, allow: false } });
    assert.equal((await request(s.gport, "GET", `/${w.key}/tabs`, { headers: who(mallory) })).json.denied, true);
    // Watchers' changes don't reach the host; an unapproved drive joiner gets nothing.
    const id0 = inside.json.tabs[0].id;
    assert.equal((await request(s.gport, "POST", `/${w.key}/tabs`, { headers: who(alice), body: { ops: [{ op: "navigate", id: id0, url: "https://x.example/" }] } })).status, 403);
    assert.equal((await request(s.gport, "POST", `/${d.key}/tabs`, { headers: who(dee, "Dee"), body: { ops: [] } })).status, 403);
    s.view.approvals.approve(s.requests.at(-1).id);
    // Drive: the query string too, minus tokens; changes go to the host's browser; local addresses never.
    const drive = await request(s.gport, "GET", `/${d.key}/tabs`, { headers: who(dee, "Dee") });
    assert.equal(drive.json.tabs[0].url, "https://shop.example.com/pay?order=991");
    assert.equal((await request(s.gport, "POST", `/${d.key}/tabs`, { headers: who(dee, "Dee"), body: { ops: [{ op: "navigate", id: id0, url: "http://192.168.1.1/" }] } })).status, 400);
    assert.equal(s.pages[0].url(), "https://shop.example.com/pay?order=991&token=abc#card", "the host's tab stayed");
    const ok = await request(s.gport, "POST", `/${d.key}/tabs`, { headers: who(dee, "Dee"), body: { ops: [{ op: "navigate", id: id0, url: "https://shop.example.com/cart?token=x" }, { op: "open", ref: "n1", url: "https://docs.example/a" }, { op: "person", id: id0, did: ['typed in "Email"'] }] } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(s.pages[0].url(), "https://shop.example.com/cart");
    assert.equal(s.pages.at(-1).url(), "https://docs.example/a");
    assert.match(ok.json.opened.n1, /^[0-9a-f]{8}$/);
    assert.deepEqual(s.people.at(-1), { url: "https://shop.example.com/cart", name: "Dee", did: ['typed in "Email"'] }, "a person there counts as a person here");
    // Their tab changes make refs here stale; only being in the tab doesn't (elsewhere() decides from what they did).
    assert.deepEqual(s.people.slice(-3).map((p) => !!p.changed), [true, true, false]);
    assert.equal((await request(s.gport, "POST", `/${d.key}/tabs`, { headers: who(dee, "Dee"), body: "not json" })).status, 400);
    // The owner takes a yes back (Remove): out at once, not let in again by this invite, and an
    // invite key can't do it.
    const deeReq = s.requests.at(-1).id;
    assert.equal((await request(s.port, "POST", `/${d.key}/approve`, { body: { id: deeReq, remove: true } })).status, 404);
    assert.equal((await request(s.port, "POST", `/${s.ownerKey}/approve`, { body: { id: deeReq, remove: true } })).status, 200);
    const out = await request(s.gport, "GET", `/${d.key}/tabs`, { headers: who(dee, "Dee") });
    assert.equal(out.status, 403);
    assert.equal(out.json.removed, true);
    assert.doesNotMatch(out.text, /shop\.example/);
    assert.equal(s.view.approvals.approve(deeReq), null, "a removed joiner can't be let back in on this invite");
    assert.equal((await request(s.port, "POST", `/${s.ownerKey}/approve`, { body: { id: deeReq, remove: true } })).status, 404, "only someone let in can be removed");
    // Revoked: gone at once.
    s.invites.revoke(w.id);
    assert.equal((await request(s.gport, "GET", `/${w.key}/tabs`, { headers: who(alice) })).status, 404);
  } finally { s.view.close(); }
});

test("a joiner who goes (invite revoked, removed) leaves nothing behind: their agent here, pictures and what they said", async () => {
  const stopped = [], gone = [];
  const remoteAgents = { stop: (k) => stopped.push(k), folder: () => "/nonexistent", line: () => true, file: () => ({}) };
  const s = await setup({ remoteAgents, shared: { onJoinerGone: (k) => gone.push(k) } });
  try {
    const d = s.invites.create({ role: "drive", label: "Dee", share: "code" });
    const e = s.invites.create({ role: "drive", label: "Eve", share: "code" });
    const dee = newJoinerId(), eve = newJoinerId();
    await request(s.gport, "GET", `/${d.key}/tabs`, { headers: who(dee, "Dee") });
    await request(s.gport, "GET", `/${e.key}/tabs`, { headers: who(eve, "Eve") });
    for (const r of s.requests) s.view.approvals.approve(r.id);
    assert.equal((await request(s.gport, "GET", `/${d.key}/tabs`, { headers: who(dee, "Dee") })).status, 200);
    // Revoked invite: their agent (and its tab turns) stop at once, not only their channel.
    s.invites.revoke(d.id);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(stopped, [`${d.id}:${dee}`]);
    assert.deepEqual(gone, [`${d.id}:${dee}`]);
    // Removed before they ever came back in: stopped by key all the same.
    const eveReq = s.requests.find((r) => r.name === "Eve").id;
    assert.equal((await request(s.port, "POST", `/${s.ownerKey}/approve`, { body: { id: eveReq, remove: true } })).status, 200);
    assert.equal(stopped.at(-1), `${e.id}:${eve}`);
    assert.equal(gone.at(-1), `${e.id}:${eve}`);
  } finally { s.view.close(); }
});

test("the joiner's connection: asks, waits for approval, then gets the shared tabs and sends changes", async () => {
  const s = await setup();
  try {
    const d = s.invites.create({ role: "drive", label: "Dee", share: "code" });
    const got = [];
    const phases = [];
    const j = startJoin({ join: { url: `http://127.0.0.1:${s.gport}`, key: d.key, role: "drive", label: "Bob" }, name: "Dee", pollMs: 50, onTabs: async (st) => got.push(st), onChange: (p) => phases.push(p) });
    for (let i = 0; i < 40 && j.phase !== "waiting"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(j.phase, "waiting");
    assert.equal(got.length, 0, "nothing before approval");
    s.view.approvals.approve(s.requests[0].id);
    for (let i = 0; i < 100 && j.phase !== "in"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(j.phase, "in");
    for (let i = 0; i < 40 && !got.length; i++) await new Promise((r) => setTimeout(r, 50));
    const id0 = got.at(-1).tabs[0].id;
    assert.ok((await j.send([{ op: "navigate", id: id0, url: "https://shop.example.com/done" }]))?.ok);
    assert.equal(s.pages[0].url(), "https://shop.example.com/done");
    await j.leave();
    assert.equal(j.phase, "left");
    assert.equal(s.view.approvals.list().length, 0, "leaving ends the approval");
  } finally { s.view.close(); }
});

test("the joiner's status when the tunnel answers for a host that's gone: plain words, still asking", async () => {
  const { createServer } = await import("node:http");
  const tunnel = createServer((req, res) => { res.writeHead(530, { "content-type": "text/html" }); res.end("<html>error code: 1033</html>"); });
  await new Promise((r) => tunnel.listen(0, "127.0.0.1", r));
  const j = startJoin({ join: { url: `http://127.0.0.1:${tunnel.address().port}`, key: "k".repeat(43), role: "drive", label: "Bob" }, name: "Dee" });
  try {
    // Right after a code is made the tunnel's edge may answer this way for a moment: it keeps asking.
    for (let i = 0; i < 40 && j.message.startsWith("Asking"); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(j.phase, "asking");
    assert.equal(j.message, "Reaching Bob's session…");
    assert.doesNotMatch(j.message, /530/);
  } finally { await j.leave().catch(() => {}); tunnel.close(); }
});

test("a joiner whose helper died (no pong to any ping) is gone within seconds, their agent stopped, the host told; the yes stands", async () => {
  const stopped = [], lost = [];
  const remoteAgents = { stop: (k) => stopped.push(k), folder: () => "/nonexistent", line: () => true, file: () => ({}) };
  const s = await setup({ remoteAgents, shared: { onJoinerLost: (j) => lost.push(j.name) } });
  try {
    const d = s.invites.create({ role: "drive", label: "Dee", share: "code" });
    const dee = newJoinerId();
    await request(s.gport, "GET", `/${d.key}/tabs`, { headers: who(dee, "Dee") });
    s.view.approvals.approve(s.requests[0].id);
    // A push channel that answers nothing: the socket stays open (as a tunnel keeps it after a kill).
    const key = Buffer.alloc(16, 7).toString("base64");
    const sock = await new Promise((ok, no) => {
      const req = http.request({ host: "127.0.0.1", port: s.gport, path: `/${d.key}/events`, headers: { ...who(dee, "Dee"), connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": key } });
      req.on("upgrade", (res, socket) => { assert.equal(res.headers["sec-websocket-accept"], acceptKey(key)); ok(socket); });
      req.on("response", (res) => no(new Error(`answered ${res.statusCode}`)));
      req.end();
    });
    sock.on("data", () => {}); // reads, never pongs
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(s.view.joinersNow().some((j) => j.who === "Dee"), "there while the channel is fresh");
    for (let i = 0; i < 100 && !lost.length; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(lost, ["Dee"], "lost within seconds of the first unanswered pings");
    assert.deepEqual(stopped, [`${d.id}:${dee}`], "their agent here stopped: its tab turns end");
    assert.ok(!s.view.joinersNow().some((j) => j.who === "Dee"), "not listed any more");
    assert.equal(s.view.approvals.get(d.id, dee)?.state, "approved", "a rejoin asks nothing new");
    assert.equal((await request(s.gport, "GET", `/${d.key}/tabs`, { headers: who(dee, "Dee") })).status, 200, "and works at once");
    sock.destroy();
  } finally { s.view.close(); }
});

test("a join right after a fresh tunnel keeps asking quietly; a code that doesn't work is refused at once", async () => {
  // Nothing answers yet (the name hasn't reached this resolver): asking, not "can't reach".
  const closed = http.createServer(); await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const port = closed.address().port; await new Promise((r) => closed.close(r));
  const j = startJoin({ join: { url: `http://127.0.0.1:${port}`, key: "k".repeat(43), role: "drive", label: "Bob" }, name: "Dee" });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(j.phase, "asking");
    assert.equal(j.message, "Reaching Bob's session…");
  } finally { await j.leave().catch(() => {}); }
  // The host answers 404: revoked, expired or a wrong key. Ended, and no more retries.
  const s = await setup();
  try {
    let hits = 0;
    const bad = startJoin({ join: { url: `http://127.0.0.1:${s.gport}`, key: "b".repeat(64), role: "drive", label: "Bob" }, name: "Dee" });
    for (let i = 0; i < 60 && bad.phase !== "ended"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(bad.phase, "ended");
    assert.match(bad.message, /doesn't work any more/);
    hits = s.requests.length;
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.requests.length, hits, "stopped: nothing more reaches the host");
  } finally { s.view.close(); }
});

test("letting a joiner in through Claude always asks; turning one away doesn't", async () => {
  const { decide, forHost } = await import("../scripts/guard.mjs");
  const verdict = (tool, input) => decide({ tool_name: `mcp__plugin_pairbrowse_browser__${tool}`, tool_input: input }, { confirm: [] }, null).hookSpecificOutput.permissionDecision;
  assert.equal(verdict("pairbrowse_invite", { action: "approve", id: "r123456" }), "ask");
  assert.equal(verdict("pairbrowse_invite", { action: "deny", id: "r123456" }), "allow");
  assert.equal(verdict("pairbrowse_invite", { action: "create", role: "drive", share: "code" }), "ask");
  assert.equal(verdict("pairbrowse_join", { action: "join", code: "pb-join:x" }), "allow");
  // Codex can't ask: an approval is refused there and handed to the user (the live view's Allow).
  const codex = JSON.parse(forHost({ tool_name: "mcp__pairbrowse_browser__pairbrowse_invite" }, decide({ tool_name: "mcp__pairbrowse_browser__pairbrowse_invite", tool_input: { action: "approve", id: "r1" } }, { confirm: [] }, null)));
  assert.equal(codex.hookSpecificOutput.permissionDecision, "deny");
});

test("the host's other tunnel addresses: Quick Tunnels or the code's own only", async () => {
  const { relayUrl } = await import("../scripts/relay.mjs");
  const code = "https://one-two.trycloudflare.com";
  assert.equal(relayUrl("https://three-four.trycloudflare.com", code), "https://three-four.trycloudflare.com");
  assert.equal(relayUrl(code, code), code);
  assert.equal(relayUrl("https://evil.example.com", code), null);
  assert.equal(relayUrl("https://x.trycloudflare.com/path", code), null);
  assert.equal(relayUrl("http://127.0.0.1:9", code), null, "loopback only in tests");
  assert.equal(relayUrl("https://u:p@x.trycloudflare.com", code), null);
});

test("a code's address: Quick Tunnels and exactly the hosts the person allowed; any other is theirs to decide", async () => {
  const { hostAllowed, cleanHost, joinHostsOf } = await import("../scripts/join.mjs");
  const ok = { v: 1, u: "https://share.example.org", k: KEY, r: "watch", l: "Bob" };
  const thrown = (fn) => { try { fn(); } catch (e) { return e; } assert.fail("didn't throw"); };
  // Allowed: the code reads as usual.
  assert.equal(parseJoinCode(pack(ok), { hosts: ["share.example.org"] }).host, "share.example.org");
  // Unlisted: refused, with the host on the error so the person can be asked.
  const err = thrown(() => parseJoinCode(pack(ok)));
  assert.equal(err.code, "unlisted-host");
  assert.equal(err.host, "share.example.org");
  assert.match(err.message, /share\.example\.org.*isn't a Cloudflare Quick Tunnel address/);
  assert.equal(thrown(() => parseJoinCode(pack({ ...ok, u: "https://Share.Example.ORG" }))).host, "share.example.org", "lower-cased");
  // Not a question for anyone: a port, http, a path, a damaged key (code stays undefined).
  for (const v of [{ ...ok, u: "https://share.example.org:8443" }, { ...ok, u: "http://share.example.org" }, { ...ok, u: "https://share.example.org/x" }, { ...ok, k: "x" }]) {
    assert.equal(thrown(() => parseJoinCode(pack(v))).code, undefined, JSON.stringify(v));
  }
  // Exact names only: no suffix, wildcard or lookalike match.
  assert.equal(hostAllowed("share.example.org", ["share.example.org"]), true);
  assert.equal(hostAllowed("a.share.example.org", ["share.example.org"]), false);
  assert.equal(hostAllowed("share.example.org.evil.example", ["share.example.org"]), false);
  assert.equal(hostAllowed("example.org", ["share.example.org"]), false);
  assert.equal(hostAllowed("x.trycloudflare.com", []), true);
  assert.equal(hostAllowed("share.example.org", ["*.example.org"]), false);
  assert.equal(cleanHost(" Share.Example.org "), "share.example.org");
  for (const junk of ["*.example.org", "share.example.org:443", "https://share.example.org", "share", "-a.example.org", "a..b", "", 42, { toString: "" }]) assert.equal(cleanHost(junk), "", JSON.stringify(junk));
  assert.deepEqual(joinHostsOf({ joinHosts: ["A.example.org", "*.bad", "a.example.org", 7] }), ["a.example.org"]);
  assert.deepEqual(joinHostsOf({ joinHosts: "a.example.org" }), []);
});

test("Always allow writes the exact host into joinHosts in config.json and keeps the rest; Remove takes it out", async () => {
  const { saveJoinHosts } = await import("../scripts/join.mjs");
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pb-joinhosts-"));
  const file = join(dir, "config.json");
  try {
    writeFileSync(file, JSON.stringify({ participantName: "Alice", joinHosts: ["old.example.org"] }));
    const config = { participantName: "Alice", joinHosts: ["old.example.org"] };
    assert.deepEqual(saveJoinHosts(config, [...config.joinHosts, "Share.Example.org", "*.bad", "share.example.org"], file), ["old.example.org", "share.example.org"]);
    assert.deepEqual(config.joinHosts, ["old.example.org", "share.example.org"], "the running config too");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { participantName: "Alice", joinHosts: ["old.example.org", "share.example.org"] });
    assert.deepEqual(saveJoinHosts(config, ["share.example.org"], file), ["share.example.org"]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).joinHosts, ["share.example.org"]);
    // No config file yet, or a broken one: written anew, nothing thrown.
    writeFileSync(file, "{ not json");
    assert.deepEqual(saveJoinHosts({}, ["a.example.org"], file), ["a.example.org"]);
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { joinHosts: ["a.example.org"] });
    const fresh = join(dir, "new", "config.json");
    saveJoinHosts({}, ["b.example.org"], fresh);
    assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")), { joinHosts: ["b.example.org"] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the person's questions about a code's address: one per code, few at once, ten minutes each", async () => {
  const { createHostAsks } = await import("../scripts/join.mjs");
  let t = 1_000_000;
  const asks = createHostAsks({ now: () => t, maxPending: 2 });
  let changes = 0;
  asks.onChange(() => changes++);
  const a = asks.add({ host: "share.example.org", code: "pb-join:aaa", name: "Alice", owner: "conn1", app: "claude-code", who: "Claude Code" });
  assert.match(a.id, /^h[0-9a-f]{6}$/);
  assert.deepEqual(a, { id: a.id, host: "share.example.org", who: "Claude Code", at: t }, "no code or name in the public view");
  assert.equal(asks.add({ host: "share.example.org", code: "pb-join:aaa" }).id, a.id, "the same code asks once");
  const b = asks.add({ host: "t.example.net", code: "pb-join:bbb", owner: "picker" });
  assert.equal(asks.add({ host: "c.example.net", code: "pb-join:ccc" }), null, "too many wait");
  assert.deepEqual(asks.list().map((x) => x.host), ["share.example.org", "t.example.net"]);
  const taken = asks.take(a.id);
  assert.deepEqual({ code: taken.code, name: taken.name, owner: taken.owner, app: taken.app }, { code: "pb-join:aaa", name: "Alice", owner: "conn1", app: "claude-code" }, "taken whole, once");
  assert.equal(asks.take(a.id), null);
  t += 10 * 60_000;
  assert.deepEqual(asks.list(), [], "timed out");
  assert.equal(asks.take(b.id), null);
  assert.ok(changes >= 4);
});

test("pairbrowse_join with an unlisted address: refused for agents, a question for the person, and their Cancel or Remove", async () => {
  const { createFollow } = await import("../scripts/daemon/follow.mjs");
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "pb-follow-hosts-"));
  const configFile = join(dir, "config.json");
  writeFileSync(configFile, JSON.stringify({ participantName: "Alice", joinHosts: ["kept.example.org"] }));
  const config = { participantName: "Alice", joinHosts: ["kept.example.org"] };
  const states = [];
  const notes = [];
  const hud = { onActivity() {}, addActivity() {}, setSharedSpark() {}, setPersonMark() {}, setReconnecting() {}, showPointers() {} };
  const follow = createFollow({ config, log() {}, context: {}, hud, presence: {}, liveView: () => null, secretDomains: () => [], forms: {}, tabOrder: {}, note: (t) => notes.push(t), onHostChange: (s) => states.push(s), configFile });
  try {
    const code = encodeJoinCode({ url: "https://share.example.org", key: KEY, role: "watch", label: "Bob" });
    // An agent: refused, told to ask the user; the question is up in the side panel with the code.
    const r = await follow.command({ action: "join", code }, { owner: "conn1", app: "claude-code" });
    assert.equal(r.error, true);
    assert.match(r.text, /^Not joining: This code leads to share\.example\.org, not a PairBrowse address.*Ask the user to allow it in the PairBrowse side panel.*Never allow an address for them/s);
    assert.equal(states.at(-1).asks.length, 1);
    assert.deepEqual(states.at(-1).hosts, [{ host: "kept.example.org", always: true }]);
    assert.equal(states.at(-1).asks[0].host, "share.example.org");
    assert.equal(states.at(-1).asks[0].who, "Claude Code");
    assert.match((await follow.command({ action: "status" }, {})).text, /Not in anyone's session\. Waiting for the user to allow share\.example\.org in the PairBrowse side panel.*allowed besides \*\.trycloudflare\.com: kept\.example\.org \(always\)/);
    // The same code again: the same question, not a second one.
    await follow.command({ action: "join", code }, { owner: "conn2", app: "codex-mcp-client" });
    assert.equal(follow.hostState().asks.length, 1);
    // From the picker: the question comes back to it too.
    const p = await follow.command({ action: "join", code: encodeJoinCode({ url: "https://t.example.net", key: KEY, role: "drive", label: "Bob" }) }, { owner: "picker", app: "PairBrowse" });
    assert.equal(p.error, true);
    assert.equal(p.hostAsk.host, "t.example.net");
    assert.match(p.text, /Join through it\? Allow once, Always allow, or Cancel\./);
    assert.equal(follow.hostState().asks.length, 2);
    // Cancel: gone, nothing allowed, nothing written.
    assert.deepEqual(await follow.decideHost({ op: "cancel", id: p.hostAsk.id }), { ok: true, host: "t.example.net", owner: "picker" });
    assert.equal(follow.hostState().asks.length, 1);
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")).joinHosts, ["kept.example.org"]);
    assert.equal((await follow.decideHost({ op: "cancel", id: p.hostAsk.id })).error, "That question is gone (answered, or it timed out after 10 minutes).");
    // Remove an allowed address: out of config.json and the running config.
    assert.deepEqual(await follow.decideHost({ op: "forget", host: "kept.example.org" }), { ok: true, host: "kept.example.org" });
    assert.deepEqual(JSON.parse(readFileSync(configFile, "utf8")), { participantName: "Alice", joinHosts: [] });
    assert.deepEqual(follow.hostState().hosts, []);
    for (const bad of [{ op: "forget", host: "*.x" }, { op: "allow", id: "nope" }, { op: "steal" }, null]) assert.ok((await follow.decideHost(bad)).error, JSON.stringify(bad));
    assert.deepEqual(notes, [], "agents hear nothing until the person says yes");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
