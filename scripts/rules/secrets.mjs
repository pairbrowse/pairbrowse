// Reads ~/.pairbrowse/secrets.env. Every secret must say which sites it may be typed into:
//   SHOPIFY_PASSWORD=...
//   SHOPIFY_PASSWORD_DOMAINS=accounts.shopify.com
// The file must be this user's own regular file (never a link), mode 0600; it is written whole
// through a 0600 temporary file and a rename, so no reader ever sees half of it.
import { closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync, constants as fsConstants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

// Reserved secrets (spec server-mode B6, C3): names under PAIRBROWSE_ are PairBrowse's own
// credentials (a proxy's username and password, a hand-off channel's token), never a site's
// password. Never typed into a page, even with a _DOMAINS line (their sites are always none);
// hidden from pairbrowse_facts get; never counted as a typed secret by secretNamesIn (policy.mjs),
// so never swapped for the value, and an agent that types a saved one is refused; still masked by
// redact; listed by name in the owner's Profile panel. Any name starting with the prefix (even
// PAIRBROWSE_ alone) gets no sites and can't be made from the Profile panel's add form.
export const RESERVED_PREFIX = "PAIRBROWSE_";
export const reservedSecret = (name) => typeof name === "string" && /^PAIRBROWSE_[A-Z0-9_]+$/.test(name);
export const RESERVED_RULE = "PAIRBROWSE_ secrets are PairBrowse's own credentials (proxies, hand-off channels) and are never typed into a page. Hand this field to the user.";
// Reserved values are masked by redact (4 or more characters), so shorter ones are refused.
export const RESERVED_MIN = 4;

export function parseSecrets(text) {
  const raw = {};
  for (const line of text.split(/\r?\n/)) {
    // "s": a value may hold U+2028 or U+2029, which "." alone doesn't match.
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/s);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/s.test(v)) v = v.slice(1, -1);
    raw[m[1]] = v;
  }
  const values = {};
  const domains = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.endsWith("_DOMAINS")) continue;
    if (!v) continue;
    values[k] = v;
    domains[k] = k.startsWith(RESERVED_PREFIX) ? [] : (raw[`${k}_DOMAINS`] || "").split(",").map((d) => d.trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean);
  }
  return { values, domains };
}

const POSIX = process.platform !== "win32";
const uid = () => (typeof process.getuid === "function" ? process.getuid() : null);

// Why the secrets file at `file` (its lstat `st`) can't be trusted, or null. Not followed through
// a link (another file's contents, or a file another user can swap), only this user's regular file.
function fileProblem(file, st) {
  const off = "Secrets are disabled until then.";
  if (st.isSymbolicLink()) return `${file} is a link; PairBrowse reads secrets only from your own regular file. Put the file itself there in place of the link. ${off}`;
  if (!st.isFile()) return `${file} isn't a regular file; move it away and save your passwords again from the Profile panel. ${off}`;
  if (POSIX && uid() !== null && st.uid !== uid()) return `${file} belongs to another user; PairBrowse reads secrets only from a file of your own. Move it away and save your passwords again from the Profile panel. ${off}`;
  if (POSIX && (st.mode & 0o077) !== 0) return `${file} is readable by other users; run chmod 600 on it. ${off}`;
  return null;
}

// { values, domains, problem }: a missing file is no secrets and no problem; a file that fails a
// check (fileProblem) or can't be read is no secrets and the problem saying why. The checks are
// made on the name (lstat) and again on the opened file (opened without following a link, without
// waiting on a pipe), so a file swapped in between is refused too.
export function loadSecrets(file) {
  const none = (problem) => ({ values: {}, domains: {}, problem });
  let st;
  try { st = lstatSync(file); } catch (e) {
    return none(e?.code === "ENOENT" ? null : `${file} couldn't be read (${e?.code || "error"}). Check its permissions; secrets are disabled until then.`);
  }
  const problem = fileProblem(file, st);
  if (problem) return none(problem);
  let text;
  try {
    const fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0));
    try {
      const opened = fstatSync(fd);
      const again = fileProblem(file, opened) || (POSIX && (opened.ino !== st.ino || opened.dev !== st.dev) ? `${file} changed while it was read. Secrets are disabled until it is read again.` : null);
      if (again) return none(again);
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return none(e?.code === "ENOENT" ? null : `${file} couldn't be read (${e?.code || "error"}). Check its permissions; secrets are disabled until then.`);
  }
  return { ...parseSecrets(text), problem: null };
}

export function hostAllowed(url, allowed) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false; // never send a password over plain http
  const host = u.hostname.toLowerCase();
  return allowed.some((d) => host === d || host.endsWith(`.${d}`));
}

// The passwords file, read again after each change so every part of the helper sees a password
// added in the Profile panel at once.
// save(next) throws (with the reason) when the file on disk fails a check: its passwords weren't
// read, so writing `next` over it would lose them.
export function secretStore(file, log = () => {}) {
  let current = loadSecrets(file);
  if (current.problem) log(current.problem);
  return {
    get: () => current,
    save(next) {
      const now = loadSecrets(file);
      if (now.problem) { current = now; throw new Error(now.problem); }
      writeSecrets(file, next);
      current = loadSecrets(file);
    },
  };
}

