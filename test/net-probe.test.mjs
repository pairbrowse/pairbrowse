// The helper's egress probe (spec server-mode C2, C6 (1); net/probe.mjs) against stand-in proxies
// (test/helpers/proxies.mjs): through an HTTP proxy's CONNECT (Basic credentials when it needs them),
// an https: proxy checked against the trust store, and SOCKS5 sending the check host as a name; it
// reads the trace's ip and loc; untrusted certificates, hung, garbled and closed proxies end it
// within its bound as a failure that names the proxy and step, never the credential.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { probeEgress, parseTrace, checkTargets, CHECK_MS, STUN_URL } from "../scripts/net/probe.mjs";
import { CHECK_URL } from "../scripts/net/config.mjs";
import { traceServer, httpProxy, socks5Proxy, hungProxy, garbageProxy, closedPort, testCa } from "./helpers/proxies.mjs";

const pki = testCa();
const noOpenssl = !pki && "openssl isn't installed";
const stubs = [];
after(async () => { for (const s of stubs) await s.close(); });
const keep = (s) => { stubs.push(s); return s; };
const USER = "proxy-user-1", PASS = "s3cret-pass-word";
const CHECK = "https://trace.test/cdn-cgi/trace";
const via = (scheme, port) => ({ scheme, host: "127.0.0.1", port });
const noCredential = (r) => {
  const text = JSON.stringify(r);
  assert.ok(!text.includes(PASS) && !text.includes(USER) && !text.includes(Buffer.from(`${USER}:${PASS}`).toString("base64")), `no credential in ${text}`);
};

test("CONNECT with Basic and SOCKS5 read ip and loc; SOCKS5 sends address type 3", { skip: noOpenssl }, async () => {
  const trace = keep(await traceServer({ ip: "203.0.113.10", loc: "US", tls: pki }));
  const auth = keep(await httpProxy({ upstream: trace.port, auth: { username: USER, password: PASS } }));
  const ok = await probeEgress({ proxy: via("http", auth.port), checkUrl: CHECK, auth: { username: USER, password: PASS }, extraCa: pki.ca });
  assert.deepEqual(ok, { ok: true, ip: "203.0.113.10", loc: "US" });
  assert.deepEqual(auth.log.map((l) => [l.method, l.target, l.authorized]), [["CONNECT", "trace.test:443", true]], "the name goes to the proxy");
  assert.deepEqual(trace.state.hosts, ["trace.test"]);

  // Without credentials, and with wrong ones: a 407 in words, the credential nowhere.
  const none = await probeEgress({ proxy: via("http", auth.port), checkUrl: CHECK, extraCa: pki.ca });
  assert.equal(none.ok, false);
  assert.equal(none.step, "tunnel");
  assert.match(none.problem, /^proxy 127\.0\.0\.1:\d+: asks for a username and password \(407\)/);
  const wrong = await probeEgress({ proxy: via("http", auth.port), checkUrl: CHECK, auth: { username: USER, password: "not-the-one" }, extraCa: pki.ca });
  assert.match(wrong.problem, /refused the username and password \(407\)/);
  noCredential(wrong);
  assert.ok(!wrong.problem.includes("not-the-one"));

  // SOCKS5: the check host as a name (type 3), an address as type 1; without auth only "no
  // authentication" is offered.
  const socks = keep(await socks5Proxy({ upstream: trace.port }));
  assert.deepEqual(await probeEgress({ proxy: via("socks5", socks.port), checkUrl: CHECK, extraCa: pki.ca }), { ok: true, ip: "203.0.113.10", loc: "US" });
  assert.deepEqual(socks.log.at(-1), { methods: [0], atyp: 3, host: "trace.test", port: 443 });
  const plain = keep(await traceServer({ ip: "2001:db8::5", loc: "DE" }));
  const socksPlain = keep(await socks5Proxy({ upstream: plain.port }));
  assert.deepEqual(await probeEgress({ proxy: via("socks5", socksPlain.port), checkUrl: "http://192.0.2.1:8080/t" }), { ok: true, ip: "2001:db8::5", loc: "DE" });
  assert.deepEqual(socksPlain.log.at(-1), { methods: [0], atyp: 1, host: "192.0.2.1", port: 8080 });
  // With auth the greeting offers both methods; the credentials go only when the proxy picks
  // username/password (RFC 1929), and a proxy taking "no authentication" never sees them.
  const open = await probeEgress({ proxy: via("socks5", socks.port), checkUrl: CHECK, auth: { username: USER, password: PASS }, extraCa: pki.ca });
  assert.deepEqual(open, { ok: true, ip: "203.0.113.10", loc: "US" });
  assert.deepEqual(socks.log.at(-1), { methods: [0, 2], atyp: 3, host: "trace.test", port: 443 });
  const strict = keep(await socks5Proxy({ upstream: trace.port, auth: { username: USER, password: PASS } }));
  assert.deepEqual(await probeEgress({ proxy: via("socks5", strict.port), checkUrl: CHECK, auth: { username: USER, password: PASS }, extraCa: pki.ca }), { ok: true, ip: "203.0.113.10", loc: "US" });
  assert.deepEqual(strict.log.at(-1), { methods: [0, 2], atyp: 3, host: "trace.test", port: 443, username: USER, authorized: true });
  // The wrong password, and none at all: refused in words, the credential nowhere.
  const wrongSocks = await probeEgress({ proxy: via("socks5", strict.port), checkUrl: CHECK, auth: { username: USER, password: "not-the-one" }, extraCa: pki.ca });
  assert.deepEqual([wrongSocks.ok, wrongSocks.step], [false, "socks5"]);
  assert.match(wrongSocks.problem, /^proxy 127\.0\.0\.1:\d+: refused the username and password$/);
  noCredential(wrongSocks);
  assert.ok(!wrongSocks.problem.includes("not-the-one"));
  const noneSocks = await probeEgress({ proxy: via("socks5", strict.port), checkUrl: CHECK, extraCa: pki.ca });
  assert.match(noneSocks.problem, /asks for a username and password; set "auth": true/);
  assert.deepEqual(strict.log.at(-1).methods, [0]);
  for (const bad of [{ username: "", password: PASS }, { username: USER, password: "x".repeat(256) }]) {
    const r = await probeEgress({ proxy: via("socks5", strict.port), checkUrl: CHECK, auth: bad, extraCa: pki.ca });
    assert.match(r.problem, /must each be 1 to 255 bytes/);
    noCredential(r);
  }
});

