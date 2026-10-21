// A hand-off link from anywhere (spec server-mode step 21b, U2, handoff.publicLink): the public
// address of the hand-off's own tunnel reaches the live view's guest port (joiner-server.mjs hands
// each request here first), and there it serves a grant's routes and nothing else: the landing page
// and its files, "Take over" (role redeem), and the turn viewer with its files, its one stream,
// stills, state, input, Done, the tab switch and the option list (role turn). Every other route,
// key or name answers 404, as a key never made: the owner's key, the browser's pages' key, invite
// links and join codes never work there (join codes keep their own tunnel's names). The one
// exception is the user's own tunnel shared by both (one address: tunnel-pool.mjs handoffShared):
// there a request no grant's key names is left to the join code server, as on loopback.
//
// The same protections as the private route, because the same routes run: a GET never uses a link
// up (the landing page), "Take over" uses its redeem key once, the grant's expiry, session and tab
// scope, and the view key's one stream with its reconnects. A request with an Origin other than
// the public address's own is refused and audited, as on the owner's port.
//
// The stream goes over a WebSocket there: a Cloudflare Quick Tunnel doesn't carry server-sent
// events (its documented limit), WebSockets pass at once. The viewer page served here says so
// (data-stream="ws"; liveview-turn.js socketEvents reads it), and the events route runs unchanged
// on a response that writes each event as one message. A ping every PING_MS keeps idle relays
// open, and a stream that answered nothing for DEAD_MS is closed, so a phone that lost its signal
// lets go of the one stream and its reconnect is taken.
import { acceptUpgrade, refuseUpgrade } from "../ws.mjs";
import { roleMay } from "./invites.mjs";
import { LOOPBACK, originOk, plain, pathParts, VIEWER_CSP } from "./http.mjs";
import { TURN_ROLES } from "./grants.mjs";

// What the public address serves, by role, as "METHOD route".
export const PUBLIC_ROUTES = {
  redeem: new Set(["GET ", "GET assets", "POST redeem"]),
  turn: new Set(["GET ", "GET assets", "GET events", "GET thumb.jpg", "GET state.json", "POST input", "POST turn", "POST turn-done", "POST turn-options", "POST turn-pick", "POST turn-fill-card"]),
};
export const PING_MS = 20_000;
export const DEAD_MS = 60_000;

// The viewer's policy on the public address: its own wss: origin named too (some browsers don't
// read 'self' as covering a WebSocket).
export const publicCsp = (host) => VIEWER_CSP.replace("connect-src 'self'", `connect-src 'self' wss://${host}`);

