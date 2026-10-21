// Where the PairBrowse browser's Safe Storage password (the key to its cookies and saved data on
// disk) comes from, per launch on macOS (config "safeStorage"):
// - "file" (default), a build with patch 594 (manifest safeStorageKeyFile): a random password in
//   the owner-only file ~/.pairbrowse/safe-storage-key, made here once, and the driver's mock
//   keychain left off. Never the Keychain, so never a prompt, and a key of this install's own.
// - "keychain": the macOS Keychain (the mock keychain left off, no file): the way for a notarized
//   build, whose Keychain entry stays its own across updates.
// - Otherwise (an older build, or a key file that fails a check): the driver's mock keychain, as
//   before: no prompt, but the engine's fixed test password.
// On Linux (a native build with safeStorageKeyFile): the same key file, the same checks, made here
// when missing; the driver's --password-store=basic stays, so no desktop keyring is ever asked
// (the browser's key-file provider comes before its fixed-key one). "keychain" means nothing there.
// A file that fails a check: the browser's fixed key, as before. Windows: as before.
//
// Saved cards (spec server-mode B12, decision U3): the engine encrypts a saved payment card with
// this same password, so a profile's payments.savedCard is honored only on a launch with a real
// key store (keyStoreOf): the macOS Keychain, or the per-install key file (checked before every
// launch: this user's regular file, mode 0600, no link, base64 only; made atomically, never over
// another file). The mock keychain's fixed test password and Linux's fixed built-in key are not
// one, nor is the open build. What the key file protects: a copied profile folder without it.
// What it doesn't: programs running as this user (they read the file as they read the profile),
// or root.
import { lstatSync, readFileSync, writeFileSync, chmodSync, linkSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";

// The browser takes 1-256 base64 characters (patch 594's ParsePassword), trailing whitespace trimmed.
const PASSWORD = /^[A-Za-z0-9+/=]{1,256}\s*$/;

// True when `file` holds a password the browser will use: this user's regular file, mode 0600, no
// link. A missing file is made (random, 0600, never over another file). False otherwise: then the
// browser would read the Keychain, so the caller keeps the mock keychain instead.
// The file is made whole or not at all: written under a fresh name beside it, then linked to its
// own name (which fails when anything is there already, so nothing is ever written over), so the
// browser or another helper never reads half a password.
export function ensureSafeStorageKey(file) {
  let st = null;
  try { st = lstatSync(file); } catch (e) { if (e?.code !== "ENOENT") return false; }
  if (!st) {
    const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, randomBytes(16).toString("base64") + "\n", { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600); // a umask can strip owner bits
      linkSync(tmp, file);
    } catch (e) { if (e?.code !== "EEXIST") { rmSync(tmp, { force: true }); return false; } }
    rmSync(tmp, { force: true });
    try { st = lstatSync(file); } catch { return false; }
  }
  if (!st.isFile() || (typeof process.getuid === "function" && st.uid !== process.getuid()) || (st.mode & 0o7777) !== 0o600) return false;
  try { return PASSWORD.test(readFileSync(file, "utf8")); } catch { return false; }
}

// { keyFile: path or null, mock: whether the driver's --use-mock-keychain stays } for a launch.
// macOS and Linux (patch 594's key providers); elsewhere the mock keychain stays. On Linux `mock`
// stays true: the driver's defaults (--password-store=basic, and a mock keychain switch Linux
// ignores) are left as they are.
export function safeStorageFor(config, shell, file, platform = process.platform) {
  if (!["darwin", "linux"].includes(platform) || !shell?.ownPages || !shell?.safeStorageKeyFile) return { keyFile: null, mock: true };
  if (platform === "linux") return { keyFile: ensureSafeStorageKey(file) ? file : null, mock: true };
  if (config?.safeStorage === "keychain") return { keyFile: null, mock: false };
  return ensureSafeStorageKey(file) ? { keyFile: file, mock: false } : { keyFile: null, mock: true };
}

// The real key store a launch's Safe Storage (safeStorageFor's answer) encrypts saved data with:
// "keychain" (macOS, the Keychain), "key-file" (the per-install key file, macOS or Linux; decision
// U3 accepts it), or "" (the mock keychain's fixed test password, Linux's fixed built-in key, or
// another system: no key store a saved card may count on).
export function keyStoreOf(storage, platform = process.platform) {
  if (!storage || !["darwin", "linux"].includes(platform)) return "";
  if (typeof storage.keyFile === "string" && storage.keyFile) return "key-file";
  return platform === "darwin" && storage.mock === false ? "keychain" : "";
}

// The status line's words when a profile asks for a saved card and the launch has no key store.
export const SAVED_CARD_REFUSED = "saved card refused: this browser has no key store for it";
// Whether a launch turns payment autofill on (spec server-mode B12): asked (the session's profile
// has payments.savedCard), native (the native PairBrowse build starts; the open build is always
// refused), storage (safeStorageFor's answer for this launch). Pure. Answers { asked, on, store,
// line }: on only with a real key store (keyStoreOf); line: the status part ("" when not asked).
export function savedCardFor({ asked = false, native = false, storage = null, platform = process.platform } = {}) {
  if (!asked) return { asked: false, on: false, store: "", line: "" };
  const store = native ? keyStoreOf(storage, platform) : "";
  if (!store) {
    const why = !native ? "PairBrowse as an extension" : !["darwin", "linux"].includes(platform) ? "no key store on this system" : "only the browser's fixed key: the key file ~/.pairbrowse/safe-storage-key failed a check, or this build can't read one";
    return { asked: true, on: false, store: "", line: `${SAVED_CARD_REFUSED} (${why}); payment autofill stays off` };
  }
  return { asked: true, on: true, store, line: `Saved card: on (encrypted with ${store === "keychain" ? "the macOS Keychain" : "this install's key file"}); only you fill it, during a hand-off` };
}
