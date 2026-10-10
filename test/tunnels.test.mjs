// The user's own tunnel for sharing (config sharing.tunnel): each kind started with a stand-in
// program on PATH that prints what the real one would and serves nothing; the address read from
// it, credentials kept out of the command line and of everything logged or quoted, a plain
// message when the program is missing or turns the credentials down, and one connection
// started again on its address when it ends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pb-tunnels-"));
process.env.PAIRBROWSE_HOME = home;
process.env.PAIRBROWSE_TEST_RESTART_MS = "200";
delete process.env.PAIRBROWSE_TEST_TUNNEL; // the real pool code path, with stand-in programs
const bin = join(home, "bin");
mkdirSync(bin);
const { tunnelConfig, splitCommand, maskSecrets } = await import("../scripts/tunnels/config.mjs");
const { startOwnTunnel, findOnPath, planFor } = await import("../scripts/tunnels/start.mjs");
const { createSharing } = await import("../scripts/daemon/sharing.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (what, cond, ms = 10_000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await cond()) return; await sleep(50); } throw new Error(`timed out: ${what}`); };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
// A stand-in program: a Node script on our PATH.
function fake(name, body) {
  const file = join(bin, name);
  writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}
const PATH = `${bin}:/usr/bin:/bin`;
const TOKEN = "eyJhIjoiYWJjZGVmIiwidCI6InRva2VuLXNlY3JldC0xMjM0NTYifQ";

test("config: the default is a Quick Tunnel; a bad setting is one plain line naming the key", () => {
  assert.equal(tunnelConfig({}).kind, "quick");
  assert.equal(tunnelConfig({ sharing: {} }).kind, "quick");
  assert.equal(tunnelConfig({ sharing: { tunnel: { kind: "quick" }, guestPort: 0 } }).guestPort, 0);
  const problem = (c) => { try { tunnelConfig(c); return ""; } catch (e) { return e.message; } };
  assert.match(problem({ sharing: { tunnel: { kind: "foo" } } }), /^sharing\.tunnel\.kind in config\.json "foo" isn't one of quick, cloudflare, ngrok, tailscale or command$/);
  assert.match(problem({ sharing: { tunnel: { kind: "cloudflare" } } }), /needs a token for kind cloudflare/);
  assert.match(problem({ sharing: { tunnel: { kind: "cloudflare", token: TOKEN } } }), /sharing\.tunnel\.hostname .* needs a host name like share\.example\.com/);
  assert.match(problem({ sharing: { tunnel: { kind: "ngrok" } } }), /needs an authtoken for kind ngrok/);
  assert.match(problem({ sharing: { tunnel: { kind: "ngrok", authtoken: "a", domain: "not a host" } } }), /sharing\.tunnel\.domain/);
  assert.match(problem({ sharing: { tunnel: { kind: "command" } } }), /needs run for kind command/);
  assert.match(problem({ sharing: { tunnel: { kind: "command", run: "x" } } }), /needs url for kind command/);
  assert.match(problem({ sharing: { tunnel: { kind: "command", run: "x", url: "https://\\S+" } } }), /exactly one capture group/);
  assert.match(problem({ sharing: { tunnel: { kind: "command", run: "x", url: "(" } } }), /isn't a valid regular expression/);
  assert.match(problem({ sharing: { tunnel: { kind: "command", run: "x", url: "(https://\\S+)", env: { A: 1 } } } }), /sharing\.tunnel\.env .* strings/);
  assert.match(problem({ sharing: { guestPort: 70000 } }), /sharing\.guestPort .* port number/);
  assert.match(problem({ sharing: { tunnel: "ngrok" } }), /sharing\.tunnel .* object/);
  // Each kind, read: what's stable, what's secret, how it's described to people.
  const cf = tunnelConfig({ sharing: { tunnel: { kind: "cloudflare", token: TOKEN, hostname: "https://Share.Example.com/" }, guestPort: 47555 } });
  assert.deepEqual([cf.stable, cf.hostname, cf.secrets, cf.guestPort, cf.describe()], [true, "share.example.com", [TOKEN], 47555, "your own Cloudflare tunnel share.example.com"]);
  const ng = tunnelConfig({ sharing: { tunnel: { kind: "ngrok", authtoken: "2abc_tok", domain: "pb.ngrok.app" } } });
  assert.deepEqual([ng.stable, ng.domain, ng.describe()], [true, "pb.ngrok.app", "your own ngrok address pb.ngrok.app"]);
  const ngFree = tunnelConfig({ sharing: { tunnel: { kind: "ngrok", authtoken: "2abc_tok" } } });
  assert.deepEqual([ngFree.stable, ngFree.describe("x.ngrok-free.app")], [false, "your own ngrok address x.ngrok-free.app"]);
  assert.deepEqual([tunnelConfig({ sharing: { tunnel: { kind: "tailscale" } } }).stable, tunnelConfig({ sharing: { tunnel: { kind: "tailscale" } } }).describe("m.tail1.ts.net")], [true, "your Tailscale Funnel address m.tail1.ts.net"]);
  const cmd = tunnelConfig({ sharing: { tunnel: { kind: "command", run: "/opt/t/mytunnel --port {port} -n 'my name'", url: "ready at (https://\\S+)", env: { TOKEN: "secret-token-1", SHORT: "ab" } } } });
  assert.deepEqual([cmd.stable, cmd.argv, cmd.secrets, cmd.describe("t.example.net")], [true, ["/opt/t/mytunnel", "--port", "{port}", "-n", "my name"], ["secret-token-1"], "your own tunnel command (mytunnel, at t.example.net)"]);
});

test("command lines split like a shell, without one; secrets are masked longest first", () => {
  assert.deepEqual(splitCommand(`a  "b c" 'd e' f\\ g "h \\" i"`), ["a", "b c", "d e", "f g", 'h " i']);
  assert.deepEqual(splitCommand(""), []);
  assert.equal(maskSecrets("token=abcdef12 and abcd and ab", ["abcdef12", "abcd", "ab"]), "token=*** and *** and ab");
  assert.equal(maskSecrets("nothing", []), "nothing");
});

test("a program that isn't installed is said so, plainly, before anything starts", async () => {
  assert.equal(findOnPath("ngrok", { path: "/nonexistent" }), null);
  await assert.rejects(startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "ngrok", authtoken: "t" } } }), 4000, { path: "/nonexistent" }), /^Error: ngrok isn't installed; install it and make sure it's on your PATH$/);
  await assert.rejects(startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "tailscale" } } }), 4000, { path: "/nonexistent" }), /tailscale isn't installed \(Tailscale, with Funnel enabled/);
  await assert.rejects(startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "command", run: "mytunnel-missing {port}", url: "(https://\\S+)" } } }), 4000, { path: "/nonexistent" }), /mytunnel-missing isn't installed/);
  await assert.rejects(startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "tailscale" } } }), 0, { path: PATH }), /bad live view port/);
});

