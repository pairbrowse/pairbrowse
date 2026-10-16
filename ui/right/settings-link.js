// The side panel's way to the Settings page, and the Tools tab asked for from outside.
// In the browser (its API, pb): one Tools row opens pairbrowse://settings/pairbrowse (Passwords first, the
// page's #passwords anchor). In the extension host the same Settings page is the extension's
// options page (settings/index.html, an extension page: the owner's key never reaches a web
// page), opened by the header's gear and that row; Passwords and the rest stay in this panel.
// Served without either (the harness without chrome.*): both stay hidden. The toolbar button's
// menu (background.js) and Settings ask for the Tools tab through the extension's session storage
// ("panelTab"): read once now and on each change, then cleared. Nothing runs but on a click or
// that change; no timer.
import { $ } from "../common.js";
import { settingsPage } from "../urls.js";

export function settingsLink({ pb, native, selectTab, scope = globalThis }) {
  const chrome = scope.chrome;
  if (pb) {
    $("sec-settings-link").hidden = false;
    $("open-settings").addEventListener("click", () => { pb.tabs.create(settingsPage("passwords"), true, -1).catch(() => {}); });
    return;
  }
  if (native) return;
  if (typeof chrome?.runtime?.openOptionsPage === "function") {
    $("sec-settings-link").hidden = false;
    $("settings-link-note").textContent = "Your browser, downloads folder, invites, approvals and more are in Settings.";
    $("top-settings").hidden = false;
    const open = (ev) => { if (ev.isTrusted) Promise.resolve(chrome.runtime.openOptionsPage()).catch(() => {}); };
    for (const id of ["open-settings", "top-settings"]) $(id).addEventListener("click", open);
  }
  const area = chrome?.storage?.session;
  if (!area) return;
  const take = (tab) => {
    if (tab !== "tools") return;
    selectTab("tools");
    Promise.resolve(area.remove?.("panelTab")).catch(() => {});
  };
  try {
    Promise.resolve(area.get("panelTab")).then((got) => take(got?.panelTab), () => {});
    chrome.storage.onChanged?.addListener((changes, where) => { if (where === "session") take(changes?.panelTab?.newValue); });
  } catch {}
}
