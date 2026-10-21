// The Tools tab's diagnostics (daemon/diagnostics.mjs): the scrub every line goes through, the
// helper's last error lines read from the log's tail only, and the plain-text report.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrub, lastErrors, createDiagnostics, pinnedBrowserVersion, fontsSummary, fontsLine } from "../scripts/daemon/diagnostics.mjs";
import { handoffKind } from "../scripts/daemon/toolstab.mjs";

const home = "/Users/tester";
const s = (t, mask) => scrub(t, { home, mask });

test("scrub: addresses become their host, file:// and bad ones say only that", () => {
  assert.equal(s("loading https://site.example/path?q=1 failed"), "loading site.example failed");
  assert.equal(s("at https://user:pw@shop.example:8443/cart#x"), "at shop.example:8443");
  assert.equal(s("open file:///Users/tester/a.pdf"), "open [file]");
  assert.equal(s("ws://"), "[url]");
  assert.ok(!s("weird ://host/x/y").includes("/x"), "a bare :// with a path is cut too");
});

test("scrub: emails, ~/.pairbrowse kept, other paths gone", () => {
  assert.equal(s("sent to ann@mail.example"), "sent to [email]");
  assert.equal(s(`wrote ${home}/.pairbrowse/sessions/a/log`), "wrote ~/.pairbrowse/sessions/a/log");
  assert.equal(s("wrote ~/.pairbrowse/runs/x.json"), "wrote ~/.pairbrowse/runs/x.json");
  assert.equal(s(`saved ${home}/Downloads/tax.pdf`), "saved [path]");
  assert.equal(s("saved ~/Desktop/notes.txt"), "saved [path]");
  assert.equal(s("at /Users/other/x and /home/bob/y and /tmp/z and /private/var/q and /Volumes/Data/k and /opt/a"), "at [path] and [path] and [path] and [path] and [path] and [path]");
  assert.equal(s("C:\\Users\\bob\\file.txt is open"), "[path] is open");
  assert.equal(scrub("in /srv/me/data", { home: "/srv/me" }), "in [path]", "the home given, wherever it is");
});

test("scrub: secrets, keys and quoted page text", () => {
  assert.equal(s("auth key=abc123 token: zzz password=hunter2"), "auth key=[hidden] token=[hidden] password=[hidden]");
  const k = "A".repeat(21) + "_b-" + "9".repeat(19);
  assert.equal(k.length, 43);
  assert.equal(s(`joined with ${k} ok`), "joined with [key] ok");
  assert.equal(s('clicked "Pay Ann Smith $40" button'), 'clicked "…" button');
  const masked = s("typed S3cretValue in the field", (t) => t.split("S3cretValue").join("••••"));
  assert.equal(masked, "typed •••• in the field", "the mask goes first");
  const long = s("x".repeat(50) + " " + "y ".repeat(200));
  assert.equal(long.length, 200, "at most 200 characters");
  assert.ok(long.endsWith("…"));
});

