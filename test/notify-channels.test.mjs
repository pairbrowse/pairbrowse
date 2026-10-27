// Hand-off messages (scripts/daemon/notify/, spec server-mode B6, B7, decision 8): one sender
// interface built from handoff.channels through a table; each of webhook, ntfy, Telegram, Discord
// and Slack sends its own request shape (here to a loopback stub), https only but for loopback, no
// redirect followed, bounded, one retry on a 5xx or a network error and none on a 4xx; a message
// carries a fixed sentence, the host, the expiry and the link, and nothing else; credentials are
// reserved secrets, never in a warning, a result or a log line.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { SENDERS, buildSenders, createNotifier, handoffSends } from "../scripts/daemon/notify/index.mjs";
import { ACTIONS, END_REASONS, LINK_MAX, MESSAGE_KINDS, actionSentence, messageProblem, messageText } from "../scripts/daemon/notify/message.mjs";
import { httpsPost, addressProblem, isLoopbackHost } from "../scripts/daemon/notify/post.mjs";
import { ntfyWithholds } from "../scripts/daemon/notify/ntfy.mjs";
import discord from "../scripts/daemon/notify/discord.mjs";
import { CHANNEL_TYPES, DETAILS } from "../scripts/daemon/audit.mjs";

// A loopback stub: records each request; answer(req, n) gives [status, body, headers] or null (never answer).
async function stub(answer = () => [200, "ok"]) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const a = answer(req, seen.length);
      if (!a) return; // hangs
      res.writeHead(a[0], a[2] || {});
      res.end(a[1] ?? "");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { seen, base, close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); } };
}

const fast = (opts = {}) => (url, body, o) => httpsPost(url, body, { ...o, timeoutMs: 1000, retryMs: 10, ...opts });
const TOKEN = `123456789:${"A".repeat(35)}`;
const turn = (over = {}) => ({ kind: "turn", id: "3fa1c2d9", action: "login", host: "accounts.example.com", link: "https://pb.example.ts.net/0123abcd/", expiresAt: Date.UTC(2026, 9, 20, 14, 35), ...over });
const secretsOf = (values) => (name) => values[name];
const network = (over = {}) => ({ kind: "network", network: "us-east", change: "changed", paused: true, at: Date.UTC(2026, 9, 20, 14, 35), ...over });

