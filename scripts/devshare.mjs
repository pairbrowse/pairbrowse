// Sharing a dev server (Next, Nuxt, Vite...) on this computer with the people in a joined session.
// Join codes never carry local addresses (tabsync.mjs): a joiner's browser would open its own
// localhost. A shared port gets an address of its own instead: a Cloudflare Quick Tunnel to a small
// proxy here, never to the dev server itself. The proxy lets a request through only with a
// joiner's token (a cookie their PairBrowse sets in its own browser; it never appears in a URL),
// watch joiners only reading (GET, HEAD, OPTIONS and WebSockets, so hot reload works), and makes
// it look like a visit from this computer (Host, Origin and Referer of localhost), so dev servers'
// host checks pass without changing the app. The host's localhost tab then crosses as the shared
// address, and a drive joiner's navigation there comes back as localhost.
import http from "node:http";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { startQuickTunnel } from "./tunnel.mjs";

export const DEV_COOKIE = "__pairbrowse_dev";
export const DEV_PORTS_MAX = 3;
export const TOKEN = /^[0-9a-f]{64}$/;
const READ = new Set(["GET", "HEAD", "OPTIONS"]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
// Headers that would tell a dev server the visit came from somewhere else (Next compares
// x-forwarded-host with Origin for server actions) or name the visitor.
const DROP = /^(x-forwarded-|x-real-ip$|forwarded$|cf-|cdn-loop$|true-client-ip$)/i;

// A dev server address on this computer: http on localhost, 127.0.0.1, [::1] or *.localhost.
// Returns { hostname, port } or null (other networks never qualify).
export function devAddress(raw) {
  let u;
  try { u = new URL(String(raw ?? "")); } catch { return null; }
  if (u.protocol !== "http:" || u.username || u.password) return null;
  const hostname = u.hostname.toLowerCase();
  if (!LOOPBACK.has(hostname) && !hostname.endsWith(".localhost")) return null;
  return { hostname, port: Number(u.port || 80) };
}

export const validPort = (p) => Number.isInteger(p) && p >= 1 && p <= 65535;

// The value of one cookie in a Cookie header, and the header without it.
export function splitCookie(header, name) {
  let value = null;
  const rest = String(header || "").split(";").map((s) => s.trim()).filter((part) => {
    if (!part) return false;
    const eq = part.indexOf("=");
    if (part.slice(0, eq < 0 ? part.length : eq) !== name) return true;
    value = eq < 0 ? "" : part.slice(eq + 1);
    return false;
  });
  return { value, rest: rest.join("; ") };
}

// What the dev server gets: the visitor's headers, as from this computer.
export function toDevHeaders(headers, { local, publicOrigin }) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (!DROP.test(k)) out[k] = v;
  out.host = local.host;
  const swap = (v) => (publicOrigin && typeof v === "string" && v.startsWith(publicOrigin) ? local.origin + v.slice(publicOrigin.length) : v);
  if (out.origin) out.origin = swap(out.origin);
  if (out.referer) out.referer = swap(out.referer);
  const { rest } = splitCookie(out.cookie, DEV_COOKIE);
  if (rest) out.cookie = rest; else delete out.cookie;
  return out;
}

// What the visitor gets back: redirects to localhost point at the shared address, and cookies
// set for localhost are set for it instead.
export function fromDevHeaders(headers, { local, publicOrigin }) {
  const out = { ...headers };
  const loc = out.location;
  if (publicOrigin && typeof loc === "string") {
    for (const o of local.origins) if (loc === o || loc.startsWith(`${o}/`) || loc.startsWith(`${o}?`)) { out.location = publicOrigin + loc.slice(o.length); break; }
  }
  if (out["set-cookie"]) out["set-cookie"] = [].concat(out["set-cookie"]).map((c) => c.replace(/;\s*domain=[^;]*/gi, ""));
  return out;
}

