// window.pairbrowse for the pages' harness: a fake of the browser's own API (the draft
// native/mojom/pairbrowse.mojom in the native repo, Part B13 of DESIGN.md) over a fixture, with
// test controls. The page contract below is what page authors and the native adapter (the
// pairbrowse-api.js that 520-webui-pages inserts over the generated bindings) both follow; a
// mismatch found later is fixed in the adapter, never by changing this contract.
//
// (1) window.pairbrowse is a plain object
//       { tabs, windows, layout, omnibox, session, agent, files, approval, NetworkState, SecurityLevel, DockState,
//         BubbleKind } and, with the fixture's bubbles: true, bubbles.
//     It exists before the page's first script in the harness (the ui server inserts this file)
//     and in the browser build (the 520 patch inserts the adapter the same way at pack time), and
//     is absent in the extension and the live view: a page tests `window.pairbrowse` once and
//     otherwise falls back to the helper's routes.
//     Interfaces: Tabs (tabs), TabsObserver, Windows (windows), WindowsObserver, Layout (layout),
//     LayoutObserver, Omnibox (omnibox), OmniboxObserver, Session (session), Agent (agent),
//     AgentObserver, Files (files), ApprovalHost (approval: setPending(count, targetId), 530; the
//     browser binds it only for its approval page, the harness records the calls), Bubbles
//     (bubbles: open(kind, anchor, arg) -> { shown }, close(kind), addObserver; 530 E1, a build
//     with the cross-slot bubbles; opt-in: the fixture's bubbles: true, so a page's tests without it
//     see a build without them), BubblesObserver.
// (2) Mojom Interface.Method is interface.method (lowerCamel). Every method returns a Promise.
//     A method with a reply `=> (a, b)` resolves to { a, b }, the reply names in lowerCamel:
//       session.helper() -> { origin, key }        tabs.list() -> { tabs }
//       tabs.create(url, active, window) -> { id } tabs.move(...) -> { ok }
//       tabs.duplicate(id) -> { newId }            tabs.get(id) -> { tab }
//       tabs.addToGroup(id, group) -> { group }    layout.get() -> { state }
//       omnibox.getState() -> { state }            agent.getOwners() -> { agents, colors }
//       files.choose(...) -> { paths }             files.saveAs(name) -> { path }
//       session.grantTabCapture(targetId, audio) -> { streamId }
//       windows.startTabDrag(tabId, offset) -> { moved }
//     The nav row's calls: tabs.goBack(id), tabs.goForward(id), tabs.stop(id), windows.bookmark(id),
//     windows.find(id); a tab's history in canGoBack / canGoForward, a window's own slot in current.
//     A tab the browser is capturing (550: a share or a recording through the capture page) has
//     capturing true; onChanged fires when it flips.
//     A method without a reply resolves to undefined once applied. Arguments are positional, in
//     mojom order.
// (3) Struct fields are lowerCamel: target_id -> targetId, default_favicon -> defaultFavicon,
//     network_state -> networkState, group_title -> groupTitle, group_color -> groupColor,
//     left_width -> leftWidth, right_width -> rightWidth, strip_height -> stripHeight,
//     timeline_height -> timelineHeight, security_level -> securityLevel,
//     display_url -> displayUrl, full_url -> fullUrl, security_text -> securityText,
//     should_display_url -> shouldDisplayUrl, user_input_in_progress -> userInputInProgress,
//     popup_open -> popupOpen, popup_bounds -> popupBounds, active_tab -> activeTab.
//     Nullable fields are null. Enums are numbers in declaration order, their objects exposed:
//     NetworkState.kNone..kError = 0..3, SecurityLevel.kNone..kDangerous = 0..3,
//     DockState.kHidden, kRail, kOpen = 0..2. A map<int32, string> arrives as a plain object
//     keyed by the decimal id (the adapter converts a Map if the generated code hands one).
// (4) x.addObserver(obj) takes a plain object with the observer interface's methods in
//     lowerCamel: TabsObserver onCreated(tab), onChanged(tab), onRemoved(id),
//     onMoved(id, index, window), onActivated(id, window); WindowsObserver onFocusChanged(id),
//     onBoundsChanged(window), onCreated(window), onRemoved(id); LayoutObserver onLayout(state);
//     OmniboxObserver onState(state); AgentObserver onOwnerChanged(id, agent, color),
//     onNotificationAction(id, button); BubblesObserver onClosed(kind, byEscape). Missing methods are no-ops; calls arrive asynchronously
//     (queueMicrotask) in registration order; addObserver returns a remove() function (the
//     adapter closes the receiver).
// (5) No synchronous getters, no other properties, no events on window.
//
// The shim itself starts no timer: every observer call is a microtask.

