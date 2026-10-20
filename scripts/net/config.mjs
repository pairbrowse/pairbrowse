// Per-session proxies (spec server-mode C4): `network` in ~/.pairbrowse/config.json, operator
// config only. No agent tool sets a proxy or a credential, and credentials never sit here: a proxy
// with `auth` true names its username and password in secrets.env (reserved PAIRBROWSE_ names made
// from its id, C3). Which network a session uses: network.sessions[<session>] (an id, or null for
// direct), else its browser profile's network id, else network.default, else direct.
//
// Fail closed: a block or entry that can't be read never turns into a direct connection. A wrong
// value in a proxy entry refuses the sessions that use that proxy; a wrong value in the block itself
// (or a config.json that can't be read at launch) refuses every session until it is fixed; a
// session map entry that isn't an id or null refuses that session. Only values whose default is the
// safer side (strict, recheckMinutes) fall back to it. No value is ever repeated in a message, only
// its kind (any of them may hold a password written there by mistake), and an id, session name or
// key only when it has the shape of one.
//
// Pure apart from readNetwork (one file read); Node's standard library only.
import { readFileSync } from "node:fs";
import { parseV4, parseV6 } from "../rules/network.mjs";
import { switchName } from "../browser-args.mjs";
import { NETWORK_ID, credentialsFor } from "./credentials.mjs";

// Proxy ids (1 to 34 lower-case letters, digits and -): kept with the secret names they make.
export { NETWORK_ID };
export const SCHEMES = ["http", "https", "socks5"];
const DEFAULT_PORT = { http: 80, https: 443, socks5: 1080 };
export const ON_EGRESS_CHANGE = ["pause", "notify", "ignore"];
export const CHECK_URL = "https://cloudflare.com/cdn-cgi/trace";
export const RECHECK_MAX = 1440;
// The block's fields and their defaults (an absent block: every session direct).
export const NETWORK_DEFAULTS = { proxies: {}, default: null, sessions: {}, strict: true, checkUrl: CHECK_URL, recheckMinutes: 10 };
// A proxy entry's fields besides server, and their defaults.
export const PROXY_DEFAULTS = { auth: false, bypass: [], expectEgress: null, onEgressChange: "pause" };
// The loopback names a strict session may bypass (the helper always passes them itself, C5).
export const LOOPBACK_BYPASS = ["localhost", "127.0.0.1", "[::1]", "::1"];
const MAX_PROXIES = 64;
const MAX_LIST = 64;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?)*$/;
const COUNTRY = /^country:[A-Z]{2}$/;

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const kindOf = (v) => (v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "object" ? "an object" : typeof v === "string" ? "a string" : typeof v === "number" ? (Number.isInteger(v) ? "a whole number" : "a number") : typeof v);
const wrong = (key, what, v) => `${key} is ${what}, not ${kindOf(v)}`;
// Session names as sessions.mjs validName takes them (repeated here to keep this module pure).
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
// The key a message names: a proxy id or session name only when it is one, else a placeholder.
const proxyKey = (id) => (NETWORK_ID.test(id) ? `network.proxies.${id}` : "an entry in network.proxies");
const sessionKey = (name) => (SESSION_NAME.test(name) ? `network.sessions.${name}` : "an entry in network.sessions");
// A session as a sentence names it: quoted, or "with that name" when it isn't one (daemon/network.mjs too).
export const sessionShown = (name) => (typeof name === "string" && SESSION_NAME.test(name) ? `"${name}"` : "with that name");
// Unknown keys named only when they look like a field name; the rest counted.
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const unknownKeys = (keys) => {
  const named = keys.filter((k) => FIELD_NAME.test(k)), other = keys.length - named.length;
  if (!named.length) return other > 1 ? `${other} unknown keys` : "an unknown key";
  return `unknown key${named.length > 1 ? "s" : ""} ${quoteList(named)}${other ? ` and ${other} more` : ""}`;
};
const PROXY_FIELDS = ["server", ...Object.keys(PROXY_DEFAULTS)];
const quoteList = (keys) => keys.map((k) => `"${k}"`).join(", ");

// A dotted-quad IPv4 address (the only IPv4 form taken here: no 127.1 or 0x7f.0.0.1).
const dottedV4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s) && parseV4(s) !== null && s.split(".").every((p) => p === String(Number(p)));

