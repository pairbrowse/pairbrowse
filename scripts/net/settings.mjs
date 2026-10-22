// The Network section of Settings (spec server-mode C14): what a person sees of config.json's
// `network` and the changes they make to it, worked out here; liveview/network.mjs reads and writes
// the files and runs the Test, the owner-only routes (liveview/routes/network.mjs) carry them.
// A person adds, edits and removes a proxy (its id, type, host, port, and whether it needs a
// username and password), picks the default, and picks one per session (or direct, or the
// default). Everything else in the block (bypass, expectEgress, onEgressChange, strict, checkUrl,
// recheckMinutes) stays as config.json has it. The username and password go only to secrets.env
// (reserved names, C3) and are write-only: the summary says whether each is saved, never what it
// is, and nothing here returns, logs or repeats a credential. A change that would leave the
// edited entry or the block with a problem (checkNetwork) is refused whole, nothing written.
//
// Pure; Node's standard library only.
import { checkNetwork, parseServer, sessionShown, NETWORK_ID, SCHEMES } from "./config.mjs";
import { proxySecretNames } from "./credentials.mjs";
import { RESERVED_MIN } from "../rules/secrets.mjs";

// The proxy types a person picks from (the schemes config.json takes).
export const PROXY_TYPES = SCHEMES;
// A session's choice: the default (no entry in network.sessions), direct (null) or a proxy (its id).
export const CHOICES = ["default", "direct", "proxy"];
// Session names as sessions.mjs validName takes them; clean sessions are never kept in the map.
const SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
const TEMPORARY = /^clean-\d+$/;
const CREDENTIAL_MAX = 4096;
const OPS = {
  add: ["op", "id", "type", "host", "port", "auth", "username", "password"],
  edit: ["op", "id", "type", "host", "port", "auth", "username", "password"],
  remove: ["op", "id"],
  default: ["op", "id"],
  session: ["op", "session", "choice", "id"],
  test: ["op", "id", "type", "host", "port", "auth", "username", "password"],
  // The recently removed list (liveview/network.mjs keeps it, never config.json): forget one, or all.
  forget: ["op", "id"],
  "clear-recent": ["op"],
};
// The ops that change the recently removed list only, not config.json.
export const RECENT_OPS = ["forget", "clear-recent"];
// How many removed proxies are kept to add again.
export const RECENT_MAX = 20;
export const NETWORK_OPS = Object.keys(OPS);

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const quoted = (id) => (typeof id === "string" && NETWORK_ID.test(id) ? `"${id}"` : "that proxy");
const listOf = (names) => (names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

// config.json's network block as written, checked: { block, problem } (block: a plain object to
// change, {} when absent; problem: why Settings can't change it, a sentence, or "").
function blockOf(raw) {
  if (raw === undefined || raw === null) return { block: {}, problem: "" };
  const checked = checkNetwork(raw);
  if (checked.problem) return { block: null, problem: `config.json's network can't be read (${checked.problem}). Fix it in config.json first; Settings changes nothing until then.` };
  return { block: raw, problem: "" };
}
const proxiesOf = (block) => (plainObject(block?.proxies) ? block.proxies : {});
const sessionsOf = (block) => (plainObject(block?.sessions) ? block.sessions : {});

// What Settings shows (GET network.json, the network event). raw: config.json's network as
// written; sessions: the kept sessions' names; values: secrets.env's values (only whether each
// credential is there is read); problem: a reason the file couldn't be read (config.json itself);
// secretsProblem: why secrets.env can't be used (rules/secrets.mjs loadSecrets), or "".
// { problem, secretsProblem, proxies: [{ id, type, host, port, auth, username, password, problem }], default,
// sessions: [{ name, choice, id }], strict }: username and password are true when saved, never
// the values; host as an address writes it (an IPv6 address in brackets); a proxy config.json
// holds with a problem is listed with that sentence (type, host and port null when its server
// can't be read). Never throws.
// usage: { id: ISO time } when a session last started or was rechecked on that proxy (its
// network.json), so each proxy says when it was last used; recent: the recently removed list
// (recentList), less any name now in config.json. Each proxy also lists usedBy: the sessions that
// go through it (their own choice, or the default when it is the default).
export function networkSummary(raw, { sessions = [], values = {}, problem = "", secretsProblem = "", usage = {}, recent = [] } = {}) {
  const checked = problem ? { problem, network: null, proxyProblems: {} } : checkNetwork(raw);
  const block = plainObject(raw) ? raw : {};
  const has = (name) => typeof values?.[name] === "string" && values[name].length > 0;
  const proxies = Object.entries(proxiesOf(block)).filter(([id]) => NETWORK_ID.test(id)).map(([id, entry]) => {
    const s = parseServer(plainObject(entry) ? entry.server : undefined);
    const names = proxySecretNames(id);
    return { id, type: s.scheme || null, host: s.host || null, port: s.port || null, auth: plainObject(entry) && entry.auth === true,
      username: has(names.username), password: has(names.password), problem: checked.proxyProblems?.[id] || "" };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const map = sessionsOf(block);
  const names = [...new Set([...sessions, ...Object.keys(map)])].filter((n) => SESSION_NAME.test(n) && !TEMPORARY.test(n)).sort((a, b) => (a === "default" ? -1 : b === "default" ? 1 : a.localeCompare(b)));
  const def = typeof block.default === "string" && NETWORK_ID.test(block.default) ? block.default : null;
  const usedBy = (id) => names.filter((n) => (Object.hasOwn(map, n) ? map[n] === id : def === id));
  const last = (id) => (plainObject(usage) && typeof usage[id] === "string" && !Number.isNaN(Date.parse(usage[id])) ? new Date(usage[id]).toISOString() : null);
  for (const p of proxies) { p.lastUsed = last(p.id); p.usedBy = usedBy(p.id); }
  const listed = new Set(proxies.map((p) => p.id));
  return {
    problem: checked.problem ? (problem || `config.json's network can't be read (${checked.problem}). Fix it in config.json first.`) : "",
    // Credentials then read as "not saved" whatever the file holds: the page says why.
    secretsProblem: typeof secretsProblem === "string" ? secretsProblem : "",
    proxies,
    default: typeof block.default === "string" && NETWORK_ID.test(block.default) ? block.default : null,
    sessions: names.map((name) => {
      if (!Object.hasOwn(map, name)) return { name, choice: "default", id: null };
      const id = map[name];
      return id === null ? { name, choice: "direct", id: null } : { name, choice: "proxy", id: typeof id === "string" && NETWORK_ID.test(id) ? id : null };
    }),
    strict: block.strict !== false,
    recent: recentList(recent).filter((r) => !listed.has(r.id)),
  };
}

// The recently removed list as kept (network-recent.json's entries): each { id, type, host, port,
// auth, removedAt } checked, newest first, at most RECENT_MAX, one per name. Never a credential.
export function recentList(raw) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    if (!plainObject(r) || typeof r.id !== "string" || !NETWORK_ID.test(r.id) || seen.has(r.id)) continue;
    if (!PROXY_TYPES.includes(r.type) || typeof r.host !== "string" || !r.host || r.host.length > 255) continue;
    const port = Number.isInteger(r.port) && r.port >= 1 && r.port <= 65535 ? r.port : null;
    const at = typeof r.removedAt === "string" && !Number.isNaN(Date.parse(r.removedAt)) ? new Date(r.removedAt).toISOString() : null;
    seen.add(r.id);
    out.push({ id: r.id, type: r.type, host: r.host, port, auth: r.auth === true, removedAt: at });
    if (out.length >= RECENT_MAX) break;
  }
  return out.sort((a, b) => String(b.removedAt || "").localeCompare(String(a.removedAt || "")));
}

// The proxy part of an add, edit or test, checked: { id, server, scheme, host, port, auth,
// username, password } (username and password "" when not given: keep what is saved) or { error }.
// The error names the field, never a value given.
export function readProxyForm(op, { needId = true } = {}) {
  const id = op.id;
  if (needId || id !== undefined) {
    if (typeof id !== "string" || !NETWORK_ID.test(id)) return { error: "The name is 1 to 34 lower-case letters, digits and -, starting with a letter or digit (like us-east)." };
  }
  if (!PROXY_TYPES.includes(op.type)) return { error: "The type is HTTP, HTTPS or SOCKS5." };
  const rawHost = typeof op.host === "string" ? op.host.trim() : "";
  if (!rawHost || rawHost.length > 255 || !/^[A-Za-z0-9._:[\]-]+$/.test(rawHost)) return { error: "The host is a name, an IPv4 address or an IPv6 address (no scheme, user, path or port)." };
  const host = rawHost.includes(":") && !rawHost.startsWith("[") ? `[${rawHost}]` : rawHost;
  let port = op.port;
  if (port === undefined || port === null || port === "") port = null;
  else if (typeof port === "string" && /^\d{1,5}$/.test(port)) port = Number(port);
  if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535)) return { error: "The port is a whole number from 1 to 65535 (empty: the type's own)." };
  const parsed = parseServer(`${op.type}://${host}${port === null ? "" : `:${port}`}`, "The address");
  if (parsed.problem) return { error: `${parsed.problem}.` };
  if (op.auth !== undefined && typeof op.auth !== "boolean") return { error: "Whether it needs a username and password is true or false." };
  const auth = op.auth === true;
  const cred = (v, what) => {
    if (v === undefined || v === null || v === "") return { value: "" };
    if (typeof v !== "string" || v.length > CREDENTIAL_MAX || /[\r\n\u0000]/.test(v)) return { error: `The ${what} is one line of up to ${CREDENTIAL_MAX} characters.` };
    if (v.length < RESERVED_MIN) return { error: `The ${what} is too short: use at least ${RESERVED_MIN} characters, so PairBrowse can keep it out of everything it shows and logs.` };
    return { value: v };
  };
  const u = cred(op.username, "username"), p = cred(op.password, "password");
  if (u.error || p.error) return { error: u.error || p.error };
  if (!auth && (u.value || p.value)) return { error: "Turn on \"Needs a username and password\" to save them, or leave them empty." };
  return { id: id ?? null, server: parsed.server, scheme: parsed.scheme, host: parsed.host, port: parsed.port, auth, username: u.value, password: p.value };
}