export const ENUMS = {
  NetworkState: { kNone: 0, kWaiting: 1, kLoading: 2, kError: 3 },
  SecurityLevel: { kNone: 0, kSecure: 1, kWarning: 2, kDangerous: 3 },
  DockState: { kHidden: 0, kRail: 1, kOpen: 2 },
  BubbleKind: { kSwitcher: 0, kShare: 1, kPicture: 2 },
};

const tab = (id, index, title, url, active) => ({
  id, index, window: 1, title, url, favicon: null, defaultFavicon: true, networkState: 0,
  muted: false, audible: false, pinned: false, group: null, groupTitle: null, groupColor: null,
  active, selected: active, blocked: false, width: 1280, height: 800, targetId: `T${id}`,
  canGoBack: false, canGoForward: false, capturing: false,
});

export function defaultFixture() {
  return {
    helper: { origin: "", key: "" },
    tabs: [
      tab(11, 0, "Shop", "https://shop.example/checkout", true),
      tab(12, 1, "Docs", "https://docs.example/", false),
      tab(13, 2, "New Tab", "chrome://pairbrowse/newtab", false),
    ],
    windows: [{ id: 1, bounds: { x: 0, y: 0, width: 1536, height: 1024 }, focused: true, minimized: false, maximized: false, fullscreen: false, activeTab: 11, incognito: false, current: true }],
    layout: { left: 2, right: 2, leftWidth: 200, rightWidth: 330, stripHeight: 44, timeline: false, timelineHeight: 130 },
    omnibox: { securityLevel: 1, displayUrl: "shop.example/checkout", fullUrl: "https://shop.example/checkout", securityText: "", shouldDisplayUrl: true, focused: false, userInputInProgress: false, popupOpen: false, bounds: { x: 120, y: 52, width: 900, height: 32 }, popupBounds: null },
    owners: { agents: { 11: "Claude" }, colors: { 11: "#e9763f" } },
    replies: {},
  };
}

