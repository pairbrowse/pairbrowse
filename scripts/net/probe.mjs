// The helper's own egress probe (spec server-mode C2, C6): reads the check address (network.checkUrl,
// by default Cloudflare's trace page, which answers "ip=" and "loc=") through a session's proxy, to
// learn the address and country its traffic leaves from, or without a proxy for this computer's
// own exit (only ever compared, never kept: C9). Through an http: or https: proxy it opens a
// CONNECT tunnel (to an https: proxy over TLS checked against the trust store, with no "insecure"
// option); through a socks5: proxy it sends the check host as a name (address type 3), so no name
// is looked up on this computer. Then TLS to the check host inside the tunnel, one GET, the answer
// read. Every step is bounded by one deadline; a step that doesn't finish in time ends the probe
// as a failure, never a pass. Errors name the proxy's host:port (or the check host) and the step,
// never a credential; nothing here logs. A SOCKS5 proxy with a username and password isn't
// supported (decision U4), so credentials are never sent to one.
//
// Node's standard library only.
import { connect as netConnect, isIP } from "node:net";
import * as tls from "node:tls";
import { within } from "../util.mjs";
import { testValue } from "../testenv.mjs";
import { parseV6 } from "../rules/network.mjs";
import { CHECK_URL } from "./config.mjs";
import { normalIp } from "./verdict.mjs";

// The bound for one probe (every step together), and the browser check's.
export const CHECK_MS = 10_000;
// The STUN server the browser check gathers WebRTC candidates against (C6 (3)).
export const STUN_URL = "stun:stun.cloudflare.com:3478";
const HEAD_MAX = 16 * 1024;
export const BODY_MAX = 64 * 1024;