test("each of webhook, ntfy, telegram, discord, slack sends its own request shape", async () => {
  const s = await stub((req) => (req.url.endsWith("/sendMessage") ? [200, '{"ok":true}'] : req.url.startsWith("/discord") ? [204, ""] : [200, "ok"]));
  try {
    const secrets = {
      PAIRBROWSE_WEBHOOK_URL: `${s.base}/hook?x=1`, PAIRBROWSE_NTFY_TOPIC: "pb_topic-1", PAIRBROWSE_NTFY_TOKEN: "tk_secrettoken",
      PAIRBROWSE_TELEGRAM_TOKEN: TOKEN, PAIRBROWSE_TELEGRAM_CHAT: "-1001234567", PAIRBROWSE_DISCORD_WEBHOOK: `${s.base}/discord/1/abc`,
      PAIRBROWSE_SLACK_WEBHOOK: `${s.base}/slack/T/B/x`,
    };
    const channels = [
      { type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" },
      { type: "ntfy", server: s.base, topicSecret: "PAIRBROWSE_NTFY_TOPIC", tokenSecret: "PAIRBROWSE_NTFY_TOKEN", link: "auto" },
      { type: "telegram", server: s.base, tokenSecret: "PAIRBROWSE_TELEGRAM_TOKEN", chatSecret: "PAIRBROWSE_TELEGRAM_CHAT" },
      { type: "discord", urlSecret: "PAIRBROWSE_DISCORD_WEBHOOK" },
      { type: "slack", urlSecret: "PAIRBROWSE_SLACK_WEBHOOK" },
    ];
    const lines = [];
    const n = createNotifier({ channels, secret: secretsOf(secrets), post: fast(), log: (l) => lines.push(l) });
    assert.deepEqual(n.warnings(), []);
    assert.deepEqual(n.usable().map((x) => x.type), ["webhook", "ntfy", "telegram", "discord", "slack"]);
    const r = await n.send(turn());
    assert.deepEqual(r, { sent: ["webhook", "ntfy", "telegram", "discord", "slack"], failed: [], withheld: [] });
    assert.deepEqual(lines, []);
    const by = (p) => s.seen.find((x) => x.url.startsWith(p));
    for (const x of s.seen) { assert.equal(x.method, "POST"); assert.equal(x.headers["user-agent"], "PairBrowse"); }

    const hook = by("/hook");
    assert.equal(hook.url, "/hook?x=1");
    assert.equal(hook.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(hook.body), { event: "pairbrowse.turn", id: "3fa1c2d9", kind: "login", host: "accounts.example.com",
      link: "https://pb.example.ts.net/0123abcd/", expiresAt: "2026-10-20T14:35:00.000Z", reason: null });

    const ntfy = by("/pb_topic-1");
    assert.equal(ntfy.headers["x-title"], "PairBrowse needs you");
    assert.equal(ntfy.headers["x-priority"], "4");
    assert.equal(ntfy.headers["x-tags"], "pairbrowse");
    assert.equal(ntfy.headers["x-click"], "https://pb.example.ts.net/0123abcd/");
    assert.equal(ntfy.headers.authorization, "Bearer tk_secrettoken");
    assert.equal(ntfy.body, "Sign in on accounts.example.com.\nTake over before 14:35 UTC: https://pb.example.ts.net/0123abcd/");

    const tg = by(`/bot${TOKEN}/sendMessage`);
    assert.deepEqual(JSON.parse(tg.body), { chat_id: "-1001234567", text: `PairBrowse needs you\n${ntfy.body}`, link_preview_options: { is_disabled: true } });

    const dc = by("/discord/1/abc");
    assert.deepEqual(JSON.parse(dc.body), { content: `**PairBrowse needs you**\n${ntfy.body}`, flags: 4, allowed_mentions: { parse: [] } });

    const sl = by("/slack/T/B/x");
    assert.deepEqual(JSON.parse(sl.body), { text: `PairBrowse needs you\n${ntfy.body}`, unfurl_links: false, unfurl_media: false });

    // An ended message: no link, its reason, ntfy at default priority.
    s.seen.length = 0;
    assert.deepEqual((await n.send({ ...turn({ kind: "ended", link: null }), reason: "expired" })).sent.length, 5);
    assert.deepEqual(JSON.parse(by("/hook").body).event, "pairbrowse.ended");
    assert.equal(by("/pb_topic-1").headers["x-priority"], "3");
    assert.equal(by("/pb_topic-1").headers["x-click"], undefined);
    assert.equal(by("/pb_topic-1").body, "The hand-off on accounts.example.com ended: nobody finished the step in time. Progress is saved, and the agent stops there.");

    // A proxy's exit (C8): the proxy's id and what happened, no link, ntfy at a step's priority.
    s.seen.length = 0;
    assert.deepEqual(await n.send(network()), { sent: ["webhook", "ntfy", "telegram", "discord", "slack"], failed: [], withheld: [] });
    assert.deepEqual(JSON.parse(by("/hook").body), { event: "pairbrowse.network", network: "us-east", change: "changed", paused: true, at: "2026-10-20T14:35:00.000Z" });
    assert.equal(by("/pb_topic-1").headers["x-title"], "PairBrowse: proxy exit changed");
    assert.equal(by("/pb_topic-1").headers["x-priority"], "4");
    assert.equal(by("/pb_topic-1").headers["x-click"], undefined);
    assert.equal(by("/pb_topic-1").body, 'The exit address of proxy "us-east" changed at 14:35 UTC.\nAgents are paused until you resume them in PairBrowse.');
    assert.equal(JSON.parse(by(`/bot${TOKEN}/sendMessage`).body).text, `PairBrowse: proxy exit changed\n${by("/pb_topic-1").body}`);
  } finally {
    await s.close();
  }
});

test("https only, but for loopback: a plain http address to another computer is refused before any request", async () => {
  for (const u of ["http://example.com/x", "ftp://example.com/", "file:///etc/passwd", "not a url", "https://user:pw@example.com/"]) assert.notEqual(addressProblem(u), "", u);
  for (const u of ["https://example.com/x", "http://127.0.0.1:9/x", "http://localhost/x", "http://[::1]:8/x"]) assert.equal(addressProblem(u), "", u);
  assert.equal(isLoopbackHost("127.255.0.1"), true);
  assert.equal(isLoopbackHost("127.0.0.1.example.com"), false);
  let asked = 0;
  const r = await httpsPost("http://hooks.example.com/abc", "{}", { request: () => { asked++; throw new Error("no"); } });
  assert.deepEqual(r, { ok: false, error: "the address is plain http to another computer (use https)" });
  assert.equal(asked, 0);
  // As a channel: skipped, the warning names the secret, never its value.
  const { senders, warnings } = buildSenders([{ type: "slack", urlSecret: "PAIRBROWSE_SLACK" }, { type: "ntfy", server: "http://ntfy.example.com", topicSecret: "PAIRBROWSE_T" }],
    { secret: secretsOf({ PAIRBROWSE_SLACK: "http://hooks.slack.example/T/B/secretpart", PAIRBROWSE_T: "topic" }) });
  assert.equal(senders.length, 0);
  assert.deepEqual(warnings, [
    "handoff.channels[0] (slack): PAIRBROWSE_SLACK is plain http to another computer (use https); this channel is skipped",
    "handoff.channels[1] (ntfy): server is plain http to another computer (use https); this channel is skipped",
  ]);
});

test("no redirect is followed; a 4xx is not tried again; a 5xx or a network error once more; every try bounded", async () => {
  let s = await stub(() => [302, "", { location: "https://elsewhere.example/" }]);
  try {
    assert.deepEqual(await httpsPost(`${s.base}/a`, "x", { retryMs: 10 }), { ok: false, status: 302, error: "redirect refused (HTTP 302)" });
    assert.equal(s.seen.length, 1);
  } finally { await s.close(); }

  s = await stub(() => [404, "nope"]);
  try {
    assert.deepEqual(await httpsPost(`${s.base}/a`, "x", { retryMs: 10 }), { ok: false, status: 404, error: "HTTP 404" });
    assert.equal(s.seen.length, 1);
  } finally { await s.close(); }

  s = await stub((req, n) => (n === 1 ? [503, ""] : [200, "ok"]));
  try {
    const waits = [];
    assert.deepEqual(await httpsPost(`${s.base}/a`, "x", { wait: async (ms) => { waits.push(ms); } }), { ok: true, status: 200 });
    assert.equal(s.seen.length, 2);
    assert.deepEqual(waits, [5000], "one retry, after 5 s");
  } finally { await s.close(); }

  s = await stub(() => [500, ""]);
  try {
    assert.deepEqual(await httpsPost(`${s.base}/a`, "x", { retryMs: 10 }), { ok: false, status: 500, error: "HTTP 500" });
    assert.equal(s.seen.length, 2, "two tries, no more");
  } finally { await s.close(); }

  // An endpoint that never answers: each try ends at its bound, and the result says so.
  s = await stub(() => null);
  try {
    const t0 = Date.now();
    assert.deepEqual(await httpsPost(`${s.base}/a`, "x", { timeoutMs: 150, retryMs: 10 }), { ok: false, error: "timed out" });
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(s.seen.length, 2);
  } finally { await s.close(); }

  // Nothing listening: a network error by its code, tried twice; no address in it.
  const r = await httpsPost("http://127.0.0.1:1/secret-path", "x", { retryMs: 10 });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.error, /secret-path|127\.0\.0\.1/);

  // A huge answer is cut off, not read whole.
  s = await stub(() => [200, "x".repeat(2 * 1024 * 1024)]);
  try { assert.equal((await httpsPost(`${s.base}/a`, "x")).ok, true); } finally { await s.close(); }
});

