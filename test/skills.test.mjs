import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("every skill shipped with the plugin is well-formed and names only real PairBrowse tools", () => {
  const r = spawnSync(process.execPath, [new URL("../scripts/validate-skills.mjs", import.meta.url).pathname], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /All 5 skills valid/);
});
