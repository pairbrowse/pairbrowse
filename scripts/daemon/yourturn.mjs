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
// ("cleared"). At its expiry (B11), in order: the goal log's pending lines written, the session's
// tabs saved, "Not done in time" in the goal log's Your turn, one ended message, the badge and the
// Tools tab's entry say "Timed out", one host note for the agent, and the tab is held (agents keep
// out, daemon/serve/refuse.mjs with step 22) until a new "you", a person's own input in it, or the
// session's end.
//
// While a grant is open on a tab, and while it is held, masked(page) is true: every agent's
// results from it are masked as a joiner's agent's are and its pictures covered (B10, serve/result.mjs).
// Nothing typed by the person passes through here: messages and audit lines carry words from
// fixed lists, host notes and the goal log fixed sentences.
import { within } from "../util.mjs";
import { handoffTimes } from "../config-schema.mjs";
import { CHALLENGE_TURN } from "../popups.mjs";
import { testMs } from "../testenv.mjs";
import { ACTIONS, actionSentence, clock } from "./notify/message.mjs";
import { handoffKind } from "./toolstab.mjs";

// How long pairbrowse_status waits for the channels' answers before saying the message is on its way.
export const REPORT_MS = 12_000;
// How long the helper's stop waits for the ended messages.
export const STOP_MS = 5000;
export const TIMED_OUT = "Timed out";
export const TIMEOUT_NOTE = "Nobody finished the step in time. Progress is saved. Stop here, tell the user where you are, and don't retry the step or work around it.";
const WAIT = "Don't act in this tab; wait with browser_wait_for.";
const MINUTE_MS = 60_000;

// The site's host as a message carries it ("" for a page without one).
const hostOf = (page) => { try { const u = new URL(page.url()); return /^https?:$/.test(u.protocol) ? u.host.toLowerCase() : ""; } catch { return ""; } };
// A tab's number as browser_tabs lists it, or -1.
const tabNumber = (page) => { try { return page.context().pages().indexOf(page); } catch { return -1; } };

