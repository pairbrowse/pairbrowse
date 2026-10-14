// The session's activity log (daemon/activitylog.mjs) and GET activity.json (liveview.mjs): bounds,
// paging, masking, the owner-only file (a rename moves it, deleting the session removes it), a
// clean session in memory only, and the route's rights.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-activity-"));
const s = await import("../scripts/sessions.mjs");
const { createActivityLog, readPageQuery, cleanLine, LOG_MAX, LOG_AGE_MS, PAGE_MAX, PAGE_DEFAULT } = await import("../scripts/daemon/activitylog.mjs");
const { startLiveView, createInvites } = await import("../scripts/liveview.mjs");

const DAY = 86_400_000;
const clock = (t0 = 1_800_000_000_000) => { let t = t0; const now = () => t; now.add = (ms) => { t += ms; }; return now; };
const line = (i, extra = {}) => ({ text: `Clicked **Button ${i}**`, who: "Claude", tab: "tab 1", ...extra });
const owner = process.platform === "win32" ? null : 0o600;

test("lines: newest first, a page at a time, times unique so no line falls between pages", () => {
  const now = clock();
  const log = createActivityLog({ now });
  // Three in the same millisecond: each gets its own time, in order.
  for (let i = 0; i < 3; i++) log.add({ t: now(), ...line(i) });
  now.add(10);
  for (let i = 3; i < 120; i++) { log.add({ t: now(), ...line(i) }); now.add(1); }
  const first = log.page({ limit: 50 });
  assert.equal(first.items.length, 50);
  assert.equal(first.items[0].text, "Clicked **Button 119**");
  assert.equal(first.more, true);
  assert.deepEqual(first.kept, { lines: LOG_MAX, days: 7, saved: false });
  const all = [...first.items];
  let page = first;
  while (page.more) { page = log.page({ before: page.items.at(-1).t, limit: 50 }); all.push(...page.items); }
  assert.equal(all.length, 120, "every line once");
  assert.deepEqual(all.map((a) => a.text), Array.from({ length: 120 }, (_, i) => `Clicked **Button ${119 - i}**`));
  assert.ok(all.every((a, i) => i === 0 || a.t < all[i - 1].t), "strictly falling times");
  assert.deepEqual(log.page({ before: all.at(-1).t }), { items: [], more: false, kept: first.kept });
  // limit is held to 1..200.
  assert.equal(log.page({ limit: 10_000 }).items.length, 120);
  assert.equal(log.page({ limit: 0 }).items.length, PAGE_DEFAULT);
});

test("bounded: the last LOG_MAX lines and none older than 7 days", () => {
  const now = clock();
  const log = createActivityLog({ now, max: 5, maxAgeMs: 2 * DAY });
  for (let i = 0; i < 8; i++) { log.add(line(i)); now.add(1000); }
  assert.equal(log.size(), 5);
  assert.equal(log.page().items.at(-1).text, "Clicked **Button 3**");
  now.add(2 * DAY - 2000); // lines 3..5 are now over two days old
  assert.deepEqual(log.page().items.map((a) => a.text.match(/\d+/)[0]), ["7", "6"]);
  assert.equal(LOG_MAX, 2000);
  assert.equal(LOG_AGE_MS, 7 * DAY);
  assert.equal(PAGE_MAX, 200);
});

