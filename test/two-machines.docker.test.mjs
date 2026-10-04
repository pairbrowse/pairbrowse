// Shared browser mode between two machines: this computer as the host (the PairBrowse browser)
// and a Linux container as the joiner (behind its own NAT), joined through a real Cloudflare
// Quick Tunnel. The joiner gets a direct connection, types into the host's Google box through
// the picture, and its agent reads the host's page. Needs Docker, the network,
// PAIRBROWSE_TEST_RUNTIME and PAIRBROWSE_TEST_DOCKER=1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const sh = (cmd, args, ms = 900_000) => execFileSync(cmd, args, { encoding: "utf8", timeout: ms, stdio: ["ignore", "pipe", "pipe"] });

test("shared browser between two machines, through a real tunnel", { skip: !runtime || process.env.PAIRBROWSE_TEST_DOCKER !== "1", timeout: 1_200_000 }, () => {
  try { sh("docker", ["rm", "-f", "pb-joiner"]); } catch {}
  sh("docker", ["run", "-d", "--name", "pb-joiner", "-v", `${runtime}:/runtime:ro`, "-v", `${repo}:/repo:ro`, "-e", "PLAYWRIGHT_BROWSERS_PATH=/ms-playwright", "node:22-bookworm", "sleep", "infinity"]);
  try {
    sh("docker", ["exec", "pb-joiner", "node", "/runtime/node_modules/playwright-core/cli.js", "install", "--with-deps", "chromium"]);
    const out = sh(process.execPath, [join(repo, "test", "two-machines", "host.mjs")], 600_000);
    assert.match(out, /"conn":"connected"[^\n]*"direct":true/, out);
    assert.match(out, /host's Google box: "[^"]*hello from sven/, out);
    assert.match(out, /"agentSnapshotSeesGoogle":true/, out);
    assert.match(out, /"muted":false/, out);
  } finally {
    try { sh("docker", ["rm", "-f", "pb-joiner"]); } catch {}
  }
});
