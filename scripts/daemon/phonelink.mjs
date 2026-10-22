// The Handoff page's part of the helper: linking Telegram or Discord to your phone with a one-time
// code, what goes there (handoff.send), and answering approval cards from that chat
// (handoff.answer). Linking writes the channel config the senders already use (daemon/notify/):
//   Telegram: reserved secrets HANDOFF_TELEGRAM_TOKEN and _CHAT (the private chat's id), a
//     handoff.channels entry { type: "telegram", tokenSecret, chatSecret }, handoff.enabled true.
//   Discord: reserved secrets HANDOFF_DISCORD_TOKEN, _CHANNEL (the DM's id) and _USER (yours), an
//     entry { type: "discord-dm", tokenSecret, channelSecret }, handoff.enabled true.
// Unlink removes that app's secrets and its entry (enabled false when no channel is left).
//
// A link: the token you paste is checked (Telegram getMe, Discord GET /users/@me) and held in
// memory only while the link waits (10 minutes); the page shows a code (PB- and 6 characters,
// crypto random, no 0/O/1/I). The helper reads the bot's messages (Telegram getUpdates long poll;
// Discord's Gateway) until someone sends that code in a private chat with the bot: that chat and
// sender are pinned, the token and ids saved as reserved secrets (secrets.env, through the
// helper's secret store, so every log masks them from then on), and the bot replies "Linked to
// PairBrowse.". Everything else it reads is ignored. A cancel or the code's expiry saves nothing.
// Only the pinned chat and user are ever answered or read from after that.
//
// Reading runs ONLY while a link waits, or while answering from chat is on and an approval the
// chat may answer waits; it stops on unlink, cancel and the helper's stop (timers unref'd).
//
// Approvals (handoff.send.approvals, under the hand-off gate: notify/index.mjs handoffSends): each
// card asked here gets a 4-character code; the message names the site's host, the click's class
// and the expiry, never the element's words or the page. With handoff.answer on, a linked app's
// chat answers it ("approve K7Q2", or Telegram's buttons) through clickApprovals.answerFromChat,
// which takes only what a joiner with the approve role could (a known tab, held to its origin).
// Each code maps to one card and stops matching when the card ends anywhere.
//
// Nothing here puts a token, a chat id or a user id in an answer, an event, a log line or an error.
import { randomInt } from "node:crypto";
import { paths } from "../paths.mjs";
import { readJson, writeJsonAtomic, urlHost } from "../util.mjs";
import { readConfigFile } from "../liveview/network.mjs";
import { setReservedSecret, deleteSecret } from "../rules/secrets.mjs";
import { buildSenders, handoffSends, handoffWants, actionGroup, SEND_GROUPS } from "./notify/index.mjs";
import { httpsPost } from "./notify/post.mjs";
import { TELEGRAM, DISCORD, TELEGRAM_API, DISCORD_API, DISCORD_GATEWAY, TELEGRAM_TOKEN, DISCORD_TOKEN, DISCORD_ID, CODE_ALPHABET, linkedTelegram, linkedDiscord } from "./notify/linked.mjs";
import { createTelegramApi } from "./phonelink/telegram.mjs";
import { createDiscordApi, openGateway } from "./phonelink/discord.mjs";

export const LINK_MS = 10 * 60_000;
export const APPS = ["telegram", "discord"];
const NAMES = { telegram: "Telegram", discord: "Discord" };
const LINKED = "Linked to PairBrowse.";
const ANSWER = /^\s*(approve|allow|deny)\s+([A-Za-z0-9]{4})\s*$/i;
const HOST = /^[a-z0-9.-]{1,253}(?::\d{1,5})?$/;
const cleanName = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 64);
const plain = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const code = (n, random) => Array.from({ length: n }, () => CODE_ALPHABET[random(CODE_ALPHABET.length)]).join("");

