// Small helpers the test files share: waits, a tool result's text, and JSON-RPC over a line stream.
// No project code is loaded here, so importing it never moves helpers/home.mjs from first place.
import { createInterface } from "node:readline";

// A wait of ms.
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Polls check every `every` ms until it returns something truthy and returns that; after ms it
// throws "timed out: <what>".
export async function until(what, check, ms = 30_000, every = 300) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(every)) {
    const got = await check();
    if (got) return got;
  }
  throw new Error(`timed out: ${what}`);
}

// The text of a tool call's answer (its text parts, or the error's message).
export const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

// JSON-RPC over a line stream: write(line) sends, input is read line by line for answers. Returns
// call(method, params, ms) that resolves with the answer of the same id, or rejects after ms
// (by default `ms` here).
export function rpc(write, input, { prefix = "t", ms: fallback = 60_000 } = {}) {
  const waiting = new Map();
  createInterface({ input }).on("line", (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  let seq = 0;
  return (method, params = {}, ms = fallback) => new Promise((resolve, reject) => {
    const id = `${prefix}${++seq}`;
    const timer = setTimeout(() => reject(new Error(`timed out: ${method} ${params.name || ""}`)), ms);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

// The MCP opening as Claude Code sends it, on a call from rpc() and its socket.
export async function initialize(call, sock, name = "claude-code") {
  const answer = await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name, version: "1" } });
  sock.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return answer;
}
