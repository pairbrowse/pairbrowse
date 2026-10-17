// The ad blocker the PairBrowse browser starts with (config "adBlocker", on by default): uBlock
// Origin Lite, shipped inside the app as the Chrome Web Store published it (the build manifest's
// adBlockerCrx), or, for a build without it, fetched from the store. The helper only names it in
// the profile; the browser itself checks the CRX's signature against the extension's id (only its
// developer's key gives that id) and installs it, and (native patch 593) starts it enabled. It
// updates from the store as any store extension. It is then the person's: they can turn it off or
// remove it in the browser's extensions page, and a removal sticks (the browser records it and
// never installs it from the entry again).
//
// macOS only: there the browser reads the profile's own "External Extensions" folder (the user
// data directory's), one <id>.json per extension.
import { readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../util.mjs";

export const AD_BLOCKER_ID = "ddkjiahejlhfcafbddmgiahcphecmpfh";
export const STORE_UPDATE_URL = "https://clients2.google.com/service/update2/crx";

// The CRX a build ships ({ path, version } from its manifest, path under Contents/Resources) as
// { file, version } for the browser at executablePath (.../Contents/MacOS/<name>), or null when
// the file isn't there.
export function shippedCrx(crx, executablePath) {
  if (!crx || typeof executablePath !== "string" || !executablePath) return null;
  const file = join(dirname(dirname(executablePath)), "Resources", crx.path);
  try { if (!statSync(file).isFile()) return null; } catch { return null; }
  return { file, version: crx.version };
}

// The entry: the shipped CRX (its absolute path, version, and that it is the store's), else the
// store's update URL.
const entryFor = (crx) => (crx
  ? { external_crx: crx.file, external_version: crx.version, is_from_webstore: true }
  : { external_update_url: STORE_UPDATE_URL });

// Writes (on) or removes (off) the ad blocker's entry in a profile (the user data directory).
// With it off the browser removes the extension at its next start. Returns true when it changed.
export function adBlockerFiles(profile, on, { id = AD_BLOCKER_ID, platform = process.platform, crx = null } = {}) {
  if (platform !== "darwin") return false;
  const file = join(profile, "External Extensions", `${id}.json`);
  if (!on) {
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  }
  const entry = entryFor(crx);
  let current = null;
  try { current = readFileSync(file, "utf8"); } catch { /* none yet */ }
  if (current === JSON.stringify(entry)) return false;
  writeJsonAtomic(file, entry, { indent: 0 });
  return true;
}
