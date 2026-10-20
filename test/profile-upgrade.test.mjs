// Older profile records and exports brought up to this PairBrowse's versions (spec server-mode
// D19, scripts/profiles/upgrade.mjs): a pure chain of one step per version, history kept and one
// entry added, a newer version refused and never rewritten, and no gap in the chain.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { upgradeProfile, upgradeExport, chainGaps, RECORD_STEPS, EXPORT_STEPS } from "../scripts/profiles/upgrade.mjs";
import { SCHEMA_VERSION, FORMAT_VERSION, checkProfile } from "../scripts/profiles/schema.mjs";

const RECORD = JSON.parse(readFileSync(new URL("./fixtures/profiles/record-1.json", import.meta.url), "utf8"));
const AT = "2026-10-21T08:00:00Z";

test("the chain has no gap: every version below the current one has its step", () => {
  assert.deepEqual(chainGaps(RECORD_STEPS, SCHEMA_VERSION), []);
  assert.deepEqual(chainGaps(EXPORT_STEPS, FORMAT_VERSION), []);
  // Steps start at 1 (the first schema); nothing else is in the chains.
  for (const steps of [RECORD_STEPS, EXPORT_STEPS]) for (const k of Object.keys(steps)) assert.ok(Number(k) >= 1, k);
  assert.ok(Object.keys(RECORD_STEPS).every((k) => Number(k) < SCHEMA_VERSION));
  assert.ok(Object.keys(EXPORT_STEPS).every((k) => Number(k) < FORMAT_VERSION));
  assert.ok(Object.isFrozen(RECORD_STEPS) && Object.isFrozen(EXPORT_STEPS));
  // A gap is named.
  assert.deepEqual(chainGaps({ 1: (r) => r, 3: (r) => r }, 5), [2, 4]);
});

