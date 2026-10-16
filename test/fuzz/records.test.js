// Property-based fuzzing of the files a hand-opened browser and a project folder name the helper
// by: the opener registry's records (scripts/openers.mjs parseRecord, readRecord; opener.json's
// parseOpener) and a project's .pairbrowse.json (scripts/home.mjs projectInstance). Whatever the
// text, size or permissions, nothing throws; a record is taken only when every field passes its
// rule (absolute paths without "..", NUL or a line break, the script .../scripts/open.mjs, a valid
// instance name) and the file and its folder are this account's alone; an instance is only ever a
// valid name (1 to 32 of a-z, 0-9 and -), never a path. Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, basename, dirname } from "node:path";
import fc from "fast-check";
import { parseRecord, readRecord } from "../../scripts/openers.mjs";
import { parseOpener } from "../../scripts/opener.mjs";
import { projectInstance, validInstance, INSTANCE_RE } from "../../scripts/home.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const FILE_RUNS = Math.min(RUNS, 500); // each run writes a file
const posix = process.platform !== "win32";
const root = mkdtempSync(join(tmpdir(), "pb-fuzz-records-"));
after(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => { const d = join(root, String(n++)); mkdirSync(d, { mode: 0o700 }); return d; };

const okPath = (p) => typeof p === "string" && p.length > 1 && p.length <= 1024 && isAbsolute(p) && !/[\0\r\n]/.test(p) && !p.split(/[\\/]/).includes("..");
const segment = fc.oneof(fc.constantFrom("..", ".", "scripts", "open.mjs", "node", "a b", "x\n", "x\0", ""), fc.string({ maxLength: 8 }));
const pathLike = fc.oneof(
  fc.array(segment, { maxLength: 6 }).map((s) => `/${s.join("/")}`),
  fc.array(segment, { minLength: 1, maxLength: 6 }).map((s) => `/${s.join("/")}/scripts/open.mjs`),
  fc.string(), fc.constant("/usr/local/bin/node"), fc.constant("/opt/pb/scripts/open.mjs"), fc.anything(),
);
const instance = fc.oneof(fc.stringMatching(/^[a-z0-9-]{1,32}$/), fc.constantFrom("../x", "a/b", "default", "", "A", "a".repeat(33), "x\n"), fc.string({ maxLength: 40 }), fc.anything());
const recordObj = fc.record({ v: fc.oneof(fc.constant(1), fc.anything()), node: pathLike, script: pathLike, home: pathLike, instance }, { requiredKeys: [] });
// A record that should be taken, so the rules' yes is tried as often as their no.
const name = fc.stringMatching(/^[A-Za-z0-9_ -]{1,12}$/);
const absDir = fc.array(name, { maxLength: 4 }).map((s) => `/${s.join("/")}`);
const goodRecord = fc.record({ v: fc.constant(1), node: absDir.map((d) => `${d}/node`), script: absDir.map((d) => `${d}/scripts/open.mjs`), home: absDir.filter((d) => d.length > 1), instance: fc.stringMatching(/^[a-z0-9-]{1,32}$/) }, { requiredKeys: ["v", "node", "script"] });
const recordText = fc.oneof(goodRecord.map((o) => JSON.stringify(o)), recordObj.map((o) => JSON.stringify(o) ?? ""), fc.string(), fc.string({ minLength: 4000, maxLength: 5000 }), fc.jsonValue().map((v) => JSON.stringify(v)));

// What a record's text must be to be taken (the rules, restated).
function acceptable(text) {
  if (Buffer.byteLength(text) > 4096) return false;
  let v;
  try { v = JSON.parse(text); } catch { return false; }
  if (!v || typeof v !== "object" || Array.isArray(v) || v.v !== 1) return false;
  if (!okPath(v.node) || !okPath(v.script) || basename(v.script) !== "open.mjs" || basename(dirname(v.script)) !== "scripts") return false;
  if (v.home !== undefined && !okPath(v.home)) return false;
  return v.instance === undefined || (typeof v.instance === "string" && INSTANCE_RE.test(v.instance));
}

test("parseRecord and parseOpener: any text never throws; taken only when every field passes", () => {
  fc.assert(fc.property(fc.oneof(recordText, fc.anything()), (text) => {
    const rec = parseRecord(text);
    const op = parseOpener(text);
    if (typeof text !== "string") { assert.equal(rec, null); assert.equal(op, null); return; }
    assert.equal(rec !== null, acceptable(text), text.slice(0, 200));
    if (rec) {
      assert.ok(okPath(rec.node) && okPath(rec.script));
      assert.ok(rec.home === null || okPath(rec.home));
      assert.ok(rec.instance === null || validInstance(rec.instance));
      assert.deepEqual(op, { node: rec.node, script: rec.script }, "the browser's own rule takes it too");
    }
  }), { numRuns: RUNS });
});

test("readRecord: any content, size and permissions never throw; taken only from the account's own private file", { skip: !posix && "file modes" }, () => {
  const mode = fc.constantFrom(0o600, 0o400, 0o644, 0o640, 0o604, 0o660, 0o700, 0o777);
  const dirMode = fc.constantFrom(0o700, 0o755, 0o750, 0o705, 0o777);
  let taken = 0;
  fc.assert(fc.property(recordText, mode, dirMode, fc.boolean(), (text, m, dm, link) => {
    const dir = fresh();
    const file = join(dir, "app.pairbrowse.browser.json");
    if (link) {
      const real = join(root, `real-${n}.json`);
      writeFileSync(real, text, { mode: 0o600 });
      symlinkSync(real, file);
    } else {
      writeFileSync(file, text);
      chmodSync(file, m);
    }
    chmodSync(dir, dm);
    let got;
    try { got = readRecord(file); } catch (e) { assert.fail(`threw: ${e?.message}`); }
    const shouldTake = !link && !(m & 0o077) && !(dm & 0o077) && acceptable(text);
    assert.equal(got !== null, shouldTake, JSON.stringify({ m: m.toString(8), dm: dm.toString(8), link, text: text.slice(0, 120) }));
    if (got) { taken++; assert.deepEqual(got, parseRecord(text)); }
    assert.equal(readRecord(file, { uid: (process.getuid?.() ?? 0) + 1 }), null, "another account's: never");
    chmodSync(dir, 0o700);
  }), { numRuns: FILE_RUNS });
  assert.ok(taken > 0, "good records were tried too");
  assert.equal(readRecord(join(root, "missing", "x.json")), null);
});

test("projectInstance: any .pairbrowse.json never throws and yields only a valid name, default, a warning or nothing", () => {
  const content = fc.oneof(
    fc.record({ instance }, { requiredKeys: [] }).map((o) => JSON.stringify(o) ?? ""),
    fc.jsonValue().map((v) => JSON.stringify(v) ?? ""),
    fc.string(), fc.string({ minLength: 4090, maxLength: 4200 }),
    instance.map((i) => `{"instance":${JSON.stringify(i) ?? "1"}${" ".repeat(4100)}}`),
  );
  let named = 0;
  fc.assert(fc.property(content, fc.boolean(), (text, link) => {
    const dir = fresh();
    const file = join(dir, ".pairbrowse.json");
    if (link) { writeFileSync(join(dir, "real.json"), text); symlinkSync(join(dir, "real.json"), file); } else writeFileSync(file, text);
    let got;
    try { got = projectInstance(dir); } catch (e) { assert.fail(`threw: ${e?.message}`); }
    assert.ok(got === null || (typeof got === "object" && (("warning" in got && typeof got.warning === "string") || ("name" in got))), JSON.stringify(got));
    if (got && "name" in got) {
      named++;
      assert.ok(got.name === null || validInstance(got.name), JSON.stringify(got));
      assert.ok(got.name === null || (!got.name.includes("/") && !got.name.includes("..")), "never a path");
      assert.ok(!link, "a link is never followed");
      assert.ok(Buffer.byteLength(text) <= 4096, "over 4 KB: never read");
      const v = JSON.parse(text);
      assert.ok(v.instance === got.name || (got.name === null && (v.instance === "default" || v.instance === null)));
    }
    assert.equal(projectInstance(dir, { uid: (process.getuid?.() ?? 0) + 1 })?.name, undefined, "another account's file: never a name");
  }), { numRuns: FILE_RUNS });
  assert.ok(named > 0, "good names were tried too");
  for (const bad of [undefined, null, 1, "", "relative/dir", {}]) assert.equal(projectInstance(bad), null);
});
