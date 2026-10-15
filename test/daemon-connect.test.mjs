// Starting the helper (scripts/launcher/daemon-connect.mjs): on macOS it runs on PairBrowse Agent, the
// native build's small app with an identity of its own (app.pairbrowse.agent), so privacy
// prompts the helper raises name PairBrowse and never use the browser's grants; elsewhere, or
// without a native build, on Node as before.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "pb-dc-"));
process.env.PAIRBROWSE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { agentProgram, startDaemon, AGENT } = await import("../scripts/launcher/daemon-connect.mjs");
const { paths } = await import("../scripts/paths.mjs");

const AGENT_TAIL = "Contents/Helpers/PairBrowse Agent.app/Contents/MacOS/PairBrowse Agent";

test("the agent is the one inside the PairBrowse app the browser config names, else the installed one", () => {
  assert.equal(AGENT.join("/"), AGENT_TAIL);
  const all = () => true;
  const mac = { platform: "darwin", usable: all, home: "/h/.pairbrowse" };
  assert.equal(agentProgram({ browser: "/A/PairBrowse.app/Contents/MacOS/pairbrowse" }, mac), `/A/PairBrowse.app/${AGENT_TAIL}`);
  // The older names, as browser.mjs reads them.
  assert.equal(agentProgram({ browserEngine: "pairbrowse", executablePath: "/B/My Build.app/Contents/MacOS/PairBrowse" }, mac), `/B/My Build.app/${AGENT_TAIL}`);
  // Not a program inside an app (Chromium's own name, a bare binary): the installed build's.
  for (const config of [{ browser: "chromium" }, { browser: "pairbrowse" }, { browser: "/usr/bin/chromium" }, {}, null]) {
    assert.equal(agentProgram(config, mac), `/h/.pairbrowse/browser/PairBrowse.app/${AGENT_TAIL}`, JSON.stringify(config));
  }
  // The named app has none (an older build): the installed one; neither: null (Node, as before).
  const only = (p) => (q) => q === p;
  assert.equal(agentProgram({ browser: "/A/PairBrowse.app/Contents/MacOS/pairbrowse" }, { ...mac, usable: only(`/h/.pairbrowse/browser/PairBrowse.app/${AGENT_TAIL}`) }),
    `/h/.pairbrowse/browser/PairBrowse.app/${AGENT_TAIL}`);
  assert.equal(agentProgram({ browser: "/A/PairBrowse.app/Contents/MacOS/pairbrowse" }, { ...mac, usable: () => false }), null);
  // Only macOS has it.
  for (const platform of ["linux", "win32"]) assert.equal(agentProgram({ browser: "/A/PairBrowse.app/Contents/MacOS/pairbrowse" }, { ...mac, platform }), null);
});

test("an agent must be an executable file", () => {
  const app = join(home, "browser", "PairBrowse.app");
  const program = join(app, ...AGENT);
  const mac = { platform: "darwin" };
  assert.equal(agentProgram({}, mac), null, "none installed");
  mkdirSync(dirname(program), { recursive: true });
  writeFileSync(program, "#!/bin/sh\n");
  chmodSync(program, 0o600);
  assert.equal(agentProgram({}, mac), null, "not executable");
  chmodSync(program, 0o700);
  assert.equal(agentProgram({}, mac), program);
  rmSync(join(home, "browser"), { recursive: true, force: true });
});

test("the helper starts on the agent, with Node and its own daemon.mjs as the agent's only arguments", () => {
  const calls = [];
  const run = (file, args, options) => { calls.push({ file, args, options }); return { unref() { this.unrefd = true; }, exitCode: null }; };
  const daemon = join(root, "scripts", "daemon.mjs");
  const agent = `/A/PairBrowse.app/${AGENT_TAIL}`;
  const child = startDaemon({ agent, run });
  assert.equal(child.unrefd, true);
  assert.equal(calls[0].file, agent);
  assert.deepEqual(calls[0].args, [process.execPath, daemon]);
  assert.match(calls[0].args[1], /\/scripts\/daemon\.mjs$/, "the form the agent accepts");
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio[0], "ignore");
  // No agent: Node, as before.
  startDaemon({ agent: null, run });
  assert.equal(calls[1].file, process.execPath);
  assert.deepEqual(calls[1].args, [daemon]);
  assert.equal(typeof paths.daemonLog, "string");
});