// gate: the live view's grant gate (liveview/grants.mjs). routes: the owner's port's route table
// (only the PUBLIC_ROUTES among it are reached). publicHost(): the hand-off tunnel's public host
// name now, or null while none is up (then nothing is served here: a grant key on the guest port
// is 404, as before). publicShared(): that name is the join codes' too. log(...): daemon.log.
export function createPublicTurn({ gate, routes, publicHost = () => null, publicShared = () => false, log = () => {}, pingMs = PING_MS, deadMs = DEAD_MS }) {
  const hostOf = (h) => String(h || "").toLowerCase().replace(/:443$/, "");
  // Whether the request came through the hand-off tunnel's name (or loopback, which cloudflared may
  // pass): { pub, named } with the public host, or null. named: a request no grant's key names is
  // 404 here (false on loopback and on a name join codes share: the join server's then).
  function reach(req) {
    const pub = publicHost();
    if (!pub || !gate.on) return null;
    const h = hostOf(req.headers.host);
    if (h === pub.toLowerCase()) return { pub, named: !publicShared() };
    return LOOPBACK.test(h) ? { pub, named: false } : null;
  }
  // The grant a request's key is (a guest of role redeem or turn), the route, and whether it is one
  // this address serves; null when the key is no live grant's.
  function grantOf(req) {
    const { key, route, rest } = pathParts(req);
    const guest = gate.match(key);
    if (!guest || !TURN_ROLES.has(guest.role)) return null;
    const allowed = PUBLIC_ROUTES[guest.role].has(`${req.method} ${route}`) && roleMay(guest.role, routes.find((r) => r.method === req.method && r.path === route)?.right);
    return { guest, route, rest, allowed };
  }
  // Another site's page using the link: refused and audited, as on the owner's port. No Origin (a
  // same-origin GET, a plain client), the public address's own, or a loopback page's passes.
  function otherOrigin(req, guest, route, pub) {
    const origin = req.headers.origin;
    if (!origin || origin === `https://${pub}` || originOk(origin)) return false;
    const kind = req.method !== "GET" ? "input-refused" : guest.role === "turn" && route === "events" ? "stream-refused" : "request-refused";
    gate.refused(guest, kind, req.method === "GET" ? "other-origin" : "not-allowed");
    return true;
  }

  // One plain request: true when it was this address's to answer (answered), false to leave it to
  // the join code server (a request on loopback that no grant's key names).
  async function request(req, res) {
    const at = reach(req);
    if (!at) return false;
    const g = grantOf(req);
    if (!g) {
      if (!at.named) return false;
      plain(res, 404);
      return true;
    }
    if (!g.allowed) { plain(res, 404); return true; }
    if (otherOrigin(req, g.guest, g.route, at.pub)) { plain(res, 403); return true; }
    if (req.method === "GET" && g.route === "events") { plain(res, 404, "Open this hand-off's page again."); return true; } // the stream is a WebSocket here
    const r = routes.find((x) => x.method === req.method && x.path === g.route);
    try {
      const has = r.needs ? r.needs() : true;
      if (!has) plain(res, 404);
      else await r.handler({ req, res, route: g.route, rest: g.rest, role: g.guest.role, invite: g.guest, byPages: false, pub: at.pub });
    } catch (e) {
      log("liveview public", e?.message || e);
      if (!res.headersSent) plain(res, 500);
    }
    return true;
  }

  // The turn stream's upgrade: true when it was this address's (answered or refused).
  function upgrade(req, socket, head) {
    const at = reach(req);
    if (!at) return false;
    const g = grantOf(req);
    if (!g) {
      if (!at.named) return false;
      refuseUpgrade(socket, 404, { error: "Unknown request." });
      return true;
    }
    if (!g.allowed || g.route !== "events" || g.guest.role !== "turn") { refuseUpgrade(socket, 404, { error: "Unknown request." }); return true; }
    if (otherOrigin(req, g.guest, g.route, at.pub)) { refuseUpgrade(socket, 403, { error: "Not from this page. Open the hand-off link again." }); return true; }
    const { req: sreq, res } = socketStream(req, socket, head, { pingMs, deadMs });
    const r = routes.find((x) => x.method === "GET" && x.path === "events");
    Promise.resolve().then(() => r.handler({ req: sreq, res, route: "events", rest: [], role: "turn", invite: g.guest, byPages: false, pub: at.pub })).catch((e) => {
      log("liveview public", e?.message || e);
      if (!res.headersSent) { res.writeHead(500); res.end(); } else res.destroy();
    });
    return true;
  }

  return { request, upgrade };
}

// The events route's request and response over an upgrade not yet answered: the route's
// writeHead(200) accepts the WebSocket, each write is one message (one event, as the route writes
// them), and any other answer (409: the stream is open elsewhere; 404) refuses the upgrade with that
// code and body. "close" is heard on both, as on a plain request.
export function socketStream(req, socket, head, { pingMs = PING_MS, deadMs = DEAD_MS } = {}) {
  let conn = null, code = 0, closed = false, timer = null;
  const closers = new Set();
  const fire = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    for (const fn of [...closers]) try { fn(); } catch {}
    closers.clear();
  };
  const onClose = (ev, fn) => { if (ev !== "close") return; if (closed) fn(); else closers.add(fn); };
  socket.on("close", fire);
  const res = {
    get headersSent() { return code !== 0; },
    get destroyed() { return closed; },
    get writableLength() { return conn ? conn.buffered : 0; },
    setHeader() {},
    writeHead(c) {
      if (code) return res;
      code = c;
      if (c !== 200) return res;
      conn = acceptUpgrade(req, socket, head, { maxMessage: 1000 }); // the viewer sends nothing on it
      if (!conn) { fire(); return res; }
      conn.onClose(fire);
      timer = setInterval(() => {
        if (Date.now() - conn.heard > deadMs) return conn.close(); // no pong: the phone is gone
        conn.ping();
      }, pingMs);
      timer.unref?.();
      return res;
    },
    write(chunk) { if (conn && !closed) conn.send(String(chunk)); return true; },
    end(body) {
      if (conn) return conn.close();
      if (closed) return;
      let parsed;
      try { parsed = JSON.parse(String(body ?? "")); } catch { parsed = { error: String(body ?? "") }; }
      refuseUpgrade(socket, code || 500, parsed);
      fire();
    },
    destroy() { if (conn) conn.close(); else socket.destroy(); fire(); },
    on: (ev, fn) => { onClose(ev, fn); return res; },
    once: (ev, fn) => { onClose(ev, fn); return res; },
  };
  const sreq = { method: "GET", url: req.url, headers: req.headers, on: (ev, fn) => { onClose(ev, fn); return sreq; }, once: (ev, fn) => { onClose(ev, fn); return sreq; } };
  return { req: sreq, res };
}
