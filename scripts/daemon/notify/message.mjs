// What a hand-off message carries, and nothing else (spec server-mode B7): { kind, id, action,
// host, link, expiresAt, reason? }. kind: "turn" (a new link), "reminder" (the one reminder) or
// "ended"; id: the grant's 8-hex id; action: the step's kind, which picks a fixed sentence; host:
// the site's host name; link: the hand-off link, or null (opened already, or none to send);
// expiresAt: when the link stops working (epoch ms); reason: why it ended (ended), or
// "browser-restarted" on a turn that replaces a link lost to a restart (B16). Any other field, or a
// value outside its rule, refuses the whole message, so the agent's own words, a password, a code,
// card data or page text can't reach a channel by mistake: the person reads the agent's words only
// after taking over.
export const MESSAGE_KINDS = ["turn", "reminder", "ended"];
// The step kinds (pairbrowse_status step, and handoffKind for a detected challenge).
export const ACTIONS = ["login", "captcha", "2fa", "payment", "other"];
// Why a grant ended (B15).
export const END_REASONS = ["done", "cleared", "agent", "tab-closed", "session-switched", "revoked", "expired", "browser-restarted", "helper-stopped"];
export const TITLE = "PairBrowse needs you";
export const ENDED_TITLE = "PairBrowse: hand-off ended";

const SENTENCES = {
  login: (host) => `Sign in on ${host}`,
  captcha: (host) => `Complete a verification on ${host}`,
  "2fa": (host) => `Enter a 2FA code on ${host}`,
  payment: (host) => `Approve a payment on ${host}`,
  other: (host) => `Take a step on ${host}`,
};
const ENDINGS = {
  done: "the step is done.",
  cleared: "the check cleared.",
  agent: "the agent went on.",
  "tab-closed": "the tab closed.",
  "session-switched": "the browser session changed.",
  revoked: "it was called off.",
  expired: "nobody finished the step in time. Progress is saved, and the agent stops there.",
  "browser-restarted": "the browser restarted.",
  "helper-stopped": "PairBrowse stopped. The step was stopped safely.",
};
const FIELDS = new Set(["kind", "id", "action", "host", "link", "expiresAt", "reason"]);
const ID = /^[0-9a-f]{8}$/;
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

// Why message can't be sent ("" when it can), naming fields and rules only, never a value.
export function messageProblem(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "a message is an object";
  const unknown = Object.keys(message).filter((k) => !FIELDS.has(k));
  if (unknown.length) return `a message carries no other field (${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")})`;
  const { kind, id, action, host, link, expiresAt, reason } = message;
  if (!MESSAGE_KINDS.includes(kind)) return "kind is turn, reminder or ended";
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
  if (kind === "ended" ? !END_REASONS.includes(reason) : reason !== undefined && reason !== null && !(kind === "turn" && reason === "browser-restarted")) {
    return kind === "ended" ? "reason is why the hand-off ended" : "reason is only browser-restarted, on a turn";
  }
  return "";
}

// "14:35 UTC": the person may be anywhere, the server's own zone means nothing to them.
export const clock = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

// The message as a channel shows it: { title, text }. withheld: the channel leaves the link out
// (a public ntfy topic, B7), so the text says where to take over instead.
export function messageText(message, { withheld = false } = {}) {
  const { kind, action, host, link, expiresAt, reason } = message;
  if (kind === "ended") return { title: ENDED_TITLE, text: `The hand-off on ${host} ended: ${ENDINGS[reason] || ENDINGS.done}` };
  const lines = [];
  if (reason === "browser-restarted") lines.push("The browser restarted; use this new link.");
  lines.push(`${kind === "reminder" ? "Reminder: " : ""}${actionSentence(action, host)}.`);
  const until = clock(expiresAt);
  if (withheld) lines.push(`Take over in PairBrowse's live view before ${until} (this channel doesn't get the link).`);
  else if (link) lines.push(`Take over before ${until}: ${link}`);
  else if (kind === "reminder") lines.push(`The link was opened already; the step stays open until ${until}.`);
  else lines.push(`Take over in PairBrowse's live view before ${until}.`);
  return { title: TITLE, text: lines.join("\n") };
}
