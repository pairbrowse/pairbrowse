// Starting the helper (scripts/daemon-connect.mjs): on macOS it runs on PairBrowse Agent, the
// native build's small app with an identity of its own (app.pairbrowse.agent), so privacy
// prompts the helper raises name PairBrowse and never use the browser's grants; elsewhere, or
// without a native build, on Node as before.
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const home = mkdtempSync(join(tmpdir(), "pb-dc-"));
process.env.PAIRBROWSE_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { agentProgram, startDaemon, AGENT } = await import("../scripts/daemon-connect.mjs");
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
