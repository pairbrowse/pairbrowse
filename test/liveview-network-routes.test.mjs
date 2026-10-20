// The Network section's owner routes (spec server-mode C14; liveview/routes/network.mjs,
// liveview/network.mjs, net/settings.mjs): only the owner's key reads or writes them (an invite
// link, a joiner's code, a hand-off grant, an agent tool and a request from another origin are
// refused); a proxy's password goes to secrets.env and never back out in an answer, an event or a
// log line; a SOCKS5 proxy with a username is refused with the U4 sentence; a session's choice
// lands in config.json's network.sessions; Test reads the exit through the proxy and answers the
// exit, its country, the leak verdict and the coherence items.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, statSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLiveView, createInvites, roleMay } from "../scripts/liveview.mjs";
import { secretStore, loadSecrets } from "../scripts/rules/secrets.mjs";
import { createNetworkSettings, readConfigFile, localeOf, TEST_NOTE } from "../scripts/liveview/network.mjs";
import { networkChange, networkSummary, readProxyForm, SOCKS5_AUTH_REFUSAL } from "../scripts/net/settings.mjs";
import { networkFor, launchPart } from "../scripts/net/config.mjs";
import { CATALOG } from "../scripts/tools/catalog.mjs";
import { navigationProblem } from "../scripts/rules/policy.mjs";
import { SERVER_EVENTS } from "../ui/events.js";

const PASSWORD = "pw-Zq81-unique-secret";
const USERNAME = "user-Kd02-unique";

function request(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
// The owner's event stream, every byte kept.
function stream(port, key) {
  const seen = [];
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/${key}/events?panel=1`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.on("data", (d) => seen.push(d.toString("utf8")));
      resolve({ text: () => seen.join(""), close: () => req.destroy() });
    });
    req.on("error", () => {});
  });
}
const until = async (what, fn) => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); } assert.fail(`timed out waiting for ${what}`); };

// A home of the test's own: config.json, secrets.env and the helper's log lines.
function setup({ config = {}, probe, locale, sessions = ["default", "shop-a"] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pb-netroutes-"));
  const configFile = join(dir, "config.json"), secretsFile = join(dir, "secrets.env");
  writeFileSync(configFile, JSON.stringify(config));
  const lines = [];
  const log = (...a) => lines.push(a.join(" "));
  const secrets = secretStore(secretsFile, log);
  const network = createNetworkSettings({ configFile, secrets, sessions: () => sessions, log, ...(probe ? { probe } : {}), ...(locale ? { locale } : {}) });
  return { dir, configFile, secretsFile, secrets, network, lines, config: () => JSON.parse(readFileSync(configFile, "utf8")) };
}
async function view(network, invites = createInvites()) {
  const lines = [];
  const v = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, settings: { read: () => ({}), write: async () => ({}), network }, log: (...a) => lines.push(a.join(" ")) });
  return { v, key: v.url.split("/").at(-2), invites, lines };
}

test("only the owner reads or writes the Network section: invite links, joiners, grants, other origins and agents can't", async () => {
  const s = setup({ config: { network: { proxies: { "us-east": { server: "http://203.0.113.10:3128" } } } } });
  const { v, key, invites } = await view(s.network);
  try {
    const add = { op: "add", id: "eu-west", type: "http", host: "198.51.100.2", port: 8080, auth: false };
    // Each kind of link but the owner's.
    for (const role of ["watch", "drive"]) {
      const i = invites.create({ role, label: role });
      assert.equal((await request(v.port, "GET", `/${i.key}/network.json`)).status, 403, `${role}: read`);
      assert.equal((await request(v.port, "POST", `/${i.key}/network`, { body: add })).status, 403, `${role}: write`);
      assert.equal((await request(v.port, "POST", `/${i.key}/network`, { body: { op: "test", type: "http", host: "198.51.100.2" } })).status, 403, `${role}: test`);
    }
    // A joiner's code: not on the owner's port, nor the join port.
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    assert.equal((await request(v.port, "GET", `/${c.key}/network.json`)).status, 404);
    assert.notEqual((await request(v.guestPort, "GET", `/${c.key}/network.json`)).status, 200, "the join port never serves it");
    assert.notEqual((await request(v.guestPort, "POST", `/${c.key}/network`, { body: add })).status, 200);
    for (const role of ["drive", "watch", "approve", "turn", "redeem"]) assert.equal(roleMay(role, "network"), false, role);
    assert.equal(roleMay("owner", "network"), true);
    // Another origin (a web page in any browser on this computer) is refused before anything runs.
    const cross = await request(v.port, "POST", `/${key}/network`, { body: add, headers: { origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
    assert.equal(s.config().network.proxies["eu-west"], undefined, "nothing written");
    // An agent: no tool takes a proxy or a credential, and the browser's own pages (Settings) are
    // never a place it can open.
    const words = JSON.stringify(Object.values(CATALOG).map((t) => t.def?.inputSchema || {}));
    assert.doesNotMatch(words, /proxy|PAIRBROWSE_PROXY|"network"/i);
    assert.ok(navigationProblem("chrome://pairbrowse/settings/index.html"));
    assert.ok(navigationProblem("pairbrowse://settings/pairbrowse"));
    // The owner can, from this origin.
    const ok = await request(v.port, "POST", `/${key}/network`, { body: add, headers: { origin: `http://127.0.0.1:${v.port}` } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(s.config().network.proxies["eu-west"].server, "http://198.51.100.2:8080");
    assert.equal(SERVER_EVENTS.network.to, "owner");
  } finally { v.close(); }
});