test("https: proxy works and an untrusted certificate is refused", { skip: noOpenssl }, async () => {
  const trace = keep(await traceServer({ tls: pki }));
  const secure = keep(await httpProxy({ upstream: trace.port, tls: pki }));
  assert.deepEqual(await probeEgress({ proxy: via("https", secure.port), checkUrl: CHECK, extraCa: pki.ca }), { ok: true, ip: "203.0.113.10", loc: "US" });
  // The proxy's certificate, not trusted here: refused naming host and "certificate", nothing sent.
  const before = secure.log.length;
  const proxyCert = await probeEgress({ proxy: via("https", secure.port), checkUrl: CHECK, auth: { username: USER, password: PASS } });
  assert.equal(proxyCert.ok, false);
  assert.equal(proxyCert.step, "connect");
  assert.match(proxyCert.problem, /^proxy 127\.0\.0\.1:\d+: its certificate isn't trusted \(/);
  assert.equal(secure.log.length, before, "no CONNECT, so no credential, over an untrusted connection");
  noCredential(proxyCert);
  // The check host's certificate, not trusted: refused naming the check host.
  const open = keep(await httpProxy({ upstream: trace.port }));
  const hostCert = await probeEgress({ proxy: via("http", open.port), checkUrl: CHECK });
  assert.equal(hostCert.step, "tls");
  assert.match(hostCert.problem, /^check address trace\.test: its certificate isn't trusted \(/);
  // A certificate for another name.
  const other = await probeEgress({ proxy: via("http", open.port), checkUrl: "https://elsewhere.test/t", extraCa: pki.ca });
  assert.match(other.problem, /^check address elsewhere\.test: its certificate isn't trusted \(ERR_TLS_CERT_ALTNAME_INVALID\)/);
});

test("hung or malformed proxies end within bound without the credential", async () => {
  const auth = { username: USER, password: PASS };
  const hung = keep(await hungProxy());
  for (const scheme of ["http", "socks5"]) {
    const t0 = Date.now();
    const r = await probeEgress({ proxy: via(scheme, hung.port), checkUrl: CHECK, timeoutMs: 300, ...(scheme === "http" ? { auth } : {}) });
    assert.ok(Date.now() - t0 < 1500, `ended within its bound (${Date.now() - t0} ms)`);
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
    assert.equal(r.step, scheme === "http" ? "tunnel" : "socks5");
    assert.match(r.problem, /^proxy 127\.0\.0\.1:\d+: timed out \((tunnel|socks5), 300 ms in all\)$/);
    noCredential(r);
  }
  const garbage = keep(await garbageProxy());
  const notHttp = await probeEgress({ proxy: via("http", garbage.port), checkUrl: CHECK, auth, timeoutMs: 2000 });
  assert.match(notHttp.problem, /answered something that isn't HTTP/);
  noCredential(notHttp);
  const notSocks = await probeEgress({ proxy: via("socks5", garbage.port), checkUrl: CHECK, timeoutMs: 2000 });
  assert.match(notSocks.problem, /answered something that isn't SOCKS5/);
  const gone = await probeEgress({ proxy: via("http", await closedPort()), checkUrl: CHECK, auth, timeoutMs: 2000 });
  assert.deepEqual([gone.step, gone.timedOut], ["connect", false]);
  assert.match(gone.problem, /^proxy 127\.0\.0\.1:\d+: refused the connection$/);
  // A proxy that refuses the tunnel, and a SOCKS5 proxy wanting a password.
  const denied = keep(await garbageProxy("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"));
  assert.match((await probeEgress({ proxy: via("http", denied.port), checkUrl: CHECK, timeoutMs: 2000 })).problem, /refused the tunnel \(status 403\)/);
  const wantsAuth = keep(await garbageProxy(Buffer.from([5, 0xff]).toString("latin1")));
  assert.match((await probeEgress({ proxy: via("socks5", wantsAuth.port), checkUrl: CHECK, timeoutMs: 2000 })).problem, /asks for a username and password; set "auth": true/);
  assert.match((await probeEgress({ proxy: via("socks5", wantsAuth.port), checkUrl: CHECK, auth, timeoutMs: 2000 })).problem, /takes neither "no authentication" nor a username and password/);
});

test("the answer: status, redirects, chunked and cut bodies, no ip line; direct probes", async () => {
  const answers = {
    "/chunked": (res) => { res.writeHead(200, { "transfer-encoding": "chunked" }); res.write("ip=192.0.2."); res.end("44\nloc=FR\n"); },
    "/redirect": (res) => { res.writeHead(302, { location: "https://example.com/" }); res.end(); },
    "/missing": (res) => { res.writeHead(404); res.end(); },
    "/noip": (res) => { res.writeHead(200); res.end("loc=US\n"); },
    "/badip": (res) => { res.writeHead(200); res.end("ip=127.1\nloc=US\n"); },
    "/cut": (res) => { res.writeHead(200, { "content-length": "100" }); res.write("ip=192.0.2.1\n"); setTimeout(() => res.socket.destroy(), 20); },
    "/huge": (res) => { res.writeHead(200); res.end("x".repeat(200_000)); },
  };
  const trace = keep(await traceServer({ answer: (req, res) => answers[req.url](res) }));
  const direct = (path) => probeEgress({ checkUrl: `http://127.0.0.1:${trace.port}${path}`, timeoutMs: 3000 });
  assert.deepEqual(await direct("/chunked"), { ok: true, ip: "192.0.2.44", loc: "FR" });
  assert.match((await direct("/redirect")).problem, /^check address 127\.0\.0\.1: answered status 302 \(a redirect; it isn't followed\)$/);
  assert.match((await direct("/missing")).problem, /answered status 404$/);
  assert.match((await direct("/noip")).problem, /answered without an ip= line/);
  assert.match((await direct("/badip")).problem, /answered without an ip= line/, "only a written-out address counts");
  assert.match((await direct("/cut")).problem, /closed the connection in the middle of its answer/);
  assert.match((await direct("/huge")).problem, /answered more than a check needs/);
  assert.match((await probeEgress({ checkUrl: "ftp://x/" })).problem, /isn't an http or https address/);
  assert.match((await probeEgress({ checkUrl: "not a url" })).problem, /isn't a valid address/);
});

test("parseTrace and checkTargets (PAIRBROWSE_TEST_NET_CHECK)", () => {
  assert.deepEqual(parseTrace("fl=1\nip=2001:DB8:0:0::1\nloc=GB\n"), { ip: "2001:db8::1", loc: "GB" });
  assert.deepEqual(parseTrace("ip=203.0.113.9\nloc=T1\n"), { ip: "203.0.113.9", loc: null }, "loc is two letters or nothing");
  assert.deepEqual(parseTrace("ipx=1.2.3.4\n"), { ip: null, loc: null });
  const net = { checkUrl: "https://check.example.com/trace" };
  assert.deepEqual(checkTargets(net, {}), { checkUrl: net.checkUrl, directUrl: net.checkUrl, stun: STUN_URL, timeoutMs: CHECK_MS });
  assert.deepEqual(checkTargets(null, {}).checkUrl, CHECK_URL);
  const env = { PAIRBROWSE_TEST_NET_CHECK: JSON.stringify({ checkUrl: "http://trace.test/t", directUrl: "http://127.0.0.1:9/t", stun: "stun:127.0.0.1:3478", ms: 2000 }) };
  assert.deepEqual(checkTargets(net, env), { checkUrl: "http://trace.test/t", directUrl: "http://127.0.0.1:9/t", stun: "stun:127.0.0.1:3478", timeoutMs: 2000 });
  for (const bad of ["{", "null", JSON.stringify({ checkUrl: "file:///etc/passwd", stun: "stun:a b", ms: 5 })]) {
    assert.deepEqual(checkTargets(net, { PAIRBROWSE_TEST_NET_CHECK: bad }), checkTargets(net, {}), bad);
  }
});
