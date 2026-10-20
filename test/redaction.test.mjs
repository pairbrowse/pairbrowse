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
      reportUrl: `https://r.example/api?k=${m.query}`, joinHosts: ["h.example"], browserArgs: [`--x=${m.key}`, `--y="${m.typed}"`],
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
  assert.match(readFileSync("scripts/daemon/serve.mjs", "utf8"), /caption = hud\.lastIn\(page\)\?\.text \|\| describe\(tool, args \|\| \{\}, \{ values: false \}\)/);
});

test("reserved secrets hidden from pairbrowse_facts, never typed, still masked", async () => {
  const { parseSecrets, setSecret, setReservedSecret, reservedSecret, RESERVED_RULE } = await import("../scripts/rules/secrets.mjs");
  const { secretNamesIn, reservedSecretsIn } = await import("../scripts/rules/policy.mjs");
  const { createFacts } = await import("../scripts/facts.mjs");
  const { createRefusals } = await import("../scripts/daemon/serve/refuse.mjs");
  const { stepsIn } = await import("../scripts/runner/steps.mjs");
  const reserved = "PAIRBROWSE_PROXY_HOME_PASSWORD";
  const value = `px${hex(6)}`;
  // A _DOMAINS line gives a reserved secret no sites.
  const store = parseSecrets(`${reserved}=${value}\n${reserved}_DOMAINS=evil.example\nSHOP_PW=shop-${hex(4)}\nSHOP_PW_DOMAINS=shop.example\n`);
  assert.deepEqual(store.domains[reserved], []);
  assert.deepEqual(store.domains.SHOP_PW, ["shop.example"]);
  assert.equal(reservedSecret(reserved), true);
  for (const n of ["SHOP_PW", "PAIRBROWSE_", "pairbrowse_x", "XPAIRBROWSE_A", null]) assert.equal(reservedSecret(n), false, String(n));

  // Hidden from pairbrowse_facts get; in the owner's Profile panel by name, marked reserved.
  const facts = createFacts({ secrets: { get: () => ({ ...store, problem: null }), save() {} }, file: join(mkdtempSync(join(tmpdir(), "pb-facts-")), "facts.json") });
  const got = facts.command({ action: "get" }).text;
  assert.ok(!got.includes(reserved) && !got.includes(value), got);
  assert.match(got, /SHOP_PW \(shop\.example\)/);
  assert.deepEqual(facts.summary().secrets, [{ name: reserved, domains: [], reserved: true }, { name: "SHOP_PW", domains: ["shop.example"] }]);
  assert.match(facts.command({ action: "remember", details: { Proxy: value } }).text, /looks like a saved password/, "never stored as a detail");

  // Never typed: not counted (so never swapped for its value) and refused, by tool and in fast mode.
  const names = Object.keys(store.values);
  assert.deepEqual(secretNamesIn("browser_type", { text: reserved }, names), []);
  assert.deepEqual(secretNamesIn("browser_fill_form", { fields: [{ value: reserved }, { value: "SHOP_PW" }] }, names), ["SHOP_PW"]);
  assert.deepEqual(reservedSecretsIn("browser_fill_form", { fields: [{ value: "a" }, { value: reserved }] }, names), [reserved]);
  const refusals = createRefusals({}, { secrets: { get: () => ({ ...store, problem: null }) }, secretNames: () => names, log() {}, serverUrl: async () => "https://evil.example/", serverPage: async () => null });
  assert.equal(await refusals.browserToolProblem("browser_type", { target: "e1", text: reserved }), RESERVED_RULE);
  assert.equal(await refusals.browserToolProblem("browser_fill_form", { fields: [{ target: "e1", value: reserved }] }), RESERVED_RULE);
  const run = await stepsIn({ url: () => "https://evil.example/" }, [{ fill: { Password: reserved } }], { secrets: store });
  assert.equal(run.ok, false);
  assert.equal(run.why, RESERVED_RULE);
  // Refused before any step runs: an ordinary field ahead of it, and earlier steps, are never touched.
  const { preflight } = await import("../scripts/runner.mjs");
  const { createRunTool } = await import("../scripts/daemon/serve/tools/run.mjs");
  for (const steps of [[{ fill: { Email: "a@b.c", Password: reserved } }], [{ go: "https://shop.example/" }, { click: "Sign in" }, { check: "Remember me" }, { fill: { Password: reserved } }]]) {
    const problem = preflight(steps, undefined, names);
    assert.match(problem, new RegExp(`^Step ${steps.length} \\(fill\\): PAIRBROWSE_ secrets`), problem);
    assert.match(problem, /Nothing was done/);
    // pairbrowse_run returns the refusal before it asks for a page at all.
    const asked = [];
    const { pairbrowse_run } = createRunTool({ disconnected: new AbortController() }, { secrets: { get: () => store }, serverPage: async () => { asked.push("page"); return null; }, context: { getContext: async () => { asked.push("context"); return null; } } });
    const r = await pairbrowse_run({ steps });
    assert.equal(r.error, true);
    assert.equal(r.text, problem);
    assert.deepEqual(asked, [], "the page is never touched");
  }
  // An unsaved PAIRBROWSE_ name is plain text: a hosting dashboard's variable name types as written.
  assert.deepEqual(reservedSecretsIn("browser_type", { text: "PAIRBROWSE_HOME" }, names), []);
  assert.equal(await refusals.browserToolProblem("browser_type", { target: "e1", text: "PAIRBROWSE_HOME" }), null);
  assert.equal(preflight([{ fill: { "Variable name": "PAIRBROWSE_HOME" } }], undefined, names), null);
  assert.equal(preflight([{ fill: { Password: reserved } }]), null, "no saved names: nothing reserved to refuse");

  // Still masked, wherever saved passwords are.
  assert.equal(redact(`proxy said ${value}`, store.values, { as: (n) => n }), `proxy said ${reserved}`);

  // The Profile panel's add form can't make one; PairBrowse's own writer needs 4+ characters.
  assert.match(setSecret({ values: {}, domains: {} }, { name: reserved, value: "x".repeat(8), domains: "a.example" }).error, /kept for PairBrowse/);
  assert.match(setSecret({ values: {}, domains: {} }, { name: "PAIRBROWSE_", value: "x".repeat(8), domains: "a.example" }).error, /kept for PairBrowse/, "the bare prefix too");
  assert.deepEqual(parseSecrets("PAIRBROWSE_=abcdef\nPAIRBROWSE__DOMAINS=a.example\n").domains.PAIRBROWSE_, []);
  assert.match(setReservedSecret({ values: {}, domains: {} }, { name: reserved, value: "abc" }).error, /at least 4 characters/);
  assert.match(setReservedSecret({ values: {}, domains: {} }, { name: "SHOP_PW", value: "abcdef" }).error, /starting with PAIRBROWSE_/);
  assert.match(setReservedSecret({ values: {}, domains: {} }, { name: reserved, value: "ab\ncd" }).error, /line breaks/);
  const next = setReservedSecret(store, { name: "PAIRBROWSE_NTFY_TOKEN", value: "tk_abcdef" });
  assert.equal(next.values.PAIRBROWSE_NTFY_TOKEN, "tk_abcdef");
  assert.deepEqual(next.domains.PAIRBROWSE_NTFY_TOKEN, []);
  assert.equal(next.values.SHOP_PW, store.values.SHOP_PW, "other secrets kept");
});
