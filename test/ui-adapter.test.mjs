// window.pairbrowse in the PairBrowse browser (ui/pairbrowse-adapter.js): the page contract of the
// harness shim (test/helpers/pairbrowse-shim.mjs) over a fake of the compiled mojom bindings, in
// the generated code's shape (FooRemote with its methods on the prototype, Foo.getRemote(),
// FooObserverReceiver over an impl, receiver.$.bindNewPipeAndPassRemote() and .close(), TS
// enums with reverse names and MIN_VALUE / MAX_VALUE, map replies as a Map). Also which pages are
// the browser's own (common.js servedByBrowser) and how ui/pairbrowse-api.js installs it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { adapt, plain } from "../ui/pairbrowse-adapter.js";
import { servedByBrowser } from "../ui/common.js";

const TOP = { protocol: "chrome:", host: "pairbrowse.top-chrome" };
const TAB = { protocol: "chrome:", host: "pairbrowse" };

function tsEnum(names) {
  const e = { MIN_VALUE: 0, MAX_VALUE: names.length - 1 };
  names.forEach((n, i) => { e[n] = i; e[i] = n; });
  return e;
}

// The fake bindings: what each remote was asked, how many remotes were made, the receivers bound.
function fakeBindings({ owners = new Map([[11, "Claude"]]), throwOn = null, approval = true, bubbles = true, pointers = true } = {}) {
  const log = { calls: [], remotes: {}, receivers: [] };
  const mod = {
    NetworkState: tsEnum(["kNone", "kWaiting", "kLoading", "kError"]),
    SecurityLevel: tsEnum(["kNone", "kSecure", "kWarning", "kDangerous"]),
    DockState: tsEnum(["kHidden", "kRail", "kOpen"]),
    ...(bubbles ? { BubbleKind: tsEnum(["kSwitcher", "kShare", "kPicture"]) } : {}),
  };
  const remote = (name, methods) => {
    class Remote {}
    for (const [method, reply] of Object.entries(methods)) {
      Remote.prototype[method] = function (...args) {
        log.calls.push([name, method, args]);
        if (throwOn === method) throw new Error("encode failed");
        return typeof reply === "function" ? reply(...args) : undefined;
      };
    }
    mod[`${name}Remote`] = Remote;
    mod[name] = { getRemote: () => { log.remotes[name] = (log.remotes[name] || 0) + 1; return new Remote(); } };
  };
  const observer = (name) => {
    mod[`${name}Receiver`] = class {
      constructor(impl) {
        this.impl = impl;
        this.closed = false;
        this.$ = { bindNewPipeAndPassRemote: () => ({ remoteOf: name, receiver: this }), close: () => { this.closed = true; } };
        log.receivers.push(this);
      }
    };
  };
  const addObserver = (o) => { log.calls.push(["observer", o.remoteOf]); };
  remote("Tabs", { list: () => Promise.resolve({ tabs: [{ id: 11, window: 1, canGoBack: true }] }), activate: null, create: () => Promise.resolve({ id: 12 }), goBack: null, addObserver });
  remote("Windows", { list: () => Promise.resolve({ windows: [{ id: 1, current: true, bounds: { x: 0, y: 0, width: 10, height: 10 } }] }), find: null, addObserver });
  remote("Layout", { get: () => Promise.resolve({ state: { left: 2 } }), set: null, addObserver });
  remote("Omnibox", { getState: () => Promise.resolve({ state: {} }), addObserver });
  remote("Session", { helper: () => Promise.resolve({ origin: "http://127.0.0.1:9", key: "k" }), grantTabCapture: () => Promise.resolve({ streamId: null }) });
  remote("Agent", { getOwners: () => Promise.resolve({ agents: owners, colors: new Map([[11, "#e9763f"]]) }), addObserver });
  remote("Files", { choose: () => Promise.resolve({ paths: [] }) });
  if (approval) remote("ApprovalHost", { setPending: null });
  if (bubbles) remote("Bubbles", { open: () => Promise.resolve({ shown: true }), close: null, addObserver });
  if (pointers) remote("Pointers", { show: null });
  for (const name of ["TabsObserver", "WindowsObserver", "LayoutObserver", "OmniboxObserver", "AgentObserver", ...(bubbles ? ["BubblesObserver"] : [])]) observer(name);
  return { mod, log };
}

const scope = (location, more = {}) => ({ location, Mojo: {}, ...more });

test("servedByBrowser: only the browser's own two hosts", () => {
  assert.equal(servedByBrowser(TOP), true);
  assert.equal(servedByBrowser(TAB), true);
  assert.equal(servedByBrowser({ protocol: "chrome:", host: "settings" }), false);
  assert.equal(servedByBrowser({ protocol: "http:", host: "pairbrowse.top-chrome" }), false);
  assert.equal(servedByBrowser({ protocol: "chrome-extension:", host: "abc" }), false);
  assert.equal(servedByBrowser(undefined), false);
});

