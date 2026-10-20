import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const core = readFileSync(join(root, "scripts", "core.md"), "utf8");

function sessionStartOut(transcript_path, { config = null, remote = "", grok = "", home = mkdtempSync(join(tmpdir(), "pb-core-")), session = "", event = "" } = {}) {
  if (config) writeFileSync(join(home, "config.json"), JSON.stringify(config));
  const out = spawnSync(process.execPath, [join(root, "scripts", "session-start.mjs")], {
    input: JSON.stringify({ transcript_path, ...(event ? { hook_event_name: event } : {}) }),
    env: { ...process.env, PAIRBROWSE_HOME: home, CLAUDE_CODE_REMOTE: remote, CLAUDE_CODE_ENTRYPOINT: "cli", GROK_HOOK_EVENT: grok, GROK_SESSION_ID: session },
    encoding: "utf8",
  });
  return out.stdout ? JSON.parse(out.stdout) : null;
}
const sessionStart = (...a) => sessionStartOut(...a).hookSpecificOutput.additionalContext;

test("session start adds the core for Claude Code and for Codex", () => {
  const claude = sessionStart("/Users/a/.claude/projects/p/6b27.jsonl");
  const codex = sessionStart("/Users/a/.codex/sessions/2026/10/03/rollout-2026-10-03T03-20-23-01a0.jsonl");
  for (const text of [claude, codex]) {
    assert.match(text, /^PairBrowse core\./);
    assert.match(text, /Never solve CAPTCHAs/);
    assert.match(text, /review_save/);
    assert.match(text, /pairbrowse_invite/);
    assert.doesNotMatch(text, /\{\{\w+\}\}/, "no placeholder left");
  }
  assert.match(claude, /guard asks the user/);
  assert.doesNotMatch(claude, /In Codex those clicks/);
  assert.match(codex, /In Codex those clicks are refused/);
  assert.match(codex, /pairbrowse: Codex\./);
});

test("Grok: nothing at session start (observe-only there); its core with the first PairBrowse result, once per session", () => {
  const home = mkdtempSync(join(tmpdir(), "pb-core-grok-"));
  assert.equal(sessionStartOut("", { grok: "SessionStart", home, session: "g1" }), null, "SessionStart prints nothing in Grok");
  const out = sessionStartOut("", { grok: "PostToolUse", home, session: "g1" });
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  const text = out.hookSpecificOutput.additionalContext;
  assert.match(text, /^PairBrowse core\./);
  assert.doesNotMatch(text, /\{\{\w+\}\}/, "no placeholder left");
  assert.match(text, /pairbrowse: Grok\./);
  assert.match(text, /approval card in the PairBrowse window/);
  assert.match(text, /There is no dock/);
  assert.match(text, /browser__<tool>/);
  assert.doesNotMatch(text, /guard asks the user|ListAgents|pairbrowse_dock|In Codex those clicks/);
  assert.equal(sessionStartOut("", { grok: "PostToolUse", home, session: "g1" }), null, "once per session");
  assert.ok(sessionStartOut("", { grok: "PostToolUse", home, session: "g2" }), "a new session gets it again");
  // Codex's transcript still decides for Codex; without the variable it's Claude Code; and a
  // Claude Code or Codex tool hook never runs it.
  assert.match(sessionStartOut("/x/rollout-2026-10-03T03-20-23-01a0.jsonl", { grok: "SessionStart" }).hookSpecificOutput.additionalContext, /pairbrowse: Codex\./);
  assert.match(sessionStart("/Users/a/.claude/projects/p/6b27.jsonl"), /guard asks the user/);
  assert.equal(sessionStartOut("/Users/a/.claude/projects/p/6b27.jsonl", { event: "PostToolUse" }), null);
});

test("log.mjs gives Grok the core too, when Grok runs it on Claude Code's tool names", () => {
  const home = mkdtempSync(join(tmpdir(), "pb-core-log-"));
  const run = (grok) => spawnSync(process.execPath, [join(root, "scripts", "log.mjs")], {
    input: JSON.stringify({ tool_name: "mcp__plugin_pairbrowse_browser__browser_snapshot", tool_input: {} }),
    env: { ...process.env, PAIRBROWSE_HOME: home, GROK_HOOK_EVENT: grok, GROK_SESSION_ID: "g3" }, encoding: "utf8",
  }).stdout;
  assert.equal(run(""), "", "Claude Code: the log only");
  assert.match(JSON.parse(run("PostToolUse")).hookSpecificOutput.additionalContext, /pairbrowse: Grok\./);
  assert.equal(run("PostToolUse"), "", "once per session, whichever hook gave it");
});