// text with every saved password (4+ characters) replaced by its name, for whatever Claude reads.
// Longest first: a password that holds a shorter one goes whole, not with its other characters left.
// as(name): what a password becomes (by default <secret>NAME</secret>). Longest first, so a saved
// password that holds a shorter one never leaves a piece of itself behind.
export function redact(text, values = {}, { as = (name) => `<secret>${name}</secret>` } = {}) {
  let out = String(text ?? "");
  const longestFirst = Object.entries(values || {}).sort(([, a], [, b]) => String(b ?? "").length - String(a ?? "").length);
  for (const [name, value] of longestFirst) if (value && String(value).length >= 4) out = out.split(String(value)).join(as(name));
  return out;
}

// ---- writing, from the Profile panel ---------------------------------------------------------

export const validSecretName = (name) => /^[A-Z][A-Z0-9_]{1,59}$/.test(String(name || "")) && !String(name).endsWith("_DOMAINS");

export function cleanDomains(list) {
  const out = [];
  for (const raw of String(list ?? "").split(/[\s,]+/)) {
    const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*?\./, "");
    if (!d) continue;
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return { error: `"${raw}" isn't a site name. Enter one like accounts.shopify.com.` };
    out.push(d);
  }
  if (!out.length) return { error: "Add at least one site where this password may be used." };
  return { domains: [...new Set(out)] };
}

// Turns "Shopify password" into SHOPIFY_PASSWORD.
export const nameFromLabel = (label) => String(label || "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(\d)/, "S_$1").slice(0, 60);

const HEADER = `# PairBrowse passwords. Managed from the Profile panel; only your user account can read this file.
# Claude types a password by its NAME; PairBrowse fills the real value, only on the HTTPS sites in NAME_DOMAINS.
`;

// Writes the whole file: a 0600 temporary file beside it (a new name, never an existing file),
// flushed, then renamed over it, so a reader sees the old file or the new one, never half. Throws
// when the name holds a link, something other than a regular file, or another user's file (a
// rename would replace what isn't ours to replace), and leaves no temporary file behind on a failure.
export function writeSecrets(file, { values, domains }) {
  let text = HEADER;
  for (const name of Object.keys(values).sort()) {
    text += `\n${name}="${values[name]}"\n${name}_DOMAINS=${(name.startsWith(RESERVED_PREFIX) ? [] : domains[name] || []).join(",")}\n`;
  }
  let st = null;
  try { st = lstatSync(file); } catch (e) { if (e?.code !== "ENOENT") throw e; }
  const problem = st && (st.isSymbolicLink() || !st.isFile() || (POSIX && uid() !== null && st.uid !== uid())) ? fileProblem(file, st) : null;
  if (problem) throw new Error(problem.replace(/ Secrets are disabled until then\.$/, " Nothing was saved."));
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      if (POSIX) fchmodSync(fd, 0o600); // the umask can't widen or narrow it
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

const valueProblem = (v) => (v.length > 4096 || /[\r\n\u0000]/.test(v) ? "Passwords can't contain line breaks. Paste it again on one line." : null);

export function setSecret(current, { name, value, domains }) {
  if (!validSecretName(name)) return { error: "Use a name like SHOPIFY_PASSWORD." };
  if (name.startsWith(RESERVED_PREFIX)) return { error: `Names starting with ${RESERVED_PREFIX} are kept for PairBrowse's own credentials. Use another name, like SHOPIFY_PASSWORD.` };
  const v = String(value ?? "");
  if (!v && !(name in current.values)) return { error: "Enter the password." };
  if (valueProblem(v)) return { error: valueProblem(v) };
  const d = cleanDomains(domains);
  if (d.error) return d;
  return {
    values: { ...current.values, [name]: v || current.values[name] }, // empty value: keep the old one, change sites only
    domains: { ...current.domains, [name]: d.domains },
  };
}

// A reserved secret (PAIRBROWSE_..., set by PairBrowse's own settings and command line, never the
// Profile panel's add form): no sites, at least RESERVED_MIN characters so redact masks it.
export function setReservedSecret(current, { name, value }) {
  if (!validSecretName(name) || !reservedSecret(name)) return { error: `Use a name starting with ${RESERVED_PREFIX}, like ${RESERVED_PREFIX}PROXY_HOME_PASSWORD.` };
  const v = String(value ?? "");
  if (v.length < RESERVED_MIN) return { error: `Too short. Use at least ${RESERVED_MIN} characters, so PairBrowse can keep it out of everything it shows and logs.` };
  if (valueProblem(v)) return { error: valueProblem(v) };
  return { values: { ...current.values, [name]: v }, domains: { ...current.domains, [name]: [] } };
}

export function deleteSecret(current, name) {
  const values = { ...current.values };
  const domains = { ...current.domains };
  delete values[name];
  delete domains[name];
  return { values, domains };
}
