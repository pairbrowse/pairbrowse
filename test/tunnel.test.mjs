import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pb-tunnel-"));
process.env.PAIRBROWSE_HOME = home;
process.env.PAIRBROWSE_TEST_KEEP_GRACE_MS = "1500";
const { tunnelUrl, CLOUDFLARED, ensureCloudflared, startQuickTunnel, adoptTunnel, heartbeatFile, helperAlive } = await import("../scripts/tunnel.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

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

test("the address is handed out only once cloudflared has a connection and the name resolves", async () => {
  // A stand-in for cloudflared: the address first, the connection a moment later.
  const exe = join(home, "fake-cloudflared");
  writeFileSync(exe, `#!${process.execPath}\nconsole.error("INF |  https://quiet-river-test.trycloudflare.com  |");\nsetTimeout(() => console.error("INF Registered tunnel connection connIndex=0"), 300);\nsetInterval(() => {}, 1000);\n`);
  chmodSync(exe, 0o755);
  const t0 = Date.now();
  let asked = 0;
  const t = await startQuickTunnel(4321, { exe, resolves: async (host) => { assert.equal(host, "quiet-river-test.trycloudflare.com"); return ++asked >= 3; } });
  try {
    assert.equal(t.url, "https://quiet-river-test.trycloudflare.com");
    assert.equal(asked, 3, "waited until the name resolved");
    assert.ok(Date.now() - t0 >= 1200, "and for the connection");
  } finally { t.stop(); }
});

test("a tunnel stops by itself once no helper is around, and only our own keeper is ever taken over or stopped", async () => {
  const exe = join(home, "fake-cloudflared");
  writeFileSync(exe, `#!${process.execPath}\nconsole.error("INF |  https://still-lake-test.trycloudflare.com  |");\nconsole.error("INF Registered tunnel connection connIndex=0");\nsetInterval(() => {}, 1000);\n`);
  chmodSync(exe, 0o755);
  const beat = setInterval(helperAlive, 300);
  const t = await startQuickTunnel(4322, { exe, resolves: async () => true });
  try {
    await sleep(6500);
    assert.ok(alive(t.pid), "kept while the helper beats");
    // Taken over by a next run: only while it is our keeper for that port.
    const real = await adoptTunnel({ url: t.url, pid: t.pid, port: 4322, log: t.log });
    assert.ok(real, "our own keeper is taken over");
    assert.equal(await adoptTunnel({ url: t.url, pid: t.pid, port: 4323 }), null, "not for another port");
    assert.equal(await adoptTunnel({ url: t.url, pid: process.pid, port: 4322 }), null, "not some other process");
    assert.equal(await adoptTunnel({ url: "https://evil.example.com", pid: t.pid, port: 4322 }), null);
    // A pid reused by something else by the time it's stopped: no signal reaches it.
    const reused = await adoptTunnel({ url: t.url, pid: process.pid, port: 1 }, { psCommand: async () => `node tunnel-keeper.mjs /x/cloudflared 1 /hb 9 ` });
    let signalled = false;
    const kill = process.kill;
    process.kill = (pid, sig) => { if (pid === process.pid && sig === "SIGTERM") signalled = true; return kill.call(process, pid, sig === "SIGTERM" ? 0 : sig); };
    try {
      reused.check = async () => false; // by now the pid is something else
      reused.stop();
      await sleep(100);
    } finally { process.kill = kill; }
    assert.equal(signalled, false, "a reused pid is never signalled");
    // The helper goes away: the keeper stops cloudflared within the grace and a check.
    clearInterval(beat);
    for (let i = 0; i < 40 && alive(t.pid); i++) await sleep(250);
    assert.ok(!alive(t.pid), "stopped once nobody beat for the grace period");
  } finally { clearInterval(beat); t.stop(); rmSync(heartbeatFile(), { force: true }); }
});

test.after(() => rmSync(home, { recursive: true, force: true }));