// Runs in the page (serialized with toString): F is the fixture, E the enums.
function install(F, E) {
  const fx = F;
  const calls = [];
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const observers = { tabs: [], windows: [], layout: [], omnibox: [], agent: [], bubbles: [] };
  const fire = (kind, method, ...args) => {
    const given = args.map(copy); // as the browser sent it at that moment
    for (const o of observers[kind].slice()) {
      if (typeof o[method] !== "function") continue;
      queueMicrotask(() => { if (observers[kind].includes(o)) o[method](...given); });
    }
  };
  const has = (name) => Object.prototype.hasOwnProperty.call(fx.replies || {}, name);

  // ---- tabs ----
  const byId = (id) => fx.tabs.find((t) => t.id === id) || null;
  const inWindow = (w) => fx.tabs.filter((t) => t.window === w).sort((a, b) => a.index - b.index);
  const sorted = () => fx.tabs.slice().sort((a, b) => a.window - b.window || a.index - b.index);
  // Renumbers a window's strip from `order` (or its current order); onMoved for each shifted tab.
  const reindex = (w, order = inWindow(w), skip = null) => {
    order.forEach((t, i) => { if (t.index !== i) { t.index = i; if (t.id !== skip) fire("tabs", "onMoved", t.id, i, w); } });
  };
  const winById = (id) => fx.windows.find((w) => w.id === id) || null;
  function activate(id) {
    const t = byId(id);
    if (!t) return;
    for (const o of inWindow(t.window)) { o.active = o.id === id; o.selected = o.active; }
    const w = winById(t.window);
    if (w) w.activeTab = id;
    fire("tabs", "onActivated", id, t.window);
  }
  function removeTab(id) {
    const t = byId(id);
    if (!t) return;
    fx.tabs = fx.tabs.filter((o) => o !== t);
    fire("tabs", "onRemoved", id);
    reindex(t.window);
    const left = inWindow(t.window);
    if (t.active && left.length) activate(left[Math.min(t.index, left.length - 1)].id);
    else if (t.active) { const w = winById(t.window); if (w) w.activeTab = -1; }
  }
  const newId = () => Math.max(0, ...fx.tabs.map((t) => t.id)) + 1;
  function addTab(given) {
    const id = Number.isInteger(given.id) ? given.id : newId();
    const w = Number.isInteger(given.window) && given.window !== -1 ? given.window : (fx.windows.find((x) => x.focused) || fx.windows[0] || { id: 1 }).id;
    const t = {
      index: inWindow(w).length, title: "New Tab", url: "chrome://pairbrowse/newtab", favicon: null, defaultFavicon: true,
      networkState: 0, muted: false, audible: false, pinned: false, group: null, groupTitle: null, groupColor: null,
      active: false, selected: false, blocked: false, width: 1280, height: 800, targetId: `T${id}`,
      canGoBack: false, canGoForward: false, capturing: false, ...given, id, window: w,
    };
    t.index = inWindow(w).length;
    t.active = false;
    t.selected = false;
    fx.tabs.push(t);
    fire("tabs", "onCreated", t);
    if (given.active) activate(id);
    return t;
  }
  function moveTab(id, index, window) {
    const t = byId(id);
    if (!t) return false;
    const from = t.window, to = window === -1 || window === undefined ? from : window;
    const target = inWindow(to).filter((o) => o !== t);
    const at = index < 0 || index > target.length ? target.length : index;
    target.splice(at, 0, t);
    t.window = to;
    if (from !== to) reindex(from);
    const was = t.index;
    reindex(to, target, id);
    if (t.index !== was || from !== to) fire("tabs", "onMoved", id, t.index, to);
    return true;
  }
  const changeTab = (id, partial) => {
    const t = byId(id);
    if (!t) return null;
    Object.assign(t, partial, { id });
    fire("tabs", "onChanged", t);
    return t;
  };
  let groups = 0;

  // ---- windows, layout, omnibox, agent ----
  const changeWindow = (id, partial, event = "onBoundsChanged") => {
    const w = winById(id);
    if (!w) return;
    Object.assign(w, partial, { id });
    if (event === "onFocusChanged") fire("windows", event, id);
    else fire("windows", event, w);
  };
  function focusWindow(id) {
    for (const w of fx.windows) w.focused = w.id === id;
    const w = winById(id);
    if (w) w.minimized = false;
    fire("windows", "onFocusChanged", w ? id : -1);
  }
  function removeWindow(id) {
    if (!winById(id)) return;
    for (const t of inWindow(id)) { fx.tabs = fx.tabs.filter((o) => o !== t); fire("tabs", "onRemoved", t.id); }
    fx.windows = fx.windows.filter((w) => w.id !== id);
    fire("windows", "onRemoved", id);
  }
  function setOwner(id, agent, color) {
    fx.owners.agents[String(id)] = agent;
    fx.owners.colors[String(id)] = color;
    fire("agent", "onOwnerChanged", id, agent, color);
  }
  function clearOwner(id) {
    delete fx.owners.agents[String(id)];
    delete fx.owners.colors[String(id)];
    fire("agent", "onOwnerChanged", id, null, null);
  }

  // Each method: recorded in calls, then applied; a Promise either way.
  const iface = (name, kind, methods) => {
    const api = {};
    for (const [method, fn] of Object.entries(methods)) {
      api[method] = (...args) => {
        calls.push({ iface: name, method, args: copy(args) });
        try { return Promise.resolve(fn(...args)); } catch (e) { return Promise.reject(e); }
      };
    }
    if (kind) {
      api.addObserver = (obj) => {
        calls.push({ iface: name, method: "addObserver", args: [Object.keys(obj || {})] });
        const o = obj && typeof obj === "object" ? obj : {};
        observers[kind].push(o);
        return () => { observers[kind] = observers[kind].filter((x) => x !== o); };
      };
    }
    return Object.freeze(api);
  };

  const tabs = iface("tabs", "tabs", {
    list: () => ({ tabs: copy(sorted()) }),
    get: (id) => ({ tab: copy(byId(id)) }),
    activate: (id) => { activate(id); },
    close: (id) => { removeTab(id); },
    create: (url, active, window) => ({ id: addTab({ url: url || "chrome://pairbrowse/newtab", title: url ? url : "New Tab", active: !!active, window }).id }),
    move: (id, index, window) => ({ ok: moveTab(id, index, window) }),
    pin: (id, on) => { changeTab(id, { pinned: !!on }); },
    mute: (id, on) => { changeTab(id, { muted: !!on }); },
    reload: (id) => {
      if (!changeTab(id, { networkState: E.NetworkState.kLoading })) return;
      queueMicrotask(() => changeTab(id, { networkState: E.NetworkState.kNone }));
    },
    duplicate: (id) => {
      const t = byId(id);
      if (!t) return { newId: -1 };
      const { id: _id, index: _i, targetId: _t, ...rest } = t;
      const d = addTab({ ...copy(rest), active: false });
      moveTab(d.id, t.index + 1, t.window);
      return { newId: d.id };
    },
    addToGroup: (id, group) => {
      const g = group || `g${++groups}`;
      const sibling = fx.tabs.find((o) => o.group === g && o.id !== id);
      changeTab(id, { group: g, groupTitle: sibling ? sibling.groupTitle : "", groupColor: sibling ? sibling.groupColor : null });
      return { group: g };
    },
    removeFromGroup: (id) => { changeTab(id, { group: null, groupTitle: null, groupColor: null }); },
    setGroupVisuals: (group, title, color) => { for (const t of fx.tabs.filter((o) => o.group === group)) changeTab(t.id, { groupTitle: title, groupColor: color }); },
    // The nav row (the mojom's GoBack, GoForward, Stop): recorded; the history is the fixture's.
    goBack: () => {},
    goForward: () => {},
    stop: () => {},
  });
  const windows = iface("windows", "windows", {
    list: () => ({ windows: copy(fx.windows) }),
    focus: (id) => { focusWindow(id); },
    minimize: (id) => { changeWindow(id, { minimized: true, focused: false }); },
    zoom: (id) => { const w = winById(id); if (w) changeWindow(id, { maximized: !w.maximized }); },
    close: (id) => { removeWindow(id); },
    setFullscreen: (id, on) => { changeWindow(id, { fullscreen: !!on }); },
    setDragRegions: () => {},
    startTabDrag: () => ({ moved: false }),
    // The nav row's star and the find bar (the mojom's Bookmark, Find): recorded.
    bookmark: () => {},
    find: () => {},
  });
  const layout = iface("layout", "layout", {
    get: () => ({ state: copy(fx.layout) }),
    set: (state) => { fx.layout = copy(state); fire("layout", "onLayout", fx.layout); },
  });
  const omnibox = iface("omnibox", "omnibox", {
    focus: () => { fx.omnibox.focused = true; fire("omnibox", "onState", fx.omnibox); },
    selectAll: () => {},
    getState: () => ({ state: copy(fx.omnibox) }),
  });
  const session = iface("session", null, {
    helper: () => ({ origin: fx.helper.origin, key: fx.helper.key }),
    grantTabCapture: (targetId) => ({ streamId: has("grantTabCapture") ? fx.replies.grantTabCapture : `stream-${targetId}` }),
  });
  const agent = iface("agent", "agent", {
    setTabOwner: (id, name, color) => { setOwner(id, name, color); },
    clear: (id) => { clearOwner(id); },
    getOwners: () => ({ agents: copy(fx.owners.agents), colors: copy(fx.owners.colors) }),
    notify: () => {},
    clearNotification: () => {},
  });
  const files = iface("files", null, {
    choose: () => ({ paths: has("choose") ? copy(fx.replies.choose) : [] }),
    saveAs: () => ({ path: has("saveAs") ? fx.replies.saveAs : null }),
  });
  // The approval bubble's host (530): recorded in calls, nothing else.
  const approval = iface("approval", null, {
    setPending: () => {},
  });

  // The cross-slot bubbles (530 E1), opt-in: the bubble the page opened (one at a time, as the
  // browser keeps one per window), shown unless the fixture's replies.open says false.
  let openBubble = null;
  const bubbles = iface("bubbles", "bubbles", {
    open: (kind) => {
      const shown = has("open") ? !!fx.replies.open : true;
      if (shown) {
        if (openBubble !== null && openBubble !== kind) fire("bubbles", "onClosed", openBubble, false);
        openBubble = kind;
      }
      return { shown };
    },
    close: (kind) => { if (openBubble === kind) { openBubble = null; fire("bubbles", "onClosed", kind, false); } },
  });

  window.pairbrowse = Object.freeze({
    tabs, windows, layout, omnibox, session, agent, files, approval, ...(fx.bubbles ? { bubbles } : {}),
    NetworkState: Object.freeze({ ...E.NetworkState }), SecurityLevel: Object.freeze({ ...E.SecurityLevel }), DockState: Object.freeze({ ...E.DockState }),
    BubbleKind: Object.freeze({ ...E.BubbleKind }),
  });

  // Test controls: each changes the fixture as the browser would and tells the observers.
  window.__pairbrowse = {
    get fixture() { return fx; },
    calls,
    tabs: {
      change: (partial) => changeTab(partial.id, partial) !== null,
      create: (t) => addTab(t || {}).id,
      remove: (id) => removeTab(id),
      move: (id, index, window = -1) => moveTab(id, index, window),
      activate: (id) => activate(id),
    },
    windows: {
      set: (w) => {
        if (winById(w.id)) return changeWindow(w.id, w);
        fx.windows.push({ bounds: { x: 0, y: 0, width: 1280, height: 800 }, focused: false, minimized: false, maximized: false, fullscreen: false, activeTab: -1, incognito: false, current: false, ...w });
        fire("windows", "onCreated", winById(w.id));
      },
      focus: (id) => focusWindow(id),
      remove: (id) => removeWindow(id),
    },
    layout: { set: (partial) => { fx.layout = { ...fx.layout, ...partial }; fire("layout", "onLayout", fx.layout); } },
    omnibox: { set: (partial) => { fx.omnibox = { ...fx.omnibox, ...partial }; fire("omnibox", "onState", fx.omnibox); } },
    agent: {
      setOwner: (id, name, color) => setOwner(id, name, color),
      clear: (id) => clearOwner(id),
      notificationAction: (id, button) => fire("agent", "onNotificationAction", id, button),
    },
    reply: (name, value) => { fx.replies = { ...(fx.replies || {}), [name]: value }; },
    // The browser closed the bubble (Escape: byEscape true; a click outside: false).
    bubbles: {
      get open() { return openBubble; },
      closed: (kind, byEscape = false) => { if (openBubble === kind) openBubble = null; fire("bubbles", "onClosed", kind, !!byEscape); },
    },
  };
}

