// The joiner port: what the sharing tunnel reaches. Join code keys only, from PairBrowse (no
// browser pages: any Origin is refused), and nothing but the approval request until the host
// lets that joiner in. Then only the shared tabs (tabsync.mjs), and with a shared browser code
// (mode "shared") the setup of a direct connection that shows them a tab live and takes their
// input there (daemon/screenshare.mjs). Never the owner's key or the viewer page.
import http from "node:http";
import { JOINER_ID, cleanName, appName, cleanComputer } from "../join.mjs";
import { LOOPBACK, keyOk, readBody, BODY_MAX, listen } from "./http.mjs";
import { acceptUpgrade, refuseUpgrade } from "../ws.mjs";

const SEEN_MS = 5000; // a joiner who polled this recently still counts as there
const INFLIGHT_MAX = 4; // requests at once per joiner: the tunnel carries a limited number
const OPS_WINDOW_MS = 60_000;
const OPS_PER_WINDOW = 3000; // changes per joiner per minute (typing sends one about every 30 ms)
const POINTERS_PER_SECOND = 40; // a pointer is sent up to 25 times a second while it moves
const POINTER_BODY_MAX = 4000;
const SAYS_PER_SECOND = 4;
const SAY_BODY_MAX = 20_000;
const SCREEN_PER_SECOND = 40; // shared browser mode: connection setup, and input on the slower route
const SCREEN_BODY_MAX = 120_000;
const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-type": "application/json" };

// Whether a joiner is still there: a recent poll.
export const recentlySeen = (j) => Date.now() - j.seen < SEEN_MS;

// The joiner a request comes from: their PairBrowse's random id, their name and app.
const joinerOf = (req) => ({
  joinerId: String(req.headers["x-pairbrowse-joiner"] || ""),
  name: cleanName((() => { try { return decodeURIComponent(req.headers["x-pairbrowse-name"] || ""); } catch { return ""; } })()),
  app: String(req.headers["x-pairbrowse-app"] || "").slice(0, 40),
  computer: cleanComputer(String(req.headers["x-pairbrowse-computer"] || "")), // "Mac", "Linux" or "Windows" only
});

