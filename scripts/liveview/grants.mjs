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
// tabs only, and two events of its own: turn ({ id, action, host, expiresAt, scope, state,
// savedCard }) and, when the grant ends, turn-ended ({ reason }), after which the stream closes.
//
// "Fill saved card" (spec server-mode B12): in a session whose browser has a saved card on, the
// viewer offers it (savedCard in the turn event), and its tap (POST turn-fill-card) sends ArrowDown
// then Enter as the person's own input, through the same queue and checks as their typing, only
// while a scope tab is on screen and its focused field is an empty card number field (autocomplete
// cc-number, or the first text field of a card or payment frame that has no cc-number field), so
// the browser's autofill list picks the card. The helper can't see that list (it is the browser's
// own window); it opens on an empty field, so from a field holding text, or another field of the
// form, the Enter could send it instead: those are refused. No agent tool reaches it; the
// card itself never passes through here (the browser fills it), and the log names the grant only.
//
// The option list (liveview/options.mjs): an open select list never reaches the picture, so after
// a tap the viewer asks (POST turn-options) and gets the focused select's options, and the person's
// choice (POST turn-pick) goes as their own arrow keys and Enter while the page's list is open, or
// is set on that same select while it is closed.
import { readFileSync } from "node:fs";
import { validName } from "../sessions.mjs";
import { ownTitle } from "../daemon/tablabels.mjs";
import { actionSentence, clock } from "../daemon/notify/message.mjs";
import { stripText } from "../sharing/join.mjs";
import { within } from "../util.mjs";
import { focusedFillField } from "../runner/cards.mjs";
import { SIGNALS } from "../rules/cards.mjs";
import { focusedSelect, chooseInPage, listOf, pickKeys, OPTION_WORDS } from "./options.mjs";
import { sse, json, plain, originOk, pathParts, SECURITY_HEADERS, VIEWER_CSP } from "./http.mjs";
import { hostOf, guestTabs, guestActivity } from "./tabs.mjs";

export const TURN_ROLES = new Set(["turn", "redeem"]);
const OPENER_MS = 1000; // asking a new tab which tab opened it
// How long a handed-over tab's close waits to see whether its browser is closing too (a crash, a
// lost screen): the browser's own close then ends the hand-off "browser-restarted", which keep-alive
// reissues once the tab is back (daemon/yourturn.mjs recover), never "tab-closed". The engine closes
// every tab before the browser's own close is heard, all in the same moment.
export const TAB_CLOSE_SETTLE_MS = 1000;
const RUN = /^[0-9a-f]{16}$/; // a turn viewer's page load, as its input batches name it
const RUNS_MAX = 8; // page loads remembered per hand-off
const LABEL = "Hand-off"; // the participant list's name for the person on a hand-off link
const landingHtml = readFileSync(new URL("../liveview-redeem.html", import.meta.url), "utf8");
const attr = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// The fields "Fill saved card" works from: the card number, or a field of a card or payment frame
// (fillProblem says which of that frame's fields).
const NUMBER = SIGNALS.token("cc-number");
const FILL_FROM = new Set([NUMBER, SIGNALS.cardFrame, SIGNALS.payFrame]);
// The person's own keys that open the autofill list on that field and pick its first card.
const FILL_KEYS = [{ type: "key", key: "ArrowDown", modifiers: 0 }, { type: "key", key: "Enter", modifiers: 0 }];
export const FILL_CARD_WORDS = {
  off: "This browser has no saved card to fill. Type the card's details by hand.",
  away: "That tab isn't on screen. Go back to the hand-off's tab.",
  field: "Tap the card number field in the picture first, then Fill saved card.",
  filled: "The card number field already holds something. Clear it first, then Fill saved card.",
  again: "Filled a moment ago. Check the picture; tap Fill saved card again only if nothing changed.",
};
// Why "Fill saved card" can't go from the focused field (runner/cards.mjs focusedFillField's
// answer, or null when unread): a FILL_CARD_WORDS key, or null. Enter goes only from an empty card
// number field: autocomplete cc-number, or in a card or payment frame without one the frame's first
// text field. From anything else the autofill list may not be open and the Enter would reach the page.
export function fillProblem(f) {
  if (!f || !FILL_FROM.has(f.signal)) return "field";
  if (f.signal !== NUMBER && (f.numberElsewhere !== false || f.first !== true)) return "field";
  if (f.empty !== true) return "filled";
  return null;
}
// A second tap this soon is a repeat (a lost answer, a double tap): its Enter could send the form.
const FILL_GAP_MS = 4000;
const FOCUS_MS = 8000; // reading the focused field (its frame, value and card signal; each read bounded too)