test("no API off the browser's hosts or without bindings", () => {
  const { mod } = fakeBindings();
  assert.equal(adapt(mod, scope({ protocol: "http:", host: "127.0.0.1:1" })), null);
  assert.equal(adapt(mod, scope({ protocol: "chrome:", host: "settings" })), null);
  assert.equal(adapt(mod, { location: TOP }), null, "no Mojo: a frame the browser gave no bindings");
  assert.equal(adapt(null, scope(TOP)), null);
});

test("a slot page: every interface, the contract's shape, remotes made on first use", async () => {
  const { mod, log } = fakeBindings();
  const pb = adapt(mod, scope(TOP));
  assert.deepEqual(Object.keys(pb).sort(), ["BubbleKind", "DockState", "NetworkState", "SecurityLevel", "agent", "approval", "bubbles", "files", "layout", "omnibox", "pointers", "session", "tabs", "windows"]);
  assert.ok(Object.isFrozen(pb) && Object.isFrozen(pb.tabs));
  assert.deepEqual(pb.DockState, { kHidden: 0, kRail: 1, kOpen: 2 }, "the names only");
  assert.deepEqual(log.remotes, {}, "nothing asked of the browser yet");
  assert.deepEqual(await pb.tabs.list(), { tabs: [{ id: 11, window: 1, canGoBack: true }] });
  assert.equal(await pb.tabs.activate(11), undefined, "a call without a reply resolves to undefined");
  assert.equal(await pb.tabs.goBack(11), undefined);
  assert.deepEqual(await pb.session.helper(), { origin: "http://127.0.0.1:9", key: "k" });
  assert.deepEqual(log.remotes, { Tabs: 1, Session: 1 }, "one remote per interface, only those used");
  const owners = await pb.agent.getOwners();
  assert.deepEqual(owners, { agents: { 11: "Claude" }, colors: { 11: "#e9763f" } });
  assert.equal(Object.getPrototypeOf(owners.agents), Object.prototype, "a map arrives as a plain object");
  assert.equal(typeof pb.windows.find, "function");
  assert.equal(pb.tabs.addObserver.length, 1);
});

test("a call that throws while sending rejects, never throws", async () => {
  const { mod } = fakeBindings({ throwOn: "set" });
  const pb = adapt(mod, scope(TOP));
  let thrown = false;
  let result = null;
  try { result = pb.layout.set({ left: 2 }); } catch { thrown = true; }
  assert.equal(thrown, false);
  await assert.rejects(result, /encode failed/);
});

test("observers: one receiver each, plain arguments, remove() closes it, a throwing observer is reported", async () => {
  const { mod, log } = fakeBindings();
  const reported = [];
  const pb = adapt(mod, scope(TOP, { reportError: (e) => reported.push(e.message) }));
  const seen = [];
  const remove = pb.agent.addObserver({ onOwnerChanged: (id, agent, color) => seen.push([id, agent, color]) });
  assert.deepEqual(log.calls.at(-1), ["observer", "AgentObserver"]);
  const receiver = log.receivers.at(-1);
  receiver.impl.onOwnerChanged(11, "Claude", "#e9763f");
  assert.deepEqual(seen, [[11, "Claude", "#e9763f"]]);
  remove();
  remove();
  assert.equal(receiver.closed, true);
  // Methods the page left out are no-ops; a throwing one is reported, not thrown into the bindings.
  pb.tabs.addObserver({ onActivated: () => { throw new Error("page bug"); } });
  const tabs = log.receivers.at(-1);
  assert.doesNotThrow(() => tabs.impl.onCreated({ id: 1 }));
  assert.doesNotThrow(() => tabs.impl.onActivated(1, 1));
  assert.deepEqual(reported, ["page bug"]);
  // Arguments arrive as plain data (a nested Map too).
  const got = [];
  pb.layout.addObserver({ onLayout: (s) => got.push(s) });
  log.receivers.at(-1).impl.onLayout({ left: 2, extra: new Map([[1, "x"]]) });
  assert.deepEqual(got, [{ left: 2, extra: { 1: "x" } }]);
  assert.deepEqual(log.remotes, { Agent: 1, Tabs: 1, Layout: 1 });
});

test("a tab page: Session only; the rest refuse without asking the browser", async () => {
  const { mod, log } = fakeBindings();
  const pb = adapt(mod, scope(TAB));
  assert.deepEqual(await pb.session.helper(), { origin: "http://127.0.0.1:9", key: "k" });
  await assert.rejects(pb.tabs.create("chrome://settings", true), /not available on this page/);
  await assert.rejects(pb.layout.get(), /not available on this page/);
  const remove = pb.tabs.addObserver({ onCreated: () => {} });
  assert.equal(typeof remove, "function");
  remove();
  assert.deepEqual(log.remotes, { Session: 1 }, "no other interface is asked for (it would end the renderer)");
  assert.deepEqual(log.receivers, []);
});

