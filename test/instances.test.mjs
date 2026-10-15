// Named instances (scripts/home.mjs): which home a process uses, the project file's rules, the
// paths an instance reads from the shared installs, the helper's environment, and the one install
// at a time in the shared home (scripts/install-lock.mjs).
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveHome, projectInstance, selectHome, INSTANCE_RE } from "../scripts/home.mjs";
import { helperEnv } from "../scripts/launcher/daemon-connect.mjs";
import { withInstallLock, withInstallLockSync } from "../scripts/install-lock.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "pb-inst-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const account = join(scratch, "account");
const project = (name, text) => { const dir = join(scratch, name); mkdirSync(dir, { recursive: true }); if (text !== undefined) writeFileSync(join(dir, ".pairbrowse.json"), text); return dir; };

test("PAIRBROWSE_HOME wins, then PAIRBROWSE_INSTANCE, then the project file, then ~/.pairbrowse", () => {
  const dir = project("p1", JSON.stringify({ instance: "work" }));
  const base = join(account, ".pairbrowse");
  assert.deepEqual(resolveHome({ env: { PAIRBROWSE_HOME: "/x/home", PAIRBROWSE_INSTANCE: "a" }, cwd: dir, account }),
    { home: "/x/home", instance: null, shared: "/x/home", source: "PAIRBROWSE_HOME" });
  assert.deepEqual(resolveHome({ env: { PAIRBROWSE_INSTANCE: "test-2" }, cwd: dir, account }),
    { home: join(base, "instances", "test-2"), instance: "test-2", shared: base, source: "PAIRBROWSE_INSTANCE" });
  assert.deepEqual(resolveHome({ env: {}, cwd: dir, account }), { home: join(base, "instances", "work"), instance: "work", shared: base, source: "project" });
  assert.deepEqual(resolveHome({ env: { CLAUDE_PROJECT_DIR: dir }, cwd: "/", account }).instance, "work", "Claude Code's project folder first");
  assert.deepEqual(resolveHome({ env: {}, cwd: project("p0"), account }), { home: base, instance: null, shared: base, source: "default" });
  assert.equal(resolveHome({ env: { PAIRBROWSE_INSTANCE: "default" }, cwd: dir, account }).home, base, "default names the default home");
  assert.equal(resolveHome({ env: {}, cwd: project("pd", '{"instance":"default"}'), account }).home, base);
});

test("an instance name is 1 to 32 of a-z, 0-9 and -: a bad PAIRBROWSE_INSTANCE throws, never a path", () => {
  for (const bad of ["../x", "Work", "a/b", "a".repeat(33), ".", "a b", "é", "a\0"]) {
    assert.equal(INSTANCE_RE.test(bad), false, bad);
    assert.throws(() => resolveHome({ env: { PAIRBROWSE_INSTANCE: bad }, cwd: "/", account }), /PAIRBROWSE_INSTANCE/);
  }
  assert.equal(INSTANCE_RE.test("a".repeat(32)), true);
});

test("the project file: only the folder's own regular file, owned by this account, small JSON", () => {
  assert.equal(projectInstance(project("none")), null);
  assert.equal(projectInstance("relative/dir"), null);
  assert.deepEqual(projectInstance(project("ok", '{"instance":"ab-1"}')), { name: "ab-1" });
  assert.equal(projectInstance(project("other-keys", '{"x":1}')), null);
  assert.match(projectInstance(project("bad-json", "{")).warning, /not JSON/);
  assert.match(projectInstance(project("bad-name", '{"instance":"../../etc"}')).warning, /instance/);
  assert.match(projectInstance(project("big", JSON.stringify({ instance: "a", pad: "x".repeat(5000) }))).warning, /4 KB/);
  assert.match(projectInstance(project("owner", '{"instance":"a"}'), { uid: 12345678 }).warning, /another account/);
  const linked = project("linked");
  symlinkSync(join(project("target", '{"instance":"a"}'), ".pairbrowse.json"), join(linked, ".pairbrowse.json"));
  assert.ok(projectInstance(linked).warning, "a link is not followed");
  // A parent folder's file is never read.
  const parent = project("parent", '{"instance":"a"}');
  mkdirSync(join(parent, "child"));
  assert.equal(projectInstance(join(parent, "child")), null);
  // A bad file leaves the default home and says why.
  const r = resolveHome({ env: {}, cwd: project("bad2", "[1"), account });
  assert.equal(r.instance, null);
  assert.match(r.warning, /not JSON/);
});

test("an instance's own files are its own; the installs come from the shared home", () => {
  const dir = project("p-paths", '{"instance":"work"}');
  const code = 'const { paths, INSTANCE } = await import("./scripts/paths.mjs"); console.log(JSON.stringify({ INSTANCE, paths }));';
  const env = { ...process.env, HOME: account, CLAUDE_PROJECT_DIR: dir };
  delete env.PAIRBROWSE_HOME; delete env.PAIRBROWSE_INSTANCE;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: root, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const { INSTANCE, paths } = JSON.parse(r.stdout);
  const base = join(account, ".pairbrowse"), own = join(base, "instances", "work");
  assert.equal(INSTANCE, "work");
  for (const k of ["home", "profile", "secrets", "facts", "factsJson", "config", "runs", "reviews", "log", "run", "daemonLog", "sessions", "sharing", "tunnels"]) assert.ok(paths[k].startsWith(own), k);
  assert.equal(paths.socket, join(own, "run", "browser.sock"));
  for (const k of ["runtime", "browser", "nativeApp", "engine", "tools", "downloads", "hostProfile", "installLock"]) assert.ok(paths[k].startsWith(base + "/") && !paths[k].startsWith(own), k);
});

