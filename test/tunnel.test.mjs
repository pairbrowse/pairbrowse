import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pb-tunnel-"));
process.env.PAIRBROWSE_HOME = home;
const { tunnelUrl, CLOUDFLARED, ensureCloudflared, startQuickTunnel } = await import("../scripts/tunnel.mjs");

test("the Quick Tunnel address is read from cloudflared's output, nothing else", () => {
  const out = "2026-10-03T00:00:00Z INF |  https://balanced-river-tested-jump.trycloudflare.com  |\n";
  assert.equal(tunnelUrl(out), "https://balanced-river-tested-jump.trycloudflare.com");
  assert.equal(tunnelUrl("https://evil.example.com/x.trycloudflare.com"), null);
  assert.equal(tunnelUrl("no address yet"), null);
});

test("every pinned cloudflared build has a SHA-256", () => {
  for (const [k, a] of Object.entries(CLOUDFLARED.assets)) assert.match(a.sha256, /^[0-9a-f]{64}$/, k);
});

test("platforms without a cloudflared build say so", async () => {
  await assert.rejects(ensureCloudflared(() => {}, "aix", "ppc64"), /no build for aix-ppc64/);
});

test("bad ports are refused before anything starts", async () => {
  await assert.rejects(startQuickTunnel(0, { exe: "/nonexistent" }), /bad live view port/);
});

test.after(() => rmSync(home, { recursive: true, force: true }));
