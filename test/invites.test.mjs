import "./helpers/home.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startLiveView, createInvites, hostOk, liveViewHostsFrom, inviteBaseFrom, inviteLabel, roleMay } from "../scripts/liveview.mjs";
import { roleOf } from "../scripts/liveview/invites.mjs";

const context = { pages: () => [] };
const profile = { get: () => ({ details: [{ label: "Email", value: "me@example.com" }], secrets: [], problem: null }), setDetail: () => null, forgetDetail() {}, setSecret: () => null, deleteSecret() {} };

async function live(options = {}) {
  const view = await startLiveView({ getContext: async () => context, currentUrl: async () => "about:blank", profile, ...options });
  return { view, port: view.port, key: view.url.split("/").at(-2) };
}

// A raw request, so the Host and Origin headers can be set the way a browser (or a tunnel) would.
function request(port, method, path, { host = `127.0.0.1:${port}`, origin, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, ...(origin ? { origin } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) };
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

// Opens an event stream and resolves once its first events arrived; ended() resolves when the server ends it.
function stream(port, path, host = `127.0.0.1:${port}`) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers: { host } }, (res) => {
      let text = "";
      let done;
      const ended = new Promise((r) => (done = r));
      res.on("data", (d) => { text += d; if (text.includes("event: activity")) resolve({ status: res.statusCode, text: () => text, ended, close: () => req.destroy() }); });
      res.on("end", () => done(text));
      res.on("close", () => done(text));
      if (res.statusCode !== 200) resolve({ status: res.statusCode, text: () => text, ended, close: () => req.destroy() });
    });
    req.on("error", reject);
  });
}

test("rights per role: watch only watches, drive also drives, neither reaches the Profile panel", () => {
  for (const r of ["page", "events", "thumb", "state"]) for (const role of ["watch", "drive", "owner"]) assert.equal(roleMay(role, r), true, `${role} ${r}`);
  assert.equal(roleMay("watch", "input"), false);
  assert.equal(roleMay("watch", "tab"), false);
  assert.equal(roleMay("drive", "input"), true);
  assert.equal(roleMay("drive", "tab"), true);
  for (const role of ["watch", "drive"]) assert.equal(roleMay(role, "profile"), false, role);
  assert.equal(roleMay("owner", "profile"), true);
  assert.equal(roleMay("nobody", "page"), false);
  for (const r of ["layout", "strip", "timeline", "config", "outline", "tools", "activity"]) { assert.equal(roleMay("owner", r), true, r); for (const role of ["watch", "drive"]) assert.equal(roleMay(role, r), false, `${role} ${r}`); }
});

test("invite store: roles, labels, expiry and limits", () => {
  let t = 1_000_000;
  const invites = createInvites({ now: () => t });
  assert.throws(() => invites.create({ role: "admin" }), /watch.*drive.*approve/);
  assert.throws(() => invites.create({ role: "watch", hours: -1 }), /hours/);
  assert.equal(invites.create({ label: "Dee" }).role, "drive", "drive unless watch is asked for");
  const a = invites.create({ role: "watch", label: "  Alice <script>‮  " });
  assert.equal(a.label, "Alice script");
  assert.equal(a.expiresAt - a.createdAt, 24 * 3_600_000, "24 hours by default");
  assert.match(a.key, /^[0-9a-f]{64}$/);
  const b = invites.create({ role: "drive", label: "Bob", hours: 1000 });
  assert.equal(b.expiresAt - b.createdAt, 168 * 3_600_000, "at most 7 days");
  assert.equal(inviteLabel("x".repeat(80)).length, 40);
  assert.equal(inviteLabel(""), "Guest");
  assert.ok(!invites.list().some((i) => "key" in i), "list never shows keys");
  assert.equal(invites.match(a.key).role, "watch");
  assert.equal(invites.match(b.key).role, "drive");
  assert.equal(invites.match(a.key.slice(1)), null);
  assert.equal(invites.match(""), null);
  t += 24 * 3_600_000;
  assert.equal(invites.match(a.key), null, "expired");
  assert.equal(invites.list().length, 1);
  assert.equal(invites.revoke(b.id), true);
  assert.equal(invites.match(b.key), null, "revoked");
  assert.equal(invites.revoke(b.id), false);
});

