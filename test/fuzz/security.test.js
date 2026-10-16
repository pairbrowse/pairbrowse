// Property-based fuzzing of the checks PairBrowse's security rests on: where a password may be
// typed, what gets masked, which addresses the browser opens and who reaches the live view.
// Each property runs on thousands of generated inputs, including attacker-shaped ones.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { hostAllowed, redact } from "../../scripts/rules/secrets.mjs";
import { navigationProblem, isBrowserPage } from "../../scripts/rules/policy.mjs";
import { hideBrowserTabs } from "../../scripts/daemon/output.mjs";
import { hostOk, originOk, keyOk } from "../../scripts/liveview/http.mjs";
import { addressToUrl } from "../../ui/urls.js";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property) => fc.assert(property, { numRuns: RUNS });

const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
// Hostnames as a URL keeps them (not "xn--" labels that aren't valid punycode: no URL parses those).
const domain = fc.tuple(label, fc.constantFrom("com", "io", "dev", "example")).map(([a, b]) => `${a}.${b}`).filter((d) => { try { return new URL(`https://${d}`).hostname === d; } catch { return false; } });
const junk = fc.string({ maxLength: 40 });

test("a password goes only to its own domain or a subdomain, and only over https", () => {
  check(fc.property(junk, domain, (url, d) => {
    if (!hostAllowed(url, [d])) return;
    const u = new URL(url);
    assert.equal(u.protocol, "https:");
    assert.ok(u.hostname === d || u.hostname.endsWith(`.${d}`), `${url} passed for ${d}`);
  }));
  // Addresses built to look like the allowed domain.
  check(fc.property(domain, domain, fc.constantFrom("", "/login", ":443/x", "?next=/"), (d, evil, rest) => {
    fc.pre(evil !== d && !evil.endsWith(`.${d}`));
    for (const url of [
      `https://${d}.${evil}${rest}`, `https://${evil}${rest}#${d}`, `https://${d}@${evil}${rest}`,
      `https://x${d}${rest}`, `https://${evil}/${d}`, `http://${d}${rest}`, `https://${evil}?${d}`,
    ]) assert.equal(hostAllowed(url, [d]), false, url);
    assert.equal(hostAllowed(`https://${d}${rest}`, [d]), true);
    assert.equal(hostAllowed(`https://login.${d}${rest}`, [d]), true);
  }));
});

