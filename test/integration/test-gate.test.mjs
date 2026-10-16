// A helper the test harness didn't start (its home outside the temp folder, as an installed one's)
// drops PAIRBROWSE_TEST_* from its environment: PAIRBROWSE_TEST_APPROVAL=1 handed down by a
// project's settings never adds the tool that answers approval cards as a person.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { session } from "../helpers/live.mjs";
import { sleep } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function toolsOf(home) {
  symlinkSync(runtime, join(home, "runtime"), "dir");
  const { createRequire } = await import("node:module");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(home, "config.json"), JSON.stringify({ executablePath, browserArgs: ["--headless=new"], display: "none", screenshots: false }));
  const daemon = spawnDaemon(home, { env: { PAIRBROWSE_TEST_APPROVAL: "1" } });
  const socketPath = join(home, "run", "browser.sock");
  try {
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    const a = await session(socketPath, "g");
    const r = await a.tool("pairbrowse_test_approval", { pending: true });
    const list = (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";
    a.sock.destroy();
    return list;
  } finally {
    await stopDaemon(daemon);
  }
}

test("PAIRBROWSE_TEST_APPROVAL in a helper the harness didn't start adds no test tool", { skip: !runtime, timeout: 120_000 }, async () => {
  // Outside the temp folder, short enough for a socket path: inside this checkout.
  const base = join(root, ".gate");
  mkdirSync(base, { recursive: true });
  const outside = mkdtempSync(join(base, "o-"));
  const { tmpdir } = await import("node:os");
  const inside = mkdtempSync(join(tmpdir(), "pb-gate-"));
  try {
    const plain = await toolsOf(outside);
    assert.doesNotMatch(plain, /^\[/, `no test tool: ${plain}`);
    const harness = await toolsOf(inside);
    assert.match(harness, /^\[/, `the harness's own helper still has it: ${harness}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(inside, { recursive: true, force: true });
  }
});
