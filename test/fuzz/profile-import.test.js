// Property-based fuzzing of a browser profile import (scripts/profiles/import.mjs checkImport, spec
// server-mode D15, D16): whatever the bytes, nothing throws; the file is either refused at one of
// the named checks, with a problem naming that check and repeating no string from the file, or
// yields settings that make a valid profile record (profiles/schema.mjs checkProfile) with a
// provenance entry holding the file's SHA-256 and no device hardware. Checking reads no file at
// all: every file system read is made to throw while it runs. Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import fc from "fast-check";
import { checkImport, exportSha256, IMPORT_CHECKS } from "../../scripts/profiles/import.mjs";
import { exportProfile } from "../../scripts/profiles/export.mjs";
import { checkProfile, SETTINGS } from "../../scripts/profiles/schema.mjs";
import { sha256 } from "../../scripts/util.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property, runs = RUNS) => fc.assert(property, { numRuns: runs });
const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/profiles/${name}`, import.meta.url), "utf8"));
const DEVICE = fixture("engine-device-1.json");
const PERSONA = fixture("engine-persona.json");
const RECORD = fixture("record-1.json");
const AT = "2026-10-21T10:00:00Z";
// A marker string: if it ever shows up in a refusal, a string from the file was repeated.
const MARK = "zq-marker-91";

// Every file system read throws while fn runs (the ESM bindings follow through syncBuiltinESMExports).
function withoutFiles(fn) {
  const names = ["openSync", "readFileSync", "readSync", "fstatSync", "statSync", "lstatSync", "readdirSync", "existsSync", "opendirSync", "readlinkSync", "realpathSync"];
  const saved = Object.fromEntries(names.map((n) => [n, fs[n]]));
  for (const n of names) fs[n] = () => { throw new Error(`a file was read: ${n}`); };
  syncBuiltinESMExports();
  try { return fn(); } finally { Object.assign(fs, saved); syncBuiltinESMExports(); }
}

const key = fc.oneof(fc.constantFrom("screen", "navigator", "intl", "options", "format", "profile", "webgl", "proxy", "__proto__", "constructor", "meta",
  "width", "height", "avail_width", "device_pixel_ratio", "languages", "timeZone", "timezone", "acceptLanguage", "fingerprint", "screenWidth", "canvasBridge", "schema_version"), fc.string({ maxLength: 8 }));
const leaf = fc.oneof(fc.integer({ min: -5, max: 20000 }), fc.double({ noNaN: false }), fc.boolean(), fc.constant(null), fc.constantFrom("de-DE", "Europe/Berlin", "off", MARK, "1920"), fc.string({ maxLength: 10 }));
const value = fc.letrec((tie) => ({
  v: fc.oneof({ depthSize: "small" }, leaf, fc.array(tie("v"), { maxLength: 4 }), fc.dictionary(key, tie("v"), { maxKeys: 5 })),
})).v;
// Mutations of real-shaped files, so the yes path is tried as often as the no.
const mutate = (base) => fc.tuple(fc.array(fc.tuple(fc.array(key, { minLength: 1, maxLength: 3 }), value), { maxLength: 3 })).map(([edits]) => {
  const o = structuredClone(base);
  // Own properties only (a "__proto__" key is written as one, as JSON.parse makes it).
  const put = (at, k, v) => Object.defineProperty(at, k, { value: v, enumerable: true, writable: true, configurable: true });
  for (const [path, v] of edits) {
    let at = o;
    for (const k of path.slice(0, -1)) { if (!Object.hasOwn(at, k) || !at[k] || typeof at[k] !== "object") put(at, k, {}); at = at[k]; }
    put(at, path[path.length - 1], v);
  }
  return o;
});
const exported = exportProfile(RECORD, { at: AT }).file;
const sealed = mutate(exported).map((f) => (f && typeof f === "object" && !Array.isArray(f) ? { ...f, sha256: exportSha256(f) } : f));
const text = fc.oneof(
  value.map((v) => JSON.stringify(v) ?? ""), mutate(DEVICE).map((v) => JSON.stringify(v)), mutate(PERSONA).map((v) => JSON.stringify(v)),
  sealed.map((v) => JSON.stringify(v)), fc.constant(JSON.stringify(DEVICE)), fc.constant(JSON.stringify(PERSONA)), fc.string({ maxLength: 40 }),
);
const host = fc.record({ source: fc.oneof(fc.constant("my laptop"), fc.string({ maxLength: 12 }), fc.constant(undefined)),
  license: fc.oneof(fc.constantFrom("own-capture", "MIT", "unknown", "GPL-3.0-only", "x y"), fc.constant(undefined)) });

test("any JSON is refused with a named check or yields a valid profile; never reads a second file", () => {
  check(fc.property(text, host, (t, h) => {
    const r = withoutFiles(() => checkImport(t, { file: "fuzz.json", at: AT, ...h }));
    if (!r.ok) {
      assert.ok(IMPORT_CHECKS.includes(r.refused.check), r.refused.check);
      assert.match(r.problem, new RegExp(`^Import of "fuzz\\.json" refused at the ${r.refused.check} check: `));
      assert.ok(!r.problem.includes(MARK), r.problem);
      assert.ok(r.items.every((i) => i.requested === null), "a refusal repeats no value");
      return;
    }
    const record = { schema: 1, id: "p-0123456789abcdef", name: r.name, kind: "store", revision: 1, status: "active", created: AT, engine: null,
      ...r.settings, license: r.license, provenance: r.provenance, validation: {}, history: [] };
    assert.deepEqual(checkProfile(record).problems, []);
    assert.deepEqual(Object.keys(r.settings).sort(), [...SETTINGS].sort());
    assert.equal(r.provenance.at(-1).sha256, sha256(Buffer.from(t, "utf8")));
    assert.equal(r.settings.network, null, "a network is never imported");
    // Hardware never reaches the settings, whatever the file said.
    assert.doesNotMatch(JSON.stringify(r.settings), /"(?:gpuVendor|gpuRenderer|hardwareConcurrency|deviceMemory|maxTouchPoints|platform|fonts|proxy|canvasBridge)":/);
  }), RUNS);
});
