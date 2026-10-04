import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startLiveView, createInvites, hostOk, liveViewHostsFrom, inviteBaseFrom, inviteLabel, roleMay } from "../scripts/liveview.mjs";

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
});

test("invite store: roles, labels, expiry and limits", () => {
  let t = 1_000_000;
  const invites = createInvites({ now: () => t });
  assert.throws(() => invites.create({ role: "admin" }), /watch.*drive/);
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
