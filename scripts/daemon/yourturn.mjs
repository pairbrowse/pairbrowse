// Hand-offs to the person (spec server-mode B7, B10, B11, decision 8): an agent's "you"
// (pairbrowse_status), a fast-mode run's hand-off step and a CAPTCHA PairBrowse saw. Each shows as
// today in the PairBrowse window (the badge, the Tools tab's Hand-offs, a notification); that never
// changes. When hand-offs go to the person's channels (handoff.enabled, and server mode or the Away
// switch: notify/index.mjs handoffSends), the step also gets a grant (daemon/grants.mjs) and its
// link goes to those channels (notify/): the person takes over from a phone, or in the window,
// whichever they use first.
//
// A grant's life here: minted for the agent's tab (its spark tab, else the tab it acts in) or the
// check's page; one message to the channels (the step's kind, the site's host, the expiry, the
// link: never the agent's words); exactly one reminder (with the link while it is unused); and its
// end. The agent's next status ends it ("agent"), a check that clears ends PairBrowse's own
// ("cleared"), and the step done in the window before anyone took the link over ends it too
// ("window", watchWindow). At its expiry (B11), in order: the goal log's pending lines written, the session's
// tabs saved, "Not done in time" in the goal log's Your turn, one ended message, the badge and the
// Tools tab's entry say "Timed out", one host note for the agent, and the tab is held (agents keep
// out, daemon/serve/refuse.mjs tabRefusal) until a new "you", a person's own input in it, or the
// session's end. On every other end (B15) one host note names what the person did there (field and
// button names only) and says to take a snapshot, and a browser_wait_for or a fast-mode handoff
// step waiting on it wakes (ended).
//
// A restart (B16): each open hand-off is kept in the session's turn.json (0600: its kind, the tab's
// address, the deadline, whether it was reminded and the channels it went to; never a key or link).
// When the browser closes under keep-alive, its link is not said to be over: once the session's tabs
// are back (recover), the tab that came back gets one replacement grant with the same deadline and
// "The browser restarted; use this new link". After a helper restart the file does this once, before
// the deadline. Otherwise (no tab, no time left, no channel, or a crash loop that keeps the browser
// down) the ended message tells the person the step was stopped safely.
//
// While a grant is open on a tab, while it is held, and after it ended until that tab loads its next
// page (what the person typed is still in its fields), masked(page) is true: every agent's results
// from it are masked as a joiner's agent's are and its pictures covered (B10, serve/result.mjs).
// In a session whose browser has a saved card on (B12, savedCard()), that holds for every tab, not
// only during a hand-off: agents never read or see what autofill put in a page.
// Nothing typed by the person passes through here: messages and audit lines carry words from
// fixed lists, host notes and the goal log fixed sentences.
//
// Compatibility vs verification (B14): when a hand-off starts, the open compatibility items
// (compatibility(): the session's network verdict and the coherence items of its profile and exit,
// rules/coherence.mjs) are read and reported in two lists: "Site verification (yours to do)", the
// step handed over, and "PairBrowse setup problems (PairBrowse's to fix)", the items; in the
// status result for an agent's "you", in a host note for PairBrowse's own check. A setup problem
// never mints a grant or sends a message by itself and is never handed to the person to work
// around; a site's verification is handed over once and never retried here.
import { rmSync } from "node:fs";
import { readJson, sleep, within, writeJsonAtomic } from "../util.mjs";
import { handoffTimes } from "../config-schema.mjs";
import { CHALLENGE_TURN } from "../popups.mjs";
import { testMs } from "../testenv.mjs";
import { ACTIONS, actionSentence, clock } from "./notify/message.mjs";
import { handoffKind } from "./toolstab.mjs";
import { setupLines } from "../rules/coherence.mjs";