test("ngrok: the address from its JSON log, the authtoken in its environment only, the domain on the command line", async () => {
  fake("ngrok", `const fs = require("fs");
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), token: process.env.NGROK_AUTHTOKEN }));
console.log(JSON.stringify({ lvl: "info", msg: "starting web service", obj: "web", addr: "127.0.0.1:4040" }));
setTimeout(() => console.log(JSON.stringify({ lvl: "info", msg: "started tunnel", obj: "tunnels", name: "command_line", addr: "http://localhost:" + process.argv[3], url: "https://pb.ngrok.app" })), 150);
setInterval(() => {}, 1000);`);
  const out = join(home, "ngrok.json");
  process.env.FAKE_OUT = out;
  const logs = [];
  const t = await startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "ngrok", authtoken: TOKEN, domain: "pb.ngrok.app" } } }), 4101, { path: PATH, log: (l) => logs.push(l) });
  try {
    assert.equal(t.url, "https://pb.ngrok.app");
    assert.equal(t.host, "pb.ngrok.app");
    assert.equal(t.own, true);
    const seen = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(seen.argv, ["http", "4101", "--log=stdout", "--log-format=json", "--domain=pb.ngrok.app"]);
    assert.equal(seen.token, TOKEN, "the authtoken reaches ngrok through NGROK_AUTHTOKEN");
    assert.doesNotMatch(logs.join("\n"), new RegExp(TOKEN), "and shows in no log line");
    assert.match(logs.join("\n"), /sharing: starting ngrok http 4101 --log=stdout --log-format=json --domain=pb.ngrok.app/);
    assert.match(logs.join("\n"), /sharing tunnel up: pb\.ngrok\.app \(ngrok\)/);
  } finally { t.stop(); }
  // The free address (no domain), from a logfmt line.
  fake("ngrok", `console.log("t=2026-10-10T10:00:00+0000 lvl=info msg=\\"started tunnel\\" obj=tunnels name=command_line addr=http://localhost:4102 url=https://1a2b-3c4d.ngrok-free.app");\nsetInterval(() => {}, 1000);`);
  const free = await startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "ngrok", authtoken: TOKEN } } }), 4102, { path: PATH });
  try { assert.equal(free.url, "https://1a2b-3c4d.ngrok-free.app"); } finally { free.stop(); }
  // A refused authtoken: said plainly, with the token nowhere in it.
  fake("ngrok", `console.log(JSON.stringify({ lvl: "eror", msg: "failed to reconnect session", err: "authentication failed: The authtoken you specified is invalid: " + process.env.NGROK_AUTHTOKEN + "\\n\\nERR_NGROK_105" }));\nsetTimeout(() => process.exit(1), 50);`);
  const err = await startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "ngrok", authtoken: TOKEN } } }), 4103, { path: PATH }).then(() => null, (e) => e.message);
  assert.equal(err, "the authtoken was refused (check sharing.tunnel in config.json)");
});

