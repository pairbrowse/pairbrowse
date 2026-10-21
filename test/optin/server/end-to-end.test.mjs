// Server mode end to end (spec server-mode sections 3 and 14): every phase working together in one
// session, in the A13 container (test/optin/server/container.mjs) on the pinned native Linux
// build with its sandbox on: server mode with keep-alive on its own Xvfb (A); a PairBrowse profile
// export imported and an HTTP and a SOCKS5 proxy added through the owner's routes as Settings
// does, the HTTP one assigned (C, D); the launch's exit check through the proxy, DNS strict,
// graphics measured as software, the profile's time zone and languages against the exit's
// country, and diagnostics (C, E); a local challenge page handed to the person through a webhook,
// a preview that leaves the link valid, Take over and typing from a 390x844 phone, Done, and the
// waiting agent going on in the same tab with the same cookies (B); the browser and then the Xvfb
// killed, with the same profile and proxy (checked again before the tabs load), the tabs and the
// open hand-off (same deadline) back (A, B, C); and card fields: an agent's typing refused, the
// person's typing in the hand-off, nothing card-shaped in a log, audit line, message or agent
// result (B13). The run inside is test/optin/server/end-to-end-run.mjs; every page is local and
// every proxy a stub; the challenge is a fixture the test person completes.
//
// Needs Docker (OrbStack on a Mac), PAIRBROWSE_TEST_DOCKER=1, PAIRBROWSE_TEST_RUNTIME and
// PAIRBROWSE_TEST_ENGINE (both mounted read-only), and the network once for the pinned build's
// archive (kept between runs). The phone's side is its own requests, as scripts/liveview-turn.js
// sends them (one live browser at a time); test/liveview-mobile.test.mjs covers the viewer page.
import "../../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE } from "../../../scripts/native-pack.mjs";
import { downloadPinned } from "../../../scripts/util.mjs";
import { dockerReady, startContainer } from "./container.mjs";
import { SCREEN } from "../../helpers/server.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const engine = process.env.PAIRBROWSE_TEST_ENGINE;
const SKIP = (!runtime || !engine || process.env.PAIRBROWSE_TEST_DOCKER !== "1") && "set PAIRBROWSE_TEST_DOCKER=1, PAIRBROWSE_TEST_RUNTIME and PAIRBROWSE_TEST_ENGINE";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cache = join(tmpdir(), "pairbrowse-test-downloads");
const CARD = "4242424242424242";

