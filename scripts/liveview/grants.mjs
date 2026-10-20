// The live view's side of hand-off grants (spec server-mode B3, B4, B5, B8): which key is a
// grant's, the landing page a delivered link opens, the one stream a view key holds, and what that
// stream gets. The grant table itself (keys, scope, expiry, audit) is daemon/grants.mjs.
//
// A grant's keys work on the owner's port only (never the join-code port), under a loopback name or
// a liveViewHosts name, as invite links do, and from the page's own origin or inviteOrigin only. The
// redeem key (role "redeem") reaches the landing page and its "Take over" POST; the view key (role
// "turn") reaches the viewer, its stream, pictures, state, input and the turn routes. Every match
// names the session open now (another one ends the grant).
//
// The view key's stream: one at a time; while it is open the picture is pinned to the grant's
// scope (cast.mjs pinned). It gets frames of scope tabs only, as they are (the person must see the
// card field they type into; every other guest keeps covers), the tab list and activity of scope
// tabs only, and two events of its own: turn ({ id, action, host, expiresAt, scope, state }) and,
// when the grant ends, turn-ended ({ reason }), after which the stream closes.
import { readFileSync } from "node:fs";
import { validName } from "../sessions.mjs";
import { ownTitle } from "../daemon/tablabels.mjs";
import { actionSentence, clock } from "../daemon/notify/message.mjs";
import { stripText } from "../sharing/join.mjs";
import { within } from "../util.mjs";
import { sse, json, plain, originOk, pathParts, SECURITY_HEADERS, VIEWER_CSP } from "./http.mjs";
import { hostOf, guestTabs, guestActivity } from "./tabs.mjs";

