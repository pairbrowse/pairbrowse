import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, symlinkSync, writeFileSync, unlinkSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function waitForLine(socket, predicate, timeout = 20_000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => { cleanup(); reject(new Error("timed out waiting for daemon response")); }, timeout);
    const cleanup = () => { clearTimeout(timer); socket.off("data", onData); socket.off("error", onError); };
    const onError = (e) => { cleanup(); reject(e); };
    const onData = (chunk) => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (predicate(msg)) { cleanup(); resolve(msg); return; }
      }
    };
    socket.on("data", onData); socket.on("error", onError);
  });
}

// app: the client name sent in initialize. Claude Code ("claude-code") runs the safety hook
// itself; any other app gets the hook's rules applied by the helper.
async function connectClient(socketPath, label, app = "claude-code") {
  const socket = net.createConnection(socketPath);
  await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let seq = 0;
  const call = (method, params = {}) => {
    const id = String(++seq);
    socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return waitForLine(socket, (msg) => msg.id === id);
  };
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: app, version: "1", pairbrowseParticipant: label } });
  socket.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return { socket, call };
}

async function waitForSocket(path) {
  for (let i = 0; i < 100; i++) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("daemon socket did not appear");
}

test("two clients share one browser and survive peer disconnect", { skip: !runtime, timeout: 90_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("playwright").chromium.executablePath();
  const home = mkdtempSync(join(tmpdir(), "pairbrowse-shared-"));
  const linkedRuntime = join(home, "runtime");
  symlinkSync(runtime, linkedRuntime, "dir");
  writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", liveViewPort: 0 }));
  const socketPath = join(home, "run", "browser.sock");
  const daemonOutput = openSync(join(home, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], {
    cwd: root, env: { ...process.env, PAIRBROWSE_HOME: home }, stdio: ["ignore", daemonOutput, daemonOutput],
  });
  let alice; let bob; let fixture; let stage = "starting daemon";
  try {
    await waitForSocket(socketPath);
    fixture = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<title>Pairbrowse fixture</title><main>shared fixture</main><button id='go'>Go</button>");
    });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${fixture.address().port}/fixture`;
    stage = "connecting clients";
    alice = await connectClient(socketPath, "Alice"); bob = await connectClient(socketPath, "Bob");
    stage = "listing tools";
    const tools = await alice.call("tools/list");
    assert.ok(tools.result.tools.some((tool) => tool.name === "pairbrowse_collaboration"));
    stage = "another app's local-network navigation handed to the user";
    const other = await connectClient(socketPath, "Other", "codex-mcp-client");
    const handed = await other.call("tools/call", { name: "browser_navigate", arguments: { url } });
    assert.equal(handed.result.isError, true);
    assert.match(handed.result.content[0].text, /local network.*ask the user to do this step themselves/s);
    // A pay click is handed off too, and a second initialize can't relabel the app as Claude Code.
    await other.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "claude-code", version: "1" } });
    const pay = await other.call("tools/call", { name: "browser_click", arguments: { element: "Pay: Pay now", target: "#pay" } });
    assert.equal(pay.result.isError, true);
    assert.match(pay.result.content[0].text, /final action \(pay\)\. This needs the user's OK/);
    const send = await other.call("tools/call", { name: "browser_click", arguments: { element: "Send: Go", target: "#go" } });
    assert.match(send.result.content[0].text, /final action \(send\)\. This needs the user's OK/, "another app's final actions are handed to the user");
    stage = "invite links";
    // Another app can't make a drive link (that needs the user's OK); a watch link works, and
    // a drive link's key never reaches the Profile panel.
    const drive = await other.call("tools/call", { name: "pairbrowse_invite", arguments: { action: "create", role: "drive", label: "Dee" } });
    assert.equal(drive.result.isError, true);
    assert.match(drive.result.content[0].text, /This needs the user's OK/);
    const watch = await other.call("tools/call", { name: "pairbrowse_invite", arguments: { action: "create", role: "watch", label: "Wes", hours: 1, share: "link" } });
    assert.ok(!watch.result.isError, watch.result.content[0].text);
    const link = watch.result.content[0].text.match(/Link: (http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/)/)?.[1];
    assert.ok(link, watch.result.content[0].text);
    assert.match(watch.result.content[0].text, /ssh -N -L (\d+):127\.0\.0\.1:\1 /);
    assert.equal((await fetch(link)).status, 200);
    assert.equal((await fetch(`${link}profile.json`)).status, 403);
    assert.equal((await fetch(`${link}input`, { method: "POST", body: "{}" })).status, 403);
    const listed = await other.call("tools/call", { name: "pairbrowse_invite", arguments: { action: "list" } });
    assert.match(listed.result.content[0].text, /Wes, watch only/);
    assert.doesNotMatch(listed.result.content[0].text, /[0-9a-f]{64}/, "list never shows keys");
    await other.call("tools/call", { name: "pairbrowse_invite", arguments: { action: "revoke_all" } });
    assert.equal((await fetch(link)).status, 404);
    other.socket.destroy();
    // A connection that never says which app it is gets the same rules.
    const anon = net.createConnection(socketPath);
    await new Promise((resolve, reject) => { anon.once("connect", resolve); anon.once("error", reject); });
    anon.write(JSON.stringify({ jsonrpc: "2.0", id: "x1", method: "tools/call", params: { name: "browser_click", arguments: { element: "Delete: Delete account", target: "#delete" } } }) + "\n");
    const anonReply = await waitForLine(anon, (m) => m.id === "x1");
    assert.equal(anonReply.result.isError, true);
    assert.match(anonReply.result.content[0].text, /final action \(delete\)/);
    anon.destroy();
    await new Promise((resolve) => setTimeout(resolve, 200));
    stage = "denying profile use while peers connected";
    const profileDenied = await alice.call("tools/call", { name: "pairbrowse_session", arguments: { action: "new", name: "two-peers" } });
    assert.equal(profileDenied.result.isError, true);
    stage = "Alice acquiring";
    const acquired = await alice.call("tools/call", { name: "pairbrowse_collaboration", arguments: { action: "acquire" } });
    assert.equal(acquired.result.isError, undefined);
    stage = "Bob denied acquire";
    const denied = await bob.call("tools/call", { name: "pairbrowse_collaboration", arguments: { action: "acquire" } });
    assert.equal(denied.result.isError, true);
    stage = "Alice navigating";
    const navigate = await alice.call("tools/call", { name: "browser_navigate", arguments: { url } });
    assert.equal(navigate.result.isError, undefined);
    const aliceSnapshot = await alice.call("tools/call", { name: "browser_snapshot", arguments: {} });
    const aliceText = aliceSnapshot.result.content?.map((part) => part.text || "").join("\n") || "";
    const buttonRef = aliceText.match(/button[^\n]*\[ref=([^\]]+)\]/)?.[1];
    assert.ok(buttonRef, `button ref missing in snapshot: ${aliceText}`);
    stage = "Alice clicking a plain button";
    // A plain button the page's scripts run: it goes, no refusal.
    const plain = await alice.call("tools/call", { name: "browser_click", arguments: { element: "Go", target: buttonRef } });
    assert.ok(!plain.result.isError, plain.result.content[0].text);
    const dialogTool = tools.result.tools.find((t) => t.name === "browser_handle_dialog");
    assert.ok(dialogTool.inputSchema.properties.element, "a dialog's OK is named like a click");
    stage = "Alice releasing";
    const release = await alice.call("tools/call", { name: "pairbrowse_collaboration", arguments: { action: "release" } });
    assert.equal(release.result.isError, undefined);
    stage = "Bob acquiring";
    const bobAcquire = await bob.call("tools/call", { name: "pairbrowse_collaboration", arguments: { action: "acquire" } });
    assert.equal(bobAcquire.result.isError, undefined);
    stage = "Bob snapshot";
    const snapshot = await bob.call("tools/call", { name: "browser_snapshot", arguments: {} });
    const snapshotText = snapshot.result.content?.map((part) => part.text || "").join("\n") || "";
    assert.match(snapshotText, /Pairbrowse fixture|shared fixture/);
    await bob.call("tools/call", { name: "pairbrowse_collaboration", arguments: { action: "release" } });
    const bobReacquire = await bob.call("tools/call", { name: "pairbrowse_collaboration", arguments: { action: "acquire" } });
    assert.equal(bobReacquire.result.isError, undefined);
    await bob.call("tools/call", { name: "browser_snapshot", arguments: {} });
    await bob.call("tools/call", { name: "pairbrowse_collaboration", arguments: { action: "release" } });
    const aliceReacquire = await alice.call("tools/call", { name: "pairbrowse_collaboration", arguments: { action: "acquire" } });
    assert.equal(aliceReacquire.result.isError, undefined);
    const staleClick = await alice.call("tools/call", { name: "browser_click", arguments: { ref: buttonRef } });
    assert.equal(staleClick.result.isError, true);
    alice.socket.destroy(); alice = null;
    stage = "waiting for Alice's lease to end";
    for (let i = 0; i < 50; i++) {
      const status = await bob.call("tools/call", { name: "pairbrowse_collaboration", arguments: { action: "status" } });
      if (!JSON.parse(status.result.content[0].text).owner) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    stage = "Bob snapshot after disconnect";
    const afterDisconnect = await bob.call("tools/call", { name: "browser_snapshot", arguments: {} });
    assert.equal(afterDisconnect.result.isError, undefined, JSON.stringify(afterDisconnect.result));
  } catch (error) {
    const daemonLog = (() => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } })();
    const stderr = (() => { try { return readFileSync(join(home, "daemon.stderr.log"), "utf8"); } catch { return ""; } })();
    console.error(`shared-browser integration failed at ${stage}\n${daemonLog}\n${stderr}`);
    throw error;
  } finally {
    alice?.socket.destroy(); bob?.socket.destroy();
    if (daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => daemon.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]);
    }
    fixture?.closeAllConnections?.();
    if (fixture) await new Promise((resolve) => fixture.close(resolve));
    unlinkSync(linkedRuntime);
    rmSync(home, { recursive: true, force: true });
  }
});

// Claude Code advertises roots, so the browser server asks it for them in the middle of a call.
// That answer must not wait behind the call that is waiting for it.
test("a client that answers roots/list mid-call isn't deadlocked", { skip: !runtime, timeout: 60_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("playwright").chromium.executablePath();
  const home = mkdtempSync(join(tmpdir(), "pairbrowse-roots-"));
  const linkedRuntime = join(home, "runtime");
  symlinkSync(runtime, linkedRuntime, "dir");
  writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", liveViewPort: 0 }));
  const socketPath = join(home, "run", "browser.sock");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: home }, stdio: "ignore" });
  let socket;
  try {
    await waitForSocket(socketPath);
    socket = net.createConnection(socketPath);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    let rootsAsked = false;
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk;
      let at;
      while ((at = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, at); buf = buf.slice(at + 1);
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.method === "roots/list") {
          rootsAsked = true;
          socket.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { roots: [{ uri: `file://${home}`, name: "test" }] } }) + "\n");
        }
      }
    });
    let seq = 0;
    const call = (method, params = {}) => {
      const id = `r${++seq}`;
      socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return waitForLine(socket, (msg) => msg.id === id);
    };
    await call("initialize", { protocolVersion: "2025-06-18", capabilities: { roots: { listChanged: true } }, clientInfo: { name: "roots-test", version: "1" } });
    socket.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const snapshot = await call("tools/call", { name: "browser_snapshot", arguments: {} });
    assert.ok(snapshot.result, JSON.stringify(snapshot));
    assert.ok(rootsAsked, "the server never asked for roots, so this test proves nothing");
  } finally {
    socket?.destroy();
    if (daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => daemon.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
    unlinkSync(linkedRuntime);
    rmSync(home, { recursive: true, force: true });
  }
});