// How long pairbrowse_status waits for the channels' answers before saying the message is on its way.
export const REPORT_MS = 12_000;
// How long the helper's stop waits for the ended messages.
export const STOP_MS = 5000;
export const TIMED_OUT = "Timed out";
export const TIMEOUT_NOTE = "Nobody finished the step in time. Progress is saved. Stop here, tell the user where you are, and don't retry the step or work around it.";
const WAIT = "Don't act in this tab; wait with browser_wait_for.";
const MINUTE_MS = 60_000;
// What ended a hand-off, as the agent's note says it (B15).
const ENDED_BY = {
  done: "the person pressed Done", window: "the person did it in the PairBrowse window", cleared: "the check on the page cleared", agent: "your next status ended it",
  "tab-closed": "its tab closed", "session-switched": "the browser session changed", revoked: "it was called off",
  "browser-restarted": "the browser restarted", "helper-stopped": "PairBrowse stopped",
};
// Ends after which the hand-off may come back with a new link (B16): its turn.json entry stays.
const KEEP = new Set(["browser-restarted", "helper-stopped"]);
// A replacement needs at least this long left before the deadline.
const REISSUE_MIN_MS = 5000;
// A step done in the window: how long the person's own input there may take to be read after the
// page moved on (presence reads it from the page), in tries of WINDOW_READ_MS.
const WINDOW_READ_MS = 200, WINDOW_READ_TRIES = 15;
const KEY_SHAPE = /^(?:check|status:.{1,200}|run:.{1,200})$/;

// The site's host as a message carries it ("" for a page without one).
const hostOf = (page) => { try { const u = new URL(page.url()); return /^https?:$/.test(u.protocol) ? u.host.toLowerCase() : ""; } catch { return ""; } };
// A tab's number as browser_tabs lists it, or -1.
const tabNumber = (page) => { try { return page.context().pages().indexOf(page); } catch { return -1; } };
const urlOf = (page) => { try { return String(page.url()); } catch { return ""; } };
// The open tab at url: the same address, else the same origin and path.
function tabAt(pages, url) {
  const place = (u) => { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return null; } };
  const live = pages.filter((p) => !p.isClosed?.());
  return live.find((p) => urlOf(p) === url) || live.find((p) => place(urlOf(p)) !== null && place(urlOf(p)) === place(url)) || null;
}
// A turn.json entry as a helper wrote it, or null.
const entryOf = (e) => (e && typeof e === "object" && /^[0-9a-f]{8}$/.test(e.id) && typeof e.key === "string" && KEY_SHAPE.test(e.key) && ACTIONS.includes(e.action) &&
  typeof e.host === "string" && typeof e.url === "string" && Number.isInteger(e.expiresAt) && typeof e.reminded === "boolean" && Array.isArray(e.sent) && e.sent.every((x) => typeof x === "string")
  ? { id: e.id, key: e.key, action: e.action, host: e.host, url: e.url, expiresAt: e.expiresAt, reminded: e.reminded, sent: e.sent.slice(0, 8) } : null);

