// The strip's row page keeps the browser and the helper in step (DESIGN.md B2, 530 F1): other
// people's pointers passed to the browser, every window's tab order reported to the helper (and
// arranged when it asks), and the helper's agent-tabs written into the browser's owners. Split
// from strip.js; definitions only, nothing runs on import. No timer: events and microtasks only.
import { postJson } from "../helper.js";
import { isColor } from "../vocab.js";

// ---- other people's pointers over the page card (530 F1): a shared-browser joiner's, which the
// helper never draws in the tab (their picture of it would show it back to them). The browser
// draws them over this window's active tab, outside it; the row's page alone passes them on, as
// they come (no timer: each one fades by itself in the browser when it stops). ----
export function pointersFor(list) {
  const tabs = [];
  for (const t of Array.isArray(list) ? list.slice(0, 16) : []) {
    if (typeof t?.target !== "string" || !/^[0-9A-F]{32}$/i.test(t.target) || !Array.isArray(t.pointers)) continue;
    const pointers = [];
    for (const p of t.pointers.slice(0, 12)) {
      const x = Number(p?.x), y = Number(p?.y), fresh = Math.round(Number(p?.fresh));
      if (typeof p?.k !== "string" || !p.k || typeof p.who !== "string" || !p.who || !/^#[0-9a-f]{6}$/i.test(p.color || "")) continue;
      if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1 && fresh >= 1 && fresh <= 3000)) continue;
      pointers.push({ key: p.k.slice(0, 100), name: [...p.who].slice(0, 40).join(""), color: p.color, x, y, freshMs: fresh });
    }
    tabs.push({ targetId: t.target, pointers });
  }
  return tabs;
}

// ---- the tab order, for the helper (scripts/daemon/taborder.mjs): every window's tabs by CDP
// target, the focused window and the last one focused. Sent on the tab and focus events only,
// at most once per burst of them (a microtask, no timer); the helper drops a repeat. ----
export function createTabOrder({ pb, base, windowId, skip }) {
  let lastFocused = -1;
  let orderQueued = false;
  function report() {
    if (!pb || !base() || orderQueued || skip()) return;
    orderQueued = true;
    queueMicrotask(async () => {
      orderQueued = false;
      try {
        const [{ tabs: all }, { windows }] = await Promise.all([pb.tabs.list(), pb.windows.list()]);
        const focused = windows.find((w) => w.focused)?.id ?? -1;
        if (focused !== -1) lastFocused = focused;
        const list = all.filter((t) => typeof t.targetId === "string" && t.targetId).slice(0, 500)
          .map((t) => ({ target: t.targetId, window: t.window, index: t.index, active: !!t.active }));
        if (base()) postJson(base() + "tab-order", { tabs: list, focused, last: lastFocused }).catch(() => {});
      } catch {}
    });
  }
  // The helper asked for an order (a shared session's host order, by CDP target): this window's
  // tabs among them take the places those tabs hold now, in the order asked; other tabs and other
  // windows stay. One move at a time, each to its final index.
  let arranging = Promise.resolve();
  function arrange(targets) {
    if (!pb) return;
    const want = targets.filter((x) => typeof x === "string").slice(0, 500);
    arranging = arranging.then(async () => {
      const { tabs: all } = await pb.tabs.list();
      const mine = all.filter((t) => t.window === windowId()).sort((a, b) => a.index - b.index);
      const byTarget = new Map(mine.map((t) => [t.targetId, t]));
      const asked = [...new Set(want)].map((x) => byTarget.get(x)).filter(Boolean);
      if (asked.length < 2) return;
      const isAsked = new Set(asked);
      let k = 0;
      const order = mine.map((t) => (isAsked.has(t) ? asked[k++] : t));
      const now = mine.slice();
      for (let i = 0; i < order.length; i++) {
        if (now[i] === order[i]) continue;
        now.splice(now.indexOf(order[i]), 1);
        now.splice(i, 0, order[i]);
        await pb.tabs.move(order[i].id, i, -1);
      }
    }).catch(() => {});
  }
  // A window focused (the browser's onFocusChanged): the last one focused, for the next report.
  const focused = (id) => { if (id !== -1) lastFocused = id; };
  return { report, arrange, focused };
}