// One shared port: the proxy server (listen on 127.0.0.1) in front of the dev server.
// access(token) -> "watch" | "drive" | null. publicHost(): the tunnel's host name, once known.
export function createDevProxy({ hostname, port, access, publicHost, log = () => {} }) {
  const connectHost = hostname === "[::1]" ? "::1" : hostname.endsWith(".localhost") ? "localhost" : hostname;
  const name = hostname === "localhost" || hostname.endsWith(".localhost") ? hostname : connectHost === "::1" ? "[::1]" : connectHost;
  const local = {
    host: `${name}:${port}`,
    origin: `http://${name}:${port}`,
    origins: [...new Set([`http://${name}:${port}`, `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`])],
  };
  let proxyPort = 0;
  const agent = new http.Agent({ keepAlive: true }); // its own: closed with the share
  const publicOrigin = () => { const h = publicHost(); return h ? (h.startsWith("127.0.0.1:") ? `http://${h}` : `https://${h}`) : null; };

  // The request's way in: the shared address (or this proxy's own loopback address), a token.
  function admit(req, websocket) {
    const host = String(req.headers.host || "").toLowerCase();
    const pub = publicHost();
    if (!(host === `127.0.0.1:${proxyPort}` || (pub && (host === pub || host === `${pub}:443`)))) return { code: 403, text: "Not this address." };
    const { value } = splitCookie(req.headers.cookie, DEV_COOKIE);
    const role = value && TOKEN.test(value) ? access(value) : null;
    if (!role) return { code: 403, text: "This dev server is shared through PairBrowse only: join the session to see it." };
    if (role !== "drive" && !websocket && !READ.has(req.method)) return { code: 403, text: "You're watching this session: you can look around, not change things." };
    return null;
  }

  const refuse = (res, code, text) => { res.writeHead(code, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }); res.end(text); };

  const server = http.createServer((req, res) => {
    const no = admit(req, false);
    if (no) return refuse(res, no.code, no.text);
    const up = http.request({ agent, host: connectHost, port, method: req.method, path: req.url, headers: toDevHeaders(req.headers, { local, publicOrigin: publicOrigin() }), autoSelectFamily: true }, (r) => {
      res.writeHead(r.statusCode || 502, fromDevHeaders(r.headers, { local, publicOrigin: publicOrigin() }));
      r.pipe(res);
    });
    up.on("error", () => { if (!res.headersSent) refuse(res, 502, `The dev server at localhost:${port} isn't answering.`); else res.destroy(); });
    req.pipe(up);
  });

  // WebSockets (hot reload): the same checks, then the two connections are joined as they are.
  server.on("upgrade", (req, socket, head) => {
    const no = admit(req, true);
    if (no) { socket.end(`HTTP/1.1 ${no.code} Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\n${no.text}`); return; }
    const dev = net.connect({ host: connectHost, port, autoSelectFamily: true }, () => {
      const headers = toDevHeaders(req.headers, { local, publicOrigin: publicOrigin() });
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers)) for (const one of [].concat(v)) raw += `${k}: ${one}\r\n`;
      dev.write(`${raw}\r\n`);
      if (head?.length) dev.write(head);
      dev.pipe(socket);
      socket.pipe(dev);
    });
    // Either side gone (closed or failed): both go, so no connection is left open.
    const close = () => { socket.destroy(); dev.destroy(); };
    for (const end of [dev, socket]) { end.on("error", close); end.on("close", close); }
  });
  server.on("clientError", (e, socket) => socket.destroy());

  return {
    local,
    listen: () => new Promise((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => { proxyPort = server.address().port; ok(proxyPort); }); }),
    get port() { return proxyPort; },
    close() { server.close(); server.closeAllConnections?.(); agent.destroy(); },
  };
}

