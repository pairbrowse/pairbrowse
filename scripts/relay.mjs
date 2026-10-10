// The joiner's side of a join code: the connection to the host's session through its sharing
// tunnel. It asks to be let in, then keeps one WebSocket open (the push channel: the shared tabs,
// form values, pointers, who does what, messages, each as it happens; tabsync.mjs), and sends
// this browser's changes on it (a drive code's tab changes; pointers and messages for both).
// Reconnects by itself; on each connect the host sends everything as it stands, so nothing is
// missed. No page of the host's
// browser, no picture of it, nothing an agent could act through.
import { newJoinerId, computerName } from "./join.mjs";
import { sleep } from "./util.mjs";
import { connect } from "./ws.mjs";

const OFFLINE_LONG_MS = 120_000; // offline this long: say so in more words
const REACHING_MS = 45_000; // a fresh tunnel's name may take this long to reach the joiner's resolver: keep asking, quietly
// In, and the connection dropped: the other addresses are tried for this long before anything
// shows (phase stays "in"). A tunnel going down with a standby up is a non-event for the joiner.
export const FAILOVER_MS = Number(process.env.PAIRBROWSE_TEST_FAILOVER_MS) || 20_000;
const REQUEST_TIMEOUT_MS = { send: 30_000, leave: 5000, pointer: 5000, connect: 20_000 };
const WAIT_MS = { idle: 3000, offline: 2000, again: 300, switch: 500 };
const SILENT_MS = 40_000; // silence this long means the channel is gone (a host sending heartbeats 15 s apart: before 0.14.15)
const SILENT_BEATS = 3; // or this many of the host's heartbeats missed in a row, once their spacing is known
const SILENT_MIN_MS = 3000;
const REPLY_MS = 30_000;

// join: a parsed join code ({ url, key, role, label }). name, app: who is joining, as the host
// sees it. onTabs(state): the session's shared tabs, each time they come in (awaited before the
// next request). onChange(phase). The host is asked right away.
// on: handlers for the host's events (tabs, form, pointers, session, message), each awaited in
// order except pointers (the latest wins).
// One of the host's other tunnel addresses, checked (never trust the other side): a Quick Tunnel
// origin, the code's own, or (tests only) loopback. Returns the origin, or null.
export function relayUrl(raw, codeUrl) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (u.origin !== String(raw).replace(/\/$/, "") || u.username || u.password) return null;
  if (u.origin === new URL(codeUrl).origin) return u.origin;
  if (u.protocol === "https:" && /^[a-z0-9-]+\.trycloudflare\.com$/.test(u.hostname)) return u.origin;
  if (process.env.PAIRBROWSE_TEST_JOIN_LOCAL === "1" && u.protocol === "http:" && u.hostname === "127.0.0.1") return u.origin;
  return null;
}

