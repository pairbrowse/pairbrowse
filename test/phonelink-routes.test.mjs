// The Handoff page's owner routes (scripts/liveview/routes/handoff.mjs over daemon/phonelink.mjs):
// only the owner's key reads or changes them (invite links 403, a join code 404 and nothing on the
// join port, hand-off grants and every other role never have the right, another origin 403);
// changes reach the owner's streams as a handoff event; a token is in no answer, event or log line.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startLiveView, createInvites, roleMay } from "../scripts/liveview.mjs";
import { createPhoneLink } from "../scripts/daemon/phonelink.mjs";
import { createNotifier } from "../scripts/daemon/notify/index.mjs";
import { SERVER_EVENTS, OWNER_EVENTS } from "../ui/events.js";
import { fakeTelegram, phoneHome, TG_TOKEN } from "./helpers/phonelink-fakes.mjs";

function request(port, method, path, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
function stream(port, key) {
  const seen = [];
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/${key}/events?panel=1`, headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.on("data", (d) => seen.push(d.toString("utf8")));
      resolve({ text: () => seen.join(""), close: () => req.destroy() });
    });
    req.on("error", () => {});
  });
}
const until = async (what, fn) => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); } assert.fail(`timed out waiting for ${what}`); };

async function setup(tg) {
  const h = phoneHome({ handoff: { away: false } });
  const config = { handoff: { enabled: false, away: false, channels: [] } };
  const notifier = createNotifier({ channels: () => config.handoff.channels, secret: (n) => h.secrets.get().values[n] });
  const handoff = createPhoneLink({ config, secrets: h.secrets, notifier, log: h.log, configFile: h.configFile, linksFile: h.linksFile, telegramBase: tg.base, quietMs: 20, pollSeconds: 1 });
  const invites = createInvites();
  const lines = [];
  const v = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, handoff, log: (...a) => lines.push(a.join(" ")) });
  return { h, handoff, invites, v, key: v.url.split("/").at(-2), lines };
}

test("only the owner reads or changes the Handoff page: invite links, joiners, grants and other origins can't", async () => {
  const tg = await fakeTelegram();
  const s = await setup(tg);
  const { v, key, invites } = s;
  try {
    const link = { op: "link", app: "telegram", token: TG_TOKEN };
    for (const role of ["watch", "drive"]) {
      const i = invites.create({ role, label: role });
      assert.equal((await request(v.port, "GET", `/${i.key}/handoff.json`)).status, 403, `${role}: read`);
      assert.equal((await request(v.port, "POST", `/${i.key}/handoff`, { body: link })).status, 403, `${role}: write`);
    }
    const c = invites.create({ role: "drive", label: "C", share: "code" });
    assert.equal((await request(v.port, "GET", `/${c.key}/handoff.json`)).status, 404);
    assert.notEqual((await request(v.guestPort, "GET", `/${c.key}/handoff.json`)).status, 200, "the join port never serves it");
    assert.notEqual((await request(v.guestPort, "POST", `/${c.key}/handoff`, { body: link })).status, 200);
    for (const role of ["drive", "watch", "approve", "turn", "redeem"]) assert.equal(roleMay(role, "handoff"), false, role);
    assert.equal(roleMay("owner", "handoff"), true);
    const cross = await request(v.port, "POST", `/${key}/handoff`, { body: link, headers: { origin: "https://evil.example" } });
    assert.equal(cross.status, 403);
    assert.equal(tg.calls.length, 0, "nothing ran");
    assert.equal(SERVER_EVENTS.handoff.to, "owner");
    assert.ok(OWNER_EVENTS.includes("handoff"));
    // The owner: the summary's shape, then a link.
    const read = JSON.parse((await request(v.port, "GET", `/${key}/handoff.json`)).text);
    assert.deepEqual(read, { on: false, server: false, ready: false, send: { approvals: true, checks: true, submits: true, runs: false }, answer: false, watchCommand: true, watchInMessages: false,
      telegram: { state: "none", bot: "", chat: "" }, discord: { state: "none", bot: "", chat: "" } });
    const bad = await request(v.port, "POST", `/${key}/handoff`, { body: { op: "link", app: "telegram", token: "123" } });
    assert.equal(bad.status, 409);
    assert.match(JSON.parse(bad.text).error, /isn't a Telegram bot token/);
  } finally { s.handoff.stop(); v.close(); await tg.close(); }
});

test("a link from the page: the code in the answer and in a handoff event; linking from the phone sends the event too; the token never comes back", async () => {
  const tg = await fakeTelegram();
  const s = await setup(tg);
  const { v, key } = s;
  const events = await stream(v.port, key);
  try {
    const r = await request(v.port, "POST", `/${key}/handoff`, { body: { op: "link", app: "telegram", token: TG_TOKEN }, headers: { origin: `http://127.0.0.1:${v.port}` } });
    assert.equal(r.status, 200, r.text);
    const body = JSON.parse(r.text);
    assert.equal(body.handoff.telegram.state, "pending");
    await until("the pending event", () => /event: handoff\ndata: .*"pending"/.test(events.text()));
    tg.push(tg.message(555123456, body.handoff.telegram.code));
    await until("the linked event", () => /event: handoff\ndata: .*"linked"/.test(events.text()));
    const set = await request(v.port, "POST", `/${key}/handoff`, { body: { op: "set", answer: true, send: { runs: true } } });
    assert.equal(set.status, 200, set.text);
    assert.equal(JSON.parse(set.text).handoff.answer, true);
    const read = await request(v.port, "GET", `/${key}/handoff.json`);
    assert.equal(JSON.parse(read.text).ready, true);
    for (const [what, text] of [["answer", r.text], ["read", read.text], ["events", events.text()], ["log", [...s.h.lines, ...s.lines].join("\n")]]) {
      assert.ok(!text.includes(TG_TOKEN), `no token in the ${what}`);
      assert.ok(!text.includes("555123456"), `no chat id in the ${what}`);
    }
  } finally { events.close(); s.handoff.stop(); v.close(); await tg.close(); }
});
