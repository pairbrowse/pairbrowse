// Hand-off messages to the person's own channels (spec server-mode B6, B7, decision 8): one sender
// interface, { type, describe(), send(message) }, built from config.json's handoff.channels through
// SENDERS. A new channel is one file (its type, its fields' rules, create) plus one entry here.
// Credentials are reserved secrets (PAIRBROWSE_..., secrets.env), named by a channel and read when a
// message goes; config.json holds only their names. A channel with an unknown type, a missing or
// misnamed secret, a value that doesn't fit (a plain http address to another computer, say) is
// skipped with a warning naming it; never its value. Messages are checked whole (message.mjs)
// before any channel gets one: a fixed sentence per step kind, the site's host, the expiry and the
// link, nothing else. Every send is bounded; a channel that fails never holds up the others.
// Helper traffic: these requests never go through a browser session's proxy (post.mjs).
import { within } from "../../util.mjs";
import { checkChannel } from "./channel.mjs";
import { messageProblem, messageText } from "./message.mjs";
import { httpsPost } from "./post.mjs";
import webhook from "./webhook.mjs";
import ntfy from "./ntfy.mjs";
import telegram from "./telegram.mjs";
import discord from "./discord.mjs";
import slack from "./slack.mjs";

export const SENDERS = { webhook, ntfy, telegram, discord, slack };
// A sender's whole send, its retry included (post.mjs: 2 tries of 10 s and the 5 s between).
export const SEND_MAX_MS = 30_000;

// Whether hand-offs go to the channels (decision 8): only with handoff.enabled, and then in server
// mode (always) or on a desktop while the person has turned Away on. Otherwise the step stays in
// the PairBrowse window, as before; a channel never takes it away from the window.
export function handoffSends(config, { server = false } = {}) {
  const h = config?.handoff || {};
  return h.enabled === true && (server === true || h.away === true);
}

// A message the helper sends of its own (a proxy's recheck: daemon/network.mjs C8) goes where
// hand-offs go (handoffSends), never elsewhere: notifier.send's result, or null with nothing sent.
// config and server() are read at each send, so Away and Settings changes count at once.
export function sendWhereHandoffsGo(config, { server = () => false, notifier }) {
  return (message) => (handoffSends(config, { server: server() }) ? notifier.send(message) : null);
}

// The usable senders for channels: { senders, warnings }. secret(name): a saved secret's value.
// post: httpsPost (tests pass their own bounds). table: SENDERS (tests add one).
export function buildSenders(channels, { secret, post = httpsPost, table = SENDERS } = {}) {
  const senders = [];
  const warnings = [];
  const list = Array.isArray(channels) ? channels : [];
  list.forEach((channel, i) => {
    const sender = channel && typeof channel === "object" && !Array.isArray(channel) && Object.hasOwn(table, channel.type) ? table[channel.type] : null;
    const where = `handoff.channels[${i}]`;
    if (!sender) {
      const type = channel && typeof channel === "object" ? channel.type : undefined;
      warnings.push(`${where}: ${typeof type === "string" ? `unknown type ${JSON.stringify(type.slice(0, 40))}` : "no type"} (${Object.keys(table).join(", ")}); this channel is skipped`);
      return;
    }
    const { problem, unknown } = checkChannel(channel, sender, { secret });
    if (unknown.length) warnings.push(`${where} (${sender.type}): unknown field${unknown.length > 1 ? "s" : ""} ${unknown.map((k) => JSON.stringify(k.slice(0, 40))).join(", ")} (not used)`);
    if (problem) { warnings.push(`${where} (${sender.type}): ${problem}; this channel is skipped`); return; }
    try {
      senders.push(sender.create(channel, { secret, post, messageText }));
    } catch (e) {
      warnings.push(`${where} (${sender.type}): couldn't be set up (${e?.code || "error"}); this channel is skipped`);
    }
  });
  return { senders, warnings };
}

// The notifier the hand-off uses. channels(): the current handoff.channels (read at each send, so
// a channel or a secret added later counts from the next message). secret(name): a saved secret's
// value. log(line): warnings (each once, until it goes away and comes back) and failed sends, by channel type
// and error, never an address or a value.
// send(message): { sent: [types], failed: [{ type, error }], withheld: [types that left the link
// out] }, or { error } when the message isn't one (then nothing is sent). usable(): the senders now.
export function createNotifier({ channels, secret, log = () => {}, post = httpsPost, table = SENDERS, sendMaxMs = SEND_MAX_MS } = {}) {
  const read = () => (typeof channels === "function" ? channels() : channels);
  let said = new Set();
  const build = () => {
    const built = buildSenders(read(), { secret, post, table });
    for (const w of built.warnings) if (!said.has(w)) try { log(`hand-off: ${w}`); } catch {}
    said = new Set(built.warnings);
    return built;
  };

  async function send(message) {
    const problem = messageProblem(message);
    if (problem) { try { log(`hand-off: a message was refused (${problem})`); } catch {} return { error: problem }; }
    const { senders } = build();
    const results = await Promise.all(senders.map(async (s) => {
      const r = await within(sendMaxMs, Promise.resolve().then(() => s.send(message)).catch((e) => ({ ok: false, error: e?.code || "error" })));
      return { type: s.type, ...(r || { ok: false, error: "timed out" }) };
    }));
    const out = { sent: [], failed: [], withheld: [] };
    for (const r of results) {
      if (r.ok) {
        out.sent.push(r.type);
        if (message.link && r.link === false) out.withheld.push(r.type);
      } else {
        out.failed.push({ type: r.type, error: String(r.error || "error").slice(0, 120) });
        try { log(`hand-off: ${r.type} couldn't send the ${message.kind} message (${String(r.error || "error").slice(0, 120)})`); } catch {}
      }
    }
    return out;
  }

  return {
    send,
    usable: () => build().senders,
    warnings: () => build().warnings,
    describe: () => build().senders.map((s) => s.describe()),
  };
}
