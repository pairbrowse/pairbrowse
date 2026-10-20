// What the egress checks mean (spec server-mode C7, C8; net/verdict.mjs): the browser's exit must be
// the one the helper measured through the proxy, inside expectEgress when it names any, and not this
// computer's own when it doesn't; a recheck's move is "changed"; WebRTC candidates other than mDNS
// names and the proxy's exit are leaks; a failed or timed-out check is a failure, never a pass; and
// no reason names an address.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalIp, inExpected, egressVerdict, webrtcVerdict, parseCandidate } from "../scripts/net/verdict.mjs";

const EXIT = "203.0.113.10", HOME = "198.51.100.7";
const ok = (ip, loc = "US") => ({ ok: true, ip, loc });
const noAddress = (v) => assert.doesNotMatch(v.reason, /\d+\.\d+\.\d+\.\d+|[0-9a-f]+::/i, `no address in "${v.reason}"`);

test("normalIp writes one spelling, or null", () => {
  assert.equal(normalIp("203.0.113.10"), "203.0.113.10");
  assert.equal(normalIp(" 2001:DB8:0:0:0:0:0:1 "), "2001:db8::1");
  assert.equal(normalIp("[2001:db8::1]"), "2001:db8::1");
  assert.equal(normalIp("2001:db8:0:1:0:0:0:5"), "2001:db8:0:1::5", "the longest zero run");
  assert.equal(normalIp("2001:db8:1:1:1:1:0:1"), "2001:db8:1:1:1:1:0:1", "a single zero group stays");
  for (const bad of ["127.1", "0x7f.0.0.1", "010.0.0.1", "256.1.1.1", "fe80::1%en0", "example.com", "", null]) assert.equal(normalIp(bad), null, String(bad));
});