test("cloudflare: a named tunnel on the dashboard's host name, the token in its environment only", async () => {
  fake("cloudflared", `const fs = require("fs");
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), token: process.env.TUNNEL_TOKEN }));
console.error("2026-10-10T10:00:00Z INF Starting tunnel tunnelID=1111");
setTimeout(() => console.error("2026-10-10T10:00:01Z INF Registered tunnel connection connIndex=0 connection=abcd location=ams01 protocol=quic"), 200);
setInterval(() => {}, 1000);`);
  const out = join(home, "cf.json");
  process.env.FAKE_OUT = out;
  const logs = [];
  const t0 = Date.now();
  const t = await startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "cloudflare", token: TOKEN, hostname: "share.example.com" } } }), 4201, { path: PATH, log: (l) => logs.push(l) });
  try {
    assert.equal(t.url, "https://share.example.com");
    assert.ok(Date.now() - t0 >= 180, "handed out once cloudflared has a connection");
    const seen = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(seen.argv, ["tunnel", "--no-autoupdate", "run"]);
    assert.equal(seen.token, TOKEN, "the token reaches cloudflared through TUNNEL_TOKEN");
    assert.doesNotMatch(logs.join("\n"), new RegExp(TOKEN));
  } finally { t.stop(); }
  fake("cloudflared", `console.error("2026-10-10T10:00:00Z ERR Couldn't start tunnel error=\\"Provided Tunnel token is not valid: " + process.env.TUNNEL_TOKEN + "\\"");\nsetTimeout(() => process.exit(1), 50);`);
  const err = await startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "cloudflare", token: TOKEN, hostname: "share.example.com" } } }), 4202, { path: PATH }).then(() => null, (e) => e.message);
  assert.equal(err, "the token was refused (check sharing.tunnel in config.json)");
});

test("tailscale: the funnel address from its output; Funnel not enabled is said plainly", async () => {
  fake("tailscale", `console.log("Available on the internet:\\n\\nhttps://My-Mac.tail1234.ts.net/\\n|-- proxy http://127.0.0.1:" + process.argv[3] + "\\n\\nPress Ctrl+C to exit.");\nsetInterval(() => {}, 1000);`);
  const t = await startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "tailscale" } } }), 4301, { path: PATH });
  try {
    assert.equal(t.url, "https://my-mac.tail1234.ts.net");
    const plan = await planFor(tunnelConfig({ sharing: { tunnel: { kind: "tailscale" } } }), 4301, { path: PATH });
    assert.deepEqual(plan.args, ["funnel", "4301"]);
  } finally { t.stop(); }
  fake("tailscale", `console.error("Funnel is not enabled on your tailnet.\\nTo enable, visit: https://login.tailscale.com/f/funnel?node=abc");\nsetTimeout(() => process.exit(1), 50);`);
  const err = await startOwnTunnel(tunnelConfig({ sharing: { tunnel: { kind: "tailscale" } } }), 4302, { path: PATH }).then(() => null, (e) => e.message);
  assert.equal(err, "Funnel was refused (enable Funnel for this computer in the tailnet's settings)");
});