// config: the running config (handoff). grants: the grant table (daemon/grants.mjs). notifier: the
// channels (notify/index.mjs createNotifier). sends(): whether hand-offs go to the channels now
// (handoffSends with server mode). handoffs: the Tools tab's hand-offs (toolstab.mjs). journal: the
// goal log. saveTabs(): the session's tabs written now. hostNote(text): for the host's agent's next
// result. audit: the trail (audit.mjs) or null. hud: the badge. sessionName(): the session open now.
// linkFor(redeemKey): the hand-off link (the live view's address), or null. agentBy(p, color): an
// agent's { label, color } for the Tools tab. log(line): ids and words only. turnMs(): a grant's
// life in ms for tests (PAIRBROWSE_TEST_TURN_MS; its reminder at two thirds), 0 for config's minutes.
// timers, now: tests (now: the wall clock grants read too). turnFile(session): the session's
// turn.json (sessionFile), or null to keep nothing (B16). keptAlive(): whether the browser comes
// back by itself after a close (server.keepAlive). successorOf(page): the tab a closed one came back
// as. pagesNow(): the open tabs. actionsIn(page): what people did in a tab, names only (presence didIn).
// savedCard(): whether the running browser has a saved card on (context.savedCard, B12).
// personActedAt(page): when a person last clicked or typed in a tab by hand, no agent's or joiner's
// input (presence actedAt), 0 for never: a step done in the window (watchWindow).
export function createYourTurn({ config, grants, notifier, sends, handoffs, journal, saveTabs = async () => ({}), hostNote = () => {}, audit = null, hud, sessionName, linkFor = async () => null,
  agentBy = (p, color = "") => ({ label: "Agent", color }), log = () => {}, turnMs = () => testMs("TURN_MS", 0), timers = { set: setTimeout, clear: clearTimeout }, now = Date.now,
  turnFile = () => null, keptAlive = () => false, successorOf = () => null, pagesNow = async () => [], actionsIn = () => "", compatibility = () => [], savedCard = () => false, personActedAt = () => 0 }) {
  const turns = new Map(); // grant id -> { id, key, participant, page, action, host, session, expiresAt, sent, timer, reminded }
  // B16: grant id -> { entry (turn.json's), session, page, participant, waiting }: waiting, the
  // restart that ended it ("browser-restarted", "helper-stopped") while it may come back.
  const kept = new Map();
  const loaded = new Set(); // sessions whose turn.json this helper read (once each)
  const steps = new Map(); // participant -> the step kind its last "you" named (pairbrowse_status step)
  const pending = new Set(); // messages on their way (the helper's stop waits for them)
  let checkTimedOut = null; // { page, text }: PairBrowse's own check that timed out, held until it clears

  const record = (kind, t, detail = null) => {
    if (!audit) return;
    let tab = null;
    try { tab = t?.page ? String(t.page.url()) : null; } catch {}
    // One word as itself, as the grant table writes its own.
    const words = Array.isArray(detail) && detail.length === 1 ? detail[0] : detail;
    try { audit.append({ kind, grant: t?.id ?? null, session: t?.session ?? null, tab, detail: words }); } catch {}
  };
  // What the last helper left in the session's turn.json, read once (before this one writes it).
  function load(session) {
    if (loaded.has(session)) return;
    loaded.add(session);
    const file = turnFile(session);
    const saved = file ? readJson(file, null) : null;
    for (const raw of Array.isArray(saved?.turns) ? saved.turns.slice(0, 20) : []) {
      const entry = entryOf(raw);
      if (entry && !kept.has(entry.id)) kept.set(entry.id, { entry, session, page: null, participant: null, waiting: "helper-stopped" });
    }
  }
  // The session's open hand-offs into its turn.json (0600), or the file gone when there are none.
  function persist(session) {
    const file = session ? turnFile(session) : null;
    if (!file) return;
    load(session);
    const list = [...kept.values()].filter((k) => k.session === session).map((k) => k.entry);
    try {
      if (list.length) writeJsonAtomic(file, { v: 1, turns: list }, { mode: 0o600 });
      else rmSync(file, { force: true });
    } catch (e) { log(`hand-off: turn.json not written (${e?.code || "error"})`); }
  }
  const keep = (t) => {
    kept.set(t.id, { entry: { id: t.id, key: t.key, action: t.action, host: t.host, url: urlOf(t.page), expiresAt: t.expiresAt, reminded: t.reminded, sent: [...t.sent] }, session: t.session, page: t.page, participant: t.participant, waiting: null });
    persist(t.session);
  };

  // A message to the channels, kept track of until it is answered.
  const send = (message) => {
    const p = Promise.resolve().then(() => notifier.send(message)).catch((e) => ({ error: e?.code || "error" }));
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };
  // The channels' types a message reached, each once (two webhooks are one "webhook").
  const typesSent = (r) => [...new Set(r?.sent || [])];
  // Who sent what, in the trail: notified (or notify-failed) with the channels' types.
  const audited = (kind, t, r, extra = []) => {
    const sent = typesSent(r);
    if (sent.length) record(kind, t, [...sent, ...extra.filter((w) => !sent.includes(w))].slice(0, 8));
    if (r?.failed?.length) record("notify-failed", t, [...new Set(r.failed.map((f) => f.type))].slice(0, 8));
  };
  const lifeMs = () => {
    const ms = Number(turnMs()) || 0;
    return ms > 0 ? ms : null;
  };
  const remindMs = () => {
    const ms = lifeMs();
    if (ms) return Math.round(ms * 2 / 3);
    const h = config.handoff || {};
    return handoffTimes({ grantMinutes: Number(h.grantMinutes) || 15, remindMinutes: Number(h.remindMinutes) || 10 }).remindMinutes * MINUTE_MS;
  };

  // The one reminder: the link again while it is unused, else "opened already".
  async function remind(t) {
    if (!turns.has(t.id) || t.reminded) return;
    t.reminded = true;
    if (kept.has(t.id)) { kept.get(t.id).entry.reminded = true; persist(t.session); }
    const key = grants.redeemKey(t.id);
    const link = key ? await Promise.resolve().then(() => linkFor(key)).catch(() => null) : null;
    if (!turns.has(t.id)) return;
    const r = await send({ kind: "reminder", id: t.id, action: t.action, host: t.host, link, expiresAt: t.expiresAt });
    audited("reminded", t, r, [...(key ? [] : ["already-opened"]), ...(key && (!link || r?.withheld?.length) ? ["no-link"] : [])]);
    log(`hand-off ${t.id}: reminder ${r?.sent?.length ? "sent" : "not sent"}`);
  }

  // A new grant for a step and its message: { id, line } (line: what the status result says), or
  // null when hand-offs stay in the window. key: the Tools tab's key ("status:<p>", "run:<p>",
  // "check"). A replacement after a restart (B16): expiresAt, the lost link's deadline, and
  // reminded, whether its one reminder went already.
  async function start({ key, participant = null, page, action, expiresAt = null, reminded = false }) {
    if (!sends()) return null;
    if (!page || page.isClosed?.()) return { line: "Your turn shows in the PairBrowse window; there is no tab of yours to hand over to the user's phone." };
    // A message names the site's host: a tab on no site (about:blank, a file) stays in the window.
    if (!hostOf(page)) return { line: "Your turn shows in the PairBrowse window; this tab is on no website, so nothing is handed over to the user's phone." };
    if (!notifier.usable().length) {
      record("notify-failed", { page, session: sessionName() }, "no-channel");
      return { line: "Hand-offs are on, but no hand-off channel can be used (daemon.log names why): tell the user directly. They can do the step in the PairBrowse window." };
    }
    // The same key's earlier step on another tab is over: the agent (or the check) moved on.
    for (const t of [...turns.values()]) if (t.key === key && t.page !== page) grants.end(t.id, key === "check" ? "cleared" : "agent");
    const session = sessionName();
    let g;
    try {
      const ms = lifeMs();
      g = grants.mint({ session, page, action, ...(expiresAt ? { expiresAt, replacement: true } : ms ? { expiresAt: now() + ms } : { minutes: config.handoff?.grantMinutes }) });
    } catch (e) {
      log(`hand-off: no grant (${e?.message || e})`);
      return { line: "The hand-off link couldn't be made (daemon.log says why): tell the user directly. They can do the step in the PairBrowse window." };
    }
    const t = { id: g.id, key, participant, page, action, host: hostOf(page), session, expiresAt: g.expiresAt, sent: [], timer: null, reminded: !!reminded, since: Date.now(), unwatch: null };
    turns.set(t.id, t);
    watchWindow(t);
    keep(t);
    if (!t.reminded) {
      t.timer = timers.set(() => { remind(t).catch((e) => log(`hand-off reminder: ${e?.message || e}`)); }, Math.max(0, Math.min(remindMs(), g.expiresAt - now() - 1000)));
      t.timer?.unref?.();
    }
    const link = await Promise.resolve().then(() => linkFor(g.redeemKey)).catch(() => null);
    const message = { kind: "turn", id: t.id, action, host: t.host, link, expiresAt: t.expiresAt, ...(expiresAt ? { reason: "browser-restarted" } : {}) };
    const sending = send(message).then((r) => {
      t.sent = typesSent(r);
      if (kept.has(t.id)) { kept.get(t.id).entry.sent = [...t.sent]; persist(t.session); }
      audited("notified", t, r, !link || r?.withheld?.length ? ["no-link"] : []);
      return r;
    });
    const r = await within(REPORT_MS, sending);
    return { id: t.id, line: sentLine(t, r) };
  }

  // Done in the window (decision 8: the step stays the window's too, and whichever the person uses
  // first completes it): while nobody took the link over, the person acted in the tab by hand
  // (personActedAt: clicks and typing, never an agent's or a joiner's) and the tab then loaded its
  // next page, as the window's own "Claude continues when the page moves on" says. The grant ends
  // "window": the waiting agent goes on and the phone hears the link is over. After Take over the
  // person's taps move pages as part of the step, so only Done (or the agent) ends it.
  function watchWindow(t) {
    const page = t.page;
    const taken = () => !grants.redeemKey(t.id);
    const acted = () => (Number(personActedAt(page)) || 0) >= t.since;
    const onLoad = () => {
      if (!turns.has(t.id) || taken()) return;
      (async () => {
        for (let i = 0; i < WINDOW_READ_TRIES && !acted() && turns.has(t.id); i++) await sleep(WINDOW_READ_MS);
        if (acted() && turns.has(t.id) && !taken()) grants.end(t.id, "window");
      })().catch((e) => log(`hand-off ${t.id}: ${e?.message || e}`));
    };
    try { page.on("domcontentloaded", onLoad); } catch { return; }
    t.unwatch = () => { try { page.off("domcontentloaded", onLoad); } catch {} };
  }

  // What pairbrowse_status says of the message: where it went, the hand-off and until when. Never the link.
  function sentLine(t, r) {
    const n = tabNumber(t.page);
    const what = `hand-off ${t.id} for ${n >= 0 ? `tab ${n}` : "its tab"}, until ${clock(t.expiresAt)}`;
    if (r === null) return `Your turn is on its way to the user's channels: ${what}. ${WAIT}`;
    if (r.error) return `Your turn couldn't be sent (${r.error}): tell the user directly; ${what} stays open in the PairBrowse window and live view. ${WAIT}`;
    const failed = [...new Set((r.failed || []).map((f) => f.type))];
    if (!r.sent?.length) return `Couldn't reach any hand-off channel (${failed.join(", ") || "none"}): tell the user directly; ${what} stays open in the PairBrowse window and live view. ${WAIT}`;
    let line = `Your turn sent (${typesSent(r).join(", ")}): ${what}. ${WAIT}`;
    if (r.withheld?.length) line += ` ${r.withheld.join(", ")} got no link (anyone can read that channel): the user opens the live view another way.`;
    if (failed.length) line += ` Not reached: ${failed.join(", ")}.`;
    return line;
  }

  // At its expiry (B11): progress kept, the person and the agent told once, the tab held.
  async function timedOut(t) {
    try { grants.hold(t.page, { session: t.session, id: t.id }); } catch {}
    const sentence = actionSentence(t.action, t.host || "this site");
    const text = `${TIMED_OUT}: ${sentence}`;
    // PairBrowse's own check: its clearing takes the badge down and lets the tab go (onChallengeCleared).
    const check = t.key === "check" ? (checkTimedOut = { page: t.page, text }) : null;
    await journal.flushNow?.().catch(() => {});
    await Promise.resolve().then(() => saveTabs()).catch(() => {});
    try { journal.status("you", `Not done in time: ${sentence}`); } catch {}
    if (t.sent.length) {
      const r = await send({ kind: "ended", id: t.id, action: t.action, host: t.host, link: null, expiresAt: t.expiresAt, reason: "expired" });
      if (r?.failed?.length) record("notify-failed", t, [...new Set(r.failed.map((f) => f.type))].slice(0, 8));
    }
    if (t.participant) await Promise.resolve(hud.setBadgeFor(t.participant, text, "you", agentBy(t.participant).label)).catch(() => {});
    else if (!check || checkTimedOut === check) { // not when the check cleared meanwhile
      await Promise.resolve(hud.setBadge(text, "you")).catch(() => {});
      handoffs.set(t.key, { text, page: t.page, kind: t.action, by: { label: "PairBrowse", color: "" } });
    }
    hostNote(TIMEOUT_NOTE);
    log(`hand-off ${t.id}: timed out; the tab is held`);
  }

  // The agents' note when a hand-off ends other than by its expiry (B15): why, what people did in
  // the tab (names only, never values: presence's lines), and to look before going on.
  function endNote(t, reason) {
    const did = String(actionsIn(t.page) || "").slice(0, 300);
    const n = tabNumber(t.page);
    return `Hand-off ${t.id} (${actionSentence(t.action, t.host || "this site")}${n >= 0 ? `, tab ${n}` : ""}) ended: ${ENDED_BY[reason] || reason}. ` +
      `${did ? `The person there: ${did}. ` : ""}Take a browser_snapshot before you go on; Done is only a hint, so check the page shows the step finished.`;
  }

  // A grant ended (any reason): its timer stops; at expiry the B11 steps; else one note for the
  // agents (B15) and the person's channels hear that the link is over, unless they ended it
  // themselves (Done) or a restart's replacement link may follow (B16, recover).
  // Tabs a hand-off ended on, until each loads its next page: what the person typed there (a card
  // number, a code) is still in its fields after Done, and reaches no agent from them (masked).
  const typedIn = new WeakSet();
  const keepMasked = (page) => {
    if (!page || typeof page !== "object" || typedIn.has(page)) return;
    typedIn.add(page);
    try { page.once?.("domcontentloaded", () => typedIn.delete(page)); } catch {}
  };
  grants.onEnd((view, reason) => {
    if (!KEEP.has(reason)) for (const p of [view.page, ...(view.scope || [])]) keepMasked(p);
    const t = turns.get(view.id);
    if (!t) return;
    turns.delete(t.id);
    t.unwatch?.();
    if (t.timer) { try { timers.clear(t.timer); } catch {} t.timer = null; }
    const k = kept.get(t.id);
    if (k && KEEP.has(reason)) { k.entry.url = urlOf(t.page) || k.entry.url; k.waiting = reason; } else kept.delete(t.id);
    persist(t.session);
    if (reason === "expired") { timedOut(t).catch((e) => log(`hand-off timeout: ${e?.message || e}`)); return; }
    hostNote(endNote(t, reason));
    // The browser comes back by itself: recover() sends the new link, or the ended message then.
    if (reason === "browser-restarted" && k && keptAlive()) { k.deferred = true; return; }
    if (reason !== "done" && t.sent.length) send({ kind: "ended", id: t.id, action: t.action, host: t.host, link: null, expiresAt: t.expiresAt, reason }).catch(() => {});
  });

  // A hand-off that may not come back: the ended message it was spared (stopped safely), once.
  function giveUp(id, k) {
    kept.delete(id);
    if (k.deferred && k.entry.sent.length) send({ kind: "ended", id, action: k.entry.action, host: k.entry.host, link: null, expiresAt: k.entry.expiresAt, reason: "browser-restarted" }).catch(() => {});
    log(`hand-off ${id}: stopped safely after the restart`);
  }

  // The site's verification a step is, in the report's words (B14).
  const VERIFICATION = { captcha: (h) => `CAPTCHA on ${h}`, "2fa": (h) => `a 2FA code on ${h}`, login: (h) => `signing in on ${h}`, payment: (h) => `approving a payment on ${h}`, other: (h) => `a step on ${h}` };
  // The two lists for a hand-off of action on page (B14), "" when the setup has nothing open. The
  // items are read now, never cached: a setup problem fixed since isn't reported.
  function report(action, page) {
    let items;
    try { const open = compatibility(); items = Array.isArray(open) ? open.filter((i) => i && (i.severity === "error" || i.severity === "warning")) : []; } catch { items = []; }
    if (!items.length) return "";
    return setupLines({ verification: (VERIFICATION[action] || VERIFICATION.other)(hostOf(page) || "this site"), items });
  }

  const endKey = (key, reason) => { for (const t of [...turns.values()]) if (t.key === key) grants.end(t.id, reason); };
  const actionOf = (step, text) => (ACTIONS.includes(step) ? step : handoffKind(text));

  return {
    // pairbrowse_status from participant (args: { kind, text, step }), in its tab page: a promise of
    // the status result's line ("" when there is nothing to say). A "you" with hand-offs going to
    // the channels mints a grant and sends; any other kind ends this agent's open hand-off ("agent").
    async onStatus(participant, args = {}, page = null) {
      const key = `status:${participant}`;
      if (args.kind !== "you") { steps.delete(participant); endKey(key, "agent"); return ""; }
      const action = actionOf(args.step, args.text);
      steps.set(participant, action);
      const r = await start({ key, participant, page, action });
      return r ? [r.line, report(action, page)].filter(Boolean).join("\n") : "";
    },
    // The badge's statuses (hud.mjs onStatus): the Tools tab's hand-off entry for an agent's "you".
    onBadge(participant, st) {
      const key = `status:${participant}`;
      if (st?.kind === "you") handoffs.set(key, { text: st.text, page: hud.sparkPage(participant) || null, kind: steps.get(participant), by: agentBy(participant, st.color) });
      else handoffs.clear(key);
    },
    // A fast-mode run's hand-off step (runner "handoff"): a Tools tab entry for that tab until the
    // step ends, and a grant and its message when hand-offs go to the channels (the step waits for
    // it: ended). The step's end ends the grant ("agent"). The run has no status result for B14's
    // lists, so they go in a host note, as for PairBrowse's own check.
    onRunStatus(participant, text, kind, page, label) {
      const key = `run:${participant}`;
      if (kind === "you") {
        const action = handoffKind(text);
        handoffs.set(key, { text, page: page || null, kind: action, by: { label: label || "Agent", color: hud.sparkColor(participant) } });
        start({ key, participant, page, action }).then((r) => {
          if (!r?.id) return;
          log(`hand-off ${r.id}: a fast-mode step`);
          const lines = report(action, page);
          if (lines) hostNote(`A fast-mode step handed this page to the user (hand-off ${r.id}). ${lines.replace(/\n/g, " ")} Don't retry the step or work around it.`);
        }).catch((e) => log(`hand-off: ${e?.message || e}`));
      } else { handoffs.clear(key); endKey(key, "agent"); }
    },
    // A CAPTCHA or bot check PairBrowse saw (popups.mjs onYourTurn): the badge and the Tools tab
    // as before, and the channels when hand-offs go there.
    onChallenge(text, page) {
      hud.setBadge(text, "you").catch(() => {});
      handoffs.set("check", { text, page: page || null, kind: "captcha", by: { label: "PairBrowse", color: "" } });
      if ([...turns.values()].some((t) => t.key === "check" && t.page === page)) return;
      start({ key: "check", page, action: "captcha" }).then((r) => {
        if (!r?.id) return;
        log(`hand-off ${r.id}: a check on the page`);
        const lines = report("captcha", page);
        if (lines) hostNote(`PairBrowse handed the check on this page to the user (hand-off ${r.id}). ${lines.replace(/\n/g, " ")} Don't retry the check or work around it.`);
      }).catch((e) => log(`hand-off: ${e?.message || e}`));
    },
    // The check is done: "Your turn" (or its "Timed out") down again if it was this one, its
    // hand-off ends and a tab it held is the person's again.
    onChallengeCleared() {
      const text = hud.badge().text;
      if (text === CHALLENGE_TURN || (checkTimedOut && text === checkTimedOut.text)) hud.setBadge("", "clear").catch(() => {});
      if (checkTimedOut) { try { grants.release(checkTimedOut.page); } catch {} checkTimedOut = null; }
      handoffs.clear("check");
      endKey("check", "cleared");
    },
    // A person used a held tab by hand: it is theirs again (B11).
    personUsed(page) { if (page && grants.held(page)) grants.release(page); },
    // Whether agents keep out of page (B9): "open" while a grant covers it, "held" after one timed
    // out there, else "" (serve/refuse.mjs tabRefusal).
    handedOff: (page) => (!page ? "" : grants.inScope(page) ? "open" : grants.held(page) ? "held" : ""),
    // A promise of { id, reason } when the hand-off waited on ends, or null when there is none:
    // participant's own (its "you" or its run's hand-off step), else the one covering page.
    // browser_wait_for and the fast-mode handoff step race it (B15).
    ended(page, participant = null) {
      const own = participant ? [...turns.values()].find((t) => t.key === `status:${participant}` || t.key === `run:${participant}`) : null;
      return own ? grants.ended(own.page) : page ? grants.ended(page) : null;
    },
    // Whether agents' results from page are masked and its pictures covered (B10): during a hand-off,
    // while its tab is held, and after it ended until the tab loads its next page; in a saved-card
    // session every tab's are (B12).
    masked: (page) => !!page && (savedCard() === true || grants.inScope(page) || grants.held(page) || typedIn.has(page)),
    // Whether the running browser has a saved card on (B12): agents' key presses into a card's
    // autofill fields are refused then (serve/refuse.mjs, fast mode's press step).
    savedCard: () => savedCard() === true,
    // The session's tabs are back after a launch (B16): each hand-off a restart cut short gets one
    // replacement grant on the tab that came back, with the same deadline, or its ended message.
    // After a helper restart the session's turn.json is read once.
    async recover() {
      const session = sessionName();
      if (!session) return;
      load(session);
      const due = [...kept.entries()].filter(([id, k]) => k.session === session && k.waiting && !turns.has(id));
      if (!due.length) return;
      const open = await Promise.resolve().then(() => pagesNow()).catch(() => []);
      for (const [id, k] of due) {
        kept.delete(id);
        const page = (k.page && successorOf(k.page)) || tabAt(Array.isArray(open) ? open : [], k.entry.url);
        if (page && k.entry.expiresAt - now() > REISSUE_MIN_MS) {
          const r = await start({ key: k.entry.key, participant: k.participant, page, action: k.entry.action, expiresAt: k.entry.expiresAt, reminded: k.entry.reminded }).catch(() => null);
          if (r?.id) { log(`hand-off ${id}: replaced by ${r.id} after the restart`); continue; }
        }
        giveUp(id, k);
      }
      persist(session);
    },
    // The crash-loop guard keeps the browser down (supervise.mjs onCrashLoop): hand-offs waiting
    // for it end, their ended message saying the step was stopped safely.
    crashLoop() {
      const sessions = new Set();
      for (const [id, k] of [...kept.entries()]) if (k.waiting === "browser-restarted") { sessions.add(k.session); giveUp(id, k); }
      for (const session of sessions) persist(session);
    },
    // The browser closed (a crash, a restart, a session switch): its hand-offs end and no tab is held.
    browserClosed() {
      grants.endWhere(() => true, "browser-restarted");
      checkTimedOut = null;
      const session = sessionName();
      if (session) grants.release({ session });
    },
    // The helper stops: every hand-off ends, its message on its way (at most STOP_MS).
    async stop() {
      grants.endWhere(() => true, "helper-stopped");
      await within(STOP_MS, Promise.allSettled([...pending]));
    },
    // The open hand-offs, without keys (tests, diagnostics).
    open: () => [...turns.values()].map((t) => ({ id: t.id, key: t.key, action: t.action, host: t.host, expiresAt: t.expiresAt, sent: [...t.sent], reminded: t.reminded })),
  };
}
