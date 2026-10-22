// Discord for the Handoff page (daemon/phonelink.mjs): the REST calls (GET /users/@me: the token
// works, the bot's name; Create Message in the linked DM) and a Gateway connection kept only while
// a link waits or an approval the DM may answer waits. Gateway: Hello (op 10) gives the heartbeat
// interval; Heartbeat (op 1) carries the last sequence number; a missing Heartbeat ACK (op 11)
// means a dead connection; Identify (op 2) with intents DIRECT_MESSAGES (1 << 12), which carries
// MESSAGE_CREATE in DMs with their content (Discord: "Content in DMs with the app" needs no
// MESSAGE_CONTENT intent); Reconnect (op 7) and Invalid Session (op 9) start over. A closed
// connection comes back after 5 s, doubling to 60 s, while it is still wanted. Every REST request is
// bounded and capped (notify/post.mjs httpsJson); a 429 is waited out once (retry_after, at most
// 10 s). No result, error or log line holds the token.
import { httpsJson } from "../notify/post.mjs";
import { connect as wsConnect } from "../../ws.mjs";
import { discordHeaders } from "../notify/discord-dm.mjs";
import { DISCORD_ID } from "../notify/linked.mjs";

export const DIRECT_MESSAGES = 1 << 12;
const GATEWAY_MAX = 1024 * 1024;
const NAME = /^[^\u0000-\u001f\u007f]{1,64}$/;

export function createDiscordApi({ base, request = httpsJson, wait = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const root = String(base).replace(/\/+$/, "");
  async function call(token, method, path, body = null) {
    for (let attempt = 0; ; attempt++) {
      const r = await request(`${root}${path}`, { method, headers: discordHeaders(token), ...(body ? { body: JSON.stringify(body) } : {}) });
      const after = Number(r.json?.retry_after);
      if (r.status === 429 && attempt === 0 && after > 0 && after <= 10) { await wait(Math.ceil(after * 1000)); continue; }
      return r;
    }
  }
  return {
    // { bot: name, id } or { error }.
    async me(token) {
      const r = await call(token, "GET", "/users/@me");
      if (r.status === 401) return { error: "Discord didn't accept this token. Reset it in the Developer Portal (Bot, Reset Token) and paste the new one." };
      if (!r.ok) return { error: `Discord didn't answer (${r.error}). Check this computer's connection, then try again.` };
      const u = r.json;
      if (!u || u.bot !== true || !DISCORD_ID.test(String(u.id || "")) || typeof u.username !== "string" || !NAME.test(u.username)) return { error: "Discord's answer wasn't a bot's. Copy the bot's token from the Developer Portal's Bot tab." };
      return { bot: u.username, id: String(u.id) };
    },
    send: (token, channelId, content) => call(token, "POST", `/channels/${channelId}/messages`, { content: String(content).slice(0, 2000), flags: 1 << 2, allowed_mentions: { parse: [] } }),
  };
}

// A Gateway connection: onDispatch(type, data) for each event; close() ends it for good.
// url: the Gateway's wss:// address (ws:// on loopback in tests). connect: scripts/ws.mjs connect.
export function openGateway({ url, token, onDispatch, log = () => {}, connect = wsConnect, timers = { set: setTimeout, clear: clearTimeout }, retryMs = 5000, os = process.platform }) {
  const httpUrl = String(url).replace(/^wss:/, "https:").replace(/^ws:/, "http:");
  let ws = null;
  let stopped = false;
  let beat = null;
  let again = null;
  let seq = null;
  let acked = true;
  let backoff = retryMs;
  const unref = (t) => { t?.unref?.(); return t; };
  const stopBeat = () => { if (beat) timers.clear(beat); beat = null; };
  function drop() {
    stopBeat();
    const w = ws;
    ws = null;
    try { w?.close(); } catch {}
  }
  function later() {
    if (stopped || again) return;
    again = unref(timers.set(() => { again = null; open(); }, backoff));
    backoff = Math.min(backoff * 2, 60_000);
  }
  function heartbeat() {
    if (!ws) return;
    if (!acked) { log("handoff: the Discord connection stopped answering; connecting again"); drop(); later(); return; }
    acked = false;
    ws.send(JSON.stringify({ op: 1, d: seq }));
  }
  function onText(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!m || typeof m !== "object") return;
    if (Number.isSafeInteger(m.s)) seq = m.s;
    if (m.op === 10) {
      const every = Math.min(Math.max(Number(m.d?.heartbeat_interval) || 41_250, 1000), 120_000);
      stopBeat();
      acked = true;
      const tick = () => { heartbeat(); if (ws) beat = unref(timers.set(tick, every)); };
      beat = unref(timers.set(tick, Math.round(every * Math.random())));
      ws?.send(JSON.stringify({ op: 2, d: { token, intents: DIRECT_MESSAGES, properties: { os, browser: "PairBrowse", device: "PairBrowse" } } }));
    } else if (m.op === 11) {
      acked = true;
    } else if (m.op === 1) {
      ws?.send(JSON.stringify({ op: 1, d: seq }));
    } else if (m.op === 7 || m.op === 9) {
      drop();
      later();
    } else if (m.op === 0) {
      if (m.t === "READY") backoff = retryMs;
      try { onDispatch(String(m.t || ""), m.d); } catch {}
    }
  }
  async function open() {
    if (stopped || ws) return;
    seq = null;
    let w;
    try { w = await connect(httpUrl, { timeoutMs: 15_000, maxMessage: GATEWAY_MAX }); } catch (e) {
      log(`handoff: couldn't reach Discord's gateway (${e?.status ? `HTTP ${e.status}` : e?.code || "error"})`);
      later();
      return;
    }
    if (stopped) { try { w.close(); } catch {} return; }
    ws = w;
    w.onMessage(onText);
    w.onClose(() => { if (ws === w) { ws = null; stopBeat(); later(); } });
  }
  open();
  return {
    close() { stopped = true; if (again) timers.clear(again); again = null; drop(); },
    get open() { return !!ws; },
  };
}
