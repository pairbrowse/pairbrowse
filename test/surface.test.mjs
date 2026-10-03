import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = "/Users/dion/.pairbrowse";
const { detectSurface, surfaceGuidance } = await import("../scripts/surface.mjs");

test("pairbrowse knows where Claude Code runs", () => {
  assert.equal(detectSurface({ CLAUDE_CODE_REMOTE: "true", CLAUDE_CODE_ENTRYPOINT: "remote_desktop" }), "cloud");
  assert.equal(detectSurface({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }), "desktop");
  assert.equal(detectSurface({ CLAUDE_CODE_ENTRYPOINT: "claude-vscode" }), "ide");
  assert.equal(detectSurface({ CLAUDE_CODE_ENTRYPOINT: "cli" }), "terminal");
  assert.equal(detectSurface({}), "terminal", "unknown falls back to a normal window");
});

test("session start tells Claude how the user sees the browser", () => {
  const home = mkdtempSync(join(tmpdir(), "pb-ss-"));
  const run = (env) => JSON.parse(spawnSync(process.execPath, ["scripts/session-start.mjs"], { env: { ...process.env, PAIRBROWSE_HOME: home, ...env }, encoding: "utf8" }).stdout).hookSpecificOutput.additionalContext;
  assert.match(run({ CLAUDE_CODE_REMOTE: "", CLAUDE_CODE_ENTRYPOINT: "cli" }), /PairBrowse browser/);
  assert.match(run({ CLAUDE_CODE_REMOTE: "", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }), /pairbrowse_dock/);
  assert.match(run({ CLAUDE_CODE_REMOTE: "true" }), /cloud session/);
});

test("terminal and IDE use the PairBrowse browser; the desktop app docks it in the workspace", () => {
  assert.match(surfaceGuidance("terminal"), /PairBrowse browser/);
  assert.match(surfaceGuidance("ide"), /PairBrowse browser/);
  assert.match(surfaceGuidance("desktop"), /pairbrowse_dock/);
  assert.match(surfaceGuidance("desktop"), /workspace/);
});

test("the session hook tells Codex from Claude Code by the transcript", async () => {
  const { detectHost, surfaceGuidance } = await import("../scripts/surface.mjs");
  assert.equal(detectHost({ transcript_path: "/Users/a/.codex/sessions/2026/10/03/rollout-2026-10-03T03-20-23-01a0.jsonl" }), "codex");
  assert.equal(detectHost({ transcript_path: "/Users/a/.claude/projects/p/6b27.jsonl" }), "claude");
  assert.equal(detectHost({}), "claude");
  assert.match(surfaceGuidance("terminal", "codex"), /^pairbrowse: Codex\..*what Codex is doing.*click those themselves/);
  assert.doesNotMatch(surfaceGuidance("terminal", "claude"), /Codex/);
});
