// The docs name what the code reads, both ways: every config.json key in docs/configuration.md is
// one the helper knows (DEFAULT_CONFIG in scripts/paths.mjs, or an older name still read) and every
// key it knows is documented there; every PAIRBROWSE_* variable the scripts read is in
// docs/development.md (the test switches table or "Every other variable") and every one listed
// there is still read.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../scripts/paths.mjs";
import { SWITCHES } from "../scripts/testenv.mjs";

const root = new URL("../", import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), "utf8");
const sources = (dir, re) => readdirSync(join(root, dir), { recursive: true }).filter((f) => re.test(f)).map((f) => read(join(dir, f)));
const scripts = sources("scripts", /\.(mjs|js)$/).join("\n");

// Older names, read while "browser" is unset and never written (docs/configuration.md says so).
const OLDER_KEYS = ["browserEngine", "executablePath"];

// The keys a bullet of docs/configuration.md documents: the backticked names before its first colon.
function documentedKeys() {
  const keys = new Set();
  for (const line of read("docs/configuration.md").split("\n")) {
    const m = /^- (`[^:]*`):/.exec(line);
    if (m) for (const k of m[1].matchAll(/`([A-Za-z.]+)`/g)) keys.add(k[1]);
  }
  return keys;
}

test("every config key in docs/configuration.md is one the helper knows, and the other way round", () => {
  const doc = documentedKeys();
  const top = new Set([...doc].map((k) => k.split(".")[0]));
  for (const k of top) assert.ok(Object.hasOwn(DEFAULT_CONFIG, k) || OLDER_KEYS.includes(k), `configuration.md documents "${k}", which DEFAULT_CONFIG doesn't have`);
  for (const k of Object.keys(DEFAULT_CONFIG)) assert.ok(top.has(k), `DEFAULT_CONFIG.${k} isn't documented in configuration.md`);
  for (const k of OLDER_KEYS) assert.match(scripts, new RegExp(`config\\??\\.${k}\\b`), `${k} is documented as still read, but no script reads it`);
  // Nested keys named anywhere in the page (sharing.tunnel, sharing.guestPort) exist, and each of
  // sharing's is named.
  const page = read("docs/configuration.md");
  const nested = new Set([...page.matchAll(/`sharing\.([A-Za-z]+)`/g)].map((m) => m[1]));
  for (const k of nested) assert.ok(Object.hasOwn(DEFAULT_CONFIG.sharing, k), `configuration.md names sharing.${k}, which DEFAULT_CONFIG.sharing doesn't have`);
  for (const k of Object.keys(DEFAULT_CONFIG.sharing)) assert.ok(nested.has(k), `sharing.${k} isn't documented in configuration.md`);
});

// A table's first-column names under a heading of docs/development.md, with the second column.
function tableRows(heading) {
  const lines = read("docs/development.md").split("\n");
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `development.md has no "${heading}"`);
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    const m = /^\| `([A-Z0-9_*]+)` \| ([^|]+?) \|/.exec(line);
    if (m) rows.push({ name: m[1], second: m[2] });
  }
  return rows;
}

// Names written PAIRBROWSE_X in a source that aren't a JavaScript binding of that name.
function envNames(src) {
  const names = new Set(src.match(/\bPAIRBROWSE_[A-Z0-9_]+/g) || []);
  for (const n of names) if (new RegExp(`\\b(?:const|let|var)\\s+${n}\\b`).test(src)) names.delete(n);
  return names;
}

test("every PAIRBROWSE_* variable the scripts read is in development.md, and every one there is read", () => {
  const switchRows = tableRows("### The test switches");
  const knobs = switchRows.filter((r) => r.second.trim() === "knob").map((r) => r.name);
  const gates = switchRows.filter((r) => r.second.trim() === "gate").map((r) => r.name);
  const other = tableRows("### Every other variable").map((r) => r.name);
  assert.ok(knobs.length && gates.length && other.length, "development.md's variable tables parse");

  // The helper's knobs are SWITCHES, exactly.
  assert.deepEqual([...knobs].sort(), Object.keys(SWITCHES).sort(), "the knob rows of development.md are SWITCHES in scripts/testenv.mjs");

  // Every variable named in scripts/ is listed.
  const inScripts = envNames(scripts);
  for (const n of inScripts) {
    if (n === "PAIRBROWSE_TEST_") continue; // the prefix itself (testenv.mjs)
    if (n.startsWith("PAIRBROWSE_TEST_")) {
      const s = n.slice("PAIRBROWSE_TEST_".length);
      assert.ok(knobs.includes(s) || gates.includes(s), `${n} (scripts/) isn't in development.md's test switches`);
    } else assert.ok(other.includes(n) || (n.endsWith("_") && other.includes(`${n}*`)), `${n} (scripts/) isn't in development.md's "Every other variable"`);
  }
  for (const n of other) {
    if (n === "PAIRBROWSE_TEST_*") continue;
    // A prefix row (PAIRBROWSE_ENGINE_*): a script names the prefix itself.
    if (n.endsWith("_*")) { assert.ok(inScripts.has(n.slice(0, -1)), `development.md lists ${n}, a prefix no script names`); continue; }
    assert.ok(inScripts.has(n), `development.md lists ${n}, which no script reads`);
  }

  // Every gate is read by a test (or a script), and every PAIRBROWSE_TEST_* a test names is listed.
  const tests = ["test", "test/integration", "test/optin", "test/helpers", "test/fuzz"]
    .flatMap((d) => sources(d, /^[^/]+\.(mjs|js)$/)).join("\n");
  const inTests = envNames(tests);
  for (const g of gates) assert.ok(inTests.has(`PAIRBROWSE_TEST_${g}`) || inScripts.has(`PAIRBROWSE_TEST_${g}`), `the gate ${g} in development.md is read by no test`);
  // SHOULD_NOT_CROSS: a stand-in daemon-connect.test.mjs sets to see the bridge drop an unknown switch.
  for (const n of inTests) {
    if (!n.startsWith("PAIRBROWSE_TEST_") || n === "PAIRBROWSE_TEST_" || n === "PAIRBROWSE_TEST_SHOULD_NOT_CROSS") continue;
    const s = n.slice("PAIRBROWSE_TEST_".length);
    assert.ok(knobs.includes(s) || gates.includes(s), `${n} (test/) isn't in development.md's test switches`);
  }
});
