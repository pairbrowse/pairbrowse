// Report a problem (liveview/report.mjs): the report checked against the pages' schema, scrubbed
// again, relayed over HTTPS without credentials, bounded in time, size and rate.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readReport, scrubReport, postReport, createReporter, reportUrlFrom, REPORTS_PER_HOUR } from "../scripts/liveview/report.mjs";

const HOME = "/Users/ann";
const SECRET = "hunter2-Sup3rS3cret";
const mask = (t) => String(t).split(SECRET).join("[STRIPE_PASSWORD]");

// The JSON the pages send (ui/common.js reportPayload), as DESIGN.md H2.1 shows it.
export const sample = (over = {}) => ({
  schema: "pairbrowse-report/1",
  createdAt: "2026-10-13T09:10:45.473Z",
  what: "The switcher said a session is already chosen.",
  app: { host: "pairbrowse", page: "settings", helper: "0.15.45", browser: { engine: "pairbrowse", version: "142.0.7444.59", build: "3" } },
  platform: { os: "macOS", mobile: false, language: "en-US" },
  helperState: { connection: "live", uptime: 7500, agents: 1, viewers: 0, joiners: 1, streams: 2, errors: 1 },
  diagnostics: "PairBrowse diagnostics report\nCreated: 2026-10-13T09:10:00.000Z\nHelper: 0.15.45 (Node 22.11.0, up 7500 s)\n",
  tab: null,
  ...over,
});

test("readReport: the pages' payload passes; any other key, type or size is refused", () => {
  assert.ok(readReport(sample()).report);
  assert.ok(readReport(sample({ tab: { url: "https://shop.example/checkout" } })).report);
  assert.ok(readReport(sample({ app: { ...sample().app, helper: null, browser: { engine: null, version: null, build: 3 } } })).report, "nulls and a numeric build");
  assert.ok(readReport(sample({ helperState: { connection: "", uptime: null, agents: null, viewers: null, joiners: null, streams: null, errors: null } })).report);
  const bad = [null, [], "x", sample({ schema: "pairbrowse-report/2" }), sample({ extra: 1 }), sample({ createdAt: "yesterday" }), sample({ what: "" }), sample({ what: "   " }),
    sample({ what: "x".repeat(4001) }), sample({ what: 5 }), sample({ app: { ...sample().app, host: "safari" } }), sample({ app: { ...sample().app, page: "../x" } }),
    sample({ app: { ...sample().app, extra: 1 } }), sample({ app: { ...sample().app, browser: { engine: "x", version: "y", build: "z", path: "/x" } } }),
    sample({ app: { ...sample().app, helper: "x".repeat(41) } }), sample({ platform: { os: "macOS", mobile: "no", language: "en" } }), sample({ platform: { os: "macOS", mobile: false } }),
    sample({ helperState: { ...sample().helperState, uptime: -1 } }), sample({ helperState: { ...sample().helperState, agents: "1" } }), sample({ helperState: { ...sample().helperState, cookies: 1 } }),
    sample({ diagnostics: 7 }), sample({ tab: "https://x.example" }), sample({ tab: { url: "file:///Users/ann/secret.pdf" } }), sample({ tab: { url: "chrome://settings" } }),
    sample({ tab: { url: "https://x.example", title: "Inbox" } }), sample({ tab: { url: "not a url" } }), sample({ platform: { os: "mac\u0000", mobile: false, language: "en" } })];
  for (const b of bad) assert.ok(readReport(b).error, JSON.stringify(b)?.slice(0, 120));
});

test("scrubReport: no home paths, no saved password, no address beyond the ticked tab's origin and path", () => {
  const given = sample({
    what: `It broke on https://shop.example/pay?card=4242&session=abc#top while ${SECRET} was typed; my file is ${HOME}/Documents/taxes.pdf; key=${"a".repeat(40)}; mail me at ann@example.com`,
    diagnostics: `Errors:\n2026-10-13T09:00:00.000Z follow: lost https://t.example.net/x?key=k in ${HOME}/Projects/x "Card number 4242"\nsecret ${SECRET}\n`,
    app: { ...sample().app, browser: { engine: "pairbrowse", version: `${HOME}/x`, build: "3" } },
    tab: { url: `https://shop.example/checkout/${SECRET}?order=17#pay` },
  });
  const out = scrubReport(readReport(given).report, { home: HOME, mask });
  const text = JSON.stringify(out);
  assert.ok(!text.includes(SECRET), "the saved password is masked everywhere");
  assert.ok(!text.includes(HOME), "no home path");
  assert.ok(!text.includes("card=4242") && !text.includes("session=abc") && !text.includes("order=17") && !text.includes("#top") && !text.includes("#pay"), "no query or fragment");
  assert.ok(!text.includes("a".repeat(40)), "no key");
  assert.match(out.what, /https:\/\/shop\.example\/pay /, "the person's words keep an address's origin and path");
  assert.match(out.what, /ann@example\.com/, "and their own email");
  assert.match(out.diagnostics, /lost t\.example\.net in \[path\]/, "the diagnostics keep hosts only");
  assert.match(out.diagnostics, /"…"/, "quoted page text goes");
  assert.equal(out.tab.url, "https://shop.example/checkout/[STRIPE_PASSWORD]", "the ticked tab: origin and path, masked");
  assert.equal(out.app.browser.version, "[path]");
  assert.deepEqual(Object.keys(out), Object.keys(sample()), "the same shape");
  assert.equal(scrubReport(readReport(sample()).report, { home: HOME, mask }).tab, null, "no tab unless ticked");
});

