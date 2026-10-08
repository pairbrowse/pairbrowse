// Fields people are filling: a field a person edits is theirs for a while, here or in the other
// browser of a shared tab. Agents leave it as the person wrote it (serve.mjs refuses typing,
// filling, choosing or ticking there; fast mode skips it), and people never wait for each other.
import { cleanName } from "../join.mjs";
import { within } from "../util.mjs";

export const OWN_MS = 5_000; // a field a person edited stays theirs this long
const FOCUS_OWN_MS = 10_000; // while they keep it focused, a little longer
const READ_MS = 1500;

// info: what the page script knows about one field ({ times, focused, rw, rt, name }: real
// input times here, and who in the other browser edited it, when). byAgent(t): whether time t
// fell in an agent's action (agents' typing is real input too). Returns { who, local, name } or null.
// byRemote(t): the joiner whose input (shared browser mode) time t was, or null.
export function fieldOwner(info, { host, byAgent = () => false, byRemote = () => null, now = Date.now() } = {}) {
  if (!info || typeof info !== "object") return null;
  const times = (Array.isArray(info.times) ? info.times : []).map(Number).filter((t) => t > 0 && t <= now && !byAgent(t));
  const t = times.length ? Math.max(...times) : 0;
  const local = t && (now - t < OWN_MS || (info.focused && now - t < FOCUS_OWN_MS)) ? t : 0;
  const rt = Number(info.rt) || 0;
  const remote = info.rw && rt <= now && now - rt < OWN_MS ? rt : 0;
  if (!local && !remote) return null;
  const name = String(info.name || "").slice(0, 60);
  const joiner = local && byRemote(local);
  if (local >= remote && joiner) return { who: cleanName(joiner), local: false, name };
  return local >= remote ? { who: host, local: true, name } : { who: cleanName(info.rw), local: false, name };
}

// The person a field (a Playwright locator) belongs to now, or null. hudKey: the page script's
// name and key (daemon/hud.mjs).
// A page too busy to answer in time is asked again; a field whose owner still can't be read is
// never taken for nobody's: { unknown: true } (the caller waits instead of typing over a person).
export async function ownerOf(locator, hudKey, opts) {
  const read = () => locator.evaluate((el, [n, k]) => window[n]?.(k, el, "owned"), hudKey).then((v) => ({ v }), () => ({ v: null, gone: true }));
  let r = await within(READ_MS, read());
  if (!r) { opts?.log?.(`field owner check took over ${READ_MS} ms; asking again`); r = await within(READ_MS * 2, read()); }
  if (!r) return { unknown: true };
  return fieldOwner(r.v, opts);
}

// The note an agent gets for a field it left alone.
export const leftAlone = (owner, label) => `${owner.who} is filling ${label || owner.name || "that field"}; left it as they wrote it.`;
