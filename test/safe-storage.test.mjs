// The Safe Storage key file (browser/safe-storage.mjs): made once, random, owner-only; a file the
// browser wouldn't use (a link, wrong mode, someone else's, not base64) keeps the mock keychain, so
// the browser never falls back to the Keychain and never asks.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSafeStorageKey, safeStorageFor } from "../scripts/browser/safe-storage.mjs";

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