test("the helper the bridge starts gets the project's instance by name, and no test switches", () => {
  const env = { PATH: "/bin", PAIRBROWSE_TEST_TUNNEL: "direct" };
  assert.deepEqual(helperEnv(env, { source: "project", instance: "work" }), { PATH: "/bin", PAIRBROWSE_INSTANCE: "work" });
  assert.deepEqual(helperEnv(env, { source: "project", instance: null }), { PATH: "/bin", PAIRBROWSE_INSTANCE: "default" });
  assert.deepEqual(helperEnv(env, { source: "default", instance: null }), { PATH: "/bin" });
});

test("under the test runner, a home or shared store inside the real ~/.pairbrowse stops the process", () => {
  const env = { ...process.env, PAIRBROWSE_INSTANCE: "x" };
  delete env.PAIRBROWSE_HOME;
  delete env.HOME; // homedir() then reads the account's own record
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", 'await import("./scripts/paths.mjs")'], { cwd: root, env: { ...env, NODE_TEST_CONTEXT: "child" }, encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /real ~\/\.pairbrowse/);
});

test("install lock: one at a time, re-entrant, a dead holder's lock taken over", async () => {
  const file = join(scratch, "shared", "install.lock");
  const order = [];
  const slow = (name) => withInstallLock(async () => { order.push(`${name}+`); await new Promise((r) => setTimeout(r, 50)); order.push(`${name}-`); }, { file });
  // In one process the lock is re-entrant, so two calls at once share it; the order shows only
  // that each runs to its end. Across processes it waits: a child holds it while this one waits.
  await Promise.all([slow("a"), slow("b")]);
  assert.equal(order.length, 4);
  assert.equal(existsSync(file), false, "released");
  // Nested: no wait on itself.
  assert.equal(await withInstallLock(() => withInstallLock(async () => 7, { file }), { file }), 7);
  assert.equal(withInstallLockSync(() => withInstallLockSync(() => 8, { file }), { file }), 8);
  assert.equal(existsSync(file), false);
  // A lock whose process is gone is taken over.
  writeFileSync(file, "999999"); chmodSync(file, 0o600);
  assert.equal(await withInstallLock(async () => "took", { file, waitMs: 2000 }), "took");
  // Another live process holds it: wait, then fail after waitMs, with the holder named.
  const holder = spawn(process.execPath, ["--input-type=module", "-e",
    `const { writeFileSync } = await import("node:fs"); writeFileSync(${JSON.stringify(file)}, String(process.pid), { flag: "wx" }); setTimeout(() => {}, 1500); process.on("exit", () => {});`], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  const said = [];
  await assert.rejects(withInstallLock(async () => 1, { file, waitMs: 300, say: (m) => said.push(m) }), /another PairBrowse install is still running \(process \d+\)/);
  assert.match(said[0], /waiting/);
  await new Promise((r) => holder.on("exit", r));
  rmSync(file, { force: true }); // the child leaves its file (it never took the lock through the module)
  assert.equal(await withInstallLock(async () => 2, { file, waitMs: 1000 }), 2);
});

test("pairbrowse_status names the instance and its home, and a project file it couldn't use", async () => {
  const { statusLine } = await import("../scripts/daemon/serve/tools/status.mjs");
  assert.equal(statusLine({ instance: null, source: "default", home: "/h/.pairbrowse" }), "ok");
  assert.equal(statusLine({ instance: "work", source: "project", home: "/h/.pairbrowse/instances/work" }), 'ok; PairBrowse instance "work" (/h/.pairbrowse/instances/work)');
  assert.equal(statusLine({ instance: null, source: "PAIRBROWSE_HOME", home: "/x" }), "ok; PairBrowse home /x");
  assert.match(statusLine({ instance: null, source: "default", home: "/h", warning: "/p/.pairbrowse.json is not JSON" }), /^ok; ignored: .*not JSON/);
});

test("open.mjs's home: the record's, else the one the environment names, else the default (never a project file)", () => {
  assert.deepEqual(selectHome({ PAIRBROWSE_HOME: "/a", X: "1" }, { PAIRBROWSE_INSTANCE: "work" }), { X: "1", PAIRBROWSE_INSTANCE: "work" });
  assert.deepEqual(selectHome({ PAIRBROWSE_INSTANCE: "a" }, { PAIRBROWSE_HOME: "/h" }), { PAIRBROWSE_HOME: "/h" });
  assert.deepEqual(selectHome({ PAIRBROWSE_HOME: "/a" }, null), { PAIRBROWSE_HOME: "/a" });
  assert.deepEqual(selectHome({}, null), { PAIRBROWSE_INSTANCE: "default" });
});
