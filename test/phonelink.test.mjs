// The Handoff page's helper part (scripts/daemon/phonelink.mjs, phonelink/, notify/discord-dm.mjs):
// linking Telegram and Discord with a one-time code against loopback stand-ins of their APIs (no
// real network), only the pinned chat and user read or answered, reading only while a link or an
// answerable approval waits, tokens never in a summary, an event or a log line, what goes to the
// phone (handoff.send), approval and run messages that carry no page words, and answers from chat
// held to what a joiner with the approve role could answer.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createPhoneLink, LINK_MS } from "../scripts/daemon/phonelink.mjs";
import { createNotifier, handoffWants, actionGroup, SENDERS } from "../scripts/daemon/notify/index.mjs";
import { messageProblem, messageText } from "../scripts/daemon/notify/message.mjs";
import { httpsJson } from "../scripts/daemon/notify/post.mjs";
import { DISCORD_AGENT } from "../scripts/daemon/notify/discord-dm.mjs";
import { createClickApprovals } from "../scripts/daemon/approvals.mjs";
import { loadSecrets } from "../scripts/rules/secrets.mjs";
import { fakeTelegram, fakeDiscord, phoneHome, TG_TOKEN, DC_TOKEN } from "./helpers/phonelink-fakes.mjs";

const CHAT = 555123456;
const USER = "400000000000000004";
const DM = "500000000000000005";
const until = async (what, fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await new Promise((r) => setTimeout(r, 15)); } assert.fail(`timed out waiting for ${what}`); };

// A phone link over a test home and the stand-ins; config is the running config (as loadConfig fills it).
function make(h, { tg, dc, approvals = null, config, timers } = {}) {
  const running = config || { handoff: { enabled: false, away: true, channels: [], ...(h.file().handoff || {}) } };
  const notifier = createNotifier({ channels: () => running.handoff.channels, secret: (n) => h.secrets.get().values[n], log: h.log });
  const events = [];
  const link = createPhoneLink({ config: running, secrets: h.secrets, notifier, approvals: () => approvals, log: h.log, configFile: h.configFile, linksFile: h.linksFile,
    telegramBase: tg?.base || "http://127.0.0.1:9", discordBase: dc?.base || "http://127.0.0.1:9", gatewayUrl: dc?.gateway || "ws://127.0.0.1:9/gateway", quietMs: 20, pollSeconds: 1, retryMs: 200, ...(timers ? { timers } : {}) });
  link.onChange((s) => events.push(s));
  return { link, events, config: running, notifier };
}
const noToken = (what, text) => { for (const t of [TG_TOKEN, DC_TOKEN]) assert.ok(!String(text).includes(t), `no token in ${what}`); };

