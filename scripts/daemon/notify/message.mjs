// What a hand-off message carries, and nothing else (spec server-mode B7): { kind, id, action,
// host, link, expiresAt, reason? }. kind: "turn" (a new link), "reminder" (the one reminder) or
// "ended"; id: the grant's 8-hex id; action: the step's kind, which picks a fixed sentence; host:
// the site's host name; link: the hand-off link, or null (opened already, or none to send);
// expiresAt: when the link stops working (epoch ms); reason: why it ended (ended), or
// "browser-restarted" on a turn that replaces a link lost to a restart (B16); privateOnly: true
// when the public link (handoff.publicLink, step 21b) couldn't start and the link is the private
// route's, so the text says it works only there. Any other field, or a
// value outside its rule, refuses the whole message, so the agent's own words, a password, a code,
// card data or page text can't reach a channel by mistake: the person reads the agent's words only
// after taking over.
// One more kind is no hand-off (spec server-mode C8): "network", { kind, network, change, paused,
// at }, when a running session's proxy exit changed or its recheck failed (daemon/network.mjs):
// network the proxy's id, change "changed" or "failed", paused whether agents were paused for it,
// at when (epoch ms). It names no session, address, country or reason: only that it happened.
export const MESSAGE_KINDS = ["turn", "reminder", "ended", "network"];
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
const FIELDS = new Set(["kind", "id", "action", "host", "link", "expiresAt", "reason", "privateOnly"]);
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

// Why message can't be sent ("" when it can), naming fields and rules only, never a value.
export function messageProblem(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return "a message is an object";
  if (message.kind === "network") return networkProblem(message);
  const unknown = Object.keys(message).filter((k) => !FIELDS.has(k));
  if (unknown.length) return `a message carries no other field (${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")})`;
  const { kind, id, action, host, link, expiresAt, reason } = message;
  if (!MESSAGE_KINDS.includes(kind)) return "kind is turn, reminder, ended or network";
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
  return "";
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

// "14:35 UTC": the person may be anywhere, the server's own zone means nothing to them.
export const clock = (ms) => `${new Date(ms).toISOString().slice(11, 16)} UTC`;

// Said under a link that works only on the private route: the public one couldn't start (step 21b).
export const PRIVATE_ONLY = "The public link couldn't start, so this link works only on your private route (your tailnet or an SSH tunnel to this computer); the step can also be done in the PairBrowse window.";

// The message as a channel shows it: { title, text }. withheld: the channel leaves the link out
// (a public ntfy topic, B7), so the text says where to take over instead.
export function messageText(message, { withheld = false } = {}) {
  const { kind, action, host, link, expiresAt, reason } = message;
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
  return { title: TITLE, text: lines.join("\n") };
}
