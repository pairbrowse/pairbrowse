import "./helpers/home.mjs";
// No test uses the person's own ~/.pairbrowse: every test file loads helpers/home.mjs before
// anything else (a home under the temp folder), and paths.mjs refuses the real one under the runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { isRealHome } from "./helpers/home.mjs";

const here = new URL(".", import.meta.url).pathname;
const files = [
  ...readdirSync(here).filter((f) => f.endsWith(".test.mjs")).map((f) => join(here, f)),
  ...readdirSync(join(here, "fuzz")).filter((f) => f.endsWith(".test.js")).map((f) => join(here, "fuzz", f)),
];

test("every test file sets its own home before its first import", () => {
  for (const f of files) {
    const first = readFileSync(f, "utf8").split("\n").find((l) => /^import[\s{"]/.test(l));
    assert.match(first ?? "", /^import "\.{1,2}\/helpers\/home\.mjs";$/, f);
  }
});

test("the home is under the temp folder, never ~/.pairbrowse", () => {
  assert.equal(isRealHome(process.env.PAIRBROWSE_HOME), false);
  assert.equal(isRealHome(join(userInfo().homedir, ".pairbrowse")), true);
  assert.ok(process.env.PAIRBROWSE_HOME.startsWith(tmpdir()) || process.env.PAIRBROWSE_HOME.startsWith("/tmp") || process.env.PAIRBROWSE_HOME.startsWith("/private"));
});

test("paths.mjs refuses the real home under the test runner", () => {
  const env = { ...process.env, NODE_TEST_CONTEXT: "child-v8" };
  delete env.PAIRBROWSE_HOME;
  const url = new URL("../scripts/paths.mjs", import.meta.url).href;
  assert.throws(() => execFileSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(url)})`], { env, stdio: "pipe" }), /real ~\/\.pairbrowse/);
});
