// Hand-off grants (spec server-mode B2, B3, B4): a short-lived, single-use way for the person to
// take one tab over from a phone. A grant is its own key table, apart from invites: it never
// becomes an invite, and an invite's key never matches here.
//
// Two keys (B3). mint() makes a 256-bit redeem key for the delivered link: matchRedeem(key) finds
// its grant without using it up (a link preview's GET, the landing page), redeem(key) uses it up
// once and hands out the view key, which then lives until the grant ends and holds one event
// stream at a time (openStream). The table keeps only SHA-256 hashes of keys, compared in constant
// time against every grant, and the redeem key itself only until it is used (the one reminder may
// carry the link again while it is unused). Hashes of used and ended keys stay until the grant's
// own expiry, so a key used again is audited as reuse and answered exactly as one never seen.
//
// Scope (B4). A grant belongs to one session and one page (the tab handed over); its scope is that
// page plus the tabs it opened while the grant was live (addToScope: a sign-in or 3-D Secure
// pop-up). Every match names the session open now: another one ends the grant. The grant ends on
// end(id, reason) (Done, a cleared check, the agent's next status, revoke, a browser restart, a
// helper stop: the reasons in END_REASONS), on its page closing (closed), or at its expiry, read on
// both the wall clock and a monotonic one as invites do, so a clock set back never stretches it.
// After a timeout the owner may hold the tab (hold): no grant, but agents keep out until release.
//
// Keys never leave this table except as mint's and redeem's answers: open(), the onEnd views,
// audit lines and log lines carry ids, sessions, pages and words only. Memory only: a helper
// restart ends every grant (the owner mints a replacement, B16).
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { validName } from "../sessions.mjs";
import { tabPlace } from "./audit.mjs";
import { ACTIONS, END_REASONS } from "./notify/message.mjs";

export const GRANT_MINUTES = { default: 15, min: 1, max: 120 };
const MINUTE_MS = 60_000;
const KEY = /^[0-9a-f]{64}$/;

const hashOf = (key) => createHash("sha256").update(key).digest();
// Whether given (any value) is the key whose hash is held, in constant time for a key-shaped value.
const sameKey = (given, held) => held !== null && timingSafeEqual(hashOf(given), held);
const urlOf = (page) => { try { return String(page.url()); } catch { return ""; } };

