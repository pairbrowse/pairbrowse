// The code's shape, kept by tests: no source file over its line budget (an allowlist with reasons,
// meant to shrink), the helper's parts (scripts/daemon/) import each other only along a known
// graph, so a new cross-import is a decision made here, and the fixed entry paths other programs
// name are listed once; any other re-export-only file is a leftover forwarder.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const rel = (p) => relative(ROOT, p).split(sep).join("/");
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
  return /\.(mjs|js)$/.test(e.name) ? [p] : [];
});
const SOURCES = ["scripts", "ui"].flatMap((d) => walk(join(ROOT, d)));
const lines = (p) => readFileSync(p, "utf8").split("\n").length - 1;

const MAX_LINES = 800;
// Over the budget for now, each with its reason and its size today: growing past it fails, and
// once under MAX_LINES it must leave this list.
const OVER = {
  "scripts/daemon.mjs": { max: 850, why: "the helper's composition root: wiring every part's deps (plan ST4: a thin root under 300 lines)" },
  "ui/right/right.js": { max: 825, why: "the side panel's right column, one page script served under a strict CSP" },
};

test(`no source file is over ${MAX_LINES} lines, except the reasoned few`, () => {
  const over = SOURCES.map((p) => [rel(p), lines(p)]).filter(([f, n]) => n > MAX_LINES && !(OVER[f] && n <= OVER[f].max));
  assert.deepEqual(over, [], "split it, or (with a reason) list it in OVER");
  for (const [f, { max }] of Object.entries(OVER)) {
    assert.ok(existsSync(join(ROOT, f)), `${f} is gone: take it off OVER`);
    const n = lines(join(ROOT, f));
    assert.ok(n > MAX_LINES, `${f} is ${n} lines now: take it off OVER`);
    assert.ok(n <= max, `${f} grew to ${n} lines (budget ${max})`);
  }
});

// Static imports and re-exports, and import("...") with a plain string.
const importsOf = (p) => [...readFileSync(p, "utf8").matchAll(/(?:^|\s)(?:import|export)\s[^;]*?\sfrom\s*["']([^"']+)["']|(?:^|\s)import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm)]
  .map((m) => m[1] || m[2] || m[3]).filter((s) => s.startsWith("."))
  .map((s) => resolve(dirname(p), s));

const DAEMON = join(ROOT, "scripts", "daemon");
// A part and the folders beside it (daemon/serve/, daemon/join/, ...) count as one when a file
// imports within its own folder; every other import between files under scripts/daemon/ is an edge.
const sameFolder = (a, b) => dirname(a) === dirname(b) && dirname(a) !== DAEMON;
const ALLOWED = new Set([
  // Parts that build on a shared piece.
  "context -> toolstab", "context -> where", "context -> browser/downloads", "context -> browser/state", "context -> browser/tabs",
  "context -> browser/launch", "context -> browser/supervise", "context -> sessions/picker", "context -> sessions/switch",
  "follow -> join/state", "follow -> join/hosts", "follow -> join/agents", "follow -> join/screens", "follow -> join/mirror",
  "recorder -> tablabels", "recorder -> capture", "recorder -> covers", "serve -> covers", "reveal -> page", "screenshot -> page",
  "serve -> browser/tabs", "serve -> output", "serve -> serve/wire", "serve -> serve/pageread", "serve -> serve/refuse",
  "serve -> serve/connection", "serve -> serve/turns", "serve -> serve/tools/index", "serve -> serve/rewrite",
  "serve -> serve/collaboration", "serve -> serve/result", "serve -> serve/departures",
  "sharing -> capture", "sharing -> tablabels", "sharing -> where", "sharing -> tunnel-pool",
  // The grant table keeps its audit lines' pages as the trail does and its words from the messages' lists.
  "grants -> audit", "grants -> notify/message",
  // Hand-offs read their step kinds and sentences as the messages word them, and a step's kind from the agent's words as the Tools tab does.
  "yourturn -> notify/message", "yourturn -> toolstab",
  // A part's own folder reaching back to a shared piece.
  "browser/downloads -> toolstab", "browser/launch -> exec-contexts", "browser/supervise -> where",
  "join/agents -> linkwait", "join/agents -> remote-agents", "join/mirror -> presence",
  "serve/collaboration -> output", "serve/connection -> output", "serve/pageread -> page", "serve/refuse -> approvals",
  "serve/refuse -> output", "serve/result -> output", "serve/result -> page", "serve/result -> reveal", "serve/result -> covers",
  "serve/rewrite -> drag", "serve/rewrite -> fields", "serve/rewrite -> page", "serve/tools/click-at -> serve/result", "serve/tools/drag -> serve/result",
  "serve/tools/click-at -> page", "serve/tools/click-at -> covers", "serve/tools/drag -> drag", "serve/tools/drag -> page", "serve/tools/run -> fields",
  "serve/turns -> linkwait", "sessions/picker -> where", "sessions/switch -> where",
]);
const part = (p) => rel(p).replace(/^scripts\/daemon\//, "").replace(/\.mjs$/, "");

test("the helper's parts import each other only along the known graph, and never the composition root", () => {
  const files = walk(DAEMON);
  const edges = new Set();
  for (const f of files) {
    for (const to of importsOf(f)) {
      assert.notEqual(to, join(ROOT, "scripts", "daemon.mjs"), `${rel(f)} imports daemon.mjs: pass what it needs as deps`);
      if (!to.startsWith(DAEMON + sep) || sameFolder(f, to)) continue;
      edges.add(`${part(f)} -> ${part(to)}`);
    }
  }
  const unknown = [...edges].filter((e) => !ALLOWED.has(e));
  assert.deepEqual(unknown, [], "a new import between the helper's parts: pass it through deps, or add the edge to ALLOWED with care");
  const gone = [...ALLOWED].filter((e) => !edges.has(e));
  assert.deepEqual(gone, [], "an allowed edge no longer exists: take it off ALLOWED");
});

// Paths other programs run or import by name: the hooks and MCP servers (hooks/hooks.json,
// .mcp.json), the native install step and tunnel keeper, and the old macos-app.mjs path the
// PairBrowse Pro repo's Linux build imports.
const ENTRY = ["scripts/launch.mjs", "scripts/runs.mjs", "scripts/guard.mjs", "scripts/log.mjs", "scripts/session-start.mjs",
  "scripts/native-install.mjs", "scripts/tunnel-keeper.mjs", "scripts/macos-app.mjs"];
// Re-export-only on purpose: ui/common.js is the pages' one module of shared parts (see its header).
const BARRELS = ["ui/common.js"];

test("the fixed entry paths are listed once and exist; no other file only forwards to another", () => {
  for (const f of ENTRY) assert.ok(existsSync(join(ROOT, f)), f);
  const named = ["hooks/hooks.json", ".mcp.json", "mcp.json"].filter((f) => existsSync(join(ROOT, f)))
    .flatMap((f) => [...readFileSync(join(ROOT, f), "utf8").matchAll(/scripts\/[\w/.-]+\.mjs/g)].map((m) => m[0]));
  for (const f of new Set(named)) assert.ok(ENTRY.includes(f), `${f} is named by a hook or server: list it in ENTRY`);
  const forwarders = SOURCES.filter((p) => {
    const code = readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, "").trim();
    return code && code.split("\n").every((l) => /^export\s+(\*|\{[^}]*\})\s+from\s+["'][^"']+["'];?$/.test(l.trim()));
  }).map(rel);
  assert.deepEqual(forwarders.filter((f) => !ENTRY.includes(f) && !BARRELS.includes(f)), [], "a re-export left at an old path: update its importers and remove it");
});