// Each agent's current tab is a page, not a number: after browser_tabs new the new tab is its own
// whatever the others do, and closing its tab never hands it another agent's tab (the numbers
// shift when tabs open and close).
test("two agents' tabs stay their own through new, navigate and close", { skip: !runtime, timeout: 120_000 }, async () => {
  const require = createRequire(join(runtime, "package.json"));
  const executablePath = require("playwright").chromium.executablePath();
  const home = mkdtempSync(join(tmpdir(), "pairbrowse-tabs-"));
  const linkedRuntime = join(home, "runtime");
  symlinkSync(runtime, linkedRuntime, "dir");
  writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", liveViewPort: 0, screenshots: false }));
  const socketPath = join(home, "run", "browser.sock");
  const daemonOutput = openSync(join(home, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], {
    cwd: root, env: { ...process.env, PAIRBROWSE_HOME: home }, stdio: ["ignore", daemonOutput, daemonOutput],
  });
  let alice; let bob; let fixture; let stage = "starting daemon";
  const text = (r) => r.result?.content?.map((part) => part.text || "").join("\n") || JSON.stringify(r);
  const tabs = async (who) => {
    const r = await who.call("tools/call", { name: "browser_tabs", arguments: { action: "list" } });
    return [...text(r).matchAll(/^- (\d+):( \(current\))? \[[^\n]*\]\(([^)\s]*)\)/gm)].map((m) => ({ index: Number(m[1]), current: !!m[2], path: m[3].replace(/^http:\/\/127\.0\.0\.1:\d+/, "") }));
  };
  const currentPath = async (who) => (await tabs(who)).find((t) => t.current)?.path;
  const ok = async (who, name, args) => {
    const r = await who.call("tools/call", { name, arguments: args });
    assert.equal(r.result?.isError, undefined, `${name} ${JSON.stringify(args)}: ${text(r)}`);
    return r;
  };
  try {
    await waitForSocket(socketPath);
    fixture = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(`<title>${req.url}</title><main>${req.url}</main>`); });
    await new Promise((resolve) => fixture.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${fixture.address().port}`;
    stage = "connecting";
    alice = await connectClient(socketPath, "Alice"); bob = await connectClient(socketPath, "Bob");
    await ok(alice, "browser_navigate", { url: `${base}/start` }); // Alice's first tab: 0

    stage = "both open a tab before either navigates";
    await ok(alice, "browser_tabs", { action: "new" }); // 1, about:blank
    await ok(bob, "browser_tabs", { action: "new" }); // 2, about:blank too
    await ok(bob, "browser_navigate", { url: `${base}/bob` });
    await ok(alice, "browser_navigate", { url: `${base}/alice` });
    assert.deepEqual((await tabs(alice)).map((t) => t.path), ["/start", "/alice", "/bob"]);
    assert.equal(await currentPath(alice), "/alice");
    assert.equal(await currentPath(bob), "/bob");

    stage = "Alice closes her tab: Bob's slides into its number";
    await ok(alice, "browser_tabs", { action: "close" });
    assert.equal(await currentPath(alice), "/start", "back to the tab she used before, not Bob's");
    await ok(alice, "browser_navigate", { url: `${base}/alice-again` });
    await ok(bob, "browser_navigate", { url: `${base}/bob-again` });
    assert.deepEqual((await tabs(bob)).map((t) => t.path), ["/alice-again", "/bob-again"]);

    stage = "Alice opens a tab, then Bob closes his: hers shifts down a number";
    await ok(alice, "browser_tabs", { action: "new" }); // 2
    await ok(alice, "browser_navigate", { url: `${base}/alice-new` });
    await ok(bob, "browser_tabs", { action: "close" }); // closes 1
    await ok(alice, "browser_navigate", { url: `${base}/alice-shifted` });
    assert.deepEqual((await tabs(alice)).map((t) => t.path), ["/alice-again", "/alice-shifted"]);
    assert.equal(await currentPath(alice), "/alice-shifted");

    assert.equal(await currentPath(bob), "/alice-again", "Bob gets the tab nobody holds, not Alice's");

    stage = "Bob, with every other tab Alice's, gets none rather than hers";
    await ok(bob, "browser_tabs", { action: "new" }); // 2
    await ok(bob, "browser_navigate", { url: `${base}/bob-x` });
    await ok(alice, "browser_tabs", { action: "close", index: 0 }); // the free tab
    await ok(bob, "browser_tabs", { action: "close" });
    const lost = await tabs(bob);
    assert.deepEqual(lost.map((t) => t.path), ["/alice-shifted"]);
    assert.ok(!lost.some((t) => t.current), "Bob's list marks none of Alice's tabs current");
    const refused = await bob.call("tools/call", { name: "browser_navigate", arguments: { url: `${base}/bob-lost` } });
    assert.equal(refused.result.isError, true, text(refused));
    assert.match(text(refused), /no tab of your own/);
    const unread = await bob.call("tools/call", { name: "browser_snapshot", arguments: {} });
    assert.equal(unread.result.isError, true, "without a tab of his own, Bob doesn't read Alice's");
    await ok(bob, "browser_tabs", { action: "new" });
    await ok(bob, "browser_navigate", { url: `${base}/bob-back` });
    assert.deepEqual((await tabs(alice)).map((t) => t.path), ["/alice-shifted", "/bob-back"]);
    assert.equal(await currentPath(bob), "/bob-back");
    assert.equal(await currentPath(alice), "/alice-shifted");
  } catch (error) {
    const daemonLog = (() => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } })();
    console.error(`tab tracking integration failed at ${stage}\n${daemonLog.slice(-4000)}`);
    throw error;
  } finally {
    alice?.socket.destroy(); bob?.socket.destroy();
    if (daemon.exitCode === null) {
      daemon.kill("SIGTERM");
      await Promise.race([new Promise((resolve) => daemon.once("exit", resolve)), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    }
    fixture?.closeAllConnections?.();
    if (fixture) await new Promise((resolve) => fixture.close(resolve));
    unlinkSync(linkedRuntime);
    rmSync(home, { recursive: true, force: true });
  }
});