test("a sender added to the table is called through the same interface", async () => {
  const got = [];
  const pager = {
    type: "pager",
    fields: { keySecret: { secret: true, required: true, pattern: /^[a-z]+$/, what: "letters" } },
    create: (channel, { secret, messageText: text }) => ({
      type: "pager",
      describe: () => `pager (${channel.keySecret})`,
      send: async (m) => { got.push({ key: secret(channel.keySecret), ...text(m) }); return { ok: true, link: true }; },
    }),
  };
  const table = { ...SENDERS, pager };
  const n = createNotifier({ channels: () => [{ type: "pager", keySecret: "PAIRBROWSE_PAGER" }], secret: secretsOf({ PAIRBROWSE_PAGER: "abcd" }), table });
  assert.deepEqual(n.describe(), ["pager (PAIRBROWSE_PAGER)"]);
  assert.deepEqual(await n.send(turn({ action: "payment" })), { sent: ["pager"], failed: [], withheld: [] });
  assert.equal(got[0].key, "abcd");
  assert.match(got[0].text, /^Approve a payment on accounts\.example\.com\./);
  // A sender that throws or hangs fails alone, bounded.
  const bad = { type: "bad", fields: {}, create: () => ({ type: "bad", describe: () => "bad", send: async () => { throw Object.assign(new Error("x"), { code: "EBAD" }); } }) };
  const slow = { type: "slow", fields: {}, create: () => ({ type: "slow", describe: () => "slow", send: () => new Promise(() => {}) }) };
  const m = createNotifier({ channels: [{ type: "bad" }, { type: "slow" }, { type: "pager", keySecret: "PAIRBROWSE_PAGER" }], secret: secretsOf({ PAIRBROWSE_PAGER: "abcd" }),
    table: { ...table, bad, slow }, sendMaxMs: 100 });
  assert.deepEqual(await m.send(turn()), { sent: ["pager"], failed: [{ type: "bad", error: "EBAD" }, { type: "slow", error: "timed out" }], withheld: [] });
  // The audit's channel words are the table's types.
  assert.deepEqual(Object.keys(SENDERS), CHANNEL_TYPES);
});