// A proxy host as written in an address: a name, a dotted-quad IPv4 or a bracketed IPv6. Lower-case, or null.
function proxyHost(raw) {
  const h = String(raw || "").toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) return parseV6(h.slice(1, -1)) && !h.includes("%") ? h : null;
  if (/^[0-9.]+$/.test(h)) return dottedV4(h) ? h : null;
  return HOSTNAME.test(h) && !/^[0-9.]+$/.test(h) ? h : null;
}

// A proxy's server address checked: { server, scheme, host, port } (server written back as
// scheme://host:port with the scheme's port filled in), or { problem } naming key, never the text.
export function parseServer(value, key = "server") {
  const like = 'a proxy address like "http://203.0.113.10:3128", "https://proxy.example.com:443" or "socks5://203.0.113.10:1080"';
  if (typeof value !== "string" || !value.trim()) return { problem: wrong(key, like, value) };
  const text = value.trim();
  const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(text)?.[1] || "").toLowerCase();
  if (/^socks4a?$|^socks$/.test(scheme)) return { problem: `${key} is a SOCKS4 address; PairBrowse takes http:, https: or socks5: proxies` };
  if (scheme === "direct") return { problem: `${key} is "direct://"; for a direct connection, map the session to null instead of naming a proxy` };
  if (!SCHEMES.includes(scheme)) return { problem: `${key} isn't an http:, https: or socks5: address (PAC files and other kinds aren't supported); it takes ${like}` };
  let url;
  try { url = new URL(text); } catch { return { problem: `${key} isn't a valid address; it takes ${like}` }; }
  if (url.username || url.password || /^[a-z0-9+.-]+:\/\/[^/?#]*@/i.test(text)) {
    return { problem: `${key} has a user name or password in it; credentials go in secrets.env, never config.json: take them out of the address and set "auth": true` };
  }
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash || /[?#]/.test(text)) return { problem: `${key} has a path, query or fragment; a proxy is only scheme://host:port (PAC files aren't supported)` };
  const host = proxyHost(url.hostname);
  if (!host) return { problem: `${key} has no usable host name (a name, an IPv4 address like 203.0.113.10, or an IPv6 address in brackets)` };
  const port = url.port === "" ? DEFAULT_PORT[scheme] : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { problem: `${key} has a port outside 1 to 65535` };
  return { server: `${scheme}://${host}:${port}`, scheme, host, port };
}

// A bypass entry: a host name (optionally *.-prefixed), an IPv4 or bracketed IPv6 address, each
// with an optional :port, a bare IPv6 address (no port: "::1"), or an address range (CIDR).
// Nothing that could add or remove other rules.
function bypassEntry(s) {
  if (typeof s !== "string" || s.length > 253) return false;
  const v = s.toLowerCase();
  if (!v.includes("/") && !v.startsWith("[") && parseV6(v) && !v.includes("%")) return true;
  const cidr = /^([^/]+)\/(\d{1,3})$/.exec(v);
  if (cidr) return cidrOk(cidr[1], Number(cidr[2]));
  const m = /^(\*\.)?(\[[^\]]+\]|[^:[\]]+)(:\d{1,5})?$/.exec(v);
  if (!m || (m[3] && !(Number(m[3].slice(1)) >= 1 && Number(m[3].slice(1)) <= 65535))) return false;
  if (m[1]) return HOSTNAME.test(m[2]) && !/^[0-9.]+$/.test(m[2]);
  return !!proxyHost(m[2]);
}
const isLoopbackBypass = (s) => LOOPBACK_BYPASS.includes(String(s).toLowerCase());

// An address range "203.0.113.0/24" or "2001:db8::/32", or a bare address.
function cidrOk(addr, bits) {
  if (dottedV4(addr)) return bits === undefined || (Number.isInteger(bits) && bits >= 0 && bits <= 32);
  if (parseV6(addr) && !addr.includes("%")) return bits === undefined || (Number.isInteger(bits) && bits >= 0 && bits <= 128);
  return false;
}
// An expectEgress item: "country:US" (two capital letters) or an address or range.
export function egressItem(s) {
  if (typeof s !== "string") return false;
  if (COUNTRY.test(s)) return true;
  const m = /^([^/]+)(?:\/(\d{1,3}))?$/.exec(s);
  return !!m && cidrOk(m[1], m[2] === undefined ? undefined : Number(m[2]));
}

