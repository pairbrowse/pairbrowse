import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { launchNative, nativeManifest } from "./native-engine.mjs";
import { ensureEngine, loadEngine } from "./native/pack.mjs";
import { PATCHRIGHT_NODE_MINIMUM } from "./driver.mjs";
import { sandboxOffAllowed, sandboxOffAsked, sandboxRefusal, withoutNoSandbox } from "./browser-args.mjs";

// The launch layer's engine (browserEngine, from browser/choice.mjs engineConfig): "open" (the
// open build, or a browser of your own on the same engine) or "pairbrowse" (a native build).
// "chromium", the older name for "open", is still read.
export function validateEngine(config, nodeVersion = process.versions.node) {
  const given = config.browserEngine ?? "open";
  const engine = given === "chromium" ? "open" : given;
  if (!["open", "pairbrowse"].includes(engine)) throw new Error(`Unknown browserEngine: ${given}`);
  if (engine === "open") return engine;
  if (Number(nodeVersion.split(".")[0]) < PATCHRIGHT_NODE_MINIMUM) throw new Error(`PairBrowse native requires Node.js ${PATCHRIGHT_NODE_MINIMUM} or newer.`);
  if (typeof config.executablePath !== "string" || !isAbsolute(config.executablePath) || !existsSync(config.executablePath)) throw new Error("PairBrowse native requires an installed executablePath.");
  nativeManifest(config.executablePath);
  return engine;
}

// The native browser keeps its own profile: never open the open build's one with it.
export const nativeProfile = (profile) => join(profile, "pairbrowse-native");
export function engineProfile(config, profile) {
  return config.browserEngine === "pairbrowse" ? nativeProfile(profile) : profile;
}

// The browser's own sandbox (renderer and GPU processes walled off from the computer). On macOS
// and Windows it is always on: "browserSandbox": false or a --no-sandbox in browserArgs (any
// spelling; their older names chromeSandbox and chromeArgs alike) is refused, and the refusal is
// logged and named in pairbrowse_status. On Linux it is on unless one of those turns it off; the
// engine refuses it as root, so it's off there; and where the kernel or container gives it
// nothing to work with (no user namespaces, Docker's default seccomp profile), the launch fails
// and runs again without it (launchEngine). Off, the log, pairbrowse_status and the browser's bar
// say so (SANDBOX_OFF_WARNING).
// { on, reason: why it's off, refused: why a request to turn it off was refused }
export function sandboxDecision(config = {}, { platform = process.platform, uid = process.getuid?.() } = {}) {
  const asked = sandboxOffAsked(config, platform);
  if (!sandboxOffAllowed(platform)) return { on: true, reason: null, refused: asked ? sandboxRefusal(asked, platform) : null };
  if (asked) return { on: false, reason: asked, refused: null };
  if (uid === 0) return { on: false, reason: "running as root, where the browser refuses its sandbox", refused: null };
  return { on: true, reason: null, refused: null };
}

// This helper's browser's sandbox as last launched (pairbrowse_status and the bar read it).
export const SANDBOX = { on: true, reason: null, refused: null };

// The messages the engine (and Playwright's rewrite of them) gives when it can't start its sandbox.
// Without user namespaces (a container, or Ubuntu's AppArmor rule against them) the engine turns to
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
// installed first when it isn't yet (scripts/native-pack.mjs). browserType: the driver's browser
// type (Playwright's chromium object).
export async function launchEngine(browserType, config, profile, options, log = () => {}, loadPack, { platform = process.platform } = {}) {
  const engine = validateEngine(config);
  const sandbox = sandboxDecision(config, { platform });
  Object.assign(SANDBOX, sandbox);
  if (sandbox.refused) noteOnce(log, `The browser's sandbox stays on: ${sandbox.refused}`);
  if (!sandbox.on) noteOnce(log, `The browser's sandbox is off: ${sandbox.reason}`);
  const pack = engine === "open" ? null : loadPack ? await loadPack() : await loadEngine(await ensureEngine(log));
  const start = (off) => {
    // Never off outside Linux, whatever asked; and a sandbox that's on gets no --no-sandbox from
    // any launch option (the driver alone adds it, and only when off).
    const chromiumSandbox = !(off && sandboxOffAllowed(platform));
    const opts = { ...options, chromiumSandbox, ...(chromiumSandbox ? { args: withoutNoSandbox(options.args, platform) } : {}) };
    if (engine !== "open") return launchNative(browserType, config, profile, opts, pack, log);
    return browserType.launchPersistentContext(profile, {
      ...opts,
      ignoreDefaultArgs: [...new Set([...(options.ignoreDefaultArgs || []), "--enable-automation"])],
      args: [...(opts.args || []), "--disable-blink-features=AutomationControlled"],
    });
  };
  if (!sandbox.on) return start(true);
  try {
    return await start(false);
  } catch (e) {
    // Only Linux falls back (containers and AppArmor take away what its sandbox needs). On macOS
    // and Windows the sandbox always works: a failure there is an error to show, never a quiet
    // launch without it.
    if (!sandboxOffAllowed(platform) || !SANDBOX_FAILED.test(String(e?.message || e))) throw e;
    noteOnce(log, "The browser's sandbox is off: this system can't run it (no user namespaces: a container or an AppArmor rule blocks them); set \"browserSandbox\": false in config.json to skip the first try");
    Object.assign(SANDBOX, { on: false, reason: "this system can't run it (no user namespaces)", refused: null });
    return start(true);
  }
}