test("a message holds the step's sentence, the host, the expiry and the link, nothing else", async () => {
  // The sentences per step kind (B7).
  assert.deepEqual(ACTIONS.map((a) => actionSentence(a, "x.example")), [
    "Sign in on x.example", "Complete a verification on x.example", "Enter a 2FA code on x.example", "Approve a payment on x.example", "Take a step on x.example"]);
  // The audit's vocabulary agrees.
  assert.deepEqual(DETAILS.minted.filter((w) => w !== "replacement").sort(), [...ACTIONS].sort());
  assert.deepEqual(DETAILS.ended, END_REASONS);
  assert.deepEqual(MESSAGE_KINDS, ["turn", "reminder", "ended", "network", "approval", "approval-ended", "run", "test"]);

  // Any other field, or a value outside its rule, refuses the whole message and nothing is sent.
  const sent = [];
  const pager = { type: "pager", fields: {}, create: () => ({ type: "pager", describe: () => "", send: async (m) => { sent.push(m); return { ok: true }; } }) };
  const lines = [];
  const n = createNotifier({ channels: [{ type: "pager" }], secret: () => undefined, table: { pager }, log: (l) => lines.push(l) });
  const bad = [
    turn({ say: "the agent's own words: password hunter2" }), turn({ text: "4111 1111 1111 1111" }), turn({ code: "123456" }), turn({ page: "page text" }),
    turn({ host: "evil.example/ your code is 123456" }), turn({ host: "a b" }), turn({ action: "enter the code 123456" }), turn({ id: "not-an-id" }),
    turn({ link: "javascript:alert(1)" }), turn({ link: "https://x.example/ code 123456" }), turn({ expiresAt: "soon" }), turn({ expiresAt: 1e20 }), turn({ expiresAt: 8.64e15 + 1 }),
    turn({ link: `https://x.example/${"a".repeat(LINK_MAX)}` }), turn({ kind: "chat" }),
    turn({ reason: "done" }), turn({ kind: "ended", link: null, reason: "because the agent said so" }), turn({ kind: "ended", reason: "done" }), null, [],
  ];
  for (const m of bad) {
    const r = await n.send(m);
    assert.ok(r.error, JSON.stringify(m));
  }
  assert.equal(sent.length, 0);
  assert.ok(lines.every((l) => !/hunter2|4111|123456|page text/.test(l)), "refusals name fields, never values");

  assert.equal(messageProblem(turn({ expiresAt: 8.64e15 })), "", "the last time a Date holds");

  // The longest message it accepts (a restart turn, the longest sentence, a 260-character host,
  // a link of LINK_MAX) still fits Discord's 2000 characters whole; one over is refused, never cut.
  const longest = turn({ reason: "browser-restarted", action: "captcha", host: `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.example`.slice(0, 260) });
  longest.link = `https://x.example/${"a".repeat(LINK_MAX - 18)}`;
  assert.equal(longest.host.length, 260);
  assert.equal(longest.link.length, LINK_MAX);
  assert.equal(messageProblem(longest), "");
  const posts = [];
  const dc = discord.create({ urlSecret: "PAIRBROWSE_D" }, { secret: () => "https://discord.example/api/webhooks/1/abc", post: async (url, body) => { posts.push(body); return { ok: true, status: 204 }; }, messageText });
  assert.deepEqual(await dc.send(longest), { ok: true, status: 204, link: true });
  const content = JSON.parse(posts[0]).content;
  assert.ok(content.length <= 2000, String(content.length));
  assert.ok(content.endsWith(longest.link), "the whole link");
  const over = discord.create({ urlSecret: "PAIRBROWSE_D" }, { secret: () => "https://discord.example/api/webhooks/1/abc", post: async () => { throw new Error("never posted"); }, messageText: () => ({ title: "t", text: "x".repeat(2000) }) });
  assert.deepEqual(await over.send(turn()), { ok: false, error: "the message is over Discord's 2000 characters" });

  // What every channel's text can hold: these lines only.
  const t = messageText(turn());
  assert.deepEqual(t, { title: "PairBrowse needs you", text: "Sign in on accounts.example.com.\nTake over before 14:35 UTC: https://pb.example.ts.net/0123abcd/" });
  assert.equal(messageText(turn({ kind: "reminder", link: null, action: "2fa" })).text, "Reminder: Enter a 2FA code on accounts.example.com.\nThe link was opened already; the step stays open until 14:35 UTC.");
  assert.equal(messageText(turn({ reason: "browser-restarted", action: "captcha" })).text, "The browser restarted; use this new link.\nComplete a verification on accounts.example.com.\nTake over before 14:35 UTC: https://pb.example.ts.net/0123abcd/");
  assert.equal(messageText(turn(), { withheld: true }).text, "Sign in on accounts.example.com.\nTake over in PairBrowse's live view before 14:35 UTC (this channel doesn't get the link).");
  for (const reason of END_REASONS) {
    const m = { ...turn({ kind: "ended", link: null }), reason };
    assert.equal(messageProblem(m), "", reason);
    assert.match(messageText(m).text, /^The hand-off on accounts\.example\.com ended: [A-Z]?[a-z]/);
  }
});