test("Telegram: a token is checked, a code shown, and only the code sent in a private chat links that chat; nothing is saved before", async () => {
  const tg = await fakeTelegram();
  const h = phoneHome({ name: "kept" });
  const { link, events, config } = make(h, { tg });
  try {
    assert.match((await link.op({ op: "link", app: "telegram", token: "nope" })).error, /isn't a Telegram bot token/);
    assert.match((await link.op({ op: "link", app: "telegram", token: `1:${"x".repeat(30)}` })).error, /didn't accept this token/);
    const r = await link.op({ op: "link", app: "telegram", token: TG_TOKEN });
    const code = r.handoff.telegram.code;
    assert.match(code, /^PB-[A-HJ-NP-Z2-9]{6}$/);
    assert.equal(r.text, `Send ${code} to @pb_test_bot in Telegram within 10 minutes.`);
    assert.deepEqual(Object.keys(r.handoff).sort(), ["answer", "discord", "on", "ready", "send", "server", "telegram", "watchCommand", "watchInMessages"]);
    assert.equal(r.handoff.telegram.state, "pending");
    assert.ok(r.handoff.telegram.expiresAt > Date.now() + LINK_MS - 5000);
    assert.equal(loadSecrets(h.secretsFile).values.PAIRBROWSE_HANDOFF_TELEGRAM_TOKEN, undefined, "nothing saved while the link waits");
    assert.equal(link.reading().telegram, true, "polling while the link waits");
    await until("a poll", () => tg.of("getUpdates").length > 0);
    assert.deepEqual(tg.of("getUpdates")[0].body.allowed_updates, ["message", "callback_query"]);
    // The code in a group, a wrong code, a bot's message: ignored.
    tg.push(tg.message(-100777, code, { type: "group", from: CHAT }));
    tg.push(tg.message(CHAT, "PB-AAAAAA"));
    await until("those read", () => tg.of("getUpdates").length >= 3);
    assert.equal(link.read().telegram.state, "pending");
    tg.push(tg.message(CHAT, ` ${code.toLowerCase()} `));
    await until("linked", () => link.read().telegram.state === "linked");
    const s = link.read();
    assert.deepEqual(s.telegram, { state: "linked", bot: "@pb_test_bot", chat: "Ann" });
    assert.equal(s.ready, true);
    const saved = loadSecrets(h.secretsFile).values;
    assert.equal(saved.PAIRBROWSE_HANDOFF_TELEGRAM_TOKEN, TG_TOKEN);
    assert.equal(saved.PAIRBROWSE_HANDOFF_TELEGRAM_CHAT, String(CHAT));
    assert.equal(statSync(h.secretsFile).mode & 0o777, 0o600);
    const file = h.file();
    assert.equal(file.name, "kept");
    assert.equal(file.handoff.enabled, true);
    assert.deepEqual(file.handoff.channels, [{ type: "telegram", tokenSecret: "PAIRBROWSE_HANDOFF_TELEGRAM_TOKEN", chatSecret: "PAIRBROWSE_HANDOFF_TELEGRAM_CHAT", server: tg.base }]);
    assert.deepEqual(config.handoff.channels, file.handoff.channels, "the running config too");
    await until("the reply", () => tg.of("sendMessage").length === 1);
    const reply = tg.of("sendMessage").at(-1).body;
    assert.equal(reply.chat_id, String(CHAT));
    assert.equal(reply.text, "Linked to PairBrowse.");
    await until("polling stopped", () => !link.reading().telegram);
    // No token or chat id anywhere a person or agent reads.
    for (const [what, text] of [["summary", JSON.stringify(link.read())], ["events", JSON.stringify(events)], ["log", h.lines.join("\n")], ["links file", readFileSync(h.linksFile, "utf8")]]) {
      noToken(what, text);
      assert.ok(!text.includes(String(CHAT)), `no chat id in the ${what}`);
    }
    assert.equal(statSync(h.linksFile).mode & 0o777, 0o600);
    // Send a test: the fixed sentence.
    const t = await link.op({ op: "test", app: "telegram" });
    assert.equal(t.text, "Sent. Check Telegram.");
    assert.match(tg.of("sendMessage").at(-1).body.text, /PairBrowse can reach you here\./);
    // Unlink: the secrets and the entry go, enabled false with no channel left.
    const u = await link.op({ op: "unlink", app: "telegram" });
    assert.equal(u.handoff.telegram.state, "none");
    assert.equal(loadSecrets(h.secretsFile).values.PAIRBROWSE_HANDOFF_TELEGRAM_TOKEN, undefined);
    assert.equal(loadSecrets(h.secretsFile).values.PAIRBROWSE_HANDOFF_TELEGRAM_CHAT, undefined);
    assert.deepEqual(h.file().handoff.channels, []);
    assert.equal(h.file().handoff.enabled, false);
  } finally { link.stop(); await tg.close(); }
});

test("Telegram: a webhook on the bot (409) is said on the page and ends the waiting link; cancel and expiry save nothing", async () => {
  const tg = await fakeTelegram();
  const h = phoneHome();
  let expire = null;
  const timers = { set: (fn, ms) => { if (ms === LINK_MS) { expire = fn; return { unref() {} }; } return setTimeout(fn, ms); }, clear: (t) => clearTimeout(t) };
  const { link } = make(h, { tg, timers });
  try {
    tg.conflict = true;
    await link.op({ op: "link", app: "telegram", token: TG_TOKEN });
    await until("the conflict said", () => /webhook set/.test(link.read().telegram.error || ""));
    assert.equal(link.read().telegram.state, "none");
    assert.equal(link.reading().telegram, false);
    tg.conflict = false;
    await link.op({ op: "link", app: "telegram", token: TG_TOKEN });
    assert.equal((await link.op({ op: "cancel", app: "telegram" })).text, "Cancelled.");
    assert.equal(link.read().telegram.state, "none");
    assert.match((await link.op({ op: "cancel", app: "telegram" })).error, /No Telegram link is waiting/);
    await link.op({ op: "link", app: "telegram", token: TG_TOKEN });
    expire();
    assert.equal(link.read().telegram.state, "none");
    assert.match(link.read().telegram.error, /expired/);
    assert.equal(link.reading().telegram, false);
    assert.equal(loadSecrets(h.secretsFile).values.PAIRBROWSE_HANDOFF_TELEGRAM_TOKEN, undefined);
    assert.match((await link.op({ op: "link", app: "telegram" })).error, /Paste your bot's token first/);
    assert.match((await link.op({ op: "test", app: "telegram" })).error, /Link Telegram first/);
    assert.match((await link.op({ op: "link", app: "matrix" })).error, /app is telegram or discord/);
    assert.match((await link.op({ op: "explode", app: "telegram" })).error, /op is/);
  } finally { link.stop(); await tg.close(); }
});

test("Discord: the token is checked over REST, the code read over the Gateway (DIRECT_MESSAGES only) from a DM, and the DM pinned", async () => {
  const dc = await fakeDiscord();
  const h = phoneHome();
  const { link, events } = make(h, { dc });
  try {
    assert.match((await link.op({ op: "link", app: "discord", token: "abc" })).error, /isn't a Discord bot token/);
    const r = await link.op({ op: "link", app: "discord", token: DC_TOKEN });
    const code = r.handoff.discord.code;
    assert.equal(r.text, `Send ${code} to PB Bot in a direct message on Discord within 10 minutes.`);
    const me = dc.calls.find((c) => c.url === "/users/@me");
    assert.equal(me.headers["user-agent"], DISCORD_AGENT);
    assert.match(DISCORD_AGENT, /^DiscordBot \(https:\/\/pairbrowse\.com, [\w.+-]+\)$/);
    await until("identified", () => dc.identified.length === 1);
    assert.equal(dc.identified[0].token, DC_TOKEN);
    assert.equal(dc.identified[0].intents, 4096);
    assert.deepEqual({ browser: dc.identified[0].properties.browser, device: dc.identified[0].properties.device }, { browser: "PairBrowse", device: "PairBrowse" });
    // In a server channel, from a bot, a wrong code: ignored.
    dc.dispatch("MESSAGE_CREATE", dc.dm(DM, USER, code, { guild_id: "600000000000000006" }));
    dc.dispatch("MESSAGE_CREATE", { ...dc.dm(DM, USER, code), author: { id: USER, username: "x", bot: true } });
    dc.dispatch("MESSAGE_CREATE", dc.dm(DM, USER, "PB-ZZZZZZ"));
    await new Promise((r2) => setTimeout(r2, 100));
    assert.equal(link.read().discord.state, "pending");
    dc.dispatch("MESSAGE_CREATE", dc.dm(DM, USER, code));
    await until("linked", () => link.read().discord.state === "linked");
    assert.deepEqual(link.read().discord, { state: "linked", bot: "PB Bot", chat: "Ann" });
    const saved = loadSecrets(h.secretsFile).values;
    assert.deepEqual([saved.PAIRBROWSE_HANDOFF_DISCORD_TOKEN, saved.PAIRBROWSE_HANDOFF_DISCORD_CHANNEL, saved.PAIRBROWSE_HANDOFF_DISCORD_USER], [DC_TOKEN, DM, USER]);
    assert.deepEqual(h.file().handoff.channels, [{ type: "discord-dm", tokenSecret: "PAIRBROWSE_HANDOFF_DISCORD_TOKEN", channelSecret: "PAIRBROWSE_HANDOFF_DISCORD_CHANNEL", server: dc.base }]);
    await until("the reply", () => dc.posts().length === 1);
    const post = dc.posts().at(-1);
    assert.equal(post.url, `/channels/${DM}/messages`);
    assert.equal(post.body.content, "Linked to PairBrowse.");
    assert.equal(post.headers.authorization, `Bot ${DC_TOKEN}`);
    await until("the gateway closed", () => !link.reading().discord && dc.sockets.size === 0);
    // The discord-dm sender: content, no embeds, no mentions, the bot's own headers.
    const t = await link.op({ op: "test", app: "discord" });
    assert.equal(t.text, "Sent. Check Discord.");
    const sent = dc.posts().at(-1);
    assert.deepEqual(sent.body, { content: "**PairBrowse**\nPairBrowse can reach you here.", flags: 4, allowed_mentions: { parse: [] } });
    assert.equal(sent.headers["user-agent"], DISCORD_AGENT);
    for (const [what, text] of [["summary", JSON.stringify(link.read())], ["events", JSON.stringify(events)], ["log", h.lines.join("\n")]]) {
      noToken(what, text);
      for (const id of [DM, USER]) assert.ok(!text.includes(id), `no id in the ${what}`);
    }
  } finally { link.stop(); await dc.close(); }
});

// Click approvals as the helper has them, with one agent's tab on a shop.
async function approvalsWith(chat) {
  const page = { url: () => "https://shop.example/checkout", isClosed: () => false };
  const ca = createClickApprovals({
    hud: { call: async () => false, sparkColor: () => "#20c997", sparkPage: () => page },
    presence: { byPerson: () => true }, collaboration: { participants: new Map() },
    liveView: () => ({ sharing: () => false, guestViewers: () => 0, pageClients: () => ({}), tabIndex: async () => 0, approveJoiners: () => 0 }),
    frontPage: async () => null, chat, waitMs: 60_000,
    setInterval: () => ({ unref() {} }), clearInterval: () => {},
  });
  ca.participant("p1", { client: "codex", tab: () => page });
  return ca;
}

test("approvals: a card goes to the phone with a code, the host and the click's class; the pinned chat answers it (buttons or typed) only with answering on", async () => {
  const tg = await fakeTelegram();
  const h = phoneHome();
  const held = {};
  const ca = await approvalsWith({ canAnswer: () => held.link.canAnswer() });
  const { link } = make(h, { tg, approvals: ca });
  held.link = link;
  link.attach(ca);
  try {
    // Link first.
    const r = await link.op({ op: "link", app: "telegram", token: TG_TOKEN });
    tg.push(tg.message(CHAT, r.handoff.telegram.code));
    await until("linked", () => link.read().telegram.state === "linked");
    assert.equal(link.canAnswer(), false, "answering from chat is off by default");
    // Off: nowhere to answer, so the ask isn't kept.
    assert.equal((await ca.open({ tool: "browser_click", input: { element: "Pay: Place order", target: "e5" }, ask: { reason: "r", target: "Place order", what: "Pay: Place order" }, participant: "p1", client: "codex" })).shown, false);
    assert.equal((await link.op({ op: "set", answer: true })).handoff.answer, true);
    assert.equal(h.file().handoff.answer, true);
    assert.equal(link.canAnswer(), true);
    const asked = await ca.open({ tool: "browser_click", input: { element: "Pay: Place order", target: "e5" }, ask: { reason: "the agent named it a payment", target: "Place order", what: "Pay: Place order" }, participant: "p1", client: "codex" });
    assert.equal(asked.shown, true, "the linked chat counts as a place to answer");
    await until("the approval message", () => tg.of("sendMessage").some((c) => c.body.reply_markup));
    const msg = tg.of("sendMessage").find((c) => c.body.reply_markup).body;
    const code = /Code ([A-HJ-NP-Z2-9]{4})/.exec(msg.text)[1];
    assert.match(msg.text, /^PairBrowse: approve a final click\?\nApprove a final click on shop\.example\? \(pay\) Code [A-Z2-9]{4}\nTap Approve or Deny/);
    assert.ok(!/Place order|the agent named it/.test(msg.text), "never the element's words or the reason");
    assert.deepEqual(msg.reply_markup.inline_keyboard[0].map((b) => b.callback_data), [`pb:a:${code}`, `pb:d:${code}`]);
    assert.equal(link.reading().telegram, true, "reading while an answerable approval waits");
    // Someone else's press: left unanswered, nothing allowed.
    tg.push(tg.press(CHAT, `pb:a:${code}`, { from: 999999999 }));
    await until("read", () => tg.of("getUpdates").length >= 6);
    assert.equal(tg.of("answerCallbackQuery").length, 0);
    assert.equal(ca.pending().length, 1);
    // The pinned user's press: allowed, the press answered, the keyboard taken off.
    tg.push(tg.press(CHAT, `pb:a:${code}`));
    assert.equal(await asked.answer.then((a) => a), "allow");
    await until("the press answered", () => tg.of("editMessageReplyMarkup").length === 1);
    assert.equal(tg.of("answerCallbackQuery")[0].body.text, `Approved (${code}).`);
    assert.deepEqual(tg.of("editMessageReplyMarkup")[0].body.reply_markup, { inline_keyboard: [] });
    await until("reading stopped", () => !link.reading().telegram);
    // A typed deny for the next one; an approval that ends elsewhere sends a short line.
    const second = await ca.open({ tool: "browser_click", input: { element: "Delete: Remove account", target: "e9" }, ask: { reason: "r", target: "Remove account", what: "Delete: Remove account" }, participant: "p1", client: "codex" });
    await until("the second message", () => tg.of("sendMessage").filter((c) => c.body.reply_markup).length === 2);
    const code2 = /Code ([A-Z2-9]{4})/.exec(tg.of("sendMessage").filter((c) => c.body.reply_markup)[1].body.text)[1];
    assert.match(tg.of("sendMessage").filter((c) => c.body.reply_markup)[1].body.text, /\(delete\)/);
    tg.push(tg.message(CHAT, `deny ${code2.toLowerCase()}`));
    assert.equal(await second.answer, "deny");
    await until("told", () => tg.of("sendMessage").some((c) => c.body.text === `Denied (${code2}).`));
    const third = await ca.open({ tool: "browser_click", input: { element: "Send: Post reply", target: "e2" }, ask: { reason: "r", target: "Post reply", what: "Send: Post reply" }, participant: "p1", client: "codex" });
    await until("the third message", () => tg.of("sendMessage").filter((c) => c.body.reply_markup).length === 3);
    const code3 = /Code ([A-Z2-9]{4})/.exec(tg.of("sendMessage").filter((c) => c.body.reply_markup)[2].body.text)[1];
    ca.answer(third.item.id, "allow", "the page");
    await until("the ended line", () => tg.of("sendMessage").some((c) => c.body.text === `PairBrowse: approval ended\nApproval ${code3} approved.`));
    // A typed answer for a code that no longer waits.
    tg.push(tg.message(CHAT, `approve ${code3}`));
    await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(link.reading().telegram, false, "nothing waits: not reading");
    noToken("log", h.lines.join("\n"));
  } finally { link.stop(); await tg.close(); }
});

test("what goes to the phone: send groups gate approvals, checks, submits and runs; set checks its fields", async () => {
  const h = phoneHome({ handoff: { enabled: true, away: true } });
  const sent = [];
  const config = { handoff: { enabled: true, away: true, channels: [] } };
  const link = createPhoneLink({ config, secrets: h.secrets, notifier: { send: async (m) => { sent.push(m); return { sent: ["webhook"] }; }, usable: () => [{}] }, log: h.log, configFile: h.configFile, linksFile: h.linksFile });
  try {
    assert.deepEqual(link.read().send, { approvals: true, checks: true, submits: true, runs: false });
    assert.equal(link.read().answer, false);
    assert.equal(link.wantsAction("captcha"), true);
    assert.equal(actionGroup("2fa"), "checks");
    assert.equal(actionGroup("payment"), "submits");
    assert.equal(link.runDone({ url: "https://shop.example/cart", outcome: "done", steps: 7 }), null, "runs are off by default");
    assert.match((await link.op({ op: "set", send: { runs: "yes" } })).error, /send takes/);
    assert.match((await link.op({ op: "set", send: { pager: true } })).error, /send takes/);
    assert.match((await link.op({ op: "set", answer: 1 })).error, /answer is true or false/);
    assert.match((await link.op({ op: "set" })).error, /Nothing to change/);
    const r = await link.op({ op: "set", send: { runs: true, checks: false } });
    assert.deepEqual(r.handoff.send, { approvals: true, checks: false, submits: true, runs: true });
    assert.deepEqual(h.file().handoff.send, { approvals: true, checks: false, submits: true, runs: true });
    assert.equal(h.file().handoff.enabled, true, "the rest of handoff kept");
    assert.equal(link.wantsAction("login"), false);
    assert.equal(link.wantsAction("payment"), true);
    await link.runDone({ url: "https://shop.example/cart", outcome: "stopped", steps: 3 });
    assert.deepEqual(sent.at(-1), { kind: "run", host: "shop.example", outcome: "stopped", steps: 3 });
    assert.equal(link.runDone({ url: "about:blank", outcome: "done", steps: 1 }), null, "no site: nothing");
    config.handoff.away = false;
    assert.equal(link.runDone({ url: "https://shop.example/", outcome: "done", steps: 1 }), null, "the hand-off gate holds (not away, not a server)");
    assert.equal(handoffWants({ handoff: {} }, "runs"), false);
  } finally { link.stop(); }
});

test("the new message kinds carry their own fields only; texts never hold more than the code, host, class and expiry", () => {
  const at = Date.UTC(2026, 9, 23, 14, 35);
  assert.equal(messageProblem({ kind: "approval", code: "K7Q2", host: "shop.example", action: "pay", expiresAt: at }), "");
  assert.equal(messageProblem({ kind: "approval", code: "K7Q2", host: "shop.example", action: "pay", expiresAt: at, answer: true }), "");
  assert.match(messageProblem({ kind: "approval", code: "K7Q2", host: "shop.example", action: "pay", expiresAt: at, target: "Place order" }), /no other field/);
  assert.match(messageProblem({ kind: "approval", code: "K0Q2", host: "shop.example", action: "pay", expiresAt: at }), /code/);
  assert.match(messageProblem({ kind: "approval", code: "K7Q2", host: "shop.example", action: "buy", expiresAt: at }), /action/);
  assert.equal(messageProblem({ kind: "approval-ended", code: "K7Q2", outcome: "denied" }), "");
  assert.match(messageProblem({ kind: "approval-ended", code: "K7Q2", outcome: "maybe" }), /outcome/);
  assert.equal(messageProblem({ kind: "run", host: "shop.example", outcome: "failed", steps: 0 }), "");
  assert.match(messageProblem({ kind: "run", host: "shop.example", outcome: "done", steps: 2, why: "the page said no" }), /no other field/);
  assert.equal(messageProblem({ kind: "test" }), "");
  assert.match(messageProblem({ kind: "test", text: "hi" }), /no other field/);
  const ap = { kind: "approval", code: "K7Q2", host: "shop.example", action: "pay", expiresAt: at, answer: true };
  assert.deepEqual(messageText(ap), { title: "PairBrowse: approve a final click?", text: "Approve a final click on shop.example? (pay) Code K7Q2\nAnswer in PairBrowse before 14:35 UTC." });
  assert.equal(messageText(ap, { reply: "typed" }).text.split("\n")[1], 'Reply "approve K7Q2" or "deny K7Q2" before 14:35 UTC.');
  assert.equal(messageText({ kind: "run", host: "a.example", outcome: "done", steps: 1 }).text, "A fast-mode run on a.example finished after 1 step.");
  assert.ok(SENDERS["discord-dm"]);
});

test("httpsJson: bounded, capped, no redirect followed, and https only but for loopback", async () => {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    if (req.url === "/big") { res.writeHead(200); res.end("x".repeat(5000)); return; }
    if (req.url === "/moved") { res.writeHead(302, { location: "https://elsewhere.example/" }); res.end(); return; }
    if (req.url === "/hang") return;
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.deepEqual(await httpsJson(`${base}/`), { ok: true, status: 200, json: { ok: true } });
    assert.equal((await httpsJson(`${base}/big`, { max: 1000 })).error, "the answer is too long");
    assert.match((await httpsJson(`${base}/moved`)).error, /redirect refused/);
    assert.equal((await httpsJson(`${base}/hang`, { timeoutMs: 100 })).error, "timed out");
    assert.match((await httpsJson("http://203.0.113.5/x")).error, /plain http to another computer/);
  } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
});