test("a masked text never shows a password", () => {
  const name = fc.stringMatching(/^[A-Z][A-Z_]{1,8}$/);
  const value = fc.stringMatching(/^[0-9!#$%&*+=?@^~]{4,16}$/);
  check(fc.property(fc.dictionary(name, value, { minKeys: 1, maxKeys: 4 }), fc.array(fc.string({ maxLength: 12 }), { maxLength: 6 }), (values, parts) => {
    const secrets = Object.values(values);
    const text = parts.flatMap((p, i) => [p, secrets[i % secrets.length]]).join("");
    const out = redact(text, values);
    for (const v of secrets) assert.ok(!out.includes(v), `${JSON.stringify(v)} shows in ${JSON.stringify(out)}`);
  }));
});

test("the browser opens only web pages", () => {
  check(fc.property(junk, (url) => {
    if (navigationProblem(url) !== null) return;
    const u = new URL(url);
    assert.ok(u.protocol === "http:" || u.protocol === "https:" || u.href === "about:blank", url);
  }));
  const scheme = fc.constantFrom("javascript", "JaVaScRiPt", "file", "data", "chrome", "chrome-extension", "blob", "view-source", "devtools");
  check(fc.property(fc.constantFrom("", " ", "\t", "\n"), scheme, junk, (lead, s, rest) => {
    assert.notEqual(navigationProblem(`${lead}${s}:${rest}`), null, `${s}:${rest}`);
  }));
  // The browser's own pages: refused with the sentence naming their rule, in any case and form.
  const own = fc.constantFrom("pairbrowse", "PairBrowse", "pairbrowse.top-chrome", "PAIRBROWSE.TOP-CHROME");
  check(fc.property(fc.constantFrom("", " ", "\t"), own, fc.constantFrom("", "/", "/picker", "/strip?x=1", "#frag"), junk, (lead, host, sep, rest) => {
    const url = `${lead}chrome://${host}${sep}${sep ? rest : ""}`;
    if (isBrowserPage(url)) assert.match(navigationProblem(url), /browser's own/, url);
  }));
  check(fc.property(fc.oneof(junk, fc.tuple(own, junk).map(([h, r]) => `chrome://${h}${r}`)), (url) => {
    if (isBrowserPage(url)) assert.match(navigationProblem(url), /browser's own/, url);
  }));
});

test("browser_tabs never lists the browser's own pages and keeps every other tab's number", () => {
  const url = fc.oneof(
    domain.map((d) => `https://${d}/`),
    domain.map((d) => `http://${d}/x`),
    fc.constantFrom("/picker", "/", "/settings?x=1").map((p) => `chrome://pairbrowse${p}`),
    fc.constantFrom("/strip", "/dock").map((p) => `chrome://pairbrowse.top-chrome${p}`),
  );
  check(fc.property(fc.array(fc.tuple(url, fc.stringMatching(/^[A-Za-z ]{0,12}$/)), { maxLength: 8 }), (tabs) => {
    const lines = tabs.map(([u, t], i) => `- ${i}: [${t}](${u})`);
    const out = hideBrowserTabs(`### Result\n${lines.map((l) => `${l}\n`).join("")}`);
    const kept = lines.filter((_, i) => !isBrowserPage(tabs[i][0]));
    assert.equal(out, `### Result\n${kept.map((l) => `${l}\n`).join("")}`);
  }));
});

test("an address typed without a scheme opens as a web page or a search", () => {
  check(fc.property(fc.string({ maxLength: 60 }).filter((t) => !t.includes(":")), (text) => {
    const url = addressToUrl(text);
    assert.ok(url === null || /^https?:\/\//.test(url), `${JSON.stringify(text)} became ${url}`);
  }));
});

test("the live view answers only on this computer, to its own pages, with the right key", () => {
  const loop = fc.constantFrom("127.0.0.1", "localhost", "[::1]");
  // Lookalikes: a loopback name with more after it (another host, a user part, a path).
  const lookalike = fc.tuple(fc.constantFrom("http://", "https://", "ws://", ""), loop, fc.string({ minLength: 1, maxLength: 30 })).map((p) => p.join(""));
  check(fc.property(loop, fc.string({ minLength: 1, maxLength: 30 }), (h, rest) => {
    fc.pre(!/^:\d{1,5}$/.test(rest));
    assert.equal(hostOk(`${h}${rest}`), false, `${h}${rest}`);
  }));
  check(fc.property(fc.oneof(junk, lookalike), (host) => {
    if (!hostOk(host)) return;
    assert.match(host.toLowerCase(), /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/);
  }));
  check(fc.property(fc.oneof(junk, lookalike).filter(Boolean), (origin) => {
    if (!originOk(origin)) return;
    const u = new URL(origin);
    assert.equal(u.protocol, "http:");
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(u.hostname), origin);
  }));
  check(fc.property(fc.string({ minLength: 1, maxLength: 64 }), fc.string({ maxLength: 64 }), (key, given) => {
    assert.equal(keyOk(given, key), Buffer.from(given).equals(Buffer.from(key)));
    assert.equal(keyOk(key, key), true);
  }));
});

// What an agent's MCP connection sends goes on to the browser server only as a well-formed
// JSON-RPC 2.0 message with the fields it knows; anything else is refused here (null), so a
// message the server would leave unanswered never holds the shared queue.
test("wellFormed: only well-formed JSON-RPC 2.0 messages, only known fields", async () => {
  const { wellFormed } = await import("../../scripts/daemon/serve/wire.mjs");
  check(fc.property(fc.anything(), (msg) => {
    const out = wellFormed(msg);
    if (out === null) return;
    assert.equal(out.jsonrpc, "2.0");
    for (const k of Object.keys(out)) assert.ok(["jsonrpc", "id", "method", "params", "result", "error"].includes(k), k);
    if ("id" in out) assert.ok(typeof out.id === "string" || typeof out.id === "number");
    if ("method" in out) assert.equal(typeof out.method, "string");
    if ("params" in out) assert.ok(out.params && typeof out.params === "object" && !Array.isArray(out.params));
    if (out.params?._meta?.progressToken !== undefined) assert.ok(["string", "number"].includes(typeof out.params._meta.progressToken));
    if ("error" in out) assert.ok(Number.isInteger(out.error.code) && typeof out.error.message === "string");
  }));
  assert.equal(wellFormed({ jsonrpc: "1.0", id: 1, method: "x" }), null);
  assert.equal(wellFormed({ jsonrpc: "2.0", id: { a: 1 }, method: "x" }), null, "an object id");
  assert.equal(wellFormed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: [] }), null, "params not an object");
  assert.deepEqual(wellFormed({ jsonrpc: "2.0", id: 1, method: "m", extra: 1 }), { jsonrpc: "2.0", id: 1, method: "m" }, "an unknown field dropped");
  assert.deepEqual(wellFormed({ jsonrpc: "2.0", id: 2, method: "m", params: { _meta: { progressToken: {} } } }), { jsonrpc: "2.0", id: 2, method: "m", params: { _meta: {} } });
  assert.deepEqual(wellFormed({ jsonrpc: "2.0", id: 3, error: "boom" }), { jsonrpc: "2.0", id: 3, error: { code: -32603, message: "Malformed error" } });
  assert.equal(wellFormed(null), null);
});
