// Property-based fuzzing of what the live view reads from a request before any route runs: the
// path and query (liveview/http.mjs pathParts, activity.json's query), request bodies however
// they arrive in chunks (readBody, readJsonBody), the bodies' own readers (tab order, layout),
// invite keys and saved join codes (liveview/invites.mjs), and which role reaches which route.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { pathParts, readBody, readJsonBody, isPlainObject } from "../../scripts/liveview/http.mjs";
import { createInvites, roleMay, liveViewHostsFrom, inviteBaseFrom } from "../../scripts/liveview/invites.mjs";
import { readTabOrder } from "../../scripts/liveview/routes/pages.mjs";
import { readLayout, readDockTab, LAYOUT_FALLBACK, STRIP_MIN, STRIP_MAX } from "../../scripts/liveview/layout.mjs";
import { readPageQuery, PAGE_MAX } from "../../scripts/daemon/activitylog.mjs";
import { createViewerRoutes } from "../../scripts/liveview/routes/viewer.mjs";
import { createOwnerRoutes } from "../../scripts/liveview/routes/owner.mjs";
import { createSessionRoutes } from "../../scripts/liveview/routes/sessions.mjs";
import { createPagesRoutes } from "../../scripts/liveview/routes/pages.mjs";
import { createTimelineRoutes } from "../../scripts/liveview/routes/timeline.mjs";
import { createToolsRoutes } from "../../scripts/liveview/routes/tools.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property, runs = RUNS) => fc.assert(property, { numRuns: runs });
const anyText = fc.string({ unit: "binary", maxLength: 80 });

// Property: a request path splits the same with or without its query, never throws, and the key
// is exactly its first segment (a query never moves the key or the route).
test("the path's key and route ignore the query and never throw", () => {
  check(fc.property(fc.array(fc.oneof(anyText, fc.constantFrom("", "..", ".", "%2F", "state.json", "assets")), { maxLength: 6 }), anyText, (segs, q) => {
    const path = `/${segs.join("/")}`;
    const plain = pathParts({ url: path });
    const withQuery = pathParts({ url: `${path}?${q}` });
    const first = path.split("?")[0].split("/");
    assert.equal(plain.key, first[1]);
    if (!path.includes("?")) assert.deepEqual(withQuery, plain);
  }));
});

// Property: the activity page's query is refused with a sentence, or reads as a whole
// number limit from 1 to PAGE_MAX and a non-negative time; never throws.
test("activity.json's query: a plain refusal or a bounded page", () => {
  const val = fc.oneof(anyText, fc.nat().map(String), fc.constantFrom("0", "-1", "1e3", "0x10", " 5", "5 ", "9".repeat(17), "Infinity", "NaN"));
  check(fc.property(fc.option(val), fc.option(val), anyText, (before, limit, junk) => {
    const p = new URLSearchParams(junk);
    if (before !== null) p.set("before", before);
    if (limit !== null) p.set("limit", limit);
    const q = readPageQuery(p);
    if (q.error) { assert.equal(typeof q.error, "string"); return; }
    assert.ok(Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= PAGE_MAX);
    assert.ok(q.before === Infinity || (Number.isSafeInteger(q.before) && q.before >= 0));
  }));
});

// A request's body arriving in byte chunks cut anywhere (also inside one character).
const chunked = (text) => fc.array(fc.nat(), { maxLength: 6 }).map((cuts) => {
  const buf = Buffer.from(text, "utf8");
  const at = [...new Set(cuts.map((c) => c % (buf.length + 1)))].sort((a, b) => a - b);
  const parts = [];
  let last = 0;
  for (const c of [...at, buf.length]) { parts.push(buf.subarray(last, c)); last = c; }
  return parts;
});
const reqOf = (parts) => ({ async *[Symbol.asyncIterator]() { for (const p of parts) yield p; } });
const resOf = () => { const r = { code: 0, body: "", writeHead(c) { r.code = c; return r; }, end(b = "") { r.body += b; } }; return r; };
const bodyText = fc.oneof(fc.string({ unit: "grapheme", maxLength: 60 }), fc.json({ maxDepth: 3 }), fc.jsonValue({ maxDepth: 2 }).map((v) => JSON.stringify(v) ?? "null"));

// Property: a body reads back exactly as sent, however it was cut, or null once it is longer
// than max (in characters, as the caps are written).
test("a request body reads back whole however it is chunked, or null past its cap", async () => {
  await fc.assert(fc.asyncProperty(bodyText.chain((t) => fc.tuple(fc.constant(t), chunked(t))), fc.nat({ max: 80 }), async ([text, parts], max) => {
    const got = await readBody(reqOf(parts), max);
    if (text.length > max) assert.equal(got, null);
    else assert.equal(got, text);
  }), { numRuns: RUNS });
});

