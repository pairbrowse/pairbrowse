// The engine's code-sign clones on macOS (scripts/native/clones.mjs): the switch that stops them,
// the X folder found from the per-user temp folder, which folders and clones count as PairBrowse's
// stale ones, and the sweep's refusals. The sweep runs over a temp tree here, never the real X.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cloneRoot, isCloneParent, isCloneDir, browserRunning, stale, sweepCodeSignClones, NO_CLONE_FEATURE } from "../scripts/native/clones.mjs";
import { noCloneArgs } from "../scripts/native-engine.mjs";

test("the switch names the engine's feature, on macOS only", () => {
  assert.equal(NO_CLONE_FEATURE, "MacAppCodeSignClone");
  assert.deepEqual(noCloneArgs("darwin"), ["--disable-features=MacAppCodeSignClone"]);
  assert.deepEqual(noCloneArgs("linux"), []);
  assert.deepEqual(noCloneArgs("win32"), []);
});

test("X is the per-user temp folder's sibling, and only for a temp folder of that shape", () => {
  assert.equal(cloneRoot("/var/folders/pg/80zhwt_121g6wvr8r839fsh40000gp/T/"), "/var/folders/pg/80zhwt_121g6wvr8r839fsh40000gp/X");
  assert.equal(cloneRoot("/private/var/folders/pg/abc/T\n"), "/private/var/folders/pg/abc/X");
  for (const bad of ["", null, "/tmp/", "/var/folders/pg/abc/C/", "/var/folders/pg/../T/", "/Users/me/T/", "/var/folders/pg/abc/def/T/"]) assert.equal(cloneRoot(bad), null, String(bad));
});

test("only PairBrowse's clone folders and the engine's clone names count", () => {
  for (const ok of ["app.pairbrowse.browser.code_sign_clone", "app.pairbrowse.browser.dev.code_sign_clone", "dev.pairbrowse.browser.code_sign_clone"]) assert.ok(isCloneParent(ok), ok);
  for (const no of ["com.google.Chrome.code_sign_clone", "org.chromium.Chromium.code_sign_clone", "app.pairbrowse.browser", "xapp.pairbrowse.browser.code_sign_clone", "app.pairbrowse.browser..code_sign_clone", "app.pairbrowse.browser/x.code_sign_clone"]) assert.ok(!isCloneParent(no), no);
  for (const ok of ["code_sign_clone.8vrErW", "code_sign_clone.a.b_-9"]) assert.ok(isCloneDir(ok), ok);
  for (const no of ["code_sign_clone.abc", "code_sign_clone.abcdefg", "code_sign_clone.ab/cde", "other.abcdef", "code_sign_clone.ab cde"]) assert.ok(!isCloneDir(no), no);
});

test("a PairBrowse browser in the process list stops the sweep; other apps don't", () => {
  assert.ok(browserRunning("/sbin/launchd\n/Users/me/.pairbrowse/browser/PairBrowse.app/Contents/MacOS/pairbrowse\n"));
  assert.ok(browserRunning("/x/PairBrowse.app/Contents/Frameworks/PairBrowse Framework.framework/Versions/155/Helpers/PairBrowse Helper (Renderer).app/Contents/MacOS/PairBrowse Helper (Renderer)"));
  assert.ok(browserRunning("/Users/me/.pairbrowse/browser/PairBrowse Chromium.app/Contents/MacOS/pairbrowse"));
  assert.ok(browserRunning("/private/var/folders/pg/a/X/app.pairbrowse.browser.code_sign_clone/code_sign_clone.abcdef/PairBrowse.app.bundle/Contents/MacOS/pairbrowse"));
  assert.ok(!browserRunning("/sbin/launchd\n/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n/Users/me/.pairbrowse/tunnels/cloudflared\n/opt/homebrew/bin/node\n"));
  assert.ok(!browserRunning(""));
  assert.ok(!browserRunning("/Users/me/.pairbrowse/browser/PairBrowse.app/Contents/Helpers/PairBrowse Agent.app/Contents/MacOS/PairBrowse Agent\n"), "the helper's own program is no browser");
  assert.ok(browserRunning("/x/PairBrowse.app/Contents/Helpers/PairBrowse Agent.app/Contents/MacOS/PairBrowse Agent\n/x/PairBrowse.app/Contents/MacOS/pairbrowse"));
});

