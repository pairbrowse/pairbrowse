// The launch self-check a native build passes before it's kept (scripts/native/check.mjs): its
// failure paths up to the launch, with no browser. The runtime here looks installed and its
// driver is a stub that only notes a launch was asked for; the engine pack is missing or altered,
// so the check must refuse before any browser starts, and leave nothing behind.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "pb-nc-"));
process.env.PAIRBROWSE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { selfCheck } = await import("../scripts/native/check.mjs");
const { paths } = await import("../scripts/paths.mjs");
const { NATIVE } = await import("../scripts/native-pack.mjs");

const launched = join(home, "launched");
const runtimeModules = join(paths.runtime, "node_modules");
mkdirSync(join(runtimeModules, "@playwright", "mcp"), { recursive: true });
writeFileSync(join(paths.runtime, "package-lock.json"), readFileSync(join(root, "runtime", "package-lock.json")));

// The driver the check loads from the runtime: a stub whose launch only leaves a mark.
function stubDriver() {
  const dir = join(runtimeModules, "patchright");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "patchright", version: "0.0.0", main: "index.js", engines: { node: ">=18" } }));
  writeFileSync(join(dir, "index.js"), `const fs = require("node:fs");
const mark = () => { fs.writeFileSync(${JSON.stringify(launched)}, "1"); throw new Error("stub driver: no browser here"); };
exports.chromium = { launchPersistentContext: mark, launch: mark };
`);
}

// The engine pack, marked installed at the pinned version; files: name -> contents.
function enginePack(files) {
  rmSync(paths.engine, { recursive: true, force: true });
  mkdirSync(paths.engine, { recursive: true });
  writeFileSync(join(paths.engine, "installed.json"), JSON.stringify({ sha256: NATIVE.engine.sha256 }));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(paths.engine, name), body);
}

// A program that isn't a browser: the check must never get as far as running it.
const exec = join(home, "fake-build", "PairBrowse");
mkdirSync(dirname(exec), { recursive: true });
writeFileSync(exec, "#!/bin/sh\necho ran > \"$(dirname \"$0\")/ran\"\n", { mode: 0o755 });

const leftovers = () => (existsSync(paths.browser) ? readdirSync(paths.browser).filter((n) => n.startsWith(".selfcheck-")) : []);

test("no driver in the runtime: refused before anything is made", async () => {
  await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), /patchright|Cannot find module/);
  assert.deepEqual(leftovers(), []);
  assert.ok(!existsSync(launched));
});

// The build's manifest beside the program (a Linux or Windows layout).
const manifest = (m) => writeFileSync(join(dirname(exec), "PairBrowse-build.json"), JSON.stringify(m));
const MAJOR = NATIVE.version.split(".")[0];

test("a build without its manifest, or one for another product or Chromium: refused before any launch", async () => {
  stubDriver();
  enginePack({});
  await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), /PairBrowse-build\.json/);
  for (const bad of [{ product: "Chromium", version: `${MAJOR}.0.0.1`, platform: "linux" }, { product: "PairBrowse", version: "1.0.0.1", platform: "linux" }, { product: "PairBrowse", version: `${MAJOR}.0`, platform: "linux" }]) {
    manifest(bad);
    await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), new RegExp(`requires a Chromium ${MAJOR} PairBrowse build`), JSON.stringify(bad));
  }
  manifest({ product: "PairBrowse", version: `${MAJOR}.0.0.1` });
  await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), /names no platform/);
  assert.ok(!existsSync(launched));
  assert.deepEqual(leftovers(), []);
});

test("the engine pack missing a file: refused before any launch, the throwaway profile removed", async () => {
  stubDriver();
  manifest({ product: "PairBrowse", version: `${MAJOR}.0.0.1`, platform: "linux" });
  enginePack({ "collector.js": "x" });
  await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), /engine pack has no engine\.mjs/);
  assert.ok(!existsSync(launched), "no browser launch was asked for");
  assert.ok(!existsSync(join(dirname(exec), "ran")), "the build was never run");
  assert.deepEqual(leftovers(), [], "nothing left in the browser folder");
});

test("an engine pack file altered after install: refused by its pinned SHA-256", async () => {
  stubDriver();
  enginePack({ "engine.mjs": "export const launchNative = () => { throw new Error('altered'); };", "collector.js": "x" });
  await assert.rejects(selfCheck(exec, { config: {}, timeoutMs: 20_000 }), /engine\.mjs doesn't match its pinned SHA-256/);
  assert.ok(!existsSync(launched));
  assert.deepEqual(leftovers(), []);
});