// ---- the helper's agent-tabs, written into the browser's owners for this window's tabs ----
// The helper knows which agent is in which page ({ id, i, host, agent: { label, color } | null,
// person }, scripts/liveview.mjs agentTabs); the browser's owners (pb.agent) are what every page's
// dot reads. An entry with `target` (the page's CDP target id) matches the tab with that targetId.
// One without matches only when that cannot be the wrong tab: the browser has one window (the
// helper's list counts every window's pages), and its host is on exactly one of this window's tabs
// and in exactly one entry without a target. The helper's `i` is the page's place in creation
// order, not in the tab row (a popup opens beside its opener, a person drags a tab), so it never
// picks a tab. Anything else waits for `target`. Only changes are written, and only owners this page
// set are cleared (kept in sessionStorage, so a reloaded strip still clears its own). The last list
// is mapped again when this window's tabs are created, moved or removed: events only, no timer.
export function createOwnerSync({ pb, tabs, owners, windowId }) {
  let sentOwners = null; // tab id -> "label\ncolor" this page set
  let lastAgentTabs = null;
  let agentTabsSeq = 0;
  const hostOfUrl = (u) => { try { return new URL(u).host; } catch { return null; } };
  const ownersKey = () => `pairbrowse.strip.owners.${windowId()}`;
  function loadSentOwners() {
    if (sentOwners) return sentOwners;
    sentOwners = new Map();
    try {
      const saved = JSON.parse(sessionStorage.getItem(ownersKey()) || "[]");
      if (Array.isArray(saved)) for (const pair of saved) if (Array.isArray(pair) && Number.isInteger(pair[0]) && typeof pair[1] === "string") sentOwners.set(pair[0], pair[1]);
    } catch {}
    return sentOwners;
  }
  function saveSentOwners() {
    try { sessionStorage.setItem(ownersKey(), JSON.stringify([...sentOwners])); } catch {}
  }
  // The entry for tab `t`, or undefined: by target, else by a host both sides hold once.
  function entryFor(t, entries, single) {
    const byTarget = entries.find((e) => typeof e.target === "string" && e.target && e.target === t.targetId);
    if (byTarget || !single) return byTarget;
    const host = hostOfUrl(t.url);
    if (!host) return undefined;
    const loose = entries.filter((e) => !e.target && e.host === host);
    if (loose.length !== 1) return undefined;
    let onTabs = 0;
    for (const other of tabs.values()) if (hostOfUrl(other.url) === host) onTabs++;
    return onTabs === 1 ? loose[0] : undefined;
  }
  async function apply(list) {
    if (!pb || !Array.isArray(list)) return;
    lastAgentTabs = list;
    const seq = ++agentTabsSeq;
    let single;
    try { const { windows } = await pb.windows.list(); single = Array.isArray(windows) && windows.length === 1; } catch { return; }
    if (seq !== agentTabsSeq) return; // a newer list is on its way
    const sent = loadSentOwners();
    const entries = list.filter((e) => e && typeof e === "object");
    const want = new Map();
    for (const t of tabs.values()) {
      const entry = entryFor(t, entries, single);
      const label = entry?.agent && typeof entry.agent.label === "string" ? entry.agent.label.trim() : "";
      if (label) want.set(t.id, { label, color: isColor(entry.agent.color) ? entry.agent.color : "" });
    }
    let changed = false;
    for (const [id, { label, color }] of want) {
      const key = `${label}\n${color}`;
      if (sent.get(id) === key) continue;
      const k = String(id);
      if (owners().agents?.[k] === label && (owners().colors?.[k] || "") === color) continue; // already so, not ours
      sent.set(id, key);
      changed = true;
      pb.agent.setTabOwner(id, label, color).catch(() => {});
    }
    for (const id of [...sent.keys()]) {
      if (want.has(id)) continue;
      sent.delete(id);
      changed = true;
      if (tabs.has(id)) pb.agent.clear(id).catch(() => {});
    }
    if (changed) saveSentOwners();
  }
  const remap = () => { if (lastAgentTabs) apply(lastAgentTabs); };
  return { apply, remap };
}
