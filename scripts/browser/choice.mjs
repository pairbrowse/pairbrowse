// Which browser the helper launches, as two separate things:
// - the binary: what program runs. "open" (the PairBrowse open build: the pinned UNGOOGLED build on
//   macOS, Playwright's elsewhere; ensureBrowser in browser.mjs), "custom" (a browser of your own
//   on the same engine, by its path) or "native" (a native PairBrowse build with its engine pack:
//   the pinned one, installed and checked by native-install.mjs, or one of your own by its path);
// - the shell: what draws PairBrowse's own UI. "extension" (the side panel extension in ui/, for
//   every binary but a native build that declares its own pages) or "pages" (the build's
//   chrome://pairbrowse pages, its manifest's `chrome` field), with or without its own capture
//   page (`capture`) and that page's own key (`capture` 2 and up).
// chooseBrowser is the one place the "browser" setting and its older names (the value
// "chromium", browserEngine, executablePath) are read. Pure: file checks come in as functions,
// and nothing is written back into config (the choice lives in the helper's context,
// daemon/context.mjs). The launch layer (engine.mjs) speaks browserEngine: engineConfig gives it
// a copy that does.
import { accessSync, statSync, constants as fsConstants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { nativeManifest, declaresOwnPages, capturePages, captureKeyed, settingsSection, quietTabs, adBlocker, adBlockerCrx, safeStorageKeyFile } from "../native-engine.mjs";

// The config value for the open build, and its older name (still read, never written).
export const OPEN_BROWSER = "pairbrowse-open";
export const OPEN_BROWSER_ALIASES = Object.freeze([OPEN_BROWSER, "chromium"]);
export const isOpenBrowser = (value) => OPEN_BROWSER_ALIASES.includes(value);
// The open build's name in words.
export const OPEN_BROWSER_NAME = "PairBrowse (open build)";

// Which browser PairBrowse runs (config "browser"): "pairbrowse" (the native build),
// "pairbrowse-open" (older name "chromium": ensureBrowser in browser.mjs, the pinned UNGOOGLED build on
// macOS and Playwright's build elsewhere, with the side panel), or an absolute path to a browser
// of your own on the same engine (launched like the open build, with the side panel). A path that
// isn't an executable file, or any other value, is the open build with a problem line for the
// helper's log. Unset: the older names (browserEngine, executablePath), read as before and not
// checked; else "pairbrowse" where a build is pinned for this computer (native), the open build
// otherwise, with set false (nobody chose yet).
// Returns { browser, set, executablePath (the program to launch, null: the one PairBrowse
// provides), problem }. exists / executable: file checks (tests pass stand-ins).
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isExecutable = (p) => { try { accessSync(p, fsConstants.X_OK); return true; } catch { return false; } };
export function browserChoice(config = {}, { native = false, exists = isFile, executable = isExecutable } = {}) {
  const given = config?.browser;
  const open = (problem) => ({ browser: OPEN_BROWSER, set: true, executablePath: null, problem });
  if (typeof given === "string") {
    if (given === "pairbrowse") return { browser: "pairbrowse", set: true, executablePath: null, problem: null };
    if (isOpenBrowser(given)) return open(null);
    if (isAbsolute(given)) {
      let ok = false;
      try { ok = !!exists(given) && !!executable(given); } catch {}
      return ok ? { browser: given, set: true, executablePath: given, problem: null } : open(`browser: ${given} isn't an executable file; using ${OPEN_BROWSER_NAME} instead`);
    }
    return open(`browser must be "pairbrowse", "${OPEN_BROWSER}" or an absolute path; using ${OPEN_BROWSER_NAME}`);
  }
  // The older names, as they were read before "browser" existed.
  const path = typeof config?.executablePath === "string" && config.executablePath ? config.executablePath : null;
  // (pairbrowse with a path: a native build of your own, used as it is.)
  if (config?.browserEngine === "pairbrowse") return { browser: "pairbrowse", set: true, executablePath: path, problem: null };
  if (path && (config?.browserEngine === "chromium" || config?.browserEngine === "auto" || config?.browserEngine == null)) return { browser: path, set: true, executablePath: path, problem: null };
  if (config?.browserEngine === "chromium") return open(null);
  return { browser: native ? "pairbrowse" : OPEN_BROWSER, set: false, executablePath: null, problem: null };
}

// The browser to launch: browserChoice's answer plus its binary.
// native: a build is pinned for this computer. pinnedExec(): where the pinned build lives (asked
// only when a path is given for the native build, to tell the pinned one from your own).
// Returns { browser, set, problem, binary: "native" | "open" | "custom", executablePath,
// install }: install true means the pinned native build, installed (or checked) before the launch,
// which then runs from pinnedExec(); executablePath null for "open" means PairBrowse's own.
export function chooseBrowser(config = {}, { native = false, pinnedExec = () => null, exists, executable } = {}) {
  const choice = browserChoice(config, { native, ...(exists ? { exists } : {}), ...(executable ? { executable } : {}) });
  if (choice.browser === "pairbrowse") {
    // (The older names: a native build of your own, used as it is.)
    const own = !!choice.executablePath && resolve(choice.executablePath) !== pinnedExec();
    return { ...choice, binary: "native", install: !own, executablePath: own ? choice.executablePath : null };
  }
  return { ...choice, binary: choice.executablePath ? "custom" : "open", install: false };
}

// The launch layer's view of a chosen browser (engine.mjs and native-engine.mjs read
// browserEngine: "pairbrowse" or "open"): a copy of config, never config itself. executablePath:
// the program (for the pinned native build, where it was installed).
export const engineConfig = (config, { binary, executablePath = null }) =>
  ({ ...config, browserEngine: binary === "native" ? "pairbrowse" : "open", executablePath });

// The shell a browser has, from its build manifest (null: not a native build, or one whose
// manifest doesn't read): the side panel extension unless the build declares its own pages.
// settingsSection: its settings are the engine settings' PairBrowse section (580). quietTabs: its
// automation tab changes never bring it in front of the app you're in (585). adBlocker: it installs
// PairBrowse's default ad blocker (591, 593), from the CRX shipped in the app (adBlockerCrx) or the store. safeStorageKeyFile: its Safe Storage
// password can come from a file (594).
export const EXTENSION_SHELL = Object.freeze({ kind: "extension", ownPages: false, capturePage: false, captureKeyed: false, settingsSection: false, quietTabs: false, adBlocker: false, adBlockerCrx: null, safeStorageKeyFile: false });
export function shellFrom(manifest) {
  if (!declaresOwnPages(manifest)) return EXTENSION_SHELL;
  const capturePage = capturePages(manifest);
  return Object.freeze({ kind: "pages", ownPages: true, capturePage, captureKeyed: capturePage && captureKeyed(manifest), settingsSection: settingsSection(manifest), quietTabs: quietTabs(manifest), adBlocker: adBlocker(manifest), adBlockerCrx: adBlocker(manifest) ? adBlockerCrx(manifest) : null, safeStorageKeyFile: safeStorageKeyFile(manifest) });
}
// The shell of the browser an engine config launches, its manifest read once. read: tests pass their own.
export function shellOf(engine, read = nativeManifest) {
  if (engine?.browserEngine !== "pairbrowse") return EXTENSION_SHELL;
  try { return shellFrom(read(engine.executablePath)); } catch { return EXTENSION_SHELL; }
}
