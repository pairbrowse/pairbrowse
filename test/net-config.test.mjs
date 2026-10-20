// config.json's `network` block (spec server-mode C4, scripts/net/config.mjs): read and checked,
// wrong values named by their key; which network a session uses (its map entry, then its browser
// profile's id, then the default, then direct); and fail closed: nothing that can't be read ever
// turns a session direct.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkNetwork, networkFor, parseServer, readNetwork, egressItem, NETWORK_DEFAULTS, PROXY_DEFAULTS } from "../scripts/net/config.mjs";
import { loadConfig, saveConfig, CONFIG_WARNINGS, DEFAULT_CONFIG } from "../scripts/paths.mjs";
import { configProblem } from "../scripts/config-schema.mjs";

const dir = mkdtempSync(join(tmpdir(), "pb-net-config-"));
let n = 0;
function file(content) {
  const f = join(dir, `config-${n++}.json`);
  writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content));
  return f;
}

const US = { server: "http://203.0.113.10:3128", auth: true, bypass: [], expectEgress: ["203.0.113.0/24", "country:US"], onEgressChange: "pause" };
const SPEC_EXAMPLE = { proxies: { "us-east": US }, default: null, sessions: { "shop-a": "us-east", "shop-b": null }, strict: true, checkUrl: "https://cloudflare.com/cdn-cgi/trace", recheckMinutes: 10 };

test("network block read; the spec's example loads with no warnings and its defaults filled", () => {
  const r = checkNetwork(SPEC_EXAMPLE);
  assert.equal(r.problem, "");
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.network.proxies["us-east"], { id: "us-east", server: "http://203.0.113.10:3128", scheme: "http", host: "203.0.113.10", port: 3128,
    auth: true, bypass: [], expectEgress: ["203.0.113.0/24", "country:US"], onEgressChange: "pause" });
  assert.deepEqual(r.network.sessions, { "shop-a": "us-east", "shop-b": null });
  // Only a server given: the entry's defaults; an empty block: the block's.
  const min = checkNetwork({ proxies: { p: { server: "https://proxy.example.com" } } });
  assert.deepEqual(min.warnings, []);
  assert.deepEqual(min.network.proxies.p, { id: "p", server: "https://proxy.example.com:443", scheme: "https", host: "proxy.example.com", port: 443, ...PROXY_DEFAULTS });
  assert.deepEqual(checkNetwork({}).network, NETWORK_DEFAULTS);
  // Absent or null: no block, every session direct, nothing said.
  for (const raw of [undefined, null]) assert.deepEqual(checkNetwork(raw), { network: null, problem: "", proxyProblems: {}, sessionProblems: {}, warnings: [], messages: [] });
});

test("servers: http, https, socks5 with their ports filled; user info, socks4, PAC, direct and paths refused, never repeating the text", () => {
  assert.deepEqual(parseServer("http://Proxy.Example.com"), { server: "http://proxy.example.com:80", scheme: "http", host: "proxy.example.com", port: 80 });
  assert.equal(parseServer("socks5://203.0.113.10").server, "socks5://203.0.113.10:1080");
  assert.equal(parseServer("socks5://[2001:db8::1]:9050").server, "socks5://[2001:db8::1]:9050");
  assert.equal(parseServer("https://[2001:db8::1]").server, "https://[2001:db8::1]:443");
  assert.equal(parseServer("http://127.0.0.1:8080/").server, "http://127.0.0.1:8080", "a trailing / is the bare address");
  const refused = {
    "http://alice:hunter2@203.0.113.10:3128": /user name or password/,
    "socks5://alice:hunter2@203.0.113.10": /user name or password/,
    "http://hunter2@203.0.113.10": /user name or password/,
    "socks4://203.0.113.10:1080": /SOCKS4/,
    "socks4a://203.0.113.10:1080": /SOCKS4/,
    "socks://203.0.113.10:1080": /SOCKS4/,
    "direct://": /map the session to null/,
    "pac+http://example.com/proxy.pac": /PAC/,
    "http://example.com/proxy.pac": /path, query or fragment.*PAC/,
    "http://example.com:3128?x=1": /path, query or fragment/,
    "ftp://example.com": /http:, https: or socks5:/,
    "203.0.113.10:3128": /http:, https: or socks5:/,
    "socks5://bad host:1080": /valid address|usable host/,
    "socks5://300.1.1.1": /usable host/,
    "socks5://127.1": /usable host/,
    "socks5://h.example:0": /usable host|port/,
    "http://": /valid address|usable host/,
  };
  for (const [server, re] of Object.entries(refused)) {
    const r = parseServer(server, "network.proxies.x.server");
    assert.ok(r.problem, server);
    assert.match(r.problem, re, server);
    assert.match(r.problem, /^network\.proxies\.x\.server /, `${server}: names the key`);
    assert.ok(!r.problem.includes("hunter2") && !r.problem.includes("alice"), `${server}: never repeats a credential`);
  }
  for (const v of [undefined, null, 5, "", "  ", {}]) assert.match(parseServer(v, "k").problem, /^k is a proxy address like/);
});