// now: the wall clock (expiresAt, as people read it); mono: a clock that never jumps. audit: the
// trail (daemon/audit.mjs createAudit) or null; log(line): ids and words only. timers: set and
// clear (tests): each grant ends on its own at its deadline, so a waiter wakes without a request.
export function createGrants({ now = () => Date.now(), mono = () => performance.now(), audit = null, log = () => {}, timers = { set: setTimeout, clear: clearTimeout } } = {}) {
  const live = new Map(); // id -> grant
  const spent = new Map(); // hex hash of a used or ended key -> { id, which, session, tab, expiresAt, monoEnd }
  const holds = new Map(); // page -> { session, id }
  const listeners = new Set(); // (view, reason) when a grant ends

  const tabOf = (page) => tabPlace(urlOf(page));
  const record = (kind, g, detail = null, page = g?.page) => {
    if (!audit) return;
    try { audit.append({ kind, grant: g?.id ?? null, session: g?.session ?? null, tab: page ? tabOf(page) : null, detail }); } catch {}
  };
  const view = (g) => ({
    id: g.id, session: g.session, action: g.action, page: g.page, scope: [...g.scope], createdAt: g.createdAt,
    expiresAt: g.expiresAt, redeemed: g.redeemed, streaming: g.streams > 0,
  });
  const over = (g, t = now(), m = mono()) => g.expiresAt <= t || g.monoEnd <= m;
  const keep = (hash, which, g) => {
    if (hash) spent.set(hash.toString("hex"), { id: g.id, which, session: g.session, tab: tabOf(g.page), expiresAt: g.expiresAt, monoEnd: g.monoEnd });
  };

  // The view handed to onEnd listeners is the grant as it was when it ended (redeemed or not).
  function finish(g, reason) {
    if (!live.delete(g.id)) return false;
    const v = view(g);
    keep(g.redeemHash, "redeem-key", g);
    keep(g.viewHash, "view-key", g);
    g.redeemKey = null; g.redeemHash = null; g.viewHash = null; g.streams = 0;
    if (g.timer) { try { timers.clear(g.timer); } catch {} g.timer = null; }
    record("ended", g, reason);
    log(`grants: ${g.id} ended (${reason})`);
    for (const w of g.waiters) w({ id: g.id, reason });
    g.waiters.clear();
    for (const fn of listeners) try { fn(v, reason); } catch {}
    return true;
  }

  function sweep() {
    const t = now(), m = mono();
    for (const g of [...live.values()]) if (over(g, t, m)) finish(g, "expired");
    for (const [h, s] of spent) if (s.expiresAt <= t || s.monoEnd <= m) spent.delete(h);
  }

  // A key used again (or after its grant ended) is audited as reuse, once per try.
  function reused(key) {
    const s = spent.get(hashOf(key).toString("hex"));
    if (!s) return;
    if (audit) try { audit.append({ kind: "reuse", grant: s.id, session: s.session, tab: s.tab, detail: s.which }); } catch {}
  }

  // The live grant whose key (redeem or view) is given, read against every grant so timing doesn't
  // tell which one came close. A grant of another session than the one open now ends; a caller
  // that names no session throws, so a missed argument never ends a grant.
  function find(given, fields, session) {
    if (!validName(session)) throw new Error("a grant key is matched against the session open now");
    sweep();
    if (typeof given !== "string" || !KEY.test(given)) return null;
    let found = null;
    for (const g of live.values()) for (const field of fields) if (sameKey(given, g[field])) found = g;
    if (!found) { reused(given); return null; }
    if (session !== found.session) { finish(found, "session-switched"); return null; }
    return found;
  }

  // The live grant whose scope holds page, if any (the newest when two do).
  function covering(page) {
    sweep();
    let found = null;
    for (const g of live.values()) if (g.scope.has(page)) found = g;
    return found;
  }

  return {
    // A new grant for page in session: { id, redeemKey, expiresAt }, the only time the redeem key
    // leaves the table. action: the step's kind (ACTIONS). minutes: its life (1 to 120, 15 when
    // left out), or expiresAt: the deadline of the link it replaces after a restart (B16, within
    // 120 minutes from now), with replacement: true. A grant already open on that page ends
    // ("agent": the agent's next status), the page leaves any other grant's scope (a pop-up handed
    // over on its own) and a hold there is released, so a tab has one grant at a time. Throws on a
    // bad argument.
    mint({ session, page, action, minutes, expiresAt, replacement = false } = {}) {
      sweep();
      if (!validName(session)) throw new Error("mint needs the session's name");
      if (!page || typeof page !== "object") throw new Error("mint needs the page handed over");
      if (!ACTIONS.includes(action)) throw new Error(`action must be one of ${ACTIONS.join(", ")}`);
      const createdAt = now();
      let end;
      if (expiresAt !== undefined && expiresAt !== null) {
        end = Number(expiresAt);
        if (!Number.isFinite(end) || end <= createdAt) throw new Error("expiresAt has passed");
        if (end - createdAt > GRANT_MINUTES.max * MINUTE_MS) throw new Error(`a grant lasts at most ${GRANT_MINUTES.max} minutes`);
      } else {
        const m = minutes === undefined || minutes === null ? GRANT_MINUTES.default : Number(minutes);
        if (!Number.isInteger(m) || m < GRANT_MINUTES.min || m > GRANT_MINUTES.max) throw new Error(`minutes must be a whole number from ${GRANT_MINUTES.min} to ${GRANT_MINUTES.max}`);
        end = createdAt + m * MINUTE_MS;
      }
      for (const g of [...live.values()]) {
        if (g.page === page) finish(g, "agent");
        else g.scope.delete(page);
      }
      holds.delete(page);
      let id;
      do id = randomBytes(4).toString("hex"); while (live.has(id));
      const redeemKey = randomBytes(32).toString("hex");
      const g = {
        id, session, action, page, scope: new Set([page]), createdAt, expiresAt: end, monoEnd: mono() + (end - createdAt),
        redeemKey, redeemHash: hashOf(redeemKey), redeemed: false, viewHash: null, streams: 0, waiters: new Set(), timer: null,
      };
      live.set(id, g);
      g.timer = timers.set(sweep, end - createdAt + 50);
      g.timer?.unref?.();
      record("minted", g, replacement ? [action, "replacement"] : action);
      log(`grants: ${id} minted (${action}${replacement ? ", replacement" : ""})`);
      return { id, redeemKey, expiresAt: end };
    },
    // The grant a redeem key belongs to, unused, without using it (the landing page), or null.
    matchRedeem(key, { session } = {}) { const g = find(key, ["redeemHash"], session); return g ? view(g) : null; },
    // Either key in one pass (the live view's dispatcher): { role: "redeem" | "turn", view }, or
    // null, a used key audited once as reuse.
    match(key, { session } = {}) {
      const g = find(key, ["redeemHash", "viewHash"], session);
      return g ? { role: sameKey(key, g.redeemHash) ? "redeem" : "turn", view: view(g) } : null;
    },
    // Uses the redeem key up: { id, viewKey, view } once, then null for that key (audited as reuse).
    redeem(key, { session } = {}) {
      const g = find(key, ["redeemHash"], session);
      if (!g) return null;
      keep(g.redeemHash, "redeem-key", g);
      g.redeemKey = null; g.redeemHash = null; g.redeemed = true;
      const viewKey = randomBytes(32).toString("hex");
      g.viewHash = hashOf(viewKey);
      record("redeemed", g);
      log(`grants: ${g.id} redeemed`);
      return { id: g.id, viewKey, view: view(g) };
    },
    // The grant a view key belongs to, or null.
    matchView(key, { session } = {}) { const g = find(key, ["viewHash"], session); return g ? view(g) : null; },
    // A live grant's stream, input or other request refused by the live view (audit
    // stream-refused, input-refused or request-refused, detail from the audit's words): whether
    // the grant is live.
    refused(id, kind, detail) {
      const g = live.get(String(id ?? ""));
      if (!g || !["stream-refused", "input-refused", "request-refused"].includes(kind)) return false;
      record(kind, g, detail);
      return true;
    },
    // The redeem key while it is unused (the one reminder carries the link again), else null.
    redeemKey(id) { sweep(); return live.get(String(id ?? ""))?.redeemKey ?? null; },
    // The grant's one event stream: { close() } while none is open, else null (audited). A
    // dropped stream closes and the same device reconnects with the same view key.
    openStream(id) {
      sweep();
      const g = live.get(String(id ?? ""));
      if (!g || g.viewHash === null) return null;
      if (g.streams > 0) { record("stream-refused", g, "second-stream"); return null; }
      g.streams = 1;
      let open = true;
      return { close() { if (open) { open = false; if (live.get(g.id) === g) g.streams = 0; } } };
    },
    // Whether page is in a live grant's scope (that grant's, with id).
    inScope(page, id) {
      if (id === undefined) return covering(page) !== null;
      sweep();
      return live.get(String(id ?? ""))?.scope.has(page) === true;
    },
    // The live grant whose scope holds page, as open() lists it, or null.
    forPage(page) { const g = covering(page); return g ? view(g) : null; },
    // A tab opened by opener joins the scope of the grant opener is in; answers that grant's id or null.
    addToScope(opener, page) {
      if (!page || typeof page !== "object") return null;
      const g = opener ? covering(opener) : null;
      if (!g) return null;
      g.scope.add(page);
      return g.id;
    },
    // Whether a live grant handed page over (its own tab, not one that joined its scope).
    handedOver(page) { return [...live.values()].some((g) => g.page === page); },
    // A tab closed: the grant handed it over ends ("tab-closed"); it leaves every other scope.
    closed(page) {
      for (const g of [...live.values()]) {
        if (g.page === page) finish(g, "tab-closed");
        else g.scope.delete(page);
      }
      holds.delete(page);
    },
    end(id, reason) {
      if (!END_REASONS.includes(reason)) throw new Error(`reason must be one of ${END_REASONS.join(", ")}`);
      const g = live.get(String(id ?? ""));
      return g ? finish(g, reason) : false;
    },
    // Ends every live grant test(view) is true for (a session switched, the helper stopping): how many.
    endWhere(test, reason) {
      if (!END_REASONS.includes(reason)) throw new Error(`reason must be one of ${END_REASONS.join(", ")}`);
      let n = 0;
      for (const g of [...live.values()]) if (test(view(g)) && finish(g, reason)) n++;
      return n;
    },
    // After a timeout the tab stays held (B11): no keys, but agents keep out.
    hold(page, { session, id = null } = {}) {
      if (!page || typeof page !== "object") throw new Error("hold needs the page");
      if (!validName(session)) throw new Error("hold needs the session's name");
      holds.set(page, { session, id });
    },
    held(page) { return holds.has(page); },
    // Lets a held tab go: a page, or { session } for every held tab of that session. How many.
    release(target) {
      if (target && typeof target === "object" && typeof target.session === "string" && !holds.has(target)) {
        let n = 0;
        for (const [page, h] of holds) if (h.session === target.session) { holds.delete(page); n++; }
        return n;
      }
      return holds.delete(target) ? 1 : 0;
    },
    // The live grants, without keys.
    open() { sweep(); return [...live.values()].map(view); },
    onEnd(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // A promise of { id, reason } when the grant covering page ends, or null when none does now
    // (browser_wait_for races it, B15).
    ended(page) {
      const g = covering(page);
      if (!g) return null;
      return new Promise((resolve) => g.waiters.add(resolve));
    },
    sweep,
  };
}