test("kept as the stream has it: names and sentences, masked, nothing else", () => {
  const log = createActivityLog({ now: () => 10, mask: (t) => t.replaceAll("hunter2", "••••") });
  const kept = log.add({ t: 5, text: "Typed hunter2 into **Password**", who: "Claude", tab: "tab hunter2", tabId: "0a1b2c3d", from: "joined", value: "secret", extra: { x: 1 } });
  assert.deepEqual(kept, { t: 5, text: "Typed •••• into **Password**", who: "Claude", tab: "tab ••••", tabId: "0a1b2c3d", from: "joined" });
  assert.deepEqual(log.page().items, [kept]);
  // Nothing the stream wouldn't send: no text, no time, a bad tab id, overlong fields cut.
  assert.equal(log.add({ t: 6, text: "" }), null);
  assert.equal(cleanLine({ text: "x" }), null);
  assert.equal(cleanLine({ t: -1, text: "x" }), null);
  assert.equal(cleanLine({ t: 1, text: "x", tabId: "../x" }).tabId, undefined);
  const long = cleanLine({ t: 1, text: "x".repeat(500), who: "w".repeat(100), tab: "t".repeat(100), from: "f".repeat(100) });
  assert.deepEqual([long.text.length, long.who.length, long.tab.length, long.from.length], [200, 60, 80, 80]);
  // A mask that throws keeps nothing (never the line unmasked).
  assert.equal(createActivityLog({ mask: () => { throw new Error("x"); } }).add({ t: 1, text: "a" }), null);
});

test("query: before and limit checked", () => {
  const q = (str) => readPageQuery(new URLSearchParams(str));
  assert.deepEqual(q(""), { before: Infinity, limit: PAGE_DEFAULT });
  assert.deepEqual(q("before=123&limit=20"), { before: 123, limit: 20 });
  assert.deepEqual(q("limit=999"), { before: Infinity, limit: PAGE_MAX });
  for (const bad of ["before=x", "before=-1", "before=1e9", "before=", "limit=0", "limit=-3", "limit=2.5", "limit=abc", "before=12345678901234567"]) assert.ok(q(bad).error, bad);
});

test("a kept session: an owner-only file that survives a restart, follows a rename and goes with the session", () => {
  let name = "work";
  s.createSession("work");
  const where = () => ({ name, file: s.isTemporary(name) ? null : s.activityFile(name) });
  const now = clock();
  const log = createActivityLog({ where, now });
  for (let i = 0; i < 3; i++) { log.add(line(i)); now.add(5); }
  const file = s.activityFile("work");
  assert.ok(existsSync(file));
  if (owner !== null) assert.equal(statSync(file).mode & 0o777, owner, "owner-only");
  assert.equal(existsSync(`${file}.tmp`), false);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).lines.map((a) => a.text), ["Clicked **Button 0**", "Clicked **Button 1**", "Clicked **Button 2**"]);
  // A helper restart: a new log reads the file.
  const again = createActivityLog({ where, now });
  assert.equal(again.page().items.length, 3);
  // A clean session: in memory only, nothing written; back on "work" its lines are there.
  name = "clean-42";
  s.createSession(name);
  again.add(line("clean"));
  assert.deepEqual(again.page().items.map((a) => a.text), ["Clicked **Button clean**"]);
  assert.equal(again.page().kept.saved, false);
  assert.equal(existsSync(s.activityFile("clean-42")), false, "no file for a clean session");
  name = "work";
  assert.equal(again.page().items.length, 3);
  assert.equal(again.page().kept.saved, true);
  // A rename moves the file (the browser closed), and the log follows the new name.
  s.renameSession("work", "client");
  assert.equal(existsSync(file), false);
  name = "client";
  again.add(line(3));
  assert.deepEqual(again.page().items.map((a) => a.text.match(/\d+/)[0]), ["3", "2", "1", "0"]);
  assert.ok(existsSync(s.activityFile("client")));
  assert.equal(s.sessionFilesExist("client"), true);
  // Deleted with its session.
  name = "default";
  s.deleteSession("client");
  assert.equal(existsSync(s.activityFile("client")), false);
  assert.equal(s.activityFile("default"), join(process.env.PAIRBROWSE_HOME, "activity.json"));
});

test("a damaged or foreign file: only well-formed lines in rising time are read", () => {
  const f = join(process.env.PAIRBROWSE_HOME, "odd.activity.json");
  writeFileSync(f, JSON.stringify({ v: 1, lines: [{ t: 2, text: "b" }, { t: 1, text: "a" }, null, "x", { t: 3, text: "c", who: 7 }, { t: 4 }] }));
  const log = createActivityLog({ where: () => ({ name: "odd", file: f }), now: () => 10 });
  assert.deepEqual(log.page().items, [{ t: 3, text: "c", who: "", tab: "" }, { t: 2, text: "b", who: "", tab: "" }]);
  writeFileSync(f, "{not json");
  assert.deepEqual(createActivityLog({ where: () => ({ name: "odd", file: f }), now: () => 10 }).page().items, []);
});

