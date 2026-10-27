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
  CRASH_WINDOW_MS: "the crash-loop guard's window and hold, in place of 5 minutes (daemon/browser/supervise.mjs)",
  FAILOVER_MS: "how long a joiner waits on a silent tunnel before the standby (sharing/join-client.mjs)",
  FILL: "pairbrowse_test_fill: a field in a tab set as a person would (a card number no agent may type)",
  GONE_MS: "when a silent joiner counts as gone (liveview/push.mjs)",
  JOIN_LOCAL: "join codes may point at http://127.0.0.1 (no tunnel)",
  JOIN_PROMPT: "pairbrowse_test_join_prompt: the join request in the bottom bar",
  KEEP_GRACE_MS: "how long a tunnel keeper outlives a quiet helper (tunnels/quick.mjs)",
  MEMORY: "pairbrowse_test_memory: listener counts",
  NETLOG: "the browser writes its NetLog to <home>/netlog.json, which the DNS leak tests read (daemon/browser/launch.mjs withNetLog)",
  NET_CHECK: "the egress checks' local stand-ins: JSON { checkUrl (http allowed), directUrl, stun, ms } (net/probe.mjs checkTargets)",
  NO_CAPTURE: "no window capture",
  NO_DIRECT: "a network where no direct screen connection can be made",
  PANEL: "pairbrowse_test_panel: the side panel's worker",
  PICK_WAIT_MS: "how long the session picker waits (daemon/sessions/picker.mjs)",
  REAL_TUNNEL: "a helper the test harness started may open a real Cloudflare Quick Tunnel (the opt-in tests); without it such a helper never does (testTunnel)",
  RECHECK_MS: "how often a running proxied session's exit is checked again (daemon/network.mjs), in place of network.recheckMinutes",
  RELAUNCH_MS: "keep-alive's one pause before each start after the browser closed by itself, in place of 2, 10 and 30 s (daemon/browser/supervise.mjs)",
  RESTART_MS: "the tunnel pool's restart pause (daemon/tunnel-pool.mjs)",
  RESUME_GRACE_MS: "how long a closed agent connection's label, color and tab wait for the same app session (daemon/serve/departures.mjs)",
  SCREEN: "pairbrowse_test_screen: the shared browser picture page",
  SERVER_OPEN: "server mode may launch a browser other than the native build (the Phase A live tests on Playwright's build: browser/choice.mjs serverRefusal)",
  SILENT_MS: "when a joiner's stream counts as silent (liveview/push.mjs)",
  TAB_ORDER: "pairbrowse_test_tab_order: read and move tabs in the strip",
  TUNNEL: "\"direct\": the guest port stands in for a tunnel",
  TURN_MAX_MS: "the most one call may hold the shared queue (serve.mjs)",
  TURN_MS: "a hand-off's life, its one reminder at two thirds of it (daemon/yourturn.mjs)",
  UNSEEN_MS: "how long after its last call an agent stops showing (collaboration.mjs)",
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

// How a helper's tunnels start under the test harness, so no test outside test/optin ever opens a
// real Quick Tunnel: "direct" (the TUNNEL switch: the guest port stands in for every tunnel, hand-off
// links included), "private" (a helper the harness started with neither switch: the guest port
// stands in for join codes and watch links, and hand-off links stay on the live view's own address,
// as with a private route), "real" (REAL_TUNNEL, the opt-in tests), or null (not the harness's
// helper: as in production).
export function testTunnel(env = process.env) {
  if (testValue("TUNNEL", env) === "direct") return "direct";
  if (!harnessStarted(env)) return null;
  return testOn("REAL_TUNNEL", env) ? "real" : "private";
}
