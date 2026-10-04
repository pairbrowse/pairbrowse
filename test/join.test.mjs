import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { encodeJoinCode, parseJoinCode, createApprovals, stripUrl, stripText, newJoinerId, personLabel, appName, displayName } from "../scripts/join.mjs";
import { readAccount } from "../scripts/util.mjs";
import { startJoin } from "../scripts/relay.mjs";
import { startLiveView, createInvites } from "../scripts/liveview.mjs";
import { TabClaims } from "../scripts/collaboration.mjs";

const KEY = "a".repeat(64);
const TUNNEL = "https://quiet-river-tested-jump.trycloudflare.com";
const pack = (obj) => `pb-join:${Buffer.from(JSON.stringify(obj)).toString("base64url")}`;

test("join codes: one string that round-trips", () => {
  const code = encodeJoinCode({ url: `${TUNNEL}/`, key: KEY, role: "drive", label: "Bob <b>" });
  assert.match(code, /^pb-join:[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseJoinCode(`  ${code}\n`), { url: TUNNEL, host: new URL(TUNNEL).host, key: KEY, role: "drive", label: "Bob b" });
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
    // Revoked: gone at once.
    s.invites.revoke(w.id);
    assert.equal((await request(s.gport, "GET", `/${w.key}/tabs`, { headers: who(alice) })).status, 404);
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

test("the joiner's status when the tunnel answers for a host that's gone: plain words, still retrying", async () => {
  const { createServer } = await import("node:http");
  const tunnel = createServer((req, res) => { res.writeHead(530, { "content-type": "text/html" }); res.end("<html>error code: 1033</html>"); });
  await new Promise((r) => tunnel.listen(0, "127.0.0.1", r));
  const j = startJoin({ join: { url: `http://127.0.0.1:${tunnel.address().port}`, key: "k".repeat(43), role: "drive", label: "Bob" }, name: "Dee" });
  try {
    for (let i = 0; i < 40 && j.phase !== "offline"; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(j.phase, "offline");
    assert.match(j.message, /Can't reach the host's session/);
    assert.doesNotMatch(j.message, /530/);
  } finally { await j.leave().catch(() => {}); tunnel.close(); }
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