test("a current record is checked as it is, unchanged", () => {
  const r = upgradeProfile(RECORD, { at: AT });
  assert.deepEqual(r.problems, []);
  assert.equal(r.from, 1);
  assert.equal(r.upgraded, false);
  assert.deepEqual(r.profile, RECORD);
  const bad = upgradeProfile({ ...RECORD, status: "gone" }, { at: AT });
  assert.equal(bad.profile, null);
  assert.match(bad.problems[0], /^status is "active" or "retired"/);
  // A key on Object.prototype is an unknown key, never a throw.
  for (const k of ["constructor", "toString", "__proto__"]) {
    const odd = upgradeProfile(JSON.parse(JSON.stringify(RECORD).replace(/^\{/, `{${JSON.stringify(k)}:{"values":1},`)), { at: AT });
    assert.equal(odd.profile, null);
    assert.match(odd.problems[0], new RegExp(`^unknown key "${k}"`));
  }
});

// A chain of three schemas for the test: 1 renames a field, 2 adds one; the checker reads schema 3.
const steps = {
  1: (r) => { const { colour, ...rest } = r; return { ...rest, color: colour }; },
  2: (r) => ({ ...r, extra: r.extra ?? "added" }),
};
const check3 = (r) => (r.schema === 3 && r.color && r.extra ? { profile: structuredClone(r), problems: [] } : { profile: null, problems: ["bad record."] });

test("older schema upgraded with history kept; newer refused; the chain has no gap", () => {
  const history = [{ revision: 1, at: "2026-10-01T00:00:00Z", change: [], by: "person" }, { revision: 2, at: "2026-10-02T00:00:00Z", change: ["locale.timezone"], by: "person" }];
  const old = { schema: 1, revision: 2, colour: "blue", history };
  const before = structuredClone(old);
  const r = upgradeProfile(old, { at: AT, steps, current: 3, check: check3 });
  assert.deepEqual(r.problems, []);
  assert.equal(r.from, 1);
  assert.equal(r.upgraded, true);
  assert.equal(r.profile.schema, 3);
  assert.equal(r.profile.color, "blue");
  assert.equal(r.profile.colour, undefined);
  assert.equal(r.profile.extra, "added");
  // History kept, one entry added at the same revision (settings unchanged).
  assert.deepEqual(r.profile.history, [...history, { revision: 2, at: AT, change: ["schema"], by: "upgrade" }]);
  assert.equal(r.profile.revision, 2);
  // The caller's object is never changed.
  assert.deepEqual(old, before);
  // From the middle of the chain.
  const mid = upgradeProfile({ schema: 2, revision: 1, color: "red", history: [] }, { at: AT, steps, current: 3, check: check3 });
  assert.equal(mid.from, 2);
  assert.equal(mid.profile.extra, "added");
  // A step that drops history doesn't lose it.
  const dropping = { 1: (r) => { const { history: _h, ...rest } = r; return { ...rest, color: r.colour }; }, 2: steps[2] };
  assert.deepEqual(upgradeProfile(old, { at: AT, steps: dropping, current: 3, check: check3 }).profile.history.slice(0, 2), history);

  // Newer: refused, naming both versions; nothing returned to write.
  const newer = upgradeProfile({ ...RECORD, schema: SCHEMA_VERSION + 1 }, { at: AT });
  assert.equal(newer.profile, null);
  assert.equal(newer.from, SCHEMA_VERSION + 1);
  assert.match(newer.problems[0], new RegExp(`schema ${SCHEMA_VERSION + 1}, newer than this PairBrowse reads \\(${SCHEMA_VERSION}\\); update PairBrowse, the file is left as it is\\.$`));
  for (const schema of [0, -1, 1.5, "1", null, undefined]) assert.match(upgradeProfile({ ...RECORD, schema }).problems[0], /no schema this PairBrowse knows/);
  assert.match(upgradeProfile("x").problems[0], /^a profile record is an object/);

  // A gap, a throwing step, a step answering nothing: refused, naming the version.
  assert.match(upgradeProfile(old, { at: AT, steps: { 2: steps[2] }, current: 3, check: check3 }).problems[0], /^no upgrade from schema 1 to 2 \(the upgrader's chain has a gap\); the file is left as it is\.$/);
  assert.match(upgradeProfile(old, { at: AT, steps: { 1: () => { throw new Error("boom"); }, 2: steps[2] }, current: 3, check: check3 }).problems[0], /^the upgrade from schema 1 to 2 failed \(boom\)/);
  assert.match(upgradeProfile(old, { at: AT, steps: { 1: () => null, 2: steps[2] }, current: 3, check: check3 }).problems[0], /^the upgrade from schema 1 to 2 answered no record/);
  // A step whose result the checker refuses: named as after the upgrade.
  const failing = upgradeProfile(old, { at: AT, steps: { 1: (r) => r, 2: (r) => r }, current: 3, check: check3 });
  assert.equal(failing.profile, null);
  assert.equal(failing.upgraded, true);
  assert.match(failing.problems[0], /^after the upgrade from schema 1: bad record\.$/);
});

test("the upgrade's history entry keeps history within its cap and passes the real checker", () => {
  // Through the real checker: an identity step from a pretend schema 0 is never offered (schema
  // starts at 1), so run one version up with a checker that reads the result as schema 1.
  const asOne = (r) => checkProfile({ ...r, schema: 1 });
  const long = Array.from({ length: 1000 }, (_, i) => ({ revision: 4, at: `2026-10-20T10:00:${String(i % 60).padStart(2, "0")}Z`, change: [], by: "person" }));
  const r = upgradeProfile({ ...RECORD, history: long }, { at: AT, steps: { 1: (x) => x }, current: 2, check: asOne });
  assert.deepEqual(r.problems, []);
  assert.equal(r.profile.history.length, 1000);
  assert.deepEqual(r.profile.history.at(-1), { revision: 4, at: AT, change: ["schema"], by: "upgrade" });
});

test("exports: the current formatVersion as it is, older through the chain, newer refused, other formats refused", () => {
  const file = { format: "pairbrowse-profile", formatVersion: 1, exported: { at: AT }, profile: {}, provenance: [], license: "own-capture", sha256: "a".repeat(64) };
  const same = upgradeExport(file);
  assert.equal(same.problem, "");
  assert.equal(same.upgraded, false);
  assert.deepEqual(same.file, file);
  assert.notEqual(same.file, file);
  const newer = upgradeExport({ ...file, formatVersion: 2 });
  assert.equal(newer.file, null);
  assert.match(newer.problem, /formatVersion 2, newer than this PairBrowse reads \(1\)/);
  assert.match(upgradeExport({ ...file, formatVersion: "1" }).problem, /no formatVersion this PairBrowse knows/);
  assert.match(upgradeExport({ ...file, format: "other" }).problem, /^not a pairbrowse-profile export/);
  assert.match(upgradeExport(null).problem, /^not a pairbrowse-profile export/);
  const older = upgradeExport({ ...file, formatVersion: 1 }, { steps: { 1: (f) => ({ ...f, added: true }) }, current: 2 });
  assert.equal(older.upgraded, true);
  assert.equal(older.file.formatVersion, 2);
  assert.equal(older.file.added, true);
});
