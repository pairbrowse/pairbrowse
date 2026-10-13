// What PairBrowse shows inside the pages (scripts/hud.js): the status badge, the bottom bar with
// the last actions, the spark on each agent's tab icon (a dot for a person from the other browser
// of a shared tab), and Claude's cursor.
import { hudScript } from "../browser.mjs";
import { isRef } from "../policy.mjs";
import { within } from "../util.mjs";
import { CHALLENGE_TURN } from "../popups.mjs";

// Each connected agent's tab carries the spark on its icon, in that participant's color. It moves
// when that agent works in another tab. Colors go by app, not by join order, as the mockup draws
// them (the user, 2026-10-12): Claude Code orange, Codex purple #9b7bfa, Gemini blue #4b8ffb;
// everyone else (other agents, a second agent of the same app, people) takes the rest in join
// order. The cursor's edge and pill, the avatars and the owner dots all read this one value. Dark
// ink (#0B1421) on each is AA, white is not (test/tokens.test.mjs; ui/common.js inkOn picks it).
export const SPARK_COLORS = ["#e9763f", "#9b7bfa", "#4b8ffb", "#4ade80", "#4fd1e8", "#f472b6"];
const APP_COLORS = { claude: "#e9763f", codex: "#9b7bfa", gemini: "#4b8ffb" };
const OTHER_COLORS = SPARK_COLORS.filter((c) => !Object.values(APP_COLORS).includes(c));

// The app a participant's label names: "claude", "codex", "gemini" or "" (another agent, or a person). A
// person's label ends in "(by hand)"; "Name · App" names its app after the dot, else the first word
// does ("Claude 3fed", "Codex").
export function appOf(label) {
  const s = String(label || "").trim();
  if (/\(by hand\)$/i.test(s)) return "";
  const i = s.lastIndexOf(" · ");
  const app = i >= 0 ? s.slice(i + 3).trim() : s;
  if (/^claude\b/i.test(app)) return "claude";
  if (/^codex\b/i.test(app)) return "codex";
  if (/^gemini\b/i.test(app)) return "gemini";
  return "";
}
// Colors for labels in join order: an app's own color while it is free, else the first free other
// color; with every color taken, the others again in turn.
export function assignColors(labels) {
  const taken = new Set();
  let n = 0;
  return labels.map((label) => {
    const own = APP_COLORS[appOf(label)];
    let c = own && !taken.has(own) ? own : OTHER_COLORS.find((x) => !taken.has(x));
    if (!c) c = OTHER_COLORS[n++ % OTHER_COLORS.length];
    taken.add(c);
    return c;
  });
}
// Claude's cursor: before a click, typing or a choice, show where in the page it happens.
const CURSOR_TOOLS = { browser_click: "click", browser_type: "type", browser_hover: "hover", browser_select_option: "click", browser_fill_form: "type", pairbrowse_upload: "click" };
const CURSOR_WAIT_MS = 300; // never holds an action up for longer finding its element
const CURSOR_ARRIVE_MS = 350; // nor for longer while the cursor gets there (the page script's limit)
// Declaring what is about to be pressed is what tells the agent's own press from a person's, so
// it waits longer than the cursor (a busy computer) for the box and for the page to take it; a
// press itself is never held up past these.
const PRESS_BOX_WAIT_MS = 1500;
const PRESS_SEND_WAIT_MS = 1000;
const RECENT_ITEMS = 4;
const SHARED_SPARK_MS = 30_000;
const PERSON_MARK_MS = 8000; // a person from the other browser stays marked this long after their last input

