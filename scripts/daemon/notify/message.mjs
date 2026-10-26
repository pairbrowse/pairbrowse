// What a hand-off message carries, and nothing else (spec server-mode B7): { kind, id, action,
// host, link, expiresAt, reason? }. kind: "turn" (a new link), "reminder" (the one reminder) or
// "ended"; id: the grant's 8-hex id; action: the step's kind, which picks a fixed sentence; host:
// the site's host name; link: the hand-off link, or null (opened already, or none to send);
// expiresAt: when the link stops working (epoch ms); reason: why it ended (ended), or
// "browser-restarted" on a turn that replaces a link lost to a restart (B16); privateOnly: true
// when the public link (handoff.publicLink, step 21b) couldn't start and the link is the private
// route's, so the text says it works only there; watch: a watch link (handoff.watchInMessages: view
// only, for whoever has it), on turn and reminder messages, said on a line of its own. Any other field, or a
// value outside its rule, refuses the whole message, so the agent's own words, a password, a code,
// card data or page text can't reach a channel by mistake: the person reads the agent's words only
// after taking over.
// One more kind is no hand-off (spec server-mode C8): "network", { kind, network, change, paused,
// at }, when a running session's proxy exit changed or its recheck failed (daemon/network.mjs):
// network the proxy's id, change "changed" or "failed", paused whether agents were paused for it,
// at when (epoch ms). It names no session, address, country or reason: only that it happened.
// The Handoff page's kinds (daemon/phonelink.mjs), each its own whitelist (handoffProblem):
//   approval        { kind, code, host, action, expiresAt, answer? }: a final click waits for an OK;
//                   code: the 4-character code an answer names; action: the click's class
//                   (rules/clicks.mjs) or "click"; answer: true when the linked chat may answer it
//                   (the senders of a linked app then say how; the others say to answer in PairBrowse);
//                   watch: a watch link, as on a turn.
//   approval-ended  { kind, code, outcome }: allowed, denied or ended (answered nowhere, withdrawn, expired).
//   run             { kind, host, outcome, steps }: a fast-mode run finished (done, stopped, failed).
//   test            { kind }: Send a test.
// None carries the element's words, the page's text, a value or the agent's words.
export const HANDOFF_KINDS = ["approval", "approval-ended", "run", "test"];
export const MESSAGE_KINDS = ["turn", "reminder", "ended", "network", ...HANDOFF_KINDS];
export const APPROVAL_ACTIONS = ["pay", "delete", "publish", "send", "submit", "click"];
export const APPROVAL_OUTCOMES = ["allowed", "denied", "ended"];
export const RUN_OUTCOMES = ["done", "stopped", "failed"];
const HANDOFF_FIELDS = {
  approval: new Set(["kind", "code", "host", "action", "expiresAt", "answer", "watch"]),
  "approval-ended": new Set(["kind", "code", "outcome"]),
  run: new Set(["kind", "host", "outcome", "steps"]),
  test: new Set(["kind"]),
};
const CODE = /^[A-HJ-NP-Z2-9]{4}$/;
export const NETWORK_CHANGES = ["changed", "failed"];
// The step kinds (pairbrowse_status step, and handoffKind for a detected challenge).
export const ACTIONS = ["login", "captcha", "2fa", "payment", "other"];
// Why a grant ended (B15).
export const END_REASONS = ["done", "window", "cleared", "agent", "tab-closed", "session-switched", "revoked", "expired", "browser-restarted", "helper-stopped"];
export const TITLE = "PairBrowse needs you";
export const ENDED_TITLE = "PairBrowse: hand-off ended";
export const NETWORK_TITLES = { changed: "PairBrowse: proxy exit changed", failed: "PairBrowse: proxy check failed" };

const SENTENCES = {
  login: (host) => `Sign in on ${host}`,
  captcha: (host) => `Complete a verification on ${host}`,
  "2fa": (host) => `Enter a 2FA code on ${host}`,
  payment: (host) => `Approve a payment on ${host}`,
  other: (host) => `Take a step on ${host}`,
};
const ENDINGS = {
  done: "the step is done.",
  window: "the step was done in the PairBrowse window.",
  cleared: "the check cleared.",
  agent: "the agent went on.",
  "tab-closed": "the tab closed.",
  "session-switched": "the browser session changed.",
  revoked: "it was called off.",
  expired: "nobody finished the step in time. Progress is saved, and the agent stops there.",
  "browser-restarted": "the browser restarted. The step was stopped safely.",
  "helper-stopped": "PairBrowse stopped. The step was stopped safely.",
};
const FIELDS = new Set(["kind", "id", "action", "host", "link", "expiresAt", "reason", "privateOnly", "watch"]);
const NETWORK_FIELDS = new Set(["kind", "network", "change", "paused", "at"]);
const ID = /^[0-9a-f]{8}$/;
// A proxy's id as config.json's network names it (net/credentials.mjs NETWORK_ID).
const NETWORK_ID = /^[a-z0-9][a-z0-9-]{0,33}$/;
// A host name (letters, digits, dots, hyphens; IDNs as their xn-- form), an IPv4 address or a
// bracketed IPv6 one, with an optional port.
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]{2,45}\])(?::\d{1,5})?$/;
// A link short enough that the longest message (a restart turn on a 260-character host) stays
// under Discord's 2000 characters whole.
export const LINK_MAX = 1600;
// The last time a Date can hold: a later one would pass here and then fail at every channel.
const TIME_MAX = 8.64e15;

