// Upgrades: homes shaped like 0.15.30, 0.15.40 and 0.15.46 left them (test/fixtures/homes,
// synthetic) read by the current loaders with everything kept: settings, sessions, tabs, people,
// remembered details, runs, the last review, saved passwords' names. After the current code writes
// to each (a setting, a person, a run, a detail), it all still loads, and that release's own
// loaders (its scripts from git) read the home back with nothing lost: a downgrade doesn't corrupt it.
// Each case copies the fixture into a fresh home under the temp folder, in a process of its own.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, chmodSync, rmSync, readFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const READ = join(ROOT, "test", "helpers", "home-read.mjs");
const VERSIONS = ["0.15.30", "0.15.40", "0.15.46"];

// A fresh home holding the fixture: secrets.env is kept as secrets.env.fixture (the repo never
// tracks a .env file), and made owner-only, as PairBrowse requires.
function homeFor(version) {
  const home = mkdtempSync(join(tmpdir(), `pb-upgrade-${version}-`));
  cpSync(join(ROOT, "test", "fixtures", "homes", version), home, { recursive: true });
  renameSync(join(home, "secrets.env.fixture"), join(home, "secrets.env"));
  chmodSync(join(home, "secrets.env"), 0o600);
  return home;
}
const read = (home, scripts, mode = "read") => JSON.parse(execFileSync(process.execPath, [READ, scripts, mode], { env: { ...process.env, PAIRBROWSE_HOME: home }, encoding: "utf8" }));

// The release's own scripts (and the top-level files of its tree they import), from its tag; null
// where the tag isn't there (a shallow clone): the downgrade half is then skipped, and says so.
const git = (args, opts = {}) => execFileSync("git", ["-C", ROOT, ...args], { maxBuffer: 64 * 1024 * 1024, stdio: ["pipe", "pipe", "ignore"], ...opts });
function releaseScripts(version) {
  try { git(["rev-parse", "-q", "--verify", `refs/tags/v${version}`]); } catch { return null; }
  const dir = mkdtempSync(join(tmpdir(), `pb-release-${version}-`));
  const have = new Set(git(["ls-tree", "--name-only", `v${version}`], { encoding: "utf8" }).split("\n"));
  const tar = git(["archive", `v${version}`, ...["scripts", "ui", "package.json"].filter((p) => have.has(p))]);
  mkdirSync(dir, { recursive: true });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  return { dir, scripts: join(dir, "scripts") };
}

// What every one of these homes holds, as the loaders read it.
function assertKept(found, version, { written = false } = {}) {
  assert.equal(found.config.participantName, "Ann Example");
  assert.equal(found.config.maxTabs, written ? 14 : 12);
  assert.equal(found.config.screenshots, false);
  assert.deepEqual(found.config.browserArgs, ["--lang=en-US"]);
  assert.equal(found.config.liveViewPort, 4321);
  assert.deepEqual(found.config.joinHosts, ["share.example.org"]);
  assert.equal(found.config.browserEngine, "auto", "the older name is still there to read");
  if (version !== "0.15.30") assert.deepEqual(found.config.sharing, { tunnel: { kind: "quick" }, guestPort: 0 });
  if (version === "0.15.46") assert.deepEqual(found.config.pairbrowse, { humanize: true, typingPace: 0.35 });
  if (found.warnings) assert.deepEqual(found.warnings, [], "nothing in an older release's config.json is unknown or refused");
  assert.equal(found.current, "work");
  assert.deepEqual(found.sessions, ["default", "work"]);
  assert.deepEqual(found.tabs.default.tabs.map((t) => t.url), ["https://shop.example.com/admin", "https://docs.example.com/start"]);
  assert.equal(found.tabs.default.active, 1);
  assert.deepEqual(found.tabs.work.tabs.map((t) => t.url), ["https://forms.example.net/apply"]);
  assert.deepEqual(found.people.default, ["Ann Example"]);
  assert.deepEqual(found.people.work, written ? ["Cy Example", "Bo Example"] : ["Bo Example"]);
  assert.deepEqual(found.facts.slice(0, 2), ["Legal name: Example Shop B.V.", "City: Utrecht"]);
  if (written) assert.ok(found.facts.includes("Country: Netherlands"));
  const shop = found.runs.find((r) => r.name === "Shop setup");
  assert.ok(shop, "the saved run");
  assert.deepEqual(shop.done, written ? ["Opened the admin", "Added shipping rates"] : ["Opened the admin"]);
  assert.deepEqual(shop.left, ["Shipping rates"]);
  assert.deepEqual(shop.yourTurn, ["Confirm the e-mail"]);
  if (version === "0.15.46") assert.ok(found.runs.some((r) => r.name === "forms.example.net 2026-05-02 09:00"), "the helper's own run");
  assert.equal(found.review, "shop.example.com");
  assert.deepEqual(found.secrets, ["EXAMPLE_PASSWORD"]);
}

for (const version of VERSIONS) {
  test(`a ${version} home: the current code reads all of it, writes to it, and ${version} reads it back`, { timeout: 60_000 }, (t) => {
    const home = homeFor(version);
    const release = releaseScripts(version);
    try {
      const before = readFileSync(join(home, "config.json"), "utf8");
      assertKept(read(home, join(ROOT, "scripts")), version);
      assert.equal(readFileSync(join(home, "config.json"), "utf8"), before, "reading changes nothing");
      // The current code writes; everything is still there for it.
      assertKept(read(home, join(ROOT, "scripts"), "write"), version, { written: true });
      // A downgrade: that release's own loaders read the home the current code wrote to.
      if (release) assertKept(read(home, release.scripts), version, { written: true });
      else t.diagnostic(`v${version} isn't in this clone: the downgrade read is skipped`);
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (release) rmSync(release.dir, { recursive: true, force: true });
    }
  });
}
