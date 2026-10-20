// A proxy's credentials (spec server-mode C3, scripts/net/credentials.mjs): reserved secret names
// made from the proxy's id, both needed, each long enough to be masked, and no message holding a
// value; the command line that sets them (net/credentials-cli.mjs); and the value masked or absent
// wherever the helper writes or answers.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { proxySecretNames, credentialsFor, NETWORK_ID } from "../scripts/net/credentials.mjs";
import { reservedSecret, validSecretName, RESERVED_MIN, loadSecrets, redact, secretStore } from "../scripts/rules/secrets.mjs";
import { askHidden, savedProxies } from "../scripts/net/credentials-cli.mjs";
import { createOutput } from "../scripts/daemon/output.mjs";
import { createLogFile } from "../scripts/daemon/logfile.mjs";
import { createDiagnostics } from "../scripts/daemon/diagnostics.mjs";
import { createNetwork } from "../scripts/daemon/network.mjs";
import { EXTENSION_SHELL, shellFrom } from "../scripts/browser/choice.mjs";
import { paths } from "../scripts/paths.mjs";
import { spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";

test("proxy secrets reserved: names from the id, upper-cased with - as _, within a secret name's length", () => {
  assert.deepEqual(proxySecretNames("us-east"), { username: "PAIRBROWSE_PROXY_US_EAST_USERNAME", password: "PAIRBROWSE_PROXY_US_EAST_PASSWORD" });
  const longest = "a".repeat(34);
  assert.ok(NETWORK_ID.test(longest));
  for (const id of ["p", "us-east", "0-9", longest]) {
    for (const name of Object.values(proxySecretNames(id))) {
      assert.ok(reservedSecret(name), `${name} is reserved (never typed into a page)`);
      assert.ok(validSecretName(name), `${name} is a valid secret name`);
    }
  }
  for (const id of ["", "US", "a_b", "-a", "a".repeat(35), null, 7]) assert.equal(proxySecretNames(id), null);
});

test("both credentials needed, each masked-long, never named by value", () => {
  const USER = "proxy-user", PASS = "pass-word-1";
  const values = { PAIRBROWSE_PROXY_US_EAST_USERNAME: USER, PAIRBROWSE_PROXY_US_EAST_PASSWORD: PASS };
  assert.deepEqual(credentialsFor("us-east", values), { username: USER, password: PASS });
  assert.equal(credentialsFor("us-east", {}).problem, 'network "us-east" needs PAIRBROWSE_PROXY_US_EAST_USERNAME and _PASSWORD in secrets.env');
  assert.equal(credentialsFor("us-east", { PAIRBROWSE_PROXY_US_EAST_USERNAME: USER }).problem, 'network "us-east" needs PAIRBROWSE_PROXY_US_EAST_USERNAME and _PASSWORD in secrets.env');
  const short = credentialsFor("us-east", { PAIRBROWSE_PROXY_US_EAST_USERNAME: "abc", PAIRBROWSE_PROXY_US_EAST_PASSWORD: "xyz" });
  assert.match(short.problem, new RegExp(`USERNAME and PAIRBROWSE_PROXY_US_EAST_PASSWORD in secrets\\.env are shorter than ${RESERVED_MIN} characters`));
  assert.ok(!short.problem.includes("abc") && !short.problem.includes("xyz"));
  const broken = credentialsFor("us-east", values, { fileProblem: "secrets.env is readable by other users; run chmod 600 on it." });
  assert.match(broken.problem, /can't be used: secrets\.env is readable by other users/);
  assert.equal(broken.username, undefined, "an unreadable file gives no credentials");
  assert.ok(credentialsFor("US_EAST", values).problem);
});

// The command line (C3), run as a person would, on a home of the test's own.
const CLI = fileURLToPath(new URL("../scripts/net/credentials.mjs", import.meta.url));
const cliHome = () => mkdtempSync(join(tmpdir(), "pb-cred-cli-"));
const cli = (home, args, input = "") => spawnSync(process.execPath, [CLI, ...args], { input, encoding: "utf8", env: { ...process.env, PAIRBROWSE_HOME: home } });

test("set reads stdin, keeps other secrets and 0600; remove and list name no value", { skip: process.platform === "win32" }, () => {
  const home = cliHome();
  const file = join(home, "secrets.env");
  try {
    writeFileSync(file, "SHOP_PW=shop-pass-1\nSHOP_PW_DOMAINS=shop.example\n", { mode: 0o600 });
    const USER = "cli-user-7", PASS = "cli-pass-word-7";
    const set = cli(home, ["set", "us-east"], `${USER}\n${PASS}\n`);
    assert.equal(set.status, 0, set.stderr);
    const saved = loadSecrets(file);
    assert.equal(saved.problem, null);
    assert.equal(saved.values.PAIRBROWSE_PROXY_US_EAST_USERNAME, USER);
    assert.equal(saved.values.PAIRBROWSE_PROXY_US_EAST_PASSWORD, PASS);
    assert.equal(saved.values.SHOP_PW, "shop-pass-1", "another secret kept");
    assert.deepEqual(saved.domains.SHOP_PW, ["shop.example"], "with its sites");
    assert.deepEqual(saved.domains.PAIRBROWSE_PROXY_US_EAST_PASSWORD, [], "a reserved secret gets no sites");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(home).filter((f) => f.endsWith(".tmp")), [], "no temporary file left");
    const list = cli(home, ["list"]);
    assert.equal(list.stdout, "us-east: username saved, password saved\n");
    for (const r of [set, list]) assert.ok(!(r.stdout + r.stderr).includes(PASS) && !(r.stdout + r.stderr).includes(USER), "nothing printed holds a value");
    // A second set replaces both; a short or missing value saves nothing.
    assert.equal(cli(home, ["set", "us-east"], "user-two\npass-two\n").status, 0);
    assert.equal(loadSecrets(file).values.PAIRBROWSE_PROXY_US_EAST_PASSWORD, "pass-two");
    const short = cli(home, ["set", "us-east"], "user-three\nabc\n");
    assert.equal(short.status, 1);
    assert.match(short.stderr, /The password: Too short\. .* Nothing was saved\./);
    assert.ok(!short.stderr.includes("abc") && !short.stderr.includes("user-three"));
    assert.equal(cli(home, ["set", "us-east"], "only-one-line\n").status, 1);
    assert.equal(loadSecrets(file).values.PAIRBROWSE_PROXY_US_EAST_PASSWORD, "pass-two", "unchanged");
    // Usage: a value is never an argument, and a bad id isn't repeated.
    const bad = cli(home, ["set", "Not-An-Id"]);
    assert.equal(bad.status, 2);
    assert.ok(!bad.stderr.includes("Not-An-Id"));
    assert.equal(cli(home, ["set", "us-east", "a-password"]).status, 2, "no value on the command line");
    assert.equal(cli(home, ["nothing"]).status, 2);
    const removed = cli(home, ["remove", "us-east"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /^Removed PAIRBROWSE_PROXY_US_EAST_USERNAME and _PASSWORD from secrets\.env\./);
    assert.deepEqual(Object.keys(loadSecrets(file).values), ["SHOP_PW"]);
    assert.equal(cli(home, ["list"]).stdout, "No proxy credentials are saved.\n");
    assert.match(cli(home, ["remove", "us-east"]).stdout, /No credentials are saved for proxy "us-east"\./);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("set never writes through a secrets.env it can't use: a link, or one others can read", { skip: process.platform === "win32" }, () => {
  const home = cliHome();
  try {
    const elsewhere = join(home, "elsewhere.env");
    writeFileSync(elsewhere, "SHOP_PW=shop-pass-1\n", { mode: 0o600 });
    symlinkSync(elsewhere, join(home, "secrets.env"));
    const linked = cli(home, ["set", "us-east"], "user-one\npass-one\n");
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /is a link; .* Nothing was saved\./);
    assert.equal(readFileSync(elsewhere, "utf8"), "SHOP_PW=shop-pass-1\n", "the file it points to is untouched");
    rmSync(join(home, "secrets.env"));
    writeFileSync(join(home, "secrets.env"), "SHOP_PW=shop-pass-1\n", { mode: 0o644 });
    chmodSync(join(home, "secrets.env"), 0o644);
    const open = cli(home, ["set", "us-east"], "user-one\npass-one\n");
    assert.equal(open.status, 1);
    assert.match(open.stderr, /readable by other users; run chmod 600 on it\. .* Nothing was saved\./);
    assert.equal(readFileSync(join(home, "secrets.env"), "utf8"), "SHOP_PW=shop-pass-1\n");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("at a terminal both values are typed with echo off", async () => {
  // A terminal stand-in: raw mode switched on for the typing and off after, nothing echoed.
  const input = Object.assign(new EventEmitter(), { modes: [], setRawMode(on) { this.modes.push(on); }, setEncoding() {}, resume() {}, pause() {} });
  let shown = "";
  const out = { write: (s) => { shown += s; } };
  const typed = askHidden("Password (not shown): ", { input, out });
  input.emit("data", "secr");
  input.emit("data", "x\u007fet-1");
  input.emit("data", "\r");
  assert.equal(await typed, "secret-1");
  assert.deepEqual(input.modes, [true, false]);
  assert.equal(shown, "Password (not shown): \n", "only the prompt and a line end shown");
  const stopped = askHidden("Username (not shown): ", { input, out });
  input.emit("data", "ab\u0003");
  assert.equal(await stopped, null, "Ctrl-C stops");
  assert.deepEqual(savedProxies({ PAIRBROWSE_PROXY_US_EAST_PASSWORD: "x", PAIRBROWSE_PROXY_A_B_USERNAME: "y", SHOP_PW: "z", PAIRBROWSE_WEBHOOK_URL: "w" }),
    [{ id: "a-b", username: true, password: false }, { id: "us-east", username: false, password: true }]);
});

test("passwords masked in tool output, hook log, daemon.log and its stderr, diagnostics", async () => {
  const USER = "mask-user-41", PASS = "mask-pass-word-41";
  const values = { PAIRBROWSE_PROXY_US_EAST_USERNAME: USER, PAIRBROWSE_PROXY_US_EAST_PASSWORD: PASS };
  const said = `proxy said 407 to ${USER}:${PASS} at http://${USER}:${PASS}@proxy.example:3128`;
  const gone = (text, where) => { assert.ok(!text.includes(PASS) && !text.includes(USER), `${where}: ${text}`); assert.match(text, /PAIRBROWSE_PROXY_US_EAST_PASSWORD/, where); };
  // What agents read.
  const dir = mkdtempSync(join(tmpdir(), "pb-cred-mask-"));
  try {
    gone(createOutput({ dir, secretValues: () => values }).mask(said), "tool output");
    // daemon.log, and what the helper writes to its stderr (the same file).
    const logPath = join(dir, "daemon.log");
    const err = { write: (chunk) => { appendFileSync(logPath, chunk); return true; } };
    const lf = createLogFile({ file: logPath, streams: [err] });
    lf.maskWith(() => values);
    lf.log(said);
    err.write(`${said}\n`);
    gone(readFileSync(logPath, "utf8"), "daemon.log and stderr");
    // The Tools tab's diagnostics report, read from that log with the helper's mask.
    writeFileSync(logPath, `2026-10-21T00:00:00.000Z error: ${said}\n`);
    const diag = createDiagnostics({ version: "1.0.0", logFile: logPath, home: dir, mask: (t) => redact(t, values) });
    const read = await diag.read();
    const report = diag.reportText(read);
    assert.ok(!report.includes(PASS) && !report.includes(USER) && !JSON.stringify(read).includes(PASS), "diagnostics");
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The hook log (scripts/log.mjs), with the values in this home's secrets.env as the CLI writes them.
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(paths.secrets, `PAIRBROWSE_PROXY_US_EAST_USERNAME="${USER}"\nPAIRBROWSE_PROXY_US_EAST_PASSWORD="${PASS}"\n`, { mode: 0o600 });
  try {
    execFileSync(process.execPath, [fileURLToPath(new URL("../scripts/log.mjs", import.meta.url))], { input: JSON.stringify({ tool_name: "mcp__plugin_pairbrowse_browser__browser_type", tool_input: { element: "Notes", text: said }, session_id: "cred" }), env: process.env });
    const logs = readdirSync(paths.log).map((f) => readFileSync(join(paths.log, f), "utf8")).join("\n");
    assert.ok(logs.length > 0, "the hook wrote its line");
    gone(logs, "hook log");
  } finally { rmSync(paths.secrets, { force: true }); }
});

test("a credential appears in no launch error, observation file or config.json; set while the helper runs, its log masks it at the launch", async () => {
  const base = mkdtempSync(join(tmpdir(), "pb-cred-launch-"));
  const USER = "late-user-51", PASS = "late-pass-word-51";
  try {
    const configFile = join(base, "config.json"), secretsFile = join(base, "secrets.env");
    const config = JSON.stringify({ network: { proxies: { "us-east": { server: "http://203.0.113.10:3128", auth: true } }, sessions: { shop: "us-east" } } });
    writeFileSync(configFile, config);
    writeFileSync(secretsFile, "SHOP_PW=shop-pass-1\n", { mode: 0o600 });
    // The helper's store, read before the credentials exist; the CLI adds them afterwards.
    const store = secretStore(secretsFile);
    assert.equal(cli(base, ["set", "us-east"], `${USER}\n${PASS}\n`).status, 0);
    assert.equal(readFileSync(configFile, "utf8"), config, "config.json untouched by the CLI");
    const lines = [];
    const part = createNetwork({ log: (l) => lines.push(l), configFile, secretsFile, readSecrets: () => store.reload(), runDir: join(base, "run"), observationsFile: (s) => join(base, s, "network.json"),
      probe: async (a) => (a.proxy ? { ok: true, ip: "203.0.113.10", loc: "US" } : { ok: true, ip: "192.0.2.1", loc: "DE" }),
      inBrowser: async () => ({ browser: { ok: true, ip: "198.51.100.9", loc: "US" }, webrtc: { ok: true, candidates: [] } }) });
    const lp = part.forLaunch("shop", { shell: shellFrom({ chrome: 1, proxyAuthFile: 1 }) });
    assert.equal(store.get().values.PAIRBROWSE_PROXY_US_EAST_PASSWORD, PASS, "the store, and so every log it masks, knows the value from this launch on");
    const r = await part.checkAtLaunch({}, "shop", lp);
    lp.drop();
    assert.equal(r.ok, false, "the exits differ: refused");
    const kept = readFileSync(join(base, "shop", "network.json"), "utf8");
    for (const [what, text] of [["launch error", r.refusal], ["observation file", kept], ["log", lines.join("\n")], ["config.json", readFileSync(configFile, "utf8")]]) {
      assert.ok(!text.includes(PASS) && !text.includes(USER), `no credential in the ${what}`);
    }
    // On a build that can't take credentials, the launch error names the secrets, never their values.
    assert.throws(() => part.forLaunch("shop", { shell: EXTENSION_SHELL }), (e) => !e.message.includes(PASS) && !e.message.includes(USER) && /can't take them/.test(e.message));
  } finally { rmSync(base, { recursive: true, force: true }); }
});