// The addresses and bound a session's checks use: { checkUrl, directUrl, stun, timeoutMs }.
// checkUrl is network.checkUrl (net: networkFor's answer), read through the proxy by the helper and
// by the browser; directUrl the same, read without the proxy; stun the STUN server. Tests only
// (PAIRBROWSE_TEST_NET_CHECK, JSON { checkUrl, directUrl, stun, ms }): local stand-ins, http:
// allowed, a shorter bound; a value that isn't such JSON is ignored.
export function checkTargets(net = {}, env = process.env) {
  const url = typeof net?.checkUrl === "string" ? net.checkUrl : CHECK_URL;
  const out = { checkUrl: url, directUrl: url, stun: STUN_URL, timeoutMs: CHECK_MS };
  const raw = testValue("NET_CHECK", env);
  if (!raw) return out;
  let t;
  try { t = JSON.parse(raw); } catch { return out; }
  if (!t || typeof t !== "object") return out;
  const web = (v) => { try { return ["http:", "https:"].includes(new URL(v).protocol) ? v : null; } catch { return null; } };
  if (web(t.checkUrl)) out.checkUrl = out.directUrl = t.checkUrl;
  if (web(t.directUrl)) out.directUrl = t.directUrl;
  if (typeof t.stun === "string" && /^stuns?:[^\s/?#]+$/.test(t.stun)) out.stun = t.stun;
  if (Number.isInteger(t.ms) && t.ms >= 100 && t.ms <= 120_000) out.timeoutMs = t.ms;
  return out;
}

// The "ip=" and "loc=" lines of a trace answer: { ip, loc } (ip normalIp's, or null; loc two
// capital letters, or null).
export function parseTrace(text) {
  const field = (k) => new RegExp(`^${k}=(.*)$`, "m").exec(String(text ?? ""))?.[1]?.trim() ?? "";
  const loc = field("loc");
  return { ip: normalIp(field("ip")), loc: /^[A-Z]{2}$/.test(loc) ? loc : null };
}

// The trust store for TLS to an https: proxy and to the check host: Node's own list and the
// system's where this Node reads it (tls.getCACertificates), as the browser trusts the system's.
let trust;
function trustStore() {
  if (trust !== undefined) return trust;
  if (typeof tls.getCACertificates !== "function") return (trust = null);
  let system = [];
  try { system = tls.getCACertificates("system"); } catch { /* not readable here: Node's own list */ }
  return (trust = [...new Set([...tls.getCACertificates("default"), ...system])]);
}

class ProbeError extends Error {
  constructor(problem, timedOut = false) { super(problem); this.timedOut = timedOut; }
}

const CERT_ERROR = /CERT|SIGNATURE|ALTNAME|ISSUER|SELF_SIGNED|VERIFY/;
// A socket error in words (its code only: an error's message can carry anything).
function described(e) {
  const code = String(e?.code || "");
  if (e instanceof ProbeError) return e.message;
  if (CERT_ERROR.test(code)) return `its certificate isn't trusted (${code})`;
  if (code === "ECONNREFUSED") return "refused the connection";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NONAME") return "its name wasn't found";
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH") return "can't be reached";
  if (code === "ECONNRESET" || code === "EPIPE" || code === "CLOSED") return "closed the connection";
  if (/^ERR_SSL|^ERR_TLS|EPROTO/.test(code)) return `TLS failed (${code})`;
  return `failed (${code || "error"})`;
}
const closed = () => Object.assign(new Error("closed"), { code: "CLOSED" });

// The SOCKS5 replies' meanings (RFC 1928 section 6).
const SOCKS_REPLY = ["", "failed", "doesn't allow the connection", "can't reach that network", "can't reach the check host",
  "had the connection refused", "timed out reaching the check host", "doesn't take CONNECT", "doesn't take that address type"];

// probeEgress({ proxy, checkUrl, auth, timeoutMs }): proxy the checked entry (net/config.mjs: {
// scheme, host, port }) or null for this computer's own exit; auth { username, password } for an
// http: or https: proxy with auth (sent as Basic in the CONNECT request only); extraCa: more
// trusted certificates (tests: their own authority). { ok: true, ip, loc } or { ok: false, step,
// problem, timedOut }. Never throws.
export async function probeEgress({ proxy = null, checkUrl = CHECK_URL, auth = null, timeoutMs = CHECK_MS, extraCa = null } = {}) {
  const started = Date.now();
  const sockets = [];
  let step = "address";
  let label = "check address";
  const ca = extraCa ? [...(trustStore() || tls.rootCertificates), ...[].concat(extraCa)] : trustStore() || undefined;
  // A step's promise within what is left of the bound; a socket error or close ends it at once.
  const bounded = async (name, promise) => {
    step = name;
    const left = Math.max(0, timeoutMs - (Date.now() - started));
    const r = await within(left, promise.then((value) => ({ value }), (error) => ({ error })));
    if (r === null) throw new ProbeError(`timed out (${name}, ${timeoutMs} ms in all)`, true);
    if (r.error) throw r.error;
    return r.value;
  };
  const open = (options, secure) => new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ ...options, ca, ALPNProtocols: ["http/1.1"] }) : netConnect(options);
    sockets.push(s);
    s.on("error", () => {}); // every error is taken below; none may go unhandled once a step is over
    s.once("error", reject);
    s.once("close", () => reject(closed()));
    s.once(secure ? "secureConnect" : "connect", () => resolve(s));
  });

  try {
    let target;
    try { target = new URL(checkUrl); } catch { throw new ProbeError("isn't a valid address"); }
    if (!["http:", "https:"].includes(target.protocol) || !target.hostname) throw new ProbeError("isn't an http or https address");
    const host = target.hostname.replace(/^\[|\]$/g, "");
    const port = Number(target.port) || (target.protocol === "https:" ? 443 : 80);
    const authority = `${target.hostname}:${port}`;
    const servername = isIP(host) ? undefined : host;
    label = `check address ${target.hostname}`;

    let socket;
    if (proxy) {
      label = `proxy ${proxy.host}:${proxy.port}`;
      if (proxy.scheme === "socks5" && auth) throw new ProbeError("a SOCKS5 proxy with a username and password isn't supported yet");
      const proxyHost = String(proxy.host).replace(/^\[|\]$/g, "");
      socket = await bounded("connect", open({ host: proxyHost, port: proxy.port, ...(proxy.scheme === "https" ? { servername: isIP(proxyHost) ? undefined : proxyHost } : {}) }, proxy.scheme === "https"));
      if (proxy.scheme === "socks5") await bounded("socks5", socks5(socket, host, port));
      else await bounded("tunnel", connectTunnel(socket, authority, auth));
      label = `check address ${target.hostname}`;
      if (target.protocol === "https:") socket = await bounded("tls", open({ socket, host, servername }, true));
    } else {
      socket = await bounded("connect", open({ host, port, ...(servername ? { servername } : {}) }, target.protocol === "https:"));
    }
    const path = `${target.pathname || "/"}${target.search}`;
    socket.write(`GET ${path} HTTP/1.1\r\nHost: ${target.host}\r\nAccept: text/plain\r\nConnection: close\r\n\r\n`);
    const res = await bounded("answer", readFrom(socket, httpResponse, HEAD_MAX + BODY_MAX));
    if (res.status !== 200) throw new ProbeError(`answered status ${res.status}${res.status >= 300 && res.status < 400 ? " (a redirect; it isn't followed)" : ""}`);
    const { ip, loc } = parseTrace(res.body.toString("utf8"));
    if (!ip) throw new ProbeError("answered without an ip= line");
    return { ok: true, ip, loc };
  } catch (e) {
    return { ok: false, step, problem: `${label}: ${described(e)}`, timedOut: !!e?.timedOut };
  } finally {
    for (const s of sockets) s.destroy();
  }
}

// Reads from socket until take(buffer, ended) answers (not null), giving up past max bytes. take may
// throw a ProbeError. The socket is paused again after.
function readFrom(socket, take, max) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0), settled = false;
    const finish = (fn, v) => {
      settled = true;
      socket.off("data", onData); socket.off("end", onEnd); socket.off("close", onEnd); socket.off("error", onError);
      socket.pause();
      fn(v);
    };
    const attempt = (ended) => {
      let r;
      try { r = take(buf, ended); } catch (e) { return finish(reject, e); }
      if (r) finish(resolve, r);
      else if (ended) finish(reject, closed());
    };
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      attempt(false);
      if (!settled && buf.length > max) finish(reject, new ProbeError("answered more than a check needs"));
    };
    const onEnd = () => attempt(true);
    const onError = (e) => finish(reject, e);
    socket.on("data", onData); socket.once("end", onEnd); socket.once("close", onEnd); socket.once("error", onError);
    socket.resume();
  });
}

