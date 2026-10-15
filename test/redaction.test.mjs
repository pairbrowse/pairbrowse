import "./helpers/home.mjs";
// One invariant across every writer of logs and diagnostics: generated saved passwords, typed
// values, keys and join tokens, cookies and URL queries go through each of them on a temp home,
// and none is found in any file they wrote. Writers: the run log hook (log.mjs: by design it keeps
// what was typed and whole addresses, as the person's own record, so there only saved passwords
// and card numbers must never show), the activity log, the goal log (journal), the trace lines
// daemon.log gets from typing (native/humanize.mjs), the Tools tab's diagnostics report, and the
// diagnostics bundle (scripts/diagnostics-bundle.mjs) with its CLI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { paths } from "../scripts/paths.mjs";
import { describe } from "../scripts/log.mjs";
import { createActivityLog } from "../scripts/daemon/activitylog.mjs";
import { createJournal } from "../scripts/daemon/journal.mjs";
import { createDiagnostics } from "../scripts/daemon/diagnostics.mjs";
import { humanType, humanFill } from "../scripts/native/humanize.mjs";
import { redact } from "../scripts/rules/secrets.mjs";
import { writeBundle } from "../scripts/diagnostics-bundle.mjs";

const ROUNDS = 12;
const hex = (n) => randomBytes(n).toString("hex");
const CARD = "4111 1111 1111 1111";
// Every file under a folder, as text.
const filesIn = (dir) => { const out = []; for (const n of readdirSync(dir)) { const f = join(dir, n); if (statSync(f).isDirectory()) out.push(...filesIn(f)); else out.push([f, readFileSync(f, "utf8")]); } return out; };
const none = (files, markers) => { for (const [f, text] of files) for (const [what, m] of Object.entries(markers)) assert.ok(!text.includes(m), `${what} (${m}) found in ${f}`); };

// A page that holds what is typed in it (enough for humanType and humanFill).
function fakePage(value) {
  const loc = { evaluate: async () => false, click: async () => {}, inputValue: async () => value, fill: async () => {}, isChecked: async () => false, selectOption: async () => {} };
  return { keyboard: { down: async () => {}, up: async () => {}, press: async () => {} }, locator: () => ({ first: () => loc }), evaluate: async () => value };
}

function round() {
  const m = { secret: `Pw${hex(6)}x`, typed: `typed${hex(5)}`, key: hex(32), cookie: `ck${hex(8)}`, query: `q${hex(6)}`, email: `u${hex(4)}@mail.example` };
  mkdirSync(paths.home, { recursive: true });
  writeFileSync(paths.secrets, `SITE_PASSWORD=${m.secret}\nSITE_PASSWORD_DOMAINS=shop.example\n`);
  chmodSync(paths.secrets, 0o600);
  return m;
}
const mask = (m) => (t) => redact(t, { SITE_PASSWORD: m.secret });
const urlWith = (m) => `https://shop.example/cart?code=${m.query}&k=${m.key}#t=${m.query}`;

test("the run log hook writes a saved password only as its name, and no card number", () => {
  for (let i = 0; i < ROUNDS; i++) {
    const m = round();
    for (const [tool, input] of [["browser_type", { element: "Password", text: m.secret }], ["browser_type", { element: "Notes", text: `my ${m.secret} here` }], ["browser_fill_form", { fields: [{ name: "Card number", value: CARD }, { name: "Notes", value: `x ${CARD}` }] }]]) {
      execFileSync(process.execPath, ["scripts/log.mjs"], { input: JSON.stringify({ tool_name: `mcp__plugin_pairbrowse_browser__${tool}`, tool_input: input, session_id: `s${i}` }), env: process.env });
    }
    none(filesIn(paths.log), { secret: m.secret, card: CARD, "card digits": CARD.replace(/ /g, "") });
  }
  assert.ok(filesIn(paths.log).some(([, t]) => t.includes("SITE_PASSWORD")), "the name is written instead");
});

test("the activity log and the goal log keep no typed value, saved password or URL query", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const m = round();
    const file = join(paths.home, `activity-${i}.json`);
    const log = createActivityLog({ where: () => ({ name: "default", file }), mask: mask(m), saveMs: 0 });
    let t = Date.parse("2026-10-16T10:00:00Z") + i * 60_000;
    const url = urlWith(m);
    const page = { url: () => url, title: async () => `Cart for ${m.secret}`, isClosed: () => false };
    const journal = createJournal({ session: () => `s${i}`, openPages: async () => [page], mask: mask(m), now: () => t, delayMs: 5 });
    const lines = [
      describe("browser_navigate", { url }, { values: false }),
      describe("browser_type", { element: "Notes", text: m.typed }, { values: false }),
      describe("browser_fill_form", { fields: [{ name: "Email", value: m.typed }, { name: "Password", value: m.secret }] }, { values: false }),
      describe("browser_select_option", { element: "Size", values: [m.typed] }, { values: false }),
      describe("browser_tabs", { action: "new", url }, { values: false }),
      `Clicked **Send** after ${m.secret}`,
    ];
    for (const text of lines) { log.add({ t: ++t, text, who: "Claude", tab: `Cart ${url}` }); journal.activity(text, "Claude", page); }
    journal.status("you", `Type ${m.secret} yourself`);
    await journal.flushNow();
    log.flush();
    assert.ok(filesIn(paths.runs).some(([, text]) => text.includes("shop.example/cart")), "the goal log was written");
    none([[file, readFileSync(file, "utf8")], ...filesIn(paths.runs)], { typed: m.typed, secret: m.secret, query: m.query });
  }
});

