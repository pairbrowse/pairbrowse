// The sharing tunnels: Quick Tunnels (a pool of two) or the user's own tunnel to the live view's
// guest port while join codes are out, replaced when one ends, kept idle a while after the last
// code ends. save(): the sharing state is written again (daemon/sharing.mjs, its codes and tunnels).
import { startQuickTunnel, watchTunnel, onTunnelExit, tunnelEnded } from "../tunnels/quick.mjs";
import { tunnelConfig } from "../tunnels/config.mjs";
import { startOwnTunnel } from "../tunnels/start.mjs";

export function createTunnelPool({ config, log, hostNote, save }) {
  // Quick Tunnels to the live view's guest port (which takes join code keys and nothing else),
  // while join codes are out: two at once. Codes carry the first's address; approved joiners learn
  // every address (sharing/join-client.mjs), so when one tunnel goes down their PairBrowse moves to the other
  // and nothing drops, and a replacement starts here. Stopped when the last code ends
  // (revoked, expired, revoke_all) or the helper shuts down.
  const direct = process.env.PAIRBROWSE_TEST_TUNNEL === "direct"; // tests: the guest port stands in
  // The user's own tunnel instead (config sharing.tunnel: tunnels/config.mjs): one connection on
  // an address of theirs, started again on that same address when it ends, so join codes keep
  // working; the pool of two and joiners' address rotation are for Quick Tunnels, whose address
  // is new each time. A bad setting is kept as a plain message: create says it, nothing starts.
  let tunnelSpec = null, tunnelProblem = "";
  try { tunnelSpec = tunnelConfig(config); } catch (e) { tunnelProblem = e.message; log(`sharing: ${tunnelProblem}`); }
  const own = !!tunnelSpec && tunnelSpec.kind !== "quick";
  const POOL = direct || own ? 1 : 2;
  let tunnelStarting = null;
  let filling = null;
  // sharing.guestPort pins the guest port (a named Cloudflare tunnel's ingress points at it).
  const pinnedPort = tunnelSpec?.guestPort || 0;
  // pool: [{ url, host, port, stop, child }], the first is the one new codes carry.
  // wanted: join codes are out. guestPortWanted: the guest port the tunnels point at.
  const tun = { pool: [], wanted: false, guestPortWanted: pinnedPort };
  // Which way sharing goes, for the user and the agent ("your own ngrok address share.example.com").
  const via = () => (tunnelSpec && own ? tunnelSpec.describe(tun.pool[0]?.host || "") : "a free relay");
  let generation = 0; // bumped by stopTunnel
  const alive = (t, port) => t.port === port && !tunnelEnded(t);

  // Cloudflare lets a computer open only so many Quick Tunnels in a while: when the last code
  // ends, the tunnel stays up for TUNNEL_IDLE_MS (no code works on it meanwhile, so nothing
  // reaches anything) and the next invite reuses it. The browser closing or the helper stopping
  // still stops it at once.
  const TUNNEL_IDLE_MS = 15 * 60_000;
  let idleTimer = null;
  function releaseTunnel() {
    tun.wanted = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimer = null; if (!tun.wanted) stopTunnel(); }, TUNNEL_IDLE_MS);
    idleTimer.unref?.();
    if (tun.pool.length) log(`sharing tunnel kept for ${TUNNEL_IDLE_MS / 60_000} min in case of a new code`);
  }
  function stopTunnel() {
    tun.wanted = false;
    clearTimeout(idleTimer); idleTimer = null;
    clearTimeout(refillTimer); refillTimer = null; emptySince = 0;
    generation++; // a tunnel still starting when this runs is stopped as soon as it's up
    const was = tun.pool;
    tun.pool = [];
    for (const t of was) { t.unwatch?.(); try { t.stop(); } catch {} }
    if (was.length) log("sharing tunnels stopped");
  }

  async function startOne(port) {
    const started = generation;
    const t = direct ? { url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, stop() {} } : own ? await startOwnTunnel(tunnelSpec, port, { log }) : await startQuickTunnel(port, { log });
    if (started !== generation) {
      try { t.stop(); } catch {}
      throw new Error("sharing stopped while its connection was starting");
    }
    t.port = port;
    return wire(t, port);
  }
  // A tunnel in the pool: watched from outside, and replaced when it ends. Joiners already in
  // move to the standby by themselves (sharing/join-client.mjs); a code not yet used carries the first live
  // address at the time it's read (list), so its string may change: fine, nobody has it yet.
  function wire(t, port) {
    // Not answering: stopped, and replaced below. The watcher ends with the tunnel's time in the
    // pool: one replaced already is never probed on and "replaced" a second time.
    t.unwatch = direct ? () => {} : watchTunnel(t, { log });
    const ended = () => {
      t.unwatch();
      if (!tun.pool.includes(t)) return;
      tun.pool = tun.pool.filter((x) => x !== t);
      save();
      // One tunnel of the user's own: started again on its address, after a breath (a program
      // that ends at once each time isn't restarted in a tight loop).
      if (own) { log("the sharing connection stopped; starting it again"); if (tun.wanted) refillSoon(port, RESTART_MS); return; }
      log(`a sharing tunnel stopped; ${tun.pool.length} left`);
      if (tun.wanted) refill(port);
    };
    if (t.child || t.adopted) onTunnelExit(t, ended);
    return t;
  }
  // Every tunnel gone and none coming back: tried again for EMPTY_NOTE_MS, then the host hears
  // it once, in plain words (nothing while at least one tunnel lives: codes keep working).
  const EMPTY_NOTE_MS = 60_000, REFILL_MS = 15_000, RESTART_MS = Number(process.env.PAIRBROWSE_TEST_RESTART_MS) || 2000;
  let emptySince = 0, refillTimer = null;
  function refillSoon(port, ms) {
    clearTimeout(refillTimer);
    refillTimer = setTimeout(() => refill(port), ms);
    refillTimer.unref?.();
  }
  function refill(port) {
    clearTimeout(refillTimer); refillTimer = null;
    fill(port).then(() => {
      if (!tun.wanted || tun.pool.length) { emptySince = 0; return; }
      emptySince ||= Date.now();
      if (Date.now() - emptySince < EMPTY_NOTE_MS) { refillTimer = setTimeout(() => refill(port), REFILL_MS); refillTimer.unref?.(); return; }
      emptySince = 0;
      log("sharing: no tunnel for a minute; the host is told");
      hostNote("Sharing lost its connection and couldn't get it back; the people in your session dropped out. Share again when you're ready.");
    });
  }
  // Up to POOL live tunnels, in the background (a failed start is retried with the next change).
  function fill(port) {
    filling ??= (async () => {
      tun.pool = tun.pool.filter((t) => alive(t, port));
      while (tun.wanted && tun.pool.length < POOL) {
        try { tun.pool.push(await startOne(port)); save(); } catch (e) { log(`sharing tunnel didn't start: ${e?.message || e}`); break; }
      }
    })().finally(() => { filling = null; });
    return filling;
  }

  // The tunnel new codes carry: the first live one (started now if there's none).
  async function ensureTunnel(live) {
    tun.wanted = true;
    clearTimeout(idleTimer); idleTimer = null;
    tun.pool = tun.pool.filter((t) => alive(t, live.guestPort));
    if (!tun.pool.length) {
      tunnelStarting ??= startOne(live.guestPort).then((t) => { tun.pool.unshift(t); save(); return t; }).finally(() => { tunnelStarting = null; });
      await tunnelStarting;
    }
    fill(live.guestPort).catch(() => {}); // the standby, in the background
    return tun.pool[0];
  }

  // Read by sharing.mjs: the setting (tunnelSpec, own, pinnedPort, tunnelProblem: a bad one, said
  // by create), the pool's size, and its parts.
  return Object.assign(tun, { tunnelSpec, own, pinnedPort, tunnelProblem, POOL, via, alive, wire, fill, ensureTunnel, releaseTunnel, stopTunnel });
}
