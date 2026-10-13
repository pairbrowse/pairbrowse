// The helper routes PairBrowse's redesigned pages need (DESIGN.md Part H, H3), over the live
// view: POST pick while a session is open (the switcher, the new tab page's chips, Settings'
// Delete), GET invites.json and POST invite { op: "revoke" }, and POST report. Each is the owner's
// alone (invite links 403, the join-code port never), bodies are bounded and checked, and open
// pages hear what changed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startLiveView, createInvites } from "../scripts/liveview.mjs";
import { createReporter } from "../scripts/liveview/report.mjs";

function request(port, method, path, { body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers, ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (raw !== undefined) req.write(raw);
    else if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
function readStream(port, path) {
  return new Promise((resolve) => {
    let text = "";
    let ended = false;
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (d) => (text += d));
      res.on("end", () => { ended = true; });
      resolve({ text: () => text, ended: () => ended, close: () => req.destroy() });
    });
    req.on("error", () => {});
  });
}
const eventsIn = (text, name) => text.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, ms = 2000) => { for (let i = 0; i < ms / 20 && !check(); i++) await wait(20); return check(); };

const SAMPLE = {
  schema: "pairbrowse-report/1", createdAt: "2026-10-13T09:10:45.473Z", what: "The switcher said a session is already chosen.",
  app: { host: "pairbrowse", page: "settings", helper: "0.15.45", browser: { engine: "pairbrowse", version: "142.0.7444.59", build: "3" } },
  platform: { os: "macOS", mobile: false, language: "en-US" },
  helperState: { connection: "live", uptime: 7500, agents: 1, viewers: 0, joiners: 1, streams: 2, errors: 1 },
  diagnostics: "PairBrowse diagnostics report\n", tab: null,
};

async function setup({ pick = async () => ({ text: "Opening." }), reporter = null, makeInvite = null } = {}) {
  const picks = [];
  const invites = createInvites();
  const picker = { state: () => ({ picking: false, where: "Local", sessions: [{ name: "work", current: true }] }), pick: async (op) => { picks.push(op); return pick(op); }, open: async () => ({ text: "x" }) };
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, picker, reporter, makeInvite });
  const key = view.url.split("/").at(-2);
  return { view, key, picks, invites };
}

test("POST pick: the owner's only, checked, bounded; 428 asks the page to confirm; open pages hear the sessions", async () => {
  const { view, key, picks, invites } = await setup({ pick: async (op) => (op.confirm ? { text: "Opening." } : { text: "Codex is using the browser.", error: true, confirm: "Codex is using the browser. Switch anyway?", agents: ["Codex"] }) });
  const owner = await readStream(view.port, `/${key}/events?page=picker`);
  const guestKey = invites.create({ role: "drive", label: "D" }).key;
  const guest = await readStream(view.port, `/${guestKey}/events?panel=1`);
  try {
    for (const role of ["watch", "drive"]) assert.equal((await request(view.port, "POST", `/${invites.create({ role, label: role }).key}/pick`, { body: { action: "new" } })).status, 403, role);
    assert.equal((await request(view.port, "POST", `/${"x".repeat(43)}/pick`, { body: { action: "new" } })).status, 404, "a wrong key");
    assert.notEqual((await request(view.guestPort, "POST", `/${key}/pick`, { body: { action: "new" } })).status, 200, "never on the join-code port");
    assert.equal((await request(view.port, "POST", `/${key}/pick`, { body: { action: "new" }, headers: { origin: "https://evil.example" } })).status, 403, "a web page's origin");
    assert.equal(picks.length, 0);
    assert.equal((await request(view.port, "POST", `/${key}/pick`, { raw: "{" })).status, 400);
    assert.equal((await request(view.port, "POST", `/${key}/pick`, { raw: JSON.stringify({ action: "use", name: "work", pad: "x".repeat(3000) }) })).status, 413);
    for (const bad of [{ action: "use" }, { action: "use", name: "work", extra: 1 }, { action: "steal" }, null, [], { action: "delete", name: "../etc" }]) {
      const r = await request(view.port, "POST", `/${key}/pick`, { body: bad });
      assert.equal(r.status, 409, JSON.stringify(bad));
      assert.equal(JSON.parse(r.text).error, true);
    }
    assert.equal(picks.length, 0, "nothing invalid reaches the helper");
    let r = await request(view.port, "POST", `/${key}/pick`, { body: { action: "use", name: "home" } });
    assert.equal(r.status, 428);
    assert.deepEqual(JSON.parse(r.text), { text: "Codex is using the browser.", error: true, confirm: "Codex is using the browser. Switch anyway?", agents: ["Codex"] });
    r = await request(view.port, "POST", `/${key}/pick`, { body: { action: "use", name: "home", confirm: true } });
    assert.equal(r.status, 200);
    assert.deepEqual(picks, [{ action: "use", name: "home" }, { action: "use", name: "home", confirm: true }], "only the fields that action takes");
    assert.ok(await until(() => eventsIn(owner.text(), "sessions").length === 1), "the owner's pages hear the sessions once, after the change");
    assert.deepEqual(eventsIn(owner.text(), "sessions")[0].sessions, [{ name: "work", current: true }]);
    assert.equal(eventsIn(guest.text(), "sessions").length, 0, "never a guest");
  } finally { owner.close(); guest.close(); view.close(); }
});

