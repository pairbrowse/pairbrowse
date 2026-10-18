// Where the PairBrowse browser's Safe Storage password (the key to its cookies and saved data on
// disk) comes from, per launch on macOS (config "safeStorage"):
// - "file" (default), a build with patch 594 (manifest safeStorageKeyFile): a random password in
//   the owner-only file ~/.pairbrowse/safe-storage-key, made here once, and the driver's mock
//   keychain left off. Never the Keychain, so never a prompt, and a key of this install's own.
// - "keychain": the macOS Keychain (the mock keychain left off, no file): the way for a notarized
//   build, whose Keychain entry stays its own across updates.
// - Otherwise (an older build, or a key file that fails a check): the driver's mock keychain, as
//   before: no prompt, but the engine's fixed test password.
import { lstatSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";

// The browser takes 1-256 base64 characters (patch 594's ParsePassword), trailing whitespace trimmed.
const PASSWORD = /^[A-Za-z0-9+/=]{1,256}\s*$/;

// True when `file` holds a password the browser will use: this user's regular file, mode 0600, no
// link. A missing file is made (random, 0600, never over another file). False otherwise: then the
// browser would read the Keychain, so the caller keeps the mock keychain instead.
export function ensureSafeStorageKey(file) {
  let st = null;
  try { st = lstatSync(file); } catch (e) { if (e?.code !== "ENOENT") return false; }
  if (!st) {
    try {
      writeFileSync(file, randomBytes(16).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
      chmodSync(file, 0o600); // a umask can strip owner bits
    } catch (e) { if (e?.code !== "EEXIST") return false; }
    try { st = lstatSync(file); } catch { return false; }
  }
  if (!st.isFile() || (typeof process.getuid === "function" && st.uid !== process.getuid()) || (st.mode & 0o7777) !== 0o600) return false;
  try { return PASSWORD.test(readFileSync(file, "utf8")); } catch { return false; }
}

// { keyFile: path or null, mock: whether the driver's --use-mock-keychain stays } for a launch.
// macOS only: patch 594 is the macOS key provider's; elsewhere the mock keychain stays.
export function safeStorageFor(config, shell, file, platform = process.platform) {
  if (platform !== "darwin" || !shell?.ownPages || !shell?.safeStorageKeyFile) return { keyFile: null, mock: true };
  if (config?.safeStorage === "keychain") return { keyFile: null, mock: false };
  return ensureSafeStorageKey(file) ? { keyFile: file, mock: false } : { keyFile: null, mock: true };
}
