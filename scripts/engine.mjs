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

// Chromium's own sandbox (renderer and GPU processes walled off from the computer) is on unless
// "chromeSandbox": false or a --no-sandbox in chromeArgs turns it off. On Linux, Chromium refuses
// it as root, so it's off there; and where the kernel or container gives it nothing to work with
// (no user namespaces, Docker's default seccomp profile), the launch fails and runs again
// without it (launchEngine). Either way the log says so once.
export function sandboxDecision(config = {}, { platform = process.platform, uid = process.getuid?.() } = {}) {
  if (config.chromeSandbox === false) return { on: false, reason: "chromeSandbox is false in config.json" };
  if ((config.chromeArgs || []).includes("--no-sandbox")) return { on: false, reason: "chromeArgs has --no-sandbox" };
  if (platform === "linux" && uid === 0) return { on: false, reason: "running as root, where Chromium refuses its sandbox" };
  return { on: true, reason: null };
}

// The messages Chromium (and Playwright's rewrite of them) gives when it can't start its sandbox.
// Without user namespaces (a container, or Ubuntu's AppArmor rule against them) Chromium turns to
// its setuid helper, chrome-sandbox, which a browser unpacked by a user can't have (root-owned,
// mode 4755): it then aborts with "The SUID sandbox helper binary was found, but is not configured correctly".
export const SANDBOX_FAILED = /No usable sandbox|sandboxing failed|crbug\.com\/(638180|357670)|SUID sandbox helper binary/i;

const noted = new Set();
function noteOnce(log, text) {
  if (noted.has(text)) return;
  noted.add(text);
  log(text);
}

// loadPack: the native engine pack's helpers (tests pass their own); default: the pinned pack,
// installed first when it isn't yet (scripts/native-pack.mjs).
export async function launchEngine(chromium, config, profile, options, log = () => {}, loadPack) {
  const engine = validateEngine(config);
  const sandbox = sandboxDecision(config);
  if (!sandbox.on) noteOnce(log, `Chromium sandbox off: ${sandbox.reason}`);
  const pack = engine === "chromium" ? null : loadPack ? await loadPack() : await loadEngine(await ensureEngine(log));
  const start = (chromiumSandbox) => {
    const opts = { ...options, chromiumSandbox };
    if (engine !== "chromium") return launchNative(chromium, config, profile, opts, pack, log);
    return chromium.launchPersistentContext(profile, {
      ...opts,
      ignoreDefaultArgs: [...new Set([...(options.ignoreDefaultArgs || []), "--enable-automation"])],
      args: [...(options.args || []), "--disable-blink-features=AutomationControlled"],
    });
  };
  if (!sandbox.on) return start(false);
  try {
    return await start(true);
  } catch (e) {
    if (!SANDBOX_FAILED.test(String(e?.message || e))) throw e;
    noteOnce(log, "Chromium sandbox off: this system can't run it (no user namespaces: a container or an AppArmor rule blocks them); set \"chromeSandbox\": false in config.json to skip the first try");
    return start(false);
  }
}
