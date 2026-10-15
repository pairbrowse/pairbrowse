// Every row of the Security table in docs/security.md names the tests that keep it true (a
// trailing "Tests: `test/...`." in its second cell), and every test it names exists: removing or
// renaming one of them fails here until the row is updated.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname;

// The table's rows: from the "| Risk | What PairBrowse does |" header to the first line that isn't one.
function rows() {
  const lines = readFileSync(join(root, "docs/security.md"), "utf8").split("\n");
  const start = lines.findIndex((l) => /^\| Risk \| What PairBrowse does \|$/.test(l));
  assert.ok(start >= 0, "docs/security.md has its Security table");
  const out = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    out.push(line);
  }
  return out;
}

test("every row of the Security table names tests, and each named test exists", () => {
  const table = rows();
  assert.ok(table.length >= 40, `the table parses (${table.length} rows)`);
  for (const row of table) {
    const risk = row.split("|")[1].trim();
    const m = /Tests: ((?:`[^`]+`(?:, )?)+)\. \|$/.exec(row);
    assert.ok(m, `"${risk}" names no tests (end its cell with: Tests: \`test/<file>\`.)`);
    const files = [...m[1].matchAll(/`([^`]+)`/g)].map((f) => f[1]);
    for (const f of files) {
      assert.match(f, /^test\/(?:[\w-]+\/)*[\w-]+\.test\.m?js$/, `"${risk}": ${f} isn't a test file path`);
      let file = false;
      try { file = statSync(join(root, f)).isFile(); } catch { /* missing */ }
      assert.ok(file, `"${risk}" names ${f}, which doesn't exist`);
      assert.match(readFileSync(join(root, f), "utf8"), /\b(?:test|it|describe)\(/, `"${risk}": ${f} has no test in it`);
    }
  }
});
