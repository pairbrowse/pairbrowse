#!/usr/bin/env node
// Checks every skills/<name>/SKILL.md: front matter with a name (matching the folder) and a
// description, a length limit, and that every tool name it mentions is one PairBrowse offers.
// Node standard library only. Usage: node scripts/validate-skills.mjs
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, OFFERED_PLAYWRIGHT, toolsFrom, toolsWith } from "./tools/catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_LINES = 130;

// Tools the PairBrowse plugin offers Claude, from the tool catalog: its own tools, the pinned
// @playwright/mcp tools it passes through and the runs server's (the catalog hides and blocks the rest).
const PAIRBROWSE_TOOLS = [...toolsFrom("helper"), ...toolsFrom("launch")];
const PLAYWRIGHT_TOOLS = [...OFFERED_PLAYWRIGHT];
const RUNS_TOOLS = [...toolsFrom("runs")];
// The host app's own tools (Claude Code, not PairBrowse) a skill may name, for coordinating the
// user's own sessions. Any other `PascalCase` tool name in backticks is flagged.
const HOST_APP_TOOLS = ["ListAgents", "SendMessage"];
// Named only to say "don't": hidden from Claude, and asks the user when called anyway.
const MENTION_ONLY = [...toolsWith("mentionOnly")];

const errors = [];
// The disabled and hidden tools: a skill must never name them.
const BLOCKED = [...toolsWith("blocked")];
const HIDDEN = [...toolsWith("hidden")].filter((t) => !MENTION_ONLY.includes(t));

// Each of PairBrowse's own tools has its definition, under its own name.
for (const t of [...PAIRBROWSE_TOOLS, ...RUNS_TOOLS]) {
  if (CATALOG[t].def?.name !== t) errors.push(`the plugin no longer defines ${t}`);
}

const allowed = new Set([...PAIRBROWSE_TOOLS, ...PLAYWRIGHT_TOOLS, ...RUNS_TOOLS, ...MENTION_ONLY]);
const TOOL_TOKEN = /\b(?:browser|pairbrowse)_[a-z_]+\b|\b(?:run|review)_[a-z_]+\b/g;
const HOST_TOKEN = /`([A-Z][a-z]+(?:[A-Z][a-z]*)+)`/g;

const skillsDir = join(root, "skills");
const skills = readdirSync(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
if (!skills.length) errors.push("no skills found in skills/");

for (const dir of skills) {
  const file = join(skillsDir, dir, "SKILL.md");
  const where = `skills/${dir}/SKILL.md`;
  if (!existsSync(file)) { errors.push(`${where}: missing`); continue; }
  const text = readFileSync(file, "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fm) { errors.push(`${where}: no YAML front matter`); continue; }
  const field = (k) => fm[1].match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim();
  const name = field("name");
  const description = field("description");
  if (!name) errors.push(`${where}: front matter has no name`);
  else if (name !== dir) errors.push(`${where}: name "${name}" doesn't match folder "${dir}"`);
  else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) errors.push(`${where}: name must be lowercase with hyphens`);
  if (!description) errors.push(`${where}: front matter has no description`);
  else if (description.length > 1024) errors.push(`${where}: description over 1024 characters`);
  const lines = text.split("\n").length;
  // The main pairbrowse skill is the long reference behind the always-on core.
  if (dir !== "pairbrowse" && lines > MAX_LINES) errors.push(`${where}: ${lines} lines (limit ${MAX_LINES})`);

  const tokens = [...new Set(text.match(TOOL_TOKEN) || [])];
  for (const t of tokens) {
    if (BLOCKED.includes(t)) errors.push(`${where}: names ${t}, which PairBrowse disables`);
    else if (HIDDEN.includes(t)) errors.push(`${where}: names ${t}, which PairBrowse doesn't offer`);
    else if (!allowed.has(t)) errors.push(`${where}: unknown tool name ${t}`);
  }
  const hostTools = [...new Set([...text.matchAll(HOST_TOKEN)].map((m) => m[1]))];
  for (const t of hostTools) if (!HOST_APP_TOOLS.includes(t)) errors.push(`${where}: unknown host app tool ${t}`);
  const named = [...tokens.sort(), ...hostTools.sort()];
  console.log(`ok  ${where}  (${lines} lines, ${named.length} tool names: ${named.join(", ")})`);
}

if (errors.length) {
  for (const e of errors) console.error(`FAIL ${e}`);
  process.exit(1);
}
console.log(`All ${skills.length} skills valid.`);
