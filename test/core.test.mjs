import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const core = readFileSync(join(root, "scripts", "core.md"), "utf8");

function sessionStart(transcript_path) {
  const home = mkdtempSync(join(tmpdir(), "pb-core-"));
  const out = spawnSync(process.execPath, [join(root, "scripts", "session-start.mjs")], {
    input: JSON.stringify({ transcript_path }),
    env: { ...process.env, PAIRBROWSE_HOME: home, CLAUDE_CODE_REMOTE: "", CLAUDE_CODE_ENTRYPOINT: "cli" },
    encoding: "utf8",
  });
  return JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
}

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

test("the core stays compact", () => {
  // About 4 characters per token: keep it near 1,200 tokens.
  assert.ok(core.length <= 5000, `core.md is ${core.length} characters (budget 5000)`);
  assert.ok(sessionStart("").length <= 6500, "core plus surface note stays small");
});

test("every tool the core names exists", () => {
  const scripts = join(root, "scripts");
  const sources = readdirSync(scripts, { recursive: true }).filter((f) => f.endsWith(".mjs")).map((f) => readFileSync(join(scripts, f), "utf8")).join("\n");
  const policy = readFileSync(join(scripts, "policy.mjs"), "utf8");
  const setOf = (name) => [...policy.match(new RegExp(`${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  const off = new Set([...setOf("BLOCKED_TOOLS"), ...setOf("HIDDEN_TOOLS")]);
  // Passed through from the pinned @playwright/mcp (see the skills repo's validate.mjs).
  const playwright = new Set(["browser_navigate", "browser_navigate_back", "browser_snapshot", "browser_click", "browser_type",
    "browser_fill_form", "browser_select_option", "browser_press_key", "browser_hover", "browser_drag", "browser_drop",
    "browser_tabs", "browser_wait_for", "browser_find", "browser_handle_dialog", "browser_file_upload"]);
  const names = [...new Set(core.match(/\b(?:browser|pairbrowse)_[a-z_]+\b|\b(?:run|review)_[a-z_]+\b/g))];
  assert.ok(names.length > 10);
  for (const t of names) {
    assert.ok(!off.has(t), `core.md names ${t}, which PairBrowse hides or blocks`);
    if (t.startsWith("browser_")) assert.ok(playwright.has(t), `unknown browser tool ${t}`);
    else assert.match(sources, new RegExp(`name: "${t}"`), `no tool named ${t} in scripts/`);
  }
});
