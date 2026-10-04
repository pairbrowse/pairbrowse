#!/usr/bin/env node
// What Claude Code runs as the "browser" MCP server: a thin bridge between Claude Code (stdio)
// and the PairBrowse daemon (private socket). Starts the daemon when it isn't running, and
// reconnects transparently if the browser is restarted mid-session.
import net from "node:net";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, copyFileSync, chmodSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, ensureDirs, loadConfig } from "./paths.mjs";
import { ancestors } from "./ancestry.mjs";
import { ensureRuntime } from "./runtime.mjs";
import { DOCK_TOOL, dockSupported, startPane } from "./dock.mjs";
import { JOIN_TOOL } from "./policy.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const err = (s) => process.stderr.write(`pairbrowse: ${s}\n`);

const config = loadConfig();

let localReady = false;
function prepareLocal() {
  if (localReady) return;
  ensureDirs();
  if (!existsSync(paths.secrets)) {
    copyFileSync(join(root, "templates", "secrets.env.example"), paths.secrets);
    if (process.platform !== "win32") chmodSync(paths.secrets, 0o600);
  }
  if (!existsSync(paths.facts)) copyFileSync(join(root, "templates", "facts.example.md"), paths.facts);
  ensureRuntime((m) => err(m));
  localReady = true;
}

function startDaemon() {
  const out = openSync(paths.daemonLog, "a");
  spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { detached: true, stdio: ["ignore", out, out], env: process.env }).unref();
}

function connectOnce() {
  return new Promise((resolve, reject) => {
    const s = net.connect(paths.socket);
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

async function connectLocal() {
  prepareLocal();
  try {
    return await connectOnce();
  } catch {}
  startDaemon();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      return await connectOnce();
    } catch {}
  }
  throw new Error(`couldn't reach the PairBrowse daemon; see ${paths.daemonLog}`);
}

// The upstream: the local daemon socket.
async function openUpstream() {
  const sock = await connectLocal();
  sock.on("error", () => {});
  return { write: (l) => !sock.destroyed && sock.write(l), input: sock, onClose: (cb) => sock.on("close", cb), close: () => sock.destroy() };
}

let up = null;
let initMsg = null;
// Docking attaches the browser to the Claude desktop window: offered only to Claude Code.
const inClaude = () => initMsg?.params?.clientInfo?.name === "claude-code";
let initializedNote = null;
let closing = false;
const queue = [];
const inflight = new Set();
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const failInflight = (message) => {
  for (const id of inflight) out({ jsonrpc: "2.0", id, error: { code: -32002, message } });
  inflight.clear();
};

async function attach(replay) {
  const conn = await openUpstream();
  up = conn;
  createInterface({ input: conn.input }).on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id === "pb-reinit") return;
    if (typeof msg.id === "string" && internalCalls.has(msg.id)) {
      internalCalls.get(msg.id)(msg);
      internalCalls.delete(msg.id);
      return;
    }
    if (msg.result?.tools) msg.result.tools = [...msg.result.tools, JOIN_TOOL, ...(dockSupported() && inClaude() ? [DOCK_TOOL] : [])];
    if (msg.id !== undefined && ("result" in msg || "error" in msg)) inflight.delete(msg.id);
    out(msg);
  });
  conn.onClose(async () => {
    if (closing || up !== conn) return;
    // The browser restarted or the connection dropped: fail what was in flight, then reconnect.
    failInflight("The PairBrowse browser restarted. Retry the last action.");
    up = null;
    try {
      await ensureAttached(true);
    } catch (e) {
      err(String(e.message || e));
    }
  });
  if (replay && initMsg) {
    conn.write(JSON.stringify({ ...initMsg, id: "pb-reinit" }) + "\n");
    if (initializedNote) conn.write(JSON.stringify(initializedNote) + "\n");
  }
  while (queue.length) conn.write(JSON.stringify(queue.shift()) + "\n");
}

// One connection attempt at a time; messages wait in the queue meanwhile.
let attaching = null;
function ensureAttached(replay) {
  attaching ??= attach(replay).finally(() => { attaching = null; });
  return attaching;
}

function send(msg) {
  if (msg.method === "initialize") {
    const label = config.participantName || process.env.PAIRBROWSE_PARTICIPANT;
    if (label) msg = { ...msg, params: { ...msg.params, clientInfo: { ...msg.params?.clientInfo, pairbrowseParticipant: String(label).replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, 60) } } };
    // The processes this bridge runs under: the hook of the same session shares one, so the
    // helper knows whose click a hook asks about (scripts/ancestry.mjs).
    msg = { ...msg, params: { ...msg.params, clientInfo: { ...msg.params?.clientInfo, pairbrowseAncestors: ancestors() } } };
  }
  if (msg.method === "initialize") initMsg = msg;
  if (up) up.write(JSON.stringify(msg) + "\n");
  else {
    queue.push(msg);
    ensureAttached(true).catch((e) => failInflight(String(e.message || e)));
  }
}

// Calls the browser on our own behalf; the answer isn't passed to Claude.
const internalCalls = new Map();
let internalSeq = 0;
function internal(name, args) {
  return new Promise((resolve) => {
    const id = `pb-int-${++internalSeq}`;
    internalCalls.set(id, resolve);
    send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  });
}

// Live view address of the browser.
async function liveViewUrl() {
  const res = await internal("pairbrowse_liveview", {});
  const url = res.result?.content?.[0]?.text?.match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)?.[0];
  if (!url) throw new Error("the browser didn't return a live view");
  return url;
}

let pane = null; // the macOS pane process
async function dockCommand(msg) {
  const reply = (text, isError = false) => out({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
  const { action, width } = msg.params?.arguments || {};
  pane?.kill();
  pane = null;
  if (action === "off") return reply("The browser pane is closed. The browser keeps running.");
  try {
    const url = await liveViewUrl();
    const child = await startPane({ url, width: Number(width) || config.dockWidth || 0, host: config.dockHost || "Claude", top: config.dockTop ?? 52, makeRoom: !!config.dockMakeRoom });
    pane = child;
    child.on("exit", () => { if (pane === child) pane = null; });
    reply(`The browser now shows as a pane on the right of the Claude window. The user can click and type in it.`);
  } catch (e) {
    reply(`Couldn't open the browser pane: ${String(e.message || e)}. Fall back to the live view link in the Browser pane.`, true);
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "initialize") initMsg = msg;
  if (msg.method === "notifications/initialized") initializedNote = msg;
  if (dockSupported() && inClaude() && msg.method === "tools/call" && msg.params?.name === "pairbrowse_dock") return void dockCommand(msg);
  if (msg.id !== undefined && msg.method) inflight.add(msg.id);
  send(msg);
}).on("close", () => {
  closing = true;
  pane?.kill();
  up?.close();
  setTimeout(() => process.exit(0), 200);
});

ensureAttached(false).catch((e) => {
  err(String(e.message || e));
  process.exit(1);
});
