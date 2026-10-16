// Named instances (scripts/home.mjs): which home a process uses, the project file's rules, the
// paths an instance reads from the shared installs, the helper's environment, and the one install
// at a time in the shared home (scripts/install-lock.mjs).
import "./helpers/home.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveHome, projectInstance, selectHome, INSTANCE_RE, gateProjectEnv, projectSetNames, settingsNames, projectDir, PROJECT_GATED } from "../scripts/home.mjs";
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

// A project's own settings (Claude Code hands their "env" to the plugin) never pick the helper's
// home nor the name it shows others; the same variables from your own shell still work.
test("a home or participant name set by the project's settings is dropped; set elsewhere it stays", () => {
  assert.deepEqual([...PROJECT_GATED].sort(), ["PAIRBROWSE_APPROVAL_WAIT_MS", "PAIRBROWSE_HOME", "PAIRBROWSE_PARTICIPANT"]);
  const clean = project("gate-clean");
  const env1 = { PAIRBROWSE_HOME: "/x/home", PAIRBROWSE_PARTICIPANT: "Me", CLAUDE_PROJECT_DIR: clean };
  assert.deepEqual(gateProjectEnv(env1), []);
  assert.equal(env1.PAIRBROWSE_HOME, "/x/home");
  for (const [dir, file, text] of [
    [".claude", "settings.json", JSON.stringify({ env: { PAIRBROWSE_HOME: "/evil", PAIRBROWSE_PARTICIPANT: "Alice (host)" } })],
    [".claude", "settings.local.json", JSON.stringify({ env: { PAIRBROWSE_HOME: "/evil", PAIRBROWSE_PARTICIPANT: "x" } })],
    [".codex", "config.toml", '[shell_environment_policy.set]\nPAIRBROWSE_HOME = "/evil"\nPAIRBROWSE_PARTICIPANT = "x"\n'],
  ]) {
    const proj = project(`gate-${file}`);
    mkdirSync(join(proj, dir), { recursive: true });
    writeFileSync(join(proj, dir, file), text);
    assert.deepEqual(projectSetNames(proj).sort(), ["PAIRBROWSE_HOME", "PAIRBROWSE_PARTICIPANT"], file);
    const env = { PAIRBROWSE_HOME: "/evil", PAIRBROWSE_PARTICIPANT: "Alice (host)", PAIRBROWSE_INSTANCE: "work", CLAUDE_PROJECT_DIR: proj };
    assert.deepEqual(gateProjectEnv(env).sort(), ["PAIRBROWSE_HOME", "PAIRBROWSE_PARTICIPANT"], file);
    assert.ok(!("PAIRBROWSE_HOME" in env) && !("PAIRBROWSE_PARTICIPANT" in env), file);
    assert.equal(env.PAIRBROWSE_INSTANCE, "work", "an instance of your own stays choosable");
    // The current folder when Claude Code names none.
    const env2 = { PAIRBROWSE_HOME: "/evil" };
    assert.deepEqual(gateProjectEnv(env2, { cwd: proj }), ["PAIRBROWSE_HOME"]);
  }
  // A settings path that can't be read (a folder in a file's place) counts as naming them all.
  const odd = project("gate-odd");
  mkdirSync(join(odd, ".claude", "settings.json"), { recursive: true });
  assert.deepEqual(projectSetNames(odd).sort(), [...PROJECT_GATED].sort());
});