// One proxy entry checked against the block's strict setting: { entry } or { problem }.
function checkProxy(id, given, strict) {
  const key = proxyKey(id);
  if (!NETWORK_ID.test(id)) return { problem: `network.proxies has an id that isn't one: proxy ids are 1 to 34 lower-case letters, digits and -, starting with a letter or digit` };
  if (!plainObject(given)) return { problem: wrong(key, 'an object { "server": ... }', given) };
  const unknown = Object.keys(given).filter((k) => !PROXY_FIELDS.includes(k));
  if (unknown.length) return { problem: `${key} has ${unknownKeys(unknown)} (it takes ${quoteList(PROXY_FIELDS)})` };
  const parsed = parseServer(given.server, `${key}.server`);
  if (parsed.problem) return { problem: parsed.problem };
  const e = { ...PROXY_DEFAULTS, ...Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)) };
  if (typeof e.auth !== "boolean") return { problem: wrong(`${key}.auth`, "true or false", e.auth) };
  if (!Array.isArray(e.bypass) || e.bypass.length > MAX_LIST || !e.bypass.every(bypassEntry)) {
    return { problem: wrong(`${key}.bypass`, `a list of up to ${MAX_LIST} host names (*.example.com), addresses or ranges`, e.bypass) };
  }
  if (e.expectEgress !== null && (!Array.isArray(e.expectEgress) || e.expectEgress.length > MAX_LIST || !e.expectEgress.every(egressItem))) {
    return { problem: wrong(`${key}.expectEgress`, 'a list of addresses, ranges ("203.0.113.0/24") or countries ("country:US"), or null', e.expectEgress) };
  }
  if (!ON_EGRESS_CHANGE.includes(e.onEgressChange)) return { problem: wrong(`${key}.onEgressChange`, '"pause", "notify" or "ignore"', e.onEgressChange) };
  if (parsed.scheme === "socks5" && e.auth) {
    return { problem: `${key}: a SOCKS5 proxy with a user name and password isn't supported yet; use an HTTP or HTTPS proxy for it, or a SOCKS5 proxy without one` };
  }
  const outside = e.bypass.filter((b) => !isLoopbackBypass(b));
  if (strict && outside.length) {
    return { problem: `${key}.bypass has ${quoteList(outside)}, which strict mode doesn't allow (only this computer's own addresses go around the proxy); remove them, or set network.strict to false` };
  }
  return {
    entry: {
      id, server: parsed.server, scheme: parsed.scheme, host: parsed.host, port: parsed.port, auth: e.auth,
      bypass: [...e.bypass], expectEgress: e.expectEgress?.length ? [...e.expectEgress] : null, onEgressChange: e.onEgressChange,
    },
  };
}

// The address the egress checks read: https, no user, at most 2,000 characters.
function checkUrlProblem(v) {
  const what = 'an https address like "https://cloudflare.com/cdn-cgi/trace"';
  if (typeof v !== "string" || v.length > 2000) return wrong("network.checkUrl", what, v);
  let url;
  try { url = new URL(v); } catch { return wrong("network.checkUrl", what, v); }
  if (url.protocol !== "https:" || !url.hostname) return wrong("network.checkUrl", what, v);
  if (url.username || url.password) return "network.checkUrl has a user name or password in it; the check address takes none";
  return "";
}

const CONSEQUENCE = {
  block: "no browser session starts until it is fixed",
  proxy: (id) => (NETWORK_ID.test(id) ? `sessions using "${id}" don't start until it is fixed` : "sessions using it don't start until it is fixed"),
  session: (name) => (SESSION_NAME.test(name) ? `session "${name}" doesn't start until it is fixed` : "that session doesn't start until it is fixed"),
  fallback: "using the default for it until it is fixed",
};