test("daemon.log's typing trace lines carry no typed value", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const m = round();
    const traced = [];
    const trace = (l) => { traced.push(l); appendFileSync(paths.daemonLog, `${new Date().toISOString()} ${l}\n`); };
    const settings = { typingPace: 1, formMove: "mouse" };
    await humanType(fakePage(m.typed), { target: "e1", name: "Notes", value: m.typed }, settings, { wait: async () => {}, trace, rng: () => 0.5 });
    await humanType(fakePage(m.secret), { target: "e2", name: "Password", value: m.secret, shown: "SITE_PASSWORD" }, settings, { wait: async () => {}, trace, rng: () => 0.5, slowly: true });
    await humanFill(fakePage(m.typed), [{ target: "e3", name: "Email", type: "textbox", value: m.typed }, { target: "e4", name: "Password", type: "textbox", value: m.secret, shown: "SITE_PASSWORD" }], settings, { wait: async () => {}, trace, rng: () => 0.5 });
    assert.equal(traced.length, 3);
    none([["trace", traced.join("\n")]], { typed: m.typed, secret: m.secret });
  }
});

// What may be in daemon.log from anywhere (an error message quoting a request or a page): the
// readers that leave the computer, or go in a bug report, must not pass it on.
function dirtyLog(m) {
  const at = new Date().toISOString();
  const port = 40000 + Number.parseInt(m.key.slice(0, 3), 16);
  appendFileSync(paths.daemonLog, [
    `${at} liveview error: failed GET http://127.0.0.1:${port}/${m.key}/state.json?x=${m.query}`,
    `${at} devshare: refused, cookie: sid=${m.cookie}; __pairbrowse_dev=${m.cookie}2`,
    `${at} sharing: join failed for ${m.email} with token=${m.key.slice(0, 20)} password: ${m.secret}`,
    `${at} type failed: "${m.typed}" lost at ${urlWith(m)} set-cookie: a=${m.cookie}3; Path=/`,
    `${at} uncaught exception: Error: crashed on ${urlWith(m)} for ${m.secret}`,
    `    at handler (${paths.home}/x.mjs:1:1) "${m.typed}"`,
    `    at /Users/someone/secret-project/${m.typed}.js:2:2`,
    "",
  ].join("\n"));
}

test("the Tools tab's diagnostics report passes on no secret, key, cookie, query, email or quoted text", async () => {
  for (let i = 0; i < ROUNDS; i++) {
    const m = round();
    dirtyLog(m);
    const diag = createDiagnostics({ version: "1.0.0", logFile: paths.daemonLog, home: paths.home, mask: mask(m) });
    const read = await diag.read();
    const text = diag.reportText({ ...read, joined: [{ role: "drive", name: m.typed }] });
    assert.ok(read.errors.length > 0, "the error lines are read");
    none([["report", text], ["errors", JSON.stringify(read)]], { secret: m.secret, key: m.key, cookie: m.cookie, query: m.query, email: m.email, typed: m.typed });
  }
});

test("the diagnostics bundle: versions, build, settings and the last crash, with nothing private", () => {
  for (let i = 0; i < ROUNDS; i++) {
    const m = round();
    dirtyLog(m);
    writeFileSync(paths.config, JSON.stringify({
      browser: "chromium", screenshots: true, proxy: { server: "http://proxy.example:8080", username: "u", password: m.secret },
      reportUrl: `https://r.example/api?k=${m.query}`, joinHosts: ["h.example"], chromeArgs: [`--x=${m.key}`, `--y="${m.typed}"`],
      helperKey: m.key, nested: { cookie: m.cookie, note: `mail ${m.email}`, deeper: { a: { b: { c: m.typed } } } },
    }));
    const out = mkdtempSync(join(tmpdir(), "pb-bundle-"));
    const { dir, files } = writeBundle({ out, home: paths.home, now: new Date(Date.UTC(2026, 9, 16, 10, i)) });
    assert.ok(dir.startsWith(out));
    const summary = JSON.parse(readFileSync(files[0], "utf8"));
    assert.equal(summary.versions.helper, JSON.parse(readFileSync("package.json", "utf8")).version);
    assert.equal(summary.config.browser, "chromium");
    assert.equal(summary.config.proxy, "[hidden]");
    assert.equal(summary.secrets.saved, 1);
    assert.match(summary.lastCrash.lines[0], /uncaught exception/);
    assert.ok(readFileSync(files[1], "utf8").includes("liveview error"));
    none(filesIn(dir), { secret: m.secret, key: m.key, cookie: m.cookie, query: m.query, email: m.email, typed: m.typed, home: paths.home });
  }
});

test("node scripts/diagnostics-bundle.mjs --out writes the folder and says where", () => {
  const out = mkdtempSync(join(tmpdir(), "pb-bundle-cli-"));
  const said = execFileSync(process.execPath, ["scripts/diagnostics-bundle.mjs", "--out", out], { env: process.env, encoding: "utf8" });
  const [dir] = readdirSync(out);
  assert.match(dir, /^pairbrowse-diagnostics-/);
  assert.deepEqual(readdirSync(join(out, dir)).sort(), ["daemon-log.txt", "summary.json"]);
  assert.ok(said.includes(join(out, dir)));
});

test("a timeline card's caption, when the bar has no line, names fields without their values", () => {
  // serve.mjs keeps it in the session's timeline index on disk: describe without values, as the bar.
  assert.match(readFileSync("scripts/daemon/serve.mjs", "utf8"), /caption: hud\.lastIn\(page\)\?\.text \|\| describe\(tool, args \|\| \{\}, \{ values: false \}\)/);
});