// ---- GET activity.json ----
function request(port, path, { host = `127.0.0.1:${port}`, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}
// The first `activity` event on a stream opened with key k.
function firstActivity(port, k) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: `/${k}/events?panel` }, (res) => {
      let buf = "";
      res.on("data", (d) => {
        buf += d;
        const m = /event: activity\ndata: (.*)\n\n/.exec(buf);
        if (m) { req.destroy(); resolve(JSON.parse(m[1])); }
      });
    });
    req.on("error", (e) => { if (e.code !== "ECONNRESET") reject(e); });
  });
}

test("GET activity.json: the owner's (either key), paged, bounds checked; the event keeps the latest 30", async () => {
  const invites = createInvites();
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", invites, mask: (t) => t.replaceAll("s3cret", "••••") });
  const key = view.url.split("/").at(-2);
  try {
    for (let i = 0; i < 260; i++) view.addActivity(`Did ${i}${i === 259 ? " s3cret" : ""}`, "Claude", "tab 1");
    let r = await request(view.port, `/${key}/activity.json`);
    assert.equal(r.status, 200);
    let body = JSON.parse(r.text);
    assert.equal(body.items.length, PAGE_DEFAULT);
    assert.equal(body.items[0].text, "Did 259 ••••", "masked as the log keeps it");
    assert.equal(body.more, true);
    r = await request(view.port, `/${view.pagesKey}/activity.json?limit=500&before=${body.items.at(-1).t}`);
    body = JSON.parse(r.text);
    assert.equal(r.status, 200, "the browser's own pages' key too");
    assert.equal(body.items.length, 200, "at most 200");
    assert.equal(body.items[0].text, `Did ${259 - PAGE_DEFAULT}`);
    assert.equal(body.more, true);
    body = JSON.parse((await request(view.port, `/${key}/activity.json?limit=200&before=${body.items.at(-1).t}`)).text);
    assert.deepEqual([body.items.length, body.more, body.items.at(-1).text], [10, false, "Did 0"]);
    for (const bad of ["?limit=0", "?before=abc", "?limit=-1"]) assert.equal((await request(view.port, `/${key}/activity.json${bad}`)).status, 400, bad);
    assert.equal((await request(view.port, `/${key}/activity.json/x`)).status, 404);
    // Guests: refused; an unknown key or a foreign Host: nothing there.
    for (const role of ["watch", "drive"]) assert.equal((await request(view.port, `/${invites.create({ role, label: role }).key}/activity.json`)).status, 403, role);
    assert.equal((await request(view.port, `/${"x".repeat(43)}/activity.json`)).status, 404);
    assert.equal((await request(view.port, `/${key}/activity.json`, { host: "evil.example" })).status, 403);
    // The stream's event as before: the latest 30, the same lines as the log's (time and text).
    const ev = await firstActivity(view.port, key);
    assert.equal(ev.length, 30);
    const newest = JSON.parse((await request(view.port, `/${key}/activity.json?limit=30`)).text).items.reverse();
    assert.deepEqual(ev, newest);
  } finally {
    view.close();
  }
});

test("GET activity.json uses the helper's log when given one", async () => {
  const activityLog = createActivityLog({ now: () => 1000 });
  activityLog.add({ t: 900, text: "Before this live view", who: "", tab: "" });
  const view = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", activityLog });
  const key = view.url.split("/").at(-2);
  try {
    view.addActivity("Now", "Claude");
    const body = JSON.parse((await request(view.port, `/${key}/activity.json`)).text);
    assert.deepEqual(body.items.map((a) => a.text), ["Now", "Before this live view"]);
  } finally {
    view.close();
  }
});