test("CIDR and country expectations, same as direct, browser vs helper, change from baseline", () => {
  // Expectations: ranges and countries, each required when named; none is null.
  assert.equal(inExpected(EXIT, "US", null), null);
  assert.equal(inExpected(EXIT, "US", []), null);
  assert.equal(inExpected(EXIT, "US", ["203.0.113.0/24"]), true);
  assert.equal(inExpected("203.0.114.1", "US", ["203.0.113.0/24"]), false);
  assert.equal(inExpected(EXIT, "US", ["203.0.113.10"]), true);
  assert.equal(inExpected(EXIT, "US", ["0.0.0.0/0"]), true);
  assert.equal(inExpected(EXIT, "DE", ["country:US", "country:CA"]), false);
  assert.equal(inExpected(EXIT, null, ["country:US"]), false, "an unknown country isn't the expected one");
  assert.equal(inExpected(EXIT, "us", ["country:US"]), true);
  assert.equal(inExpected(EXIT, "US", ["203.0.113.0/24", "country:US"]), true);
  assert.equal(inExpected(EXIT, "DE", ["203.0.113.0/24", "country:US"]), false, "both kinds must hold");
  assert.equal(inExpected("2001:db8::77", "US", ["2001:db8::/32"]), true);
  assert.equal(inExpected("2001:db9::77", "US", ["2001:db8::/32"]), false);
  assert.equal(inExpected("2001:db8::77", "US", ["203.0.113.0/24"]), false, "an IPv6 exit isn't in an IPv4 range");
  assert.equal(inExpected(EXIT, "US", ["2001:db8::/32"]), false);

  // Helper and browser agree: ok, with the exit read and whether it is this computer's own.
  assert.deepEqual(egressVerdict({ helper: ok(EXIT), browser: ok(EXIT), direct: ok(HOME) }), { verdict: "ok", reason: "", ip: EXIT, loc: "US", sameAsDirect: false });
  assert.equal(egressVerdict({ helper: ok(EXIT), browser: ok(EXIT) }).sameAsDirect, null, "the direct exit unknown");
  assert.equal(egressVerdict({ helper: ok(EXIT), browser: ok(EXIT), direct: { ok: false, problem: "x" } }).verdict, "ok", "a network whose only way out is the proxy");
  // Browser vs helper.
  const differ = egressVerdict({ helper: ok(EXIT), browser: ok(HOME) });
  assert.equal(differ.verdict, "failed");
  assert.match(differ.reason, /different address than the proxy's/);
  noAddress(differ);
  assert.equal(egressVerdict({ helper: ok("2001:db8::1"), browser: ok("2001:DB8:0::1") }).verdict, "ok", "spellings of one address agree");
  // Same as direct, when no expectation is set; an expectation decides instead when set.
  const same = egressVerdict({ helper: ok(HOME), browser: ok(HOME), direct: ok(HOME) });
  assert.deepEqual([same.verdict, same.sameAsDirect], ["failed", true]);
  assert.match(same.reason, /this computer's own/);
  noAddress(same);
  assert.equal(egressVerdict({ helper: ok(HOME), browser: ok(HOME), direct: ok(HOME), expectEgress: ["198.51.100.0/24"] }).verdict, "ok");
  const outside = egressVerdict({ helper: ok(EXIT, "DE"), browser: ok(EXIT, "DE"), expectEgress: ["country:US"] });
  assert.equal(outside.verdict, "failed");
  assert.match(outside.reason, /outside the addresses or countries its expectEgress lists/);
  // Change from baseline (a recheck); the same address is ok.
  const moved = egressVerdict({ helper: ok("203.0.113.11"), browser: ok("203.0.113.11"), baseline: EXIT });
  assert.equal(moved.verdict, "changed");
  noAddress(moved);
  assert.equal(egressVerdict({ helper: ok(EXIT), browser: ok(EXIT), baseline: EXIT }).verdict, "ok");
  // A failure outranks a change.
  assert.equal(egressVerdict({ helper: ok("203.0.113.11"), browser: ok("203.0.113.11"), baseline: EXIT, expectEgress: ["country:FR"] }).verdict, "failed");
});

test("WebRTC host or srflx with a real address is a leak", () => {
  const line = (addr, type, raddr) => `candidate:1 1 udp 2113937151 ${addr} 5000 typ ${type}${raddr ? ` raddr ${raddr} rport 0` : ""} generation 0`;
  const mdns = "375d1daf-927a-43ac-a42c-37aabca2807f.local";
  assert.deepEqual(parseCandidate(`a=${line(EXIT, "srflx", "0.0.0.0")}`), { address: EXIT, type: "srflx", related: "0.0.0.0" });
  assert.equal(parseCandidate("nonsense"), null);
  // None, mDNS names, the proxy's exit: ok, kept without addresses.
  assert.deepEqual(webrtcVerdict({ ok: true, candidates: [] }, { egress: EXIT }), { verdict: "ok", reason: "", candidates: [] });
  const fine = webrtcVerdict({ ok: true, candidates: [line(mdns, "host"), line(EXIT, "srflx", "0.0.0.0")] }, { egress: EXIT });
  assert.deepEqual(fine, { verdict: "ok", reason: "", candidates: [{ type: "host", kind: "mdns" }, { type: "srflx", kind: "egress" }] });
  // A host candidate with this computer's address, a srflx with another one, a srflx whose related
  // address is a real one, and a line that can't be read: each a leak, the record address-free.
  for (const lines of [[line("192.168.1.20", "host")], [line(mdns, "host"), line(HOME, "srflx", "0.0.0.0")], [line(EXIT, "srflx", "10.0.0.5")], ["candidate:garbled"]]) {
    const v = webrtcVerdict({ ok: true, candidates: lines }, { egress: EXIT });
    assert.equal(v.verdict, "leak", JSON.stringify(lines));
    noAddress(v);
    assert.doesNotMatch(JSON.stringify(v.candidates), /\d+\.\d+\.\d+\.\d+|\.local/);
  }
  // Without a known exit, any address is a leak.
  assert.equal(webrtcVerdict({ ok: true, candidates: [line(EXIT, "srflx")] }).verdict, "leak");
  assert.equal(webrtcVerdict({ ok: true, candidates: [line("2001:db8::9", "host")] }, { egress: EXIT }).verdict, "leak");
});

test("a timeout is a failure, never a pass", () => {
  const timedOut = { ok: false, step: "tunnel", problem: "proxy 203.0.113.10:3128: timed out (tunnel, 10000 ms in all)", timedOut: true };
  const helper = egressVerdict({ helper: timedOut, browser: ok(EXIT) });
  assert.equal(helper.verdict, "failed");
  assert.match(helper.reason, /^The check through the proxy timed out: proxy/);
  const browser = egressVerdict({ helper: ok(EXIT), browser: { ok: false, problem: "timed out (load, 10000 ms)", timedOut: true } });
  assert.equal(browser.verdict, "failed");
  assert.match(browser.reason, /^The browser's own check timed out/);
  assert.equal(egressVerdict({}).verdict, "failed", "no answers at all");
  assert.equal(egressVerdict({ helper: ok(EXIT), browser: { ok: true, ip: "not-an-ip" } }).verdict, "failed");
  const gather = webrtcVerdict({ ok: false, problem: "the WebRTC gathering didn't finish within 5000 ms", timedOut: true }, { egress: EXIT });
  assert.equal(gather.verdict, "failed");
  assert.match(gather.reason, /didn't finish in time/);
  assert.equal(webrtcVerdict(null).verdict, "failed");
});