// Property: a JSON body is the parsed value, or the answer already went out as 413 (too
// large) or 400 (not JSON, or not an object where one is required): never a 500, never thrown.
test("a JSON body: the value, or 400 or 413 answered, never thrown", async () => {
  await fc.assert(fc.asyncProperty(bodyText.chain((t) => fc.tuple(fc.constant(t), chunked(t))), fc.nat({ max: 120 }), fc.boolean(), async ([text, parts], max, object) => {
    const res = resOf();
    const v = await readJsonBody(reqOf(parts), res, max, { object });
    if (text.length > max) { assert.equal(v, undefined); assert.equal(res.code, 413); return; }
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (parsed === undefined || (object && !isPlainObject(parsed))) { assert.equal(v, undefined); assert.equal(res.code, 400); return; }
    assert.deepEqual(v, parsed);
    assert.equal(res.code, 0, "nothing answered for a good body");
  }), { numRuns: RUNS });
});

// Property: the tab strip's report and a layout are either refused or exactly the shapes the
// helper keeps (no other field, every value in range); never thrown.
test("tab order and layout bodies: refused, or only checked fields in range", () => {
  const target = fc.oneof(fc.stringMatching(/^[A-Fa-f0-9]{32}$/), anyText);
  const tab = fc.record({ target, window: fc.oneof(fc.integer(), fc.double(), anyText), index: fc.oneof(fc.integer({ min: -2, max: 50 }), anyText), active: fc.oneof(fc.boolean(), fc.constant("true")), extra: fc.anything() }, { requiredKeys: [] });
  const body = fc.oneof(fc.anything(), fc.record({ tabs: fc.array(tab, { maxLength: 5 }), focused: fc.oneof(fc.integer(), anyText), last: fc.oneof(fc.integer(), fc.constant(null)), more: fc.anything() }, { requiredKeys: [] }));
  check(fc.property(body, (b) => {
    const r = readTabOrder(b);
    if (r === null) return;
    assert.deepEqual(Object.keys(r).sort(), ["focused", "last", "tabs"]);
    for (const t of r.tabs) {
      assert.deepEqual(Object.keys(t).sort(), ["active", "index", "target", "window"]);
      assert.match(t.target, /^[A-F0-9]{32}$/);
      assert.ok(Number.isInteger(t.index) && t.index >= 0 && Number.isInteger(t.window) && typeof t.active === "boolean");
    }
  }));
  const side = fc.oneof(fc.constantFrom("open", "rail", "hidden", "OPEN", "", "__proto__"), anyText, fc.anything());
  check(fc.property(fc.oneof(fc.anything(), fc.record({ left: side, right: side, strip: fc.oneof(fc.integer({ min: 0, max: 300 }), fc.double(), anyText), tab: fc.oneof(fc.constantFrom("agent", "page", "pictures", "tools", "x"), fc.anything()) }, { requiredKeys: [] })), (g) => {
    const l = readLayout(g, LAYOUT_FALLBACK);
    if (!l.error) {
      assert.deepEqual(Object.keys(l).sort(), ["left", "right", "strip"]);
      for (const s of [l.left, l.right]) assert.ok(["open", "rail", "hidden"].includes(s));
      assert.ok(Number.isInteger(l.strip) && l.strip >= STRIP_MIN && l.strip <= STRIP_MAX);
    }
    const t = readDockTab(g);
    assert.ok(t.error || t.tab === null || ["agent", "page", "pictures", "tools"].includes(t.tab));
  }));
});

// Property: no invite key but an invite's own whole key matches it: a prefix, a suffix, a
// changed letter, another case or any other string never does; expired and revoked keys stop.
test("an invite key matches only itself, and only while the invite stands", () => {
  check(fc.property(fc.array(fc.constantFrom("watch", "drive"), { minLength: 1, maxLength: 4 }), fc.oneof(anyText, fc.stringMatching(/^[0-9a-f]{64}$/)), fc.nat(), (roles, other, n) => {
    let t = 1_000_000;
    const invites = createInvites({ now: () => t });
    const made = roles.map((role) => invites.create({ role, hours: 1 }));
    assert.equal(invites.match(other)?.id ?? null, made.find((i) => i.key === other)?.id ?? null);
    const i = made[n % made.length];
    assert.equal(invites.match(i.key)?.id, i.id);
    const p = n % 64;
    for (const near of [i.key.slice(0, p), i.key + "0", i.key.slice(1), i.key.toUpperCase(), i.key.slice(0, p) + (i.key[p] === "a" ? "b" : "a") + i.key.slice(p + 1), ` ${i.key}`]) {
      if (near !== i.key) assert.equal(invites.match(near), null);
    }
    invites.revoke(i.id);
    assert.equal(invites.match(i.key), null);
    t += 3_600_001;
    for (const x of made) assert.equal(invites.match(x.key), null);
  }), Math.min(RUNS, 1000));
});