test("the approve role: shared browser codes only, drive underneath, switched between drive and approve", () => {
  let t = 1_000_000;
  const invites = createInvites({ now: () => t });
  const a = invites.create({ role: "approve", label: "Alex", share: "code" });
  // Underneath it is a drive invite (every drive right and check holds as it is), approve on top.
  assert.deepEqual([a.role, a.approve, roleOf(a)], ["drive", true, "approve"]);
  assert.equal(invites.match(a.key).approve, true);
  assert.equal(roleOf(invites.get(a.id)), "approve");
  assert.equal(roleMay(invites.match(a.key).role, "input"), true);
  assert.throws(() => invites.create({ role: "approve" }), /shared browser join codes only/, "a link can't approve");
  assert.throws(() => invites.create({ role: "approve", share: "code", mode: "follow" }), /shared browser join codes only/, "nor a follow code");
  const d = invites.create({ role: "drive", share: "code", label: "Dee" });
  const w = invites.create({ role: "watch", share: "code", label: "Wes" });
  const f = invites.create({ role: "drive", share: "code", mode: "follow", label: "Fay" });
  const heard = [];
  invites.onRole((id) => heard.push(id));
  assert.equal(roleOf(invites.setRole(d.id, "approve")), "approve");
  assert.equal(roleOf(invites.setRole(d.id, "approve")), "approve", "the same role again: nothing changes");
  assert.equal(roleOf(invites.setRole(a.id, "drive")), "drive");
  assert.deepEqual(heard, [d.id, a.id], "each change heard once");
  assert.throws(() => invites.setRole(w.id, "approve"), /watch only/);
  assert.throws(() => invites.setRole(d.id, "watch"), /drive.*approve/);
  assert.throws(() => invites.setRole(f.id, "approve"), /shared browser join codes only/);
  assert.throws(() => invites.setRole("0badc0de", "approve"), /No such invite/);
  // Saved and restored with the code: approve survives a restart only where it may hold.
  const saved = invites.savedCodes();
  const again = createInvites({ now: () => t });
  assert.equal(again.restore([...saved, { ...saved.find((i) => i.id === f.id), id: "0000aaaa", approve: true }, { ...saved.find((i) => i.id === w.id), id: "0000bbbb", approve: true }]), 6);
  assert.equal(roleOf(again.get(d.id)), "approve");
  assert.equal(roleOf(again.get(a.id)), "drive");
  assert.equal(roleOf(again.get("0000aaaa")), "drive", "a follow code never comes back as approve");
  assert.equal(roleOf(again.get("0000bbbb")), "watch", "a watch code never comes back as approve");
  t += 25 * 3_600_000;
  assert.equal(invites.get(d.id), null, "expired");
});

test("watch links: page and events, no input, tabs or profile", async () => {
  const invites = createInvites();
  const { view, port, key } = await live({ invites });
  try {
    const w = invites.create({ role: "watch", label: "Wendy" });
    const page = await request(port, "GET", `/${w.key}/`);
    assert.equal(page.status, 200);
    assert.match(page.text, /<body data-role="watch" /);
    assert.equal((await request(port, "GET", `/${w.key}/state.json`)).status, 200);
    assert.equal((await request(port, "POST", `/${w.key}/input`, { body: { type: "text", text: "x" } })).status, 403);
    assert.equal((await request(port, "POST", `/${w.key}/tab`, { body: { new: true } })).status, 403);
    assert.equal((await request(port, "GET", `/${w.key}/profile.json`)).status, 403);
    assert.equal((await request(port, "POST", `/${w.key}/profile`, { body: { op: "deleteSecret", name: "X" } })).status, 403);
    // The owner's own link keeps every right.
    assert.match((await request(port, "GET", `/${key}/`)).text, /<body data-role="owner" /);
    assert.equal((await request(port, "GET", `/${key}/profile.json`)).status, 200);
  } finally { view.close(); }
});

test("drive links: input and tabs, still no profile", async () => {
  const invites = createInvites();
  const humans = [];
  const { view, port } = await live({ invites, onHumanInput: (page, who, changes = true) => humans.push(changes) });
  try {
    const d = invites.create({ role: "drive", label: "Dan" });
    assert.equal((await request(port, "POST", `/${d.key}/input`, { body: { type: "text", text: "x" } })).status, 204);
    assert.equal((await request(port, "POST", `/${d.key}/tab`, { body: { i: 0 } })).status, 204);
    assert.equal(humans.length, 2, "a guest's input counts as a human's, so Claude waits");
    // Only moving the pointer or scrolling: still a person there, but nothing an agent's refs point at changed.
    assert.equal((await request(port, "POST", `/${d.key}/input`, { body: [{ type: "mouse", action: "mouseMoved", x: 5, y: 5 }, { type: "wheel", x: 5, y: 5, dy: 10 }] })).status, 204);
    assert.deepEqual(humans, [true, true, false]);
    assert.equal((await request(port, "GET", `/${d.key}/profile.json`)).status, 403);
    assert.equal((await request(port, "POST", `/${d.key}/profile`, { body: { op: "setDetail", label: "a", value: "b" } })).status, 403);
    assert.equal((await request(port, "POST", `/${d.key}/input`, { origin: "https://evil.example", body: { type: "text", text: "x" } })).status, 403, "cross-site");
  } finally { view.close(); }
});