// config: the running config (handoff). secrets: the helper's secret store. notifier: the
// hand-off channels (notify/index.mjs createNotifier). approvals(): the click approvals
// (daemon/approvals.mjs) or null. server(): server mode. log(line). configFile, linksFile: where
// config.json and the linked apps' display names (handoff-links.json, 0600) live.
// telegramBase, discordBase, gatewayUrl: the services' addresses (loopback stand-ins in tests).
// request (notify/post.mjs httpsJson), post (httpsPost), connect (ws.mjs connect), timers, now,
// random(n), quietMs (a pause between polls that brought nothing: tests), pollSeconds: tests.
export function createPhoneLink({ config, secrets, notifier, approvals = () => null, server = () => false, log = () => {}, configFile = paths.config, linksFile = paths.handoffLinks,
  telegramBase = TELEGRAM_API, discordBase = DISCORD_API, gatewayUrl = DISCORD_GATEWAY, request, post = httpsPost, connect, timers = { set: setTimeout, clear: clearTimeout },
  now = Date.now, random = randomInt, quietMs = 0, pollSeconds, retryMs = 5000 }) {
  const tg = createTelegramApi({ base: telegramBase, ...(request ? { request } : {}), ...(pollSeconds !== undefined ? { pollSeconds } : {}) });
  const dc = createDiscordApi({ base: discordBase, ...(request ? { request } : {}) });
  const apps = { telegram: { pending: null, error: "", loop: null, offset: 0, offsetToken: "" }, discord: { pending: null, error: "", gateway: null, gatewayToken: "" } };
  const waiting = new Map(); // approval code -> { id, answerable, answeredHere }
  const codeOf = new Map(); // approval id -> its code
  const listeners = new Set();
  let busy = false;
  let stopped = false;
  let unwatch = null;
  const unref = (t) => { t?.unref?.(); return t; };

  const values = () => { try { return secrets?.get?.().values || {}; } catch { return {}; } };
  const saved = (name) => { const v = values()[name]; return typeof v === "string" && v ? v : ""; };
  const channels = () => (Array.isArray(config.handoff?.channels) ? config.handoff.channels : []);
  const linked = (app) => (app === "telegram"
    ? TELEGRAM_TOKEN.test(saved(TELEGRAM.token)) && /^-?\d{1,20}$/.test(saved(TELEGRAM.chat)) && channels().some(linkedTelegram)
    : DISCORD_TOKEN.test(saved(DISCORD.token)) && DISCORD_ID.test(saved(DISCORD.channel)) && DISCORD_ID.test(saved(DISCORD.user)) && channels().some(linkedDiscord));
  const shown = () => { const r = readJson(linksFile, {}); return plain(r) ? r : {}; };
  const sends = () => handoffSends(config, { server: server() === true });
  const answerOn = () => config.handoff?.answer === true;
  const anyAnswerable = () => [...waiting.values()].some((w) => w.answerable);

  // ---- the summary (GET handoff.json, the handoff event) ----
  function appSummary(app) {
    const a = apps[app];
    const names = plain(shown()[app]) ? shown()[app] : {};
    const error = a.error ? { error: a.error } : {};
    if (a.pending) return { state: "pending", bot: a.pending.bot, chat: "", code: a.pending.code, expiresAt: a.pending.expiresAt, ...error };
    if (linked(app)) return { state: "linked", bot: cleanName(names.bot), chat: cleanName(names.chat), ...error };
    return { state: "none", bot: "", chat: "", ...error };
  }
  function read() {
    const h = config.handoff || {};
    let usable = 0;
    try { usable = notifier.usable().length; } catch {}
    return {
      on: h.away === true, server: server() === true, ready: h.enabled === true && usable > 0,
      send: Object.fromEntries(SEND_GROUPS.map((g) => [g, handoffWants(config, g)])), answer: answerOn(),
      telegram: appSummary("telegram"), discord: appSummary("discord"),
    };
  }
  function changed() {
    const summary = read();
    for (const fn of listeners) try { fn(summary); } catch {}
  }

  // ---- files: config.json's handoff, secrets.env, the display names ----
  function writeHandoff(fn) {
    const file = readConfigFile(configFile);
    if (file.problem) return file.problem;
    const h = plain(file.config.handoff) ? file.config.handoff : {};
    const next = fn({ ...h, channels: Array.isArray(h.channels) ? h.channels : [] });
    try { writeJsonAtomic(configFile, { ...file.config, handoff: next }); } catch (e) {
      return `config.json couldn't be written (${e?.code || "error"}). Check that PairBrowse's folder can be written, then try again.`;
    }
    const { channels: list, enabled, send, answer } = next;
    config.handoff = { ...config.handoff, channels: list, enabled: enabled === true, ...(send !== undefined ? { send } : {}), ...(answer !== undefined ? { answer } : {}) };
    return "";
  }
  function storeSecrets(set = [], remove = []) {
    if (!secrets) return "PairBrowse can't save the token from here: restart PairBrowse, then link again.";
    try {
      secrets.update((cur) => {
        let next = cur;
        for (const [name, value] of set) { next = setReservedSecret(next, { name, value }); if (next.error) return next; }
        for (const name of remove) next = deleteSecret(next, name);
        return next;
      });
      return "";
    } catch {
      return "secrets.env couldn't be written. Check that it is yours alone and not a link, then try again.";
    }
  }
  function writeNames(app, entry) {
    const all = shown();
    if (entry) all[app] = entry; else delete all[app];
    try { writeJsonAtomic(linksFile, all, { mode: 0o600 }); } catch (e) { log(`handoff: ${NAMES[app]}'s names not kept (${e?.code || "error"})`); }
  }
  const entryFor = (app) => (app === "telegram"
    ? { type: "telegram", tokenSecret: TELEGRAM.token, chatSecret: TELEGRAM.chat, ...(telegramBase !== TELEGRAM_API ? { server: telegramBase } : {}) }
    : { type: "discord-dm", tokenSecret: DISCORD.token, channelSecret: DISCORD.channel, ...(discordBase !== DISCORD_API ? { server: discordBase } : {}) });
  const isEntry = (app) => (app === "telegram" ? linkedTelegram : linkedDiscord);

  // ---- reading the bots' messages, only in the windows above ----
  function wanted(app) {
    if (stopped) return false;
    if (apps[app].pending) return true;
    return answerOn() && linked(app) && anyAnswerable();
  }
  function sync() {
    // Telegram: one long poll at a time.
    const t = apps.telegram;
    if (wanted("telegram") && !t.loop) {
      const loop = { stopped: false, timer: null };
      t.loop = loop;
      const cycle = async () => {
        if (loop.stopped || !wanted("telegram")) { if (t.loop === loop) t.loop = null; return; }
        const delay = await telegramStep().catch(() => 5000);
        if (loop.stopped) return;
        loop.timer = unref(timers.set(cycle, delay));
      };
      cycle();
    } else if (!wanted("telegram") && t.loop) {
      t.loop.stopped = true;
      if (t.loop.timer) timers.clear(t.loop.timer);
      t.loop = null;
    }
    // Discord: one Gateway connection, with the token the link or the answers need.
    const d = apps.discord;
    const token = d.pending?.token || saved(DISCORD.token);
    if (wanted("discord") && (!d.gateway || d.gatewayToken !== token)) {
      d.gateway?.close();
      d.gatewayToken = token;
      d.gateway = openGateway({ url: gatewayUrl, token, onDispatch: discordEvent, log, timers, retryMs, ...(connect ? { connect } : {}) });
    } else if (!wanted("discord") && d.gateway) {
      d.gateway.close();
      d.gateway = null;
      d.gatewayToken = "";
    }
  }

  async function telegramStep() {
    const a = apps.telegram;
    const token = a.pending?.token || saved(TELEGRAM.token);
    if (!TELEGRAM_TOKEN.test(token)) return 5000;
    if (a.offsetToken !== token) { a.offsetToken = token; a.offset = 0; }
    const r = await tg.getUpdates(token, a.offset);
    if (!r.ok) {
      if (r.status === 409) {
        a.error = "This bot has a webhook set, so PairBrowse can't read its messages. Remove the bot's webhook (or use another bot), then link again.";
        if (a.pending) endPending("telegram");
        changed();
        return 60_000;
      }
      if (r.status === 401 || r.status === 404) {
        a.error = "Telegram no longer accepts this bot's token. Link again with the bot's current token.";
        if (a.pending) endPending("telegram");
        changed();
        return 60_000;
      }
      return r.retryAfter || 5000;
    }
    for (const u of r.updates.slice(0, 100)) {
      if (Number.isSafeInteger(u?.update_id) && u.update_id >= a.offset) a.offset = u.update_id + 1;
      try { await telegramUpdate(u, token); } catch (e) { log(`handoff: a Telegram update wasn't handled (${e?.code || "error"})`); }
    }
    return r.updates.length ? 0 : quietMs;
  }

  async function telegramUpdate(u, token) {
    const m = u?.message;
    if (plain(m) && typeof m.text === "string" && m.text.length <= 200) {
      const p = apps.telegram.pending;
      const chat = m.chat;
      const from = m.from;
      if (p && p.token === token && chat?.type === "private" && Number.isSafeInteger(chat.id) && from?.id === chat.id && from.is_bot !== true && m.text.trim().toUpperCase() === p.code) {
        await linkTelegram(p, String(chat.id), cleanName(from.first_name || chat.first_name || from.username || ""));
        return;
      }
      const pinned = saved(TELEGRAM.chat);
      if (pinned && !p && String(chat?.id) === pinned && String(from?.id) === pinned) {
        const said = typedAnswer(m.text, "Telegram");
        if (said) await tg.sendMessage(token, pinned, said);
      }
      return;
    }
    const q = u?.callback_query;
    if (plain(q) && typeof q.id === "string" && q.id.length <= 64) {
      const pinned = saved(TELEGRAM.chat);
      // Only the pinned user in the pinned chat: anyone else's press is left unanswered.
      if (!pinned || apps.telegram.pending || String(q.from?.id) !== pinned || String(q.message?.chat?.id) !== pinned) return;
      const m2 = /^pb:([ad]):([A-HJ-NP-Z2-9]{4})$/.exec(String(q.data || ""));
      const said = m2 ? answerCode(m2[2], m2[1] === "a" ? "allow" : "deny", "Telegram") : "That isn't a PairBrowse answer.";
      await tg.answerCallbackQuery(token, q.id, said);
      if (Number.isSafeInteger(q.message?.message_id)) await tg.removeKeyboard(token, pinned, q.message.message_id);
    }
  }

  async function discordEvent(type, d) {
    if (type !== "MESSAGE_CREATE" || !plain(d) || d.guild_id || !plain(d.author) || d.author.bot === true) return;
    const content = typeof d.content === "string" && d.content.length <= 200 ? d.content : "";
    const channel = String(d.channel_id || "");
    const user = String(d.author.id || "");
    if (!DISCORD_ID.test(channel) || !DISCORD_ID.test(user)) return;
    const a = apps.discord;
    const p = a.pending;
    if (p && content.trim().toUpperCase() === p.code) {
      await linkDiscord(p, channel, user, cleanName(d.author.global_name || d.author.username || ""));
      return;
    }
    if (p || channel !== saved(DISCORD.channel) || user !== saved(DISCORD.user)) return;
    const said = typedAnswer(content, "Discord");
    if (said) await dc.send(saved(DISCORD.token), channel, said);
  }

  // ---- answers from chat ----
  function answerCode(given, answer, from) {
    const c = String(given || "").toUpperCase();
    const w = waiting.get(c);
    if (!w || !w.answerable || !answerOn()) return "That approval no longer waits.";
    w.answeredHere = true;
    const ok = approvals()?.answerFromChat?.(w.id, answer, from) === true;
    if (!ok) { w.answeredHere = false; return "That approval no longer waits."; }
    log(`handoff: approval ${c} ${answer === "allow" ? "allowed" : "denied"} from ${from}`);
    return answer === "allow" ? `Approved (${c}).` : `Denied (${c}).`;
  }
  function typedAnswer(text, from) {
    const m = ANSWER.exec(String(text || ""));
    if (!m) return "";
    return answerCode(m[2], m[1].toLowerCase() === "deny" ? "deny" : "allow", from);
  }

  // ---- linking ----
  function endPending(app) {
    const a = apps[app];
    if (a.pending?.timer) timers.clear(a.pending.timer);
    a.pending = null;
    sync();
  }
  function startPending(app, token, bot) {
    endPending(app);
    const a = apps[app];
    const c = `PB-${code(6, random)}`;
    const expiresAt = now() + LINK_MS;
    a.pending = { code: c, expiresAt, token, bot, timer: null };
    a.pending.timer = unref(timers.set(() => {
      if (apps[app].pending?.code !== c) return;
      apps[app].error = "The code expired before it arrived. Link again for a new one.";
      endPending(app);
      log(`handoff: ${NAMES[app]}'s link code expired`);
      changed();
    }, LINK_MS));
    a.error = "";
    sync();
    return a.pending;
  }
  async function finishLink(app, p, set, names, say) {
    const a = apps[app];
    if (a.pending !== p) return;
    const problem = storeSecrets(set) || writeHandoff((h) => ({ ...h, channels: [...h.channels.filter((c) => !isEntry(app)(c)), entryFor(app)], enabled: true }));
    endPending(app);
    if (problem) { a.error = `Not linked: ${problem}`; log(`handoff: ${NAMES[app]} not linked (${problem})`); changed(); return; }
    writeNames(app, names);
    a.error = "";
    log(`handoff: ${NAMES[app]} linked`);
    try { await say(); } catch {}
    changed();
  }
  const linkTelegram = (p, chatId, chat) => finishLink("telegram", p, [[TELEGRAM.token, p.token], [TELEGRAM.chat, chatId]], { bot: p.bot, chat },
    () => tg.sendMessage(p.token, chatId, LINKED));
  const linkDiscord = (p, channel, user, chat) => finishLink("discord", p, [[DISCORD.token, p.token], [DISCORD.channel, channel], [DISCORD.user, user]], { bot: p.bot, chat },
    () => dc.send(p.token, channel, LINKED));

  async function link(app, given) {
    const tokenName = app === "telegram" ? TELEGRAM.token : DISCORD.token;
    const pattern = app === "telegram" ? TELEGRAM_TOKEN : DISCORD_TOKEN;
    if (given !== undefined && given !== null && typeof given !== "string") return { error: "The token is text." };
    const typed = typeof given === "string" ? given.trim() : "";
    const token = typed || saved(tokenName);
    if (!token) return { error: `Paste your bot's token first (${app === "telegram" ? "from @BotFather" : "from the Developer Portal's Bot tab"}).` };
    if (!pattern.test(token)) {
      return { error: app === "telegram" ? "That isn't a Telegram bot token (it looks like 123456789:ABC...). Copy it again from @BotFather." : "That isn't a Discord bot token. Copy it from the Developer Portal: Bot, Reset Token." };
    }
    if (busy) return { error: "A token is being checked already. Wait a moment." };
    busy = true;
    let me;
    try { me = app === "telegram" ? await tg.getMe(token) : await dc.me(token); } finally { busy = false; }
    if (me.error) { apps[app].error = ""; return { error: me.error }; }
    const p = startPending(app, token, cleanName(me.bot));
    log(`handoff: ${NAMES[app]} link started (waiting for the code)`);
    changed();
    const where = app === "telegram" ? `to ${p.bot} in Telegram` : `to ${p.bot} in a direct message on Discord`;
    return { text: `Send ${p.code} ${where} within 10 minutes.`, handoff: read() };
  }
  function cancel(app) {
    if (!apps[app].pending) return { error: `No ${NAMES[app]} link is waiting.` };
    endPending(app);
    apps[app].error = "";
    log(`handoff: ${NAMES[app]} link cancelled`);
    changed();
    return { text: "Cancelled.", handoff: read() };
  }
  function unlink(app) {
    endPending(app);
    const names = app === "telegram" ? [TELEGRAM.token, TELEGRAM.chat] : [DISCORD.token, DISCORD.channel, DISCORD.user];
    const problem = writeHandoff((h) => {
      const list = h.channels.filter((c) => !isEntry(app)(c));
      return { ...h, channels: list, enabled: list.length > 0 && h.enabled === true };
    }) || storeSecrets([], names);
    if (problem) return { error: `Not unlinked: ${problem}` };
    writeNames(app, null);
    apps[app].error = "";
    sync();
    log(`handoff: ${NAMES[app]} unlinked`);
    changed();
    return { text: `${NAMES[app]} unlinked.`, handoff: read() };
  }
  async function test(app) {
    if (!linked(app)) return { error: `Link ${NAMES[app]} first.` };
    const built = buildSenders([entryFor(app)], { secret: (n) => values()[n], post });
    if (!built.senders.length) return { error: `${NAMES[app]} can't be used: link it again.` };
    const r = await built.senders[0].send({ kind: "test" }).catch(() => ({ ok: false, error: "error" }));
    if (!r?.ok) return { error: `${NAMES[app]} didn't take the test message (${String(r?.error || "error").slice(0, 80)}).` };
    log(`handoff: test sent to ${NAMES[app]}`);
    return { text: `Sent. Check ${NAMES[app]}.`, handoff: read() };
  }
  function set(given) {
    const out = {};
    if (given.answer !== undefined) {
      if (typeof given.answer !== "boolean") return { error: "answer is true or false." };
      out.answer = given.answer;
    }
    if (given.send !== undefined) {
      if (!plain(given.send)) return { error: "send is { approvals, checks, submits, runs }." };
      for (const [k, v] of Object.entries(given.send)) {
        if (!SEND_GROUPS.includes(k) || typeof v !== "boolean") return { error: `send takes ${SEND_GROUPS.join(", ")}, each true or false.` };
      }
      out.send = given.send;
    }
    if (!Object.keys(out).length) return { error: "Nothing to change." };
    const problem = writeHandoff((h) => ({
      ...h,
      ...(out.send ? { send: Object.fromEntries(SEND_GROUPS.map((g) => [g, typeof out.send[g] === "boolean" ? out.send[g] : handoffWants({ handoff: h }, g)])) } : {}),
      ...(out.answer !== undefined ? { answer: out.answer } : {}),
    }));
    if (problem) return { error: `Not saved: ${problem}` };
    sync();
    log("handoff: what goes to your phone changed (from Settings)");
    changed();
    return { text: "Saved.", handoff: read() };
  }

  // POST handoff: one op. -> { text, handoff } or { error }.
  async function op(given) {
    if (!plain(given)) return { error: "Not an op." };
    const which = given.op;
    if (which === "set") return set(given);
    if (!["link", "cancel", "unlink", "test"].includes(which)) return { error: "op is link, cancel, unlink, test or set." };
    if (!APPS.includes(given.app)) return { error: "app is telegram or discord." };
    if (which === "link") return link(given.app, given.token);
    if (which === "cancel") return cancel(given.app);
    if (which === "unlink") return unlink(given.app);
    return test(given.app);
  }

  // ---- approvals and runs as messages ----
  function onAsk(item) {
    const info = approvals()?.chatInfo?.(item?.id);
    if (!info || !sends() || !handoffWants(config, "approvals")) return;
    let c;
    do c = code(4, random); while (waiting.has(c));
    const answerable = info.answerable === true && answerOn() && (linked("telegram") || linked("discord"));
    waiting.set(c, { id: item.id, answerable, answeredHere: false });
    codeOf.set(item.id, c);
    sync();
    Promise.resolve(notifier.send({ kind: "approval", code: c, host: info.host, action: info.action, expiresAt: info.expiresAt, ...(answerable ? { answer: true } : {}) })).catch(() => {});
  }
  function onEnd(item) {
    const c = codeOf.get(item?.id);
    if (!c) return;
    codeOf.delete(item.id);
    const w = waiting.get(c);
    waiting.delete(c);
    sync();
    if (w?.answeredHere) return; // the chat that answered was told already
    const outcome = item.answer === "allow" ? "allowed" : item.answer === "deny" ? "denied" : "ended";
    Promise.resolve(notifier.send({ kind: "approval-ended", code: c, outcome })).catch(() => {});
  }
  // Called once the click approvals exist (daemon.mjs).
  function attach(clickApprovals) {
    unwatch?.();
    unwatch = clickApprovals?.onChange?.((change) => {
      if (change?.op === "add" && !change.item?.from) onAsk(change.item);
      else if (change?.op === "withdraw") onEnd(change.item);
    }) || null;
  }
  // A fast-mode run finished (serve/tools/run.mjs): { url, outcome, steps }.
  function runDone({ url, outcome, steps }) {
    const host = urlHost(url);
    if (!host || !HOST.test(host) || !sends() || !handoffWants(config, "runs")) return null;
    return Promise.resolve(notifier.send({ kind: "run", host, outcome, steps: Math.max(0, Math.min(100_000, Number(steps) | 0)) })).catch(() => null);
  }

  return {
    read, op, changed, attach, runDone,
    onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    // A step handed to the person goes to the phone only when its group is on (yourturn.mjs).
    wantsAction: (action) => handoffWants(config, actionGroup(action)),
    // A linked chat is a place to answer this approval (approvals.mjs surface).
    canAnswer: () => answerOn() && sends() && handoffWants(config, "approvals") && (linked("telegram") || linked("discord")),
    reading: () => ({ telegram: !!apps.telegram.loop, discord: !!apps.discord.gateway }),
    stop() {
      stopped = true;
      for (const app of APPS) { if (apps[app].pending?.timer) timers.clear(apps[app].pending.timer); apps[app].pending = null; }
      unwatch?.();
      sync();
    },
  };
}
