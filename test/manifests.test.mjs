import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

test("Claude Code and Codex manifests describe the same plugin version", () => {
  const versions = [json(".claude-plugin/plugin.json").version, json(".claude-plugin/marketplace.json").plugins[0].version, json(".codex-plugin/plugin.json").version, json("package.json").version];
  assert.equal(new Set(versions).size, 1, versions.join(" "));
  assert.equal(json(".codex-plugin/plugin.json").name, json(".claude-plugin/plugin.json").name);
});

test("the Codex plugin's files exist and its servers are the ones the hooks and guard know", async () => {
  const codex = json(".codex-plugin/plugin.json");
  for (const p of [codex.skills, codex.mcpServers, codex.interface.logo, codex.interface.composerIcon]) assert.ok(existsSync(join(root, p)), p);
  const servers = json(codex.mcpServers.replace(/^\.\//, "")).mcpServers;
  assert.deepEqual(Object.keys(servers).sort(), ["pairbrowse_browser", "pairbrowse_runs"]);
  for (const s of Object.values(servers)) {
    assert.equal(s.cwd, ".");
    assert.ok(existsSync(join(root, s.args[0])), s.args[0]);
  }
  const hooks = json("hooks/hooks.json").hooks;
  const pre = new RegExp(`^(${hooks.PreToolUse[0].matcher})$`);
  const post = new RegExp(`^(${hooks.PostToolUse[0].matcher})$`);
  for (const name of ["mcp__plugin_pairbrowse_browser__browser_click", "mcp__pairbrowse_browser__browser_click", "mcp__plugin_pairbrowse_runs__run_save", "mcp__pairbrowse_runs__run_save"]) assert.ok(pre.test(name), name);
  for (const name of ["mcp__plugin_pairbrowse_browser__browser_click", "mcp__pairbrowse_browser__browser_click"]) assert.ok(post.test(name), name);
  assert.ok(!pre.test("mcp__browser__browser_click"), "another app's browser server isn't guarded by PairBrowse");
  const { isCodexTool } = await import("../scripts/guard.mjs");
  assert.ok(isCodexTool("mcp__pairbrowse_browser__browser_click"));
  assert.ok(!isCodexTool("mcp__plugin_pairbrowse_browser__browser_click"));
});