// pages(): the open tabs (none while the browser is closed). participants(): ids in the order
// they joined. labelOf(id): a participant's label ("" when unknown), for its color by app. waiting(page): the person an agent waits for there. liveView(): the live view, if
// up. notify(text): tells the user it's their turn. pause(): { by, can }: who paused agents (by
// empty: nobody) and whether the person here may pause and resume (daemon/pause.mjs). docked():
// true while the browser is a PairBrowse build with its own pages (the window's docks carry the
// bar's duties; scripts/hud.js "docked").
export function createHud({ pages, participants, labelOf = () => "", waiting, liveView, notify, pause = () => ({ by: "", can: true }), docked = () => false }) {
  // The page script, with names and a key that are new each time the helper starts.
  const { source, name: HUD_NAME, token: HUD_TOKEN } = hudScript();
  let badge = { text: "", kind: "clear", color: "" };
  const sparks = new Map(); // participant -> { page, color }
  // The bar's last actions, newest last: each tab's own (what was done there), and the ones about
  // no tab (a session joined or ended, a joiner's task), shown in every tab. Another agent's work
  // in another tab never shows in yours.
  const recentInTab = new WeakMap(); // tab -> [{ t, text, who }]
  const recentEverywhere = [];
  const recentFor = (page) => [...(recentInTab.get(page) || []), ...recentEverywhere].sort((a, b) => a.t - b.t).slice(-RECENT_ITEMS);
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

  // With the agent's spark color the text goes as data ({ text, color }: the badge's left edge in
  // that color), never through the page's JSON.parse; PairBrowse's own statuses stay plain text.
  const applyBadge = (page) => quietly(page, badge.color ? { text: badge.text, color: badge.color } : badge.text, badge.kind);
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
    if (before !== (color || "") && !sparkOn(page)) applySpark(page, tabIcon(page));
  }
  // A person from the other browser of a shared tab using it by hand: a dot in their color on the
  // tab's icon (in a corner of an agent's spark, when one is there). It goes PERSON_MARK_MS after
  // their last input.
  const personMarks = new Map(); // tab -> { color, until }
  const personMark = (page) => { const m = personMarks.get(page); return m && Date.now() < m.until ? `o${m.color}` : ""; };
  // What the tab's icon shows: the spark of an agent here, else of one there; and a person there
  // ("#rrggbb", "o#rrggbb" or both, space apart; empty: the site's own icon).
  const tabIcon = (page) => [sparkOn(page)?.color || sharedSpark(page), personMark(page)].filter(Boolean).join(" ");
  function setPersonMark(page, color) {
    if (!page || page.isClosed()) return;
    const before = tabIcon(page);
    if (/^#[0-9a-f]{6}$/i.test(color || "")) personMarks.set(page, { color, until: Date.now() + PERSON_MARK_MS }); else personMarks.delete(page);
    if (tabIcon(page) !== before) applySpark(page, tabIcon(page));
  }
  setInterval(() => {
    for (const [page, s] of sharedSparks) if (Date.now() >= s.until) { sharedSparks.delete(page); if (!page.isClosed() && !sparkOn(page)) applySpark(page, tabIcon(page)); }
    for (const [page, m] of personMarks) if (Date.now() >= m.until) { personMarks.delete(page); if (!page.isClosed()) applySpark(page, tabIcon(page)); }
  }, 2000).unref();
  // Where the person and the agent last pointed in a tab (document coordinates), and the others'
  // pointers from the other browser of a shared tab, drawn in the page.
  const readPointer = (page) => within(800, call(page, "", "pointer").catch(() => null));
  const showPointers = (page, list) => quietly(page, JSON.stringify(list), "cursors");
  // The shared tabs whose connection to the host is being moved to another address: their bars say
  // "Reconnecting to Bob…" meanwhile (for the person here only; agents hear nothing of it).
  let reconnecting = { to: "", pages: new Set() };
  // Whether this browser's recorder runs (daemon.mjs sets it): the bars of this browser's own pages
  // show a REC pill meanwhile. Never crossed to joiners.
  let recording = false;
  function applyBar(page) {
    const person = waiting(page);
    const p = pause();
    const re = reconnecting.to && reconnecting.pages.has(page) ? reconnecting.to : "";
    return quietly(page, JSON.stringify({ items: recentFor(page), waiting: !!person, person: person || "", pause: p.by ? { by: p.by } : null, canPause: !!p.can, ...(re ? { reconnecting: re } : {}), ...(recording ? { recording: true } : {}) }), "bar");
  }
  function setRecording(on) {
    on = !!on;
    if (on === recording) return;
    recording = on;
    return pages().then((all) => all.forEach(applyBar)).catch(() => {});
  }
  // to: the host's name while the switch is on (empty: over); pages: the shared tabs here.
  function setReconnecting(to, pages = []) {
    const next = { to: String(to || "").slice(0, 60), pages: new Set(to ? pages : []) };
    const same = next.to === reconnecting.to && next.pages.size === reconnecting.pages.size && [...next.pages].every((p) => reconnecting.pages.has(p));
    if (same) return;
    const touched = new Set([...reconnecting.pages, ...next.pages]);
    reconnecting = next;
    for (const page of touched) if (!page.isClosed()) applyBar(page);
  }
  const sparkOn = (page) => [...sparks.values()].find((s) => s.page === page);

  // Each agent's status (pairbrowse_status). The badge shows a hand-off to the user ("you")
  // over agents' own statuses, else the latest; an agent that isn't Claude is named in its
  // status ("Codex: filling the form"). PairBrowse's own "solve the check" badge (popups) stands.
  const statuses = new Map(); // participant -> { text, kind, t, color }
  async function setBadgeFor(participant, text, kind, label = "") {
    if (kind === "clear" || !text) { if (!statuses.delete(participant)) return; } // nothing to take down
    else {
      const app = String(label || "").split(" · ")[1] || "";
      const other = kind === "claude" && app && !/^Claude/i.test(app);
      statuses.set(participant, { text: other ? `${app}: ${text}` : String(text), kind: other ? "agent" : kind, t: Date.now(), color: sparkColor(participant) });
    }
    if (badge.kind === "you" && badge.text === CHALLENGE_TURN) return; // PairBrowse's own hand-off stands
    const all = [...statuses.values()].sort((a, b) => b.t - a.t);
    const shown = all.find((s) => s.kind === "you") || all[0];
    if ((shown?.text || "") === badge.text && (shown?.kind || "clear") === badge.kind && (shown?.color || "") === badge.color) return; // as shown already
    await setBadge(shown?.text || "", shown?.kind || "clear", shown?.color || "");
  }
  const statusOf = (participant) => statuses.get(participant) || null;
  // The badge in every tab and the live view. kind "you" also notifies the user. color: the
  // participant's spark color (its status), "" for PairBrowse's own.
  async function setBadge(text, kind, color = "") {
    badge = kind === "clear" ? { text: "", kind: "clear", color: "" } : { text: String(text || ""), kind, color: /^#[0-9a-f]{6}$/i.test(color) ? color : "" };
    liveView()?.setStatus(badge);
    if (badge.kind === "you" && badge.text) notify(badge.text);
    await Promise.all((await pages()).map(applyBadge));
  }

  // The participants colored in join order (an id not listed comes last); an unlisted
  // "joined:<label>" id is labelled from its own label.
  function sparkColor(participant) {
    const ids = [...participants()];
    if (!ids.includes(participant)) ids.push(participant);
    const labelFor = (id) => labelOf(id) || (typeof id === "string" && id.startsWith("joined:") ? id.slice(7) : "");
    return assignColors(ids.map(labelFor))[ids.indexOf(participant)];
  }
  // Moves a participant's spark to a tab: the page itself, else the tab showing url (none: takes
  // it away). A page is exact; two tabs can show the same URL.
  async function moveSpark(participant, url) {
    const page = (url && typeof url === "object" ? url : url && (await pages()).find((p) => p.url() === url)) || null;
    const prev = sparks.get(participant);
    if (prev?.page === page) return;
    if (page) sparks.set(participant, { page, color: sparkColor(participant) });
    else sparks.delete(participant);
    sparksChanged();
    if (prev?.page && !prev.page.isClosed()) await applySpark(prev.page, tabIcon(prev.page));
    if (page) await applySpark(page, tabIcon(page));
  }
  const sparkPage = (participant) => sparks.get(participant)?.page;
  // A tab closed: no spark, shared spark or person mark stays on it (each would hold the page).
  function forgetPage(page) {
    let moved = false;
    for (const [participant, s] of sparks) if (s.page === page) { sparks.delete(participant); moved = true; }
    sharedSparks.delete(page);
    personMarks.delete(page);
    if (moved) sparksChanged();
  }
  const cursorListeners = new Set(); // fn(page, { x, y, t }): an agent's cursor was sent there
  // Someone wants to know when an agent's spark moved (the tab labels: daemon/tablabels.mjs).
  const sparkListeners = new Set();
  function sparksChanged() { for (const fn of sparkListeners) try { fn(); } catch {} }
  // The agent is done in a tab: its cursor there goes at once instead of after a while.
  const hideCursor = (page) => (page && !page.isClosed() ? quietly(page, "", "cursor-off") : Promise.resolve());
  // Every agent's spark: [{ id, page, color }].
  const sparkList = () => [...sparks.entries()].map(([id, s]) => ({ id, page: s.page, color: s.color }));
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
    const item = { t: Date.now(), text: String(text).slice(0, 200), who: String(who).slice(0, 60) };
    if (page) {
      const list = recentInTab.get(page) || [];
      list.push(item);
      if (list.length > RECENT_ITEMS) list.shift();
      recentInTab.set(page, list);
      if (!page.isClosed()) applyBar(page);
      return;
    }
    recentEverywhere.push(item);
    if (recentEverywhere.length > RECENT_ITEMS) recentEverywhere.shift();
    pages().then((all) => all.forEach(applyBar)).catch(() => {});
  }

  // who: the agent's name, shown on its cursor in its spark color (like people's pointers).
  // It goes to the element's center, where a click lands (a humanized click picks its own point
  // inside: the press puts the cursor there). Resolves to how long it takes to arrive (ms).
  const cursorSeq = new WeakMap(); // tab -> how many times a cursor was sent there
  async function pointAt(page, box, act, who = "") {
    if (!box) return 0;
    cursorSeq.set(page, (cursorSeq.get(page) || 0) + 1);
    const r = await quietly(page, JSON.stringify({ x: box.x + box.width / 2, y: box.y + box.height / 2, act, who: who || "Claude", color: sparkOwner(page)?.color || "", w: Math.round(Math.min(box.width, box.height)), bw: Math.round(box.width), bh: Math.round(box.height) }), "cursor");
    // Where it points goes to people in other browsers at once, not only on their next poll (a
    // busy computer can let polls time out for seconds).
    if (r?.at) for (const fn of cursorListeners) try { fn(page, r.at); } catch {}
    return Math.max(0, Math.min(CURSOR_ARRIVE_MS, Number(r?.ms) || 0));
  }
  // Where an element is, for the cursor: the action never waits longer than CURSOR_WAIT_MS for it.
  // A busy computer can take longer to say: then the cursor still goes there once it's known
  // (unless it was sent somewhere else meanwhile), so people in other browsers see the agent's
  // pointer all the same.
  async function boxFor(page, el, act, who, asked = el.boundingBox().catch(() => null)) {
    const box = await within(CURSOR_WAIT_MS, asked);
    if (!box) {
      const seq = cursorSeq.get(page) || 0;
      asked.then((late) => { if (late && (cursorSeq.get(page) || 0) === seq && !page.isClosed()) pointAt(page, late, act, who).catch(() => {}); }).catch(() => {});
    }
    return box;
  }
  // Declares to the page what PairBrowse is about to press there, before the press: boxes in
  // viewport pixels (an element's, or a spot with no size). The page script then knows a trusted
  // press inside one as PairBrowse's own for a while, whatever the cursor animation is doing; the
  // daemon's presence hears of it too (onPress), in case the page is slow to take it. Resolves
  // once the page has it (or after a bounded wait: a press is never held up for long).
  const pressListeners = new Set(); // fn(page, { x, y, w, h, t }): a declared press (box center)
  async function declarePress(page, boxes) {
    const list = (boxes || []).filter((b) => b && Number.isFinite(b.x) && Number.isFinite(b.y)).slice(0, 40).map((b) => ({ x: b.x, y: b.y, w: Math.max(0, Number(b.width ?? b.w) || 0), h: Math.max(0, Number(b.height ?? b.h) || 0) }));
    if (!list.length || !page || page.isClosed()) return false;
    const t = Date.now();
    for (const b of list) for (const fn of pressListeners) try { fn(page, { x: b.x + b.w / 2, y: b.y + b.h / 2, w: b.w, h: b.h, t, press: true }); } catch {}
    return (await within(PRESS_SEND_WAIT_MS, call(page, JSON.stringify(list), "press").catch(() => false))) === true;
  }
  // The box of what is about to be pressed: el is a locator, or anything with boundingBox().
  // asked: its boundingBox() promise when already under way (the cursor asked first), since: when
  // it was asked (the wait is bounded from then, not from now).
  const pressBox = (el, asked = null, since = Date.now()) => within(Math.max(50, PRESS_BOX_WAIT_MS - (Date.now() - since)), (asked || el.boundingBox()).catch(() => null)).catch(() => null);
  // Declares a press on el (see declarePress). Resolves to whether the page took it.
  async function pressOn(page, el) {
    if (!page || page.isClosed() || !el) return false;
    return declarePress(page, [await pressBox(el)]);
  }
  // Moves the cursor to an element (fast mode), and declares the press there. Returns a promise:
  // fast mode doesn't wait for the cursor to arrive, only for it and the declaration to be sent
  // (so the press that follows puts it on the click, and is known as the agent's).
  function cursorTo(page, el, act, who = "") {
    const since = Date.now();
    const asked = el.boundingBox().catch(() => null);
    return within(CURSOR_WAIT_MS, asked).then(async (box) => {
      if (!box) {
        const seq = cursorSeq.get(page) || 0;
        asked.then((late) => { if (late && (cursorSeq.get(page) || 0) === seq && !page.isClosed()) pointAt(page, late, act, who).catch(() => {}); }).catch(() => {});
      }
      const ms = await pointAt(page, box, act, who);
      await declarePress(page, [box || await pressBox(el, asked, since)]);
      return ms;
    }).catch(() => {});
  }
  // Before a browser tool acts on an element: a snapshot ref, or a selector (the same one the tool
  // uses). pageFor(): the tab it acts in (null: none).
  async function showCursor(tool, args, pageFor, who = "") {
    const act = CURSOR_TOOLS[tool];
    const target = args?.target || args?.fields?.[0]?.target;
    if (!act || typeof target !== "string" || !target) return;
    const page = await pageFor();
    if (!page) return;
    let el;
    try { el = page.locator(isRef(target) ? `aria-ref=${target}` : target).first(); } catch { return; }
    const since = Date.now();
    const asked = el.boundingBox().catch(() => null);
    const box = await boxFor(page, el, act, who, asked);
    const ms = await pointAt(page, box, act, who);
    // The press that follows is the agent's: declared before the action goes on.
    await declarePress(page, [box || await pressBox(el, asked, since)]);
    // The action waits for the cursor to arrive, so it is there when the click happens.
    if (ms) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // What a form fill will act on, all of it (document pixels), so the page script knows the
  // agent's own clicks on the later fields (and on the labels of ticked boxes) from a person's.
  async function markTargets(page, targets) {
    if (!page || page.isClosed()) return;
    const boxes = (await Promise.all((targets || []).filter((t) => typeof t === "string" && t).slice(0, 40).map((t) => within(400, page.locator(isRef(t) ? `aria-ref=${t}` : t).first().boundingBox().catch(() => null)).catch(() => null)))).filter(Boolean);
    if (boxes.length) await quietly(page, JSON.stringify(boxes.map((b) => ({ x: b.x, y: b.y, w: b.width, h: b.height }))), "targets");
  }
  // Each page as it loads: the script, then the badge, spark and bar. Inside the PairBrowse
  // browser's own window (docked()), the page first learns that the window's agent panel carries
  // the bar and the agent's status (scripts/hud.js "docked"); elsewhere no call is made.
  async function onPageLoad(page) {
    await ensure(page);
    if (docked()) await quietly(page, JSON.stringify({ on: true }), "docked");
    if (badge.text) applyBadge(page);
    if (tabIcon(page)) applySpark(page, tabIcon(page));
    applyBar(page);
  }

  return {
    // The page script's name and key: forms.mjs reads and claims fields through it.
    key: [HUD_NAME, HUD_TOKEN],
    refreshBars: () => pages().then((all) => all.forEach(applyBar)).catch(() => {}),
    source, call, ensure, onPageLoad, applyBar, setReconnecting, setRecording, setBadge, setBadgeFor, statusOf, badge: () => badge,
    moveSpark, sparkPage, sparkOwner, sparkList, hideCursor, forgetPage, sparkColor, clearSparks: () => { sparks.clear(); sparksChanged(); }, onSparks: (fn) => { sparkListeners.add(fn); return () => sparkListeners.delete(fn); }, onCursor: (fn) => { cursorListeners.add(fn); return () => cursorListeners.delete(fn); }, setSharedSpark, sharedSpark, setPersonMark, tabIcon, readPointer, showPointers,
    addActivity, onActivity: (fn) => { listeners.add(fn); return () => listeners.delete(fn); }, lastIn: (page) => lastInTab.get(page) || null, cursorTo, showCursor, markTargets,
    pressOn, declarePress, onPress: (fn) => { pressListeners.add(fn); return () => pressListeners.delete(fn); },
  };
}
