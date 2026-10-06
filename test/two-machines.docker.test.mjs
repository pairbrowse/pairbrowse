// Shared browser mode between two machines, both ways: this Mac and a Linux container (behind its
// own NAT), joined through a real Cloudflare Quick Tunnel. The joiner gets a direct connection,
// types into the host's Google box through the picture, and its agent reads the host's page; a new
// agent of the joiner's starts on the host tab the joiner looks at (or looked at last), not the first free one, and its
// "release" frees that tab in the host's browser at once. Needs Docker, the network,
// PAIRBROWSE_TEST_RUNTIME and PAIRBROWSE_TEST_DOCKER=1.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const skip = !runtime || process.env.PAIRBROWSE_TEST_DOCKER !== "1";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd, args, ms = 900_000) => execFileSync(cmd, args, { encoding: "utf8", timeout: ms, stdio: ["ignore", "pipe", "pipe"] });
const mail = mkdtempSync("/tmp/pbmail-");
const run = (cmd, args, env = {}) => new Promise((resolve) => {
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
  const timer = setTimeout(() => p.kill(), 600_000);
  p.on("exit", () => { clearTimeout(timer); resolve(out); });
});
const inLinux = (script) => run("docker", ["exec", "-e", "PB_MAIL=/mail", "-e", "PB_RUNTIME=/runtime", "pb-joiner", "node", `/repo/test/two-machines/${script}`]);
const onMac = (script) => run(process.execPath, [join(repo, "test", "two-machines", script)], { PB_MAIL: mail, PB_RUNTIME: runtime });

// The container never outlives the test: any left by an interrupted run (this one's name, its
// label, or the name earlier versions used) goes before it starts; it goes after the run, on
// Ctrl+C or a kill, and, through a watcher outside this process group, whenever this process ends
// however it ended (the test runner can end it before its own handlers run); failing all that, it
// stops by itself after two hours and Docker removes it (--rm).
const LABEL = "pairbrowse-test=two-machines";
function removeContainers() {
  let ids = [];
  try { ids = sh("docker", ["ps", "-aq", "--filter", `label=${LABEL}`], 30_000).split(/\s+/).filter(Boolean); } catch {}
  for (const name of [...ids, "pb-joiner", "pb-sven"]) try { sh("docker", ["rm", "-f", name], 60_000); } catch {}
}
const cleanUp = () => { if (!skip) removeContainers(); rmSync(mail, { recursive: true, force: true }); };
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) process.once(signal, () => { cleanUp(); process.exit(code); });
function watchContainer() {
  const watcher = `const { execFileSync } = require("node:child_process");
    const timer = setInterval(() => {
      try { process.kill(${process.pid}, 0); return; } catch {}
      clearInterval(timer);
      try { execFileSync("docker", ["rm", "-f", "pb-joiner"], { stdio: "ignore", timeout: 60000 }); } catch {}
    }, 1000);`;
  spawn(process.execPath, ["-e", watcher], { detached: true, stdio: "ignore" }).unref();
}

before(() => {
  if (skip) return;
  removeContainers();
  watchContainer();
  sh("docker", ["run", "-d", "--rm", "--name", "pb-joiner", "--label", LABEL, "-v", `${runtime}:/runtime:ro`, "-v", `${repo}:/repo:ro`, "-v", `${mail}:/mail`, "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", "node:22-bookworm", "sleep", "7200"]);
  sh("docker", ["exec", "pb-joiner", "node", "/runtime/node_modules/playwright-core/cli.js", "install", "--with-deps", "chromium"]);
});
after(cleanUp);

function check(out) {
  assert.match(out, /"conn":"connected"[^\n]*"direct":true/, out);
  assert.match(out, /"googleBox":"[^"]*hello from sven/, out);
  assert.match(out, /"agentSnapshotSeesGoogle":true/, out);
  assert.match(out, /"muted":false/, out);
  assert.match(out, /"inSight":\{"startsOn":"https:\/\/www\.iana\.org/, out);
  assert.match(out, /"lastLookedAt":\{"startsOn":"https:\/\/www\.iana\.org/, out);
  assert.match(out, /"agentHolds":\{"ok":true/, out);
  assert.match(out, /"whileHeld":\{"refused":true,"text":"[^"]*in use by/, out);
  assert.match(out, /"afterRelease":\{"ok":true/, out);
}
for (const [name, host, joiner] of [["Mac hosts, Linux joins", onMac, inLinux], ["Linux hosts, Mac joins", inLinux, onMac]]) {
  test(`shared browser between two machines, through a real tunnel: ${name}`, { skip, timeout: 900_000 }, async () => {
    for (const f of ["code", "typed-done", "two", "held", "checked", "released", "host-done", "stop"]) rmSync(join(mail, f), { force: true });
    const [h, j] = await Promise.all([host("host.mjs"), joiner("joiner.mjs")]);
    const out = `${h}\n${j}`;
    console.log(out);
    check(out);
  });
}