// config.json's `network` value checked. { network, problem, proxyProblems, sessionProblems,
// warnings, messages }: network is the block with its defaults filled (null when absent: every session
// direct; null too with a problem); problem (one sentence, or "") refuses every session;
// proxyProblems { id: sentence } refuse the sessions using that proxy; sessionProblems
// { session: sentence } refuse that session; warnings are one line each for the log and
// pairbrowse_status, each saying what it stops; messages the same without the file's name and what
// they stop (a write that would bring any of them is refused, configProblem). Never throws.
export function checkNetwork(raw) {
  const out = { network: null, problem: "", proxyProblems: {}, sessionProblems: {}, warnings: [], messages: [] };
  const warn = (msg, what) => { out.messages.push(msg); out.warnings.push(`config.json: ${msg}; ${what}`); };
  const blockProblem = (msg) => { out.problem = msg; out.network = null; warn(msg, CONSEQUENCE.block); return out; };
  if (raw === undefined || raw === null) return out;
  if (!plainObject(raw)) return blockProblem(wrong("network", 'an object { "proxies": { ... }, ... }, or null', raw));
  const unknown = Object.keys(raw).filter((k) => !Object.hasOwn(NETWORK_DEFAULTS, k));
  if (unknown.length) return blockProblem(`network has ${unknownKeys(unknown)} (it takes ${quoteList(Object.keys(NETWORK_DEFAULTS))})`);
  const given = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined));
  const net = { ...NETWORK_DEFAULTS, ...given };
  if (!plainObject(net.proxies)) return blockProblem(wrong("network.proxies", "an object of proxies by id", net.proxies));
  if (Object.keys(net.proxies).length > MAX_PROXIES) return blockProblem(`network.proxies has more than ${MAX_PROXIES} proxies`);
  if (!plainObject(net.sessions)) return blockProblem(wrong("network.sessions", "an object of session names to a proxy id or null", net.sessions));
  if (net.default !== null && (typeof net.default !== "string" || !NETWORK_ID.test(net.default))) return blockProblem(wrong("network.default", "a proxy id or null", net.default));
  const urlProblem = checkUrlProblem(net.checkUrl);
  if (urlProblem) return blockProblem(urlProblem);
  // The safer side is the default for these two: strict on, a recheck every 10 minutes.
  if (typeof net.strict !== "boolean") { warn(wrong("network.strict", "true or false", net.strict), CONSEQUENCE.fallback); net.strict = true; }
  if (!(Number.isInteger(net.recheckMinutes) && net.recheckMinutes >= 1 && net.recheckMinutes <= RECHECK_MAX)) {
    warn(wrong("network.recheckMinutes", `a whole number from 1 to ${RECHECK_MAX}`, net.recheckMinutes), CONSEQUENCE.fallback);
    net.recheckMinutes = NETWORK_DEFAULTS.recheckMinutes;
  }
  // Built from entries (never by assignment), so a key such as "__proto__" stays a plain key.
  const proxies = [], proxyProblems = [], sessions = [], sessionProblems = [];
  for (const [id, entry] of Object.entries(net.proxies)) {
    const r = checkProxy(id, entry, net.strict);
    if (r.problem) { proxyProblems.push([id, r.problem]); warn(r.problem, CONSEQUENCE.proxy(id)); } else proxies.push([id, r.entry]);
  }
  for (const [name, id] of Object.entries(net.sessions)) {
    if (id === null || (typeof id === "string" && NETWORK_ID.test(id))) { sessions.push([name, id]); continue; }
    const msg = wrong(sessionKey(name), "a proxy id or null (direct)", id);
    sessionProblems.push([name, msg]);
    warn(msg, CONSEQUENCE.session(name));
  }
  out.proxyProblems = Object.fromEntries(proxyProblems);
  out.sessionProblems = Object.fromEntries(sessionProblems);
  // Ids named but not defined: said once here; the sessions that use them refuse at launch.
  const defined = (id) => Object.hasOwn(net.proxies, id);
  if (net.default !== null && !defined(net.default)) warn(`network.default names "${net.default}", which network.proxies doesn't define`, "sessions without a proxy of their own don't start until it is fixed");
  for (const [name, id] of sessions) {
    if (id !== null && !defined(id)) warn(`${sessionKey(name)} names "${id}", which network.proxies doesn't define`, CONSEQUENCE.session(name));
  }
  out.network = { proxies: Object.fromEntries(proxies), default: net.default, sessions: Object.fromEntries(sessions), strict: net.strict, checkUrl: net.checkUrl, recheckMinutes: net.recheckMinutes };
  return out;
}

// The one sentence a session's launch is refused with (in its launch error and status).
export const sessionRefusal = (session, problem) => `Session ${sessionShown(session)} doesn't start: ${String(problem).replace(/\.+$/, "")}.`;