// key: the owner's key (it never works here). joiners: the live view's joiner map, filled here.
// live: the coordinator's { tabsFor(j), openStream(j, conn), applyTabs(body, j), pointersFor(body, j), say(body, j), screen(body, j),
// stopScreens(j), changed } (changed: the participant list changed; screen: shared browser mode, invites with mode "shared" only).
export function createJoinerServer({ key, invites, approvals, joiners, tunnelHost, live, onJoinRequest, log }) {
  // Answers to the tunnels' public names (tunnelHost(): one or a list), or to loopback
  // (cloudflared may pass either).
  const joinerHostOk = (host) => {
    const h = String(host || "").toLowerCase();
    return LOOPBACK.test(h) || [].concat(tunnelHost() || []).some((t) => { t = String(t).toLowerCase(); return !!t && (h === t || h === `${t}:443`); });
  };
  // The join code invite a key belongs to, or null (the owner's key and link invites never work here).
  const codeInvite = (given) => {
    const matched = keyOk(given, key) ? null : invites.match(given);
    return matched?.share === "code" ? matched : null;
  };

  // Nothing of the session before the host said yes.
  function admit(invite, who) {
    if (!JOINER_ID.test(who.joinerId)) return { code: 400, body: { error: "This request doesn't say who is joining." } };
    const r = approvals.check(invite, who.joinerId, who.name, who.app, who.computer);
    if (r.isNew) {
      try { onJoinRequest(r.entry); } catch {}
    }
    if (r.state === "approved") {
      const k = `${invite.id}:${who.joinerId}`;
      let j = joiners.get(k);
      if (!j) {
        j = { invite, joinerId: who.joinerId, name: r.entry.name, app: who.app ? appName(who.app) : r.entry.app, computer: r.entry.computer || "", seen: 0, inflight: 0, ops: [] };
        joiners.set(k, j);
      }
      const fresh = !recentlySeen(j);
      j.seen = Date.now();
      if (fresh) live.changed();
      return { j };
    }
    if (r.state === "pending") return { code: 403, body: { waiting: true, error: "Waiting for the host to approve. They see a request to let you in." } };
    if (r.state === "denied") return { code: 403, body: { denied: true, error: "The host didn't let you in." } };
    return { code: 429, body: { error: "Too many people are asking to join right now. Try again in a few minutes." } };
  }

  function dropJoiner(invite, joinerId) {
    const k = `${invite.id}:${joinerId}`;
    const j = joiners.get(k);
    joiners.delete(k);
    approvals.leave(invite.id, joinerId);
    if (j) { live.stopScreens?.(j)?.catch?.(() => {}); live.changed(); }
  }

  // One change from an admitted joiner, from a request or the push channel: (drive) their tab
  // changes, their pointers, who does what on their side and messages. Returns { code, body }.
  // size: the change's size in bytes (checked against the same caps either way).
  async function act(route, parsed, size, invite, j) {
    const t = Date.now();
    // Pointers, both roles: a watcher's pointer shows here too, and moves or pauses nothing.
    if (route === "pointer") {
      j.pointers = (j.pointers || []).filter((x) => x > t - 1000);
      if (j.pointers.length >= POINTERS_PER_SECOND) return { code: 429, body: { error: "Too many pointer updates. Slow down." } };
      j.pointers.push(t);
      if (size > POINTER_BODY_MAX) return { code: 413, body: { error: "Too large." } };
      return { code: 200, body: await live.pointersFor(parsed, j) };
    }
    if (route === "tabs") {
      if (invite.role !== "drive") return { code: 403, body: { error: "This code is for watching only." } };
      if (size > BODY_MAX.input) return { code: 413, body: { error: "Too large." } };
      j.ops = (j.ops || []).filter((x) => x > t - OPS_WINDOW_MS);
      const n = Array.isArray(parsed?.ops) ? parsed.ops.length : 0;
      if (j.ops.length + n > OPS_PER_WINDOW) return { code: 429, body: { error: "Too many tab changes at once. Slow down." } };
      for (let i = 0; i < n; i++) j.ops.push(t);
      const r = await live.applyTabs(parsed, j);
      return r.problem ? { code: 400, body: { error: r.problem } } : { code: 200, body: r };
    }
    // Who is doing what on their side, and messages: text only, both roles (a watcher may talk).
    if (route === "say") {
      j.says = (j.says || []).filter((x) => x > t - 1000);
      if (j.says.length >= SAYS_PER_SECOND) return { code: 429, body: { error: "Too many updates. Slow down." } };
      j.says.push(t);
      if (size > SAY_BODY_MAX) return { code: 413, body: { error: "Too large." } };
      const r = live.say(parsed, j);
      return r?.problem ? { code: 429, body: { error: r.problem } } : { code: 200, body: { ok: true } };
    }
    // Shared browser mode: the tab's picture straight to them (setup only through here), or on the
    // slower route pictures and input through here.
    if (route === "screen") {
      if (invite.mode !== "shared") return { code: 403, body: { error: "This code doesn't share the browser itself." } };
      j.screens = (j.screens || []).filter((x) => x > t - 1000);
      if (j.screens.length >= SCREEN_PER_SECOND) return { code: 429, body: { error: "Too many requests. Slow down." } };
      j.screens.push(t);
      if (size > SCREEN_BODY_MAX) return { code: 413, body: { error: "Too large." } };
      const r = await live.screen(parsed, j);
      return r?.problem ? { code: 400, body: { error: r.problem } } : { code: 200, body: r };
    }
    // Shared browser mode: their own agent's messages for its participant here, and the files it
    // sends over for an upload (in parts).
    if (route === "agent" || route === "file") {
      if (invite.mode !== "shared") return { code: 403, body: { error: "This code doesn't share the browser itself." } };
      j.agentCalls = (j.agentCalls || []).filter((x) => x > t - 1000);
      if (j.agentCalls.length >= SCREEN_PER_SECOND) return { code: 429, body: { error: "Too many requests. Slow down." } };
      j.agentCalls.push(t);
      if (size > BODY_MAX.input) return { code: 413, body: { error: "Too large." } };
      const r = route === "agent" ? await live.agent(parsed, j) : live.file(parsed, j);
      return r?.problem ? { code: 400, body: { error: r.problem } } : { code: 200, body: r };
    }
    return { code: 404, body: { error: "Unknown request." } };
  }

  // One plain request from an admitted joiner (the push channel carries the same).
  async function handle(req, route, invite, j, answer) {
    if (req.method === "GET" && route === "tabs") return answer(200, { role: invite.role, name: j.name, ...await live.tabsFor(j) });
    if (req.method !== "POST") return answer(404, { error: "Unknown request." });
    const body = await readBody(req, BODY_MAX.input);
    if (body === null) return answer(413, { error: "Too large." });
    let parsed;
    try { parsed = JSON.parse(body); } catch { return answer(400, { error: "Not JSON." }); }
    const r = await act(route, parsed, Buffer.byteLength(body), invite, j);
    return answer(r.code, r.body);
  }

  // The same checks as a plain request; null and an answer when it's refused.
  function check(req) {
    if (!joinerHostOk(req.headers.host) || req.headers.origin) return { code: 403, body: { error: "Join codes work through PairBrowse only." } };
    const url = new URL(req.url, "http://x");
    const [, given, route = "", extra] = url.pathname.split("/");
    const invite = codeInvite(given);
    if (!invite || extra !== undefined) return { code: 404, body: { error: "This join code doesn't work any more. Ask the host for a new one." } };
    return { invite, route, who: joinerOf(req) };
  }

  const server = http.createServer(async (req, res) => {
    const answer = (code, body = {}) => { res.writeHead(code, HEADERS); res.end(JSON.stringify(body)); };
    try {
      const c = check(req);
      if (!c.invite) return answer(c.code, c.body);
      const { invite, route, who } = c;
      if (req.method === "POST" && route === "leave") { dropJoiner(invite, who.joinerId); return answer(200, { ok: true }); }
      const a = admit(invite, who);
      if (!a.j) return answer(a.code, a.body);
      const j = a.j;
      if (j.inflight >= INFLIGHT_MAX) return answer(429, { error: "Too many requests at once. Retry in a moment." });
      j.inflight++;
      try {
        return await handle(req, route, invite, j, answer);
      } finally {
        j.inflight--;
      }
    } catch (e) {
      log("liveview guest", e?.message || e);
      if (!res.headersSent) answer(500, { error: "Something went wrong on the host's side. Retry." });
    }
  });

  // The push channel: one WebSocket per joiner (a quick tunnel holds back streamed responses, but
  // not these), after the same checks and the host's approval. The host's side pushes; the
  // joiner's changes come back on it, each answered with its request number.
  server.on("upgrade", (req, socket, head) => {
    try {
      const c = check(req);
      if (!c.invite) return refuseUpgrade(socket, c.code, c.body);
      if (c.route !== "events") return refuseUpgrade(socket, 404, { error: "Unknown request." });
      const a = admit(c.invite, c.who);
      if (!a.j) return refuseUpgrade(socket, a.code, a.body);
      const j = a.j;
      const conn = acceptUpgrade(req, socket, head, { maxMessage: BODY_MAX.input + 1000 });
      if (!conn) return;
      // Changes apply in the order they came; pointers don't wait behind them, and neither does
      // shared browser mode (setting up a connection takes a second or two), which keeps its own order.
      let chain = Promise.resolve(), screenChain = Promise.resolve();
      conn.onMessage((raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        j.seen = Date.now();
        const run = async () => {
          const r = await act(String(m?.route || ""), m?.body, Buffer.byteLength(raw), c.invite, j).catch((e) => { log("liveview guest", e?.message || e); return { code: 500, body: { error: "Something went wrong on the host's side." } }; });
          if (m?.n !== undefined) conn.send(JSON.stringify({ event: "reply", data: { n: m.n, code: r.code, body: r.body } }));
        };
        if (m?.route === "pointer") run();
        else if (m?.route === "screen") { if (m?.body?.op === "want") run(); else screenChain = screenChain.then(run); }
        else chain = chain.then(run);
      });
      live.openStream(j, conn);
    } catch (e) {
      log("liveview guest", e?.message || e);
      socket.destroy();
    }
  });

  return {
    server,
    // wantPort (0: any); if it's taken, any free port (the tunnel is then restarted).
    listen: (wantPort) => listen(server, wantPort).catch((e) => {
      if (!wantPort || e.code !== "EADDRINUSE") throw e;
      return listen(server, 0);
    }),
    close() {
      server.close();
      server.closeAllConnections?.();
    },
  };
}
