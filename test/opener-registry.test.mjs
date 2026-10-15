// The opener registry (plans/555 D6.2a; scripts/openers.mjs, opener.mjs claimOpener): each helper
// writes the record of the build it launches under that build's bundle id, never over another
// running helper's, removes its own at a clean stop; open.mjs finds its helper's home from the
// record of the app that ran it.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, chmodSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecordName, bundleIdOf, bundleIdOfApp, parseRecord, readRecord, openerEnv, openersDir, recordFile, appOf, RELEASE_BUNDLE_ID, DEV_BUNDLE_ID } from "../scripts/openers.mjs";
import { claimOpener, releaseOpener, registryDir, parseOpener, openerText, OPEN_ANSWER_MS } from "../scripts/opener.mjs";
import { paths } from "../scripts/paths.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(root, "scripts", "open.mjs");
const scratch = mkdtempSync(join(tmpdir(), "pb-reg-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const account = join(scratch, "account");
const dir = openersDir(account);
const base = join(account, ".pairbrowse");
const work = join(base, "instances", "work");

function app(name, manifest) {
  const a = join(scratch, "apps", name, "PairBrowse.app");
  mkdirSync(join(a, "Contents", "Resources"), { recursive: true });
  mkdirSync(join(a, "Contents", "MacOS"), { recursive: true });
  if (manifest) writeFileSync(join(a, "Contents", "Resources", "PairBrowse-build.json"), JSON.stringify(manifest));
  return join(a, "Contents", "MacOS", "pairbrowse");
}

test("record names are bundle ids, never paths (the browser's IsRecordName)", () => {
  for (const ok of [RELEASE_BUNDLE_ID, DEV_BUNDLE_ID, "a", "A-1.b2"]) assert.equal(isRecordName(ok), true, ok);
  for (const bad of ["", ".a", "a.", "-a", "a..b", "../run/opener", "a/b", "a b", "a\0", "x".repeat(129), null, 3]) assert.equal(isRecordName(bad), false, String(bad));
});

test("a build's bundle id: its manifest's bundleId, else by channel, else the release id", () => {
  assert.equal(bundleIdOf({ product: "PairBrowse", bundleId: DEV_BUNDLE_ID, channel: "dev" }), DEV_BUNDLE_ID);
  assert.equal(bundleIdOf({ product: "PairBrowse", channel: "dev" }), DEV_BUNDLE_ID);
  assert.equal(bundleIdOf({ product: "PairBrowse", version: "150.0.0.1" }), RELEASE_BUNDLE_ID);
  assert.equal(bundleIdOf({ product: "PairBrowse", bundleId: "../x" }), RELEASE_BUNDLE_ID);
  assert.equal(bundleIdOf({ product: "Chromium" }), null);
  assert.equal(bundleIdOfApp(app("dev", { product: "PairBrowse", channel: "dev", bundleId: DEV_BUNDLE_ID })), DEV_BUNDLE_ID);
  assert.equal(bundleIdOfApp(app("none")), null, "no manifest: not a native build (the branded Chromium)");
  assert.equal(appOf("/A/B.app/Contents/MacOS/b"), "/A/B.app");
  assert.equal(appOf("/usr/bin/node"), null);
});

test("records keep the browser's form; home and instance ride along", () => {
  const text = openerText({ node: process.execPath, script: SCRIPT, home: work, instance: "work" });
  assert.ok(parseOpener(text), "the browser's rule still accepts it");
  assert.deepEqual(parseRecord(text), { node: process.execPath, script: SCRIPT, home: work, instance: "work" });
  assert.equal(parseRecord(JSON.stringify({ v: 1, node: process.execPath, script: SCRIPT, home: "relative" })), null);
  assert.equal(parseRecord(JSON.stringify({ v: 1, node: process.execPath, script: SCRIPT, home: work, instance: "../x" })), null);
});

test("claim: owner-only and atomic; another running helper's record stays, a gone one's is replaced; release removes only its own", async () => {
  const name = DEV_BUNDLE_ID;
  const file = recordFile(name, dir);
  const alive = new Set();
  const answers = async (home) => alive.has(home);
  assert.equal(await claimOpener(name, { dir, script: SCRIPT, home: base, instance: null, answers }), "written");
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(readRecord(file).home, base);
  assert.deepEqual(readdirSync(dir), [`${name}.json`], "no temp file left");
  // The default helper runs: the work instance leaves its record alone.
  alive.add(base);
  assert.equal(await claimOpener(name, { dir, script: SCRIPT, home: work, instance: "work", answers }), "kept");
  assert.equal(readRecord(file).home, base);
  assert.equal(releaseOpener(name, { dir, home: work }), false, "not its record");
  assert.ok(existsSync(file));
  // The default helper is gone: the work instance takes the record.
  alive.delete(base);
  assert.equal(await claimOpener(name, { dir, script: SCRIPT, home: work, instance: "work", answers }), "written");
  assert.deepEqual(readRecord(file), { node: process.execPath, script: SCRIPT, home: work, instance: "work" });
  // Its own record: rewritten without asking.
  alive.add(work);
  assert.equal(await claimOpener(name, { dir, script: SCRIPT, home: work, instance: "work", answers }), "written");
  assert.equal(releaseOpener(name, { dir, home: work }), true);
  assert.equal(existsSync(file), false);
  assert.equal(await claimOpener("../opener", { dir, script: SCRIPT, home: work, answers }), "skipped");
});

test("open.mjs's home: the record of the app that ran it, only when it names this script", async () => {
  const devExe = app("dev2", { product: "PairBrowse", channel: "dev", bundleId: DEV_BUNDLE_ID });
  const relExe = app("rel", { product: "PairBrowse", version: "150.0.0.1" });
  const env = (exe, script = SCRIPT) => openerEnv({ parentExe: exe, script, account });
  assert.equal(env(devExe), null, "no record: opener.json's helper");
  await claimOpener(DEV_BUNDLE_ID, { dir, script: SCRIPT, home: work, instance: "work", answers: async () => false });
  assert.deepEqual(env(devExe), { PAIRBROWSE_INSTANCE: "work" });
  assert.equal(env(relExe), null, "another app's record is never read");
  assert.equal(env(devExe, join(scratch, "other-copy", "scripts", "open.mjs")), null, "another copy's record");
  assert.equal(env("/usr/bin/node"), null);
  await claimOpener(RELEASE_BUNDLE_ID, { dir, script: SCRIPT, home: base, instance: null, answers: async () => false });
  assert.deepEqual(env(relExe), { PAIRBROWSE_INSTANCE: "default" });
  const elsewhere = join(scratch, "elsewhere-home");
  await claimOpener(RELEASE_BUNDLE_ID, { dir, script: SCRIPT, home: elsewhere, instance: null, answers: async () => false });
  assert.deepEqual(env(relExe), { PAIRBROWSE_HOME: elsewhere });
  // An instance record whose home isn't that instance's: refused.
  writeFileSync(recordFile(DEV_BUNDLE_ID, dir), JSON.stringify({ v: 1, node: process.execPath, script: SCRIPT, home: elsewhere, instance: "work" }));
  assert.equal(env(devExe), null);
  // Others may read or write the folder or the file: refused, as the browser does.
  await claimOpener(DEV_BUNDLE_ID, { dir, script: SCRIPT, home: work, instance: "work", answers: async () => false });
  chmodSync(recordFile(DEV_BUNDLE_ID, dir), 0o644);
  assert.equal(env(devExe), null);
  chmodSync(recordFile(DEV_BUNDLE_ID, dir), 0o600);
  chmodSync(dir, 0o755);
  assert.equal(env(devExe), null);
  chmodSync(dir, 0o700);
  assert.deepEqual(env(devExe), { PAIRBROWSE_INSTANCE: "work" });
  assert.equal(readRecord(recordFile(DEV_BUNDLE_ID, dir), { uid: 12345678 }), null, "another account's");
});

test("a helper the test harness started writes its registry in its own home, never the person's", () => {
  assert.equal(registryDir({ harness: true }), join(paths.run, "openers"));
});

test("open.mjs's own answer bound is opener.mjs's", () => {
  assert.match(readFileSync(SCRIPT, "utf8"), new RegExp(`const OPEN_ANSWER_MS = ${OPEN_ANSWER_MS.toLocaleString("en-US").replace(/,/g, "_")};`));
});