// grants: the grant table (daemon/grants.mjs createGrants), or null (no hand-off: nothing matches).
// sessionName(): the session open now. idOf(page): the live view's tab ids. getContext(): the
// browser context. cast: the picture (liveview/cast.mjs). linkGuests, clients, viewers: the live
// view's streams. inviteOrigin: inviteBaseUrl's origin, or null. invites: the invite store (its
// revoke_all ends every grant too). onChanged(): who is watching changed. log(...): daemon.log.
// savedCard(): whether the browser has a saved card on (B12). humanPost(route, events, role, who,
// id): the live view's queue for a person's input (liveview.mjs). focused(page): the focused
// field as runner/cards.mjs focusedFillField reads it (tests). select(page): the focused select as
// liveview/options.mjs focusedSelect reads it, choose(page, index, count): chooseInPage (tests).
export function createTurnGate({ grants = null, sessionName, idOf, getContext, cast, linkGuests, clients, viewers, inviteOrigin = null, invites = null, onChanged = () => {}, log = () => {},
  savedCard = () => false, humanPost = async () => {}, focused = (page) => focusedFillField(page), select = (page) => focusedSelect(page), choose = (page, index, count) => chooseInPage(page, index, count), now = Date.now }) {
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
    return { id: v.id, action: v.action, host: hostOf(v.page.url()), expiresAt: v.expiresAt, scope, state: onScreen(guest) ? "on" : "off", savedCard: savedCard() === true };
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

  // A turn viewer's input batches carry ?run=<its page load, 16 hex>&seq=<1, 2, ...>: a batch sent
  // again because its answer was lost (the phone's connection dropped mid-request) is one already
  // replayed, never replayed twice. A batch without them is always fresh. Kept per run (two pages
  // on one view key never mix their numbers), a batch counts only once it was replayed (one that
  // failed goes again), and one still being replayed when it comes again is answered busy.
  // Returns { repeat } (answer it, replay nothing), { busy } (answer 503: sent again later), or
  // { end(ok) } to call once the batch was replayed (ok) or not.
  const batches = new Map(); // grant id -> Map(run -> { seq: the last replayed, busy: one in flight or 0 })
  function batchOf(guest, req) {
    const q = new URL(req.url, "http://x").searchParams;
    const run = q.get("run") || "", seq = Number(q.get("seq"));
    if (!RUN.test(run) || !Number.isSafeInteger(seq) || seq < 1) return { end() {} };
    const id = grantOf(guest);
    if (!batches.has(id)) batches.set(id, new Map());
    const runs = batches.get(id);
    let b = runs.get(run);
    if (!b) {
      // A few page loads per hand-off (a reload, a second device); the oldest one goes first.
      if (runs.size >= RUNS_MAX) runs.delete(runs.keys().next().value);
      runs.set(run, (b = { seq: 0, busy: 0 }));
    }
    if (seq <= b.seq) return { repeat: true };
    if (b.busy === seq) return { busy: true };
    b.busy = seq;
    return { end(ok) { if (b.busy === seq) b.busy = 0; if (ok) b.seq = Math.max(b.seq, seq); } };
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
  // pop-up); any tab closing leaves every scope, the handed-over one ending its grant (after
  // TAB_CLOSE_SETTLE_MS, unless its browser's close ended it first). Tabs open
  // before the watch began are not asked: a pop-up opened before the hand-off isn't in it.
  function tabClosed(page) {
    if (!grants.handedOver?.(page)) return grants.closed(page);
    const t = setTimeout(() => grants.closed(page), TAB_CLOSE_SETTLE_MS);
    t.unref?.();
  }
  async function opened(page) {
    page.once?.("close", () => tabClosed(page));
    const opener = await within(OPENER_MS, Promise.resolve().then(() => page.opener()).catch(() => null));
    if (opener && grants.addToScope(opener, page)) changed().catch(() => {});
  }
  async function watch() {
    if (!grants) return;
    const ctx = await getContext();
    if (!ctx || watched.has(ctx)) return;
    watched.add(ctx);
    for (const p of ctx.pages()) p.once?.("close", () => tabClosed(p));
    ctx.on?.("page", (p) => { opened(p).catch((e) => log("turn opener", e?.message || e)); });
  }

  // Each tick while a grant is open: a session switched ends its grants, new tabs are watched.
  async function tick() {
    if (!grants || !grants.open().length) return;
    const session = sessionName();
    if (validName(session)) grants.endWhere((v) => v.session !== session, "session-switched");
    await watch();
  }

  // A grant ended: its stream hears why and closes; the picture is free to follow again, for
  // whoever still watches (with nobody watching, the stream's close stops the picture: stopIfIdle).
  const stopEnd = grants ? grants.onEnd((v, reason) => {
    batches.delete(v.id);
    filled.delete(v.id);
    let any = false;
    for (const [res, s] of streams) {
      if (s.guest.grant !== v.id) continue;
      streams.delete(res);
      s.stream.close();
      linkGuests.delete(res); clients.delete(res); viewers.delete(res);
      if (!res.destroyed) { res.write(sse("turn-ended", { reason })); res.end(); }
      any = true;
    }
    if (any) { onChanged(); if (viewers.size) cast.follow().catch(() => {}); }
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
  // "Fill saved card" (B12): ArrowDown then Enter as the person's own input into the focused, empty
  // card number field of the scope tab on screen. 409 with a sentence when there is no saved card,
  // no scope tab on screen (audited as any out-of-scope input), or no such field has the focus
  // (fillProblem: another field, one holding text, or one the page didn't answer for in time).
  const filled = new Map(); // grant id -> when its last fill went (a repeat within FILL_GAP_MS is refused)
  async function fillCard(res, guest) {
    if (savedCard() !== true) return json(res, 409, { error: FILL_CARD_WORDS.off });
    const id = grantOf(guest);
    if (now() - (filled.get(id) ?? -Infinity) < FILL_GAP_MS) return json(res, 409, { error: FILL_CARD_WORDS.again });
    if (!onScreen(guest)) { grants.refused(id, "input-refused", "out-of-scope"); return json(res, 409, { error: FILL_CARD_WORDS.away }); }
    const page = cast.state.shown?.page;
    const field = await within(FOCUS_MS, Promise.resolve().then(() => focused(page)).catch(() => null));
    const problem = fillProblem(field);
    if (problem) return json(res, 409, { error: FILL_CARD_WORDS[problem] });
    filled.set(id, now());
    await humanPost("input", FILL_KEYS.map((k) => ({ ...k })), "turn", `${LABEL} (by hand)`, guest.id);
    log(`hand-off ${id}: Fill saved card`);
    json(res, 200, { ok: true });
  }

  // The option list: the focused select of the scope tab on screen ({ options: null } when there
  // is none), and the person's choice of one, as their own keys. 409 with a sentence when no scope
  // tab is on screen (audited as any out-of-scope input), the select changed or lost the focus, the
  // option is disabled, or the page didn't take it.
  async function readSelect(res, guest) {
    if (!onScreen(guest)) { grants.refused(grantOf(guest), "input-refused", "out-of-scope"); json(res, 409, { error: OPTION_WORDS.away }); return undefined; }
    return within(FOCUS_MS, Promise.resolve().then(() => select(cast.state.shown?.page)).catch(() => null));
  }
  async function options(res, guest) {
    const sel = await readSelect(res, guest);
    if (sel !== undefined) json(res, 200, listOf(sel));
  }
  async function pick(res, guest, { index, count }) {
    const sel = await readSelect(res, guest);
    if (sel === undefined) return;
    const { keys, problem } = pickKeys(sel, index, count);
    if (problem) return json(res, 409, { error: OPTION_WORDS[problem] });
    const page = cast.state.shown?.page;
    let after = sel;
    if (keys) {
      // The list is open in the page: the person's own keys choose in it.
      await humanPost("input", keys, "turn", `${LABEL} (by hand)`, guest.id);
      after = await within(FOCUS_MS, Promise.resolve().then(() => select(page)).catch(() => null));
    } else if (await within(FOCUS_MS, Promise.resolve().then(() => choose(page, index, count)).catch(() => false))) {
      // A closed list: set on that same select (keys there would send the form or open a menu nobody sees).
      after = { ...sel, selected: index };
    }
    log(`hand-off ${grantOf(guest)}: chose from a list`);
    if (after?.selected !== index) return json(res, 409, { error: OPTION_WORDS.missed });
    json(res, 200, { ok: true });
  }

  // The viewer shows another of the grant's tabs; never one outside it.
  async function showTab(res, guest, id) {
    const page = scopeOf(guest).find((p) => idOf(p) === id);
    if (!page) return json(res, 409, { error: "That tab isn't part of this hand-off. Choose one of the hand-off's own tabs." });
    await cast.show(page);
    json(res, 200, { ok: true });
  }

  return {
    on: !!grants, match, refusedOrigin, forTurn, onScreen, batchOf, openStream, started, pinned, changed, tick, watch, landing, redeem, showTab, fillCard, options, pick,
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
