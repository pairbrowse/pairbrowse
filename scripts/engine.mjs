import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { launchNative, nativeManifest } from "./native-engine.mjs";
import { ensureEngine, loadEngine } from "./native-pack.mjs";
import { PATCHRIGHT_NODE_MINIMUM } from "./driver.mjs";

export function validateEngine(config, nodeVersion = process.versions.node) {
  const engine = config.browserEngine ?? "chromium";
  if (!["chromium", "pairbrowse"].includes(engine)) throw new Error(`Unknown browserEngine: ${engine}`);
  if (engine === "chromium") return engine;
  if (Number(nodeVersion.split(".")[0]) < PATCHRIGHT_NODE_MINIMUM) throw new Error(`PairBrowse native requires Node.js ${PATCHRIGHT_NODE_MINIMUM} or newer.`);
  if (typeof config.executablePath !== "string" || !isAbsolute(config.executablePath) || !existsSync(config.executablePath)) throw new Error("PairBrowse native requires an installed executablePath.");
  nativeManifest(config.executablePath);
  return engine;
}

// The native browser keeps its own profile: never open the Chromium one with it.
export function engineProfile(config, profile) {
  return config.browserEngine === "pairbrowse" ? join(profile, "pairbrowse-native") : profile;
}

// loadPack: the native engine pack's helpers (tests pass their own); default: the pinned pack,
// installed first when it isn't yet (scripts/native-pack.mjs).
export async function launchEngine(chromium, config, profile, options, log = () => {}, loadPack) {
  const engine = validateEngine(config);
  if (engine === "chromium") return chromium.launchPersistentContext(profile, {
    ...options,
    ignoreDefaultArgs: [...new Set([...(options.ignoreDefaultArgs || []), "--enable-automation"])],
    args: [...(options.args || []), "--disable-blink-features=AutomationControlled"],
  });
  const pack = loadPack ? await loadPack() : await loadEngine(await ensureEngine(log));
  return launchNative(chromium, config, profile, options, pack, log);
}