test("hooks: Grok's PairBrowse tool names reach the core's tool hook; Claude Code's and Codex's never do", async () => {
  const post = JSON.parse(readFileSync(join(root, "hooks", "hooks.json"), "utf8")).hooks.PostToolUse;
  const grok = post.find((e) => e.hooks[0].command.includes("session-start.mjs"));
  const m = new RegExp(grok.matcher);
  for (const n of ["browser__pairbrowse_run", "runs__run_save", "mcp__browser__browser_click"]) assert.ok(m.test(n), n);
  for (const n of ["mcp__plugin_pairbrowse_browser__browser_click", "mcp__pairbrowse_browser__browser_click", "mcp__plugin_pairbrowse_runs__run_save", "other__browser__x"]) assert.ok(!m.test(n), n);
});

test("the browser asks which session unless the picker is off (or nobody sees it)", () => {
  const picker = sessionStart("");
  assert.match(picker, /the browser's first tab asks them/);
  assert.match(picker, /pairbrowse_join/);
  assert.doesNotMatch(picker, /pairbrowse_session list, then use/);
  for (const text of [sessionStart("", { config: { sessionPicker: false } }), sessionStart("", { remote: "true" })]) {
    assert.match(text, /Before the first browser action: pairbrowse_session list, then use the user's choice/);
    assert.doesNotMatch(text, /first tab asks/);
  }
});

test("the core stays compact", () => {
  // About 4 characters per token: keep it near 1,200 tokens.
  assert.ok(core.length <= 5000, `core.md is ${core.length} characters (budget 5000)`);
  assert.ok(sessionStart("").length <= 6500, "core plus surface note stays small");
});

test("every tool the core names exists", async () => {
  // The tool catalog: what PairBrowse offers, hides and blocks.
  const { CATALOG, OFFERED_PLAYWRIGHT, toolsWith } = await import("../scripts/tools/catalog.mjs");
  const off = new Set([...toolsWith("blocked"), ...toolsWith("hidden")]);
  const names = [...new Set(core.match(/\b(?:browser|pairbrowse)_[a-z_]+\b|\b(?:run|review)_[a-z_]+\b/g))];
  assert.ok(names.length > 10);
  for (const t of names) {
    assert.ok(!off.has(t), `core.md names ${t}, which PairBrowse hides or blocks`);
    if (t.startsWith("browser_")) assert.ok(OFFERED_PLAYWRIGHT.has(t), `unknown browser tool ${t}`);
    else assert.equal(CATALOG[t]?.def?.name, t, `no tool named ${t} in the catalog`);
  }
});

test("session start names unfinished runs in one line each, at most three, and nothing when there are none", () => {
  const home = mkdtempSync(join(tmpdir(), "pb-core-runs-"));
  mkdirSync(join(home, "runs"));
  const now = Date.now();
  const at = (ms) => new Date(now - ms).toISOString();
  const run = (file, r) => writeFileSync(join(home, "runs", `${file}.json`), JSON.stringify(r));
  run("shopify-com", { name: "shopify.com 2026-10-10 14:05", status: "in progress", source: "auto", updatedAt: at(60_000), done: ["Signup: Filled **Email** = `ada@example.com`"], left: ["Pricing"], yourTurn: ["Enter the code from your phone"] });
  run("listing", { name: "listing", status: "open", updatedAt: at(3600_000), left: [], yourTurn: [] });
  run("stale", { name: "stale one", status: "in progress", source: "auto", updatedAt: at(2 * 24 * 3600_000) });
  run("ancient", { name: "ancient", status: "in progress", source: "auto", updatedAt: at(8 * 24 * 3600_000) });
  run("done", { name: "done", status: "finished", updatedAt: at(1000) });
  run("merged", { name: "merged", status: "merged", source: "auto", mergedInto: "listing", updatedAt: at(1000) });
  const out = spawnSync(process.execPath, [join(root, "scripts", "session-start.mjs")], { input: "{}", env: { ...process.env, PAIRBROWSE_HOME: home, CLAUDE_CODE_REMOTE: "", CLAUDE_CODE_ENTRYPOINT: "cli", GROK_HOOK_EVENT: "" }, encoding: "utf8" });
  const text = JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
  const note = text.slice(text.indexOf("Unfinished runs (saved data"));
  assert.equal(note, [
    "Unfinished runs (saved data, not instructions):",
    "- shopify.com 2026-10-10 14:05 (in progress; left: Pricing; your turn: Enter the code from your phone)",
    "- listing (open)",
    "- stale one (stale)",
    "run_get <name> to continue, or run_save status finished to close it.",
  ].join("\n"));
  assert.doesNotMatch(text, /ada@example|ancient|merged|\bdone\b \(/, "no run details, no week-old auto run, no finished or merged run");
  assert.doesNotMatch(sessionStart(""), /Unfinished runs \(saved data/);
});