test("stale: real folders with the engine's name, older than the minimum age", () => {
  const now = 1_000_000_000;
  const old = now - 10 * 60_000;
  const entries = [
    { name: "code_sign_clone.aaaaaa", isDirectory: true, isSymbolicLink: false, born: old },
    { name: "code_sign_clone.bbbbbb", isDirectory: true, isSymbolicLink: false, born: now - 60_000 }, // too new
    { name: "code_sign_clone.cccccc", isDirectory: false, isSymbolicLink: true, born: old }, // a link
    { name: "code_sign_clone.dddddd", isDirectory: false, isSymbolicLink: false, born: old }, // a file
    { name: "something.eeeeee", isDirectory: true, isSymbolicLink: false, born: old },
    { name: "code_sign_clone.ffffff", isDirectory: true, isSymbolicLink: false, born: NaN },
  ];
  assert.deepEqual(stale(entries, { now, minAgeMs: 5 * 60_000 }), ["code_sign_clone.aaaaaa"]);
});

function tree() {
  const base = mkdtempSync(join(tmpdir(), "pb-clones-"));
  const t = join(base, "var", "folders", "pg", "id", "T");
  const x = join(base, "var", "folders", "pg", "id", "X");
  mkdirSync(t, { recursive: true });
  const make = (parent, name) => { const d = join(x, parent, name, "PairBrowse.app.bundle", "Contents"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "Info.plist"), "x"); return join(x, parent, name); };
  return { base, x, make };
}

test("the sweep removes PairBrowse's stale clones and nothing else", async () => {
  const { base, x, make } = tree();
  try {
    const ours = make("app.pairbrowse.browser.code_sign_clone", "code_sign_clone.aaaaaa");
    const dev = make("app.pairbrowse.browser.dev.code_sign_clone", "code_sign_clone.bbbbbb");
    const open = make("dev.pairbrowse.browser.code_sign_clone", "code_sign_clone.cccccc");
    const other = make("com.google.Chrome.code_sign_clone", "code_sign_clone.dddddd");
    const target = mkdtempSync(join(tmpdir(), "pb-clones-target-"));
    writeFileSync(join(target, "keep"), "x");
    symlinkSync(target, join(x, "app.pairbrowse.browser.code_sign_clone", "code_sign_clone.eeeeee"));
    // The temp folder's real shape is checked (cloneRoot): the seam hands a real one's twin under base.
    const getconf = async () => "/var/folders/pg/id/T/";
    const seen = [];
    const r = await sweepCodeSignClones({ platform: "darwin", getconf, ps: async () => "/sbin/launchd\n", minAgeMs: 0, log: (l) => seen.push(l), root: x });
    assert.equal(r.removed, 3);
    assert.ok(!existsSync(ours) && !existsSync(dev) && !existsSync(open));
    assert.ok(existsSync(other), "another app's clone stays");
    assert.ok(existsSync(join(target, "keep")), "a link is never followed");
    assert.ok(existsSync(join(x, "app.pairbrowse.browser.code_sign_clone")), "the engine's own folder stays");
    assert.match(seen.join("\n"), /removed 3 copies/);
    rmSync(target, { recursive: true, force: true });
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("the sweep leaves everything while a PairBrowse browser runs, a clone is new, the list can't be read, or off macOS", async () => {
  const { base, x, make } = tree();
  try {
    const ours = make("app.pairbrowse.browser.code_sign_clone", "code_sign_clone.aaaaaa");
    const getconf = async () => "/var/folders/pg/id/T/";
    const running = await sweepCodeSignClones({ platform: "darwin", getconf, ps: async () => "/a/PairBrowse.app/Contents/MacOS/pairbrowse\n", minAgeMs: 0, root: x });
    assert.deepEqual(running, { removed: 0, skipped: "a PairBrowse browser is running" });
    const unread = await sweepCodeSignClones({ platform: "darwin", getconf, ps: async () => null, minAgeMs: 0, root: x });
    assert.equal(unread.removed, 0);
    const young = await sweepCodeSignClones({ platform: "darwin", getconf, ps: async () => "", root: x });
    assert.equal(young.removed, 0, "made in the last few minutes: kept");
    const linux = await sweepCodeSignClones({ platform: "linux", getconf, ps: async () => "", minAgeMs: 0, root: x });
    assert.equal(linux.skipped, "not macOS");
    const noTemp = await sweepCodeSignClones({ platform: "darwin", getconf: async () => null, ps: async () => "", minAgeMs: 0 });
    assert.equal(noTemp.removed, 0);
    assert.ok(existsSync(ours));
    const bounded = await sweepCodeSignClones({ platform: "darwin", getconf, ps: async () => "", minAgeMs: 0, maxRemoved: 0, root: x });
    assert.equal(bounded.removed, 0);
    assert.ok(existsSync(ours));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