test("the password goes to secrets.env and never back out in an answer, event or log line", async () => {
  const s = setup({ config: { name: "kept", network: { strict: true, recheckMinutes: 5 } } });
  const { v, key, lines: viewLines } = await view(s.network);
  const events = await stream(v.port, key);
  try {
    const r = await request(v.port, "POST", `/${key}/network`, { body: { op: "add", id: "us-east", type: "https", host: "proxy.example.com", port: 443, auth: true, username: USERNAME, password: PASSWORD } });
    assert.equal(r.status, 200, r.text);
    const body = JSON.parse(r.text);
    assert.equal(body.text, 'Added proxy "us-east", with its username and password in secrets.env.');
    assert.deepEqual(body.network.proxies, [{ id: "us-east", type: "https", host: "proxy.example.com", port: 443, auth: true, username: true, password: true, problem: "" }]);
    // In secrets.env under the reserved names, 0600; config.json names neither.
    const saved = loadSecrets(s.secretsFile);
    assert.equal(saved.values.PAIRBROWSE_PROXY_US_EAST_PASSWORD, PASSWORD);
    assert.equal(saved.values.PAIRBROWSE_PROXY_US_EAST_USERNAME, USERNAME);
    assert.equal(statSync(s.secretsFile).mode & 0o777, 0o600);
    const config = s.config();
    assert.deepEqual(config.network, { strict: true, recheckMinutes: 5, proxies: { "us-east": { server: "https://proxy.example.com:443", auth: true } } });
    assert.equal(config.name, "kept", "the rest of config.json kept");
    // The launch reads them as before (the session uses it as the default once picked).
    await request(v.port, "POST", `/${key}/network`, { body: { op: "default", id: "us-east" } });
    const part = launchPart(networkFor(s.config(), "shop-a"), { shell: { proxyAuthFile: 1 }, secrets: saved, native: true });
    assert.equal(part.authFile.password, PASSWORD);
    // Edit with the password left empty keeps it; the summary still says only "saved".
    const e = await request(v.port, "POST", `/${key}/network`, { body: { op: "edit", id: "us-east", type: "https", host: "proxy.example.com", port: 8443, auth: true } });
    assert.equal(e.status, 200, e.text);
    assert.equal(loadSecrets(s.secretsFile).values.PAIRBROWSE_PROXY_US_EAST_PASSWORD, PASSWORD);
    const read = await request(v.port, "GET", `/${key}/network.json`);
    await until("the events", () => (events.text().match(/event: network/g) || []).length >= 3);
    for (const [what, text] of [["answer", r.text], ["edit answer", e.text], ["read", read.text], ["events", events.text()], ["log", [...s.lines, ...viewLines].join("\n")]]) {
      assert.doesNotMatch(text, new RegExp(PASSWORD), `no password in the ${what}`);
      assert.doesNotMatch(text, new RegExp(USERNAME), `no username in the ${what}`);
    }
    assert.ok(s.lines.some((l) => /network: Added proxy "us-east"/.test(l)), "the change is logged, without the credentials");
    // A too-short password is refused, nothing changed.
    const short = await request(v.port, "POST", `/${key}/network`, { body: { op: "edit", id: "us-east", type: "https", host: "proxy.example.com", auth: true, password: "abc" } });
    assert.equal(short.status, 409);
    assert.match(JSON.parse(short.text).error, /too short/);
    // Turning auth off, then removing: the credentials leave secrets.env.
    await request(v.port, "POST", `/${key}/network`, { body: { op: "default", id: null } });
    const off = await request(v.port, "POST", `/${key}/network`, { body: { op: "edit", id: "us-east", type: "https", host: "proxy.example.com", auth: false } });
    assert.equal(off.status, 200, off.text);
    assert.equal(loadSecrets(s.secretsFile).values.PAIRBROWSE_PROXY_US_EAST_PASSWORD, undefined);
    const gone = await request(v.port, "POST", `/${key}/network`, { body: { op: "remove", id: "us-east" } });
    assert.equal(gone.status, 200, gone.text);
    assert.deepEqual(s.config().network.proxies, {});
  } finally { events.close(); v.close(); }
});

