// Property-based fuzzing of what the native install step reads from a downloaded build: its
// build manifest (native-engine.mjs nativeManifest), whether it fits this computer (native/
// install.mjs buildFits), the chips its program names (machoArchs), and the SHA-256 side file
// next to an archive (expectedSha256). Each either refuses with a plain Error or returns only
// what was checked; none throws a TypeError on a malformed file.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { nativeManifest } from "../../scripts/native-engine.mjs";
import { buildFits, machoArchs, expectedSha256, nativeLayout } from "../../scripts/native/install.mjs";
import { NATIVE } from "../../scripts/native-pack.mjs";

const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property, runs = RUNS) => fc.assert(property, { numRuns: runs });
const dir = mkdtempSync(join(tmpdir(), "pb-fuzz-native-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

// A refusal is a plain Error (a sentence), or a SyntaxError for a file that isn't JSON at all.
const refuses = (fn) => { try { return { ok: fn() }; } catch (e) { assert.ok(e instanceof Error && (e.constructor === Error || e instanceof SyntaxError), `${e?.constructor?.name}: ${e?.message}`); return { error: e }; } };
const MAJOR = NATIVE.version.split(".")[0];
const version = fc.oneof(fc.tuple(fc.constantFrom(MAJOR, "1", "999"), fc.nat(), fc.nat(), fc.nat()).map((p) => p.join(".")), fc.string({ maxLength: 20 }), fc.integer(), fc.constant(null), fc.array(fc.string()), fc.constant({ split: 1 }));
const manifest = fc.oneof(fc.anything(), fc.record({ product: fc.constantFrom("PairBrowse", "pairbrowse", "", 1), version, platform: fc.oneof(fc.constantFrom("linux", "windows", "macos", "__proto__"), fc.anything()), arch: fc.oneof(fc.constantFrom("x64", "arm64", "x86_64", ""), fc.anything()) }, { requiredKeys: [] }));

// Property: a Linux or Windows build's manifest comes back only as a PairBrowse build of the
// pinned engine major with a four-part version and a known platform; anything else refuses.
test("a build manifest: checked, or refused with a sentence", () => {
  const exec = join(dir, "chrome");
  check(fc.property(fc.oneof(manifest.map((m) => JSON.stringify(m) ?? ""), fc.string({ maxLength: 40 })), (text) => {
    writeFileSync(join(dir, "PairBrowse-build.json"), text);
    const r = refuses(() => nativeManifest(exec));
    if (r.error) return;
    assert.equal(r.ok.product, "PairBrowse");
    assert.match(r.ok.version, new RegExp(`^${MAJOR}\\.\\d+\\.\\d+\\.\\d+$`));
    assert.ok(["linux", "windows"].includes(r.ok.platform));
  }), Math.min(RUNS, 2000));
});

// Property: a build fits only when its manifest names this chip and platform (on macOS: its
// program is a Mach-O for this chip); otherwise a sentence, never a TypeError.
test("a build fits only this computer's platform and chip", () => {
  const layouts = [nativeLayout("darwin", "arm64"), nativeLayout("darwin", "x64"), nativeLayout("linux", "x64"), nativeLayout("win32", "x64")];
  const macho = fc.oneof(fc.constant(null), fc.array(fc.constantFrom("arm64", "x86_64", "other"), { maxLength: 3 }));
  check(fc.property(manifest, fc.constantFrom(...layouts), macho, (m, layout, archs) => {
    const r = refuses(() => buildFits(m, layout, archs));
    if (r.error) return;
    assert.equal(m.arch, layout.arch);
    if (layout.platform === "macos") { assert.ok(m.platform === undefined || m.platform === "macos"); assert.ok(archs.includes(layout.arch)); }
    else assert.equal(m.platform, layout.platform);
  }));
});

// Property: any file is a Mach-O program of known chips (one to 16 of them) or null; never thrown.
test("the chips a program names: from any bytes, a short list or null", () => {
  const file = join(dir, "program");
  const fat = fc.tuple(fc.constantFrom(0xcafebabe, 0xcafebabf), fc.integer({ min: 0, max: 40 }), fc.uint8Array({ maxLength: 300 })).map(([magic, n, rest]) => { const b = Buffer.alloc(8); b.writeUInt32BE(magic, 0); b.writeUInt32BE(n, 4); return Buffer.concat([b, Buffer.from(rest)]); });
  const thin = fc.tuple(fc.integer({ min: 0, max: 0xffffffff }), fc.uint8Array({ maxLength: 20 })).map(([cpu, rest]) => { const b = Buffer.alloc(8); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4); return Buffer.concat([b, Buffer.from(rest)]); });
  check(fc.property(fc.oneof(fat, thin, fc.uint8Array({ maxLength: 64 }).map((b) => Buffer.from(b))), (bytes) => {
    writeFileSync(file, bytes);
    const r = machoArchs(file);
    if (r === null) return;
    assert.ok(Array.isArray(r) && r.length >= 1 && r.length <= 16);
    for (const a of r) assert.ok(["arm64", "x86_64", "other"].includes(a));
  }), Math.min(RUNS, 2000));
  assert.equal(machoArchs(join(dir, "missing")), null);
});

// Property: an archive's SHA-256 is 64 lowercase hex characters from its side file (naming this
// archive, or nothing) or as given; anything else refuses.
test("an archive's SHA-256 from its side file: 64 hex, for this archive, or refused", () => {
  const archive = join(dir, "PairBrowse-1.zip");
  const hex = fc.stringMatching(/^[0-9a-fA-F]{64}$/);
  const side = fc.oneof(fc.string({ maxLength: 100 }), fc.tuple(fc.oneof(hex, fc.string({ maxLength: 70 })), fc.constantFrom("", "  PairBrowse-1.zip", " *PairBrowse-1.zip", "  other.zip", "\tPairBrowse-1.zip\n", "  ../PairBrowse-1.zip")).map(([h, n]) => h + n));
  check(fc.property(side, fc.oneof(fc.constant(undefined), hex, fc.string({ maxLength: 70 })), (text, given) => {
    writeFileSync(`${archive}.sha256`, text);
    const r = refuses(() => expectedSha256(archive, given));
    if (r.error) return;
    assert.match(r.ok, /^[0-9a-f]{64}$/);
    if (given !== undefined) assert.equal(r.ok, String(given).toLowerCase());
    else { const name = text.trim().split(/\s+/)[1]; assert.ok(!name || name.replace(/^\*/, "") === "PairBrowse-1.zip"); }
  }), Math.min(RUNS, 2000));
});
