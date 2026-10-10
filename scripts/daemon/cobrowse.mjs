// Shared tabs, live: reads the page script in each shared tab (a pointer that moved, a field that
// changed) and hands it on at once: to the joiners' streams on the host, to the host from a
// joiner. Tabs where something is going on are read about 30 times a second, the others a few
// times a second; only tabs that are shared at all are read. Nothing here goes through an agent.
import { within } from "../util.mjs";

const HOT_MS = 33;
const IDLE_MS = 500; // between looks while no tab is shared at all (nothing to read)
const COLD_MS = 120; // per tab, more with many tabs (15 ms each)
const HOT_FOR_MS = 2500; // a tab stays "hot" this long after its last pointer move or field change
const READ_MS = 500;
const FRAMES_MAX = 6;

// call(target, value, kind): the page script (hud.mjs). pages(): the shared tabs now.
// onPointer(page, { me, agent, view }): where the person and the agent here last pointed, and
// where the person is reading (document coordinates, with times). onDirty(page, t): a field changed there at time t.
export function createCobrowse({ call, pages, onPointer, onDirty, log = () => {} }) {
  const hotUntil = new WeakMap();
  const lastSeen = new WeakMap(); // tab -> "x,y,t|x,y,t"
  const lastCold = new WeakMap();
  let busy = false;
  let stopped = false;

  async function readPage(page, cold) {
    const r = await within(READ_MS, call(page, "", "tick").catch(() => null));
    let dirty = Number(r?.dirty) || 0;
    // Fields inside frames (card forms often sit in one) are checked on the slower round.
    if (cold) for (const f of page.frames().slice(1, FRAMES_MAX)) { const x = await within(READ_MS, call(f, "", "tick").catch(() => null)); dirty = Math.max(dirty, Number(x?.dirty) || 0); }
    if (!r && !dirty) return;
    const sig = `${r?.me?.x},${r?.me?.y},${r?.me?.t}|${r?.agent?.x},${r?.agent?.y},${r?.agent?.t}|${r?.view?.y},${r?.view?.h}`;
    if (r && sig !== lastSeen.get(page)) {
      lastSeen.set(page, sig);
      hotUntil.set(page, Date.now() + HOT_FOR_MS);
      try { onPointer(page, { me: r.me || null, agent: r.agent || null, view: r.view || null }); } catch {}
    }
    if (dirty) {
      hotUntil.set(page, Date.now() + HOT_FOR_MS);
      try { onDirty(page, dirty); } catch {}
    }
  }

  async function round() {
    if (busy || stopped) return 0;
    busy = true;
    try {
      const now = Date.now();
      const list = (await pages().catch(() => [])).filter((p) => p && !p.isClosed());
      await Promise.all(list.map((p) => {
        const cold = now - (lastCold.get(p) || 0) >= Math.max(COLD_MS, list.length * 15);
        if (!cold && now >= (hotUntil.get(p) || 0)) return null;
        if (cold) lastCold.set(p, now);
        return readPage(p, cold).catch((e) => log("cobrowse", e?.message || e));
      }));
      return list.length;
    } finally {
      busy = false;
    }
  }
  // Rounds follow one another: HOT_MS apart while any tab is shared, IDLE_MS apart while none is
  // (the helper doesn't wake thirty times a second for nothing).
  let timer = null;
  const next = (ms) => { if (stopped) return; timer = setTimeout(() => round().then((n) => next(n ? HOT_MS : IDLE_MS), () => next(IDLE_MS)), ms); timer.unref(); };
  next(HOT_MS);
  // A tab just became shared or active: a round now, not after the idle gap.
  const soon = () => { if (stopped || busy) return; clearTimeout(timer); next(0); };
  return { stop() { stopped = true; clearTimeout(timer); }, hot: (page) => { hotUntil.set(page, Date.now() + HOT_FOR_MS); soon(); }, soon };
}
