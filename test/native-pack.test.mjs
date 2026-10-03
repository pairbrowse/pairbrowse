import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pb-pack-"));
process.env.PAIRBROWSE_HOME = home;
const { installEngine, loadEngine, engineDir, ensureEngine, NATIVE } = await import("../scripts/native-pack.mjs");
const { downloadPinned } = await import("../scripts/util.mjs");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// A stand-in engine pack as engine/build.mjs packs it: engine/{engine.mjs, collector.js, engine.json}.
function fakePack(version = "150.0.0.1") {
  const dir = mkdtempSync(join(tmpdir(), "pb-pack-src-"));
  const engine = join(dir, "engine");
  mkdirSync(engine);
  const files = {
    "engine.mjs": `export const DEFAULT_IGNORED_ARGS = ["--enable-automation"]; export const version = ${JSON.stringify(version)};\n`,
    "collector.js": "globalThis.collectFingerprint = async () => ({});\n",
  };
  for (const [name, data] of Object.entries(files)) writeFileSync(join(engine, name), data);
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ product: "PairBrowse engine", version }));
  const archive = join(dir, `pairbrowse-engine-${version}.tgz`);
  execFileSync("tar", ["-czf", archive, "-C", dir, "engine"]);
  const pins = Object.fromEntries(Object.entries(files).map(([name, data]) => [name, sha256(data)]));
  return { archive, pins, sha: sha256(readFileSync(archive)) };
}

test("an engine pack installs only when its archive and files match their pins", async () => {
  const pack = fakePack();
  await assert.rejects(installEngine(pack.archive, { sha256: "00".repeat(32), pins: pack.pins }), /doesn't match its SHA-256/);
  await assert.rejects(installEngine(pack.archive, { sha256: pack.sha, pins: { ...pack.pins, "engine.mjs": "11".repeat(32) } }), /engine\.mjs doesn't match/);
  assert.equal(existsSync(engineDir()), false, "nothing installed after a failed check");
  assert.equal(await installEngine(pack.archive, { sha256: pack.sha, pins: pack.pins }), engineDir());
  assert.equal(JSON.parse(readFileSync(join(engineDir(), "installed.json"), "utf8")).sha256, pack.sha);
  const loaded = await loadEngine(engineDir(), pack.pins);
  assert.deepEqual(loaded.DEFAULT_IGNORED_ARGS, ["--enable-automation"]);
  assert.match(loaded.collector, /collectFingerprint/);
});

test("a changed engine file isn't loaded", async () => {
  const pack = fakePack("150.0.0.2");
  await installEngine(pack.archive, { sha256: pack.sha, pins: pack.pins });
  writeFileSync(join(engineDir(), "collector.js"), "globalThis.collectFingerprint = async () => ({ changed: true });\n");
  await assert.rejects(loadEngine(engineDir(), pack.pins), /collector\.js doesn't match its pinned SHA-256/);
});

test("installing a new engine pack replaces the old one", async () => {
  const first = fakePack("150.0.0.3");
  await installEngine(first.archive, { sha256: first.sha, pins: first.pins });
  const second = fakePack("150.0.0.4");
  await installEngine(second.archive, { sha256: second.sha, pins: second.pins });
  assert.equal((await loadEngine(engineDir(), second.pins)).version, "150.0.0.4");
  assert.deepEqual(readdirSync(home).filter((n) => n.startsWith(".engine-")), [], "no staging left behind");
});

test("on start, the pinned engine pack is downloaded from the release once, then reused", async () => {
  const pack = fakePack("150.0.0.5");
  let requests = 0;
  const server = createServer((req, res) => {
    requests++;
    if (req.url !== `/${basename(pack.archive)}`) { res.writeHead(404); return res.end(); }
    res.end(readFileSync(pack.archive));
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const saved = { baseUrl: NATIVE.baseUrl, engine: NATIVE.engine };
  NATIVE.baseUrl = `http://127.0.0.1:${server.address().port}`;
  NATIVE.engine = { file: basename(pack.archive), sha256: pack.sha, files: pack.pins };
  try {
    assert.equal(await ensureEngine(), engineDir());
    assert.equal(await ensureEngine(), engineDir());
    assert.equal(requests, 1, "installed once, then reused");
    NATIVE.engine = { ...NATIVE.engine, sha256: "cd".repeat(32) };
    rmSync(join(home, "downloads"), { recursive: true, force: true });
    await assert.rejects(ensureEngine(), /isn't installed \(.*SHA-256\)\. Install it with: node .*native-install\.mjs/);
  } finally {
    Object.assign(NATIVE, saved);
    server.close();
  }
});

test("a download is kept only when it matches its pin", async () => {
  const server = createServer((_, res) => res.end("payload"));
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const dest = join(home, "dl", "file.bin");
  try {
    await assert.rejects(downloadPinned(url, dest, "00".repeat(32)), /doesn't match its pinned SHA-256/);
    assert.equal(existsSync(dest) || existsSync(`${dest}.part`), false, "nothing left behind");
    assert.equal(await downloadPinned(url, dest, sha256("payload")), dest);
    assert.equal(readFileSync(dest, "utf8"), "payload");
  } finally { server.close(); }
});

test.after(() => rmSync(home, { recursive: true, force: true }));
