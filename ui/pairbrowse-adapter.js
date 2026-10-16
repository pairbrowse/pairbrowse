// window.pairbrowse in the PairBrowse browser: the page contract of test/helpers/pairbrowse-shim.mjs
// (DESIGN.md B13) over the browser's own mojom bindings (pairbrowse.mojom-webui.js, compiled and
// served from the page's own host by the native build). Pure: adapt() takes the bindings module
// and the page's global object and returns the API, or null where the browser offers none.
//
// - The window's slot pages (chrome://pairbrowse.top-chrome/) get every interface; the tab pages
//   (chrome://pairbrowse/, shown as pairbrowse://) get Session only. Asking the browser for an
//   interface a host does not bind would end the page's renderer, so the others are present but
//   refuse (their promises reject, addObserver does nothing).
// - A remote is made on the first call to its interface: a page that never asks for Files or the
//   omnibox makes the browser build nothing for them.
// - Every method returns a Promise; replies arrive as plain objects (a mojom map becomes an object
//   keyed by the decimal id); enums are the plain { kName: n } objects.
// - x.addObserver(obj) binds one receiver for obj and returns remove(), which closes it. Observer
//   calls arrive from the browser asynchronously; a page's observer that throws is reported, not
//   rethrown into the bindings.
// Nothing here starts a timer, a poll or a DOM observer.

import { TOP_SHELL_HOST, TAB_HOST } from "./urls.js";

// The interfaces: the page's name, the mojom interface, its observer interface and the observer's
// methods (lowerCamel, in mojom order).
const INTERFACES = [
  ["tabs", "Tabs", "TabsObserver", ["onCreated", "onChanged", "onRemoved", "onMoved", "onActivated"]],
  ["windows", "Windows", "WindowsObserver", ["onFocusChanged", "onBoundsChanged", "onCreated", "onRemoved"]],
  ["layout", "Layout", "LayoutObserver", ["onLayout"]],
  ["omnibox", "Omnibox", "OmniboxObserver", ["onState"]],
  ["session", "Session", null, []],
  ["agent", "Agent", "AgentObserver", ["onOwnerChanged"]],
  ["files", "Files", null, []],
  // The click-approval bubble (530): the browser binds it only for its approval page, so only the
  // approve page in bubble mode calls it, after checking setPending is a function (a build without
  // 530 compiles no ApprovalHost: no methods here).
  ["approval", "ApprovalHost", null, []],
  // Bubbles for cross-slot popovers (530 E1): the strip's switcher and Share card and the
  // timeline's picture in a bubble anchored to the control that opened it. The browser binds it
  // for the strip and the timeline only; a page checks bubbles.open is a function first (a build
  // without it compiles no Bubbles: no methods here, and the page keeps its in-dock fallback).
  ["bubbles", "Bubbles", "BubblesObserver", ["onClosed"]],
  // Other people's pointers over the page card (530 F1): bound for the strip's page only; the
  // strip checks pointers.show is a function first (a build without it: no methods here).
  ["pointers", "Pointers", null, []],
];
const TAB_PAGE_INTERFACES = new Set(["session"]);
const ENUMS = ["NetworkState", "SecurityLevel", "DockState", "BubbleKind"];

// A reply or an observer argument as the page contract has it: plain objects and arrays all the
// way down, a Map as an object keyed by the decimal id.
export function plain(value) {
  if (value instanceof Map) {
    const out = {};
    for (const [key, item] of value) out[String(key)] = plain(item);
    return out;
  }
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = plain(value[key]);
    return out;
  }
  return value;
}

// The enum's own names only (the compiled TS enum also maps numbers back to names and carries
// MIN_VALUE / MAX_VALUE).
const enumObject = (source) => Object.freeze(Object.fromEntries(
  Object.entries(source || {}).filter(([name, n]) => /^k[A-Z]/.test(name) && typeof n === "number")));

// The methods a remote class sends: everything on its prototype but the constructor and the
// observer hook, which the adapter wraps itself.
function methodNames(Remote) {
  const proto = Remote?.prototype;
  if (!proto) return [];
  return Object.getOwnPropertyNames(proto).filter((name) => name !== "constructor" && name !== "addObserver" && typeof proto[name] === "function");
}

function refused(name) {
  return () => Promise.reject(new Error(`pairbrowse.${name} is not available on this page`));
}

function makeInterface(bindings, scope, [name, mojom, observer, observerMethods], allowed) {
  const api = {};
  const Remote = bindings[`${mojom}Remote`];
  const names = methodNames(Remote);
  if (!allowed) {
    for (const method of names) api[method] = refused(`${name}.${method}`);
    if (observer) api.addObserver = () => () => {};
    return Object.freeze(api);
  }
  let remote = null;
  const get = () => (remote ||= bindings[mojom].getRemote());
  for (const method of names) {
    api[method] = (...args) => {
      try {
        return Promise.resolve(get()[method](...args)).then(plain);
      } catch (e) {
        return Promise.reject(e);
      }
    };
  }
  if (observer) {
    const Receiver = bindings[`${observer}Receiver`];
    api.addObserver = (obj) => {
      const target = obj && typeof obj === "object" ? obj : {};
      const impl = {};
      for (const method of observerMethods) {
        impl[method] = (...args) => {
          const fn = target[method];
          if (typeof fn !== "function") return;
          try {
            fn.apply(target, args.map(plain));
          } catch (e) {
            if (typeof scope.reportError === "function") scope.reportError(e);
          }
        };
      }
      const receiver = new Receiver(impl);
      get().addObserver(receiver.$.bindNewPipeAndPassRemote());
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        receiver.$.close();
      };
    };
  }
  return Object.freeze(api);
}

// The API for the page whose global object is `scope`, or null: not one of PairBrowse's own hosts,
// or a page the browser gave no bindings (no Mojo).
export function adapt(bindings, scope) {
  const host = scope?.location?.protocol === "chrome:" ? scope.location.host : "";
  if (host !== TOP_SHELL_HOST && host !== TAB_HOST) return null;
  if (typeof scope.Mojo === "undefined" || !bindings) return null;
  const allowed = (name) => host === TOP_SHELL_HOST || TAB_PAGE_INTERFACES.has(name);
  const api = {};
  for (const spec of INTERFACES) api[spec[0]] = makeInterface(bindings, scope, spec, allowed(spec[0]));
  for (const name of ENUMS) api[name] = enumObject(bindings[name]);
  return Object.freeze(api);
}
