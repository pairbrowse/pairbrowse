import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "pb-tunnel-"));
process.env.PAIRBROWSE_HOME = home;
process.env.PAIRBROWSE_TEST_KEEP_GRACE_MS = "1500";
const { tunnelExitReason, tunnelUrl, CLOUDFLARED, ensureCloudflared, startQuickTunnel, adoptTunnel, heartbeatFile, helperAlive, watchTunnel, tunnelEnded } = await import("../scripts/tunnel.mjs");
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
  let here = 0;
  const t = await startQuickTunnel(4321, { exe, resolves: async (host) => { assert.equal(host, "quiet-river-test.trycloudflare.com"); return ++asked >= 3; }, resolvesLocally: async () => ++here >= 2 });
  try {
    assert.equal(t.url, "https://quiet-river-test.trycloudflare.com");
    assert.equal(asked, 3, "waited until the name resolved");
    assert.equal(here, 2, "and until this computer's own resolver saw it");
    assert.ok(Date.now() - t0 >= 1200, "and for the connection");
  } finally { t.stop(); }
});

test("why cloudflared stopped, in plain words: rate-limited, or its last error line", async () => {
  const log = "2026-10-09T13:30:00Z INF Requesting new quick Tunnel on trycloudflare.com...\n2026-10-09T13:30:01Z ERR Couldn't start tunnel error=\"Unauthorized: 429 Too Many Requests, error code: 1015\"\n";
  assert.match(tunnelExitReason(1, log), /too many fresh sharing connections were opened from this computer in a short time; sharing works again in a few minutes/);
  assert.doesNotMatch(tunnelExitReason(1, log), /Cloudflare|tunnel/i, "the agent reads this: no tunnel talk");
  assert.equal(tunnelExitReason(1, "INF something\nERR failed to dial edge: no route to host\n"), "the sharing connection ended (exit 1): failed to dial edge: no route to host");
  assert.equal(tunnelExitReason(2, ""), "the sharing connection ended (exit 2)");
  // A cloudflared that dies with that error: the host's agent gets the reason, not an exit code.
  const exe = join(home, "fake-cloudflared-429");
  writeFileSync(exe, `#!${process.execPath}\nconsole.error("ERR Couldn't start tunnel error=\\"429 Too Many Requests, error code: 1015\\"");\nsetTimeout(() => process.exit(1), 100);\n`);
  chmodSync(exe, 0o755);
  await assert.rejects(startQuickTunnel(4323, { exe, resolves: async () => true, resolvesLocally: async () => true }), /too many fresh sharing connections/);
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
    assert.equal(tunnelEnded(t), false, "live while it runs");
    for (let i = 0; i < 40 && alive(t.pid); i++) await sleep(250);
    assert.ok(!alive(t.pid), "stopped once nobody beat for the grace period");
    await sleep(50);
    assert.equal(tunnelEnded(t), true, "over once its keeper ended, however it ended");
  } finally { clearInterval(beat); t.stop(); rmSync(heartbeatFile(), { force: true }); }
});

test("the watcher leaves a tunnel alone once it's over: stopped, its keeper killed, or taken out of use", async () => {
  const logs = [];
  const probes = { a: 0, b: 0, c: 0, d: 0 };
  // Already over (its keeper ended by a signal: exitCode stays null): never probed, never "replaced".
  const a = { url: "http://a", host: "a", child: { exitCode: null, signalCode: "SIGTERM" }, gone: false, stop: () => { throw new Error("stopped twice"); } };
  assert.equal(tunnelEnded(a), true);
  watchTunnel(a, { everyMs: 10, misses: 2, log: (l) => logs.push(l), probe: async () => { probes.a++; return false; } });
  // Stopped by the pool while it's down: the stop marks it gone, and the watcher says nothing.
  const b = { url: "http://b", host: "b", child: { exitCode: null, signalCode: null }, gone: false, stop() { b.gone = true; } };
  watchTunnel(b, { everyMs: 10, misses: 3, log: (l) => logs.push(l), probe: async () => { probes.b++; return false; } });
  await sleep(15);
  b.stop();
  // Taken out of use (the pool's replacement): its watcher's stop() ends the probing.
  const c = { url: "http://c", host: "c", child: { exitCode: null, signalCode: null }, gone: false, stop() {} };
  const unwatch = watchTunnel(c, { everyMs: 10, misses: 3, log: (l) => logs.push(l), probe: async () => { probes.c++; return false; } });
  await sleep(15);
  unwatch();
  // A live tunnel that stops answering is stopped and said so, once.
  const d = { url: "http://d", host: "d", child: { exitCode: null, signalCode: null }, gone: false, stops: 0, stop() { d.stops++; d.gone = true; } };
  watchTunnel(d, { everyMs: 10, misses: 2, log: (l) => logs.push(l), probe: async () => { probes.d++; return false; } });
  await sleep(120);
  assert.equal(probes.a, 0, "a tunnel over before the first look isn't probed");
  assert.ok(probes.b <= 2 && probes.c <= 2, `probing ended with the tunnel: ${probes.b}, ${probes.c}`);
  assert.deepEqual(logs, ["tunnel d isn't answering; replacing it"]);
  assert.equal(d.stops, 1);
  assert.equal(probes.d, 2);
});

test.after(() => rmSync(home, { recursive: true, force: true }));
