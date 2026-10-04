// The PairBrowse side panel opens from its pinned toolbar button, or with Cmd+Shift+Y
// (Ctrl+Shift+Y elsewhere), which opens the panel itself rather than going through the button.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
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
  if (id) shown.add(id);
  chrome.notifications.create({ type: "basic", iconUrl: "icon128.png", title, message, priority: 2, requireInteraction: true })
    .then((id) => console.log("notification shown", id), (e) => console.warn("notification failed", e?.message || e));
  return "queued";
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