test("expired, revoked and unknown keys get 404 like a wrong key", async () => {
  let t = Date.now();
  const invites = createInvites({ now: () => t });
  const { view, port } = await live({ invites });
  try {
    const a = invites.create({ role: "drive", label: "A", hours: 1 });
    const b = invites.create({ role: "watch", label: "B" });
    assert.equal((await request(port, "GET", `/${a.key}/`)).status, 200);
    t += 3_600_001;
    assert.equal((await request(port, "GET", `/${a.key}/`)).status, 404, "expired");
    assert.equal((await request(port, "POST", `/${a.key}/input`, { body: { type: "text", text: "x" } })).status, 404);
    invites.revoke(b.id);
    assert.equal((await request(port, "GET", `/${b.key}/`)).status, 404, "revoked");
    assert.equal((await request(port, "GET", `/${"0".repeat(64)}/`)).status, 404, "unknown");
  } finally { view.close(); }
});

test("revoking ends an open live view at once; guests show as participants; profile updates stay with the owner", async () => {
  const invites = createInvites();
  const { view, port, key } = await live({ invites });
  try {
    const g = invites.create({ role: "watch", label: "Gina" });
    const guest = await stream(port, `/${g.key}/events`);
    assert.equal(guest.status, 200);
    assert.match(guest.text(), /"guests":\[\{"label":"Gina","role":"watch"\}\]/);
    const state = JSON.parse((await request(port, "GET", `/${key}/state.json`)).text);
    assert.deepEqual(state.collaboration.guests, [{ label: "Gina", role: "watch" }]);
    view.setProfile({ details: [{ label: "Email", value: "secret@example.com" }], secrets: [] });
    view.addActivity("after profile");
    await new Promise((r) => setTimeout(r, 50));
    assert.doesNotMatch(guest.text(), /event: profile|secret@example\.com/);
    invites.revoke(g.id);
    await guest.ended;
    const after = JSON.parse((await request(port, "GET", `/${key}/state.json`)).text);
    assert.deepEqual(after.collaboration.guests, []);
  } finally { view.close(); }
});

test("liveViewHosts: extra names take invite links only, never the owner's key", async () => {
  const invites = createInvites();
  const { view, port, key } = await live({ invites, hosts: ["myhost.tail1234.ts.net"], inviteOrigin: "https://myhost.tail1234.ts.net" });
  try {
    const host = "myhost.tail1234.ts.net";
    const w = invites.create({ role: "watch", label: "W" });
    const d = invites.create({ role: "drive", label: "D" });
    assert.equal((await request(port, "GET", `/${w.key}/`, { host })).status, 200);
    assert.equal((await request(port, "GET", `/${key}/`, { host })).status, 404, "owner key through the extra name");
    assert.equal((await request(port, "GET", `/${w.key}/`, { host: "other.ts.net" })).status, 403, "unlisted name");
    const origin = "https://myhost.tail1234.ts.net";
    assert.equal((await request(port, "POST", `/${d.key}/input`, { host, origin, body: { type: "text", text: "x" } })).status, 204, "drive posts from the invite origin");
    assert.equal((await request(port, "POST", `/${w.key}/input`, { host, origin, body: { type: "text", text: "x" } })).status, 403, "watch never posts");
    assert.equal((await request(port, "POST", `/${key}/input`, { origin, body: { type: "text", text: "x" } })).status, 403, "the invite origin isn't the owner's");
  } finally { view.close(); }
});

test("hostOk with liveViewHosts", () => {
  const hosts = ["myhost.tail1234.ts.net"];
  assert.equal(hostOk("myhost.tail1234.ts.net", hosts), true);
  assert.equal(hostOk("MyHost.tail1234.ts.net:443", hosts), true);
  assert.equal(hostOk("127.0.0.1:4000", hosts), true);
  assert.equal(hostOk("evil.myhost.tail1234.ts.net", hosts), false);
  assert.equal(hostOk("myhost.tail1234.ts.net.evil.example", hosts), false);
  assert.equal(hostOk("myhost.tail1234.ts.net@evil", hosts), false);
  assert.equal(hostOk("myhost.tail1234.ts.net", []), false, "not listed by default");
});

