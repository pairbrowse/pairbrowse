// The joiner's side of a join code: the connection to the host's session through its sharing
// tunnel. It asks to be let in, then keeps one WebSocket open (the push channel: the shared tabs,
// form values, pointers, who does what, messages, each as it happens; tabsync.mjs), and sends
// this browser's changes on it (a drive code's tab changes; pointers and messages for both).
// Reconnects by itself; on each connect the host sends everything as it stands, so nothing is
// missed. No page of the host's
// browser, no picture of it, nothing an agent could act through.
import { newJoinerId } from "./join.mjs";
import { sleep } from "./util.mjs";
import { connect } from "./ws.mjs";

const OFFLINE_LONG_MS = 120_000; // offline this long: say the tunnel may be down
const REQUEST_TIMEOUT_MS = { send: 30_000, leave: 5000, pointer: 5000, connect: 20_000 };
const WAIT_MS = { idle: 3000, offline: 2000, again: 300 };
const SILENT_MS = 40_000; // the host sends a heartbeat every 15 s: silence this long means the channel is gone
const REPLY_MS = 30_000;

// join: a parsed join code ({ url, key, role, label }). name, app: who is joining, as the host
// sees it. onTabs(state): the session's shared tabs, each time they come in (awaited before the
// next request). onChange(phase). The host is asked right away.
// on: handlers for the host's events (tabs, form, pointers, session, message), each awaited in
// order except pointers (the latest wins).
export function startJoin({ join: code, name, app = "", joinerId = newJoinerId(), log = () => {}, onTabs = async () => {}, on = {}, onChange = () => {} }) {
  const base = `${code.url}/${code.key}`;
  const headers = { "x-pairbrowse-joiner": joinerId, "x-pairbrowse-name": encodeURIComponent(name), "x-pairbrowse-app": app };
  const Host = code.label.charAt(0).toUpperCase() + code.label.slice(1); // at a sentence's start
  let phase = "asking"; // asking, waiting, in, denied, ended, offline, left
  let message = `Asking ${code.label} to let you in.`;
  let stopped = false;
  let offlineSince = 0;
  const set = (p, m) => {
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
    if (res.ok) { offlineSince = 0; if (phase !== "in") set("in", `You're in ${code.label}'s session (${code.role}).`); return body; }
    if (res.status === 403 && body.waiting) set("waiting", `Waiting for ${code.label} to approve. They see your request now.`);
    else if (res.status === 403 && body.denied) { set("denied", `${Host} didn't let you in.`); stopped = true; }
    else if (res.status === 404) { set("ended", "This join code doesn't work any more (revoked, expired, or the host's browser restarted). Ask for a new one."); stopped = true; }
    else if (res.status === 429) set(phase === "in" ? "in" : "waiting", body.error || "The host is busy. Retrying.");
    // The tunnel's own error page (Cloudflare's 502 or 530 when the host's helper is gone), not the host.
    else if (res.status >= 500 && !body.error) offline();
    else set("offline", body.error || `The host's session answered ${res.status}. Retrying.`);
    return null;
  }
  const request = (path, init = {}, ms) => fetch(`${base}/${path}`, { ...init, headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}) }, signal: AbortSignal.timeout(ms) });
  const offline = () => {
    offlineSince ||= Date.now();
    const long = Date.now() - offlineSince > OFFLINE_LONG_MS;
    set("offline", long ? "Can't reach the host's session for a while: the free tunnel may be down. Still retrying; ask the host for a new code if it doesn't come back." : "Can't reach the host's session right now. Retrying.");
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
    while (!stopped) {
      try {
        const c = await connect(`${base}/events`, { headers });
        conn = c;
        offlineSince = 0;
        if (phase !== "in") set("in", `You're in ${code.label}'s session (${code.role}).`);
        let heard = Date.now();
        const watchdog = setInterval(() => { if (Date.now() - heard > SILENT_MS) c.close(); }, 5000);
        // Pushed events apply in order; pointers right away (only the latest one matters).
        let chain = Promise.resolve();
        c.onMessage((raw) => {
          heard = Date.now();
          let m;
          try { m = JSON.parse(raw); } catch { return; }
          const { event, data } = m || {};
          if (event === "reply") { replies.get(data?.n)?.(data); replies.delete(data?.n); return; }
          if (event === "ping" || stopped) return;
          if (event === "pointers") { try { on.pointers?.(data); } catch {} return; }
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
        if (!stopped) set("offline", "The connection to the host's session dropped. Reconnecting.");
      } catch (e) {
        if (stopped) break;
        if (e.status) {
          // Answered, but not let in (yet): what that means for the joiner.
          await understand({ ok: false, status: e.status, json: async () => e.body || {} });
        } else offline();
      }
      if (!stopped) await sleep(phase === "offline" ? WAIT_MS.offline : phase === "in" ? WAIT_MS.again : WAIT_MS.idle);
    }
  })();

  return {
    role: code.role,
    host: code.label,
    get phase() { return phase; },
    get message() { return message; },
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