// Property: join codes restored from a damaged sharing file never throw, and only well-formed,
// unexpired codes within the week come back, with their roles never widened past drive.
test("saved join codes restored from any file: only checked ones, never wider", () => {
  const now = 2_000_000_000_000;
  const entry = fc.record({
    id: fc.oneof(fc.stringMatching(/^[0-9a-f]{8}$/), anyText), key: fc.oneof(fc.stringMatching(/^[0-9a-f]{64}$/), anyText),
    share: fc.constantFrom("code", "link", ""), role: fc.constantFrom("watch", "drive", "approve", "owner", "__proto__"), mode: fc.constantFrom("shared", "follow", "x"),
    approve: fc.anything(), label: fc.oneof(anyText, fc.anything()),
    createdAt: fc.oneof(fc.integer({ min: now - 9 * 86_400_000, max: now + 86_400_000 }), anyText, fc.constant(null)),
    expiresAt: fc.oneof(fc.integer({ min: now - 86_400_000, max: now + 9 * 86_400_000 }), anyText, fc.constant(Infinity)),
  }, { requiredKeys: [] });
  check(fc.property(fc.oneof(fc.anything(), fc.array(fc.oneof(entry, fc.anything()), { maxLength: 6 })), (list) => {
    const invites = createInvites({ now: () => now });
    invites.restore(list);
    for (const c of invites.savedCodes()) {
      assert.match(c.id, /^[0-9a-f]{8}$/);
      assert.match(c.key, /^[0-9a-f]{64}$/);
      assert.equal(c.share, "code");
      assert.ok(["watch", "drive"].includes(c.role));
      assert.ok(c.expiresAt > now && c.expiresAt - c.createdAt <= 7 * 86_400_000);
      if (c.approve) assert.ok(c.role === "drive" && c.mode === "shared");
    }
  }));
});

// Property: config's extra live view hosts are plain host names (never loopback), and an
// invite base is only such a host's origin.
test("liveViewHosts and inviteBaseUrl from any config: only plain listed hosts", () => {
  const hostish = fc.oneof(anyText, fc.domain(), fc.constantFrom("localhost", "127.0.0.1", "[::1]", "a.ts.net.", "*.x.com", "x.com:80", "http://x.com"));
  check(fc.property(fc.oneof(fc.anything(), fc.array(hostish, { maxLength: 5 })), fc.oneof(anyText, fc.webUrl(), hostish.map((h) => `https://${h}`)), (value, base) => {
    const { hosts } = liveViewHostsFrom(value);
    for (const h of hosts) { assert.match(h, /^[a-z0-9.-]+$/); assert.ok(!["localhost", "127.0.0.1"].includes(h)); }
    const { base: b } = inviteBaseFrom(base, hosts);
    if (b) { const u = new URL(b); assert.equal(b, u.origin); assert.ok(hosts.includes(u.hostname)); }
  }));
});

// Every live view route, built with stand-ins (building one reads none of its parts).
const stub = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : stub), apply: () => stub });
const deps = new Proxy({}, { get: () => stub });
const ROUTES = [createViewerRoutes, createOwnerRoutes, createSessionRoutes, createPagesRoutes, createTimelineRoutes, createToolsRoutes].flatMap((make) => { const r = make(deps); return Array.isArray(r) ? r : r.routes; });
// What a link's guest may reach, written out here: a new route open to them fails this test.
const GUEST = { watch: ["GET ", "GET assets", "GET events", "GET thumb.jpg", "GET state.json"], drive: ["GET ", "GET assets", "GET events", "GET thumb.jpg", "GET state.json", "POST input", "POST tab", "POST pause"] };

// Property: as the live view's server picks (liveview.mjs: the route by method and path, then
// roleMay), a watch or drive link reaches only the routes listed above, whatever the method and
// path; any other role name (approve, owner's lookalikes, Object's own names) reaches nothing.
test("a guest's role reaches only its own routes, whatever the method and path", () => {
  const method = fc.constantFrom("GET", "POST", "DELETE", "PUT", "OPTIONS", "get", "HEAD");
  const route = fc.oneof(fc.constantFrom(...new Set(ROUTES.map((r) => r.path))), anyText);
  check(fc.property(method, route, fc.constantFrom("watch", "drive", "approve", "Owner", "__proto__", "constructor", "hasOwnProperty", "toString", ""), (m, path, role) => {
    const r = ROUTES.find((x) => x.method === m && x.path === path);
    if (!r || !roleMay(role, r.right)) return;
    assert.ok(GUEST[role]?.includes(`${m} ${path}`), `${role} reached ${m} ${path}`);
  }));
  for (const r of ROUTES) assert.ok(roleMay("owner", r.right), `${r.method} ${r.path}: the owner may use every route`);
});
