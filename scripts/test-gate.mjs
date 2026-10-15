// The test gate (testenv.mjs applyTestGate), run on import: daemon.mjs imports this first, before
// any module reads a test switch, so unless the test harness started this helper every
// PAIRBROWSE_TEST_* is gone from its environment.
import { applyTestGate } from "./testenv.mjs";

export { TEST_PREFIX, harnessStarted, withoutTestSwitches } from "./testenv.mjs";

applyTestGate();