test("server mode end to end: keep-alive Xvfb, imported profile, proxies from Settings, launch checks, phone hand-off, recovery, card fields", { skip: SKIP, timeout: 5_400_000 }, async (t) => {
  assert.ok(dockerReady(), "Docker answers");
  await downloadPinned(`${NATIVE.baseUrl}/${NATIVE.linux.file}`, join(cache, NATIVE.linux.file), NATIVE.linux.sha256);
  const c = startContainer({ name: "pb-server-e2e", repo, log: console.log, mounts: [
    { from: runtime, to: "/runtime" }, { from: engine, to: "/engine" }, { from: cache, to: "/cache" },
  ] });
  let r;
  try {
    const out = await c.node("/repo/test/optin/server/end-to-end-run.mjs", [], { ms: 5_000_000 });
    const line = out.out.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `the run printed its result:\n${out.out.slice(-6000)}`);
    r = JSON.parse(line.slice("RESULT ".length));
  } finally { c.stop(); }
  t.diagnostic(JSON.stringify({ ...r, log: undefined }, null, 1).slice(0, 20000));
  assert.equal(r.error, undefined, `${r.error}\n--- daemon.log ---\n${r.log}`);
  const s = r.steps;
  assert.notEqual(r.uid, 0, "a normal user");

  // 1. Server mode with keep-alive, on its own Xvfb at virtualScreen's size.
  assert.ok(s[1].screen?.alive, "the helper's own Xvfb runs");
  assert.deepEqual(s[1].screen.geometry, SCREEN);
  assert.match(s[1].status, new RegExp(`virtual screen ${s[1].screen.display} ${SCREEN.width}x${SCREEN.height}`));
  assert.match(s[1].status, /keep-alive on/);
  assert.doesNotMatch(s[1].status, /sandbox is off/i);

  // 2. Imported through the owner's route; both proxies added; the HTTP one assigned.
  assert.equal(s[2].imported.status, 200, JSON.stringify(s[2].imported));
  assert.equal(s[2].imported.format, "pairbrowse-profile/1");
  assert.ok(s[2].listed, "the profile is listed");
  assert.deepEqual(s[2].added.map((a) => a.status), [200, 200], JSON.stringify(s[2].added));
  assert.equal(s[2].socksTest.status, 200, JSON.stringify(s[2].socksTest));
  assert.equal(s[2].socksTest.verdict, "ok", JSON.stringify(s[2].socksTest));
  assert.equal(s[2].socksTest.country, "US", "Test read the exit through the SOCKS5 proxy");
  assert.equal(s[2].assign.status, 200, s[2].assign.text);
  assert.match(s[2].assign.text, /Session "work" uses "http-local"/);

  // 3. The launch: the exit checked through the proxy, strict, coherence reported, software graphics.
  assert.match(s[3].created, /work/, s[3].created);
  assert.ok(!s[3].navigateError, s[3].navigate);
  assert.ok(s[3].launchLog.some((l) => /launch: network "http-local" \(session, strict\)/.test(l)), s[3].launchLog.join("\n"));
  assert.ok(s[3].launchLog.some((l) => /"http-local" passed its check at launch \(exit country US\); locale\.timezone-vs-egress, locale\.language-vs-egress/.test(l)), s[3].launchLog.join("\n"));
  const first = s[3].observations?.at(-1);
  assert.equal(first?.kind, "launch");
  assert.equal(first?.verdict, "ok");
  assert.equal(first?.dns, "strict");
  assert.equal(first?.browser?.ip, "203.0.113.10", "the browser's own read went through the proxy");
  assert.deepEqual(first?.coherence, ["locale.timezone-vs-egress", "locale.language-vs-egress"]);
  assert.ok(s[3].proxyAsked.some((t) => /trace-e2e\.test/.test(t)) && s[3].proxyAsked.some((t) => /shop\.pbtest\.example\/login/.test(t)), `names went to the proxy: ${s[3].proxyAsked}`);
  assert.match(s[3].status, /Profile: imported \(rev \d+/);
  assert.match(s[3].status, /network "http-local" \(strict\): exit checked at launch, country US/);
  assert.match(s[3].status, /warning: The browser's time zone Europe\/Berlin is used in DE[^]*this proxy's exit is in US/);
  assert.match(s[3].status, /Graphics: software \(/, "measured: the real software path");
  assert.equal(s[3].diagnostics.browser?.graphics?.kind, "software", JSON.stringify(s[3].diagnostics.browser));
  assert.equal(s[3].diagnostics.browser?.engine, "pairbrowse");
  assert.match(s[3].report, /Graphics: software, /);
  assert.doesNotMatch(s[3].report, /203\.0\.113\.10|198\.51\.100\.20/, "no exit address in a report");
  assert.equal(s[3].sandbox?.noSandboxSwitch, false, "no --no-sandbox");
  assert.ok(s[3].sandbox?.renderers > 0 && s[3].sandbox.namespaced === s[3].sandbox.renderers, `the sandbox: ${JSON.stringify(s[3].sandbox)}`);

  // 4. The challenge, handed to the person and back.
  assert.ok(s[4].handed, s[4].said);
  assert.match(s[4].said, /Site verification \(yours to do\)/);
  assert.match(s[4].said, /PairBrowse setup problems \(PairBrowse's to fix[^]*time zone Europe\/Berlin vs egress US/);
  assert.doesNotMatch(s[4].said, /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}/, "the agent never gets the link");
  assert.deepEqual(s[4].messageKeys, ["event", "expiresAt", "host", "id", "kind", "link", "reason"]);
  assert.equal(s[4].message.kind, "captcha");
  assert.equal(s[4].message.host, "shop.pbtest.example");
  assert.doesNotMatch(JSON.stringify(s[4].message), /hunter2|Ada/, "never the agent's words");
  assert.deepEqual(s[4].previews, [{ status: 200, takeOver: true }, { status: 200, takeOver: true }], "a preview GET leaves the link valid");
  assert.equal(s[4].secondRedeem, 404, "single use");
  assert.ok(s[4].viewerPage.status === 200 && s[4].viewerPage.viewport, "the phone viewer's page");
  assert.ok(s[4].sent.every((x) => x === 204), JSON.stringify(s[4].sent));
  assert.equal(s[4].answerAfterResend, "4", "a batch sent twice is typed once");
  assert.equal(s[4].done, 200);
  assert.ok(!s[4].waitedError, s[4].waited);
  assert.match(s[4].waited, new RegExp(`hand-off ${s[4].handed.id} ended \\(done\\)`));
  assert.deepEqual(s[4].current, [s[4].handed.tab, "http://shop.pbtest.example/cleared"], "the same tab, past the check");
  assert.match(s[4].cookies, /sid=ada/, "still signed in");
  assert.match(s[4].cookies, /cleared=yes/);

  // 6 (agent side). No agent types a card number.
  assert.ok(s[6].ref, "the card field was found");
  assert.ok(s[6].typeRefused, s[6].typeSaid);
  assert.match(s[6].typeSaid, /card/i);
  assert.ok(s[6].fillRefused, s[6].fillSaid);
  assert.equal(s[6].pageGot, null, "nothing reached the field");
  assert.match(s[6].handed, /hand-off [0-9a-f]{8} for tab \d+/);

  // 5. Recovery: the same profile and proxy, checked before the tabs, the tabs, the hand-off.
  for (const k of s[5].kills) {
    assert.ok(k.network, `${k.what}: the same proxy: ${k.lines.join("\n")}`);
    assert.ok(k.checkBeforeTabs, `${k.what}: checked again before the tabs loaded:\n${k.lines.join("\n")}`);
    assert.equal(k.restored, "2", `${k.what}: both tabs back`);
    assert.ok(k.newScreen, `${k.what}: ${k.what === "xvfb" ? "a new" : "the same"} screen`);
    assert.ok(k.replaced, `${k.what}: the open hand-off's new link:\n${k.lines.join("\n")}`);
    assert.equal(k.replaced.expiresAt, s[5].original.expiresAt, `${k.what}: the same deadline`);
    assert.equal(k.replaced.kind, "payment");
  }
  assert.match(s[5].tabs, /shop\.pbtest\.example\/pay/);
  assert.match(s[5].tabs, /shop\.pbtest\.example\/two/);
  assert.match(s[5].status, /Profile: imported/);
  assert.match(s[5].status, /network "http-local" \(strict\)/);
  assert.ok(s[5].observations.filter((o) => o.kind === "launch" && o.proxy === "http-local" && o.dns === "strict" && o.verdict === "ok").length >= 3, JSON.stringify(s[5].observations));

  // 6 (person side). The person pays; nothing card-shaped anywhere PairBrowse writes or tells.
  assert.ok(s[6].personTyped.every((x) => x === 204), JSON.stringify(s[6].personTyped));
  assert.equal(s[6].pageGotAfter, "16:ok", "the person's card number reached the page");
  assert.equal(s[6].done, 200);
  assert.ok(!s[6].waitedError, s[6].waited);
  assert.match(s[6].waited, /ended \(done\)/);
  assert.equal(s[6].snapshotHasCard, false, s[6].snapshotSays);
  assert.deepEqual(s[6].cardIn.results, [], "in no agent result");
  assert.equal(s[6].cardIn.messages, 0, "in no message");
  assert.deepEqual(s[6].cardIn.files, [], "in no log, audit line or other file");
  assert.deepEqual(s[6].cardIn.logsRead, ["daemon.log", "audit.jsonl"], "the log and the audit trail were read");
  assert.ok(!JSON.stringify(r).includes(CARD.slice(0, 12)), "nowhere in what the run saw");
  for (const kind of ["minted", "notified", "redeemed", "ended"]) assert.ok(r.audit.includes(kind), `audit: ${kind} (${r.audit})`);
});
