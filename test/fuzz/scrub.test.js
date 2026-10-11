// Property-based fuzzing of the diagnostics scrub (daemon/diagnostics.mjs): whatever surrounds
// them, the home folder, a key, a full address and a saved secret never survive it.
// Run with: npm ci && npm run test:fuzz
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
