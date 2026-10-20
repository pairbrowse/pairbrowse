// The browser profiles' command line (spec server-mode D14, step 38; profiles/cli.mjs): the person's
// list, show, create, edit, retire and restore, assign, import (with a dry run), export, validate
// (holding a profile to the build installed now) and migrate with --report, --dismiss and --undo,
// each through the profile store; usage mistakes exit 2, refusals 1, and nothing printed holds a
// value read from an import that wasn't applied.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProfilesCli, USAGE } from "../scripts/profiles/cli.mjs";
import { createProfileStore } from "../scripts/profiles/store.mjs";
import { createSession, readAssignment } from "../scripts/sessions.mjs";
import { readMigration } from "../scripts/profiles/migrate.mjs";
import { paths } from "../scripts/paths.mjs";

const T0 = Date.parse("2026-10-21T10:00:00Z");
const dir = mkdtempSync(join(tmpdir(), "pb-cli-"));
const store = createProfileStore({ now: () => T0 });
const BUILD = { build: "150.0.7871.114", pack: "4451781446317d6ebf675afa0d75258d826fb1f5ddf06f292a20bfc24e65f793" };
async function cli(...argv) {
  let out = "", err = "";
  const code = await runProfilesCli(argv, { out: { write: (s) => { out += s; } }, err: { write: (s) => { err += s; } }, store, config: { browser: "pairbrowse" }, native: true, build: BUILD, running: () => false, now: () => T0, platform: "linux" });
  return { code, out, err };
}

test("profiles from the command line: make, change, retire, assign, import, export, validate", async () => {
  assert.deepEqual(await cli("nonsense"), { code: 2, out: "", err: `${USAGE}\n` });
  let r = await cli("create", "berlin", "--settings", '{"locale":{"languages":["de-DE"],"timezone":"Europe/Berlin","source":"set"}}');
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Made browser profile "berlin" \(p-[0-9a-f]{16}\), revision 1\.\n$/);
  assert.equal((await cli("create", "x", "--settings", "{nope")).code, 2);
  assert.equal((await cli("create", "x", "--color", "red")).code, 2);
  r = await cli("create", "bad", "--settings", '{"executablePath":"/bin/sh"}');
  assert.equal(r.code, 1, "a key a profile can't hold is refused");
  r = await cli("edit", "berlin", "--settings", '{"window":{"width":1280,"height":800}}', "--revision", "1");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /revision 2/);
  r = await cli("edit", "berlin", "--name", "berlin-2", "--revision", "1");
  assert.equal(r.code, 1);
  assert.match(r.err, /changed meanwhile/);
  r = await cli("show", "berlin");
  assert.equal(JSON.parse(r.out).window.width, 1280);
  assert.equal((await cli("retire", "berlin")).out, 'Browser profile "berlin" is retired.\n');
  createSession("cli-work");
  r = await cli("assign", "cli-work", "berlin");
  assert.equal(r.code, 1);
  assert.match(r.err, /retired/);
  assert.equal((await cli("restore", "berlin")).code, 0);
  r = await cli("assign", "cli-work", "berlin");
  assert.equal(r.code, 0, r.err);
  assert.equal(readAssignment("cli-work").profileId, store.get("berlin").id);
  r = await cli("list");
  assert.equal(r.out, `berlin  ${store.get("berlin").id}  rev 4  active  sessions: cli-work\n`);
  // "default" is made from config.json when first named.
  createSession("cli-other");
  assert.equal((await cli("assign", "cli-other", "default")).code, 0);
  assert.match((await cli("list")).out, /^default {2}p-[0-9a-f]{16} {2}rev 1 {2}active {2}\(from config\.json\) {2}sessions: cli-other\n/);

  // Import: a dry run writes nothing; the persona's hardware is reported, never its values.
  const file = new URL("./fixtures/profiles/engine-persona.json", import.meta.url).pathname;
  r = await cli("import", file, "--dry-run", "--source", "an old persona", "--license", "own-capture");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^Would import /);
  const count = store.list().length;
  r = await cli("import", file, "--source", "an old persona", "--license", "unknown", "--name", "old-desk");
  assert.equal(r.code, 0, r.err);
  assert.equal(store.list().length, count + 1);
  assert.match(r.out, /gpuVendor: unsupported/);
  assert.match(r.out, /Its license is "unknown"/);
  const persona = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(!r.out.includes(String(persona.options.gpuVendor)), "a value not applied isn't printed");
  r = await cli("import", file);
  assert.equal(r.code, 1);
  assert.match(r.err, /refused at the provenance check/);

  // Export: the sealed file, 0600; an existing file only with --overwrite.
  const dest = join(dir, "berlin.json");
  r = await cli("export", "berlin", dest);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(readFileSync(dest, "utf8")).profile.name, "berlin");
  assert.equal((await cli("export", "berlin", dest)).code, 1);
  assert.equal((await cli("export", "berlin", dest, "--overwrite", "--with-history")).code, 0);

  // Validate: held to the build installed now; a build it can't apply on refused by name.
  r = await cli("validate", "berlin");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^berlin: applies on build 150\.0\.7871\.114; unverified until PairBrowse measures this build\.\n$/);
  assert.deepEqual(store.get("berlin").engine, { major: "150", build: BUILD.build });
  let none = "";
  const code = await runProfilesCli(["validate"], { out: { write: () => {} }, err: { write: (s) => { none += s; } }, store, config: {}, native: false, build: { problem: "The native PairBrowse build isn't installed yet: start the browser once, then check the profile." }, running: () => false });
  assert.equal(code, 1);
  assert.match(none, /isn't installed yet/);
});

test("migrate from the command line: --report, the move, --dismiss and --undo", async () => {
  writeFileSync(paths.config, JSON.stringify({ browser: "pairbrowse", pairbrowse: { gpuVendor: "Intel", timezone: "Europe/Berlin" } }));
  let out = "";
  const run = (...argv) => runProfilesCli(argv, { out: { write: (s) => { out += s; } }, err: { write: (s) => { out += s; } }, store, config: { browser: "pairbrowse", pairbrowse: { gpuVendor: "Intel", timezone: "Europe/Berlin" } }, native: true, running: () => false, now: () => T0, platform: "linux" });
  assert.equal(await run("migrate", "--report"), 0);
  assert.match(out, /isn't moved to browser profiles yet/);
  assert.match(out, /Kept out of it: .*pairbrowse\.gpuVendor/);
  assert.equal(await run("migrate", "--report", "--undo"), 2, "one at a time");
  out = "";
  assert.equal(await run("migrate"), 0, out);
  assert.match(out, /^Moved \d+ sessions? to browser profile "default"/);
  assert.ok(readMigration());
  out = "";
  assert.equal(await run("migrate"), 0);
  assert.match(out, /already/);
  assert.equal(await run("migrate", "--dismiss"), 0);
  assert.equal(readMigration().dismissed, true);
  out = "";
  assert.equal(await runProfilesCli(["migrate", "--undo"], { out: { write: () => {} }, err: { write: (s) => { out += s; } }, store, config: {}, native: true, running: () => true }), 1);
  assert.match(out, /helper is running/);
  out = "";
  assert.equal(await run("migrate", "--undo"), 0, out);
  assert.match(out, /Exported "berlin" to /);
  assert.equal(existsSync(paths.browserProfiles), false);
  assert.equal(readMigration(), null);
});