// The shared ports and who may use them. isIn(key): whether a joiner (inviteId:joinerId) is still
// in the session; a token works only while they are.
export function createDevShare({ log = () => {}, startTunnel = (port) => startQuickTunnel(port, { log }), direct = process.env.PAIRBROWSE_TEST_TUNNEL === "direct", onStopped = () => {} } = {}) {
  const shares = new Map(); // port -> { port, hostname, proxy, tunnel, origin, host }
  const tokens = new Map(); // token -> { key, role, port }
  const starting = new Set(); // shares whose tunnel is still starting (unshare and stopAll end them too)
  let isIn = () => false;

  const access = (port) => (token) => {
    const t = tokens.get(token);
    if (!t || t.port !== port || !isIn(t.key)) return null;
    return t.role;
  };

  async function share(hostname, port) {
    if (!validPort(port)) throw new Error("Give the dev server's port (1-65535).");
    const have = shares.get(port);
    if (have) return have;
    if (shares.size >= DEV_PORTS_MAX) throw new Error(`At most ${DEV_PORTS_MAX} dev servers are shared at once. Stop one with unshare_port.`);
    const entry = { port, hostname, origin: null, host: null };
    entry.proxy = createDevProxy({ hostname, port, access: access(port), publicHost: () => entry.host, log });
    const proxyPort = await entry.proxy.listen();
    starting.add(entry);
    try {
      entry.tunnel = direct ? { url: `http://127.0.0.1:${proxyPort}`, stop() {} } : await startTunnel(proxyPort);
      // Unshared while the tunnel was starting: stop it, never keep it.
      if (entry.stopped) {
        try { entry.tunnel.stop(); } catch {}
        throw new Error(`localhost:${port} is no longer shared`);
      }
    } catch (e) {
      entry.proxy.close();
      throw e;
    } finally {
      starting.delete(entry);
    }
    entry.origin = new URL(entry.tunnel.url).origin;
    entry.host = new URL(entry.tunnel.url).host;
    entry.tunnel.child?.once("exit", () => { if (shares.get(port) === entry) { stopOne(port); onStopped(port); } });
    shares.set(port, entry);
    log(`dev server localhost:${port} shared`);
    return entry;
  }

  function stopOne(port) {
    const e = shares.get(port);
    if (!e) return false;
    shares.delete(port);
    try { e.tunnel?.stop(); } catch {}
    e.proxy.close();
    for (const [t, v] of tokens) if (v.port === port) tokens.delete(t);
    log(`dev server localhost:${port} no longer shared`);
    return true;
  }

  return {
    share,
    unshare(port) {
      let pending = false;
      for (const entry of starting) if (entry.port === port) { entry.stopped = true; pending = true; }
      return stopOne(port) || pending;
    },
    stopAll() {
      for (const entry of starting) entry.stopped = true;
      for (const port of [...shares.keys()]) stopOne(port);
    },
    list: () => [...shares.values()].map((e) => ({ port: e.port, hostname: e.hostname, url: e.origin })),
    members(fn) { isIn = fn; },
    // What one joiner's PairBrowse needs to open the shared dev servers: [{ origin, token }].
    forJoiner(key, role) {
      const out = [];
      for (const e of shares.values()) {
        let token = [...tokens].find(([, v]) => v.key === key && v.port === e.port && v.role === role)?.[0];
        if (!token) { token = randomBytes(32).toString("hex"); tokens.set(token, { key, role, port: e.port }); }
        out.push({ origin: e.origin, token });
      }
      return out;
    },
    forget(key) { for (const [t, v] of tokens) if (v.key === key) tokens.delete(t); },
    // A host tab's address on a shared dev server, as its shared address (null: not shared).
    toPublic(raw) {
      const d = devAddress(raw);
      const e = d && shares.get(d.port);
      if (!e) return null;
      const u = new URL(raw);
      return e.origin + u.pathname + u.search + u.hash;
    },
    // A shared address back as the dev server's own, for the host's browser (null: not one).
    toLocal(raw) {
      let u;
      try { u = new URL(String(raw ?? "")); } catch { return null; }
      for (const e of shares.values()) if (u.origin === e.origin) return e.proxy.local.origin + u.pathname + u.search + u.hash;
      return null;
    },
  };
}

// The joiner's side: a dev server entry from the host, checked (a Quick Tunnel address and a
// token; a loopback address only in tests). Returns { origin, token } or null.
export function readDevEntry(x, { allowLocal = false } = {}) {
  if (!x || typeof x.token !== "string" || !TOKEN.test(x.token)) return null;
  let u;
  try { u = new URL(String(x.origin)); } catch { return null; }
  if (u.origin !== x.origin) return null;
  if (u.protocol === "https:" && /^[a-z0-9-]+\.trycloudflare\.com$/.test(u.hostname)) return { origin: u.origin, token: x.token };
  if (allowLocal && u.protocol === "http:" && u.hostname === "127.0.0.1") return { origin: u.origin, token: x.token };
  return null;
}
