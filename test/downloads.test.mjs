// The downloads folder (rules/downloads.mjs): checked when chosen, when config.json is read, and
// again at every save, on the folder's real path at that moment.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync, realpathSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { checkDownloads, downloadsFolderNow } from "../scripts/rules/downloads.mjs";
import { loadConfig, paths } from "../scripts/paths.mjs";
import { createDownloads } from "../scripts/daemon/browser/downloads.mjs";

const testHome = process.env.PAIRBROWSE_HOME;

const user = realpathSync(mkdtempSync(join(tmpdir(), "pb-dl-user-")));
after(() => rmSync(user, { recursive: true, force: true }));
const at = (...p) => join(user, ...p);
mkdirSync(at("Library", "LaunchAgents"), { recursive: true });
mkdirSync(at("Work"), { recursive: true });

test("a chosen folder is used by its real path while it qualifies; swapped for a link or gone, Downloads is", () => {
  const home = testHome;
  assert.deepEqual(downloadsFolderNow(at("Work"), { home, user }), { dir: at("Work") });
  // Swapped for a link into ~/Library/LaunchAgents after it was chosen.
  mkdirSync(at("Later"));
  assert.deepEqual(downloadsFolderNow(at("Later"), { home, user }), { dir: at("Later") });
  rmSync(at("Later"), { recursive: true });
  symlinkSync(at("Library", "LaunchAgents"), at("Later"));
  const swapped = downloadsFolderNow(at("Later"), { home, user });
  assert.equal(swapped.dir, at("Downloads"), "your Downloads folder, made when missing");
  assert.match(swapped.problem, /Library/);
  // Gone: never made again (its parent may be a link now too).
  const gone = downloadsFolderNow(at("Gone", "Deep"), { home, user });
  assert.equal(gone.dir, at("Downloads"));
  assert.ok(!existsSync(at("Gone")), "a missing chosen folder isn't made");
  // A link to a hidden folder, the helper's home, the home folder itself.
  mkdirSync(at(".ssh"));
  symlinkSync(at(".ssh"), at("Keys"));
  assert.match(downloadsFolderNow(at("Keys"), { home, user }).problem, /hidden/);
  assert.match(checkDownloads(user, { home, user }).problem, /home folder/);
  symlinkSync(home, at("Helper"));
  assert.match(checkDownloads(at("Helper"), { home, user: tmpdir() }).problem ?? "", /PairBrowse's own folder/);
  // Downloads itself a link into Library: nowhere.
  const user2 = realpathSync(mkdtempSync(join(tmpdir(), "pb-dl-user2-")));
  try {
    mkdirSync(join(user2, "Library", "LaunchAgents"), { recursive: true });
    symlinkSync(join(user2, "Library", "LaunchAgents"), join(user2, "Downloads"));
    const none = downloadsFolderNow(null, { home, user: user2 });
    assert.equal(none.dir, null);
    assert.match(none.problem, /Library/);
  } finally { rmSync(user2, { recursive: true, force: true }); }
});

test("a downloads folder written into config.json by hand gets the same check", () => {
  const saved = process.env.HOME;
  process.env.HOME = user; // homedir() reads it
  try {
    for (const [value, kept] of [[at("Work"), true], [at("Library", "LaunchAgents"), false], ["/etc", false], [paths.home, false], ["relative/x", false], [42, false], [at("Missing"), false]]) {
      writeFileSync(paths.config, JSON.stringify({ downloadsDir: value }));
      assert.equal(loadConfig().downloadsDir, kept ? value : null, String(value));
    }
  } finally {
    process.env.HOME = saved;
    rmSync(paths.config, { force: true });
  }
});

test("a save resolves the folder at that moment: one swapped for a link after loading is not written to", async () => {
  mkdirSync(at("Saves"));
  const config = { downloadsDir: at("Saves") };
  const notes = [];
  const fake = (name) => {
    const src = join(user, `src-${name}`);
    writeFileSync(src, "data");
    return { suggestedFilename: () => name, path: async () => src, failure: async () => null };
  };
  const done = [];
  const { keepDownloads } = createDownloads({
    personTabs: { has: () => false }, config, hostNote: (t) => notes.push(t), log: () => {}, profile: () => user,
    onDownload: (e) => { if (e.op !== "start") done.push(e); return 1; },
    folderNow: () => downloadsFolderNow(config.downloadsDir, { home: testHome, user }),
  });
  const page = new EventEmitter();
  keepDownloads(page);
  const save = async (name) => { const n = done.length; page.emit("download", fake(name)); for (let i = 0; i < 200 && done.length === n; i++) await new Promise((r) => setTimeout(r, 10)); };
  await save("a.txt");
  assert.deepEqual(readdirSync(at("Saves")), ["a.txt"]);
  // The folder is swapped for a link into LaunchAgents after it was chosen and loaded.
  rmSync(at("Saves"), { recursive: true });
  symlinkSync(at("Library", "LaunchAgents"), at("Saves"));
  await save("evil.plist");
  assert.deepEqual(readdirSync(at("Library", "LaunchAgents")), [], "nothing lands in LaunchAgents");
  assert.ok(readdirSync(at("Downloads")).includes("evil.plist"), "it goes to your Downloads folder instead");
  assert.equal(done.at(-1).op, "done");
});
