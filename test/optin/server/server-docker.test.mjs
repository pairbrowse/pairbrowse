// Server mode, Phase A, in the A13 container (spec server-mode step 46; test/optin/server/
// container.mjs): a real helper and the driver's browser on the helper's own virtual screen, the
// container's normal user, every capability dropped. With the test seccomp profile the sandbox
// runs (its namespace layer seen in /proc) and a restart brings back the session, its tabs and its
// login; under Docker's default seccomp profile (no user namespaces) or as root the launch is
// refused and no browser ever starts without the sandbox; with keep-alive a helper SIGKILLed and
// started again, as a service manager does, brings the browser back by itself with session and
// tabs. The cases run inside by test/optin/server/server-run.mjs.
//
// Needs Docker, the network (the image, the driver's browser) and PAIRBROWSE_TEST_RUNTIME, with
// PAIRBROWSE_TEST_DOCKER=1. On Apple Silicon the x64 container runs emulated, where no seccomp filter
// installs: the seccomp layer is checked only on an x64 host.
import "../../helpers/home.mjs";
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerReady, startContainer } from "./container.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SKIP = !runtime || process.env.PAIRBROWSE_TEST_DOCKER !== "1";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
// The driver's Linux browser, downloaded once into a folder kept between runs and mounted in.
const browsers = join(tmpdir(), "pairbrowse-test-downloads", "ms-playwright-linux");
const ENV = { PAIRBROWSE_TEST_RUNTIME: "/runtime", PLAYWRIGHT_BROWSERS_PATH: "/browsers" };
const mounts = () => [{ from: runtime, to: "/runtime" }, { from: browsers, to: "/browsers", readOnly: false }];

// One case in a container of its own: its RESULT line, parsed.
async function runCase(which, { seccomp = "test", root = false } = {}) {
  const c = startContainer({ name: `pb-server-${which}${root ? "-root" : ""}${seccomp === "default" ? "-default" : ""}`, repo, mounts: mounts(), env: ENV, seccomp, root, log: console.log });
  try {
    const r = await c.node("/repo/test/optin/server/server-run.mjs", [which], { ms: 900_000 });
    const line = r.out.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `the case ran:\n${r.out.slice(-4000)}`);
    const result = JSON.parse(line.slice("RESULT ".length));
    assert.equal(result.error, undefined, `${result.error}\n${result.log || ""}`);
    return result;
  } finally { c.stop(); }
}

before(async () => {
  if (SKIP) return;
  assert.ok(dockerReady(), "Docker answers");
  mkdirSync(browsers, { recursive: true });
  chmodSync(browsers, 0o777); // the container's user writes here
  // The driver's browser for Linux x64, as the container's user (the image has its libraries).
  const c = startContainer({ name: "pb-server-install", repo, mounts: mounts(), env: ENV, log: console.log });
  try {
    const r = await c.exec(["node", "/runtime/node_modules/patchright/cli.js", "install", "chromium"], { ms: 1_200_000 });
    assert.equal(r.code, 0, r.out);
  } finally { c.stop(); }
});

test("non-root, sandbox on, a page opens, a restart restores the session", { skip: SKIP, timeout: 1_200_000 }, async () => {
  const r = await runCase("restart");
  assert.notEqual(r.uid, 0, "a normal user");
  assert.match(r.created, /Created and switched/);
  assert.equal(r.cookieBefore, "cookies: login=kept", "a page opens and logs in");
  assert.equal(r.sandbox.noSandboxSwitch, false, "no --no-sandbox");
  assert.ok(r.sandbox.renderers > 0 && r.sandbox.namespaced === r.sandbox.renderers, `the namespace sandbox: ${JSON.stringify(r.sandbox)}`);
  if (process.arch === "x64") assert.equal(r.sandbox.seccomp, r.sandbox.renderers, "and the seccomp filter");
  assert.doesNotMatch(r.status, /sandbox is off/i);
  assert.match(r.status, new RegExp(`virtual screen ${r.screen.display} 1280x800`));
  assert.ok(r.stopped && r.screenGone, "SIGTERM ends the helper and its screen");
  for (const p of ["/account", "/two"]) assert.ok(r.listAfter.includes(`${r.base}${p})`), `${p} is back:\n${r.listAfter}`);
  assert.equal(r.cookieAfter, "cookies: login=kept", "the login came back");
  assert.doesNotMatch(r.statusAfter, /sandbox is off/i);
});

test("default seccomp profile or root: launch refused, never started without the sandbox", { skip: SKIP, timeout: 1_200_000 }, async () => {
  const blocked = await runCase("refused", { seccomp: "default" });
  assert.notEqual(blocked.uid, 0);
  assert.match(blocked.navigate, /the browser's sandbox can't start on this system[^]*in server mode, PairBrowse never starts the browser without it/);
  assert.equal(blocked.browsers, 0, "no browser runs");
  assert.doesNotMatch(blocked.navigate + blocked.status, /sandbox is off/i);

  const root = await runCase("refused", { root: true });
  assert.equal(root.uid, 0, "root");
  assert.match(root.navigate, /the browser's sandbox can't run as root; run PairBrowse as a normal user \(in server mode/);
  assert.equal(root.browsers, 0, "no browser ever starts");
  assert.doesNotMatch(root.navigate + root.status, /sandbox is off/i);
});

test("systemd-style restart after SIGKILL restores session and tabs with keepAlive", { skip: SKIP, timeout: 1_200_000 }, async () => {
  const r = await runCase("keepalive");
  assert.ok(r.killed, "the helper was SIGKILLed");
  assert.ok(r.startedAlone, "the next helper starts the browser by itself, nobody connected");
  assert.equal(r.restored, "2", "with the session's two tabs");
  assert.ok(r.reaped && r.oldScreenGone, "the killed helper's Xvfb is ended by the next one");
  for (const p of ["/one", "/two"]) assert.ok(r.listAfter.includes(`${r.base}${p})`), `${p} is back:\n${r.listAfter}`);
  assert.match(r.sessionAfter, /work/);
  assert.match(r.statusAfter, /keep-alive on/);
});
