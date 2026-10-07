// The PairBrowse side panel opens from its pinned toolbar button, or with Cmd+Shift+Y
// (Ctrl+Shift+Y elsewhere), which opens the panel itself rather than going through the button.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
// The build this worker was made from. The browser can keep running an old cached copy of this
// file after an update; the helper compares this with the file on disk and reloads the extension
// when they differ (daemon/panel.mjs). A hash of this file with the value blanked (browser.mjs
// panelBuildOf).
const PB_BUILD = "e4da2826d74a0979";
globalThis.pbBuild = PB_BUILD;
// In a new profile on macOS the browser starts without a window (--no-startup-window, see
// browserArgs in browser.mjs) and this opens the first one, once per browser run (session storage), so a worker restart after
// the user closed every window brings none back.
(async () => {
  if ((await chrome.storage.session.get("started")).started) return;
  await chrome.storage.session.set({ started: true });
  if (!(await chrome.windows.getAll()).length) await chrome.windows.create({ url: "about:blank" });
})().catch(() => {});
chrome.commands.onCommand.addListener((command, tab) => {
  // Called straight from the key press: sidePanel.open needs that user gesture.
  if (command === "open-panel" && tab?.windowId !== undefined) chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
});
// The daemon hands over the live view address at launch; it's kept in session storage (memory
// only, never on disk).
globalThis.pbSetView = (url) => chrome.storage.session.set({ view: url });
// Chrome stops an idle extension worker after 30 seconds; PairBrowse talks to it any time (the
// live view address, notifications), so keep it awake: any extension call resets that timer.
setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20_000);
// "Your turn" notifications (sign-in, 2FA, CAPTCHA, an approval), shown as PairBrowse.
// Answers at once (so the helper never sends it twice); the outcome goes to the worker's console.
const shown = new Set();
globalThis.pbNotify = (title, message, id) => {
  if (id && shown.has(id)) return "already shown";
  if (id) { if (shown.size >= 500) shown.delete(shown.values().next().value); shown.add(id); }
  chrome.notifications.create({ type: "basic", iconUrl: "icon128.png", title, message, priority: 2, requireInteraction: true })
    .then((id) => console.log("notification shown", id), (e) => console.warn("notification failed", e?.message || e));
  return "queued";
};
// A join request while the person isn't looking at the browser: the notification has Allow and
// Deny. Only a person can press a notification's button (no script, page or agent can), and the
// press answers the request the side panel's way: POST approve to the live view with the owner's
// key, which this worker holds in memory (session storage). Each notification answers only the
// request it was made for (the live view answers only one still waiting). Clicking the
// notification itself brings the browser to the front, where the bottom bar asks too.
const JOIN_PREFIX = "pbjoin-";
const joinNotes = new Map(); // notification id -> request id
const noteId = (request) => JOIN_PREFIX + request;
globalThis.pbNotifyJoin = (title, message, request) => {
  request = String(request || "");
  if (!/^r[0-9a-f]{6}$/.test(request)) return "bad request";
  const nid = noteId(request);
  if (joinNotes.has(nid)) return "already shown";
  joinNotes.set(nid, request);
  chrome.notifications.create(nid, { type: "basic", iconUrl: "icon128.png", title, message, priority: 2, requireInteraction: true, buttons: [{ title: "Allow" }, { title: "Deny" }] })
    .then((id) => console.log("notification shown", id), (e) => console.warn("notification failed", e?.message || e));
  return "queued";
};
// The request was answered or is gone: its notification goes.
globalThis.pbClearJoin = (request) => {
  const nid = noteId(String(request || ""));
  if (!joinNotes.delete(nid)) return false;
  chrome.notifications.clear(nid).catch(() => {});
  return true;
};
// The list, for the helper's tests: request ids with a notification up.
globalThis.pbJoinNotes = () => [...joinNotes.values()];
async function joinButton(nid, index) {
  const request = joinNotes.get(nid);
  if (!request || (index !== 0 && index !== 1)) return false;
  joinNotes.delete(nid);
  chrome.notifications.clear(nid).catch(() => {});
  const { view } = await chrome.storage.session.get("view");
  if (!view) return false;
  const r = await fetch(view + "approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: request, allow: index === 0 }) }).catch(() => null);
  return !!r?.ok;
}
async function bringToFront() {
  const w = await chrome.windows.getLastFocused().catch(() => null);
  if (w?.id !== undefined) await chrome.windows.update(w.id, w.state === "minimized" ? { focused: true, state: "normal" } : { focused: true }).catch(() => {});
}
chrome.notifications.onButtonClicked?.addListener((nid, index) => { joinButton(nid, index).catch(() => {}); });
chrome.notifications.onClicked?.addListener((nid) => {
  bringToFront().catch(() => {});
  if (!joinNotes.has(nid)) chrome.notifications.clear(nid).catch(() => {});
});
chrome.notifications.onClosed?.addListener((nid) => { joinNotes.delete(nid); });
// Whether the person is looking at the browser: its last focused window has the system's focus
// and isn't minimized. Read here, from the browser itself, because a page can't tell: Playwright
// emulates focus for every page it drives (document.hasFocus() stays true), and a tab behind
// another app stays "visible". The helper shows a join request in the bar only then, else a
// notification.
globalThis.pbFocused = async () => {
  const w = await chrome.windows.getLastFocused();
  return w?.focused === true && w.state !== "minimized";
};
// A shared session's tabs stand in the same order in both browsers: the helper reads the tabs'
// places (and addresses, to tell them apart) and moves them. Asked only by the helper, over the
// browser's private pipe; nothing here talks to a page or the network.
globalThis.pbTabs = async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, windowId: t.windowId, index: t.index, url: t.url || t.pendingUrl || "" }));
// ids: tab ids in the order wanted. They take the places they hold now, in that order, per window.
globalThis.pbArrange = async (ids) => {
  const tabs = new Map((await chrome.tabs.query({})).map((t) => [t.id, t]));
  const byWindow = new Map();
  for (const id of ids) { const t = tabs.get(id); if (t) byWindow.set(t.windowId, [...(byWindow.get(t.windowId) || []), t]); }
  for (const list of byWindow.values()) {
    const slots = list.map((t) => t.index).sort((a, b) => a - b);
    for (let i = 0; i < list.length; i++) await chrome.tabs.move(list[i].id, { index: slots[i] }).catch(() => {});
  }
  return true;
};
// Shared browser mode (share.js, the offscreen document that captures a tab and sends it peer to
// peer). Asked only by the helper. A tab's DevTools target id is how the helper names it; here
// it becomes the tab id the capture needs (listing targets attaches to nothing).
// The tab in front (the active tab of the window last focused), by its tab id (pbTabs names the
// rest): where the helper shows a join request in the bottom bar.
globalThis.pbFront = async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id ?? null;
globalThis.pbTabId = async (targetId) => (await chrome.debugger.getTargets()).find((t) => t.id === targetId)?.tabId ?? null;
async function shareDocument() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({ url: "share.html", reasons: ["USER_MEDIA"], justification: "Show a shared tab live to the people the user let in." }).catch((e) => {
    if (!/single offscreen/i.test(String(e?.message))) throw e; // made at the same moment by another call
  });
}
globalThis.pbShare = async (msg) => {
  await shareDocument();
  if (msg?.op === "offer" && !(await chrome.runtime.sendMessage({ to: "share", op: "has", tabId: msg.tabId }))) {
    msg = { ...msg, streamId: await chrome.tabCapture.getMediaStreamId({ targetTabId: msg.tabId }) };
  }
  return chrome.runtime.sendMessage({ ...msg, to: "share" });
};