test("liveViewHosts and inviteBaseUrl are validated strictly", () => {
  const { hosts, problems } = liveViewHostsFrom(["MyHost.tail1234.ts.net", "myhost.tail1234.ts.net", "*.ts.net", "https://x.ts.net", "a b", "host:80", "localhost", 5, "-bad.example"]);
  assert.deepEqual(hosts, ["myhost.tail1234.ts.net"]);
  assert.equal(problems.length, 7);
  assert.deepEqual(liveViewHostsFrom(undefined), { hosts: [], problems: [] });
  assert.deepEqual(inviteBaseFrom("https://myhost.tail1234.ts.net", hosts), { base: "https://myhost.tail1234.ts.net", problem: null });
  assert.equal(inviteBaseFrom("https://myhost.tail1234.ts.net/", hosts).base, "https://myhost.tail1234.ts.net");
  assert.equal(inviteBaseFrom("http://myhost.tail1234.ts.net:8080", hosts).base, "http://myhost.tail1234.ts.net:8080");
  assert.deepEqual(inviteBaseFrom(null, hosts), { base: null, problem: null });
  for (const bad of ["https://other.ts.net", "ftp://myhost.tail1234.ts.net", "https://u:p@myhost.tail1234.ts.net", "https://myhost.tail1234.ts.net/x", "https://myhost.tail1234.ts.net/?a=1", "javascript:alert(1)", "not a url"]) {
    const r = inviteBaseFrom(bad, hosts);
    assert.equal(r.base, null, bad);
    assert.ok(r.problem, bad);
  }
});

// ---- the invite store on its own (scripts/liveview/invites.mjs), on an injected clock ----

test("invite lifetime: 24 h by default, hours as given, capped at 7 days; bad hours, shares and modes refused", () => {
  let t = 5_000_000;
  const invites = createInvites({ now: () => t });
  const H = 3_600_000;
  for (const hours of [undefined, null, ""]) assert.equal(((i) => i.expiresAt - i.createdAt)(invites.create({ hours })), 24 * H, `default for ${JSON.stringify(hours)}`);
  assert.equal(((i) => i.expiresAt - i.createdAt)(invites.create({ hours: "2" })), 2 * H, "a number as text");
  assert.equal(((i) => i.expiresAt - i.createdAt)(invites.create({ hours: 0.5 })), H / 2);
  assert.equal(((i) => i.expiresAt - i.createdAt)(invites.create({ hours: 24 * 7 })), 168 * H);
  assert.equal(((i) => i.expiresAt - i.createdAt)(invites.create({ hours: 24 * 7 + 1 })), 168 * H, "over the cap: the cap");
  for (const hours of [0, -1, "abc", NaN, Infinity, {}]) assert.throws(() => invites.create({ hours }), /hours/, String(hours));
  assert.throws(() => invites.create({ share: "public" }), /share/);
  assert.throws(() => invites.create({ share: "code", mode: "mirror" }), /mode/);
  // Expiry is exact: valid up to the last millisecond before expiresAt.
  const a = invites.create({ hours: 1 });
  t = a.expiresAt - 1;
  assert.equal(invites.match(a.key)?.id, a.id);
  t = a.expiresAt;
  assert.equal(invites.match(a.key), null, "at expiresAt it no longer works");
  assert.equal(invites.get(a.id), null);
});

test("key compare: only the whole key, as given; ids and keys are random and distinct", () => {
  const invites = createInvites();
  const a = invites.create({ role: "watch" });
  const b = invites.create({ role: "drive" });
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.key, b.key);
  assert.match(a.id, /^[0-9a-f]{8}$/);
  assert.equal(invites.match(a.key).id, a.id);
  for (const wrong of [a.key.toUpperCase(), `${a.key}0`, a.key.slice(0, -1), ` ${a.key}`, a.id, null, undefined, 0, b.key.slice(0, 32) + a.key.slice(32)]) {
    const got = invites.match(wrong);
    assert.ok(got === null || got.id === b.id && wrong === b.key, `matched ${String(wrong).slice(0, 20)}`);
  }
  assert.equal(invites.match(a.key.toUpperCase()), null, "case matters");
  // What match, get and list hand out never carries the key.
  for (const view of [invites.match(a.key), invites.get(a.id), ...invites.list()]) assert.ok(!("key" in view), JSON.stringify(view));
});

