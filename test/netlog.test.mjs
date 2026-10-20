// The DNS leak tests' parts without a browser (spec server-mode C12): the NetLog switch only a
// test run's helper adds to a launch (daemon/browser/launch.mjs withNetLog), and the reader that
// finds the names a browser looked up itself (test/helpers/netlog.mjs), on NetLogs shaped as the
// engine writes them, a cut-short one included. The live test: test/integration/proxy.test.mjs.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { withNetLog, NETLOG_SWITCH } from "../scripts/daemon/browser/launch.mjs";
import { paths } from "../scripts/paths.mjs";
import { parseNetLog, bareHost, resolvedHosts, dnsLeaks } from "./helpers/netlog.mjs";

test("withNetLog: the switch only with PAIRBROWSE_TEST_NETLOG=1, after every other one, into the home", () => {
  const options = { headless: false, args: ["--lang=en-US", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"] };
  assert.equal(withNetLog(options, { env: {} }), options, "unchanged without the switch");
  assert.equal(withNetLog(options, { env: { PAIRBROWSE_TEST_NETLOG: "0" } }), options, "only \"1\" turns it on");
  const on = withNetLog(options, { env: { PAIRBROWSE_TEST_NETLOG: "1" } });
  assert.deepEqual(on.args, [...options.args, `${NETLOG_SWITCH}=${paths.netlog}`]);
  assert.equal(on.headless, false, "the other options kept");
  assert.equal(options.args.length, 2, "the launch's own options aren't changed in place");
  assert.deepEqual(withNetLog({}, { env: { PAIRBROWSE_TEST_NETLOG: "1" }, file: "/t/n.json" }).args, ["--log-net-log=/t/n.json"]);
  assert.ok(paths.netlog.startsWith(paths.home), "the NetLog stays in the (test) home");
});

// A NetLog as the engine writes it: constants, then one event per line.
const TYPES = { HOST_RESOLVER_MANAGER_REQUEST: 7, HOST_RESOLVER_MANAGER_JOB: 8, DNS_TRANSACTION: 9, URL_REQUEST_START_JOB: 10, TCP_CONNECT: 11 };
const event = (type, params, phase = 1) => JSON.stringify({ params, phase, source: { id: 3, type: 1 }, time: "1", type: TYPES[type] });
const netlog = (events, { finished = true } = {}) =>
  `{"constants":{"logEventTypes":${JSON.stringify(TYPES)},"logEventPhase":{"PHASE_BEGIN":1}},\n"events": [\n${events.join(",\n")}${finished ? "\n]}\n" : ",\n"}`;

test("the reader: hosts of the resolver's events, bare and once each; other events never count", () => {
  const log = parseNetLog(netlog([
    event("HOST_RESOLVER_MANAGER_REQUEST", { host: "http://Page-1.test", is_speculative: false }),
    event("HOST_RESOLVER_MANAGER_REQUEST", { host: "https://page-1.test:8443" }),
    event("HOST_RESOLVER_MANAGER_JOB", { host: "img-1.test:443" }),
    event("DNS_TRANSACTION", { hostname: "dp-1.test", query_type: 1 }),
    event("HOST_RESOLVER_MANAGER_REQUEST", { host: "[::1]:9222" }),
    event("HOST_RESOLVER_MANAGER_REQUEST", { net_error: -105 }, 2),
    event("URL_REQUEST_START_JOB", { url: "http://never-resolved.test/" }),
    event("TCP_CONNECT", { address_list: ["203.0.113.10:80"], host: "proxied.test" }),
  ]));
  assert.deepEqual(resolvedHosts(log), ["page-1.test", "img-1.test", "dp-1.test", "::1"]);
  assert.deepEqual(resolvedHosts({}), [], "nothing in nothing");
});

test("bareHost: scheme, port and brackets off", () => {
  assert.equal(bareHost("http://~NOTFOUND"), "~notfound");
  assert.equal(bareHost("https://[2001:db8::1]:8443"), "2001:db8::1");
  assert.equal(bareHost("2001:db8::1"), "2001:db8::1", "a bare IPv6 address keeps its colons");
  assert.equal(bareHost("proxy.test:3128"), "proxy.test");
  assert.equal(bareHost("ws://ws.test/path"), "ws.test");
});

test("dnsLeaks: every lookup but the proxy's host, loopback and strict mode's ~NOTFOUND", () => {
  const log = parseNetLog(netlog([
    event("HOST_RESOLVER_MANAGER_REQUEST", { host: "http://~notfound" }),
    event("HOST_RESOLVER_MANAGER_REQUEST", { host: "proxy.test:3128" }),
    event("HOST_RESOLVER_MANAGER_REQUEST", { host: "localhost:80" }),
    event("HOST_RESOLVER_MANAGER_REQUEST", { host: "127.0.0.1:5000" }),
    event("HOST_RESOLVER_MANAGER_REQUEST", { host: "app.localhost:80" }),
  ]));
  assert.deepEqual(dnsLeaks(log, { proxyHost: "proxy.test" }), [], "a strict session's NetLog: nothing leaks");
  const leaky = parseNetLog(netlog([
    event("HOST_RESOLVER_MANAGER_REQUEST", { host: "proxy.test:3128" }),
    event("HOST_RESOLVER_MANAGER_REQUEST", { host: "http://page-1.test" }),
    event("HOST_RESOLVER_MANAGER_JOB", { host: "update.example:443" }),
  ]));
  assert.deepEqual(dnsLeaks(leaky, { proxyHost: "proxy.test" }), ["page-1.test", "update.example"]);
  assert.deepEqual(dnsLeaks(leaky, { proxyHost: "other.test" }), ["proxy.test", "page-1.test", "update.example"], "another proxy's host is a leak too");
});

test("a NetLog cut short (the browser killed) is read up to its last whole event", () => {
  const whole = [event("HOST_RESOLVER_MANAGER_REQUEST", { host: "http://a.test" }), event("HOST_RESOLVER_MANAGER_REQUEST", { host: "http://b.test" })];
  const cut = `${netlog(whole, { finished: false })}{"params":{"host":"http://c.te`;
  assert.deepEqual(resolvedHosts(parseNetLog(cut)), ["a.test", "b.test"]);
  assert.deepEqual(resolvedHosts(parseNetLog(netlog(whole, { finished: false }))), ["a.test", "b.test"], "ended after a comma");
  assert.throws(() => parseNetLog("not json at all"), /not a NetLog/);
  assert.throws(() => parseNetLog(""), /not a NetLog/);
});