test("reportUrlFrom: https only, no user, query or fragment", () => {
  assert.equal(reportUrlFrom("https://reports.pairbrowse.example/v1/report"), "https://reports.pairbrowse.example/v1/report");
  for (const bad of ["http://reports.example/r", "https://u:p@reports.example/r", "https://reports.example/r?token=x", "https://reports.example/r#x", "ftp://x", "", null, 3, "https://x\n.example", `https://x.example/${"a".repeat(2100)}`]) {
    assert.equal(reportUrlFrom(bad), null, String(bad).slice(0, 60));
  }
});

// A stand-in for https.request: records the request and answers as told.
function fakeRequest({ status = 200, body = '{"id":"PB-1042"}', hang = false, error = null, chunks = null } = {}) {
  const seen = [];
  const request = (url, opts, onRes) => {
    const req = new EventEmitter();
    let sent = "";
    req.destroy = () => { req.destroyed = true; };
    req.end = (text) => {
      sent = text;
      seen.push({ url: String(url), opts, text: sent });
      if (hang) return;
      setImmediate(() => {
        if (error) return req.emit("error", new Error(error));
        const res = new EventEmitter();
        res.statusCode = status;
        res.setEncoding = () => {};
        onRes(res);
        for (const c of chunks || [body]) { if (req.destroyed) return; res.emit("data", c); }
        res.emit("end");
      });
    };
    return req;
  };
  return { request, seen };
}

test("postReport: one POST of JSON, no credentials or cookies, bounded answer and time", async () => {
  const f = fakeRequest();
  const r = await postReport("https://reports.example/v1/report", '{"a":1}', { request: f.request });
  assert.deepEqual(r, { status: 200, body: '{"id":"PB-1042"}' });
  assert.equal(f.seen.length, 1);
  assert.equal(f.seen[0].opts.method, "POST");
  assert.equal(f.seen[0].url, "https://reports.example/v1/report");
  assert.deepEqual(Object.keys(f.seen[0].opts.headers).sort(), ["accept", "content-length", "content-type"], "no authorization, cookie or anything else");
  assert.equal(f.seen[0].text, '{"a":1}');
  assert.match((await postReport("http://reports.example/r", "{}", { request: f.request })).error, /isn't https/);
  assert.equal(f.seen.length, 1, "nothing sent to http");
  assert.match((await postReport("https://r.example/", "{}", { request: fakeRequest({ hang: true }).request, timeoutMs: 50 })).error, /didn't answer within/);
  assert.match((await postReport("https://r.example/", "{}", { request: fakeRequest({ error: "ECONNREFUSED" }).request })).error, /Couldn't reach/);
  assert.match((await postReport("https://r.example/", "{}", { request: fakeRequest({ chunks: ["x".repeat(3000), "y".repeat(3000)] }).request })).error, /too long/);
});

test("the reporter: 404 without an address, 409 for a bad report, 502 when the server doesn't take it, 5 an hour", async () => {
  let now = 1_000_000;
  const sent = [];
  let answer = { status: 200, body: '{"id":"PB-1042","extra":"ignored"}' };
  const send = async (url, text) => { sent.push({ url, body: JSON.parse(text) }); return typeof answer === "function" ? answer() : answer; };
  const off = createReporter({ url: () => undefined, send });
  assert.equal(off.enabled(), false);
  assert.deepEqual(await off.relay(sample()), { status: 404 });
  assert.equal((await createReporter({ url: () => "http://x.example/r", send }).relay(sample())).status, 404, "an invalid address is none");
  const rep = createReporter({ url: () => "https://reports.example/v1/report", send, home: HOME, mask, now: () => now });
  assert.equal(rep.enabled(), true);
  assert.deepEqual(await rep.relay(sample({ what: `my password ${SECRET}` })), { status: 200, body: { ok: true, id: "PB-1042" } });
  assert.equal(sent[0].url, "https://reports.example/v1/report");
  assert.equal(sent[0].body.what, "my password [STRIPE_PASSWORD]", "what leaves is scrubbed again");
  assert.equal((await rep.relay({ ...sample(), cookies: "x" })).status, 409);
  assert.equal(sent.length, 1, "a refused report isn't sent and doesn't count");
  answer = { status: 200, body: '{"id":"not ok!"}' };
  assert.deepEqual((await rep.relay(sample())).body, { ok: true }, "a malformed id isn't passed on");
  answer = { status: 302, body: "" };
  assert.deepEqual(await rep.relay(sample()), { status: 502, body: { error: "The report server answered with a redirect; nothing was sent on." } });
  answer = { status: 500, body: "boom" };
  assert.deepEqual(await rep.relay(sample()), { status: 502, body: { error: "The report server didn't take it (HTTP 500)." } });
  answer = { error: "Couldn't reach the report server." };
  assert.deepEqual(await rep.relay(sample()), { status: 502, body: { error: "Couldn't reach the report server." } });
  assert.equal(sent.length, REPORTS_PER_HOUR);
  const limited = await rep.relay(sample());
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /5 reports went out in the last hour/);
  assert.equal(sent.length, REPORTS_PER_HOUR, "the sixth isn't sent");
  now += 3_600_000;
  answer = { status: 201, body: '{"id":"PB-1043"}' };
  assert.deepEqual(await rep.relay(sample()), { status: 200, body: { ok: true, id: "PB-1043" } }, "an hour later it goes again");
  answer = () => { throw new Error("x"); };
  assert.equal((await rep.relay(sample())).status, 502, "a sender that throws is a failure, never a crash");
});