// The step's sentence: "Sign in on example.com".
export const actionSentence = (action, host) => (SENTENCES[action] || SENTENCES.other)(host);

// A watch link as a message may carry it: an http(s) address of LINK_MAX at most, no spaces.
const linkOk = (v) => { try { return typeof v === "string" && v.length <= LINK_MAX && !/\s/.test(v) && ["https:", "http:"].includes(new URL(v).protocol); } catch { return false; } };
const watchProblem = (message) => (message.watch !== undefined && message.watch !== null && (!linkOk(message.watch) || message.kind === "ended") ? "watch is a watch link, on a turn, a reminder or an approval" : "");

// Why message can't be sent ("" when it can), naming fields and rules only, never a value.
export function messageProblem(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "a message is an object";
  if (message.kind === "network") return networkProblem(message);
  if (HANDOFF_KINDS.includes(message.kind)) return handoffProblem(message);
  const unknown = Object.keys(message).filter((k) => !FIELDS.has(k));
  if (unknown.length) return `a message carries no other field (${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")})`;
  const { kind, id, action, host, link, expiresAt, reason } = message;
  if (!MESSAGE_KINDS.includes(kind)) return `kind is one of ${MESSAGE_KINDS.join(", ")}`;
  if (!(typeof id === "string" && ID.test(id))) return "id is a grant's 8-hex id";
  if (!ACTIONS.includes(action)) return `action is one of ${ACTIONS.join(", ")}`;
  if (!(typeof host === "string" && host.length <= 260 && HOST.test(host))) return "host is a site's host name";
  if (link !== null && link !== undefined) {
    let u = null;
    try { u = typeof link === "string" && link.length <= LINK_MAX && !/\s/.test(link) ? new URL(link) : null; } catch {}
    if (!u || (u.protocol !== "https:" && u.protocol !== "http:")) return "link is the hand-off link, or null";
    if (kind === "ended") return "an ended message has no link";
  }
  if (!(Number.isInteger(expiresAt) && expiresAt > 0 && expiresAt <= TIME_MAX)) return "expiresAt is a time (epoch ms)";
  if (message.privateOnly !== undefined && (typeof message.privateOnly !== "boolean" || (message.privateOnly && (kind === "ended" || !link)))) return "privateOnly is true or false, and true only with a link";
  if (kind === "ended" ? !END_REASONS.includes(reason) : reason !== undefined && reason !== null && !(kind === "turn" && reason === "browser-restarted")) {
    return kind === "ended" ? "reason is why the hand-off ended" : "reason is only browser-restarted, on a turn";
  }
  return watchProblem(message);
}

// A network message's own rule: its fields only, each in its rule.
function networkProblem(message) {
  const unknown = Object.keys(message).filter((k) => !NETWORK_FIELDS.has(k));
  if (unknown.length) return `a network message carries no other field (${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")})`;
  if (!(typeof message.network === "string" && NETWORK_ID.test(message.network))) return "network is a proxy's id";
  if (!NETWORK_CHANGES.includes(message.change)) return "change is changed or failed";
  if (typeof message.paused !== "boolean") return "paused is true or false";
  if (!(Number.isInteger(message.at) && message.at > 0 && message.at <= TIME_MAX)) return "at is a time (epoch ms)";
  return "";
}

// A Handoff page message's own rule: its kind's fields only, each in its rule.
function handoffProblem(message) {
  const fields = HANDOFF_FIELDS[message.kind];
  const unknown = Object.keys(message).filter((k) => !fields.has(k));
  if (unknown.length) return `a ${message.kind} message carries no other field (${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")})`;
  const { kind } = message;
  if ((kind === "approval" || kind === "approval-ended") && !(typeof message.code === "string" && CODE.test(message.code))) return "code is an approval's 4-character code";
  if ((kind === "approval" || kind === "run") && !(typeof message.host === "string" && message.host.length <= 260 && HOST.test(message.host))) return "host is a site's host name";
  if (kind === "approval") {
    if (!APPROVAL_ACTIONS.includes(message.action)) return `action is one of ${APPROVAL_ACTIONS.join(", ")}`;
    if (!(Number.isInteger(message.expiresAt) && message.expiresAt > 0 && message.expiresAt <= TIME_MAX)) return "expiresAt is a time (epoch ms)";
    if (message.answer !== undefined && typeof message.answer !== "boolean") return "answer is true or false";
    if (watchProblem(message)) return watchProblem(message);
  }
  if (kind === "approval-ended" && !APPROVAL_OUTCOMES.includes(message.outcome)) return "outcome is allowed, denied or ended";
  if (kind === "run") {
    if (!RUN_OUTCOMES.includes(message.outcome)) return "outcome is done, stopped or failed";
    if (!(Number.isInteger(message.steps) && message.steps >= 0 && message.steps <= 100_000)) return "steps is a number of steps";
  }
  return "";
}

