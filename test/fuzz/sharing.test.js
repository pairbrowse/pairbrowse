// Property-based fuzzing of what crosses from a host's browser to the people who join it: names,
// join codes, tab addresses, activity, form values, a drive joiner's changes and the results a
// joiner's agent reads. Each property runs on thousands of generated inputs, attacker-shaped too.
// Run with: npm ci && npm run test:fuzz
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { cleanName, parseJoinCode, encodeJoinCode, createApprovals, stripUrl, stripText } from "../../scripts/join.mjs";
import { shareableUrl, stateForJoiner, readOps, createMirror, createOrderSync, shareFields, readForm, formForJoiner, readPointers, crossingText, TABS_MAX, OPS_MAX, ACTIVITY_MAX, URL_MAX, FIELDS_MAX, VALUE_MAX, POINTER_MAX } from "../../scripts/tabsync.mjs";
import { forJoiner } from "../../scripts/daemon/serve.mjs";
import { guestTabs, guestActivity } from "../../scripts/liveview/tabs.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property) => fc.assert(property, { numRuns: RUNS });

const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
const domain = fc.tuple(label, fc.constantFrom("com", "io", "dev", "example")).map(([a, b]) => `${a}.${b}`).filter((d) => { try { return new URL(`https://${d}`).hostname === d; } catch { return false; } });
const junk = fc.string({ maxLength: 40 });
const anyText = fc.string({ unit: "binary", maxLength: 80 });
// Characters that must never show in a name: controls, bidi and other formatting ones, markup.
const NOT_IN_NAME = /[\p{Cc}\p{Cf}\p{Cs}<>"'`]/u;
const nasty = fc.constantFrom("\u0000", "\u001b", "\u007f", "\u0085", "\u00ad", "\u061c", "\u180e", "\u200b", "\u200d", "\u200e", "\u202e", "\u2066", "\u2069", "\ufeff", "\ufff9", "\u{e0041}", "\ud800", "\udc00", "<", ">", "\"", "'", "`", " ", "\n", "\u2028", "😀", "é");
const nameish = fc.array(fc.oneof(nasty, fc.string({ unit: "grapheme", maxLength: 6 })), { maxLength: 30 }).map((p) => p.join(""));
// A unique marker no generated text holds: where it shows, a secret crossed.
const SECRET = "Zq7SECRETx9";
const pathSeg = fc.oneof(label, fc.constantFrom("tmp", "home", "Users", "private", "var", "Foo_(bar)", "a[1]", "~x", "-", "%20"));
const webUrl = fc.tuple(fc.constantFrom("http", "https"), domain, fc.array(pathSeg, { maxLength: 4 })).map(([s, d, p]) => `${s}://${d}/${p.join("/")}`);
const localUrl = fc.oneof(
  fc.tuple(fc.constantFrom("http://localhost", "http://127.0.0.1", "http://127.1", "http://0x7f.1", "http://2130706433", "http://10.1.2.3", "http://192.168.0.1", "http://172.20.1.1", "http://169.254.1.1",
    "http://0.0.0.0", "http://[::1]", "http://[::ffff:127.0.0.1]", "http://[fe80::1]", "http://router", "http://printer.local", "http://app.localhost", "http://example.com.", "https://a@example.com", "https://a:b@example.com"),
  fc.constantFrom("", ":3000", ":8080"), fc.constantFrom("/", "/x?y=1", "/a#b")).map((p) => p.join("")),
  fc.constantFrom("file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "data:text/html,x", "about:blank", "view-source:https://a.com", "blob:https://a.com/x", "ftp://a.com/"));
const anyUrl = fc.oneof(webUrl, localUrl, junk, fc.webUrl({ withQueryParameters: true, withFragments: true }));
const secretish = fc.constantFrom(`a${SECRET}@b.com`, `eyJ${SECRET}`, `ab12${SECRET}cd34ef56gh78ij90`, `${SECRET}%40x.com`);
// Anything a request body can hold, including objects String() can't convert ({ "toString": "" }).
const json = fc.oneof({ arbitrary: fc.jsonValue({ maxDepth: 3 }), weight: 6 }, { arbitrary: fc.constantFrom('{"toString":""}', '{"toString":1,"valueOf":null}').map((t) => JSON.parse(t)), weight: 1 });

// ---- join.mjs ----

test("a name shown to others has no control, bidi, zero-width or markup characters, at most 40 characters, never empty", () => {
  check(fc.property(fc.oneof(nameish, anyText, json), fc.oneof(fc.constant(undefined), fc.constantFrom("Guest", "Agent", "the host")), (name, fallback) => {
    const out = fallback === undefined ? cleanName(name) : cleanName(name, fallback);
    assert.equal(typeof out, "string");
    assert.ok(out.length > 0 && out.length <= 40, JSON.stringify(out));
    assert.doesNotMatch(out, NOT_IN_NAME, JSON.stringify(out));
    assert.equal(out, out.trim());
  }));
});

const key = fc.stringMatching(/^[0-9a-f]{64}$/);
const tunnel = fc.array(label.filter((l) => !l.includes("-")), { minLength: 1, maxLength: 4 }).map((w) => `https://${w.join("-")}.trycloudflare.com`);
const codeOf = (body) => `pb-join:${Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).toString("base64url")}`;
// Addresses built to look like a Quick Tunnel or a listed host, but not one.
const lookalike = fc.tuple(label, domain).chain(([w, d]) => fc.constantFrom(
  `https://${w}.trycloudflare.com.${d}`, `https://${d}/.trycloudflare.com`, `https://${d}#.trycloudflare.com`, `https://${w}.trycloudflare.com@${d}`,
  `https://${w}.trycloudflare.com:444`, `http://${w}.trycloudflare.com`, `https://${w}trycloudflare.com`, `https://${w}.trycloudflare.com/x`,
  `https://${w}.trycloudflare.com?x`, `https://x${d}`, `https://${d}.evil.io`, `https://${d}:8443`, `http://127.0.0.1:9`, `https://127.0.0.1`, `javascript://${d}`));

function allowedJoin(r, hosts, allowLocal) {
  const u = new URL(r.url);
  if (allowLocal && u.protocol === "http:" && u.hostname === "127.0.0.1") return;
  assert.equal(u.protocol, "https:", r.url);
  assert.equal(u.port, "", r.url);
  assert.ok(/^[a-z0-9]+(-[a-z0-9]+)*\.trycloudflare\.com$/.test(u.hostname) || hosts.includes(u.hostname), r.url);
  assert.equal(r.url, u.origin);
  assert.match(r.key, /^[0-9a-f]{64}$/);
  assert.ok(r.role === "watch" || r.role === "drive");
  assert.ok(r.mode === "shared" || r.mode === "follow");
  assert.doesNotMatch(r.label, NOT_IN_NAME);
}

test("a join code only ever points at a Quick Tunnel or a listed host, and anything else is refused with a plain reason", () => {
  const parse = (code, opts) => { try { return parseJoinCode(code, opts); } catch (e) { assert.ok(e instanceof Error && typeof e.message === "string" && e.message, String(e)); return null; } };
  const opts = fc.record({ hosts: fc.array(domain, { maxLength: 2 }), allowLocal: fc.boolean() });
  check(fc.property(fc.oneof(junk, anyText, json.map((v) => codeOf(v)), fc.string().map((s) => `pb-join:${s}`)), opts, (code, o) => {
    const r = parse(code, o);
    if (r) allowedJoin(r, o.hosts, o.allowLocal);
  }));
  // Well-formed codes whose address is a lookalike (or any address at all), with other fields fuzzed too.
  check(fc.property(fc.oneof(lookalike, tunnel, junk, fc.webUrl()), fc.oneof(key, junk), fc.oneof(fc.constantFrom("watch", "drive"), json), json, opts, (u, k, r, l, o) => {
    const res = parse(codeOf({ v: 1, u, k, r, l, m: "s" }), o);
    if (res) allowedJoin(res, o.hosts, o.allowLocal);
  }));
  // Valid codes, mutated a character at a time.
  check(fc.property(tunnel, key, fc.constantFrom("watch", "drive"), nameish, fc.nat(), fc.string({ minLength: 1, maxLength: 3 }), opts, (u, k, role, name, at, put, o) => {
    const code = encodeJoinCode({ url: u, key: k, role, label: name });
    const ok = parseJoinCode(code);
    assert.equal(ok.url, u);
    assert.equal(ok.key, k);
    const i = at % code.length;
    const r = parse(code.slice(0, i) + put + code.slice(i + 1), o);
    if (r) allowedJoin(r, o.hosts, o.allowLocal);
  }));
});

test("approvals restored from a damaged file never throw and keep only checked entries", () => {
  check(fc.property(fc.oneof(json, fc.array(fc.record({ id: fc.oneof(fc.stringMatching(/^r[0-9a-f]{6}$/), junk), joinerId: fc.oneof(fc.stringMatching(/^[0-9a-f]{32}$/), junk), inviteId: junk, name: fc.oneof(nameish, json), role: json, state: fc.constantFrom("approved", "removed", "pending", "x"), at: json }, { requiredKeys: [] }), { maxLength: 6 })), (list) => {
    const a = createApprovals();
    a.restore(list);
    for (const e of a.list()) {
      assert.ok(e.state === "approved" || e.state === "removed");
      assert.ok(e.role === "watch" || e.role === "drive");
      assert.doesNotMatch(e.name, NOT_IN_NAME);
    }
  }));
});

// Text with an address in it, its query string or fragment holding the marker.
const withQuery = fc.tuple(junk, webUrl, fc.constantFrom("?t=", "?a=(b)&t=", "#", "#/x/", "?q=1#"), fc.constantFrom("", ")", "]", ".", " more", "\nmore", "(x)")).map(([pre, u, q, post]) => `${pre} ${u}${q}${SECRET}${post}`);

test("addresses that invite link guests see carry no query string or fragment", () => {
  check(fc.property(withQuery, (text) => {
    assert.ok(!stripText(text).includes(SECRET), `${JSON.stringify(text)} -> ${JSON.stringify(stripText(text))}`);
  }));
  check(fc.property(fc.oneof(withQuery, withQuery.map((t) => t.trim().split(" ").pop())), (raw) => {
    assert.ok(!stripUrl(raw).includes(SECRET), `${JSON.stringify(raw)} -> ${JSON.stringify(stripUrl(raw))}`);
  }));
});

test("the live view's guests get tabs and activity without query strings or fragments", () => {
  const tab = fc.record({ url: fc.oneof(withQuery.map((t) => t.trim().split(" ").pop()), anyUrl), title: withQuery, last: fc.option(fc.record({ text: withQuery })) });
  check(fc.property(fc.array(tab, { maxLength: 5 }), fc.array(fc.record({ text: withQuery }), { maxLength: 5 }), (tabs, activity) => {
    const seen = JSON.stringify([guestTabs(tabs), guestActivity(activity)]);
    assert.ok(!seen.includes(SECRET), seen);
  }));
});

// ---- tabsync.mjs ----

const isLocal = (url) => { try { const u = new URL(url); return !/^https?:$/.test(u.protocol) || !!u.username || !!u.password || u.hostname.startsWith("[") || !u.hostname.includes(".") || u.hostname.endsWith(".") || /^(127|10|0|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(u.hostname) || /(^|\.)(localhost|local)$/.test(u.hostname); } catch { return true; } };

test("a tab's address crosses only as a public web address, within its size, and without secrets", () => {
  check(fc.property(fc.oneof(anyUrl, localUrl), fc.boolean(), fc.array(domain, { maxLength: 2 }), (raw, full, secretDomains) => {
    const out = shareableUrl(raw, { full, secretDomains });
    if (out === null) return;
    assert.ok(out.length <= URL_MAX);
    assert.equal(isLocal(out), false, `${raw} -> ${out}`);
    assert.equal(shareableUrl(out, { full, secretDomains }), out, "crossing twice changes nothing");
    const host = new URL(out).hostname;
    if (!full || secretDomains.some((d) => host === d || host.endsWith(`.${d}`))) assert.doesNotMatch(out, /[?#]/);
  }));
  check(fc.property(localUrl, fc.boolean(), (raw, full) => assert.equal(shareableUrl(raw, { full }), null, raw)));
  // Sign-in links, one-time codes and personal details stay home, even in a drive session.
  const name = fc.constantFrom("token", "access_token", "code", "password", "sid", "state", "email", "phone", "reset", "magic_link", "signature", "otp", "apikey", "SessionId");
  check(fc.property(webUrl, fc.array(fc.tuple(label, label), { maxLength: 3 }), fc.oneof(fc.tuple(name, label.map((v) => `${v}${SECRET}`)), fc.tuple(label, secretish)), fc.nat(3), (u, plain, bad, at) => {
    const params = [...plain]; params.splice(at % (plain.length + 1), 0, bad);
    const raw = `${u}?${new URLSearchParams(params)}`;
    const out = shareableUrl(raw, { full: true });
    assert.ok(out === null || !decodeURIComponent(out).includes(SECRET), `${raw} -> ${out}`);
    assert.ok(out === null || !shareableUrl(`${u}#${bad[1]}`, { full: true }).includes(SECRET));
  }));
});

const tabId = fc.stringMatching(/^[0-9a-f]{8}$/);
const hostTab = fc.record({ id: tabId, url: anyUrl, title: fc.oneof(withQuery, anyText), agent: fc.oneof(fc.constant(""), nameish), color: fc.oneof(fc.constant("#aabbcc"), junk), left: json, person: fc.oneof(fc.constant(""), nameish), acting: fc.boolean(),
  did: fc.array(fc.record({ n: json, who: nameish, line: fc.oneof(withQuery, anyText) }), { maxLength: 12 }) }, { requiredKeys: ["id", "url"] });

test("a joiner gets only shareable tabs, nothing but the address on secret domains, and no more than the limits", () => {
  check(fc.property(fc.array(hostTab, { maxLength: 50 }), fc.array(fc.record({ t: json, text: fc.oneof(withQuery, anyText), who: nameish, tabId: fc.oneof(tabId, fc.constant(undefined)), from: fc.constantFrom("", "j1", "j2") }), { maxLength: 20 }),
    fc.array(fc.oneof(nameish, json), { maxLength: 25 }), fc.boolean(), fc.array(domain, { maxLength: 2 }), fc.constantFrom("", "Bob"), fc.constantFrom("", "j1"), (tabs, activity, people, drive, secretDomains, name, from) => {
      const out = stateForJoiner({ tabs, activity, people }, { drive, secretDomains, name, from });
      assert.ok(out.tabs.length <= TABS_MAX && out.activity.length <= ACTIVITY_MAX && out.people.length <= 20);
      const crossing = new Set();
      for (const t of out.tabs) {
        const src = tabs.find((x) => x.id === t.id && shareableUrl(x.url, { full: drive, secretDomains }) === t.url);
        assert.ok(src, `${t.url} came from no tab`);
        assert.equal(isLocal(t.url), false);
        const host = new URL(t.url).hostname;
        if (secretDomains.some((d) => host === d || host.endsWith(`.${d}`))) assert.deepEqual(Object.keys(t), ["id", "url"]);
        else crossing.add(t.id);
        assert.ok((t.title ?? "").length <= 200 && !String(t.title ?? "").includes(SECRET));
        for (const d of t.did || []) { assert.ok(d.who !== name || !name); assert.ok(!d.line.includes(SECRET) && d.line.length <= 80); }
        if (t.person) assert.notEqual(t.person, name);
      }
      for (const a of out.activity) {
        assert.ok(!a.tabId || crossing.has(a.tabId), "activity in a tab that doesn't cross");
        assert.ok(!a.text.includes(SECRET) && a.text.length <= 200);
      }
      if (from) assert.ok(out.activity.length <= activity.filter((a) => a.from !== from).length);
      for (const p of out.people) assert.ok(p.length <= 60 && (!name || p !== name));
    }));
});

test("a drive joiner's changes are checked: malformed ones are refused, never thrown, and accepted ones are safe", () => {
  const ids = new Set(["aaaaaaaa", "bbbbbbbb"]);
  const known = fc.constantFrom("aaaaaaaa", "bbbbbbbb", "cccccccc");
  const op = fc.oneof(json, fc.record({ op: fc.constantFrom("close", "person", "activity", "agent", "order", "form", "navigate", "open", "x"), id: fc.oneof(known, json), ids: fc.oneof(fc.array(known), json),
    url: fc.oneof(anyUrl, localUrl, json), ref: fc.oneof(fc.stringMatching(/^[a-z0-9]{1,16}$/), json, fc.constant(["n1"])), text: fc.oneof(withQuery, json), who: fc.oneof(nameish, json), did: fc.oneof(fc.array(fc.oneof(withQuery, json)), json),
    color: json, left: json, acting: json, fields: fc.oneof(json, fc.array(fc.record({ k: junk, f: junk, t: fc.constantFrom("text", "password", "select", "checkbox", "x"), v: json, m: json, filled: json }))) }, { requiredKeys: ["op"] }));
  check(fc.property(fc.oneof(json, fc.record({ ops: fc.oneof(fc.array(op, { maxLength: OPS_MAX + 3 }), json) })), (body) => {
    const r = readOps(body, ids);
    if (r.problem) { assert.equal(typeof r.problem, "string"); return; }
    assert.ok(r.ops.length <= OPS_MAX);
    for (const o of r.ops) {
      if (o.id !== undefined) assert.ok(ids.has(o.id));
      if (o.op === "navigate" || o.op === "open") { assert.equal(shareableUrl(o.url, { full: true }), o.url); assert.equal(isLocal(o.url), false); }
      if (o.op === "open") assert.ok(typeof o.ref === "string" && /^[a-z0-9]{1,16}$/.test(o.ref), JSON.stringify(o.ref));
      if (o.op === "order") assert.ok(o.ids.every((id) => ids.has(id)) && o.ids.length <= TABS_MAX);
      if (o.op === "person") assert.ok(o.did.length <= 10 && o.did.every((d) => typeof d === "string" && d.length <= 80));
      if (o.op === "activity") assert.ok(!o.text.includes(SECRET));
      if (o.op === "form") for (const f of o.fields) assert.ok(f.m ? !("v" in f) : f.t !== "password");
    }
  }));
});

test("a joiner's browser takes from the host only checked tabs, whatever the host sends", () => {
  check(fc.property(fc.oneof(json, fc.array(fc.oneof(json, fc.record({ id: fc.oneof(tabId, json), url: fc.oneof(anyUrl, localUrl, json) })), { maxLength: TABS_MAX + 5 })), fc.array(fc.oneof(tabId, json), { maxLength: 5 }), (tabs, order) => {
    const plan = createMirror().fromHost(tabs, new Set());
    for (const t of [...plan.open, ...plan.navigate]) { assert.match(t.id, /^[0-9a-f]{8}$/); assert.equal(isLocal(t.url), false); }
    assert.ok(plan.open.length <= TABS_MAX);
    createOrderSync().fromHost(order);
  }));
});

// A Luhn-valid card number, with or without separators.
const card = fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 15, maxLength: 15 }).map((d) => {
  const sum = d.reduce((s, x, i) => { let v = x; if (i % 2 === 0) { v *= 2; if (v > 9) v -= 9; } return s + v; }, 0);
  return [...d, (10 - (sum % 10)) % 10].join("");
}).chain((n) => fc.constantFrom(n, n.replace(/(\d{4})(?=\d)/g, "$1 "), n.replace(/(\d{4})(?=\d)/g, "$1-")));
const field = fc.record({ k: fc.oneof(label, junk), f: fc.constantFrom("", "top"), t: fc.constantFrom("text", "email", "textarea", "select", "checkbox", "password", "number", ""),
  hints: fc.oneof(fc.constant(""), fc.constantFrom("password", "cc-number", "one-time-code", "card number", "Your name")), v: fc.oneof(anyText, card, card.map((c) => `pay ${c} now`), fc.constant(`pw:${SECRET}`), fc.array(anyText, { maxLength: 3 }), fc.string({ maxLength: 1500 }), json), o: fc.oneof(fc.constant(undefined), nameish) }, { requiredKeys: ["k"] });

test("form values cross within their limits, and sensitive ones only as filled or empty", () => {
  check(fc.property(fc.array(field, { maxLength: FIELDS_MAX + 20 }), (list) => {
    const raw = list.map((x, i) => ({ ...x, k: `k${i}` }));
    const out = shareFields(raw, { secretValues: [SECRET] });
    assert.ok(out.length <= FIELDS_MAX);
    for (const x of raw) if (x.t === "password" || /password|cc-|one-time|card/.test(x.hints || "")) assert.ok(!out.some((f) => f.k === x.k && "v" in f), `${x.t} ${x.hints} crossed with its value`);
    for (const f of out) {
      if (f.m) { assert.ok(!("v" in f)); continue; }
      const vals = Array.isArray(f.v) ? f.v : [f.v];
      for (const v of vals) if (typeof v === "string") { assert.ok(v.length <= VALUE_MAX && !v.includes(SECRET)); assert.doesNotMatch(v.replace(/[\s-]/g, ""), /^\d{16}$/); }
    }
  }));
});

test("a joiner gets a tab's form values only for a tab that fully crosses, only for its page, and never a sensitive value", () => {
  check(fc.property(fc.oneof(anyUrl, localUrl), fc.oneof(anyUrl, json), fc.array(field, { maxLength: 8 }), fc.array(domain, { maxLength: 2 }), fc.boolean(), (tabUrl, formUrl, fields, secretDomains, same) => {
    const form = { url: same ? tabUrl : formUrl, fields: shareFields(fields, { secretValues: [SECRET] }) };
    const out = formForJoiner(tabUrl, form, { secretDomains });
    if (!out) return;
    const tab = shareableUrl(tabUrl, { secretDomains });
    assert.ok(tab && !isLocal(tab));
    const host = new URL(tab).hostname;
    assert.ok(!secretDomains.some((d) => host === d || host.endsWith(`.${d}`)));
    assert.equal(new URL(out.url).origin + new URL(out.url).pathname, tab);
    assert.ok(out.fields.length <= FIELDS_MAX && !JSON.stringify(out.fields).includes(SECRET));
  }));
  // From the other side: anything at all is a form or null, never a throw.
  check(fc.property(fc.oneof(json, fc.record({ url: anyUrl, fields: fc.oneof(json, fc.array(field, { maxLength: FIELDS_MAX + 5 })) })), (o) => {
    const r = readForm(o);
    if (!r) return;
    assert.ok(r.fields.length <= FIELDS_MAX);
    for (const f of r.fields) {
      if (f.m || f.t === "password") { assert.ok(f.m && !("v" in f)); continue; }
      for (const v of Array.isArray(f.v) ? f.v : [f.v]) if (typeof v === "string") { assert.ok(v.length <= VALUE_MAX); assert.doesNotMatch(v.replace(/[\s-]/g, ""), /^\d{16}$/); }
    }
  }));
});

test("pointers from a joiner are a known tab and a clamped position, whatever they send", () => {
  const ids = new Set(["aaaaaaaa"]);
  const p = fc.oneof(json, fc.record({ id: fc.constantFrom("aaaaaaaa", "bbbbbbbb"), x: json, y: json, h: json, who: fc.oneof(nameish, json), color: json }));
  check(fc.property(fc.record({ me: p, view: p, agents: fc.oneof(json, fc.array(p, { maxLength: 12 })) }, { requiredKeys: [] }), (body) => {
    const r = readPointers(body, ids);
    assert.ok(r.agents.length <= 8);
    for (const x of [r.me, r.view, ...r.agents].filter(Boolean)) {
      assert.ok(ids.has(x.id) && x.x >= 0 && x.x <= POINTER_MAX && x.y >= 0 && x.y <= POINTER_MAX);
      if (x.color !== undefined) assert.match(x.color, /^#[0-9a-f]{6}$/i);
    }
  }));
});

test("what someone did, as it crosses, names no local address and no query string", () => {
  const local = fc.constantFrom("http://192.168.1.4/admin", "http://localhost:3000/x", "http://router/", "http://[::1]:8080/a", "http://10.0.0.7/");
  check(fc.property(junk, fc.oneof(local, withQuery), junk, (a, u, b) => {
    const out = crossingText(`${a} ${u} ${b}`);
    assert.ok(!out.includes(SECRET), out);
    assert.ok(!/192\.168\.1\.4|localhost:3000|\/\/router|\[::1\]|10\.0\.0\.7/.test(out) || /192\.168\.1\.4|localhost:3000|\/\/router|\[::1\]|10\.0\.0\.7/.test(a + b), out);
  }));
});

// ---- daemon/serve.mjs ----

const user = fc.stringMatching(/^[a-z]{3,8}$/).map((u) => `zq${u}`);
const folderPath = fc.tuple(user, fc.array(label, { minLength: 1, maxLength: 3 }), fc.constantFrom("/Users/@/", "/home/@/", "/root/@/", "/tmp/@/", "/private/tmp/@/", "/var/folders/@/", "/Volumes/@/", "C:\\Users\\@\\", "file:///Users/@/"))
  .map(([u, segs, root]) => { const sep = root.includes("\\") ? "\\" : "/"; return { u, segs, path: `${root.replace("@", u)}${segs.join(sep)}` }; });

test("a joiner's agent's results name no folder on the host's computer, and web addresses stay whole", () => {
  check(fc.property(fc.array(fc.tuple(fc.constantFrom(" ", "\n", "(", "[x](", "\"", "at ", "dir=", ": "), folderPath, fc.constantFrom(" ", ")", ".", ",", "\"", "\n")), { minLength: 1, maxLength: 3 }), (parts) => {
    const text = parts.map(([a, p, b]) => `${a}${p.path}${b}`).join("");
    const homes = [`/Users/${parts[0][1].u}`, `/home/${parts[0][1].u}`, "/tmp"];
    const out = forJoiner(text, homes);
    for (const [, p] of parts) {
      // The account name never shows as a word of its own ("zqab" may still be part of "zqabc",
      // a folder kept under the home "/tmp", or a folder another path keeps).
      const kept = parts.some(([, x]) => x.segs.includes(p.u) || (x.path.startsWith("/tmp/") && x.u === p.u));
      if (!p.path.startsWith("/tmp/") && !kept) assert.doesNotMatch(out, new RegExp(`(?<![\\w-])${p.u}(?![\\w-])`), `${JSON.stringify(text)} -> ${JSON.stringify(out)}`);
      // Under a home: "~/" and the folders below it; elsewhere the name only.
      if (!homes.some((h) => p.path.includes(`${h}/`))) for (const s of p.segs.slice(0, -1).filter((s) => !parts.some(([, x]) => x !== p && x.segs.includes(s)))) assert.ok(!out.includes(`/${s}/`) && !out.includes(`\\${s}\\`), `${s} in ${JSON.stringify(out)}`);
    }
  }));
  // Web addresses stay whole: their own paths, and values that name no home of this computer.
  const query = fc.tuple(label, fc.array(pathSeg.filter((s) => s !== "tmp"), { minLength: 1, maxLength: 3 })).map(([k, s]) => `?${k}=/${s.join("/")}`);
  check(fc.property(webUrl, fc.oneof(fc.constant(""), query), fc.constantFrom("", "[a](", "see ", "("), fc.constantFrom("", ")", " ok"), user, (u, q, a, b, who) => {
    const url = `${u}${q}`;
    const out = forJoiner(`${a}${url}${b}`, [`/Users/${who}`, `/home/${who}`, "/tmp"]);
    assert.ok(out.includes(url), `${url} -> ${out}`);
  }));
  // A home of this computer inside a web address (a query value, plain or percent-encoded): hidden
  // as "~", and the rest of the address stays as it was.
  check(fc.property(webUrl, label, fc.constantFrom("/Users/@", "/home/@", "/tmp"), fc.array(label, { maxLength: 2 }), fc.boolean(), fc.constantFrom("", "&x=1", "#top"), user, (u, k, home, rest, encode, tail, who) => {
    const value = [home.replace("@", who), ...rest].join("/");
    const url = `${u}?${k}=${encode ? value.replace(/\//g, "%2F") : value}${tail}`;
    const out = forJoiner(`see ${url} ok`, [`/Users/${who}`, `/home/${who}`, "/tmp"]);
    assert.equal(out, `see ${u}?${k}=${["~", ...rest].join(encode ? "%2F" : "/")}${tail} ok`);
    if (!u.includes(who)) assert.doesNotMatch(out, new RegExp(`(?<![\\w-])${who}(?![\\w-])`));
  }));
});