// The settings are read as Claude Code and Codex read them: a key spelled with escapes is the same key.
test("a gated name spelled with JSON or TOML escapes is still caught; a file not naming one removes nothing", () => {
  const esc = (s) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
  const proj = project("gate-escaped");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "settings.json"), `{"env":{"${esc("PAIRBROWSE_HOME")}":"/evil"}}`);
  assert.deepEqual(projectSetNames(proj), ["PAIRBROWSE_HOME"]);
  const env = { PAIRBROWSE_HOME: "/evil", CLAUDE_PROJECT_DIR: proj };
  assert.deepEqual(gateProjectEnv(env), ["PAIRBROWSE_HOME"]);
  assert.ok(!("PAIRBROWSE_HOME" in env));
  // Half escaped, lower-case hex, any letter case, nested elsewhere in the file: all caught.
  assert.deepEqual(settingsNames("json", '{"env":{"PAIRBROWSE_\\u0068ome":"x"}}'), ["PAIRBROWSE_HOME"]);
  assert.deepEqual(settingsNames("json", '\uFEFF{"a":[{"b":{"PAIRBROWSE_PARTICIPANT":1}}]}'), ["PAIRBROWSE_PARTICIPANT"]);
  // Unparsable JSON names them all; a value that merely mentions one names nothing.
  assert.deepEqual(settingsNames("json", '{"env":{"PAIRBROWSE_HOME":').sort(), [...PROJECT_GATED].sort());
  assert.deepEqual(settingsNames("json", '{"env":{"OTHER":"PAIRBROWSE_HOME"},"note":"PAIRBROWSE_PARTICIPANT"}'), []);
  assert.deepEqual(settingsNames("json", "{}"), []);
  // TOML: \uXXXX and \UXXXXXXXX in a quoted key.
  assert.deepEqual(settingsNames("toml", `[shell_environment_policy.set]\n"${esc("PAIRBROWSE_HOME")}" = "/evil"\n`), ["PAIRBROWSE_HOME"]);
  assert.deepEqual(settingsNames("toml", '[x]\n"PAIRBROWSE_\\U00000050ARTICIPANT" = "y"\n'), ["PAIRBROWSE_PARTICIPANT"]);
  assert.deepEqual(settingsNames("toml", '[x]\nOTHER = "1"\n'), []);
  const codex = project("gate-escaped-toml");
  mkdirSync(join(codex, ".codex"), { recursive: true });
  writeFileSync(join(codex, ".codex", "config.toml"), `[shell_environment_policy.set]\n"PAIRBROWSE_${esc("HOME")}" = "/evil"\n`);
  const env2 = { PAIRBROWSE_HOME: "/evil", PAIRBROWSE_INSTANCE: "work" };
  assert.deepEqual(gateProjectEnv(env2, { cwd: codex }), ["PAIRBROWSE_HOME"]);
  assert.equal(env2.PAIRBROWSE_INSTANCE, "work");
});

// A project can't shorten how long an ask waits in the browser; your own setting still works.
test("PAIRBROWSE_APPROVAL_WAIT_MS set by the project's settings is ignored by the hook", () => {
  const proj = project("gate-wait");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ env: { PAIRBROWSE_APPROVAL_WAIT_MS: "100" } }));
  const code = `const g = await import(${JSON.stringify(new URL("../scripts/guard.mjs", import.meta.url).href)}); console.log(g.APPROVAL_WAIT_MS);`;
  const run = (dir) => {
    const env = { PATH: process.env.PATH, HOME: account, PAIRBROWSE_HOME: process.env.PAIRBROWSE_HOME, PAIRBROWSE_APPROVAL_WAIT_MS: "100", CLAUDE_PROJECT_DIR: dir };
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: dir, env, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return Number(out.stdout.trim().split("\n").pop());
  };
  assert.equal(run(proj), 120_000, "the project's value is removed: the default wait");
  assert.equal(run(project("gate-wait-clean")), 100, "set outside the project, it holds");
});

// A malformed PAIRBROWSE_INSTANCE: every hook and the bridge stop with one clear line, no stack trace.
test("a bad PAIRBROWSE_INSTANCE stops the hooks and the bridge with a clear message", () => {
  const dir = project("bad-instance");
  const env = { PATH: process.env.PATH, HOME: account, PAIRBROWSE_INSTANCE: "Not Valid!" };
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__plugin_pairbrowse_browser__browser_navigate", tool_input: { url: "https://example.com" } });
  for (const script of ["guard.mjs", "log.mjs", "session-start.mjs", "launch.mjs", "runs.mjs"]) {
    const out = spawnSync(process.execPath, [join(root, "scripts", script)], { cwd: dir, env, input, encoding: "utf8", timeout: 15_000 });
    assert.equal(out.status, 2, `${script}: ${out.stderr}`);
    assert.equal(out.stdout, "", script);
    assert.match(out.stderr, /^PairBrowse is off: PAIRBROWSE_INSTANCE must be 1 to 32 of a-z, 0-9 and - \(got "Not Valid!"\)\. Fix or remove PAIRBROWSE_INSTANCE/, script);
    assert.equal(out.stderr.trim().split("\n").length, 1, `${script}: one line, no stack trace`);
  }
});