test("the approval bubble's host (530): on the top-chrome host only, absent from a build without it", async () => {
  const top = fakeBindings();
  const pb = adapt(top.mod, scope(TOP));
  assert.equal(typeof pb.approval.setPending, "function");
  assert.equal(await pb.approval.setPending(1, "T11"), undefined);
  assert.deepEqual(top.log.calls.at(-1), ["ApprovalHost", "setPending", [1, "T11"]]);
  assert.deepEqual(top.log.remotes, { ApprovalHost: 1 });

  const tab = fakeBindings();
  const onTab = adapt(tab.mod, scope(TAB));
  await assert.rejects(onTab.approval.setPending(1, ""), /not available on this page/);
  assert.deepEqual(tab.log.remotes, {}, "the tab host never asks the browser for it");
  assert.deepEqual(tab.log.calls, []);

  // A build without 530 compiles no ApprovalHost: nothing to call, so the page's feature check fails.
  const old = fakeBindings({ approval: false });
  const before = adapt(old.mod, scope(TOP));
  assert.equal(typeof before.approval?.setPending, "undefined");
  assert.deepEqual(Object.keys(before.approval), []);
});

test("the cross-slot bubbles (530 E1): on the top-chrome host only, absent from a build without them", async () => {
  const top = fakeBindings();
  const pb = adapt(top.mod, scope(TOP));
  assert.deepEqual(pb.BubbleKind, { kSwitcher: 0, kShare: 1, kPicture: 2 });
  assert.equal(typeof pb.bubbles.open, "function");
  const anchor = { x: 92, y: 10, width: 140, height: 33 };
  assert.deepEqual(await pb.bubbles.open(pb.BubbleKind.kSwitcher, anchor, ""), { shown: true });
  assert.deepEqual(top.log.calls.at(-1), ["Bubbles", "open", [0, anchor, ""]]);
  const closed = [];
  const remove = pb.bubbles.addObserver({ onClosed: (kind, byEscape) => closed.push([kind, byEscape]) });
  assert.deepEqual(top.log.calls.at(-1), ["observer", "BubblesObserver"]);
  top.log.receivers.at(-1).impl.onClosed(1, true);
  assert.deepEqual(closed, [[1, true]]);
  remove();
  assert.equal(top.log.receivers.at(-1).closed, true);

  const tab = fakeBindings();
  const onTab = adapt(tab.mod, scope(TAB));
  await assert.rejects(onTab.bubbles.open(0, anchor, ""), /not available on this page/);
  assert.deepEqual(tab.log.remotes, {});

  // A build without them compiles no Bubbles: the pages' feature check fails and they keep the
  // in-dock fallback.
  const old = adapt(fakeBindings({ bubbles: false }).mod, scope(TOP));
  assert.equal(typeof old.bubbles?.open, "undefined");
  assert.deepEqual(old.BubbleKind, {});
});

test("other people's pointers (530 F1): on the top-chrome host only, absent from a build without them", async () => {
  const top = fakeBindings();
  const pb = adapt(top.mod, scope(TOP));
  assert.equal(typeof pb.pointers.show, "function");
  const tabs = [{ targetId: "0123456789ABCDEF0123456789ABCDEF", pointers: [{ key: "i1:a:me", name: "Alice", color: "#f472b6", x: 0.25, y: 0.5, freshMs: 2900 }] }];
  assert.equal(await pb.pointers.show(tabs), undefined);
  assert.deepEqual(top.log.calls.at(-1), ["Pointers", "show", [tabs]]);
  const tab = fakeBindings();
  await assert.rejects(adapt(tab.mod, scope(TAB)).pointers.show([]), /not available on this page/);
  assert.deepEqual(tab.log.remotes, {});
  // A build without them compiles no Pointers: the strip never calls it.
  assert.equal(typeof adapt(fakeBindings({ pointers: false }).mod, scope(TOP)).pointers?.show, "undefined");
});

test("plain(): maps, arrays and objects all the way down", () => {
  assert.deepEqual(plain(new Map([[1, new Map([[2, [new Map([[3, "x"]])]]])]])), { 1: { 2: [{ 3: "x" }] } });
  assert.equal(plain(null), null);
  assert.equal(plain(5), 5);
});

test("pairbrowse-api.js: the bindings beside it, defined once and read-only", () => {
  const source = readFileSync(new URL("../ui/pairbrowse-api.js", import.meta.url), "utf8");
  assert.match(source, /^import \* as bindings from "\.\/pairbrowse\.mojom-webui\.js";$/m);
  assert.match(source, /^import \{ adapt \} from "\.\/pairbrowse-adapter\.js";$/m);
  assert.match(source, /Object\.defineProperty\(globalThis, "pairbrowse", \{ value: api, enumerable: true \}\)/);
  // The extension never loads it: no page names it (the native build inserts it at pack time).
  for (const page of ["strip", "left", "right", "timeline", "newtab", "picker", "approve", "settings", "screen", "capture"]) {
    const html = readFileSync(new URL(`../ui/${page}/index.html`, import.meta.url), "utf8");
    assert.doesNotMatch(html, /pairbrowse-api\.js/, page);
  }
});
