// The side panel extension in plain Chromium reaches the same Settings page and Tools lists as the
// native build: the toolbar button's menu (ui/background.js), and the extension's pages only
// (the owner's key in the extension's session storage never reaches a web page).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// The worker with a stand-in for chrome: what it registered and what a menu click asks for.
function worker() {
  const calls = [], menus = [], on = {};
  const listen = (name) => ({ addListener: (fn) => { on[name] = fn; } });
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {}, open: async (o) => { calls.push(["sidePanel.open", o]); } },
    commands: { onCommand: { addListener() {} } },
    runtime: { getPlatformInfo() {}, onInstalled: listen("installed"), openOptionsPage: async () => { calls.push(["openOptionsPage"]); }, lastError: undefined },
    contextMenus: { removeAll: (done) => { menus.length = 0; done(); }, create: (o, done) => { menus.push(o); done?.(); }, onClicked: listen("menu") },
    storage: { session: { set: async (o) => { calls.push(["storage.session.set", o]); }, get: async () => ({ started: true }) } },
    windows: { getAll: async () => [{}] },
    notifications: { onButtonClicked: listen("button"), onClicked: listen("click"), onClosed: listen("closed") },
  };
  new Function("globalThis", "chrome", "setInterval", "fetch", "console", read("ui/background.js"))({}, chrome, () => 0, async () => ({ ok: true }), { log() {}, warn() {} });
  return { calls, menus, on };
}

test("the toolbar button's menu opens Settings and the side panel's Tools tab", async () => {
  const { calls, menus, on } = worker();
  on.installed();
  assert.deepEqual(menus.map(({ id, title, contexts }) => [id, title, contexts]), [
    ["pb-settings", "Settings", ["action"]],
    ["pb-tools", "Downloads, recordings and hand-offs", ["action"]],
  ]);
  on.installed(); // an update: the same two items, not four
  assert.equal(menus.length, 2);
  on.menu({ menuItemId: "pb-settings" }, { windowId: 3 });
  on.menu({ menuItemId: "pb-tools" }, { windowId: 3 });
  on.menu({ menuItemId: "something-else" }, { windowId: 3 });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [["openOptionsPage"], ["sidePanel.open", { windowId: 3 }], ["storage.session.set", { panelTab: "tools" }]]);
});

test("Settings in the extension is an extension page: no web page can load it or read the owner's key", () => {
  const m = JSON.parse(read("ui/manifest.json"));
  assert.equal(m.options_ui.page, "settings/index.html");
  // Nothing of the extension is reachable from a web page, and no script runs in one.
  assert.equal(m.web_accessible_resources, undefined);
  assert.equal(m.content_scripts, undefined);
  assert.equal(m.externally_connectable, undefined);
  assert.deepEqual(m.host_permissions, ["http://127.0.0.1/*"]);
  assert.ok(m.permissions.includes("contextMenus"));
  // Session storage stays in the extension's own pages (its default access level, never widened).
  for (const f of ["ui/background.js", "ui/helper.js", "ui/settings/settings.js", "ui/right/right.js", "ui/right/settings-link.js"]) {
    assert.doesNotMatch(read(f), /setAccessLevel/, f);
  }
  // Settings and the panel open the options page by the extension's own call: no address with the
  // key in it is ever handed to a tab.
  for (const f of ["ui/settings/settings.js", "ui/right/settings-link.js", "ui/background.js"]) {
    assert.doesNotMatch(read(f), /tabs\.create\(\{\s*url:\s*(view|base|url)\b/, f);
  }
});