// The network one session uses, from config (its `network` as config.json holds it) and the
// session's browser profile's network id (profileNetwork: an id, or null/undefined for none).
// { session, id, source, proxy, strict, checkUrl, recheckMinutes, problem }: source is "session",
// "profile", "default" or "direct"; proxy the checked entry (null: direct); problem a sentence
// naming the session (proxy null then): the launch refuses, never going direct instead.
export function networkFor(config, session, { profileNetwork } = {}) {
  const checked = checkNetwork(config?.network);
  const base = { session, id: null, source: "direct", proxy: null, strict: checked.network?.strict ?? NETWORK_DEFAULTS.strict,
    checkUrl: checked.network?.checkUrl ?? CHECK_URL, recheckMinutes: checked.network?.recheckMinutes ?? NETWORK_DEFAULTS.recheckMinutes, problem: "" };
  const refuse = (problem, id = null, source = base.source) => ({ ...base, id, source, problem: sessionRefusal(session, problem) });
  if (checked.problem) return refuse(`config.json's network: ${checked.problem}`);
  const net = checked.network;
  if (!net) return base;
  let id, source, where;
  if (Object.hasOwn(checked.sessionProblems, session)) return refuse(checked.sessionProblems[session], null, "session");
  if (Object.hasOwn(net.sessions, session)) [id, source, where] = [net.sessions[session], "session", sessionKey(session)];
  else if (profileNetwork !== undefined && profileNetwork !== null) {
    [id, source, where] = [profileNetwork, "profile", "its browser profile"];
    if (typeof id !== "string" || !NETWORK_ID.test(id)) return refuse(`its browser profile's network is ${kindOf(id)}, not a proxy id`, null, source);
  } else if (net.default !== null) [id, source, where] = [net.default, "default", "network.default"];
  else return base;
  if (id === null) return { ...base, source };
  if (Object.hasOwn(checked.proxyProblems, id)) return refuse(checked.proxyProblems[id], id, source);
  if (!Object.hasOwn(net.proxies, id)) return refuse(`${where} names "${id}", which network.proxies in config.json doesn't define`, id, source);
  return { ...base, id, source, proxy: net.proxies[id] };
}

// The network block once a session is renamed (to: its new name) or deleted (to: null) (C4: the
// map follows the session, sessions.mjs). Its own entry, whatever value it holds (a wrong one keeps
// refusing), moves to the new name in its place, or goes with a deleted session; a leftover entry
// under the new name goes too, so a rename never changes which network the session uses. A block
// with no map to change (absent, not an object, its sessions not an object: every session refuses
// on such a block anyway) or nothing to move gives null: nothing to write. Pure; never throws.
export function sessionMoved(network, from, to = null) {
  if (!plainObject(network) || !plainObject(network.sessions)) return null;
  const has = (name) => Object.hasOwn(network.sessions, name);
  if (!has(from) && (to === null || !has(to))) return null;
  // Built from entries (never by assignment), so a key such as "__proto__" stays a plain key.
  const entries = [];
  for (const [name, id] of Object.entries(network.sessions)) {
    if (name === to && name !== from) continue;
    if (name === from) { if (to !== null) entries.push([to, id]); continue; }
    entries.push([name, id]);
  }
  return { ...network, sessions: Object.fromEntries(entries) };
}

// config.json's `network` as the file holds it now (C4: read at each launch; the helper's loaded
// config is never re-read otherwise). { network } (undefined: the file or the key is absent), or
// { problem } when the file is there but can't be read or parsed: the launch refuses rather than
// going direct.
export function readNetwork(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    if (e?.code === "ENOENT") return { network: undefined };
    return { problem: `config.json couldn't be read (${e?.code || "error"}), so the session's network isn't known` };
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { problem: "config.json isn't valid JSON, so the session's network isn't known" }; }
  if (parsed === null) return { network: undefined };
  if (!plainObject(parsed)) return { problem: "config.json isn't an object { ... }, so the session's network isn't known" };
  return { network: parsed.network };
}

// ---- the launch (spec server-mode C1, C5; daemon/network.mjs forLaunch) ------------------------