test("a refused pick answers 409 with the helper's sentence and changes nothing", async () => {
  const { view, key } = await setup({ pick: async () => ({ text: "People are in this session; switch once they have left.", error: true }) });
  const owner = await readStream(view.port, `/${key}/events?panel=1`);
  try {
    const r = await request(view.port, "POST", `/${key}/pick`, { body: { action: "delete", name: "old" } });
    assert.equal(r.status, 409);
    assert.equal(JSON.parse(r.text).text, "People are in this session; switch once they have left.");
    await wait(50);
    assert.equal(eventsIn(owner.text(), "sessions").length, 0);
  } finally { owner.close(); view.close(); }
});

test("GET invites.json and POST invite { op: revoke }: no keys or codes; a revoked invite stops at once; open pages hear it", async () => {
  const { view, key, invites } = await setup({ makeInvite: async () => { const i = invites.create({ role: "watch", label: "Made" }); return { ok: true, id: i.id, link: `http://x/${i.key}/` }; } });
  const owner = await readStream(view.port, `/${key}/events?panel=1`);
  const bob = invites.create({ role: "drive", label: "Bob", share: "code" });
  const watcher = invites.create({ role: "watch", label: "Wendy" });
  const wendy = await readStream(view.port, `/${watcher.key}/events?panel=1`);
  try {
    for (const role of ["watch", "drive"]) {
      const k = invites.create({ role, label: `${role} guest` }).key;
      assert.equal((await request(view.port, "GET", `/${k}/invites.json`)).status, 403, role);
      assert.equal((await request(view.port, "POST", `/${k}/invite`, { body: { op: "revoke", id: bob.id } })).status, 403, role);
    }
    assert.notEqual((await request(view.guestPort, "GET", `/${bob.key}/invites.json`)).status, 200, "a join code on its own port");
    let r = await request(view.port, "GET", `/${key}/invites.json`);
    assert.equal(r.status, 200);
    const items = JSON.parse(r.text).items;
    assert.deepEqual(items.find((i) => i.id === bob.id), { id: bob.id, role: "drive", label: "Bob", share: "code", expires: bob.expiresAt });
    for (const i of items) assert.deepEqual(Object.keys(i).sort(), ["expires", "id", "label", "role", "share"]);
    for (const i of [bob, watcher]) assert.ok(!r.text.includes(i.key), "never a key");
    for (const bad of [{ op: "revoke" }, { op: "revoke", id: "XYZ" }, { op: "revoke", id: bob.id, also: 1 }, { op: "revoke_all" }, { op: "delete", id: bob.id }]) {
      assert.equal((await request(view.port, "POST", `/${key}/invite`, { body: bad })).status, 409, JSON.stringify(bad));
    }
    assert.equal((await request(view.port, "POST", `/${key}/invite`, { raw: "{" })).status, 400);
    assert.equal((await request(view.port, "POST", `/${key}/invite`, { body: { op: "revoke", id: "0badc0de" } })).status, 404);
    r = await request(view.port, "POST", `/${key}/invite`, { body: { op: "revoke", id: watcher.id } });
    assert.deepEqual([r.status, JSON.parse(r.text)], [200, { ok: true, id: watcher.id }]);
    assert.ok(await until(() => wendy.ended()), "the watcher's open view ends at once");
    assert.equal((await request(view.port, "GET", `/${watcher.key}/state.json`)).status, 404, "and the link is gone");
    assert.equal((await request(view.port, "POST", `/${key}/invite`, { body: { op: "revoke", id: watcher.id } })).status, 404, "revoked already");
    const heard = eventsIn(owner.text(), "invites");
    assert.ok(heard.length >= 1);
    assert.ok(!heard.at(-1).items.some((i) => i.id === watcher.id));
    assert.ok(!owner.text().includes(bob.key), "no key in any event");
    // Making one with the Share card is heard too (the code stays in its answer only).
    r = await request(view.port, "POST", `/${key}/invite`, { body: { share: "link", role: "watch", name: "Ann" } });
    assert.equal(r.status, 200);
    const link = JSON.parse(r.text).link;
    assert.ok(await until(() => eventsIn(owner.text(), "invites").some((e) => e.items.some((i) => i.label === "Made"))));
    assert.ok(!owner.text().includes(link.split("/")[3]), "the new key isn't in the event");
  } finally { owner.close(); wendy.close(); view.close(); }
});

