// The helper's test switches, in one place: every PAIRBROWSE_TEST_* the helper reads is listed in
// SWITCHES below and read through testMs / testOn / testValue (an unlisted name throws), so what
// test-only behaviour production code holds can be reviewed here. They are for the test suite
// alone (shorter timers, test-only tools such as one that answers an approval card as a person
// would, a local "tunnel", no capture): unless the test harness started this helper, the gate
// (applyTestGate, run by test-gate.mjs, which daemon.mjs imports first) removes every one from its
// environment. The harness's helper is one whose home (PAIRBROWSE_HOME) is inside the system's
// temp folder and whose runtime there is a link the harness made (test/helpers/live.mjs and the live tests
// link the pinned runtime; an installed helper's is a folder npm filled). An environment a project
// or app hands down (a .claude/settings.json "env") can name variables, never make that link. The
// plugin's bridge drops them too (launcher/daemon-connect.mjs).
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

// Removes every test switch from env unless the test harness started this helper.
export function applyTestGate(env = process.env) {
  if (!harnessStarted(env)) for (const k of Object.keys(env)) if (k.startsWith(TEST_PREFIX)) delete env[k];
}

// Every switch, without its prefix, and what it does.
export const SWITCHES = {
  ACTIVE_MS: "how long an agent's connection counts as active (serve.mjs)",
  APPROVAL: "pairbrowse_test_approval: the approval card, clicked as a person would",
  FAILOVER_MS: "how long a joiner waits on a silent tunnel before the standby (sharing/join-client.mjs)",
  GONE_MS: "when a silent joiner counts as gone (liveview/push.mjs)",
  JOIN_LOCAL: "join codes may point at http://127.0.0.1 (no tunnel)",
  JOIN_PROMPT: "pairbrowse_test_join_prompt: the join request in the bottom bar",
  KEEP_GRACE_MS: "how long a tunnel keeper outlives a quiet helper (tunnels/quick.mjs)",
  MEMORY: "pairbrowse_test_memory: listener counts",
  NO_CAPTURE: "no window capture",
  NO_DIRECT: "a network where no direct screen connection can be made",
  PANEL: "pairbrowse_test_panel: the side panel's worker",
  PICK_WAIT_MS: "how long the session picker waits (daemon/sessions/picker.mjs)",
  RESTART_MS: "the tunnel pool's restart pause (daemon/tunnel-pool.mjs)",
  SCREEN: "pairbrowse_test_screen: the shared browser picture page",
  SILENT_MS: "when a joiner's stream counts as silent (liveview/push.mjs)",
  TAB_ORDER: "pairbrowse_test_tab_order: read and move tabs in the strip",
  TUNNEL: "\"direct\": the guest port stands in for a tunnel",
  TURN_MAX_MS: "the most one call may hold the shared queue (serve.mjs)",
};
const named = (name) => {
  if (!Object.hasOwn(SWITCHES, name)) throw new Error(`unknown test switch ${name}`);
  return TEST_PREFIX + name;
};
// A switch's raw value (undefined when unset).
export const testValue = (name, env = process.env) => env[named(name)];
// A switch that is on ("1").
export const testOn = (name, env = process.env) => testValue(name, env) === "1";
// A duration switch in ms, or fallback when unset or not a positive number.
export const testMs = (name, fallback, env = process.env) => Number(testValue(name, env)) || fallback;
