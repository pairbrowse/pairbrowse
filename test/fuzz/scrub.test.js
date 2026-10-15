// Property-based fuzzing of the diagnostics scrub (daemon/diagnostics.mjs): whatever surrounds
// them, the home folder, a key, a full address and a saved secret never survive it.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { scrub } from "../../scripts/daemon/diagnostics.mjs";

const HOME = "/Users/fuzzhome";
const KEY = "Qw3rTy_uIoP-aSdFgHjKl0zXcVbNm9876543210abcd"; // 43 base64url characters
const URL_WITH_PATH = "https://bank.example/account/42?session=abc";
const SECRET = "Tr0ub4dor&3";
const mask = (t) => t.split(SECRET).join("••••");

test("scrub never lets the home path, a key, a secret or an address's path through", () => {
  assert.equal(KEY.length, 43);
  const piece = fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom(HOME, `${HOME}/Downloads/tax.pdf`, `${HOME}/.pairbrowse/log`, KEY, URL_WITH_PATH, SECRET, " ", "\"", "/", ":", "~", "=", "key=", "@"));
  fc.assert(fc.property(fc.array(piece, { minLength: 1, maxLength: 12 }), (parts) => {
    const out = scrub(parts.join(""), { home: HOME, mask });
    assert.ok(!out.includes(HOME), out);
    assert.ok(!out.includes(KEY), out);
    assert.ok(!out.includes(SECRET), out);
    assert.ok(!/:\/\/[^\s/]*\//.test(out), out);
    assert.ok(out.length <= 200);
  }), { numRuns: 3000 });
});

// Report a problem (liveview/report.mjs): whatever the person typed or the diagnostics carry, the
// report that leaves holds no home path, key or saved secret, no query or fragment, and the
// diagnostics no address beyond a host.
test("a report leaves without the home path, a key, a secret, a query or a fragment", async () => {
  const { readReport, scrubReport } = await import("../../scripts/liveview/report.mjs");
  const piece = fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom(HOME, `${HOME}/Downloads/tax.pdf`, KEY, URL_WITH_PATH, `${URL_WITH_PATH}#frag`, SECRET, " ", "\n", "\"", "/", ":", "?", "#", "key=", "@"));
  const text = fc.array(piece, { minLength: 1, maxLength: 12 }).map((p) => `x${p.join("")}`);
  fc.assert(fc.property(text, text, (what, diagnostics) => {
    const r = readReport({ schema: "pairbrowse-report/1", createdAt: "2026-10-13T09:10:45.473Z", what: what.slice(0, 4000),
      app: { host: "pairbrowse", page: "settings", helper: null, browser: { engine: null, version: null, build: null } },
      platform: { os: "macOS", mobile: false, language: "en" },
      helperState: { connection: "live", uptime: 1, agents: 0, viewers: 0, joiners: 0, streams: 1, errors: 0 },
      diagnostics, tab: { url: `${URL_WITH_PATH}#frag` } });
    assert.ok(r.report, r.error);
    const out = scrubReport(r.report, { home: HOME, mask });
    const all = JSON.stringify(out);
    for (const bad of [HOME, KEY, SECRET, "session=abc", "#frag"]) assert.ok(!all.includes(bad), `${bad} in ${all}`);
    assert.ok(!/:\/\/[^\s/]*\//.test(out.diagnostics), out.diagnostics);
    assert.equal(out.tab.url, "https://bank.example/account/42");
  }), { numRuns: 2000 });
});
