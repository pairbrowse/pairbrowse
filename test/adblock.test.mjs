// The ad blocker the PairBrowse browser ships (browser/adblock.mjs): on macOS, a profile gets uBlock
// Origin Lite's External Extensions entry (the CRX inside the app, or for a build without one the
// store's update URL) and nothing else (its extension records are the browser's, signed); off
// removes the entry; Linux native builds the same (the CRX next to the binary); Windows gets no files.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adBlockerFiles, shippedCrx, AD_BLOCKER_ID, STORE_UPDATE_URL } from "../scripts/browser/adblock.mjs";
import { DEFAULT_CONFIG } from "../scripts/paths.mjs";

const mac = { platform: "darwin" };
const profile = () => mkdtempSync(join(tmpdir(), "pb-adblock-"));
const entry = (dir) => join(dir, "External Extensions", `${AD_BLOCKER_ID}.json`);
const secureFile = (dir) => join(dir, "Default", "Secure Preferences");

test("on by default", () => {
  assert.equal(DEFAULT_CONFIG.adBlocker, true);
});

test("a new profile: the store entry, no extension record", () => {
  const dir = profile();
  assert.equal(adBlockerFiles(dir, true, mac), true);
  assert.deepEqual(JSON.parse(readFileSync(entry(dir), "utf8")), { external_update_url: STORE_UPDATE_URL });
  assert.equal(STORE_UPDATE_URL, "https://clients2.google.com/service/update2/crx");
  assert.equal(existsSync(secureFile(dir)), false, "Secure Preferences untouched");
  assert.equal(adBlockerFiles(dir, true, mac), false, "nothing to change the second time");
});

test("off removes the entry; the browser removes the extension at its next start", () => {
  const dir = profile();
  adBlockerFiles(dir, true, mac);
  assert.equal(adBlockerFiles(dir, false, mac), true);
  assert.equal(existsSync(entry(dir)), false);
  assert.equal(adBlockerFiles(dir, false, mac), false);
});

test("macOS and Linux, not Windows", () => {
  const lin = profile();
  assert.equal(adBlockerFiles(lin, true, { platform: "linux" }), true);
  assert.deepEqual(JSON.parse(readFileSync(entry(lin), "utf8")), { external_update_url: STORE_UPDATE_URL });
  assert.equal(adBlockerFiles(lin, false, { platform: "linux" }), true);
  const dir = profile();
  assert.equal(adBlockerFiles(dir, true, { platform: "win32" }), false);
  assert.equal(existsSync(join(dir, "External Extensions")), false);
  assert.equal(existsSync(secureFile(dir)), false);
});

test("prepareProfile: only a build with its own pages, and only when asked", async () => {
  const { prepareProfile } = await import("../scripts/browser.mjs");
  if (process.platform !== "darwin") return;
  const ext = profile();
  prepareProfile(ext, undefined, { adBlocker: true });
  assert.equal(existsSync(entry(ext)), false, "not with the side panel extension");
  const own = profile();
  assert.equal(prepareProfile(own, undefined, { browserPages: true, adBlocker: true }), true, "still a new profile");
  assert.equal(existsSync(entry(own)), true);
  prepareProfile(own, undefined, { browserPages: true, adBlocker: false });
  assert.equal(existsSync(entry(own)), false);
});

test("the CRX the app ships: its absolute path and version, the store's, else the store's update URL", () => {
  const app = profile();
  const exe = join(app, "PairBrowse.app", "Contents", "MacOS", "pairbrowse");
  const rel = "PairBrowse-Extensions/uBlock-Origin-Lite.crx";
  assert.equal(shippedCrx({ path: rel, version: "1.2" }, exe, "darwin"), null, "no file there");
  mkdirSync(join(app, "PairBrowse.app", "Contents", "Resources", "PairBrowse-Extensions"), { recursive: true });
  writeFileSync(join(app, "PairBrowse.app", "Contents", "Resources", rel), "crx");
  const crx = shippedCrx({ path: rel, version: "1.2" }, exe, "darwin"); // the macOS app's layout, on any system
  // Linux: next to the executable.
  mkdirSync(join(app, "linux", "PairBrowse-Extensions"), { recursive: true });
  writeFileSync(join(app, "linux", rel), "crx");
  assert.deepEqual(shippedCrx({ path: rel, version: "1.2" }, join(app, "linux", "pairbrowse"), "linux"), { file: join(app, "linux", rel), version: "1.2" });
  assert.deepEqual(crx, { file: join(app, "PairBrowse.app", "Contents", "Resources", rel), version: "1.2" });
  assert.equal(shippedCrx(null, exe, "darwin"), null);
  const dir = profile();
  assert.equal(adBlockerFiles(dir, true, { ...mac, crx }), true);
  assert.deepEqual(JSON.parse(readFileSync(entry(dir), "utf8")), { external_crx: crx.file, external_version: "1.2", is_from_webstore: true });
  assert.equal(adBlockerFiles(dir, true, { ...mac, crx }), false);
  assert.equal(adBlockerFiles(dir, true, mac), true, "a build without it: the store's update URL");
  assert.deepEqual(JSON.parse(readFileSync(entry(dir), "utf8")), { external_update_url: STORE_UPDATE_URL });
});

test("Linux: the CRX under the binary's own directory, never outside it", () => {
  const root = profile();
  const exe = join(root, "pairbrowse", "pairbrowse");
  const rel = "PairBrowse-Extensions/uBlock-Origin-Lite.crx";
  assert.equal(shippedCrx({ path: rel, version: "1.2" }, exe, "linux"), null, "no file there");
  mkdirSync(join(root, "pairbrowse", "PairBrowse-Extensions"), { recursive: true });
  writeFileSync(join(root, "pairbrowse", rel), "crx");
  const crx = shippedCrx({ path: rel, version: "1.2" }, exe, "linux");
  assert.deepEqual(crx, { file: join(root, "pairbrowse", rel), version: "1.2" });
  assert.equal(shippedCrx({ path: rel, version: "1.2" }, exe, "darwin"), null, "the macOS layout looks in Contents/Resources");
  writeFileSync(join(root, "outside.crx"), "crx");
  assert.equal(shippedCrx({ path: "../outside.crx", version: "1.2" }, exe, "linux"), null, "no leaving the install directory");
  const dir = profile();
  assert.equal(adBlockerFiles(dir, true, { platform: "linux", crx }), true);
  assert.deepEqual(JSON.parse(readFileSync(entry(dir), "utf8")), { external_crx: crx.file, external_version: "1.2", is_from_webstore: true });
});
