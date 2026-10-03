export const PATCHRIGHT_NODE_MINIMUM = 20;

export function validateBrowserDriver(config = {}, nodeVersion = process.versions.node) {
  const driver = config.browserDriver ?? "patchright";
  if (!["patchright", "playwright"].includes(driver)) throw new Error(`Unknown browserDriver: ${driver}`);
  if (driver === "patchright" && Number(String(nodeVersion).split(".")[0]) < PATCHRIGHT_NODE_MINIMUM) {
    throw new Error(`Patchright requires Node.js ${PATCHRIGHT_NODE_MINIMUM} or newer; set browserDriver to playwright on Node.js 18.`);
  }
  return driver;
}

// MCP remains the upstream @playwright/mcp server. Only the browser implementation used to
// create its user-provided context is selected here; both drivers expose Playwright's chromium API.
export function loadBrowserDriver(require, config = {}, nodeVersion = process.versions.node) {
  const driver = validateBrowserDriver(config, nodeVersion);
  return driver === "patchright" ? require("patchright") : require("playwright");
}

