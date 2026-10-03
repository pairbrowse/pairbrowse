// What PairBrowse shows inside the pages (scripts/hud.js): the status badge, the bottom bar with
// the last actions, the spark on each agent's tab icon, and Claude's cursor.
import { hudScript } from "../browser.mjs";
import { isRef } from "../policy.mjs";
import { within } from "../util.mjs";

// Each connected agent's tab carries the spark on its icon, in that participant's color (in the
// order they joined: orange, cyan, purple, green). It moves when that agent works in another tab.
const SPARK_COLORS = ["#e9763f", "#4fd1e8", "#a78bfa", "#4ade80"];
// Claude's cursor: before a click, typing or a choice, show where in the page it happens.
const CURSOR_TOOLS = { browser_click: "click", browser_type: "type", browser_hover: "hover", browser_select_option: "click", browser_fill_form: "type", pairbrowse_upload: "click" };
const CURSOR_WAIT_MS = 300; // never holds an action up for longer
const RECENT_ITEMS = 4;
const SHARED_SPARK_MS = 30_000;

// pages(): the open tabs (none while the browser is closed). participants(): ids in the order
// they joined. waiting(page): the person an agent waits for there. liveView(): the live view, if
// up. notify(text): tells the user it's their turn.
export function createHud({ pages, participants, waiting, liveView, notify }) {
  // The page script, with names and a key that are new each time the helper starts.
  const { source, name: HUD_NAME, token: HUD_TOKEN } = hudScript();
  let badge = { text: "", kind: "clear" };
  const sparks = new Map(); // participant -> { page, color }
  const recent = []; // the bar's last actions, newest last
  const lastInTab = new WeakMap(); // tab -> { text, who }, for the tab overview
  const listeners = new Set(); // onActivity: a joined session's shared tabs send theirs on

  // One call into the page script (in a page or a frame). Rejects when the page doesn't answer.
  const call = (target, value, kind) => target.evaluate(([n, t, v, k]) => window[n]?.(t, v, k), [HUD_NAME, HUD_TOKEN, value, kind]);
  const quietly = (target, value, kind) => call(target, value, kind).catch(() => {});

  // The page script normally comes in as an init script. Some engines don't run those (patchright
  // with the native PairBrowse browser), so add it whenever a page loads without it. Under
  // patchright this runs in its hidden script world, the same one every later page.evaluate uses.
  async function ensure(page) {
    try {
      if (await page.evaluate((n) => typeof window[n] === "function", HUD_NAME)) return;
      await page.evaluate(source);
    } catch {}
  }

  const applyBadge = (page) => quietly(page, badge.text, badge.kind);
  const applySpark = (page, color) => quietly(page, color || "", "spark");
  // Agents in the other browser of a shared tab (a joined session): their spark shows on this
  // browser's copy too, in their color, unless an agent here holds the tab. Each one lasts
  // SHARED_SPARK_MS unless it's said again.
  const sharedSparks = new Map(); // tab -> { color, until }
  const sharedSpark = (page) => { const s = sharedSparks.get(page); return s && Date.now() < s.until ? s.color : ""; };
  function setSharedSpark(page, color) {
    if (!page || page.isClosed()) return;
    const before = sharedSpark(page);
    if (color) sharedSparks.set(page, { color, until: Date.now() + SHARED_SPARK_MS }); else sharedSparks.delete(page);
    if (before !== (color || "") && !sparkOn(page)) applySpark(page, color);
  }
  setInterval(() => {
    for (const [page, s] of sharedSparks) if (Date.now() >= s.until) { sharedSparks.delete(page); if (!page.isClosed() && !sparkOn(page)) applySpark(page, ""); }
  }, 5000).unref();
  // Where the person and the agent last pointed in a tab (document coordinates), and the others'
  // pointers from the other browser of a shared tab, drawn in the page.
  const readPointer = (page) => within(800, call(page, "", "pointer").catch(() => null));
  const showPointers = (page, list) => quietly(page, JSON.stringify(list), "cursors");
  function applyBar(page) {
    const person = waiting(page);
    return quietly(page, JSON.stringify({ items: recent, waiting: !!person, person: person || "" }), "bar");
  }
  const sparkOn = (page) => [...sparks.values()].find((s) => s.page === page);

  // The badge in every tab and the live view. kind "you" also notifies the user.
  async function setBadge(text, kind) {
    badge = kind === "clear" ? { text: "", kind: "clear" } : { text: String(text || ""), kind };
    liveView()?.setStatus(badge);
    if (badge.kind === "you" && badge.text) notify(badge.text);
    await Promise.all((await pages()).map(applyBadge));
  }

  function sparkColor(participant) {
    const order = participants();
    return SPARK_COLORS[Math.max(0, order.indexOf(participant)) % SPARK_COLORS.length];
  }
  // Moves a participant's spark to a tab: the page itself, else the tab showing url (none: takes
  // it away). A page is exact; two tabs can show the same URL.
  async function moveSpark(participant, url) {
    const page = (url && typeof url === "object" ? url : url && (await pages()).find((p) => p.url() === url)) || null;
    const prev = sparks.get(participant);
    if (prev?.page === page) return;
    if (page) sparks.set(participant, { page, color: sparkColor(participant) });
    else sparks.delete(participant);
    const still = prev?.page && sparkOn(prev.page);
    if (prev?.page && !prev.page.isClosed()) await applySpark(prev.page, still?.color || sharedSpark(prev.page));
    if (page) await applySpark(page, sparks.get(participant).color);
  }
  const sparkPage = (participant) => sparks.get(participant)?.page;
  // The agent whose spark is on this tab: { id, color }, or null.
  function sparkOwner(page) {
    const entry = [...sparks.entries()].find(([, s]) => s.page === page);
    return entry ? { id: entry[0], color: entry[1].color } : null;
  }

  const tabName = (page) => { try { const i = page.context().pages().indexOf(page); return i >= 0 ? `tab ${i + 1}` : ""; } catch { return ""; } };
  // text: what happened; who: the participant's label ("Alice · Claude Code"); page: the tab.
  // from: the joiner it came from (a joined session's activity isn't sent back there).
  function addActivity(text, who = "", page = null, from = "") {
    if (text && page) lastInTab.set(page, { text: String(text).slice(0, 120), who: String(who).slice(0, 60) });
    liveView()?.addActivity(text, who, page ? tabName(page) : "", page, from);
    for (const fn of listeners) try { fn(text, who, page, from); } catch {}
    if (!text) return;
    recent.push({ t: Date.now(), text: String(text).slice(0, 200), who: String(who).slice(0, 60) });
    if (recent.length > RECENT_ITEMS) recent.shift();
    pages().then((all) => all.forEach(applyBar)).catch(() => {});
  }

  function pointAt(page, box, act) {
    if (box) return quietly(page, JSON.stringify({ x: box.x + Math.min(box.width / 2, 24), y: box.y + box.height / 2, act }), "cursor");
  }
  // Moves the cursor to an element (fast mode); doesn't wait for anything.
  function cursorTo(page, el, act) {
    within(CURSOR_WAIT_MS, el.boundingBox().catch(() => null)).then((box) => pointAt(page, box, act));
  }
  // Before a browser tool acts on a snapshot ref. pageFor(): the tab it acts in (null: none).
  async function showCursor(tool, args, pageFor) {
    const act = CURSOR_TOOLS[tool];
    const target = args?.target || args?.fields?.[0]?.target;
    if (!act || !isRef(target)) return;
    const page = await pageFor();
    if (page) await pointAt(page, await within(CURSOR_WAIT_MS, page.locator(`aria-ref=${target}`).boundingBox().catch(() => null)), act);
  }

  // Each page as it loads: the script, then the badge, spark and bar.
  async function onPageLoad(page) {
    await ensure(page);
    if (badge.text) applyBadge(page);
    if (sparkOn(page) || sharedSpark(page)) applySpark(page, sparkOn(page)?.color || sharedSpark(page));
    applyBar(page);
  }

  return {
    source, call, ensure, onPageLoad, applyBar, setBadge, badge: () => badge,
    moveSpark, sparkPage, sparkOwner, sparkColor, clearSparks: () => sparks.clear(), setSharedSpark, sharedSpark, readPointer, showPointers,
    addActivity, onActivity: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, lastIn: (page) => lastInTab.get(page) || null, cursorTo, showCursor,
  };
}
