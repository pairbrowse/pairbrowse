// The sharing tunnels: Quick Tunnels (a pool of two) or the user's own tunnel to the live view's
// guest port while join codes are out, replaced when one ends, kept idle a while after the last
// code ends. save(): the sharing state is written again (daemon/sharing.mjs, its codes and tunnels).
import { startQuickTunnel, watchTunnel, onTunnelExit, tunnelEnded } from "../tunnels/quick.mjs";
import { tunnelConfig } from "../tunnels/config.mjs";
import { startOwnTunnel } from "../tunnels/start.mjs";
import { testMs, testTunnel } from "../testenv.mjs";

// startHandoff(port): starts the public tunnel (hand-offs and watch links; tests pass a stand-in; by
// default as the pool's: Quick Tunnel, the user's own, or the guest port itself under the test
// switch). onPublicLost(): that tunnel ended by itself (not stopped here).
export function createTunnelPool({ config, log, hostNote, save, startHandoff = null, onPublicLost = () => {} }) {
  // Quick Tunnels to the live view's guest port (which takes join code keys and nothing else),
  // while join codes are out: two at once. Codes carry the first's address; approved joiners learn
  // every address (sharing/join-client.mjs), so when one tunnel goes down their PairBrowse moves to the other
  // and nothing drops, and a replacement starts here. Stopped when the last code ends
  // (revoked, expired, revoke_all) or the helper shuts down.
  const direct = ["direct", "private"].includes(testTunnel()); // tests: the guest port stands in (never a real tunnel without REAL_TUNNEL)
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
  // The hand-off's own tunnel (ensureHandoff, below) and the one its links are on now (it or a
  // shared pool tunnel).
  let handoff = null, handoffStarting = null, handoffGen = 0, handoffUsing = null;
  const alive = (t, port) => t.port === port && !tunnelEnded(t);

  // Cloudflare lets a computer open only so many Quick Tunnels in a while: when the last code
  // ends, the tunnel stays up for TUNNEL_IDLE_MS (no code works on it meanwhile, so nothing
  // reaches anything) and the next invite reuses it. The browser closing or the helper stopping
  // still stops it at once.
  const TUNNEL_IDLE_MS = 15 * 60_000;
  let idleTimer = null;
  function releaseTunnel() {
    tun.wanted = false;
    clearTimeout(idleTimer); idleTimer = null;
    if (!tun.pool.length && !tunnelStarting) return; // nothing up to keep (revoke_all closed it)
    idleTimer = setTimeout(() => { idleTimer = null; if (!tun.wanted) stopTunnel(); }, TUNNEL_IDLE_MS);
    idleTimer.unref?.();
    if (tun.pool.length) log(`sharing tunnel kept for ${TUNNEL_IDLE_MS / 60_000} min in case of a new code`);
  }
  // A pool tunnel an open hand-off's link is on (the user's own tunnel, shared: ensureHandoff) leaves
  // the pool instead of stopping, and is the hand-off's own from then on: it stops with the last
  // hand-off (stopHandoff), never with the idle keep or the last code while a hand-off is open.
  function stopTunnel() {
    tun.wanted = false;
    clearTimeout(idleTimer); idleTimer = null;
    clearTimeout(refillTimer); refillTimer = null; emptySince = 0;
    generation++; // a tunnel still starting when this runs is stopped as soon as it's up
    const was = tun.pool;
    tun.pool = [];
    const keep = handoffUsing && was.includes(handoffUsing) && !tunnelEnded(handoffUsing) ? handoffUsing : null;
    for (const t of was) { t.unwatch?.(); if (t !== keep) try { t.stop(); } catch {} }
    if (keep) { handoff = keep; if (keep.child || keep.adopted) onTunnelExit(keep, () => { if (handoff === keep) handoff = null; if (handoffUsing === keep) handoffUsing = null; }); log("sharing tunnel kept for the open hand-off"); }
    if (was.length > (keep ? 1 : 0)) log("sharing tunnels stopped");
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
  const EMPTY_NOTE_MS = 60_000, REFILL_MS = 15_000, RESTART_MS = testMs("RESTART_MS", 2000);
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

  // A hand-off link from anywhere (spec server-mode step 21b, handoff.publicLink): a tunnel of its
  // own to the guest port, up only while a hand-off is open. Started by the first link made for it
  // (ensureHandoff), stopped when the last hand-off ends (stopHandoff), never kept idle the way the
  // pool's is and never kept across a restart of the helper (a keeper left behind a helper that
  // died stops once no helper beats, KEEP_GRACE_MS). Its public name serves a grant's routes alone
  // (liveview/public-turn.mjs). With the user's own tunnel (one address, one process) a live pool
  // tunnel is used as it is, and a hand-off's tunnel is taken into the pool when a join code needs one;
  // on that shared name join codes keep working (handoffShared), and the pool lets it go back to the
  // hand-off rather than stop it while a hand-off is open (stopTunnel).
  async function ensureHandoff(port) {
    if (handoffUsing && alive(handoffUsing, port)) return handoffUsing;
    const shared = own ? tun.pool.find((t) => alive(t, port)) : null;
    if (shared) return (handoffUsing = shared);
    handoffStarting ??= (async () => {
      const gen = handoffGen;
      const t = await (startHandoff ? startHandoff(port) : direct ? { url: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}`, stop() {} } : own ? startOwnTunnel(tunnelSpec, port, { log }) : startQuickTunnel(port, { log }));
      t.port = port;
      if (gen !== handoffGen) { try { t.stop(); } catch {} throw new Error("the hand-off ended while its public address was starting"); }
      handoff = t;
      if (t.child || t.adopted) onTunnelExit(t, () => { const lost = handoff === t; if (handoff === t) handoff = null; if (handoffUsing === t) handoffUsing = null; if (lost) { log("public tunnel ended by itself"); try { onPublicLost(); } catch {} } });
      log(`hand-off tunnel up: ${t.host}`);
      return (handoffUsing = t);
    })().finally(() => { handoffStarting = null; });
    return handoffStarting;
  }
  function stopHandoff() {
    handoffGen++;
    const t = handoff;
    handoff = null; handoffUsing = null;
    if (!t || tun.pool.includes(t)) return; // taken into the pool: join codes use it
    try { t.stop(); } catch {}
    log("hand-off tunnel stopped");
  }
  // The public name a hand-off link is on now, or null.
  const handoffHost = () => (handoffUsing && !tunnelEnded(handoffUsing) ? handoffUsing.host : null);
  // Whether that name is the join codes' too (the user's own tunnel, shared with the pool): then a
  // request on it that no grant's key names is the join server's (liveview/public-turn.mjs).
  const handoffShared = () => !!handoffUsing && tun.pool.includes(handoffUsing);

  // The tunnel new codes carry: the first live one (started now if there's none).
  async function ensureTunnel(live) {
    tun.wanted = true;
    clearTimeout(idleTimer); idleTimer = null;
    tun.pool = tun.pool.filter((t) => alive(t, live.guestPort));
    // The user's own tunnel already up for a hand-off: the same one carries the codes.
    if (own && !tun.pool.length && handoff && alive(handoff, live.guestPort)) tun.pool.unshift(wire(handoff, live.guestPort));
    if (!tun.pool.length) {
      tunnelStarting ??= startOne(live.guestPort).then((t) => { tun.pool.unshift(t); save(); return t; }).finally(() => { tunnelStarting = null; });
      await tunnelStarting;
    }
    fill(live.guestPort).catch(() => {}); // the standby, in the background
    return tun.pool[0];
  }

  // Read by sharing.mjs: the setting (tunnelSpec, own, pinnedPort, tunnelProblem: a bad one, said
  // by create), the pool's size, and its parts.
  return Object.assign(tun, { tunnelSpec, own, pinnedPort, tunnelProblem, POOL, via, alive, wire, fill, ensureTunnel, releaseTunnel, stopTunnel, ensureHandoff, stopHandoff, handoffHost, handoffShared });
}
