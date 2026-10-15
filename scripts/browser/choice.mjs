// Which browser the helper launches, as two separate things:
// - the binary: what program runs. "chromium" (the PairBrowse Chromium: ungoogled-chromium on
//   macOS, Playwright's elsewhere; ensureBrowser in browser.mjs), "custom" (a Chromium-based
//   browser of your own, by its path) or "native" (a native PairBrowse build with its engine pack:
//   the pinned one, installed and checked by native-install.mjs, or one of your own by its path);
// - the shell: what draws PairBrowse's own UI. "extension" (the side panel extension in ui/, for
//   every binary but a native build that declares its own pages) or "pages" (the build's
//   chrome://pairbrowse pages, its manifest's `chrome` field), with or without its own capture
//   page (`capture`) and that page's own key (`capture` 2 and up).
// chooseBrowser is the one place the "browser" setting and its older names (browserEngine,
// executablePath) are read. Pure: file checks come in as functions, and nothing is written back
// into config (the choice lives in the helper's context, daemon/context.mjs). The launch layer
// (engine.mjs) still speaks the older names: engineConfig gives it a copy that does.
import { accessSync, statSync, constants as fsConstants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { nativeManifest, chromePages, capturePages, captureKeyed } from "../native-engine.mjs";

// Which browser PairBrowse runs (config "browser"): "pairbrowse" (the native build), "chromium"
// (ensureBrowser in browser.mjs: ungoogled-chromium on macOS, Playwright's Chromium elsewhere,
// with the side panel), or an absolute path to a Chromium-based browser of your own (launched like
// "chromium", with the side panel). A path that isn't an executable file, or any other value, is
// "chromium" with a problem line for the helper's log. Unset: the older names (browserEngine,
// executablePath), read as before and not checked; else "pairbrowse" where a build is pinned for
// this computer (native), "chromium" otherwise, with set false (nobody chose yet).
// Returns { browser, set, executablePath (the program to launch, null: the one PairBrowse
// provides), problem }. exists / executable: file checks (tests pass stand-ins).
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isExecutable = (p) => { try { accessSync(p, fsConstants.X_OK); return true; } catch { return false; } };
export function browserChoice(config = {}, { native = false, exists = isFile, executable = isExecutable } = {}) {
  const given = config?.browser;
  const chromium = (problem) => ({ browser: "chromium", set: true, executablePath: null, problem });
  if (typeof given === "string") {
    if (given === "pairbrowse") return { browser: "pairbrowse", set: true, executablePath: null, problem: null };
    if (given === "chromium") return chromium(null);
    if (isAbsolute(given)) {
      let ok = false;
      try { ok = !!exists(given) && !!executable(given); } catch {}
      return ok ? { browser: given, set: true, executablePath: given, problem: null } : chromium(`browser: ${given} isn't an executable file; using Chromium instead`);
    }
    return chromium('browser must be "pairbrowse", "chromium" or an absolute path; using Chromium');
  }
  // The older names, as they were read before "browser" existed.
  const path = typeof config?.executablePath === "string" && config.executablePath ? config.executablePath : null;
  // (pairbrowse with a path: a native build of your own, used as it is.)
  if (config?.browserEngine === "pairbrowse") return { browser: "pairbrowse", set: true, executablePath: path, problem: null };
  if (path && (config?.browserEngine === "chromium" || config?.browserEngine === "auto" || config?.browserEngine == null)) return { browser: path, set: true, executablePath: path, problem: null };
  if (config?.browserEngine === "chromium") return chromium(null);
  return { browser: native ? "pairbrowse" : "chromium", set: false, executablePath: null, problem: null };
}

// The browser to launch: browserChoice's answer plus its binary.
// native: a build is pinned for this computer. pinnedExec(): where the pinned build lives (asked
// only when a path is given for the native build, to tell the pinned one from your own).
// Returns { browser, set, problem, binary: "native" | "chromium" | "custom", executablePath,
// install }: install true means the pinned native build, installed (or checked) before the launch,
// which then runs from pinnedExec(); executablePath null for "chromium" means PairBrowse's own.
export function chooseBrowser(config = {}, { native = false, pinnedExec = () => null, exists, executable } = {}) {
  const choice = browserChoice(config, { native, ...(exists ? { exists } : {}), ...(executable ? { executable } : {}) });
  if (choice.browser === "pairbrowse") {
    // (The older names: a native build of your own, used as it is.)
    const own = !!choice.executablePath && resolve(choice.executablePath) !== pinnedExec();
    return { ...choice, binary: "native", install: !own, executablePath: own ? choice.executablePath : null };
  }
  return { ...choice, binary: choice.executablePath ? "custom" : "chromium", install: false };
}

// The launch layer's view of a chosen browser (engine.mjs and native-engine.mjs read the older
// names): a copy of config, never config itself. executablePath: the program (for the pinned
// native build, where it was installed).
export const engineConfig = (config, { binary, executablePath = null }) =>
  ({ ...config, browserEngine: binary === "native" ? "pairbrowse" : "chromium", executablePath });

// The shell a browser has, from its build manifest (null: not a native build, or one whose
// manifest doesn't read): the side panel extension unless the build declares its own pages.
export const EXTENSION_SHELL = Object.freeze({ kind: "extension", ownPages: false, capturePage: false, captureKeyed: false });
export function shellFrom(manifest) {
  if (!chromePages(manifest)) return EXTENSION_SHELL;
  const capturePage = capturePages(manifest);
  return Object.freeze({ kind: "pages", ownPages: true, capturePage, captureKeyed: capturePage && captureKeyed(manifest) });
}
// The shell of the browser an engine config launches, its manifest read once. read: tests pass their own.
export function shellOf(engine, read = nativeManifest) {
  if (engine?.browserEngine !== "pairbrowse") return EXTENSION_SHELL;
  try { return shellFrom(read(engine.executablePath)); } catch { return EXTENSION_SHELL; }
}