// A body checked against its op's fields: the op, or { error }.
export function readNetworkOp(given) {
  if (!plainObject(given) || !Object.hasOwn(OPS, given.op)) return { error: `A network change is { op: ${NETWORK_OPS.map((o) => `"${o}"`).join(", ")}, ... }.` };
  const extra = Object.keys(given).find((k) => !OPS[given.op].includes(k));
  if (extra !== undefined) return { error: `"${given.op}" takes ${OPS[given.op].slice(1).join(", ")}${/^[A-Za-z]{1,40}$/.test(extra) ? `, not "${extra}"` : ""}.` };
  return given;
}

// One change to the block. raw: config.json's network as written (undefined: none); values:
// secrets.env's values (to know which credentials are saved); secretsProblem: why secrets.env can't
// be used (a change that needs a username and password is refused with it). { network, set, remove, text } (the
// block to write whole into config.json's network, the reserved secrets to set { name: value } and
// remove [names], a sentence for the person, naming no credential) or { error }. Test isn't a
// change (liveview/network.mjs runs it). Never throws.
export function networkChange(raw, op, { values = {}, secretsProblem = "" } = {}) {
  const read = readNetworkOp(op);
  if (read.error) return read;
  if (op.op === "test") return { error: "A test isn't a change." };
  if (RECENT_OPS.includes(op.op)) return { error: "That changes the recently removed list, not config.json." };
  const { block, problem } = blockOf(raw);
  if (problem) return { error: problem };
  const proxies = proxiesOf(block), map = sessionsOf(block);
  const exists = (id) => typeof id === "string" && Object.hasOwn(proxies, id);
  const saved = (name) => typeof values?.[name] === "string" && values[name].length > 0;
  // Built from entries (never by assignment), so a key such as "__proto__" stays a plain key.
  const withProxies = (entries) => ({ ...block, proxies: Object.fromEntries(entries) });
  const set = {};
  let next, remove = [], text;
  if (op.op === "add" || op.op === "edit") {
    const f = readProxyForm(op);
    if (f.error) return f;
    if (op.op === "add" && exists(f.id)) return { error: `A proxy named ${quoted(f.id)} is there already: edit it, or choose another name.` };
    if (op.op === "edit" && !exists(f.id)) return { error: `There's no proxy named ${quoted(f.id)} (it may have been removed). Reload the list.` };
    const names = proxySecretNames(f.id);
    if (f.auth) {
      // Its saved credentials can't be read nor new ones written: say why, not "enter one".
      if (secretsProblem) return { error: `Not saved: PairBrowse can't use secrets.env for the username and password. ${secretsProblem}` };
      if (!f.username && !saved(names.username)) return { error: "Enter the proxy's username." };
      if (!f.password && !saved(names.password)) return { error: "Enter the proxy's password." };
      if (f.username) set[names.username] = f.username;
      if (f.password) set[names.password] = f.password;
    } else remove = [names.username, names.password].filter(saved);
    const old = op.op === "edit" && plainObject(proxies[f.id]) ? proxies[f.id] : {};
    const entry = { ...old, server: f.server, auth: f.auth };
    next = withProxies(op.op === "edit" ? Object.entries(proxies).map(([id, e]) => [id, id === f.id ? entry : e]) : [...Object.entries(proxies), [f.id, entry]]);
    const checked = checkNetwork(next);
    const why = checked.problem || checked.proxyProblems[f.id];
    if (why) return { error: `Not saved: ${why}.` };
    text = `${op.op === "add" ? "Added" : "Saved"} proxy "${f.id}"${f.auth ? ", with its username and password in secrets.env" : ""}.`;
  } else if (op.op === "remove") {
    if (!exists(op.id)) return { error: `There's no proxy named ${quoted(op.id)} (it may have been removed already). Reload the list.` };
    const users = Object.entries(map).filter(([, id]) => id === op.id).map(([name]) => sessionShown(name));
    const uses = [...(block.default === op.id ? ["the default"] : []), ...(users.length ? [`session${users.length > 1 ? "s" : ""} ${listOf(users)}`] : [])];
    // Never quietly direct: sessions on it would otherwise refuse to start, or (the default) a
    // person would think they still went through it.
    if (uses.length) return { error: `"${op.id}" is ${listOf(uses)}: choose another for ${uses.length > 1 || users.length > 1 ? "them" : "it"} first, then remove it.` };
    next = withProxies(Object.entries(proxies).filter(([id]) => id !== op.id));
    const names = proxySecretNames(op.id);
    remove = [names.username, names.password].filter(saved);
    text = `Removed proxy "${op.id}"${remove.length ? " and its username and password" : ""}.`;
  } else if (op.op === "default") {
    if (op.id !== null && !exists(op.id)) return { error: `There's no proxy named ${quoted(op.id)}. Choose one from the list, or direct.` };
    next = { ...block, default: op.id };
    text = op.id === null ? "Sessions without a choice of their own now connect directly." : `Sessions without a choice of their own now use "${op.id}".`;
  } else {
    const name = op.session;
    if (typeof name !== "string" || !SESSION_NAME.test(name) || TEMPORARY.test(name)) return { error: "session is a kept session's name (a clean session can't have a choice of its own)." };
    if (!CHOICES.includes(op.choice)) return { error: `choice is ${CHOICES.map((c) => `"${c}"`).join(", ")}.` };
    if (op.choice === "proxy" && !exists(op.id)) return { error: `There's no proxy named ${quoted(op.id)}. Choose one from the list.` };
    if (op.choice !== "proxy" && op.id !== undefined && op.id !== null) return { error: "id goes with choice \"proxy\" only." };
    const entries = Object.entries(map).filter(([n]) => n !== name);
    if (op.choice !== "default") entries.push([name, op.choice === "direct" ? null : op.id]);
    next = { ...block, sessions: Object.fromEntries(entries) };
    text = `Session "${name}" ${op.choice === "default" ? "follows the default" : op.choice === "direct" ? "connects directly" : `uses "${op.id}"`} from its next start.`;
  }
  const after = checkNetwork(next);
  if (after.problem) return { error: `Not saved: ${after.problem}.` };
  return { network: next, set, remove, text };
}
