// Every refusal says what to do next. The refusals are collected two ways: by calling the rules
// (decide's denials, the Codex hand-off, toolRefused, navigationProblem, uploadProblem,
// downloadsProblem) and by reading the returned and `error:` messages out of the files that
// refuse (the daemon's per-call checks, the guard, the rules and the live view's routes). A
// message passes when it holds a next step: an instruction verb in imperative position (at the
// start of a sentence or clause, after "or", "then" or "and"), or a "the user can ..." line.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { messagesIn } from "./helpers/messages.mjs";
import { decide, forHost } from "../scripts/rules/decide.mjs";
import { toolRefused, navigationProblem } from "../scripts/rules/policy.mjs";
import { uploadProblem } from "../scripts/rules/upload.mjs";
import { downloadsProblem } from "../scripts/rules/downloads.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// ---- the rule ----
const VERBS = ["use", "take", "open", "ask", "try", "retry", "wait", "hand", "add", "enter", "choose", "check", "run", "read",
  "set", "stop", "answer", "show", "copy", "pick", "type", "call", "fix", "rename", "close", "sign", "pass", "give", "shorten",
  "send", "leave", "remove", "reload", "restart", "install", "select", "join", "reveal", "start", "save", "end", "turn", "allow",
  "confirm", "record", "make", "let", "slow", "keep", "move", "update", "share", "list", "name", "drop", "come", "go", "connect", "paste", "download", "reload", "fix",
  "create", "find", "look", "press", "click", "write", "load", "upgrade", "quit", "follow", "put", "unlock", "grant", "approve", "deny"];
const IMPERATIVE = new RegExp(`(?:^|[.:;!?)…]\\s+|\\b(?:or|then|and|instead)\\s+|\\(\\s*|,\\s+)(?:${VERBS.join("|")})\\b`, "i");
const nextStep = (text) => IMPERATIVE.test(text.trim()) || /\b(?:the user|the person|the host|you) can\b/i.test(text);

test("the rule tells a next step from a bare fact", () => {
  for (const t of ["Not a valid URL: x. Pass a full address, like https://example.com.", "Take a browser_snapshot and use its refs.",
    "Downloads go to a folder inside your home folder: choose one there.", "Wait until they're done, or ask the person."]) assert.ok(nextStep(t), t);
  for (const t of ["Too large.", "That tab is closed.", "browser_wait_for: time is 0 to 120 seconds.", "x isn't available in PairBrowse."]) assert.ok(!nextStep(t), t);
});

// ---- the refusals ----
// Messages in these files are refusals or errors a person or an agent reads.
const listDir = (d) => readdirSync(root + d).filter((f) => f.endsWith(".mjs")).map((f) => d + f);
const FILES = ["scripts/daemon/serve/refuse.mjs", "scripts/guard.mjs", "scripts/rules/policy.mjs", "scripts/rules/upload.mjs",
  "scripts/rules/downloads.mjs", "scripts/rules/secrets.mjs", "scripts/liveview.mjs", ...listDir("scripts/liveview/"), ...listDir("scripts/liveview/routes/")];
