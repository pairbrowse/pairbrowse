// Stand-ins for the services the Handoff page talks to, on loopback only: a Telegram Bot API
// (getMe, getUpdates with queued updates, sendMessage, answerCallbackQuery,
// editMessageReplyMarkup) and Discord (REST /users/@me and Create Message, and a Gateway on
// /gateway over scripts/ws.mjs acceptUpgrade). Every request is recorded; nothing leaves the computer.
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptUpgrade } from "../../scripts/ws.mjs";
import { secretStore } from "../../scripts/rules/secrets.mjs";

export const TG_TOKEN = `7012345678:${"Ab_cD-".repeat(6)}`;
export const DC_TOKEN = `${"M".repeat(24)}.${"Gx1".repeat(2)}.${"z9_-".repeat(8)}`;
export const DC_BOT_ID = "100000000000000001";

const body = (req) => new Promise((resolve) => { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => resolve(b)); });
const listen = async (server) => { await new Promise((r) => server.listen(0, "127.0.0.1", r)); return `http://127.0.0.1:${server.address().port}`; };

export async function fakeTelegram({ token = TG_TOKEN } = {}) {
  const calls = [];
  const queue = [];
  let nextId = 1;
  let conflict = false;
  const server = createServer(async (req, res) => {
    const text = await body(req);
    let json = {};
    try { json = JSON.parse(text || "{}"); } catch {}
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
    const method = m?.[2] || "";
    calls.push({ method, token: m?.[1], body: json, url: req.url });
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (!m || m[1] !== token) return send(401, { ok: false, error_code: 401, description: "Unauthorized" });
    if (method === "getMe") return send(200, { ok: true, result: { id: 7012345678, is_bot: true, first_name: "PB", username: "pb_test_bot" } });
    if (method === "getUpdates") {
      if (conflict) return send(409, { ok: false, error_code: 409, description: "Conflict: can't use getUpdates method while webhook is active" });
      const offset = Number(json.offset) || 0;
      const ready = () => queue.filter((u) => u.update_id >= offset);
      for (let i = 0; i < 20 && !ready().length; i++) await new Promise((r) => setTimeout(r, 10));
      const out = ready();
      for (const u of out) queue.splice(queue.indexOf(u), 1);
      return send(200, { ok: true, result: out });
    }
    return send(200, { ok: true, result: method === "sendMessage" ? { message_id: 50 + calls.length } : true });
  });
  const base = await listen(server);
  return {
    base, calls,
    of: (method) => calls.filter((c) => c.method === method),
    push(update) { queue.push({ update_id: nextId++, ...update }); },
    message: (chat, text, { type = "private", from = chat, first = "Ann" } = {}) => ({ message: { message_id: 9, chat: { id: chat, type, first_name: first }, from: { id: from, is_bot: false, first_name: first }, text } }),
    press: (chat, data, { from = chat } = {}) => ({ callback_query: { id: `${4000 + nextId}`, from: { id: from, is_bot: false }, data, message: { message_id: 77, chat: { id: chat, type: "private" } } } }),
    set conflict(v) { conflict = v; },
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

export async function fakeDiscord({ token = DC_TOKEN } = {}) {
  const calls = [];
  const sockets = new Set();
  const identified = [];
  const server = createServer(async (req, res) => {
    const text = await body(req);
    let json = null;
    try { json = JSON.parse(text || "null"); } catch {}
    calls.push({ method: req.method, url: req.url, headers: req.headers, body: json });
    const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bot ${token}`) return send(401, { message: "401: Unauthorized", code: 0 });
    if (req.method === "GET" && req.url === "/users/@me") return send(200, { id: DC_BOT_ID, username: "PB Bot", bot: true });
    if (req.method === "POST" && /^\/channels\/\d+\/messages$/.test(req.url)) return send(200, { id: "200000000000000002" });
    send(404, { message: "404: Not Found" });
  });
  server.on("upgrade", (req, socket, head) => {
    const ws = acceptUpgrade(req, socket, head);
    if (!ws) return;
    sockets.add(ws);
    ws.onClose(() => sockets.delete(ws));
    let seq = 0;
    ws.onMessage((text) => {
      const m = JSON.parse(text);
      if (m.op === 1) ws.send(JSON.stringify({ op: 11 }));
      if (m.op === 2) { identified.push(m.d); ws.send(JSON.stringify({ op: 0, s: ++seq, t: "READY", d: { v: 10, user: { id: DC_BOT_ID } } })); }
    });
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 500 } }));
    ws.dispatch = (t, d) => ws.send(JSON.stringify({ op: 0, s: ++seq, t, d }));
  });
  const base = await listen(server);
  return {
    base, calls, identified, sockets,
    gateway: `${base.replace("http:", "ws:")}/gateway`,
    dispatch(t, d) { for (const ws of sockets) ws.dispatch(t, d); },
    dm: (channel, user, content, extra = {}) => ({ id: "300000000000000003", channel_id: channel, author: { id: user, username: "ann", global_name: "Ann", bot: false }, content, ...extra }),
    posts: () => calls.filter((c) => c.method === "POST" && /\/messages$/.test(c.url)),
    close: () => { for (const ws of sockets) ws.close(); server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  };
}

// A home of the test's own: config.json, secrets.env, the links file and the log lines.
export function phoneHome(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pb-phone-"));
  const configFile = join(dir, "config.json");
  const secretsFile = join(dir, "secrets.env");
  const linksFile = join(dir, "handoff-links.json");
  writeFileSync(configFile, JSON.stringify(config));
  const lines = [];
  const log = (...a) => lines.push(a.join(" "));
  return { dir, configFile, secretsFile, linksFile, lines, log, secrets: secretStore(secretsFile, log), file: () => JSON.parse(readFileSync(configFile, "utf8")) };
}