export const TURN_ROLES = new Set(["turn", "redeem"]);
const OPENER_MS = 1000; // asking a new tab which tab opened it
const LABEL = "Hand-off"; // the participant list's name for the person on a hand-off link
const landingHtml = readFileSync(new URL("../liveview-redeem.html", import.meta.url), "utf8");
const attr = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// grants: the grant table (daemon/grants.mjs createGrants), or null (no hand-off: nothing matches).
// sessionName(): the session open now. idOf(page): the live view's tab ids. getContext(): the
// browser context. cast: the picture (liveview/cast.mjs). linkGuests, clients, viewers: the live
// view's streams. inviteOrigin: inviteBaseUrl's origin, or null. invites: the invite store (its
// revoke_all ends every grant too). onChanged(): who is watching changed. log(...): daemon.log.
export function createTurnGate({ grants = null, sessionName, idOf, getContext, cast, linkGuests, clients, viewers, inviteOrigin = null, invites = null, onChanged = () => {}, log = () => {} }) {
  const streams = new Map(); // event stream -> { guest, stream, sig }
  const watched = new WeakSet(); // browser contexts whose new tabs are checked for their opener

  const guestOf = (role, id) => ({ id: `${role}-${id}`, grant: id, role, label: LABEL });
  const grantOf = (x) => (typeof x === "string" ? x.replace(/^(turn|redeem)-/, "") : x?.grant ?? null);
  const viewOf = (x) => { const id = grantOf(x); return grants?.open().find((g) => g.id === id) || null; };
  const scopeOf = (x) => (viewOf(x)?.scope || []).filter((p) => !p.isClosed?.());
  const inScope = (page, x) => !!page && !!grants && grants.inScope(page, grantOf(x));
  const onScreen = (x) => inScope(cast.state.shown?.page, x);

  // A key that is a live grant's, for the session open now: the guest a request acts as, or null.
  function match(given) {
    const session = sessionName();
    if (!grants || !validName(session)) return null;
    const m = grants.match(given, { session });
    return m ? guestOf(m.role, m.view.id) : null;
  }

  // A request on a grant key from another site (a page that learned the link and posts to it, or
  // holds its one stream): refused and audited. No Origin (a same-origin GET) passes.
  function refusedOrigin(guest, req) {
    if (!guest || !TURN_ROLES.has(guest.role)) return false;
    const origin = req.headers.origin;
    if (!origin || originOk(origin) || (inviteOrigin && origin === inviteOrigin)) return false;
    const { route } = pathParts(req);
    const kind = req.method !== "GET" ? "input-refused" : guest.role === "turn" && route === "events" ? "stream-refused" : "request-refused";
    grants.refused(guest.grant, kind, req.method === "GET" ? "other-origin" : "not-allowed");
    return true;
  }

  // What a turn stream gets of an event the guests get: tabs and activity of scope tabs only.
  function forTurn(event, data, guest) {
    // By each tab's own id, never its number: a tab closing while the list was built shifts them.
    if (event === "tabs" && Array.isArray(data)) {
      const ids = new Set(scopeOf(guest).map(idOf));
      return guestTabs(data.filter((t) => t.id && ids.has(t.id)));
    }
    if (event === "activity" && Array.isArray(data)) {
      const ids = new Set(scopeOf(guest).map(idOf));
      return guestActivity(data.filter((a) => a.tabId && ids.has(a.tabId)));
    }
    return data;
  }

  // The turn event: the step, its site, when it ends, the scope's tabs and whether one is on screen.
  async function turnState(guest) {
    const v = viewOf(guest);
    if (!v) return null;
    const shown = cast.state.shown?.page;
    const scope = await Promise.all(scopeOf(guest).map(async (p) => ({ id: idOf(p), title: stripText(await ownTitle(p)), host: hostOf(p.url()), shown: p === shown })));
    return { id: v.id, action: v.action, host: hostOf(v.page.url()), expiresAt: v.expiresAt, scope, state: onScreen(guest) ? "on" : "off" };
  }
  // Each turn stream hears its state again when it changed (a tab shown, a pop-up joining).
  async function changed() {
    for (const [res, s] of streams) {
      const state = await turnState(s.guest).catch(() => null);
      const sig = JSON.stringify(state);
      if (!state || sig === s.sig || res.destroyed || !streams.has(res)) continue;
      s.sig = sig;
      res.write(sse("turn", state));
    }
  }

  // The view key's one stream: true when it opened (else a second one is open, audited by the
  // table). It closes when the request does; the picture moves to the grant's tab.
  function openStream(res, guest) {
    const stream = grants?.openStream(guest.grant);
    if (!stream) return false;
    streams.set(res, { guest, stream, sig: "" });
    res.once("close", () => { stream.close(); streams.delete(res); });
    return true;
  }
  // After the stream's first events: the picture on the grant's tab, the turn event, new tabs watched.
  async function started(res, guest) {
    await watch();
    const pin = scopeOf(guest);
    if (pin.length && !onScreen(guest)) await cast.show(pin[0]);
    const state = await turnState(guest);
    const s = streams.get(res);
    if (state && s && !res.destroyed) { s.sig = JSON.stringify(state); res.write(sse("turn", state)); }
  }

  // The tabs the picture is held to while a turn stream is open: each such grant's scope.
  function pinned() {
    if (!streams.size) return null;
    return [...new Set([...streams.values()].flatMap((s) => scopeOf(s.guest)))];
  }

  // A tab opened by a scope tab while the grant is live joins the scope (a sign-in or 3-D Secure
  // pop-up); any tab closing leaves every scope, the handed-over one ending its grant. Tabs open
  // before the watch began are not asked: a pop-up opened before the hand-off isn't in it.
  async function opened(page) {
    page.once?.("close", () => grants.closed(page));
    const opener = await within(OPENER_MS, Promise.resolve().then(() => page.opener()).catch(() => null));
    if (opener && grants.addToScope(opener, page)) changed().catch(() => {});
  }
  async function watch() {
    if (!grants) return;
    const ctx = await getContext();
    if (!ctx || watched.has(ctx)) return;
    watched.add(ctx);
    for (const p of ctx.pages()) p.once?.("close", () => grants.closed(p));
    ctx.on?.("page", (p) => { opened(p).catch((e) => log("turn opener", e?.message || e)); });
  }

  // Each tick while a grant is open: a session switched ends its grants, new tabs are watched.
  async function tick() {
    if (!grants || !grants.open().length) return;
    const session = sessionName();
    if (validName(session)) grants.endWhere((v) => v.session !== session, "session-switched");
    await watch();
  }

  // A grant ended: its stream hears why and closes; the picture is free to follow again.
  const stopEnd = grants ? grants.onEnd((v, reason) => {
    let any = false;
    for (const [res, s] of streams) {
      if (s.guest.grant !== v.id) continue;
      streams.delete(res);
      s.stream.close();
      linkGuests.delete(res); clients.delete(res); viewers.delete(res);
      if (!res.destroyed) { res.write(sse("turn-ended", { reason })); res.end(); }
      any = true;
    }
    if (any) { onChanged(); cast.follow().catch(() => {}); }
  }) : () => {};
  // pairbrowse_invite revoke_all calls every link off, hand-offs too.
  const stopRevokeAll = grants && invites?.onRevokeAll ? invites.onRevokeAll(() => grants.endWhere(() => true, "revoked")) : () => {};

  // The landing page a delivered link opens (B-AP1): the step, its site and when the link ends,
  // and "Take over". Serving it uses nothing up, so a chat app's link preview is harmless.
  function landing(req, res, guest) {
    const v = viewOf(guest);
    if (!v) return plain(res, 404);
    const path = String(req.url).split("?")[0];
    if (!path.endsWith("/")) { res.writeHead(308, { ...SECURITY_HEADERS, location: `${path}/` }); return res.end(); }
    const host = hostOf(v.page.url()) || "a site";
    const fill = { sentence: actionSentence(v.action, host), expires: String(v.expiresAt), clock: clock(v.expiresAt) };
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": VIEWER_CSP });
    res.end(landingHtml.replace(/\{\{(sentence|expires|clock)\}\}/g, (_, k) => attr(fill[k])));
  }
  // The tap: uses the redeem key up and answers where the viewer is (the view key's address).
  function redeem(req, res) {
    const session = sessionName();
    const r = validName(session) ? grants.redeem(pathParts(req).key, { session }) : null;
    if (!r) return json(res, 404, { error: "This hand-off link was used already or has ended. Ask for a new one if the step is still open." });
    json(res, 200, { view: `/${r.viewKey}/` });
  }
  // The viewer shows another of the grant's tabs; never one outside it.
  async function showTab(res, guest, id) {
    const page = scopeOf(guest).find((p) => idOf(p) === id);
    if (!page) return json(res, 409, { error: "That tab isn't part of this hand-off. Choose one of the hand-off's own tabs." });
    await cast.show(page);
    json(res, 200, { ok: true });
  }

  return {
    on: !!grants, match, refusedOrigin, forTurn, onScreen, openStream, started, pinned, changed, tick, watch, landing, redeem, showTab,
    // The last frame, for a turn stream that just opened: only from a scope tab, as it is.
    frameFor: (guest) => (cast.state.lastFrame && inScope(cast.state.lastFrameFrom, guest) ? cast.state.lastFrame : null),
    // Whether a stream gets a frame of the tab on screen as it is: a turn stream, that tab in its scope.
    frameTo: (res) => { const g = linkGuests.get(res); return g?.role === "turn" && inScope(cast.state.lastFrameFrom, g); },
    // The page a turn viewer's still comes from: the shown tab in scope, the grant's tab when none
    // is shown, or null when another tab is on screen.
    stillOf: (guest) => (cast.state.shown ? (onScreen(guest) ? cast.state.shown.page : null) : scopeOf(guest)[0] || null),
    refused: (guest, kind, detail) => grants?.refused(grantOf(guest), kind, detail),
    end: (guest, reason) => !!grants && grants.end(grantOf(guest), reason),
    close() { stopEnd(); stopRevokeAll(); for (const s of streams.values()) s.stream.close(); streams.clear(); },
  };
}