test("a SOCKS5 proxy with a username is refused with the U4 sentence; without one it is added", async () => {
  const s = setup();
  const { v, key } = await view(s.network);
  try {
    const r = await request(v.port, "POST", `/${key}/network`, { body: { op: "add", id: "socks-a", type: "socks5", host: "198.51.100.4", auth: true, username: USERNAME, password: PASSWORD } });
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.text).error, SOCKS5_AUTH_REFUSAL);
    assert.match(SOCKS5_AUTH_REFUSAL, /^A SOCKS5 proxy with a user name and password isn't supported yet/);
    assert.equal(loadSecrets(s.secretsFile).values.PAIRBROWSE_PROXY_SOCKS_A_PASSWORD, undefined, "no secret saved");
    assert.deepEqual(s.config(), {}, "config.json untouched");
    // A test of the same is refused before anything is sent.
    const t = await request(v.port, "POST", `/${key}/network`, { body: { op: "test", type: "socks5", host: "198.51.100.4", auth: true, username: USERNAME, password: PASSWORD } });
    assert.equal(t.status, 409);
    assert.equal(JSON.parse(t.text).error, SOCKS5_AUTH_REFUSAL);
    const ok = await request(v.port, "POST", `/${key}/network`, { body: { op: "add", id: "socks-a", type: "socks5", host: "198.51.100.4", auth: false } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(s.config().network.proxies["socks-a"].server, "socks5://198.51.100.4:1080");
  } finally { v.close(); }
});

test("the default and each session's choice land in network.sessions; a proxy in use isn't removed", async () => {
  const s = setup({ config: { network: { proxies: { "us-east": { server: "http://203.0.113.10:3128", expectEgress: ["country:US"], onEgressChange: "notify" } }, sessions: { "old-one": null } } } });
  const { v, key } = await view(s.network);
  try {
    const post = (body) => request(v.port, "POST", `/${key}/network`, { body });
    assert.equal((await post({ op: "session", session: "shop-a", choice: "proxy", id: "us-east" })).status, 200);
    assert.equal((await post({ op: "session", session: "default", choice: "direct" })).status, 200);
    assert.deepEqual(s.config().network.sessions, { "old-one": null, "shop-a": "us-east", default: null });
    assert.equal(networkFor(s.config(), "shop-a").id, "us-east", "the launch reads it");
    assert.equal(networkFor(s.config(), "default").source, "session");
    // Follow the default: its entry goes.
    assert.equal((await post({ op: "session", session: "old-one", choice: "default" })).status, 200);
    assert.deepEqual(s.config().network.sessions, { "shop-a": "us-east", default: null });
    // Refused: an unknown proxy, a clean session, a name that isn't one.
    for (const body of [{ op: "session", session: "shop-a", choice: "proxy", id: "nope" }, { op: "session", session: "clean-3", choice: "direct" }, { op: "session", session: "../x", choice: "direct" },
      { op: "session", session: "shop-a", choice: "elsewhere" }, { op: "default", id: "nope" }, { op: "remove", id: "us-east" }, { op: "add", id: "Bad Id", type: "http", host: "h.example" },
      { op: "add", id: "x", type: "http", host: "user:pw@h.example" }, { op: "add", id: "x", type: "socks4", host: "h.example" }, { op: "rename", id: "us-east" }, { op: "add", id: "x", type: "http", host: "h.example", extra: 1 }]) {
      const r = await post(body);
      assert.equal(r.status, 409, JSON.stringify(body));
    }
    const inUse = JSON.parse((await post({ op: "remove", id: "us-east" })).text).error;
    assert.equal(inUse, '"us-east" is session "shop-a": choose another for it first, then remove it.');
    // An edit keeps what Settings doesn't show (expectEgress, onEgressChange).
    assert.equal((await post({ op: "edit", id: "us-east", type: "http", host: "203.0.113.11", port: 3128, auth: false })).status, 200);
    assert.deepEqual(s.config().network.proxies["us-east"], { server: "http://203.0.113.11:3128", expectEgress: ["country:US"], onEgressChange: "notify", auth: false });
    // The summary lists the sessions with their choices.
    const sum = JSON.parse((await request(v.port, "GET", `/${key}/network.json`)).text);
    assert.deepEqual(sum.sessions, [{ name: "default", choice: "direct", id: null }, { name: "shop-a", choice: "proxy", id: "us-east" }]);
  } finally { v.close(); }
});

test("a network block or config.json that can't be read is never rewritten from Settings", async () => {
  const s = setup({ config: { network: { proxies: [] } } });
  const before = readFileSync(s.configFile, "utf8");
  const r = s.network.write({ op: "add", id: "a", type: "http", host: "h.example", auth: false });
  assert.match(r.error, /^config\.json's network can't be read/);
  assert.match(s.network.read().problem, /network\.proxies/);
  writeFileSync(s.configFile, "{ broken");
  assert.match(s.network.write({ op: "default", id: null }).error, /isn't valid JSON/);
  assert.equal(readFileSync(s.configFile, "utf8"), "{ broken");
  assert.notEqual(before, "");
  assert.deepEqual(readConfigFile(join(s.dir, "absent.json")), { config: {} });
  // A proxy entry with a problem of its own is listed with it; others can still be changed.
  writeFileSync(s.configFile, JSON.stringify({ network: { proxies: { bad: { server: "socks4://h.example:1" }, good: { server: "http://h.example:1" } } } }));
  const sum = s.network.read();
  assert.equal(sum.problem, "");
  assert.match(sum.proxies.find((p) => p.id === "bad").problem, /SOCKS4/);
  assert.equal(s.network.write({ op: "default", id: "good" }).text, 'Sessions without a choice of their own now use "good".');
});

test("Test reads the exit through the proxy: address, country, leak verdict and coherence items", async () => {
  const calls = [];
  const probe = async (o) => { calls.push(o); return o.proxy ? { ok: true, ip: "203.0.113.7", loc: "US" } : { ok: true, ip: "192.0.2.50", loc: "DE" }; };
  const s = setup({ probe, locale: () => ({ timezone: "Europe/Berlin", languages: ["de-DE", "de"], geoip: false }) });
  const { v, key } = await view(s.network);
  try {
    const t = await request(v.port, "POST", `/${key}/network`, { body: { op: "test", type: "http", host: "203.0.113.10", port: 3128, auth: true, username: USERNAME, password: PASSWORD } });
    assert.equal(t.status, 200, t.text);
    const r = JSON.parse(t.text);
    assert.equal(r.verdict, "ok");
    assert.deepEqual(r.exit, { ip: "203.0.113.7", country: "US" });
    assert.equal(r.sameAsDirect, false);
    assert.deepEqual(r.coherence.map((c) => [c.id, c.severity]), [["locale.timezone-vs-egress", "error"], ["locale.language-vs-egress", "warning"]]);
    assert.match(r.coherence[0].text, /Europe\/Berlin is used in DE, but this proxy's exit is in US/);
    assert.equal(r.note, TEST_NOTE);
    assert.doesNotMatch(t.text, new RegExp(PASSWORD));
    assert.deepEqual(calls[0].auth, { username: USERNAME, password: PASSWORD }, "the typed credentials, for the probe only");
    assert.deepEqual(calls[0].proxy, { id: null, server: "http://203.0.113.10:3128", scheme: "http", host: "203.0.113.10", port: 3128 });
    assert.equal(calls[1].proxy, null, "this computer's own exit, to compare");
    assert.equal(loadSecrets(s.secretsFile).values.PAIRBROWSE_PROXY_US_EAST_PASSWORD, undefined, "a test saves nothing");
    assert.deepEqual(s.config(), {});
    assert.ok(!s.lines.join("\n").includes("203.0.113.7"), "no exit address logged");
  } finally { v.close(); }
  // The exit is this computer's own: a leak. A probe that fails: failed with its reason, no exit.
  const leak = setup({ probe: async () => ({ ok: true, ip: "192.0.2.50", loc: "DE" }), locale: () => ({ timezone: "Europe/Berlin", languages: ["de-DE"], geoip: false }) });
  const l = await leak.network.test({ op: "test", type: "http", host: "203.0.113.10" });
  assert.equal(l.verdict, "failed");
  assert.equal(l.sameAsDirect, true);
  assert.match(l.reason, /this computer's own/);
  assert.deepEqual(l.coherence, []);
  const down = setup({ probe: async (o) => (o.proxy ? { ok: false, step: "connect", problem: "proxy 203.0.113.10:3128 refused the connection (connect)" } : { ok: true, ip: "192.0.2.50", loc: "DE" }) });
  const d = await down.network.test({ op: "test", type: "http", host: "203.0.113.10", port: 3128 });
  assert.equal(d.verdict, "failed");
  assert.equal(d.exit, null);
  assert.match(d.reason, /The check through the proxy failed/);
  // A saved proxy is tested with its saved credentials and its expectEgress (no direct probe then).
  const seen = [];
  const saved = setup({ config: { network: { proxies: { "us-east": { server: "http://203.0.113.10:3128", auth: true, expectEgress: ["country:US"] } } } },
    probe: async (o) => { seen.push(o); return { ok: true, ip: "203.0.113.7", loc: "US" }; }, locale: () => ({ timezone: "America/New_York", languages: ["en-US"], geoip: false }) });
  saved.secrets.save({ values: { PAIRBROWSE_PROXY_US_EAST_USERNAME: USERNAME, PAIRBROWSE_PROXY_US_EAST_PASSWORD: PASSWORD }, domains: {} });
  const k = await saved.network.test({ op: "test", id: "us-east", type: "http", host: "203.0.113.10", port: 3128, auth: true });
  assert.equal(k.verdict, "ok");
  assert.deepEqual(k.coherence, [], "New York time and en-US fit a US exit");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].auth, { username: USERNAME, password: PASSWORD });
  // geoip: the time zone follows the exit, nothing to compare.
  const geo = setup({ probe: async (o) => (o.proxy ? { ok: true, ip: "203.0.113.7", loc: "US" } : { ok: true, ip: "192.0.2.50", loc: "DE" }), locale: () => ({ timezone: "Europe/Berlin", languages: ["de-DE"], geoip: true }) });
  const g = await geo.network.test({ op: "test", type: "http", host: "203.0.113.10" });
  assert.deepEqual([g.coherence, g.locale], [[], "geoip"]);
});

test("net/settings: forms, summaries and changes are pure and never repeat a credential", () => {
  assert.deepEqual(readProxyForm({ id: "a", type: "http", host: "2001:db8::1", port: "8080" }), { id: "a", server: "http://[2001:db8::1]:8080", scheme: "http", host: "[2001:db8::1]", port: 8080, auth: false, username: "", password: "" });
  for (const bad of [{ id: "a", type: "http", host: "" }, { id: "a", type: "http", host: "h.example", port: 0 }, { id: "a", type: "http", host: "h.example/x" }, { id: "a", type: "pac", host: "h.example" },
    { id: "a", type: "http", host: "h.example", auth: false, password: PASSWORD }, { id: "a", type: "http", host: "h.example", auth: true, password: "a\nb" }]) {
    const r = readProxyForm(bad);
    assert.ok(r.error, JSON.stringify(bad));
    assert.doesNotMatch(r.error, new RegExp(PASSWORD));
  }
  const add = networkChange(undefined, { op: "add", id: "a", type: "http", host: "h.example", auth: true, username: USERNAME, password: PASSWORD });
  assert.deepEqual(add.network, { proxies: { a: { server: "http://h.example:80", auth: true } } });
  assert.deepEqual(add.set, { PAIRBROWSE_PROXY_A_USERNAME: USERNAME, PAIRBROWSE_PROXY_A_PASSWORD: PASSWORD });
  assert.doesNotMatch(add.text, new RegExp(PASSWORD));
  assert.equal(networkChange(undefined, { op: "add", id: "a", type: "http", host: "h.example", auth: true, username: USERNAME }).error, "Enter the proxy's password.");
  const sum = networkSummary({ proxies: { a: { server: "http://h.example:80", auth: true } }, sessions: { "clean-2": null } }, { sessions: ["default", "clean-1"], values: { PAIRBROWSE_PROXY_A_PASSWORD: PASSWORD } });
  assert.deepEqual(sum.proxies[0], { id: "a", type: "http", host: "h.example", port: 80, auth: true, username: false, password: true, problem: "" });
  assert.deepEqual(sum.sessions, [{ name: "default", choice: "default", id: null }], "clean sessions are never listed");
  assert.doesNotMatch(JSON.stringify(sum), new RegExp(PASSWORD));
  // The browser's locale: the native build's own settings, else this computer's.
  assert.deepEqual(localeOf({ pairbrowse: { timezone: "Asia/Tokyo", acceptLanguage: "ja-JP,ja;q=0.9", geoip: true } }, { native: true }), { timezone: "Asia/Tokyo", languages: ["ja-JP", "ja"], geoip: true });
  assert.equal(localeOf({ pairbrowse: { timezone: "Asia/Tokyo" } }, { native: false }).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test("credentials added to secrets.env by hand are seen at once and kept by a later change from Settings", async () => {
  const s = setup({ config: { network: { proxies: { "us-east": { server: "http://203.0.113.10:3128", auth: true } } } } });
  // The store has read the (missing) file; then the owner adds us-east's credentials and one of
  // their own passwords by hand, as docs/configuration.md says.
  writeFileSync(s.secretsFile, `PAIRBROWSE_PROXY_US_EAST_USERNAME="${USERNAME}"\nPAIRBROWSE_PROXY_US_EAST_PASSWORD="${PASSWORD}"\nSHOP_PASSWORD="hand-added-1"\nSHOP_PASSWORD_DOMAINS=shop.example\n`, { mode: 0o600 });
  const sum = s.network.read();
  assert.equal(sum.secretsProblem, "");
  assert.deepEqual(sum.proxies[0], { id: "us-east", type: "http", host: "203.0.113.10", port: 3128, auth: true, username: true, password: true, problem: "" });
  // An edit with the fields left empty keeps them; a test uses them.
  const edit = s.network.write({ op: "edit", id: "us-east", type: "http", host: "203.0.113.11", port: 3128, auth: true });
  assert.equal(edit.error, undefined, edit.error);
  const seen = [];
  const t = setup({ config: s.config(), probe: async (o) => { if (!o.proxy) return { ok: true, ip: "192.0.2.50", loc: "DE" }; seen.push(o.auth); return { ok: true, ip: "203.0.113.7", loc: "US" }; } });
  writeFileSync(t.secretsFile, readFileSync(s.secretsFile, "utf8"), { mode: 0o600 });
  assert.equal((await t.network.test({ op: "test", id: "us-east", type: "http", host: "203.0.113.11", port: 3128, auth: true })).verdict, "ok");
  assert.deepEqual(seen[0], { username: USERNAME, password: PASSWORD });
  // Another hand edit after that, then an add with credentials from Settings: nothing is lost.
  writeFileSync(s.secretsFile, `${readFileSync(s.secretsFile, "utf8")}\nBANK_PASSWORD="hand-added-2"\nBANK_PASSWORD_DOMAINS=bank.example\n`, { mode: 0o600 });
  const add = s.network.write({ op: "add", id: "eu-west", type: "http", host: "198.51.100.2", port: 8080, auth: true, username: `${USERNAME}-2`, password: `${PASSWORD}-2` });
  assert.equal(add.error, undefined, add.error);
  const after = loadSecrets(s.secretsFile);
  assert.equal(after.values.PAIRBROWSE_PROXY_US_EAST_USERNAME, USERNAME);
  assert.equal(after.values.PAIRBROWSE_PROXY_US_EAST_PASSWORD, PASSWORD);
  assert.equal(after.values.PAIRBROWSE_PROXY_EU_WEST_PASSWORD, `${PASSWORD}-2`);
  assert.deepEqual([after.values.SHOP_PASSWORD, after.domains.SHOP_PASSWORD], ["hand-added-1", ["shop.example"]]);
  assert.deepEqual([after.values.BANK_PASSWORD, after.domains.BANK_PASSWORD], ["hand-added-2", ["bank.example"]]);
  // A removal deletes only that proxy's entries from the file as it is then.
  writeFileSync(s.secretsFile, `${readFileSync(s.secretsFile, "utf8")}\nLATE_PASSWORD="hand-added-3"\n`, { mode: 0o600 });
  assert.equal(s.network.write({ op: "remove", id: "eu-west" }).error, undefined);
  const gone = loadSecrets(s.secretsFile).values;
  assert.equal(gone.PAIRBROWSE_PROXY_EU_WEST_PASSWORD, undefined);
  assert.deepEqual([gone.LATE_PASSWORD, gone.BANK_PASSWORD, gone.PAIRBROWSE_PROXY_US_EAST_PASSWORD], ["hand-added-3", "hand-added-2", PASSWORD]);
  // What the helper masks follows the file too.
  assert.equal(s.secrets.get().values.LATE_PASSWORD, "hand-added-3");
});

test("a secrets.env that can't be used is said in the summary and is the reason a credential change is refused", { skip: process.platform === "win32" }, async () => {
  const s = setup({ config: { network: { proxies: { "us-east": { server: "http://203.0.113.10:3128", auth: true } } } } });
  writeFileSync(s.secretsFile, `PAIRBROWSE_PROXY_US_EAST_USERNAME="${USERNAME}"\nPAIRBROWSE_PROXY_US_EAST_PASSWORD="${PASSWORD}"\n`);
  chmodSync(s.secretsFile, 0o644);
  const sum = s.network.read();
  assert.match(sum.secretsProblem, /readable by other users; run chmod 600/);
  assert.equal(sum.problem, "");
  assert.doesNotMatch(JSON.stringify(sum), new RegExp(PASSWORD));
  for (const op of [{ op: "edit", id: "us-east", type: "http", host: "203.0.113.11", port: 3128, auth: true },
    { op: "add", id: "eu-west", type: "http", host: "198.51.100.2", auth: true, username: USERNAME, password: PASSWORD }]) {
    const r = s.network.write(op);
    assert.match(r.error, /^Not saved: PairBrowse can't use secrets\.env for the username and password\. .*chmod 600/, op.op);
    assert.doesNotMatch(r.error, /Enter the proxy's/);
  }
  assert.equal(s.config().network.proxies["eu-west"], undefined, "nothing written");
  assert.equal(readFileSync(s.secretsFile, "utf8").includes(PASSWORD), true, "the file is left as it was");
  // A change that needs no credentials still goes through.
  assert.equal(s.network.write({ op: "default", id: "us-east" }).error, undefined);
  const t = await s.network.test({ op: "test", id: "us-east", type: "http", host: "203.0.113.10", port: 3128, auth: true });
  assert.match(t.error, /saved ones can't be read\. .*chmod 600/);
  // Pure: the same refusal from net/settings.
  assert.match(networkChange({ proxies: {} }, { op: "add", id: "a", type: "http", host: "h.example", auth: true, username: USERNAME, password: PASSWORD }, { secretsProblem: "X is a link." }).error, /X is a link\.$/);
  assert.equal(networkSummary(undefined, { secretsProblem: "X is a link." }).secretsProblem, "X is a link.");
});