test("a process in such a project resolves the default home and passes neither variable on", () => {
  const proj = project("gate-run");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ env: { PAIRBROWSE_HOME: join(proj, "home"), PAIRBROWSE_PARTICIPANT: "Alice" } }));
  const code = `const p = await import(${JSON.stringify(new URL("../scripts/paths.mjs", import.meta.url).href)});
    const d = await import(${JSON.stringify(new URL("../scripts/launcher/daemon-connect.mjs", import.meta.url).href)});
    const e = d.helperEnv();
    console.log(JSON.stringify({ home: p.HOME, warning: p.SELECTED.warning, env: [e.PAIRBROWSE_HOME, e.PAIRBROWSE_PARTICIPANT, process.env.PAIRBROWSE_HOME] }));`;
  const env = { PATH: process.env.PATH, HOME: account, PAIRBROWSE_HOME: join(proj, "home"), PAIRBROWSE_PARTICIPANT: "Alice", CLAUDE_PROJECT_DIR: proj };
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: proj, env, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  const r = JSON.parse(out.stdout.trim().split("\n").pop());
  assert.equal(r.home, join(account, ".pairbrowse"));
  assert.match(r.warning, /PAIRBROWSE_HOME and PAIRBROWSE_PARTICIPANT set by this project's settings/);
  assert.deepEqual(r.env, [null, null, null], "neither reaches the helper (JSON writes a missing one as null)");
});

// The hooks and the bridge read the same project folder: Claude Code's CLAUDE_PROJECT_DIR (which it
// sets for hooks and MCP servers; .mcp.json passes it too), else the current folder.
test("the hooks and the bridge resolve the same home for the same inputs", () => {
  assert.equal(projectDir({ CLAUDE_PROJECT_DIR: "/p" }, "/c"), "/p");
  for (const odd of [undefined, "", ".", "${CLAUDE_PROJECT_DIR}", "rel/dir"]) assert.equal(projectDir({ CLAUDE_PROJECT_DIR: odd }, "/c"), "/c", String(odd));
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")).mcpServers;
  for (const name of ["browser", "runs"]) assert.equal(mcp[name].env?.CLAUDE_PROJECT_DIR, "${CLAUDE_PROJECT_DIR:-.}", name);

  const proj = project("same-home", '{"instance":"work"}');
  const sub = join(proj, "sub");
  mkdirSync(join(proj, ".claude"), { recursive: true });
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ env: { PAIRBROWSE_HOME: join(proj, "home") } }));
  const hookCode = `const p = await import(${JSON.stringify(new URL("../scripts/paths.mjs", import.meta.url).href)});
    await import(${JSON.stringify(new URL("../scripts/guard.mjs", import.meta.url).href)});
    console.log(JSON.stringify({ home: p.HOME, set: process.env.PAIRBROWSE_HOME ?? null }));`;
  const bridgeCode = `const p = await import(${JSON.stringify(new URL("../scripts/paths.mjs", import.meta.url).href)});
    const d = await import(${JSON.stringify(new URL("../scripts/launcher/daemon-connect.mjs", import.meta.url).href)});
    console.log(JSON.stringify({ home: p.HOME, set: d.helperEnv().PAIRBROWSE_HOME ?? null, instance: d.helperEnv().PAIRBROWSE_INSTANCE }));`;
  const run = (code, cwd, extra) => {
    const env = { PATH: process.env.PATH, HOME: account, PAIRBROWSE_HOME: join(proj, "home"), ...extra };
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd, env, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout.trim().split("\n").pop());
  };
  const want = join(account, ".pairbrowse", "instances", "work");
  // Claude Code started in a subfolder: the hook runs there, the bridge in the plugin's folder;
  // both have CLAUDE_PROJECT_DIR. And a bridge whose client left it unexpanded or defaulted, in the
  // project folder.
  for (const [code, cwd, dir] of [[hookCode, sub, proj], [bridgeCode, root, proj], [bridgeCode, proj, "${CLAUDE_PROJECT_DIR}"], [bridgeCode, proj, "."], [hookCode, proj, undefined]]) {
    const r = run(code, cwd, dir === undefined ? {} : { CLAUDE_PROJECT_DIR: dir });
    assert.equal(r.home, want, `${cwd} ${dir}`);
    assert.equal(r.set, null, "the project's PAIRBROWSE_HOME is removed on both sides");
    if ("instance" in r) assert.equal(r.instance, "work", "the helper the bridge starts gets the instance");
  }
});
