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
