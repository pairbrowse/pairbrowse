// A PairBrowse home of the test's own, under the system's temp folder, set before any project module
// loads (paths.mjs reads PAIRBROWSE_HOME as it loads). Every test file imports this first:
//   import "./helpers/home.mjs";
// It throws when the home would be the person's own ~/.pairbrowse (their profile, secrets, runs).
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";

const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
// The account's own home from the system's record, not $HOME (a test may point that elsewhere).
const REAL_HOME = real(join(userInfo().homedir, ".pairbrowse"));

if (!process.env.PAIRBROWSE_HOME) process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-test-"));

// Whether a home is the person's own; tests never use it.
export function isRealHome(home) {
  return !home || real(home) === REAL_HOME;
}
if (isRealHome(process.env.PAIRBROWSE_HOME)) {
  throw new Error(`Tests never use the real ~/.pairbrowse (PAIRBROWSE_HOME=${process.env.PAIRBROWSE_HOME}); set it to a folder under ${tmpdir()}.`);
}

export const testHome = process.env.PAIRBROWSE_HOME;