// config: the running config (handoff). grants: the grant table (daemon/grants.mjs). notifier: the
// channels (notify/index.mjs createNotifier). sends(): whether hand-offs go to the channels now
// (handoffSends with server mode). handoffs: the Tools tab's hand-offs (toolstab.mjs). journal: the
// goal log. saveTabs(): the session's tabs written now. hostNote(text): for the host's agent's next
// result. audit: the trail (audit.mjs) or null. hud: the badge. sessionName(): the session open now.
// linkFor(redeemKey): the hand-off link (the live view's address), or null. agentBy(p, color): an
// agent's { label, color } for the Tools tab. log(line): ids and words only. turnMs(): a grant's
// life in ms for tests (PAIRBROWSE_TEST_TURN_MS; its reminder at two thirds), 0 for config's minutes.
// timers, now: tests (now: the wall clock grants read too).
export function createYourTurn({ config, grants, notifier, sends, handoffs, journal, saveTabs = async () => ({}), hostNote = () => {}, audit = null, hud, sessionName, linkFor = async () => null,
  agentBy = (p, color = "") => ({ label: "Agent", color }), log = () => {}, turnMs = () => testMs("TURN_MS", 0), timers = { set: setTimeout, clear: clearTimeout }, now = Date.now }) {
  const turns = new Map(); // grant id -> { id, key, participant, page, action, host, session, expiresAt, sent, timer, reminded }
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
    const key = grants.redeemKey(t.id);
    const link = key ? await Promise.resolve().then(() => linkFor(key)).catch(() => null) : null;
    if (!turns.has(t.id)) return;
    const r = await send({ kind: "reminder", id: t.id, action: t.action, host: t.host, link, expiresAt: t.expiresAt });
    audited("reminded", t, r, [...(key ? [] : ["already-opened"]), ...(key && (!link || r?.withheld?.length) ? ["no-link"] : [])]);
    log(`hand-off ${t.id}: reminder ${r?.sent?.length ? "sent" : "not sent"}`);
  }

  // A new grant for a step and its message: { id, line } (line: what the status result says), or
  // null when hand-offs stay in the window. key: the Tools tab's key ("status:<p>", "check").
  async function start({ key, participant = null, page, action }) {
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
      g = grants.mint({ session, page, action, ...(ms ? { expiresAt: now() + ms } : { minutes: config.handoff?.grantMinutes }) });
    } catch (e) {
      log(`hand-off: no grant (${e?.message || e})`);
      return { line: "The hand-off link couldn't be made (daemon.log says why): tell the user directly. They can do the step in the PairBrowse window." };
    }
    const t = { id: g.id, key, participant, page, action, host: hostOf(page), session, expiresAt: g.expiresAt, sent: [], timer: null, reminded: false };
    turns.set(t.id, t);
    t.timer = timers.set(() => { remind(t).catch((e) => log(`hand-off reminder: ${e?.message || e}`)); }, Math.max(0, Math.min(remindMs(), g.expiresAt - now() - 1000)));
    t.timer?.unref?.();
    const link = await Promise.resolve().then(() => linkFor(g.redeemKey)).catch(() => null);
    const message = { kind: "turn", id: t.id, action, host: t.host, link, expiresAt: t.expiresAt };
    const sending = send(message).then((r) => {
      t.sent = typesSent(r);
      audited("notified", t, r, !link || r?.withheld?.length ? ["no-link"] : []);
      return r;
    });
    const r = await within(REPORT_MS, sending);
    return { id: t.id, line: sentLine(t, r) };
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

  // A grant ended (any reason): its timer stops; at expiry the B11 steps; else the person's channels
  // hear that the link is over, unless they ended it themselves (Done).
  grants.onEnd((view, reason) => {
    const t = turns.get(view.id);
    if (!t) return;
    turns.delete(t.id);
    if (t.timer) { try { timers.clear(t.timer); } catch {} t.timer = null; }
    if (reason === "expired") { timedOut(t).catch((e) => log(`hand-off timeout: ${e?.message || e}`)); return; }
    if (reason !== "done" && t.sent.length) send({ kind: "ended", id: t.id, action: t.action, host: t.host, link: null, expiresAt: t.expiresAt, reason }).catch(() => {});
  });

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
      return (await start({ key, participant, page, action }))?.line || "";
    },
    // The badge's statuses (hud.mjs onStatus): the Tools tab's hand-off entry for an agent's "you".
    onBadge(participant, st) {
      const key = `status:${participant}`;
      if (st?.kind === "you") handoffs.set(key, { text: st.text, page: hud.sparkPage(participant) || null, kind: steps.get(participant), by: agentBy(participant, st.color) });
      else handoffs.clear(key);
    },
    // A fast-mode run's hand-off step (runner "handoff"): a Tools tab entry for that tab until the step ends.
    onRunStatus(participant, text, kind, page, label) {
      if (kind === "you") handoffs.set(`run:${participant}`, { text, page: page || null, by: { label: label || "Agent", color: hud.sparkColor(participant) } });
      else handoffs.clear(`run:${participant}`);
    },
    // A CAPTCHA or bot check PairBrowse saw (popups.mjs onYourTurn): the badge and the Tools tab
    // as before, and the channels when hand-offs go there.
    onChallenge(text, page) {
      hud.setBadge(text, "you").catch(() => {});
      handoffs.set("check", { text, page: page || null, kind: "captcha", by: { label: "PairBrowse", color: "" } });
      if ([...turns.values()].some((t) => t.key === "check" && t.page === page)) return;
      start({ key: "check", page, action: "captcha" }).then((r) => { if (r?.id) log(`hand-off ${r.id}: a check on the page`); }).catch((e) => log(`hand-off: ${e?.message || e}`));
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
    // Whether agents keep out of page: a grant open on it, or held after a timeout (B9).
    handedOff: (page) => !!page && (grants.inScope(page) || grants.held(page)),
    // Whether agents' results from page are masked and its pictures covered (B10).
    masked: (page) => !!page && (grants.inScope(page) || grants.held(page)),
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