test("lastErrors: only the tail, no trace lines, at most 20, with where", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-diag-"));
  try {
    const big = join(dir, "big.log");
    // Errors only at the start of a 1 MB file: the last 256 KB has none.
    writeFileSync(big, `2026-10-12T10:00:00.000Z liveview Error: boom\n`.repeat(50) + `2026-10-12T10:00:01.000Z fine line\n`.repeat(30_000));
    assert.deepEqual(await lastErrors({ file: big, home }), []);
    const log = join(dir, "daemon.log");
    const lines = [];
    for (let i = 0; i < 30; i++) lines.push(`2026-10-12T10:00:${String(i).padStart(2, "0")}.000Z session error: number ${i} failed`);
    lines.push("2026-10-12T10:01:00.000Z trace browser_click failed in 30 ms");
    lines.push("2026-10-12T10:01:01.000Z listening on /tmp/x");
    lines.push("2026-10-12T10:01:02.000Z Something can't be done at /Users/tester/x");
    writeFileSync(log, lines.join("\n") + "\n");
    const errs = await lastErrors({ file: log, home });
    assert.equal(errs.length, 20);
    assert.ok(!errs.some((e) => /trace|listening/.test(e.text)), "trace lines and plain lines are skipped");
    assert.deepEqual(errs.at(-1), { at: Date.parse("2026-10-12T10:01:02.000Z"), where: "helper", text: "Something can't be done at [path]" });
    assert.deepEqual(errs.at(-2), { at: Date.parse("2026-10-12T10:00:29.000Z"), where: "session", text: "error: number 29 failed" });
    assert.deepEqual(await lastErrors({ file: join(dir, "missing.log"), home }), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("handoffKind: a label from the agent's own words", () => {
  assert.equal(handoffKind("Please solve the CAPTCHA"), "captcha");
  assert.equal(handoffKind("Solve the check in this tab"), "captcha");
  assert.equal(handoffKind("Enter the 2FA code from your phone"), "2fa");
  assert.equal(handoffKind("Type the verification code we sent"), "2fa");
  assert.equal(handoffKind("Enter your card details to pay"), "payment");
  assert.equal(handoffKind("Sign in please"), "login");
  assert.equal(handoffKind("Log in with your password"), "login");
  assert.equal(handoffKind("Pick the colour you like"), "other");
});

test("the report names joined people by role count only, and is scrubbed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-diag-"));
  try {
    const log = join(dir, "daemon.log");
    writeFileSync(log, `2026-10-12T10:00:00.000Z liveview error at https://a.example/p?q=1 for ${home}/Documents/x.txt\n`);
    const d = createDiagnostics({ version: "1.2.3", browser: async () => ({ engine: "pairbrowse", version: "142.0.1", build: "b7" }), agents: () => 2, logFile: log, home });
    const read = await d.read();
    assert.equal(read.helper.version, "1.2.3");
    assert.equal(read.agents, 2);
    assert.deepEqual(read.browser, { engine: "pairbrowse", version: "142.0.1", build: "b7", graphics: null }, "no graphics read while no browser runs");
    assert.equal(read.errors[0].text, "error at a.example for [path]");
    const text = d.reportText({ ...read, connections: { agents: 2, viewers: 1, joiners: 1, streams: 3 }, joined: [{ label: "Zelda Q (Claude Code)", role: "drive" }, { label: "Yuri", role: "watch" }] });
    assert.match(text, /Joined: 1 drive, 1 watch/);
    assert.ok(!/Zelda|Yuri/.test(text), "no joiner's name");
    assert.match(text, /Browser: pairbrowse 142\.0\.1 \(build b7\)/);
    assert.match(text, /Connections: 2 agents, 1 viewers, 1 joiners, 3 streams/);
    assert.ok(text.split("\n").every((l) => l.length <= 200));
    assert.ok(!text.includes(home) && !text.includes("/p?q"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scrub: plain words after key or password stay readable, values after a separator do not", () => {
  assert.equal(scrub("Couldn't find key Enter"), "Couldn't find key Enter");
  assert.equal(scrub("password field not found"), "password field not found");
  assert.equal(scrub("token: abc123 sent"), "token=[hidden] sent");
  assert.equal(scrub("authorization Bearer abc.def"), "authorization=[hidden]");
  assert.equal(scrub("key=val"), "key=[hidden]");
});

test("pinnedBrowserVersion: the version the helper pins, never a guess", () => {
  assert.equal(pinnedBrowserVersion({ engine: "pairbrowse", nativeRecord: { version: "160.0.1" }, ungoogled: "154.0-1" }), "160.0.1");
  assert.equal(pinnedBrowserVersion({ engine: "pairbrowse", nativeRecord: null, ungoogled: "154.0-1" }), "154.0-1");
  assert.equal(pinnedBrowserVersion({ engine: "pairbrowse" }), null);
  const browsersJson = { browsers: [{ name: "firefox", browserVersion: "1" }, { name: "chromium", revision: "1247", browserVersion: "155.0.8059.12" }] };
  assert.equal(pinnedBrowserVersion({ engine: "open", browsersJson }), "155.0.8059.12");
  assert.equal(pinnedBrowserVersion({ engine: "open", browsersJson: { browsers: [{ name: "chromium", revision: "1247" }] } }), "r1247");
  assert.equal(pinnedBrowserVersion({ engine: "open", browsersJson: null }), null);
  assert.equal(pinnedBrowserVersion({ engine: "path", browsersJson }), null);
});

test("a known browser version reaches diagnostics.json and the report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-diag-v-"));
  try {
    const browsersJson = { browsers: [{ name: "chromium", revision: "1247", browserVersion: "155.0.8059.12" }] };
    const d = createDiagnostics({ version: "1.2.3", logFile: join(dir, "none.log"), home: dir,
      browser: async () => ({ engine: "open", version: pinnedBrowserVersion({ engine: "open", browsersJson }), build: null }) });
    const got = await d.read();
    assert.equal(got.browser.version, "155.0.8059.12");
    assert.equal(JSON.parse(JSON.stringify(got)).browser.version, "155.0.8059.12");
    assert.match(d.reportText(got), /Browser: open 155\.0\.8059\.12/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Spec step 52: on Linux the report and diagnostics.json name the Windows fonts the browser finds
// (present, standing in and by which open font, absent), and nothing else of the computer's fonts.
test("the Windows fonts reach diagnostics.json and the report, only by their known names", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-diag-f-"));
  try {
    const fonts = async () => ({ conf: "pairbrowse", standIns: true, present: ["Arial", "Some Private Font"], standingIn: [{ family: "Calibri", by: "Carlito" }, { family: "Calibri", by: "/home/x/evil" }], absent: ["Segoe UI"], extra: "x" });
    const d = createDiagnostics({ version: "1.2.3", logFile: join(dir, "none.log"), home: dir, fonts });
    const got = await d.read();
    assert.deepEqual(got.browser.fonts, { conf: "pairbrowse", standIns: true, present: ["Arial"], standingIn: [{ family: "Calibri", by: "Carlito" }], absent: ["Segoe UI"] });
    assert.match(d.reportText(got), /^Windows fonts: present Arial; standing in Calibri \(Carlito\); absent Segoe UI \(stand-ins on\)$/m);
    assert.equal(fontsSummary(null), null);
    // Off Linux (no fonts read) nothing is said; a read that never answers is given up on.
    const none = await createDiagnostics({ logFile: join(dir, "none.log"), home: dir }).read();
    assert.equal(none.browser.fonts, undefined);
    assert.doesNotMatch(createDiagnostics({ home: dir }).reportText(none), /Windows fonts/);
    const thrown = await createDiagnostics({ logFile: join(dir, "none.log"), home: dir, fonts: () => { throw new Error("no fc-list"); } }).read();
    assert.equal(thrown.browser.fonts, undefined);
    assert.match(fontsLine({ standIns: false, conf: "build", present: [], standingIn: [], absent: ["Calibri"] }), /^Windows fonts: absent Calibri \(stand-ins off, the build's own font configuration\)$/);
    assert.match(fontsLine({ standIns: true, conf: "system", present: [], standingIn: [], absent: ["Calibri"] }), /\(stand-ins on, this computer's font configuration\)$/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
