// Property-based fuzzing of a shared dev server's edges (scripts/sharing/devshare.mjs): which
// addresses count as one, the Host/Origin/Cookie rewrite toward it and the redirect and cookie
// rewrite back, the entry a joiner takes from the host, the host's other tunnel addresses
// (join-client.mjs relayUrl), and mapUrl: a localhost tab's shared address and back.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { devAddress, splitCookie, toDevHeaders, fromDevHeaders, readDevEntry, createDevShare, DEV_COOKIE, TOKEN } from "../../scripts/sharing/devshare.mjs";
import { relayUrl } from "../../scripts/sharing/join-client.mjs";
import { stateForJoiner, shareableUrl } from "../../scripts/sharing/tabsync.mjs";
import { isQuickTunnelHost } from "../../scripts/util.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property) => fc.assert(property, { numRuns: RUNS });
const anyText = fc.string({ unit: "binary", maxLength: 60 });
const label = fc.stringMatching(/^[a-z0-9]{1,8}$/);
const tunnel = fc.array(label, { minLength: 1, maxLength: 3 }).map((w) => `https://${w.join("-")}.trycloudflare.com`);
const hostish = fc.constantFrom("localhost", "127.0.0.1", "[::1]", "app.localhost", "LOCALHOST", "localhost.", "127.1", "0.0.0.0", "10.0.0.1", "example.com", "a.localhost.evil.com", "localhost@evil.com");
const anyUrl = fc.oneof(anyText, fc.webUrl({ withQueryParameters: true, withFragments: true }),
  fc.tuple(fc.constantFrom("http", "https", "ws", "file", "javascript"), fc.constantFrom("", "u:p@", "u@"), hostish, fc.constantFrom("", ":0", ":3000", ":65535", ":65536", ":x"), fc.constantFrom("/", "/a?b=1", "/#x", "")).map(([s, a, h, p, r]) => `${s}://${a}${h}${p}${r}`));

// Property: only http on this computer's loopback names (or *.localhost) is a dev server,
// without a user part, on a real port; anything else is null; never thrown.
test("a dev server address is http on this computer only", () => {
  check(fc.property(fc.oneof(anyUrl, fc.anything()), (raw) => {
    const d = devAddress(raw);
    if (d === null) return;
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(d.hostname) || d.hostname.endsWith(".localhost"), d.hostname);
    assert.ok(Number.isInteger(d.port) && d.port >= 1 && d.port <= 65535);
    const u = new URL(String(raw));
    assert.equal(u.protocol, "http:");
    assert.ok(!u.username && !u.password);
  }));
});

const cookiePart = fc.oneof(fc.tuple(fc.constantFrom(DEV_COOKIE, "a", "sid", `${DEV_COOKIE}x`, ` ${DEV_COOKIE}`), fc.stringMatching(/^[^;]{0,20}$/)).map(([k, v]) => `${k}=${v}`), fc.constantFrom(DEV_COOKIE, "", " ", "=x"));
const cookieHeader = fc.array(cookiePart, { maxLength: 5 }).map((p) => p.join(";"));

// Property: the joiner's token cookie never reaches the dev server, nor any header that names
// another visitor or address (x-forwarded-*, forwarded, cf-*); Host is always the dev server's,
// and an Origin or Referer on the shared address arrives as the dev server's own.
test("toward the dev server: its own Host, no token cookie, no forwarding headers", () => {
  const local = { host: "localhost:3000", origin: "http://localhost:3000" };
  const pub = "https://a-b.trycloudflare.com";
  const name = fc.oneof(fc.constantFrom("host", "origin", "referer", "cookie", "x-forwarded-host", "X-Forwarded-For", "forwarded", "cf-connecting-ip", "x-real-ip", "true-client-ip", "cdn-loop", "accept"), fc.stringMatching(/^[a-z-]{1,12}$/));
  const value = fc.oneof(anyText, fc.constant(pub), fc.constant(`${pub}/x?y`), anyUrl);
  check(fc.property(fc.dictionary(name, value, { maxKeys: 8 }), cookieHeader, fc.constantFrom(pub, null), (headers, cookie, publicOrigin) => {
    const out = toDevHeaders({ ...headers, cookie }, { local, publicOrigin });
    assert.equal(out.host, local.host);
    for (const k of Object.keys(out)) assert.doesNotMatch(k, /^(x-forwarded-|x-real-ip$|forwarded$|cf-|cdn-loop$|true-client-ip$)/i);
    if (out.cookie !== undefined) for (const part of out.cookie.split(";")) assert.notEqual(part.trim().split("=")[0], DEV_COOKIE);
    for (const h of ["origin", "referer"]) if (publicOrigin && typeof headers[h] === "string" && headers[h].startsWith(pub)) assert.ok(out[h].startsWith(local.origin));
  }));
});

// Property: splitCookie finds a cookie only by its exact name, and the rest never holds it.
test("one cookie out of a Cookie header, by its exact name only", () => {
  check(fc.property(cookieHeader, (h) => {
    const { value, rest } = splitCookie(h, DEV_COOKIE);
    const named = h.split(";").map((s) => s.trim()).filter((p) => p && p.slice(0, p.includes("=") ? p.indexOf("=") : p.length) === DEV_COOKIE);
    assert.equal(value !== null, named.length > 0);
    for (const part of rest.split("; ")) assert.notEqual(part.slice(0, part.includes("=") ? part.indexOf("=") : part.length), DEV_COOKIE);
  }));
});

