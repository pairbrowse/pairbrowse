// A proxy's username and password (spec server-mode C3): only in ~/.pairbrowse/secrets.env, under
// reserved names made from the proxy's id (upper-cased, - as _): the reserved prefix, then
// PROXY_<ID>_USERNAME and PROXY_<ID>_PASSWORD. Reserved names are never typed into a page and are masked in
// what the helper logs and agents read (rules/secrets.mjs). They reach the browser only through
// its owner-only proxy auth file (net/config.mjs launchPart, daemon/network.mjs), never argv or the
// driver. No message here ever holds a value, only the names.
//
// Pure; Node's standard library only.
import { RESERVED_MIN, RESERVED_PREFIX } from "../rules/secrets.mjs";

// Ids name a proxy in the map, in a profile and, upper-cased with - as _, in its secrets' names
// (34 characters keep the longest of those within a secret name's 60). net/config.mjs reads it here.
export const NETWORK_ID = /^[a-z0-9][a-z0-9-]{0,33}$/;

// The two secret names for proxy id `id` ("us-east": the prefix, then PROXY_US_EAST_USERNAME and
// _PASSWORD), or null for a string that isn't an id.
export function proxySecretNames(id) {
  if (typeof id !== "string" || !NETWORK_ID.test(id)) return null;
  const stem = `${RESERVED_PREFIX}PROXY_${id.toUpperCase().replaceAll("-", "_")}`;
  return { username: `${stem}_USERNAME`, password: `${stem}_PASSWORD` };
}

// The credentials of proxy `id` from secrets.env's values (loadSecrets(...).values): { username,
// password }, or { problem } naming what is missing (both are needed, each at least RESERVED_MIN
// characters, which redact masks). fileProblem: why secrets.env couldn't be read (loadSecrets'
// problem), said first when given, since every secret is off until it is fixed.
export function credentialsFor(id, values = {}, { fileProblem = null } = {}) {
  const names = proxySecretNames(id);
  if (!names) return { problem: "that proxy has no valid id" };
  const need = `network "${id}" needs ${names.username} and _PASSWORD in secrets.env`;
  if (fileProblem) return { problem: `${need}, and secrets.env can't be used: ${fileProblem}` };
  const get = (name) => (typeof values?.[name] === "string" ? values[name] : "");
  const username = get(names.username), password = get(names.password);
  if (!username || !password) return { problem: need };
  const short = [[names.username, username], [names.password, password]].filter(([, v]) => v.length < RESERVED_MIN).map(([n]) => n);
  if (short.length) return { problem: `${short.join(" and ")} in secrets.env ${short.length > 1 ? "are" : "is"} shorter than ${RESERVED_MIN} characters, too short to be masked in logs; use a longer one` };
  // One line of JSON (the auth file): a line break can't come from secrets.env, but never pass one on.
  if (/[\r\n]/.test(username + password)) return { problem: `${names.username} or _PASSWORD in secrets.env has a line break in it` };
  return { username, password };
}
