import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataHome, desktopEntry, desktopId, installDesktop, quoteExec, DESKTOP_FOLDER } from "../scripts/native/desktop.mjs";
import { installNative, nativeDirs, nativeLayout } from "../scripts/native/install.mjs";

const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

// A build folder that ships PairBrowse-Desktop/ (an entry with an Exec of its own, icons).
function fakeBuild(root, { entry = true } = {}) {
  const folder = join(root, DESKTOP_FOLDER);
  for (const size of ["16x16", "256x256"]) {
    mkdirSync(join(folder, "icons", "hicolor", size, "apps"), { recursive: true });
    writeFileSync(join(folder, "icons", "hicolor", size, "apps", "pairbrowse.png"), `png ${size}`);
  }
  mkdirSync(join(folder, "icons", "hicolor", "scalable", "apps"), { recursive: true });
  writeFileSync(join(folder, "icons", "hicolor", "scalable", "apps", "pairbrowse.svg"), "<svg/>");
  if (entry) writeFileSync(join(folder, "pairbrowse.desktop"), "[Desktop Entry]\nExec=rm -rf ~ %U\n");
  writeFileSync(join(root, "chrome"), "#!/bin/sh\n", { mode: 0o755 });
  return root;
}

test("Exec is the program's path, quoted and escaped per the desktop entry spec", () => {
  assert.equal(quoteExec("/home/a/.pairbrowse/browser/PairBrowse/chrome"), '"/home/a/.pairbrowse/browser/PairBrowse/chrome"');
  assert.equal(quoteExec('/x/a b"$`\\%/chrome'), '"/x/a b\\\\"\\\\$\\\\`\\\\\\\\%%/chrome"');
  assert.throws(() => quoteExec("/x/a\nExec=evil"), /can't go in a desktop entry/);
  assert.throws(() => quoteExec("relative/chrome"));
  const text = desktopEntry("/opt/pb/chrome");
  assert.match(text, /^Exec="\/opt\/pb\/chrome" %U$/m);
  assert.match(text, /^StartupWMClass=Pairbrowse$/m);
  assert.match(text, /^Icon=pairbrowse$/m);
  assert.match(text, /^Name=PairBrowse$/m);
  assert.doesNotMatch(text, /MimeType/);
  assert.match(desktopEntry("/opt/pb/chrome", { label: "other\nExec=x" }), /^Name=PairBrowse \(otherExecx\)$/m);
});

test("the data home follows XDG_DATA_HOME when absolute; one entry id per install", () => {
  assert.equal(dataHome({ XDG_DATA_HOME: "/d" }, "/home/a"), "/d");
  assert.equal(dataHome({ XDG_DATA_HOME: "rel" }, "/home/a"), join("/home/a", ".local", "share"));
  assert.equal(dataHome({}, "/home/a"), join("/home/a", ".local", "share"));
  assert.equal(desktopId("/home/a/.pairbrowse/browser", "/home/a/.pairbrowse/browser"), "pairbrowse");
  const other = desktopId("/srv/pb/browser", "/home/a/.pairbrowse/browser");
  assert.match(other, /^pairbrowse-[0-9a-f]{8}$/);
  assert.notEqual(other, desktopId("/srv/pb2/browser", "/home/a/.pairbrowse/browser"));
});

test("installs the entry and icons, never the archive's Exec, never through a symlink", () => {
  const app = fakeBuild(temp("pb-desk-app-"));
  const home = join(temp("pb-desk-home-"), "share");
  const browserDir = join(temp("pb-desk-b-"), "browser");
  const elsewhere = join(temp("pb-desk-else-"), "target");
  writeFileSync(elsewhere, "keep");
  mkdirSync(join(home, "applications"), { recursive: true });
  symlinkSync(elsewhere, join(home, "applications", "pairbrowse.desktop"));
  const entry = installDesktop(app, join(app, "chrome"), { browserDir, home, defaultDir: browserDir });
  assert.equal(entry, join(home, "applications", "pairbrowse.desktop"));
  assert.ok(!lstatSync(entry).isSymbolicLink(), "the symlink was replaced, not followed");
  assert.equal(readFileSync(elsewhere, "utf8"), "keep");
  const text = readFileSync(entry, "utf8");
  assert.ok(text.includes(`Exec="${join(app, "chrome")}" %U`));
  assert.doesNotMatch(text, /rm -rf/);
  assert.equal(readFileSync(join(home, "icons", "hicolor", "256x256", "apps", "pairbrowse.png"), "utf8"), "png 256x256");
  assert.equal(readFileSync(join(home, "icons", "hicolor", "scalable", "apps", "pairbrowse.svg"), "utf8"), "<svg/>");
  // A symlinked folder below the data home is refused.
  const home2 = temp("pb-desk-home2-");
  symlinkSync(temp("pb-desk-tgt-"), join(home2, "applications"));
  assert.throws(() => installDesktop(app, join(app, "chrome"), { browserDir, home: home2, defaultDir: browserDir }), /isn't a folder/);
  // An older build without PairBrowse-Desktop: nothing written.
  const old = temp("pb-desk-old-");
  assert.equal(installDesktop(old, join(old, "chrome"), { browserDir, home: join(old, "share") }), null);
  assert.ok(!existsSync(join(old, "share")));
});

function fakeLinuxArchive(version) {
  const dir = temp("pb-desk-arc-");
  const root = join(dir, "PairBrowse");
  mkdirSync(root, { recursive: true });
  fakeBuild(root);
  writeFileSync(join(root, "PairBrowse-build.json"), JSON.stringify({ product: "PairBrowse", version, platform: "linux", arch: "x64", binary: "chrome" }));
  const archive = join(dir, `pairbrowse-${version}-linux-x64.tar.xz`);
  execFileSync("tar", ["-cJf", archive, "-C", dir, "PairBrowse"]);
  writeFileSync(`${archive}.sha256`, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  ${archive.split("/").pop()}\n`);
  return archive;
}

test("a Linux install writes the desktop entry after its checks; a failed write doesn't fail it", async () => {
  const layout = nativeLayout("linux", "x64");
  const d = nativeDirs(layout);
  const home = temp("pb-desk-inst-");
  const logs = [];
  const opts = { check: async () => ["fake check"], register: true, layout, dataHome: home, config: { browser: "pairbrowse" }, log: (m) => logs.push(m) };
  assert.equal(await installNative(fakeLinuxArchive("150.0.2.1"), opts), d.exec);
  const entry = readFileSync(join(home, "applications", `${desktopId(d.dir)}.desktop`), "utf8");
  assert.ok(entry.includes(`Exec="${d.exec}" %U`));
  // No entry while the check fails: the build never committed.
  rmSync(join(home, "applications"), { recursive: true, force: true });
  await assert.rejects(installNative(fakeLinuxArchive("150.0.2.2"), { ...opts, check: async () => { throw new Error("no side panel"); } }), /no side panel/);
  assert.ok(!existsSync(join(home, "applications")));
  // A data home that can't be written: logged, the install still succeeds.
  const blocked = join(temp("pb-desk-blk-"), "file");
  writeFileSync(blocked, "");
  assert.equal(await installNative(fakeLinuxArchive("150.0.2.3"), { ...opts, dataHome: blocked }), d.exec);
  assert.match(logs.join("\n"), /couldn't install the desktop entry/);
  rmSync(d.app, { recursive: true, force: true });
  rmSync(d.previous, { recursive: true, force: true });
  rmSync(d.record, { force: true });
});
