// The helper's test switches (PAIRBROWSE_TEST_*: shorter timers, test-only tools such as one that
// answers an approval card as a person would, a local "tunnel", no capture) are for the test suite
// alone. Imported first by daemon.mjs, before any module reads them: unless this helper was started
// by the test harness, every one is removed from its environment. The harness's helper is one
// whose home (PAIRBROWSE_HOME) is inside the system's temp folder and whose runtime there is a link
// the harness made (test/live.mjs and the live tests link the pinned runtime; an installed helper's
// is a folder npm filled). An environment a project or app hands down (a .claude/settings.json
// "env") can name variables, never make that link. The plugin's bridge drops them too
// (daemon-connect.mjs).
import { lstatSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

export const TEST_PREFIX = "PAIRBROWSE_TEST_";

// Whether a helper with this environment was started by the test harness.
export function harnessStarted(env = process.env, { temp = tmpdir() } = {}) {
  const home = env.PAIRBROWSE_HOME;
  if (!home) return false;
  try {
    const real = realpathSync(home);
    const roots = [...new Set([temp, "/tmp"].map((t) => { try { return realpathSync(t); } catch { return null; } }).filter(Boolean))];
    if (!roots.some((r) => real.startsWith(r + sep))) return false;
    return lstatSync(join(real, "runtime")).isSymbolicLink();
  } catch {
    return false;
  }
}

// An environment without the test switches (a copy).
export const withoutTestSwitches = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith(TEST_PREFIX)));

if (!harnessStarted()) for (const k of Object.keys(process.env)) if (k.startsWith(TEST_PREFIX)) delete process.env[k];
