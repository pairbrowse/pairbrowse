// Agents that go and come back. A closed connection stops showing at once (collaboration.mjs
// hide; when an agent shows at all: untilSeen there), but what lets the same app session come
// back as itself, its label, color and tab, is held for GRACE_MS (a bridge restarted, the socket
// dropped) and handed to the connection that resumes it; after that its tab is released.
import { testMs } from "../../testenv.mjs";

export const GRACE_MS = testMs("RESUME_GRACE_MS", 10_000);

// The same app session, across its connections: the app and the process that started its bridge
// (launch.mjs sends it). Never a joiner's agent's, nor one without a known process.
export function resumeKey(clientName, parent, remote = false) {
  const pid = Number(parent);
  if (remote || !clientName || !Number.isSafeInteger(pid) || pid <= 1) return "";
  return `${String(clientName).slice(0, 60)}|${pid}`;
}

// hold(key, identity, finish): a closed connection's identity, kept graceMs, then finish() (what
// releases it for good). Without a key it finishes at once. take(key): the identity held under
// key (its timer stopped), or null; the caller adopts it and then calls its finish().
export function createDepartures({ graceMs = GRACE_MS, log = () => {} } = {}) {
  const held = new Map(); // key -> { identity..., finish, timer }
  const run = (fn) => { try { fn(); } catch (e) { log("departure", e?.message || e); } };
  return {
    hold(key, identity, finish) {
      if (!key) return run(finish);
      const prev = held.get(key);
      if (prev) { clearTimeout(prev.timer); held.delete(key); run(prev.finish); }
      const timer = setTimeout(() => { if (held.get(key)?.timer === timer) held.delete(key); run(finish); }, graceMs);
      timer.unref?.();
      held.set(key, { ...identity, finish, timer });
    },
    take(key) {
      const e = key ? held.get(key) : null;
      if (!e) return null;
      held.delete(key);
      clearTimeout(e.timer);
      return e;
    },
    size: () => held.size,
  };
}