export const APPROVAL_TITLE = "PairBrowse: approve a final click?";
const APPROVAL_ENDINGS = { allowed: "approved.", denied: "denied.", ended: "no longer waits (answered elsewhere, withdrawn or expired)." };
const RUN_WORDS = { done: "finished", stopped: "stopped", failed: "failed" };

// "14:35 UTC": the person may be anywhere, the server's own zone means nothing to them.
export const clock = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

// A watch link for a hand-off message (handoff.watchInMessages, off by default): watchLink() (the
// helper's chat watch link: sharing.mjs chatWatchLink) answers { link } or { error }; resolves the
// link, or null when the setting is off or no link could be made (the message goes without it).
export function watchForMessage(config, watchLink) {
  if (config?.handoff?.watchInMessages !== true || typeof watchLink !== "function") return Promise.resolve(null);
  return Promise.resolve().then(() => watchLink()).then((r) => (typeof r?.link === "string" ? r.link : null)).catch(() => null);
}

// The watch link's line (handoff.watchInMessages).
export const watchLine = (watch) => `Watch live (view only): ${watch}`;

// Said under a link that works only on the private route: the public one couldn't start (step 21b).
export const PRIVATE_ONLY = "The public link couldn't start, so this link works only on your private route (your tailnet or an SSH tunnel to this computer); the step can also be done in the PairBrowse window.";

// The message as a channel shows it: { title, text }. withheld: the channel leaves the link out
// (a public ntfy topic, B7), so the text says where to take over instead.
// reply: "buttons" (a linked Telegram chat: buttons and typed replies), "typed" (a linked Discord
// DM: typed replies) or false (any other channel: answer in PairBrowse), for an approval the
// linked chat may answer (message.answer).
export function messageText(message, { withheld = false, reply = false } = {}) {
  const { kind, action, host, link, expiresAt, reason } = message;
  if (kind === "approval") {
    const lines = [`Approve a final click on ${host}? (${action}) Code ${message.code}`];
    const until = clock(expiresAt);
    if (message.answer === true && reply === "buttons") lines.push(`Tap Approve or Deny, or reply "approve ${message.code}" or "deny ${message.code}", before ${until}.`);
    else if (message.answer === true && reply === "typed") lines.push(`Reply "approve ${message.code}" or "deny ${message.code}" before ${until}.`);
    else lines.push(`Answer in PairBrowse before ${until}.`);
    if (message.watch && !withheld) lines.push(watchLine(message.watch));
    return { title: APPROVAL_TITLE, text: lines.join("\n") };
  }
  if (kind === "approval-ended") return { title: "PairBrowse: approval ended", text: `Approval ${message.code} ${APPROVAL_ENDINGS[message.outcome] || APPROVAL_ENDINGS.ended}` };
  if (kind === "run") return { title: "PairBrowse: run finished", text: `A fast-mode run on ${host} ${RUN_WORDS[message.outcome] || "ended"} after ${message.steps} step${message.steps === 1 ? "" : "s"}.` };
  if (kind === "test") return { title: "PairBrowse", text: "PairBrowse can reach you here." };
  if (kind === "network") {
    const what = message.change === "changed"
      ? `The exit address of proxy "${message.network}" changed at ${clock(message.at)}.`
      : `Proxy "${message.network}" failed its recheck at ${clock(message.at)}; nothing went around it.`;
    return { title: NETWORK_TITLES[message.change] || NETWORK_TITLES.failed, text: `${what}\n${message.paused ? "Agents are paused until you resume them in PairBrowse." : "Agents go on."}` };
  }
  if (kind === "ended") return { title: ENDED_TITLE, text: `The hand-off on ${host} ended: ${ENDINGS[reason] || ENDINGS.done}` };
  const lines = [];
  if (reason === "browser-restarted") lines.push("The browser restarted; use this new link.");
  lines.push(`${kind === "reminder" ? "Reminder: " : ""}${actionSentence(action, host)}.`);
  const until = clock(expiresAt);
  if (withheld) lines.push(`Take over in PairBrowse's live view before ${until} (this channel doesn't get the link).`);
  else if (link) { lines.push(`Take over before ${until}: ${link}`); if (message.privateOnly === true) lines.push(PRIVATE_ONLY); }
  else if (kind === "reminder") lines.push(`The link was opened already; the step stays open until ${until}.`);
  else lines.push(`Take over in PairBrowse's live view before ${until}.`);
  if (message.watch && !withheld) lines.push(watchLine(message.watch));
  return { title: TITLE, text: lines.join("\n") };
}