// Strict mode's WebRTC policy: no UDP outside the proxy (so no local or public address of this
// computer reaches a page). The native build adds the same switch on every launch by itself.
export const STRICT_WEBRTC = "--webrtc-ip-handling-policy=disable_non_proxied_udp";
// The same policy in the spelling the open build's browser reads: it ignores STRICT_WEBRTC and
// gathers this computer's public address through STUN (seen behind a stub proxy, step 28). Only the
// open build gets it: native-engine.mjs drops every other WebRTC policy switch than STRICT_WEBRTC.
export const STRICT_WEBRTC_OPEN = "--force-webrtc-ip-handling-policy=disable_non_proxied_udp";
// What always goes around the proxy: this computer itself. The driver adds "<-loopback>" to the
// bypass list (send loopback through the proxy too) unless loopback is named here, so the helper's
// own 127.0.0.1 (the live view the browser's pages talk to) would otherwise go to the proxy.
export const DRIVER_LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];
export const PROXY_AUTH_SWITCH = "--pairbrowse-proxy-auth-file";
// The resolver rule a proxied session launches with: no name is looked up on this computer except
// the proxy's own and localhost; every other one goes to the proxy (C5).
export const resolverRule = (host) => `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}, EXCLUDE localhost`;
// A bypass entry as the browser's bypass list reads it: lower-case, a bare IPv6 address in brackets.
const bypassRule = (b) => { const v = String(b).toLowerCase(); return !v.includes("/") && !v.startsWith("[") && v.includes(":") && parseV6(v) ? `[${v}]` : v; };

// What a launch adds for the network networkFor chose (net), on a browser whose shell
// (browser/choice.mjs) is `shell` (native: a native build, engine "pairbrowse"; else the open
// build or another browser on its engine), with secrets.env as loadSecrets read it (`secrets`: { values,
// problem }, read only for a proxy with auth). { proxy, args, authFile, drop } or { problem }:
// - proxy: the driver's { server, bypass } (bypass comma-separated, loopback always first), never
//   with a credential; null for a direct session.
// - args: the resolver rule (strict, and always for SOCKS5 so it comes after the driver's own and a
//   user's local rule can't replace it) and, strict, STRICT_WEBRTC (and STRICT_WEBRTC_OPEN when not
//   native).
// - authFile: the auth file's content ({ server, username, password }) for a proxy with auth, on a
//   build that reads one (shell.proxyAuthFile); the caller writes it owner-only and adds its switch.
//   A proxy with auth on any other browser (the open build too) is refused: never argv or the driver.
// - drop: switch names taken out of the user's browserArgs first (their --host-resolver-rules).
// - problem: the launch's refusal sentence (net's own, or the credentials'); never a direct launch.
export function launchPart(net, { shell = null, secrets = null, native = false } = {}) {
  if (net?.problem) return { problem: net.problem };
  if (!net?.proxy) return { proxy: null, args: [], authFile: null, drop: [] };
  const p = net.proxy;
  let authFile = null;
  if (p.auth) {
    if (!shell?.proxyAuthFile) {
      return { problem: sessionRefusal(net.session, `network "${p.id}" needs a username and password, and this browser can't take them from its own file (no PairBrowse build reads one yet, and the open build never will); use a proxy without one for now`) };
    }
    const creds = credentialsFor(p.id, secrets?.values, { fileProblem: secrets?.problem || null });
    if (creds.problem) return { problem: sessionRefusal(net.session, creds.problem) };
    authFile = { server: p.server, username: creds.username, password: creds.password };
  }
  const resolver = net.strict || p.scheme === "socks5";
  return {
    proxy: { server: p.server, bypass: [...new Set([...DRIVER_LOOPBACK, ...p.bypass.map(bypassRule)])].join(",") },
    args: [...(resolver ? [resolverRule(p.host)] : []), ...(net.strict ? [STRICT_WEBRTC, ...(native ? [] : [STRICT_WEBRTC_OPEN])] : [])],
    authFile,
    drop: resolver ? ["host-resolver-rules"] : [],
  };
}

// The launch options with a launchPart applied: its proxy set, the switches it drops taken out of
// options.args (the user's, screened by launchArgs) and its own added last, where the engine takes
// them over any earlier value. { options, dropped }: dropped names each switch taken out (no value).
export function applyLaunchPart(options, part) {
  const dropped = [];
  const kept = (options?.args || []).filter((a) => {
    if (!part?.drop?.includes(switchName(a))) return true;
    dropped.push(String(a).split("=")[0]);
    return false;
  });
  const proxy = part?.proxy ? { proxy: { ...part.proxy } } : {};
  return { options: { ...options, ...proxy, args: [...kept, ...(part?.args || [])] }, dropped };
}