const { helperEnv, connectOnce, connectLocal, prepareLocal } = await import("../scripts/launcher/daemon-connect.mjs");

test("the helper's environment: no test switches, the project's instance named outright, the caller's own untouched", () => {
  const env = { PATH: "/bin", PAIRBROWSE_HOME: "/h", PAIRBROWSE_TEST_TUNNEL: "direct", PAIRBROWSE_TEST_APPROVAL: "1", PAIRBROWSE_TESTING: "kept", pairbrowse_test_lower: "kept" };
  const copy = { ...env };
  const plain = helperEnv(env, { source: "default", instance: null });
  assert.deepEqual(plain, { PATH: "/bin", PAIRBROWSE_HOME: "/h", PAIRBROWSE_TESTING: "kept", pairbrowse_test_lower: "kept" });
  assert.deepEqual(env, copy, "a copy: the bridge's own environment keeps its switches");
  assert.equal(helperEnv(env, { source: "project", instance: "work" }).PAIRBROWSE_INSTANCE, "work");
  assert.equal(helperEnv(env, { source: "project", instance: null }).PAIRBROWSE_INSTANCE, "default", "a project that chose the default home says so");
  for (const source of ["PAIRBROWSE_HOME", "PAIRBROWSE_INSTANCE", "default"]) assert.ok(!("PAIRBROWSE_INSTANCE" in helperEnv(env, { source, instance: "work" })), source);
  // A project's choice replaces whatever instance this process was handed.
  assert.equal(helperEnv({ PAIRBROWSE_INSTANCE: "other" }, { source: "project", instance: "work" }).PAIRBROWSE_INSTANCE, "work");
});

test("startDaemon hands the helper that environment", () => {
  process.env.PAIRBROWSE_TEST_SHOULD_NOT_CROSS = "1";
  try {
    let options;
    startDaemon({ agent: null, run: (file, args, o) => { options = o; return { unref() {} }; } });
    assert.ok(!Object.keys(options.env).some((k) => k.startsWith("PAIRBROWSE_TEST_")), "no test switch reaches the helper");
    assert.equal(options.env.PAIRBROWSE_HOME, home);
  } finally { delete process.env.PAIRBROWSE_TEST_SHOULD_NOT_CROSS; }
});

// The pinned runtime, as ensureRuntime finds it installed (its lockfile and the MCP package), so
// prepareLocal never runs npm here.
function fakeRuntime() {
  mkdirSync(join(paths.runtime, "node_modules", "@playwright", "mcp"), { recursive: true });
  writeFileSync(join(paths.runtime, "package-lock.json"), readFileSync(join(root, "runtime", "package-lock.json")));
}

test("connectOnce: the socket when a helper listens, an error when none does", async () => {
  const sock = join(mkdtempSync(join(tmpdir(), "pb-s-")), "h.sock");
  await assert.rejects(connectOnce(sock), (e) => ["ENOENT", "ECONNREFUSED"].includes(e.code));
  const server = net.createServer((c) => c.end("hello\n"));
  await new Promise((r) => server.listen(sock, r));
  try {
    const s = await connectOnce(sock);
    const got = await new Promise((r) => s.once("data", (d) => r(String(d))));
    assert.equal(got, "hello\n");
    s.destroy();
  } finally { server.close(); }
});

test("connectLocal: prepares the home once, then reaches the running helper without starting one", async () => {
  fakeRuntime();
  mkdirSync(dirname(paths.socket), { recursive: true, mode: 0o700 });
  const server = net.createServer((c) => c.end());
  await new Promise((r) => server.listen(paths.socket, r));
  try {
    const said = [];
    const s = await connectLocal((m) => said.push(m));
    s.destroy();
    assert.deepEqual(said, [], "nothing to install, nothing started");
    assert.ok(existsSync(paths.facts));
    assert.equal(statSync(paths.secrets).mode & 0o777, 0o600, "the secrets file is the owner's alone");
    prepareLocal(); // once per process: a second call changes nothing
  } finally { server.close(); }
});
