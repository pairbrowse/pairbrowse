// Interruptions per flow: realistic sign-up and settings flows go with no user prompt and no
// refusal; a card checkout, a red delete button and a click the agent names "Send:" still ask.
// A prompt is what the PreToolUse hook (scripts/guard.mjs decide) asks Claude Code's user about;
// a refusal is the helper sending the call back.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = (title, body) => `<!doctype html><title>${title}</title><style>body{font-family:sans-serif} .danger{background:#d93025;color:#fff;border:0;padding:6px}</style>
<div id="cookies" role="dialog" aria-label="Cookies"><p>We use cookies.</p><button type="button" style="background:#1a73e8;color:#fff" onclick="this.parentElement.remove()">Accept all</button><button type="button" onclick="this.parentElement.remove()">Reject</button></div>
<h1>${title}</h1>${body}`;
// A sign-up in three pages with no step markup (as most sites have), each an ordinary POST.
const PAGES = {
  "/signup": page("Create your account", `<form method="post" action="/signup/2">
    <label>Full name <input name="name" autocomplete="name"></label>
    <label>Email <input name="email" type="email" autocomplete="email"></label>
    <button>Continue</button></form>`),
  "/signup/2": page("Choose a password", `<form method="post" action="/signup/3">
    <label>Password <input name="pw" type="password" autocomplete="new-password"></label>
    <label>Repeat password <input name="pw2" type="password" autocomplete="new-password"></label>
    <button type="button" onclick="document.querySelectorAll('[type=password]').forEach((x) => x.type = 'text')">Show password</button>
    <button>Continue</button></form>`),
  "/signup/3": page("About your business", `<form method="post" action="/welcome">
    <label>Company <input name="company" autocomplete="organization"></label>
    <label>Website <input name="site" type="url"></label>
    <label><input type="checkbox" name="terms"> I accept the terms</label>
    <button>Create account</button></form>`),
  "/welcome": page("Welcome", `<p>Your account is ready.</p><a href="/settings">Settings</a>`),
  "/settings": page("Store settings", `<form method="post" action="/settings/saved">
    <label>Store name <input name="store" value="Ada's"></label>
    <label>Time zone <select name="tz"><option>UTC</option><option>Europe/Berlin</option></select></label>
    <button type="button" role="switch" aria-checked="false" onclick="this.setAttribute('aria-checked', 'true')">Email notifications</button>
    <button type="button" onclick="document.getElementById('more').hidden = false">Add another contact</button><input id="more" name="more" hidden>
    <button>Save changes</button></form>`),
  "/settings/saved": page("Settings saved", `<p>Saved.</p>`),
  "/checkout": page("Checkout", `<form method="post" action="/paid">
    <label>Card number <input name="cc" autocomplete="cc-number"></label>
    <label>Expiry <input name="exp" autocomplete="cc-exp"></label>
    <button>Place order</button></form>`),
  "/account": page("Account", `<button type="button" class="danger" onclick="document.body.dataset.gone = 1">Delete account</button>`),
  "/inbox": page("Inbox", `<form method="post" action="/sent"><label>Reply <textarea name="body"></textarea></label><button>Send</button></form>`),
};

function connect(socketPath, app) {
  const sock = net.createConnection(socketPath);
  const waiting = new Map();
  createInterface({ input: sock }).on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  let seq = 0;
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = `c${++seq}`;
    const timer = setTimeout(() => reject(new Error(`timed out: ${method} ${params.name || ""}`)), 60_000);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    sock.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return new Promise((ok, no) => { sock.once("error", no); sock.once("connect", async () => {
    await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: app, version: "1" } });
    sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    ok({ sock, call });
  }); });
}

test("ordinary flows never interrupt; real commitments ask", { skip: !runtime, timeout: 180_000 }, async () => {
  const { decide } = await import("../scripts/guard.mjs");
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("playwright").chromium.executablePath();
  const posted = [];
  const fixture = createServer((req, res) => {
    const path = req.url.split("?")[0];
    if (req.method === "POST") posted.push(path);
    res.writeHead(PAGES[path] ? 200 : 404, { "content-type": "text/html" });
    res.end(PAGES[path] || "<title>Not found</title>");
  });
  await new Promise((r) => fixture.listen(0, "127.0.0.1", r));
  const base = join(tmpdir(), "pbt");
  mkdirSync(base, { recursive: true });
  const home = mkdtempSync(join(base, "cf-"));
  symlinkSync(runtime, join(home, "runtime"), "dir");
  const chromeArgs = ["--headless=new", `--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${fixture.address().port}`];
  writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath, chromeArgs, display: "none", screenshots: false, browserDriver: "playwright" }));
  const out = openSync(join(home, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: home }, stdio: ["ignore", out, out] });
  const socketPath = join(home, "run", "browser.sock");
  const site = "http://shop.pbtest.example";
  let stage = "start", claude, codex;
  // Every call goes through the hook as Claude Code runs it, then the helper; both are counted.
  const counts = {};
  let flow = "";
  const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
  const call = async (name, args = {}) => {
    const c = (counts[flow] ||= { calls: 0, prompts: 0, refusals: 0 });
    c.calls++;
    const verdict = decide({ tool_name: `mcp__plugin_pairbrowse_browser__${name}`, tool_input: args }, {}, null).hookSpecificOutput.permissionDecision;
    if (verdict === "ask") c.prompts++;
    assert.notEqual(verdict, "deny", `${name} denied`);
    const r = await claude.call("tools/call", { name, arguments: args });
    if (r.result?.isError && /^Refused|Stopped|stopped|refused/.test(text(r))) { c.refusals++; (c.why ||= []).push(`${name}: ${text(r).slice(0, 300)}`); }
    return r;
  };
  const snap = async () => text(await claude.call("tools/call", { name: "browser_snapshot", arguments: {} }));
  const ref = (s, role, name) => s.match(new RegExp(`${role} "${name}"[^\\n]*\\[ref=(f?\\d*e\\d+)\\]`))?.[1];
  const click = async (role, name, element = name) => { const s = await snap(); const target = ref(s, role, name); assert.ok(target, `${role} "${name}" in ${s.slice(0, 800)}`); return call("browser_click", { target, element }); };
  const type = async (name, value) => { const s = await snap(); return call("browser_type", { target: ref(s, "textbox", name), text: value }); };
  const at = async (title) => { for (let i = 0; i < 50; i++) { if ((await snap()).includes(title)) return; await sleep(200); } assert.fail(`never reached "${title}"`); };
  try {
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    // The socket file can show a moment before the helper listens on it (a busy machine): retry.
    for (let i = 0; !claude; i++) claude = await connect(socketPath, "claude-code").catch(async (e) => { if (i > 50) throw e; await sleep(200); });

    stage = "sign-up, step by step with browser_click";
    flow = "sign-up (clicks)";
    await call("browser_navigate", { url: `${site}/signup` });
    await click("button", "Accept all");
    await type("Full name", "Ada Lovelace");
    await type("Email", "ada@example.com");
    assert.ok(!(await click("button", "Continue")).result.isError);
    await at("Choose a password");
    await type("Password", "x-Long-Passw0rd");
    await type("Repeat password", "x-Long-Passw0rd");
    assert.ok(!(await click("button", "Show password")).result.isError);
    assert.ok(!(await click("button", "Continue")).result.isError);
    await at("About your business");
    await type("Company", "Analytical Engines");
    await call("browser_click", { target: ref(await snap(), "checkbox", "I accept the terms"), element: "I accept the terms" });
    assert.ok(!(await click("button", "Create account")).result.isError);
    await at("Your account is ready");

    stage = "the same sign-up in fast mode";
    flow = "sign-up (fast mode)";
    const run = async (steps) => { const r = await call("pairbrowse_run", { steps }); assert.ok(!r.result?.isError, text(r)); return text(r); };
    await run([{ go: `${site}/signup` }, { fill: { "Full name": "Ada Lovelace", Email: "ada@example.com" } }, { click: "Continue" }, { waitFor: "Choose a password" }]);
    await run([{ fill: { Password: "x-Long-Passw0rd", "Repeat password": "x-Long-Passw0rd" } }, { click: "Show password" }, { click: "Continue" }, { waitFor: "About your business" }]);
    await run([{ fill: { Company: "Analytical Engines" } }, { check: "I accept the terms" }, { click: "Create account" }, { waitFor: "Your account is ready" }]);

    stage = "settings and save";
    flow = "settings";
    await call("browser_navigate", { url: `${site}/settings` });
    await type("Store name", "Ada's Engines");
    await call("browser_select_option", { target: ref(await snap(), "combobox", "Time zone"), values: ["Europe/Berlin"] });
    assert.ok(!(await click("switch", "Email notifications")).result.isError);
    assert.ok(!(await click("button", "Add another contact")).result.isError);
    assert.ok(!(await click("button", "Save changes")).result.isError);
    await at("Settings saved");
    assert.deepEqual(posted.filter((p) => p !== "/paid" && p !== "/sent").length, 7, "every ordinary submit went through");

    stage = "checkout with card fields";
    flow = "checkout";
    await call("browser_navigate", { url: `${site}/checkout` });
    await type("Card number", "4242424242424242");
    const order = await click("button", "Place order");
    assert.match(text(order), /^Refused[^\n]*final action \(pay\)/, "refused until named");
    const fast = await claude.call("tools/call", { name: "pairbrowse_run", arguments: { steps: [{ click: "Place order" }] } });
    assert.match(text(fast), /\(pay\)[^\n]*browser_click/, "fast mode stops at it");
    counts.checkout.refusals++;
    const named = { target: ref(await snap(), "button", "Place order"), element: "Pay: Place order" };
    assert.equal(decide({ tool_name: "mcp__plugin_pairbrowse_browser__browser_click", tool_input: named }, {}, null).hookSpecificOutput.permissionDecision, "ask");
    counts.checkout.prompts++; // the user would confirm here; the test doesn't press it
    assert.ok(!posted.includes("/paid"), "nothing paid");

    stage = "a red delete button";
    flow = "delete";
    await call("browser_navigate", { url: `${site}/account` });
    assert.match(text(await click("button", "Delete account")), /^Refused[^\n]*\(delete\)/);
    const del = await click("button", "Delete account", "Delete: Delete account");
    assert.ok(!del.result.isError, text(del));

    stage = "a reply the agent names Send:";
    flow = "send";
    await call("browser_navigate", { url: `${site}/inbox` });
    await type("Reply", "Thanks!");
    const send = await click("button", "Send", "Send: Send reply");
    assert.ok(!send.result.isError, text(send));

    stage = "Codex: named final actions are handed to the user";
    codex = await connect(socketPath, "codex-mcp-client");
    const opened = await codex.call("tools/call", { name: "browser_tabs", arguments: { action: "new", url: `${site}/inbox` } });
    assert.ok(!opened.result?.isError, text(opened));
    const cs = text(await codex.call("tools/call", { name: "browser_snapshot", arguments: {} }));
    const handed = await codex.call("tools/call", { name: "browser_click", arguments: { target: ref(cs, "button", "Send"), element: "Send: Send reply" } });
    assert.match(text(handed), /final action \(send\)\. This needs the user's OK/);

    const report = Object.entries(counts).map(([f, c]) => `${f}: ${c.calls} calls, ${c.prompts} prompts, ${c.refusals} refusals${c.why ? ` (${c.why.join("; ")})` : ""}`).join("\n");
    console.log(`click prompts per flow:\n${report}`);
    for (const f of ["sign-up (clicks)", "sign-up (fast mode)", "settings"]) assert.deepEqual([counts[f].prompts, counts[f].refusals], [0, 0], `${f} interrupts nobody\n${report}`);
    assert.equal(counts.checkout.prompts, 1);
    assert.equal(counts.delete.prompts, 1);
    assert.equal(counts.send.prompts, 1);
  } catch (e) {
    let log = ""; try { log = readFileSync(join(home, "daemon.log"), "utf8").slice(-2500); } catch {}
    throw new Error(`${stage}: ${e.message}\n${log}`);
  } finally {
    claude?.sock.destroy();
    codex?.sock.destroy();
    fixture.close();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(home, { recursive: true, force: true });
  }
});