// The page script: plain script, an IIFE over a copy of the fixture, no timers, no sinks.
export function shimScript(fixture = defaultFixture()) {
  return `// window.pairbrowse, the pages' harness shim (test/helpers/pairbrowse-shim.mjs)\n(${install.toString()})(${JSON.stringify(fixture)}, ${JSON.stringify(ENUMS)});\n`;
}

// Bridge period only (deleted with the extension): the chrome.storage and chrome.runtime the
// panel, picker and capture pages still read. session.get("view") is the helper's address; local
// is kept in the page's localStorage so it survives a reload.
export function bridgeChromeScript(base) {
  return `// chrome.* for the bridge period (test/helpers/pairbrowse-shim.mjs)
(() => {
  const load = () => { try { return JSON.parse(localStorage.getItem("__store") || "{}"); } catch { return {}; } };
  window.chrome = {
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => undefined },
    storage: {
      session: { get: async (k) => (k === "view" || k === undefined ? { view: ${JSON.stringify(base)} } : {}) },
      local: {
        get: async (k) => { const s = load(); return k in s ? { [k]: s[k] } : {}; },
        set: async (o) => { try { localStorage.setItem("__store", JSON.stringify({ ...load(), ...o })); } catch {} },
      },
      onChanged: { addListener() {} },
    },
  };
  window.__copied = null;
  try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied = t; } } }); } catch {}
})();
`;
}