// Property: back to the visitor, a redirect moves to the shared address only when it pointed at
// the dev server's own origin (never a lookalike such as localhost:3000.evil.com), and cookies
// lose their Domain.
test("back from the dev server: redirects only from its own origins, cookies without Domain", () => {
  const local = { origins: ["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"] };
  const pub = "https://a-b.trycloudflare.com";
  const loc = fc.oneof(anyUrl, fc.tuple(fc.constantFrom(...local.origins, "http://localhost:30000", "http://localhost:3000.evil.com", "http://localhost:3000@evil.com"), fc.constantFrom("", "/", "/x", "?a", "#b", ".evil")).map(([o, r]) => o + r));
  const setCookie = fc.array(fc.tuple(anyText, fc.constantFrom("", "; Domain=localhost", ";domain=.x.com", "; DOMAIN=a; Path=/", "; Path=/")).map(([a, b]) => `c=${a}${b}`), { maxLength: 3 });
  check(fc.property(loc, setCookie, (location, cookies) => {
    const out = fromDevHeaders({ location, "set-cookie": cookies }, { local, publicOrigin: pub });
    const own = local.origins.find((o) => location === o || location.startsWith(`${o}/`) || location.startsWith(`${o}?`));
    assert.equal(out.location, own ? pub + location.slice(own.length) : location);
    if (cookies.length) for (const c of [].concat(out["set-cookie"])) assert.doesNotMatch(c, /;\s*domain=/i);
  }));
});

// Property: a joiner takes a dev server entry from the host only as a Quick Tunnel origin
// (standbys too) with a 64-hex token; anything else is null, never thrown.
test("a joiner's dev server entry: Quick Tunnel origins and a token only", () => {
  const origin = fc.oneof(tunnel, anyUrl, tunnel.map((t) => `${t}/`), tunnel.map((t) => t.replace("https", "http")), fc.constant("https://trycloudflare.com"), fc.constant("https://x.trycloudflare.com.evil.com"));
  check(fc.property(fc.oneof(fc.anything(), fc.record({ origin, token: fc.oneof(fc.stringMatching(/^[0-9a-f]{64}$/), anyText), also: fc.oneof(fc.anything(), fc.array(origin, { maxLength: 5 })) }, { requiredKeys: [] })), (x) => {
    const e = readDevEntry(x);
    if (!e) return;
    assert.match(e.token, TOKEN);
    for (const o of [e.origin, ...(e.also || [])]) { const u = new URL(o); assert.equal(u.protocol, "https:"); assert.ok(isQuickTunnelHost(u.hostname)); assert.equal(u.origin, o); }
    assert.ok(!e.also || e.also.length <= 3);
  }));
});

// Property: one of the host's other addresses is followed only when it is the join code's own
// origin or a Quick Tunnel origin; never a user part, a path or another host.
test("the host's other tunnel addresses: the code's origin or a Quick Tunnel only", () => {
  const code = "https://code-host.trycloudflare.com/x";
  check(fc.property(fc.oneof(anyUrl, tunnel, fc.anything()), (raw) => {
    const r = relayUrl(raw, code);
    if (r === null) return;
    const u = new URL(r);
    assert.equal(r, u.origin);
    assert.ok(r === new URL(code).origin || (u.protocol === "https:" && isQuickTunnelHost(u.hostname)), r);
  }));
});

// Property: mapUrl round-trips. A localhost tab on a shared port crosses as the shared address
// with the same path, query and fragment, and comes back as the dev server's own; a port not
// shared, or any other address, maps to nothing.
test("mapUrl: a shared port's tab crosses as its shared address and comes back the same", async () => {
  const share = createDevShare({ direct: true });
  try {
    const entry = await share.share("localhost", 4321);
    const path = fc.webPath();
    const query = fc.option(fc.webQueryParameters().map((q) => `?${q}`), { nil: "" });
    const frag = fc.option(fc.webFragments().map((f) => `#${f}`), { nil: "" });
    check(fc.property(fc.constantFrom("localhost", "127.0.0.1", "[::1]"), path, query, frag, (host, p, q, f) => {
      const local = `http://${host}:4321${p.startsWith("/") ? p : `/${p}`}${q}${f}`;
      const u = new URL(local);
      const pub = share.toPublic(local);
      assert.equal(pub, entry.origin + u.pathname + u.search + u.hash);
      assert.equal(share.toLocal(pub), entry.proxy.local.origin + u.pathname + u.search + u.hash);
      assert.equal(share.toPublic(local.replace(":4321", ":4322")), null);
    }));
    check(fc.property(fc.oneof(anyUrl, fc.anything()), (raw) => {
      const pub = share.toPublic(raw);
      if (pub !== null) assert.ok(pub.startsWith(`${entry.origin}/`));
      const back = share.toLocal(raw);
      if (back !== null) assert.ok(back.startsWith(`${entry.proxy.local.origin}/`));
    }));
  } finally { share.stopAll(); }
});

// Property: whatever mapUrl answers for a tab (a shared address, a local one, garbage), what
// crosses to a joiner is still only a public web address.
test("a tab crosses only as a public web address, whatever mapUrl answers", () => {
  check(fc.property(fc.array(fc.tuple(anyUrl, fc.oneof(anyUrl, fc.constant(null), fc.anything())), { maxLength: 5 }), fc.boolean(), (pairs, drive) => {
    const tabs = pairs.map(([url], i) => ({ id: `0000000${i}`, url, title: "t" }));
    const map = new Map(pairs.map(([url, to]) => [url, to]));
    const state = stateForJoiner({ tabs }, { drive, mapUrl: (u) => (typeof map.get(u) === "string" ? map.get(u) : null) });
    for (const t of state.tabs) {
      assert.equal(shareableUrl(t.url, { full: true }) !== null, true, t.url);
      assert.equal(devAddress(t.url), null);
    }
  }));
});
