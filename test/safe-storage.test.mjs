// The Safe Storage key file (browser/safe-storage.mjs): made once, random, owner-only; a file the
// browser wouldn't use (a link, wrong mode, someone else's, not base64) keeps the mock keychain, so
// the browser never falls back to the Keychain and never asks. The key store a saved card counts on
// (spec server-mode B12, U3): the Keychain or this key file, never a fixed key or the open build.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, chmodSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSafeStorageKey, safeStorageFor, keyStoreOf, savedCardFor, SAVED_CARD_REFUSED } from "../scripts/browser/safe-storage.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "pb-safe-storage-"));
const can = { ownPages: true, safeStorageKeyFile: true };

test("made once: random base64, 0600", () => {
  const file = join(dir(), "key");
  assert.equal(ensureSafeStorageKey(file), true);
  const first = readFileSync(file, "utf8");
  assert.match(first, /^[A-Za-z0-9+/=]{24}\n$/);
  assert.equal(ensureSafeStorageKey(file), true);
  assert.equal(readFileSync(file, "utf8"), first);
  assert.notEqual(readFileSync((() => { const f = join(dir(), "key"); ensureSafeStorageKey(f); return f; })(), "utf8"), first, "each install its own");
});

test("a file the browser wouldn't use keeps the mock keychain and is left alone", () => {
  const d = dir();
  const wide = join(d, "wide"); writeFileSync(wide, "abc\n"); chmodSync(wide, 0o644);
  const bad = join(d, "bad"); writeFileSync(bad, "not base64!\n", { mode: 0o600 });
  const target = join(d, "target"); writeFileSync(target, "abc\n", { mode: 0o600 });
  const link = join(d, "link"); symlinkSync(target, link);
  for (const f of [wide, bad, link]) {
    assert.equal(ensureSafeStorageKey(f), false, f);
    assert.deepEqual(safeStorageFor({}, can, f, "darwin"), { keyFile: null, mock: true });
  }
  assert.equal(readFileSync(bad, "utf8"), "not base64!\n");
});

test("the choice: file, keychain, or the mock for builds without 594", () => {
  const file = join(dir(), "key");
  assert.deepEqual(safeStorageFor({}, can, file, "darwin"), { keyFile: file, mock: false });
  assert.deepEqual(safeStorageFor({ safeStorage: "keychain" }, can, file, "darwin"), { keyFile: null, mock: false });
  assert.deepEqual(safeStorageFor({}, { ownPages: true }, file), { keyFile: null, mock: true });
  assert.deepEqual(safeStorageFor({}, { safeStorageKeyFile: true }, file), { keyFile: null, mock: true });
  assert.deepEqual(safeStorageFor({}, can, file, "win32"), { keyFile: null, mock: true }, "not on Windows");
});

test("Linux: the same key file, the driver's defaults (--password-store=basic) left as they are", () => {
  const file = join(dir(), "key");
  assert.deepEqual(safeStorageFor({}, can, file, "linux"), { keyFile: file, mock: true });
  assert.match(readFileSync(file, "utf8"), /^[A-Za-z0-9+/=]{24}\n$/);
  assert.deepEqual(safeStorageFor({ safeStorage: "keychain" }, can, file, "linux"), { keyFile: file, mock: true }, "no keyring on Linux");
  assert.deepEqual(safeStorageFor({}, { ownPages: true }, join(dir(), "key"), "linux"), { keyFile: null, mock: true }, "a build without 594");
  const wide = join(dir(), "wide"); writeFileSync(wide, "abc\n"); chmodSync(wide, 0o644);
  assert.deepEqual(safeStorageFor({}, can, wide, "linux"), { keyFile: null, mock: true }, "a bad file: the browser's fixed key, as before");
});

test("made whole or not at all (U3): no leftover beside it, never over a file that is there, owner-only", () => {
  const d = dir();
  const file = join(d, "key");
  assert.equal(ensureSafeStorageKey(file), true);
  assert.deepEqual(readdirSync(d), ["key"], "the temporary name is gone");
  assert.equal(statSync(file).mode & 0o7777, 0o600);
  // A file already there (another helper's, made a moment ago) is kept as it is.
  const other = join(d, "other");
  writeFileSync(other, "c29tZWtleQ==\n", { mode: 0o600 });
  assert.equal(ensureSafeStorageKey(other), true);
  assert.equal(readFileSync(other, "utf8"), "c29tZWtleQ==\n");
  assert.deepEqual(readdirSync(d).sort(), ["key", "other"]);
});

test("a saved card's key store: the Keychain or the per-install key file, never a fixed key", () => {
  const file = join(dir(), "key");
  assert.equal(keyStoreOf(safeStorageFor({}, can, file, "darwin"), "darwin"), "key-file");
  assert.equal(keyStoreOf(safeStorageFor({ safeStorage: "keychain" }, can, file, "darwin"), "darwin"), "keychain");
  assert.equal(keyStoreOf(safeStorageFor({}, can, file, "linux"), "linux"), "key-file", "U3: the key file counts on Linux");
  assert.equal(keyStoreOf(safeStorageFor({}, { ownPages: true }, file, "darwin"), "darwin"), "", "the mock keychain's fixed test password");
  assert.equal(keyStoreOf(safeStorageFor({}, { ownPages: true }, file, "linux"), "linux"), "", "Linux's fixed built-in key");
  assert.equal(keyStoreOf(safeStorageFor({}, can, file, "win32"), "win32"), "");
  const wide = join(dir(), "wide"); writeFileSync(wide, "abc\n"); chmodSync(wide, 0o644);
  assert.equal(keyStoreOf(safeStorageFor({}, can, wide, "linux"), "linux"), "", "a key file that fails a check");
  assert.equal(keyStoreOf(null, "darwin"), "");
});

test("savedCardFor: on only when asked, on the native build, with a real key store; otherwise a status line and autofill off", () => {
  const file = join(dir(), "key");
  const real = safeStorageFor({}, can, file, "linux");
  assert.deepEqual(savedCardFor({ asked: false, native: true, storage: real, platform: "linux" }), { asked: false, on: false, store: "", line: "" });
  const on = savedCardFor({ asked: true, native: true, storage: real, platform: "linux" });
  assert.equal(on.on, true);
  assert.equal(on.store, "key-file");
  assert.match(on.line, /^Saved card: on \(encrypted with this install's key file\)/);
  assert.match(savedCardFor({ asked: true, native: true, storage: safeStorageFor({ safeStorage: "keychain" }, can, file, "darwin"), platform: "darwin" }).line, /the macOS Keychain/);
  for (const [why, args] of [
    ["the open build", { native: false, storage: real, platform: "linux" }],
    ["a fixed key", { native: true, storage: safeStorageFor({}, { ownPages: true }, file, "linux"), platform: "linux" }],
    ["the mock keychain", { native: true, storage: safeStorageFor({}, { ownPages: true }, file, "darwin"), platform: "darwin" }],
    ["Windows", { native: true, storage: { keyFile: null, mock: true }, platform: "win32" }],
  ]) {
    const r = savedCardFor({ asked: true, ...args });
    assert.equal(r.on, false, why);
    assert.equal(r.store, "", why);
    assert.ok(r.line.startsWith(SAVED_CARD_REFUSED), why);
    assert.match(r.line, /payment autofill stays off$/, why);
  }
});
