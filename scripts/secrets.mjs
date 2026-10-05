// Reads ~/.pairbrowse/secrets.env. Every secret must say which sites it may be typed into:
//   SHOPIFY_PASSWORD=...
//   SHOPIFY_PASSWORD_DOMAINS=accounts.shopify.com
import { readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";

export function parseSecrets(text) {
  const raw = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    raw[m[1]] = v;
  }
  const values = {};
  const domains = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.endsWith("_DOMAINS")) continue;
    if (!v) continue;
    values[k] = v;
    domains[k] = (raw[`${k}_DOMAINS`] || "").split(",").map((d) => d.trim().toLowerCase().replace(/^\*?\./, "")).filter(Boolean);
  }
  return { values, domains };
}

export function loadSecrets(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { values: {}, domains: {}, problem: null };
  }
  if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
    return { values: {}, domains: {}, problem: `${file} is readable by other users; run chmod 600 on it. Secrets are disabled until then.` };
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
export function secretStore(file, log = () => {}) {
  let current = loadSecrets(file);
  if (current.problem) log(current.problem);
  return {
    get: () => current,
    save(next) {
      writeSecrets(file, next);
      current = loadSecrets(file);
    },
  };
}

// text with every saved password (4+ characters) replaced by its name, for whatever Claude reads.
// Longest first: a password that starts with (or holds) a shorter one is masked whole, not
// left with its remainder showing.
export function redact(text, values) {
  let out = String(text);
  const longestFirst = Object.entries(values).sort(([, a], [, b]) => String(b).length - String(a).length);
  for (const [name, value] of longestFirst) if (value && value.length >= 4) out = out.split(value).join(`<secret>${name}</secret>`);
  return out;
}

// ---- writing, from the Profile panel ---------------------------------------------------------

export const validSecretName = (name) => /^[A-Z][A-Z0-9_]{1,59}$/.test(String(name || "")) && !String(name).endsWith("_DOMAINS");

export function cleanDomains(list) {
  const out = [];
  for (const raw of String(list ?? "").split(/[\s,]+/)) {
    const d = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*?\./, "");
    if (!d) continue;
    if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return { error: `"${raw}" isn't a site name like accounts.shopify.com` };
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

export function writeSecrets(file, { values, domains }) {
  let text = HEADER;
  for (const name of Object.keys(values).sort()) {
    text += `\n${name}="${values[name]}"\n${name}_DOMAINS=${(domains[name] || []).join(",")}\n`;
  }
  writeFileSync(file, text, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600);
}

export function setSecret(current, { name, value, domains }) {
  if (!validSecretName(name)) return { error: "Use a name like SHOPIFY_PASSWORD." };
  const v = String(value ?? "");
  if (!v && !(name in current.values)) return { error: "Enter the password." };
  if (v.length > 4096 || /[\r\n\u0000]/.test(v)) return { error: "Passwords can't contain line breaks." };
  const d = cleanDomains(domains);
  if (d.error) return d;
  return {
    values: { ...current.values, [name]: v || current.values[name] }, // empty value: keep the old one, change sites only
    domains: { ...current.domains, [name]: d.domains },
  };
}

export function deleteSecret(current, name) {
  const values = { ...current.values };
  const domains = { ...current.domains };
  delete values[name];
  delete domains[name];
  return { values, domains };
}
