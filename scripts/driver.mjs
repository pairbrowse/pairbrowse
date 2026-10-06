import { readFileSync } from "node:fs";
import { join } from "node:path";

// The oldest Node.js major the pinned Patchright runs on: its package.json "engines" field
// (patchright 1.63.0: ">=20"). Used as is when the runtime isn't installed yet.
export const PATCHRIGHT_NODE_MINIMUM = 20;

export function patchrightNodeMinimum(runtime) {
  try {
    const engines = JSON.parse(readFileSync(join(runtime, "node_modules", "patchright", "package.json"), "utf8")).engines?.node;
    const m = /^\s*>=?\s*(\d+)/.exec(engines || "");
    if (m) return Number(m[1]);
  } catch {}
  return PATCHRIGHT_NODE_MINIMUM;
}

export const fallbackNotice = (nodeVersion, minimum = PATCHRIGHT_NODE_MINIMUM) =>
  `PairBrowse is using Playwright instead of Patchright because Node.js ${nodeVersion} is too old for Patchright. ` +
  `Update to Node.js ${minimum} or newer for the default, harder-to-detect driver.`;

// Which driver drives the browser. Patchright is the default and the recommended one; "playwright"
// is an explicit opt-in. On a Node.js too old for Patchright, PairBrowse falls back to Playwright
// instead of failing, and `notice` says so (shown to the user once).
export function chooseBrowserDriver(config = {}, nodeVersion = process.versions.node, minimum = PATCHRIGHT_NODE_MINIMUM) {
  const driver = config.browserDriver ?? "patchright";
  if (!["patchright", "playwright"].includes(driver)) throw new Error(`Unknown browserDriver: ${driver}`);
  if (driver === "patchright" && Number(String(nodeVersion).split(".")[0]) < minimum) {
    return { driver: "playwright", notice: fallbackNotice(nodeVersion, minimum) };
  }
  return { driver, notice: null };
}

export const validateBrowserDriver = (config = {}, nodeVersion = process.versions.node, minimum) =>
  chooseBrowserDriver(config, nodeVersion, minimum).driver;

// MCP remains the upstream @playwright/mcp server. Only the browser implementation used to
// create its user-provided context is selected here; both drivers expose Playwright's chromium API.
export function loadBrowserDriver(require, config = {}, nodeVersion = process.versions.node, minimum) {
  return require(validateBrowserDriver(config, nodeVersion, minimum));
}