test("wrong values in a proxy entry are refused with the key and stop only the sessions using it", () => {
  const cases = {
    "network.proxies.p.auth": { auth: "yes" },
    "network.proxies.p.bypass": { bypass: "localhost" },
    "network.proxies.p.expectEgress": { expectEgress: ["US"] },
    "network.proxies.p.onEgressChange": { onEgressChange: "stop" },
  };
  for (const [key, fields] of Object.entries(cases)) {
    const r = checkNetwork({ proxies: { p: { server: "http://203.0.113.10:3128", ...fields }, q: { server: "http://203.0.113.11:3128" } }, sessions: { a: "p", b: "q" } });
    assert.equal(r.problem, "", key);
    assert.match(r.proxyProblems.p, new RegExp(`^${key.replaceAll(".", "\\.")} is `), key);
    assert.deepEqual(Object.keys(r.network.proxies), ["q"], `${key}: the good proxy beside it is kept`);
    assert.equal(r.warnings.length, 1, key);
    assert.match(r.warnings[0], /^config\.json: .*; sessions using "p" don't start until it is fixed$/, key);
  }
  // An unknown key in an entry (a misspelt expectEgress would drop the expectation): refused.
  assert.match(checkNetwork({ proxies: { p: { server: "http://h.example:1", expectEgres: [] } } }).proxyProblems.p, /^network\.proxies\.p has unknown key "expectEgres"/);
  assert.match(checkNetwork({ proxies: { p: "http://h.example:1" } }).proxyProblems.p, /^network\.proxies\.p is an object/);
  // Ids: lower-case, digits and -, 1 to 34 characters.
  for (const id of ["US-East", "-a", "a_b", "x".repeat(35), ""]) assert.match(checkNetwork({ proxies: { [id]: { server: "http://h.example:1" } } }).proxyProblems[id], /proxy ids are 1 to 34/, id);
  assert.deepEqual(checkNetwork({ proxies: { ["a".repeat(34)]: { server: "http://h.example:1" } } }).warnings, []);
});

test("SOCKS5 with auth refused (U4); without, it passes", () => {
  const r = checkNetwork({ proxies: { s: { server: "socks5://203.0.113.10:1080", auth: true }, t: { server: "socks5://203.0.113.10:1080" } } });
  assert.match(r.proxyProblems.s, /SOCKS5 proxy with a user name and password isn't supported yet; use an HTTP or HTTPS proxy/);
  assert.ok(r.network.proxies.t);
});

test("strict mode allows only loopback bypasses; with strict false a host or range may be bypassed", () => {
  const strictOk = checkNetwork({ proxies: { p: { server: "http://h.example:1", bypass: ["localhost", "127.0.0.1", "[::1]", "::1"] } } });
  assert.deepEqual(strictOk.warnings, []);
  const strictNo = checkNetwork({ proxies: { p: { server: "http://h.example:1", bypass: ["localhost", "*.example.com"] } } });
  assert.match(strictNo.proxyProblems.p, /^network\.proxies\.p\.bypass has "\*\.example\.com", which strict mode doesn't allow/);
  const loose = checkNetwork({ strict: false, proxies: { p: { server: "http://h.example:1", bypass: ["*.example.com", "10.0.0.0/8", "intranet:8080", "[2001:db8::1]", "2001:db8::2"] } } });
  assert.deepEqual(loose.warnings, []);
  assert.deepEqual(loose.network.proxies.p.bypass, ["*.example.com", "10.0.0.0/8", "intranet:8080", "[2001:db8::1]", "2001:db8::2"]);
  assert.match(checkNetwork({ proxies: { p: { server: "http://h.example:1", bypass: ["2001:db8::2"] } } }).proxyProblems.p, /which strict mode doesn't allow/, "a bare IPv6 address other than ::1 is outside strict mode");
  // Nothing that could add or remove other rules (separators, the engine's own <-loopback>).
  for (const b of ["<-loopback>", "a.example,b.example", "a.example;b.example", "a b", "*", "10.0.0.0/33"]) {
    assert.match(checkNetwork({ strict: false, proxies: { p: { server: "http://h.example:1", bypass: [b] } } }).proxyProblems.p ?? "", /bypass is a list/, b);
  }
});

test("expectEgress takes addresses, ranges and countries", () => {
  for (const ok of ["203.0.113.7", "203.0.113.0/24", "2001:db8::/32", "country:US", "0.0.0.0/0"]) assert.ok(egressItem(ok), ok);
  for (const bad of ["US", "country:us", "country:USA", "203.0.113.0/40", "2001:db8::/129", "example.com", 5]) assert.ok(!egressItem(bad), String(bad));
  assert.equal(checkNetwork({ proxies: { p: { server: "http://h.example:1", expectEgress: [] } } }).network.proxies.p.expectEgress, null, "an empty list is none");
});

test("a broken block refuses every session, never falling back to direct", () => {
  const blocks = {
    "network is an object": "us-east",
    "network has unknown key \"sesions\"": { proxies: {}, sesions: { a: "p" } },
    "network.proxies is an object": { proxies: [] },
    "network.sessions is an object": { sessions: "a" },
    "network.default is a proxy id or null": { default: 5 },
    "network.checkUrl is an https address": { checkUrl: "http://example.com/trace" },
  };
  for (const [start, raw] of Object.entries(blocks)) {
    const r = checkNetwork(raw);
    assert.ok(r.problem.startsWith(start), `${start}: ${r.problem}`);
    assert.equal(r.network, null);
    assert.match(r.warnings[0], /; no browser session starts until it is fixed$/);
    const pick = networkFor({ network: raw }, "anything");
    assert.equal(pick.proxy, null);
    assert.match(pick.problem, /^Session "anything" doesn't start: config\.json's network: /, start);
  }
  assert.match(checkNetwork({ checkUrl: "https://u:p@example.com/" }).problem, /checkUrl has a user name or password/);
  assert.match(checkNetwork({ proxies: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, { server: "http://h.example:1" }])) }).problem, /more than 64/);
});

test("strict and recheckMinutes fall back to their safer defaults, with a warning", () => {
  const r = checkNetwork({ strict: "no", recheckMinutes: 0 });
  assert.equal(r.problem, "");
  assert.equal(r.network.strict, true);
  assert.equal(r.network.recheckMinutes, 10);
  assert.equal(r.warnings.length, 2);
  assert.ok(r.warnings.every((w) => w.endsWith("using the default for it until it is fixed")));
  assert.equal(checkNetwork({ recheckMinutes: 1440 }).network.recheckMinutes, 1440);
  assert.equal(checkNetwork({ recheckMinutes: 1441 }).network.recheckMinutes, 10);
});

test("session map, then profile id, then default, then direct; unknown id refuses", () => {
  const config = { network: { proxies: { "us-east": US, eu: { server: "socks5://198.51.100.2:1080" } }, default: "eu", sessions: { "shop-a": "us-east", "shop-b": null } } };
  const pick = (session, opts) => networkFor(config, session, opts);
  // The map wins over the profile and the default, null included.
  assert.deepEqual([pick("shop-a", { profileNetwork: "eu" }).id, pick("shop-a").source], ["us-east", "session"]);
  assert.deepEqual([pick("shop-b", { profileNetwork: "us-east" }).proxy, pick("shop-b").source, pick("shop-b").problem], [null, "session", ""]);
  // Then the profile's id; a profile without one (null or absent) falls to the default.
  assert.deepEqual([pick("other", { profileNetwork: "us-east" }).id, pick("other", { profileNetwork: "us-east" }).source], ["us-east", "profile"]);
  assert.deepEqual([pick("other", { profileNetwork: null }).id, pick("other").source], ["eu", "default"]);
  assert.equal(pick("other").proxy.server, "socks5://198.51.100.2:1080");
  // Then direct.
  const none = networkFor({ network: { proxies: config.network.proxies } }, "other");
  assert.deepEqual([none.id, none.source, none.proxy, none.problem], [null, "direct", null, ""]);
  for (const c of [{}, { network: null }, DEFAULT_CONFIG]) assert.deepEqual([networkFor(c, "default").source, networkFor(c, "default").problem], ["direct", ""]);
  // The block's own settings ride along.
  assert.deepEqual([pick("shop-a").strict, pick("shop-a").checkUrl, pick("shop-a").recheckMinutes], [true, "https://cloudflare.com/cdn-cgi/trace", 10]);
  // An undefined id refuses, wherever it was named: never direct.
  const unknown = { network: { proxies: { eu: { server: "http://h.example:1" } }, default: "nope", sessions: { a: "gone" } } };
  for (const [session, opts, where] of [["a", {}, "network.sessions.a"], ["b", { profileNetwork: "missing" }, "its browser profile"], ["c", {}, "network.default"]]) {
    const r = networkFor(unknown, session, opts);
    assert.equal(r.proxy, null, session);
    assert.match(r.problem, new RegExp(`^Session "${session}" doesn't start: ${where} names "[a-z]+", which network.proxies in config.json doesn't define\\.$`), session);
  }
  assert.match(networkFor(config, "x", { profileNetwork: 7 }).problem, /its browser profile's network is a whole number, not a proxy id/);
  // A proxy that failed its check, and a map entry that isn't an id: those sessions refuse.
  const broken = { network: { proxies: { p: { server: "socks4://h.example:1" }, q: { server: "http://h.example:2" } }, sessions: { a: "p", b: "q", c: ["q"] } } };
  assert.match(networkFor(broken, "a").problem, /^Session "a" doesn't start: network\.proxies\.p\.server is a SOCKS4 address/);
  assert.equal(networkFor(broken, "b").proxy.id, "q");
  assert.match(networkFor(broken, "c").problem, /^Session "c" doesn't start: network\.sessions\.c is a proxy id or null/);
  // Keys that are object internals stay plain keys.
  const proto = JSON.parse('{"proxies":{"q":{"server":"http://h.example:2"}},"sessions":{"__proto__":"q","constructor":null}}');
  assert.equal(networkFor({ network: proto }, "__proto__").id, "q");
  assert.equal(networkFor({ network: proto }, "constructor").source, "session");
  assert.equal(networkFor({ network: proto }, "toString").source, "direct");
});

test("loadConfig keeps the block as written and names its problems; saveConfig refuses a bad one", () => {
  let config = loadConfig(file({ network: SPEC_EXAMPLE }));
  assert.deepEqual(CONFIG_WARNINGS, []);
  assert.deepEqual(config.network, SPEC_EXAMPLE);
  assert.equal(loadConfig(file({})).network, null, "absent: null, every session direct");
  const f = file({ network: { proxies: { p: { server: "http://alice:hunter2@h.example:1" } }, sessions: { a: "p" } } });
  config = loadConfig(f);
  assert.equal(CONFIG_WARNINGS.length, 1);
  assert.match(CONFIG_WARNINGS[0], /^config\.json: network\.proxies\.p\.server has a user name or password in it/);
  assert.ok(!CONFIG_WARNINGS[0].includes("hunter2"));
  assert.match(networkFor(config, "a").problem, /doesn't start/, "the loaded config still refuses it");
  // A block of the wrong type is kept as written (so it refuses), with one warning, not the schema's default.
  config = loadConfig(file({ network: "us-east" }));
  assert.equal(config.network, "us-east");
  assert.equal(CONFIG_WARNINGS.length, 1);
  assert.match(CONFIG_WARNINGS[0], /^config\.json: network is an object .*no browser session starts until it is fixed$/);
  // Writes: a bad block is refused before anything is written; a good one goes through.
  const target = file({ maxTabs: 9 });
  assert.match(configProblem({ network: { proxies: { p: { server: "socks4://h.example:1" } } } }), /^network\.proxies\.p\.server is a SOCKS4 address.*; nothing was written\.$/);
  assert.throws(() => saveConfig({ network: { default: "nope" } }, target), /network\.default names "nope".*nothing was written/);
  assert.throws(() => saveConfig({ network: [] }, target), /^Error: network is an object/);
  assert.deepEqual(saveConfig({ network: SPEC_EXAMPLE }, target), { maxTabs: 9, network: SPEC_EXAMPLE });
  assert.equal(configProblem({ network: null }), "");
});

test("no value written in the block comes back in a warning, a message, a launch refusal or a refused save", () => {
  const cred = "http://alice:hunter2@h.example:1";
  const ok = { server: "http://h.example:1" };
  const blocks = [
    cred, [cred], { proxies: cred }, { proxies: [cred] }, { default: cred }, { sessions: cred }, { sessions: { a: cred } }, { sessions: { a: [cred] } },
    { checkUrl: cred }, { checkUrl: [cred] }, { strict: cred }, { recheckMinutes: cred },
    { proxies: { p: cred } }, { proxies: { p: { server: cred } } }, { proxies: { p: { server: [cred] } } }, { proxies: { p: { server: { cred } } } },
    { proxies: { p: { ...ok, bypass: [cred] } } }, { proxies: { p: { ...ok, bypass: cred } } }, { strict: false, proxies: { p: { ...ok, bypass: [cred] } } },
    { proxies: { p: { ...ok, expectEgress: [cred] } } }, { proxies: { p: { ...ok, auth: cred, onEgressChange: cred } } }, { proxies: { p: { ...ok, onEgressChange: cred } } },
    { proxies: { [cred]: ok }, sessions: { a: cred } }, { proxies: { p: ok }, sessions: { [cred]: [cred] } },
    { proxies: { p: ok }, sessions: { [cred]: "nope" } }, { [cred]: 1 }, { proxies: { p: { ...ok, [cred]: 1 } } },
  ];
  const leaks = (text) => /hunter2|alice/.test(text);
  for (const raw of blocks) {
    const r = checkNetwork(raw);
    const said = [r.problem, ...r.warnings, ...r.messages, ...Object.values(r.proxyProblems), ...Object.values(r.sessionProblems), configProblem({ network: raw })];
    for (const session of ["a", cred]) said.push(networkFor({ network: raw }, session, { profileNetwork: cred }).problem, networkFor({ network: raw }, session).problem);
    assert.ok(said.some(Boolean), `${JSON.stringify(raw)}: refused`);
    for (const text of said) assert.ok(!leaks(text), `${JSON.stringify(raw)}: ${text}`);
  }
  for (const v of [cred, [cred], { cred }]) assert.ok(!leaks(parseServer(v, "k").problem), JSON.stringify(v));
  // Through loadConfig (CONFIG_WARNINGS: daemon.log, pairbrowse_status) and a refused save too.
  for (const raw of blocks) {
    loadConfig(file({ network: raw }));
    assert.ok(CONFIG_WARNINGS.length && !CONFIG_WARNINGS.some(leaks), JSON.stringify(raw));
    assert.throws(() => saveConfig({ network: raw }, file({})), (e) => !leaks(e.message), JSON.stringify(raw));
  }
});

test("saveConfig never replaces a config.json it can't read: what it held (a network block) stays", () => {
  for (const text of ['{ "network": { "proxies": { "p": { "server": "http://h.example:1" } } }, ', "[1]", "7"]) {
    const f = file(text);
    assert.throws(() => saveConfig({ participantName: "Ann" }, f), /config\.json isn't (valid JSON|an object).*nothing was written/, text);
    assert.equal(readFileSync(f, "utf8"), text, `${text}: left as it was`);
  }
  // An empty file or a JSON null holds nothing to lose: written.
  for (const text of ["", "  \n", "null"]) assert.deepEqual(saveConfig({ participantName: "Ann" }, file(text)), { participantName: "Ann" }, JSON.stringify(text));
  assert.deepEqual(saveConfig({ participantName: "Ann" }, join(dir, "fresh.json")), { participantName: "Ann" }, "a missing file is created");
});

test("readNetwork reads the file at each launch: absent is direct, unreadable or unparsable refuses", () => {
  assert.deepEqual(readNetwork(join(dir, "missing.json")), { network: undefined });
  assert.deepEqual(readNetwork(file({ maxTabs: 3 })), { network: undefined });
  assert.deepEqual(readNetwork(file({ network: SPEC_EXAMPLE })), { network: SPEC_EXAMPLE });
  assert.deepEqual(readNetwork(file("null")), { network: undefined });
  assert.match(readNetwork(file("{ not json")).problem, /isn't valid JSON/);
  assert.match(readNetwork(file("[1]")).problem, /isn't an object/);
  const folder = join(dir, "a-folder");
  mkdirSync(folder);
  assert.match(readNetwork(folder).problem, /couldn't be read \(EISDIR\)/);
});

test("any shape under network or its parts loads without a throw", () => {
  const shapes = [null, true, 0, -1, 1.5, NaN, "", "x", [], ["x"], [1], {}, { a: 1 }];
  for (const v of shapes) {
    for (const raw of [v, { proxies: v }, { sessions: v }, { default: v }, { strict: v }, { checkUrl: v }, { recheckMinutes: v },
      { proxies: { p: v } }, { proxies: { p: { server: v } } }, { proxies: { p: { server: "http://h.example:1", bypass: v, expectEgress: v, auth: v, onEgressChange: v } } },
      { proxies: { p: { server: "http://h.example:1" } }, sessions: { a: v } }]) {
      assert.doesNotThrow(() => { checkNetwork(raw); networkFor({ network: raw }, "a", { profileNetwork: v }); configProblem({ network: raw }); }, JSON.stringify(raw));
    }
  }
});
