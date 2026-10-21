// The native Linux build installed inside the container the way the helper's install step installs
// it (scripts/native/install.mjs ensureNative: the archive from the home's downloads, its SHA-256,
// the manifest, the launch self-check on a virtual screen of its own, the engine pack), from the
// pinned archives mounted at /cache (native-cache.mjs). The install runs in a process of its own
// on an install home (PB_INSTALL_HOME, kept between a developer's reruns), since paths.mjs fixes
// the home as it loads. Answers { exe, version, engine (the installed pack's folder), home }.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NATIVE } from "../../../scripts/native-pack.mjs";

export async function installNativeLinux({ cache = "/cache", runtime = "/runtime", repo = "/repo", home = process.env.PB_INSTALL_HOME || join(tmpdir(), "pb-native-install"), log = (m) => process.stderr.write(`install: ${m}\n`) } = {}) {
  mkdirSync(join(home, "downloads"), { recursive: true, mode: 0o700 });
  if (!existsSync(join(home, "runtime"))) symlinkSync(runtime, join(home, "runtime"), "dir");
  writeFileSync(join(home, "config.json"), JSON.stringify({ browser: "pairbrowse" }));
  for (const asset of [NATIVE.linux, NATIVE.engine]) {
    const src = join(cache, asset.file), dest = join(home, "downloads", asset.file);
    if (existsSync(src) && !existsSync(dest)) copyFileSync(src, dest);
  }
  const script = `const { ensureNative } = await import(${JSON.stringify(`${repo}/scripts/native/install.mjs`)});
const { nativeManifest } = await import(${JSON.stringify(`${repo}/scripts/native-engine.mjs`)});
const exe = await ensureNative((m) => process.stderr.write("install: " + m + "\\n"));
console.log("EXE " + JSON.stringify({ exe, version: exe ? nativeManifest(exe).version : null }));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, PAIRBROWSE_HOME: home }, encoding: "utf8", maxBuffer: 64 << 20, timeout: 1_500_000 });
  for (const line of String(r.stderr || "").split("\n").filter(Boolean)) log(line.replace(/^install: /, ""));
  const m = /^EXE (\{.*\})$/m.exec(String(r.stdout || ""));
  const found = m ? JSON.parse(m[1]) : null;
  if (r.status !== 0 || !found?.exe) throw new Error(`the native build didn't install:\n${String(r.stdout || "").slice(-2000)}\n${String(r.stderr || "").slice(-3000)}`);
  return { exe: found.exe, version: found.version, engine: join(home, "engine"), home };
}