// An HTTP proxy's CONNECT tunnel to authority (host:port), with Basic credentials when given.
async function connectTunnel(socket, authority, auth) {
  const credentials = auth ? `Proxy-Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}\r\n` : "";
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${credentials}\r\n`);
  const head = await readFrom(socket, (buf) => {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return null;
    return { status: statusOf(buf.subarray(0, end)), rest: buf.length - end - 4 };
  }, HEAD_MAX);
  if (head.status === 407) {
    throw new ProbeError(auth ? "refused the username and password (407)" : "asks for a username and password (407); set \"auth\": true and its secrets in secrets.env");
  }
  if (head.status !== 200) throw new ProbeError(`refused the tunnel (status ${head.status})`);
  if (head.rest) throw new ProbeError("sent data before the tunnel opened");
}

const statusOf = (head) => {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(head.toString("latin1"));
  if (!m) throw new ProbeError("answered something that isn't HTTP");
  return Number(m[1]);
};

// A SOCKS5 CONNECT to host:port without authentication (RFC 1928): a name goes as address type 3
// (the proxy looks it up), an IPv4 or IPv6 address as type 1 or 4.
async function socks5(socket, host, port) {
  socket.write(Buffer.from([5, 1, 0]));
  const hello = await readFrom(socket, (buf) => (buf.length >= 2 ? buf : null), 2);
  if (hello[0] !== 5) throw new ProbeError("answered something that isn't SOCKS5");
  if (hello[1] === 0xff || hello[1] !== 0) throw new ProbeError("wants a username and password, which PairBrowse doesn't send to a SOCKS5 proxy yet");
  let address;
  if (isIP(host) === 4) address = Buffer.from([1, ...host.split(".").map(Number)]);
  else if (isIP(host) === 6) address = Buffer.from([4, ...parseV6(host).flatMap((w) => [w >> 8, w & 0xff])]);
  else {
    const name = Buffer.from(host, "ascii");
    if (name.length > 255) throw new ProbeError("the check host's name is too long for SOCKS5");
    address = Buffer.concat([Buffer.from([3, name.length]), name]);
  }
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 0xff])]));
  const reply = await readFrom(socket, (buf) => {
    if (buf.length < 5) return null;
    if (buf[0] !== 5) throw new ProbeError("answered something that isn't SOCKS5");
    const size = { 1: 4, 3: 1 + buf[4], 4: 16 }[buf[3]];
    if (buf[1] === 0 && size === undefined) throw new ProbeError("answered with an unknown address type");
    if (buf[1] !== 0) return { rep: buf[1], rest: 0 };
    const total = 4 + size + 2;
    return buf.length >= total ? { rep: 0, rest: buf.length - total } : null;
  }, 4 + 256 + 2);
  if (reply.rep) throw new ProbeError(`${SOCKS_REPLY[reply.rep] || `refused the connection (reply ${reply.rep})`}`);
  if (reply.rest) throw new ProbeError("sent data before the connection opened");
}

// An HTTP/1.1 answer once complete: { status, body } (a Content-Length body, a chunked one, or
// one that ends with the connection), or null while more is to come.
function httpResponse(buf, ended) {
  const end = buf.indexOf("\r\n\r\n");
  if (end < 0) {
    if (buf.length > HEAD_MAX) throw new ProbeError("answered a header that is too long");
    return null;
  }
  const status = statusOf(buf.subarray(0, end));
  const head = buf.subarray(0, end).toString("latin1");
  const body = buf.subarray(end + 4);
  const length = /^content-length:\s*(\d+)\s*$/im.exec(head);
  if (/^transfer-encoding:.*chunked/im.test(head)) {
    const parts = [];
    for (let at = 0; ;) {
      const line = body.indexOf("\r\n", at);
      if (line < 0) return ended ? truncated() : null;
      const size = parseInt(body.subarray(at, line).toString("latin1"), 16);
      if (!Number.isInteger(size) || size < 0) throw new ProbeError("answered a malformed body");
      if (size === 0) return { status, body: Buffer.concat(parts) };
      if (body.length < line + 2 + size + 2) return ended ? truncated() : null;
      parts.push(body.subarray(line + 2, line + 2 + size));
      at = line + 2 + size + 2;
    }
  }
  if (length) {
    const n = Number(length[1]);
    if (n > BODY_MAX) throw new ProbeError("answered more than a check needs");
    if (body.length >= n) return { status, body: body.subarray(0, n) };
    return ended ? truncated() : null;
  }
  return ended ? { status, body } : null;
}
const truncated = () => { throw new ProbeError("closed the connection in the middle of its answer"); };