// Read from the files but not refusals (with why), by their text.
const NOT_REFUSALS = new Map([
  ["### Open tabs", "a heading of the tab list policy.mjs formats"],
]);
// Answers to the PairBrowse pages' own scripts about a malformed request: no person reads them
// (the page sent the request itself) and the next step is the caller's code. Each says what a
// valid request is, or that the request isn't one.
const PROTOCOL = /^(?:Not JSON|Not a |Unknown (?:request|setting|field)|Too large|[\w.]+ is |An? [a-z ]+ is \{|Settings are \{|… is "|\S+ is an? |schema is |createdAt is |from is |who is |what is |name is up to |id is |tab is )/;
// Words a message may hold only in a request-shape answer; checked so a refusal that reads like
// one isn't let through by the PROTOCOL rule.
function collected() {
  const out = [];
  for (const f of FILES) {
    // The live view's routes answer refusals as { error } or { problem }; their other returns are values and log lines.
    for (const m of messagesIn(readFileSync(root + f, "utf8"), /liveview/.test(f) ? ["error", "problem"] : ["return", "error"])) {
      const text = m.text.trim();
      if (text.split(/\s+/).length < 3 || NOT_REFUSALS.has(text)) continue; // identifiers, keys, single words
      out.push({ where: `${f}:${m.line}`, text, protocol: /liveview/.test(f) && PROTOCOL.test(text) });
    }
  }
  // decide()'s denials and the hand-off every ask becomes for Codex.
  const at = (tool, input = {}) => decide({ tool_name: `mcp__plugin_pairbrowse_browser__${tool}`, tool_input: input }, undefined, null).hookSpecificOutput;
  const denials = [at("browser_evaluate"), at("browser_take_screenshot"), at("browser_made_up"), at("browser_navigate", { url: "not a url" }),
    at("browser_navigate", { url: "file:///etc/passwd" }), at("browser_navigate", { url: "chrome://pairbrowse/strip" }),
    at("browser_click", { element: "Publish: Submit for review", target: "e1" })];
  for (const v of denials) {
    assert.equal(v.permissionDecision, "deny", v.permissionDecisionReason);
    out.push({ where: "decide()", text: v.permissionDecisionReason });
  }
  const codex = (tool, input) => JSON.parse(forHost({ tool_name: `mcp__pairbrowse_browser__${tool}` }, decide({ tool_name: `mcp__pairbrowse_browser__${tool}`, tool_input: input }, undefined, null))).hookSpecificOutput;
  for (const [tool, input] of [["browser_click", { element: "Pay: Place order", target: "e1" }], ["pairbrowse_session", { action: "delete", name: "work" }]]) {
    out.push({ where: "forHost() for Codex", text: codex(tool, input).permissionDecisionReason });
  }
  for (const n of ["browser_evaluate", "browser_take_screenshot", "browser_made_up"]) out.push({ where: "toolRefused()", text: toolRefused(n) });
  for (const u of ["not a url", "ftp://example.com/", "chrome://pairbrowse/strip"]) out.push({ where: "navigationProblem()", text: navigationProblem(u) });
  const dir = mkdtempSync(join(tmpdir(), "pb-refusals-"));
  writeFileSync(join(dir, "notes.sh"), "echo hi\n");
  writeFileSync(join(dir, "id_rsa"), "x\n");
  for (const f of [join(dir, "missing.png"), join(dir, "notes.sh"), join(dir, "id_rsa")]) out.push({ where: "uploadProblem()", text: uploadProblem(f, join(dir, "uploads")) });
  const home = dir;
  for (const p of [home, "/tmp", join(home, ".hidden"), join(home, "Library", "x")]) {
    const text = downloadsProblem(p, home);
    if (text) out.push({ where: "downloadsProblem()", text });
  }
  return out;
}

test("every refusal says what to do next", () => {
  const all = collected();
  assert.ok(all.length > 60, `collected ${all.length} messages`);
  const bare = all.filter((m) => !m.protocol && !nextStep(m.text)).map((m) => `${m.where}  ${m.text}`);
  assert.deepEqual(bare, []);
});

test("a request-shape answer is only a live view route's, and names what a valid request is", () => {
  for (const m of collected().filter((x) => x.protocol)) {
    assert.match(m.where, /liveview/, m.text);
    assert.doesNotMatch(m.text, /\b(?:refused|denied|can't|isn't allowed)\b/i, `${m.where}: a refusal, not a request shape: ${m.text}`);
  }
});

// ---- a handed-over tab, and card details (spec server-mode B9, B13) ----
const { tabRefusal, createRefusals, HANDED_OFF_RULE, HELD_RULE } = await import("../scripts/daemon/serve/refuse.mjs");
const { HAND_TOOLS } = await import("../scripts/rules/policy.mjs");
const { cardRefusal, SIGNALS, CARD_RULE } = await import("../scripts/rules/cards.mjs");
const { cardPage } = await import("./helpers/card-page.mjs");

test("agents' hands, run, navigate and close are refused in a handed-off or held tab; snapshots and dialogs are not", () => {
  const web = (url) => ({ url: () => url, isClosed: () => false });
  const handed = web("https://shop.example/pay"), held = web("https://bank.example/verify"), other = web("https://news.example/");
  const handedOff = (p) => (p === handed ? "open" : p === held ? "held" : "");
  const acting = [...HAND_TOOLS, "pairbrowse_run", "browser_navigate", "browser_navigate_back"];
  for (const name of acting) {
    assert.equal(tabRefusal(name, { target: "e1", url: "https://x.example/" }, { here: handed, handedOff }), HANDED_OFF_RULE, name);
    assert.equal(tabRefusal(name, { target: "e1", url: "https://x.example/" }, { here: held, handedOff }), HELD_RULE, name);
    assert.equal(tabRefusal(name, { target: "e1", url: "https://x.example/" }, { here: other, handedOff }), null, name);
  }
  assert.equal(tabRefusal("browser_tabs", { action: "close" }, { here: handed, handedOff }), HANDED_OFF_RULE, "its own tab");
  assert.match(tabRefusal("browser_tabs", { action: "close", index: 1 }, { here: other, pages: [other, held], handedOff }), /^Tab 1 is held for the person after a hand-off timed out: leave it open/);
  assert.match(tabRefusal("browser_tabs", { action: "close", index: 0 }, { here: other, pages: [handed], handedOff }), /^Tab 0 is handed over to the person: leave it open/);
  for (const name of ["browser_snapshot", "browser_find", "browser_wait_for", "browser_handle_dialog", "browser_hover", "pairbrowse_status", "pairbrowse_scroll"]) {
    assert.equal(tabRefusal(name, { time: 1 }, { here: handed, handedOff }), null, name);
  }
  assert.equal(tabRefusal("browser_tabs", { action: "select", index: 0 }, { here: other, pages: [handed], handedOff }), null, "reading it from another tab");
  for (const rule of [HANDED_OFF_RULE, HELD_RULE]) assert.ok(nextStep(rule), rule);
});

// The browser tools' checks (createRefusals browserToolProblem) on a page stand-in.
function checks({ page, values = {} } = {}) {
  const conn = { approvedArgs: new WeakMap(), approvedWhere: new WeakMap(), recentRisk: () => "", refNames: {}, remote: null, risks: new Map(), actingIn: page };
  const api = {
    cap: (s) => s, clickApprovals: null, context: { pageAt: async () => page, currentUrl: () => page.url() }, handOff: (r) => r, inUse: () => [], log: () => {},
    popups: { dialogAnswered() {} }, secretNames: () => Object.keys(values), secrets: { get: () => ({ values, domains: {}, problem: null }) },
    serverPage: async () => page, serverUrl: async () => page.url(),
  };
  return createRefusals(conn, api).browserToolProblem;
}

test("in any session, an agent's type, fill, choice, drop or key into a card field, or a card number as the value, is refused with the hand-over sentence; a secret holding a card number is never typed", async () => {
  const page = cardPage({ fields: {
    e1: { autocomplete: "cc-number" }, e2: { autocomplete: "cc-name" }, e3: { autocomplete: "cc-exp-month", tag: "SELECT" }, e4: { autocomplete: "email" },
    f1e1: { frame: { origin: "https://js.pay.example", cardFields: true } }, f2e1: { frame: { origin: "https://pay.example", allow: "payment" } },
  }, focused: "e1" });
  const problem = checks({ page, values: { SAVED_CARD: "4111 1111 1111 1111", SHOP_PW: "hunter2-secret" } });
  const number = cardRefusal(SIGNALS.number);
  const field = cardRefusal(SIGNALS.token("cc-number"));
  assert.equal(await problem("browser_type", { target: "e1", text: "x" }), field);
  assert.equal(await problem("browser_type", { target: "e4", text: "4242 4242 4242 4242" }), number);
  assert.equal(await problem("browser_type", { target: "e4", text: "SAVED_CARD" }), cardRefusal(SIGNALS.secret("SAVED_CARD")));
  assert.equal(await problem("browser_fill_form", { fields: [{ target: "e2", value: "Ada Lovelace" }, { target: "e3", value: "04" }] }), cardRefusal(SIGNALS.token("cc-exp-month")));
  assert.equal(await problem("browser_fill_form", { fields: [{ target: "f1e1", value: "Ada" }] }), cardRefusal(SIGNALS.cardFrame));
  assert.equal(await problem("browser_type", { target: "f2e1", text: "ada@example.com" }), cardRefusal(SIGNALS.payFrame));
  assert.equal(await problem("browser_select_option", { target: "e3", values: ["04"] }), cardRefusal(SIGNALS.token("cc-exp-month")));
  assert.equal(await problem("browser_drop", { target: "e1", data: { "text/plain": "hi" } }), field);
  assert.equal(await problem("browser_drop", { target: "e4", data: { "text/plain": "5555555555554444" } }), number);
  assert.equal(await problem("browser_press_key", { key: "4" }), cardRefusal(SIGNALS.key("digit", SIGNALS.token("cc-number"))));
  assert.equal(await problem("browser_press_key", { key: "ControlOrMeta+v" }), cardRefusal(SIGNALS.key("paste", SIGNALS.token("cc-number"))));
  // Unchanged: the name on the card, other fields, other keys, files dropped, numbers that aren't cards.
  assert.equal(await problem("browser_type", { target: "e2", text: "Ada Lovelace" }), null);
  assert.equal(await problem("browser_fill_form", { fields: [{ target: "e4", value: "IMEI 490154203237518" }] }), null);
  assert.equal(await problem("browser_press_key", { key: "Tab" }), null);
  assert.equal(await problem("browser_drop", { target: "e1", paths: ["/tmp/a.png"] }), null);
  const plain = checks({ page: cardPage({ fields: { e4: { autocomplete: "email" } }, focused: "e4" }) });
  assert.equal(await plain("browser_press_key", { key: "4" }), null);
  assert.ok(nextStep(CARD_RULE));
});