test("a network message (C8) names the proxy and what happened, nothing else: no session, address, country or reason", async () => {
  assert.equal(messageProblem(network()), "");
  assert.equal(messageProblem(network({ change: "failed", paused: false })), "");
  const bad = [
    network({ session: "shop" }), network({ ip: "203.0.113.77" }), network({ loc: "US" }), network({ reason: "The proxy's exit address changed." }),
    network({ link: "https://pb.example.ts.net/x/" }), network({ id: "3fa1c2d9" }), network({ network: "US-EAST" }), network({ network: "a b" }),
    network({ network: "x".repeat(35) }), network({ change: "moved" }), network({ paused: "yes" }), network({ at: "now" }), network({ at: 8.64e15 + 1 }),
    turn({ kind: "network" }),
  ];
  for (const m of bad) assert.notEqual(messageProblem(m), "", JSON.stringify(m));
  assert.ok(!/203\.0\.113\.77|shop|US"/.test(bad.map(messageProblem).join(" ")), "refusals name fields, never values");
  assert.deepEqual(messageText(network({ change: "failed", paused: false })), { title: "PairBrowse: proxy check failed",
    text: 'Proxy "us-east" failed its recheck at 14:35 UTC; nothing went around it.\nAgents go on.' });
});

test("ntfy: on public ntfy.sh without a token the link stays out (link auto); always and never as written", async () => {
  const seen = [];
  const post = async (url, body, { headers }) => { seen.push({ url, body, headers }); return { ok: true, status: 200 }; };
  const secret = secretsOf({ PAIRBROWSE_NTFY_TOPIC: "my_topic", PAIRBROWSE_NTFY_TOKEN: "tk_abc" });
  const n = createNotifier({ channels: [{ type: "ntfy", topicSecret: "PAIRBROWSE_NTFY_TOPIC" }], secret, post });
  assert.deepEqual(n.describe(), ["ntfy on https://ntfy.sh (PAIRBROWSE_NTFY_TOPIC), without the link"]);
  assert.deepEqual(await n.send(turn()), { sent: ["ntfy"], failed: [], withheld: ["ntfy"] });
  assert.equal(seen[0].url, "https://ntfy.sh/my_topic");
  assert.equal(seen[0].headers["x-click"], undefined);
  assert.equal(seen[0].headers.authorization, undefined);
  assert.doesNotMatch(seen[0].body, /pb\.example|0123abcd/);
  assert.match(seen[0].body, /live view/);
  assert.equal(ntfyWithholds({ topicSecret: "PAIRBROWSE_T", tokenSecret: "PAIRBROWSE_K" }), false, "a token: a private topic");
  assert.equal(ntfyWithholds({ server: "https://ntfy.example.com" }), false, "your own server");
  assert.equal(ntfyWithholds({ link: "always" }), false);
  assert.equal(ntfyWithholds({ server: "https://ntfy.example.com", link: "never" }), true);
  // With a token on ntfy.sh, the link goes with the bearer token.
  seen.length = 0;
  const m = createNotifier({ channels: [{ type: "ntfy", topicSecret: "PAIRBROWSE_NTFY_TOPIC", tokenSecret: "PAIRBROWSE_NTFY_TOKEN" }], secret, post });
  assert.deepEqual(await m.send(turn()), { sent: ["ntfy"], failed: [], withheld: [] });
  assert.equal(seen[0].headers["x-click"], "https://pb.example.ts.net/0123abcd/");
  assert.equal(seen[0].headers.authorization, "Bearer tk_abc");
});

test("a channel that can't be used is skipped with a warning naming it, never a value; secrets are read at each send", async () => {
  const values = { PAIRBROWSE_TG: TOKEN, PAIRBROWSE_CHAT: "not a chat", SHOPIFY_PASSWORD: "https://hooks.example.com/x" };
  const channels = [
    { type: "pigeon" }, "webhook", { type: "webhook", urlSecret: "SHOPIFY_PASSWORD" }, { type: "webhook", url: "https://hooks.example.com/x" },
    { type: "discord", urlSecret: "PAIRBROWSE_MISSING" }, { type: "telegram", tokenSecret: "PAIRBROWSE_TG", chatSecret: "PAIRBROWSE_CHAT" },
    { type: "ntfy", topicSecret: "PAIRBROWSE_TG" }, { type: "ntfy", topicSecret: "PAIRBROWSE_T2", link: "sometimes" }, { type: "slack", urlSecret: "PAIRBROWSE_S", extra: 1 },
  ];
  values.PAIRBROWSE_T2 = "t2";
  values.PAIRBROWSE_S = "https://hooks.slack.com/services/T/B/x";
  const lines = [];
  const n = createNotifier({ channels, secret: (k) => values[k], post: async () => ({ ok: true, status: 200 }), log: (l) => lines.push(l) });
  const w = n.warnings();
  assert.deepEqual(w, [
    'handoff.channels[0]: unknown type "pigeon" (webhook, ntfy, telegram, discord, slack, discord-dm); this channel is skipped',
    "handoff.channels[1]: no type (webhook, ntfy, telegram, discord, slack, discord-dm); this channel is skipped",
    "handoff.channels[2] (webhook): urlSecret isn't a secret name starting with PAIRBROWSE_ (credentials live in secrets.env, never in config.json); this channel is skipped",
    'handoff.channels[3] (webhook): unknown field "url" (not used)',
    "handoff.channels[3] (webhook): urlSecret (a PAIRBROWSE_ secret's name) is missing; this channel is skipped",
    "handoff.channels[4] (discord): PAIRBROWSE_MISSING isn't saved in secrets.env; this channel is skipped",
    "handoff.channels[5] (telegram): PAIRBROWSE_CHAT isn't a chat id (a number) or @channelname; this channel is skipped",
    "handoff.channels[6] (ntfy): PAIRBROWSE_TG isn't a topic name (letters, digits, - and _, up to 64); this channel is skipped",
    'handoff.channels[7] (ntfy): link is "auto", "always" or "never"; this channel is skipped',
    'handoff.channels[8] (slack): unknown field "extra" (not used)',
  ]);
  for (const v of Object.values(values)) assert.ok(!w.join("\n").includes(v), "no secret value in a warning");
  assert.deepEqual(n.usable().map((s) => s.type), ["slack"]);
  // A secret saved later counts from the next send; one removed fails that channel, by name.
  values.PAIRBROWSE_MISSING = "https://discord.com/api/webhooks/1/abc";
  assert.deepEqual((await n.send(turn())).sent, ["discord", "slack"]);
  const s = buildSenders([{ type: "slack", urlSecret: "PAIRBROWSE_S" }], { secret: (k) => values[k], post: async () => ({ ok: true }) }).senders[0];
  delete values.PAIRBROWSE_S;
  assert.deepEqual(await s.send(turn()), { ok: false, error: "PAIRBROWSE_S isn't saved in secrets.env" });
  // Each warning logged once while it stays.
  n.warnings();
  const before = lines.length;
  n.warnings();
  n.warnings();
  assert.equal(lines.length, before);
  assert.equal(lines.filter((l) => l.includes("channels[0]")).length, 1);
  assert.ok(lines.every((l) => l.startsWith("hand-off: ")));
});

test("hand-offs go to channels whenever enabled: on a desktop while a channel can be used, on a server always; handoff.away is no longer read", () => {
  assert.equal(handoffSends({ handoff: { enabled: false, away: true } }, { server: true }), false);
  assert.equal(handoffSends({ handoff: { enabled: true, away: false } }, { server: false }), true, "a desktop with a channel: the phone too (Away off is ignored)");
  assert.equal(handoffSends({ handoff: { enabled: true, away: false } }, { server: false, usable: 1 }), true);
  assert.equal(handoffSends({ handoff: { enabled: true } }, { server: false, usable: 0 }), false, "a desktop with no usable channel: the window only");
  assert.equal(handoffSends({ handoff: { enabled: true } }, { server: true, usable: 0 }), true, "server mode: always (the result says no channel could be used)");
  assert.equal(handoffSends({}, { server: true }), false);
  assert.equal(handoffSends(undefined), false);
});