test("POST report: the owner's only, 404 without an address, at most 64 KB, relayed and answered with the server's id", async () => {
  const sent = [];
  let answer = { status: 200, body: '{"id":"PB-1042"}' };
  const config = { reportUrl: null };
  const reporter = createReporter({ url: () => config.reportUrl, send: async (url, text) => { sent.push({ url, text }); return answer; } });
  const { view, key, invites } = await setup({ reporter });
  try {
    assert.equal((await request(view.port, "POST", `/${key}/report`, { body: SAMPLE })).status, 404, "no reportUrl: no such route");
    config.reportUrl = "https://reports.example/v1/report";
    for (const role of ["watch", "drive"]) assert.equal((await request(view.port, "POST", `/${invites.create({ role, label: role }).key}/report`, { body: SAMPLE })).status, 403, role);
    assert.notEqual((await request(view.guestPort, "POST", `/${key}/report`, { body: SAMPLE })).status, 200);
    assert.equal((await request(view.port, "POST", `/${key}/report`, { body: SAMPLE, headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await request(view.port, "POST", `/${key}/report`, { raw: JSON.stringify({ ...SAMPLE, diagnostics: "x".repeat(70_000) }) })).status, 413);
    assert.equal((await request(view.port, "POST", `/${key}/report`, { raw: "{" })).status, 400);
    const bad = await request(view.port, "POST", `/${key}/report`, { body: { ...SAMPLE, cookies: "a=b" } });
    assert.equal(bad.status, 409);
    assert.match(JSON.parse(bad.text).error, /Unknown field "cookies"/);
    assert.equal(sent.length, 0, "nothing refused leaves");
    let r = await request(view.port, "POST", `/${key}/report`, { body: SAMPLE });
    assert.deepEqual([r.status, JSON.parse(r.text)], [200, { ok: true, id: "PB-1042" }]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://reports.example/v1/report");
    assert.deepEqual(Object.keys(JSON.parse(sent[0].text)), Object.keys(SAMPLE));
    assert.ok(!r.text.includes("reports.example"), "the address is never in an answer");
    answer = { status: 503, body: "" };
    r = await request(view.port, "POST", `/${key}/report`, { body: SAMPLE });
    assert.equal(r.status, 502);
    assert.match(JSON.parse(r.text).error, /HTTP 503/);
    answer = { status: 200, body: "{}" };
    for (let i = 0; i < 3; i++) assert.equal((await request(view.port, "POST", `/${key}/report`, { body: SAMPLE })).status, 200);
    r = await request(view.port, "POST", `/${key}/report`, { body: SAMPLE });
    assert.equal(r.status, 429, "the sixth in an hour");
    assert.equal(sent.length, 5);
  } finally { view.close(); }
  // Without a reporter at all (a helper built without one): 404.
  const plainView = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank" });
  try { assert.equal((await request(plainView.port, "POST", `/${plainView.url.split("/").at(-2)}/report`, { body: SAMPLE })).status, 404); } finally { plainView.close(); }
});
