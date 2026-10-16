// The tool catalog (scripts/tools/catalog.mjs): every tool's definition and rules in one place,
// read by serve.mjs, guard.mjs, policy.mjs, launch.mjs, runs.mjs and validate-skills.mjs.
// (shared-browser.integration checks the live tools/list against it.)
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, HELPER_TOOLS, OFFERED_PLAYWRIGHT, RUNS_TOOLS, toolsWith, toolsFrom } from "../scripts/tools/catalog.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const RULES = new Set(["blocked", "hidden", "mentionOnly", "screenshot", "loading", "inline", "inlineShort", "clicking", "tab", "field", "pageRead",
  "noWait", "noPickWait", "decorated", "browserGuarded", "approval", "forwarded", "remote"]);

test("every entry is well formed: a known server, origin and rules, and a definition under its own name", () => {
  for (const [name, t] of Object.entries(CATALOG)) {
    assert.ok(["browser", "runs"].includes(t.server), name);
    assert.ok(["playwright", "helper", "launch", "runs"].includes(t.from), name);
    for (const r of t.rules) assert.ok(RULES.has(r), `${name}: unknown rule ${r}`);
    assert.equal(new Set(t.rules).size, t.rules.length, `${name}: a rule twice`);
    if (t.from === "playwright") { assert.equal(t.def, undefined, name); assert.match(name, /^browser_/); continue; }
    assert.equal(t.def.name, name);
    assert.equal(typeof t.def.description, "string");
    assert.equal(t.def.inputSchema.type, "object", name);
  }
});

test("rules that go together do", () => {
  for (const name of toolsWith("noWait")) assert.ok(toolsWith("noPickWait").has(name), `${name} answers before the browser, so before the picker too`);
  for (const name of toolsWith("inlineShort")) assert.ok(toolsWith("inline").has(name), name);
  for (const name of toolsWith("mentionOnly")) assert.ok(toolsWith("hidden").has(name), name);
  for (const name of [...toolsWith("blocked"), ...toolsWith("hidden")]) assert.deepEqual(CATALOG[name].rules.filter((r) => r !== "blocked" && r !== "hidden" && r !== "mentionOnly"), [], `${name} is never called, so has no call rules`);
  for (const name of toolsWith("field")) assert.ok(toolsWith("tab").has(name), name);
  for (const name of toolsWith("approval")) assert.ok(toolsWith("tab").has(name), name);
  for (const name of toolsWith("forwarded")) assert.ok(toolsWith("remote").has(name), `${name} goes to the host, which takes it`);
});

test("policy, guard and validate-skills read their lists from the catalog", async () => {
  const policy = await import("../scripts/rules/policy.mjs");
  const guard = await import("../scripts/guard.mjs");
  assert.deepEqual([...policy.BLOCKED_TOOLS], ["browser_run_code_unsafe", "browser_webmcp_list", "browser_webmcp_call"]);
  assert.ok(policy.HIDDEN_TOOLS.has("browser_take_screenshot") && policy.HIDDEN_TOOLS.has("browser_evaluate"));
  assert.deepEqual([...guard.APPROVAL_TOOLS].sort(), ["browser_click", "browser_drag", "browser_drop", "browser_handle_dialog", "pairbrowse_click_at"]);
  for (const name of ["STATUS_TOOL", "LIVEVIEW_TOOL", "RECORD_TOOL", "INVITE_TOOL", "JOIN_TOOL"]) assert.equal(policy[name], CATALOG[policy[name].name].def, name);
  for (const [file, name] of [["runner.mjs", "RUN_TOOL"], ["runner.mjs", "SCROLL_TOOL"], ["upload.mjs", "UPLOAD_TOOL"], ["facts.mjs", "FACTS_TOOL"], ["sessions.mjs", "SESSION_TOOL"],
    ["collaboration.mjs", "COLLABORATION_TOOL"], ["dock.mjs", "DOCK_TOOL"], ["daemon/screenshot.mjs", "CLICK_AT_TOOL"]]) {
    const mod = await import(`../scripts/${file}`);
    assert.equal(mod[name], CATALOG[mod[name].name].def, `${file} ${name}`);
  }
  // No tool list is read out of source text any more.
  for (const f of ["scripts/validate-skills.mjs", "test/core.test.mjs"]) assert.doesNotMatch(readFileSync(join(root, f), "utf8"), /policy\.mjs|name: "\$\{/, f);
  const r = spawnSync(process.execPath, [join(root, "scripts", "validate-skills.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("the helper lists its own tools in the catalog's order, after the browser's offered ones", () => {
  assert.deepEqual(HELPER_TOOLS.map((t) => t.name), [...toolsFrom("helper")]);
  assert.deepEqual([...toolsFrom("launch")].sort(), ["pairbrowse_dock", "pairbrowse_join"]);
  assert.deepEqual([...toolsFrom("runs")], RUNS_TOOLS.map((t) => t.name));
  assert.ok(!OFFERED_PLAYWRIGHT.has("browser_evaluate") && OFFERED_PLAYWRIGHT.has("browser_click"));
  for (const f of ["serve.mjs", ...readdirSync(join(root, "scripts", "daemon", "serve"), { recursive: true }).filter((n) => n.endsWith(".mjs")).map((n) => join("serve", n))]) {
    const serve = readFileSync(join(root, "scripts", "daemon", f), "utf8");
    assert.doesNotMatch(serve, /^(export )?const [A-Z_]+ = new Set\(\["(browser|pairbrowse)_/m, `${f} keeps no tool list of its own`);
  }
});

// The pinned @playwright/mcp still has each tool the catalog names (PAIRBROWSE_TEST_RUNTIME).
const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
test("the pinned Playwright server defines every tool the catalog passes through or hides", { skip: !runtime }, () => {
  const names = new Set();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js")) for (const m of readFileSync(p, "utf8").matchAll(/name: ["'](browser_[a-z_]+)["']/g)) names.add(m[1]);
    }
  };
  walk(join(runtime, "node_modules"));
  for (const name of toolsFrom("playwright")) if (!toolsWith("blocked").has(name)) assert.ok(names.has(name), `${name} is not in the pinned Playwright server`);
});
