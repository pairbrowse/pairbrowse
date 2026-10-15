// Property-based fuzzing of the local-network check (scripts/rules/network.mjs): every way a URL
// can name a loopback, private, link-local or shared (CGNAT, Tailscale) address is caught, and
// public addresses written the same ways are not.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { isLocalNetwork, isLocalHost } from "../../scripts/rules/network.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property) => fc.assert(property, { numRuns: RUNS });

// [first address, prefix length] of each local IPv4 range.
const RANGES = [[0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0a80000, 16]];
const isLocal = (n) => RANGES.some(([b, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(b / 2 ** (32 - bits)));
const localV4 = fc.tuple(fc.constantFrom(...RANGES), fc.nat()).map(([[b, bits], r]) => b + (r % 2 ** (32 - bits)));
const publicV4 = fc.nat({ max: 0xffffffff }).filter((n) => !isLocal(n));

const bytes = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const hex16 = (n) => [((n >>> 16) & 0xffff).toString(16), (n & 0xffff).toString(16)];
const part = (v, how) => (how === 0 ? String(v) : how === 1 ? `0x${v.toString(16)}` : v === 0 ? "0" : `0${v.toString(8)}`);
// The ways one IPv4 address can be written in a URL's host.
const writings = (n) => fc.tuple(fc.nat({ max: 12 }), fc.array(fc.nat({ max: 2 }), { minLength: 4, maxLength: 4 }), fc.constantFrom("", ".", "..")).map(([form, hows, dot]) => {
  const [a, b, c, d] = bytes(n);
  const [hi, lo] = hex16(n);
  switch (form) {
    case 0: return `${[a, b, c, d].map((v, i) => part(v, hows[i])).join(".")}${dot}`;
    case 1: return `${part(n, hows[0])}${dot}`; // one number
    case 2: return `${part(a, hows[0])}.${part(n & 0xffffff, hows[1])}${dot}`; // a.bcd
    case 3: return `${part(a, hows[0])}.${part(b, hows[1])}.${part(n & 0xffff, hows[2])}${dot}`; // a.b.cd
    case 4: return `[::ffff:${a}.${b}.${c}.${d}]`;
    case 5: return `[::ffff:${hi}:${lo}]`;
    case 6: return `[0:0:0:0:0:ffff:${a}.${b}.${c}.${d}]`;
    case 7: return `[64:ff9b::${a}.${b}.${c}.${d}]`;
    case 8: return `[64:ff9b::${hi}:${lo}]`;
    case 9: return `[2002:${hi}:${lo}::1]`;
    case 10: return `[::${a}.${b}.${c}.${d}]`.replace("[::0.0.0.0]", "[::]").replace("[::0.0.0.1]", "[::1]");
    default: return `${a}.${b}.${c}.${d}${dot}`;
  }
});

test("a local IPv4 address is caught however it is written", () => {
  check(fc.property(localV4.chain((n) => writings(n).map((w) => [n, w])), fc.constantFrom("http", "https", "ws", "ftp"), ([n, w], scheme) => {
    assert.ok(isLocalNetwork(`${scheme}://${w}/x`), `${w} (${bytes(n).join(".")})`);
  }));
});

test("a public IPv4 address written the same ways is not", () => {
  // ::a.b.c.d (IPv4-compatible) and 6to4 embed the address too; NAT64's 64:ff9b::/96 likewise.
  check(fc.property(publicV4.chain((n) => writings(n).map((w) => [n, w])), ([n, w]) => {
    assert.equal(isLocalNetwork(`http://${w}/`), false, `${w} (${bytes(n).join(".")})`);
  }));
});

test("unique local, link-local and site-local IPv6 addresses are caught; global ones are not", () => {
  const group = fc.nat({ max: 0xffff }).map((n) => n.toString(16));
  const rest = fc.array(group, { minLength: 7, maxLength: 7 });
  check(fc.property(fc.constantFrom([0xfc00, 0xfe00], [0xfe80, 0xffc0], [0xfec0, 0xffc0]), fc.nat({ max: 0xffff }), rest, ([base, mask], r, tail) => {
    const first = (base | (r & ~mask & 0xffff)).toString(16);
    assert.ok(isLocalNetwork(`http://[${first}:${tail.join(":")}]/`), first);
  }));
  check(fc.property(fc.integer({ min: 0x2001, max: 0x3fff }).filter((g) => g !== 0x2002), rest, (g, tail) => {
    assert.equal(isLocalNetwork(`http://[${g.toString(16)}:${tail.join(":")}]/`), false);
  }));
});

test("local names with any number of trailing dots and any case; the check never throws", () => {
  check(fc.property(fc.constantFrom("localhost", "app.localhost", "printer.local", "LocalHost", "NAS.LOCAL"), fc.constantFrom("", ".", ".."), (name, dot) => {
    assert.ok(isLocalNetwork(`http://${name}${dot}:8080/`), name + dot);
  }));
  check(fc.property(fc.string({ maxLength: 60 }), (s) => {
    assert.equal(typeof isLocalNetwork(s), "boolean");
    assert.equal(typeof isLocalHost(s), "boolean");
  }));
});