test("command: {port} filled in, env passed, the address by the user's pattern, http refused, its output masked", async () => {
  fake("mytunnel", `const fs = require("fs");
fs.writeFileSync(process.env.FAKE_OUT, JSON.stringify({ argv: process.argv.slice(2), token: process.env.TOKEN }));
console.log("mytunnel: connecting with token " + process.env.TOKEN);
setTimeout(() => console.log("mytunnel: ready at https://t.example.net/ (forwarding to " + process.argv[3] + ")"), 100);
setInterval(() => {}, 1000);`);
  const out = join(home, "cmd.json");
  process.env.FAKE_OUT = out;
  const logs = [];
  const spec = tunnelConfig({ sharing: { tunnel: { kind: "command", run: "mytunnel --port {port} --name 'pair browse'", url: "ready at (https://\\S+)", env: { TOKEN: "secret-token-1" } } } });
  const t = await startOwnTunnel(spec, 4401, { path: PATH, log: (l) => logs.push(l) });
  try {
    assert.equal(t.url, "https://t.example.net");
    const seen = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(seen, { argv: ["--port", "4401", "--name", "pair browse"], token: "secret-token-1" });
    assert.match(t.output(), /connecting with token \*\*\*/, "what the program printed is kept masked");
    assert.doesNotMatch(logs.join("\n"), /secret-token-1/);
  } finally { t.stop(); }
  fake("mytunnel", `console.log("ready at http://t.example.net/");\nsetInterval(() => {}, 1000);`);
  const loose = tunnelConfig({ sharing: { tunnel: { kind: "command", run: "mytunnel", url: "ready at (\\S+)" } } });
  await assert.rejects(startOwnTunnel(loose, 4402, { path: PATH }), /mytunnel gave http, not an https address/);
  fake("mytunnel", `console.error("fatal: could not reach the relay with " + process.env.TOKEN);\nsetTimeout(() => process.exit(3), 50);`);
  const err = await startOwnTunnel(spec, 4403, { path: PATH }).then(() => null, (e) => e.message);
  assert.equal(err, "mytunnel ended (exit 3): fatal: could not reach the relay with ***");
  fake("mytunnel", `setInterval(() => {}, 1000);`);
  await assert.rejects(startOwnTunnel(spec, 4404, { path: PATH, timeoutMs: 300 }), /mytunnel didn't give an address in time/);
});

// The helper's sharing part with stand-ins for the browser and the live view (as devshare-ask.test.mjs).
function sharingWith(config, notes, logs = []) {
  const fakeLive = { url: "http://127.0.0.1:1/k/", port: 1, guestPort: 4501, setStatus() {}, setSession() {}, setCollaboration() {}, setDev() {}, close() {} };
  const view = { currentUrl: () => "about:blank", getContext: async () => ({ pages: () => [] }), status: () => ({}), session: () => null, collaboration: () => ({}), secretDomains: () => [] };
  const hostNote = (t) => notes.push(`note: ${t}`);
  hostNote.drop = () => {};
  return createSharing({ config, log: (l) => logs.push(l), host: "Me", view, notify: (t) => notes.push(`notify: ${t}`), hostNote, startLive: async () => fakeLive });
}

test("sharing: one connection of the user's own, said in plain words, started again on the same address when it ends", { timeout: 30_000 }, async () => {
  const pids = join(home, "pids");
  rmSync(pids, { force: true });
  fake("mytunnel", `require("fs").appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n");\nconsole.log("ready at https://t.example.net/ port " + process.argv[3]);\nsetInterval(() => {}, 1000);`);
  process.env.PATH = PATH;
  const notes = [], logs = [];
  const sharing = sharingWith({ sharing: { tunnel: { kind: "command", run: "mytunnel --port {port}", url: "ready at (https://\\S+)", env: { TOKEN: "secret-token-1" } } } }, notes, logs);
  try {
    const made = await sharing.inviteCommand({ action: "create", role: "watch", share: "code", name: "Bob" }, { who: "Claude Code" });
    assert.equal(made.error, undefined, made.text);
    const code = made.text.match(/Join code: (pb-join:\S+)/)[1];
    const packed = JSON.parse(Buffer.from(code.slice("pb-join:".length), "base64url").toString());
    assert.equal(packed.u, "https://t.example.net", "the code carries the user's own address");
    assert.match(made.text, /It goes through your own tunnel command \(mytunnel, at t\.example\.net\); their PairBrowse shows them t\.example\.net and asks before joining through it/);
    assert.match(made.text, /comes back on the same address/);
    assert.doesNotMatch(made.text, /secret-token-1|free relay/);
    const list = await sharing.inviteCommand({ action: "list" });
    assert.match(list.text, /Join codes go through your own tunnel command \(mytunnel, at t\.example\.net\)\./);
    assert.match(list.text, /code: pb-join:/);
    await sleep(300);
    const first = readFileSync(pids, "utf8").trim().split("\n").map(Number);
    assert.equal(first.length, 1, "one connection, not a pool of two");
    // The program ends: started again on the same address, with no alarm and nothing for the host.
    process.kill(first[0], "SIGTERM");
    await until("the restart", () => readFileSync(pids, "utf8").trim().split("\n").length === 2);
    await until("it's up", () => alive(readFileSync(pids, "utf8").trim().split("\n").map(Number)[1]) && logs.filter((l) => /sharing tunnel up/.test(l)).length >= 2);
    await sleep(200);
    assert.match(logs.join("\n"), /the sharing connection stopped; starting it again/);
    assert.doesNotMatch(logs.join("\n"), /left/);
    assert.deepEqual(notes, [], "the host heard nothing: the code works as before");
    const again = await sharing.inviteCommand({ action: "list" });
    assert.match(again.text, new RegExp(code.replace(/[+/]/g, "\\$&")), "the same code, with the same address");
    assert.doesNotMatch(logs.join("\n"), /secret-token-1/);
    // Ended by the host: the program is stopped and not started again.
    const second = readFileSync(pids, "utf8").trim().split("\n").map(Number)[1];
    sharing.endAll();
    await until("stopped", () => !alive(second));
    await sleep(500);
    assert.equal(readFileSync(pids, "utf8").trim().split("\n").length, 2, "not started again once sharing ended");
  } finally { sharing.endAll(); }
});

test("sharing: a bad setting or a missing program fails create plainly, and nothing is shared", async () => {
  const notes = [];
  const bad = sharingWith({ sharing: { tunnel: { kind: "foo" } } }, notes);
  try {
    const r = await bad.inviteCommand({ action: "create", role: "watch", share: "code", name: "Bob" });
    assert.equal(r.error, true);
    assert.equal(r.text, `Sharing couldn't start: sharing.tunnel.kind in config.json "foo" isn't one of quick, cloudflare, ngrok, tailscale or command. Nothing was shared.`);
    assert.equal((await bad.inviteCommand({ action: "list" })).text, "No invites.");
  } finally { bad.endAll(); }
  rmSync(join(bin, "ngrok"), { force: true });
  process.env.PATH = PATH;
  const missing = sharingWith({ sharing: { tunnel: { kind: "ngrok", authtoken: TOKEN } } }, notes);
  try {
    const r = await missing.inviteCommand({ action: "create", role: "watch", share: "code", name: "Bob" });
    assert.equal(r.text, "Sharing couldn't start: ngrok isn't installed; install it and make sure it's on your PATH. Nothing was shared.");
    assert.equal((await missing.inviteCommand({ action: "list" })).text, "No invites.", "the invite was taken back");
  } finally { missing.endAll(); }
  // A pinned guest port another program holds: said, and nothing shared.
  fake("mytunnel", `console.log("ready at https://t.example.net/");\nsetInterval(() => {}, 1000);`);
  const pinned = sharingWith({ sharing: { guestPort: 4999, tunnel: { kind: "command", run: "mytunnel", url: "ready at (https://\\S+)" } } }, notes);
  try {
    const r = await pinned.inviteCommand({ action: "create", role: "watch", share: "code", name: "Bob" });
    assert.match(r.text, /Sharing couldn't start: port 4999 \(sharing\.guestPort in config\.json\) is in use by another program/);
  } finally { pinned.endAll(); }
  assert.ok(!existsSync(join(home, "sharing.json")), "nothing saved");
});

test.after(() => rmSync(home, { recursive: true, force: true }));