export function startJoin({ join: code, name, app = "", joinerId = newJoinerId(), log = () => {}, onTabs = async () => {}, on = {}, onChange = () => {} }) {
  // The addresses to the host's session: the code's, then the others the host names once we're in
  // (its standby tunnels). A dropped connection tries the next one, so a tunnel going down moves
  // this joiner to another without a new code.
  let urls = [code.url];
  let at = 0;
  const base = () => `${urls[at]}/${code.key}`;
  const nextRelay = () => { if (urls.length > 1) at = (at + 1) % urls.length; };
  const takeRelays = (list) => {
    if (!Array.isArray(list)) return;
    const ok = list.slice(0, 4).map((u) => relayUrl(u, code.url)).filter(Boolean);
    if (!ok.length) return;
    const current = urls[at];
    urls = [...new Set([current, ...ok])];
    at = 0;
  };
  const headers = { "x-pairbrowse-joiner": joinerId, "x-pairbrowse-name": encodeURIComponent(name), "x-pairbrowse-app": app, "x-pairbrowse-computer": computerName() };
  const Host = code.label.charAt(0).toUpperCase() + code.label.slice(1); // at a sentence's start
  let phase = "asking"; // asking, waiting, in, denied, ended, offline, left
  let message = `Asking ${code.label} to let you in.`;
  let stopped = false;
  let offlineSince = 0;
  const startedAt = Date.now();
  let answered = false; // the host's side answered at least once (in, waiting, denied...)
  let lostAt = 0; // when the channel dropped while in (0: not dropped)
  const switching = () => phase === "in" && lostAt && Date.now() - lostAt < FAILOVER_MS;
  const set = (p, m) => {
    if (p === "offline" && switching()) return; // still moving to another address
    if (p === phase && m === message) return;
    const before = phase;
    phase = p;
    message = m;
    if (before !== p) try { onChange(p); } catch {}
  };

  // What the host's answer means for the joiner.
  async function understand(res) {
    let body = {};
    try { body = await res.json(); } catch {}
    if (!(res.status >= 500 && !body.error)) answered = true; // the host's side, not the tunnel's error page
    if (res.ok) { offlineSince = 0; lostAt = 0; if (phase !== "in") set("in", `You're in ${code.label}'s session (${code.role}).`); return body; }
    if (res.status === 403 && body.waiting) set("waiting", `Waiting for ${code.label} to approve. They see your request now.`);
    else if (res.status === 403 && body.denied) { set("denied", body.removed ? `${Host} took you out of the session.` : `${Host} didn't let you in.`); stopped = true; }
    else if (res.status === 404) { set("ended", "This join code doesn't work any more (revoked, expired, or the host closed their browser). Ask for a new one."); stopped = true; }
    else if (res.status === 429) set(phase === "in" ? "in" : "waiting", body.error || "The host is busy. Retrying.");
    // The tunnel's own error page (Cloudflare's 502 or 530 when the host's helper is gone), not the host.
    else if (res.status >= 500 && !body.error) offline();
    else set("offline", body.error || `The host's session answered ${res.status}. Retrying.`);
    return null;
  }
  const request = (path, init = {}, ms) => fetch(`${base()}/${path}`, { ...init, headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(ms) });
  const offline = () => {
    offlineSince ||= Date.now();
    // Nothing from the host yet, right after the code was made: the tunnel's name may not have
    // reached this computer's resolver (or the tunnel's edge) yet; retrying every 2 s is the fix.
    if (!answered && Date.now() - startedAt < REACHING_MS) return set("asking", `Reaching ${code.label}'s session…`);
    const long = Date.now() - offlineSince > OFFLINE_LONG_MS;
    set("offline", long ? "Can't reach the host's session for a while. Still retrying; ask the host for a new code if it doesn't come back." : "Can't reach the host's session right now. Retrying.");
  };

  let conn = null; // the open push channel
  let seq = 0;
  const replies = new Map(); // request number -> resolve
  // A change on the channel, answered by the host ({ code, body }), or null when it's not open.
  function ask(route, body, wait = true) {
    if (!conn || conn.closed) return Promise.resolve(null);
    const n = ++seq;
    conn.send(JSON.stringify({ route, body, ...(wait ? { n } : {}) }));
    if (!wait) return Promise.resolve({ code: 200, body: {} });
    return new Promise((resolve) => {
      const timer = setTimeout(() => { replies.delete(n); resolve(null); }, REPLY_MS);
      replies.set(n, (r) => { clearTimeout(timer); resolve(r); });
    });
  }
  (async function loop() {
    let dropped = false;
    while (!stopped) {
      try {
        const c = await connect(`${base()}/events`, { headers });
        conn = c;
        const connectedAt = Date.now();
        answered = true;
        offlineSince = 0;
        lostAt = 0;
        if (phase !== "in") set("in", `You're in ${code.label}'s session (${code.role}).`);
        // A stream that stalls without closing (a free tunnel can) is dropped once the host's
        // heartbeats stop (3 s), and the next address is tried at once.
        let heard = Date.now(), lastPing = 0, silent = SILENT_MS;
        const watchdog = setInterval(() => { if (Date.now() - heard > silent) c.close(); }, 250);
        // Pushed events apply in order; pointers right away (only the latest one matters).
        let chain = Promise.resolve();
        c.onMessage((raw) => {
          heard = Date.now();
          let m;
          try { m = JSON.parse(raw); } catch { return; }
          const { event, data } = m || {};
          if (event === "reply") { replies.get(data?.n)?.(data); replies.delete(data?.n); return; }
          if (event === "ping") {
            if (lastPing) silent = Math.min(SILENT_MS, Math.max(SILENT_MIN_MS, SILENT_BEATS * (heard - lastPing)));
            lastPing = heard;
            return;
          }
          if (stopped) return;
          if (event === "pointers") { try { on.pointers?.(data); } catch {} return; }
          if (event === "screen") { try { on.screen?.(data); } catch {} return; } // shared browser mode: pictures, connection states
          if (event === "agent") { try { on.agent?.(data); } catch {} return; } // shared browser mode: answers for this side's agents
          if (event === "tabs") takeRelays(data?.relays);
          chain = chain.then(async () => {
            if (event === "tabs") await onTabs(data);
            else if (typeof on[event] === "function") await on[event](data);
          }).catch((e) => log("shared tabs", e?.message || e));
        });
        await new Promise((r) => c.onClose(r));
        clearInterval(watchdog);
        conn = null;
        for (const [, resolve] of replies) resolve(null);
        replies.clear();
        // Dropped while in: straight on to the next address (a standby tunnel), no pause first,
        // and nothing shows unless every address stays down for FAILOVER_MS.
        if (!stopped) { lostAt ||= Date.now(); nextRelay(); log("shared tabs", `the channel dropped after ${Math.round((Date.now() - connectedAt) / 1000)} s; trying address ${at + 1} of ${urls.length}`); set("offline", "The connection to the host's session dropped. Reconnecting."); dropped = true; }
      } catch (e) {
        if (stopped) break;
        if (e.status) {
          // Answered, but not let in (yet): what that means for the joiner.
          await understand({ ok: false, status: e.status, json: async () => e.body || {} });
        } else { offline(); nextRelay(); }
      }
      if (!stopped && !dropped) await sleep(phase === "offline" ? WAIT_MS.offline : phase === "in" ? (switching() ? WAIT_MS.switch : WAIT_MS.again) : WAIT_MS.idle);
      dropped = false;
    }
  })();

  return {
    role: code.role,
    host: code.label,
    get phase() { return phase; },
    get message() { return message; },
    // In, but the channel dropped and another address is being tried: the picture stands still
    // meanwhile, and the person here is told so (never an agent: nothing in results or notes).
    get switching() { return !!switching(); },
    // A drive joiner's changes to the shared tabs. Resolves to the host's answer ({ opened }), or null.
    async send(ops) {
      if (code.role !== "drive" || phase !== "in" || !ops.length) return null;
      const r = await ask("tabs", { ops });
      if (!r) return null;
      if (r.code === 400) { log("shared tabs refused", r.body?.error || ""); return null; }
      return r.code === 200 ? r.body : null;
    },
    // This side's pointers ({ me, agents, t }), both roles (everyone else's come on the channel).
    pointer(body) { return ask("pointer", body, false); },
    // Shared browser mode (codes with mode "shared"): setting up a tab's direct connection, or the
    // slower route's pictures and input. Resolves to the host's answer, or { error }.
    async screen(body) {
      if (phase !== "in" || code.mode !== "shared") return { error: "not in a shared browser session" };
      const r = await ask("screen", body);
      return r?.code === 200 ? r.body : { error: r?.body?.error || "no answer" };
    },
    // Shared browser mode: one MCP message from an agent here (agent: its id) for its participant
    // in the host's browser; answers come on the channel (on.agent). Drive codes only.
    async agent(agentId, line, tab = "") {
      if (phase !== "in" || code.mode !== "shared" || code.role !== "drive") return { error: "not driving a shared browser" };
      const r = await ask("agent", { a: agentId, line, ...(tab ? { tab } : {}) });
      return r?.code === 200 ? r.body : { error: r?.body?.error || "no answer" };
    },
    // A part of a file an agent here uploads in the host's browser.
    async file(part) {
      if (phase !== "in" || code.mode !== "shared" || code.role !== "drive") return { error: "not driving a shared browser" };
      const r = await ask("file", part);
      return r?.code === 200 ? r.body : { error: r?.body?.error || "no answer" };
    },
    // Who is doing what here, or a message: text only, both roles.
    async say(op) {
      const r = await ask("say", op);
      return r?.code === 200;
    },
    async leave() {
      if (stopped && phase === "left") return;
      stopped = true;
      conn?.close();
      set("left", "You left the session.");
      await request("leave", { method: "POST", body: "{}" }, REQUEST_TIMEOUT_MS.leave).catch(() => {});
    },
  };
}