test("ended invites are announced: revoke, revokeAll and expiry, each once", () => {
  let t = 1_000_000;
  const invites = createInvites({ now: () => t });
  const ended = [];
  const stop = invites.onEnd((ids) => ended.push(...ids));
  const a = invites.create({ hours: 1 });
  const b = invites.create({ hours: 2 });
  const c = invites.create({ hours: 3 });
  invites.revoke(a.id);
  t += 2 * 3_600_000;
  invites.sweep();
  invites.sweep();
  assert.deepEqual(ended, [a.id, b.id]);
  assert.equal(invites.revokeAll(), 1);
  assert.deepEqual(ended, [a.id, b.id, c.id]);
  stop();
  invites.create();
  invites.revokeAll();
  assert.equal(ended.length, 3, "a listener removed hears nothing more");
});

test("saved join codes: links never saved; restore takes back only well-formed, live, capped codes", () => {
  const t = 10_000_000;
  const H = 3_600_000;
  const invites = createInvites({ now: () => t });
  invites.create({ role: "drive", label: "Link" });
  const code = invites.create({ role: "watch", share: "code", label: "Code" });
  const saved = invites.savedCodes();
  assert.deepEqual(saved.map((i) => i.id), [code.id], "only join codes");
  assert.equal(saved[0].key, code.key, "whole, with the key");
  const good = saved[0];
  const id = (n) => n.toString(16).padStart(8, "0");
  const bad = [
    null, "x", 5,
    { ...good, id: "XYZ" }, // id not hex
    { ...good, id: id(1), key: "short" },
    { ...good, id: id(2), key: good.key.toUpperCase() },
    { ...good, id: id(3), share: "link" }, // links never come back
    { ...good, id: id(4), role: "owner" },
    { ...good, id: id(5), role: "approve" }, // kept as drive + approve, never as a role of its own
    { ...good, id: id(6), mode: "mirror" },
    { ...good, id: id(7), expiresAt: t }, // expired
    { ...good, id: id(8), expiresAt: "soon" },
    { ...good, id: id(9), createdAt: t - H, expiresAt: t - H + 168 * H + 1 }, // longer than 7 days
    { ...good, id: id(10), createdAt: undefined },
  ];
  const again = createInvites({ now: () => t });
  assert.equal(again.restore([...bad, good, { ...good }]), 1, "the good one once, its copy refused");
  assert.equal(again.restore("not a list"), 0);
  assert.equal(again.restore(undefined), 0);
  assert.deepEqual(again.list().map((i) => i.id), [code.id]);
  assert.equal(again.match(good.key).role, "watch");
  // A label comes back cleaned like a new one.
  const third = createInvites({ now: () => t });
  assert.equal(third.restore([{ ...good, label: "<b>Eve</b>‮" }]), 1);
  assert.equal(third.get(good.id).label, "bEve/b");
  // Exactly 7 days long is fine.
  const fourth = createInvites({ now: () => t });
  assert.equal(fourth.restore([{ ...good, createdAt: t - H, expiresAt: t - H + 168 * H }]), 1);
});

test("role rights: every right named, only the owner's beyond page, events, thumb, state, input and tab", () => {
  const guest = ["page", "events", "thumb", "state", "input", "tab"];
  const ownerOnly = ["profile", "approve", "session", "record", "journal", "invite", "layout", "strip", "timeline", "config", "outline", "tools", "capture", "activity"];
  for (const r of [...guest, ...ownerOnly]) assert.equal(roleMay("owner", r), true, r);
  for (const r of ownerOnly) for (const role of ["drive", "watch", "approve"]) assert.equal(roleMay(role, r), false, `${role} ${r}`);
  // "approve" is no rights role of its own: an approve invite is checked as the drive it is.
  for (const r of guest) assert.equal(roleMay("approve", r), false, r);
  // Names from outside never reach the object's own properties.
  for (const role of ["__proto__", "constructor", "hasOwnProperty", "toString"]) assert.equal(roleMay(role, "page"), false, role);
  assert.equal(roleMay("owner", "constructor"), false);
  assert.equal(roleOf(null), "watch");
  assert.equal(roleOf({ role: "watch", approve: true }), "watch", "approve only on top of drive");
  assert.equal(roleOf({ role: "drive", approve: "yes" }), "drive", "approve must be true itself");
});
