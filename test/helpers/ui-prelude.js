// The pages' harness prelude: the first script of every page the ui server serves (before the
// shim and the page's own). Patchright has no console API, so what the page says goes wrong is
// kept here, in window.__harness.log: console.error and console.warn, uncaught errors,
// unhandled rejections and CSP / Trusted Types violations. It also keeps the page's timers,
// frames, observers and event streams in live sets, emulates a hidden page
// (__harness.setHidden) and counts callbacks that run while hidden. It starts no timer itself.
(() => {
  const H = { log: [], hidden: false, hiddenFires: 0 };
  const text = (v) => {
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const record = (kind, value, extra = {}) => { H.log.push({ kind, text: String(value).slice(0, 500), ...extra }); };

  // ---- timers and frames ----
  const pending = { timeouts: new Set(), intervals: new Set(), frames: new Set() };
  const run = (fn, args) => { if (H.hidden) H.hiddenFires++; return fn(...args); };
  const native = {
    setTimeout: window.setTimeout.bind(window), setInterval: window.setInterval.bind(window),
    clearTimeout: window.clearTimeout.bind(window), clearInterval: window.clearInterval.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };
  window.setTimeout = function setTimeout(fn, ms, ...args) {
    if (typeof fn !== "function") return native.setTimeout(fn, ms, ...args);
    const id = native.setTimeout(() => { pending.timeouts.delete(id); run(fn, args); }, ms);
    pending.timeouts.add(id);
    return id;
  };
  window.setInterval = function setInterval(fn, ms, ...args) {
    if (typeof fn !== "function") return native.setInterval(fn, ms, ...args);
    const id = native.setInterval(() => run(fn, args), ms);
    pending.intervals.add(id);
    return id;
  };
  // The two clears share one list of ids, as in the HTML spec.
  const clear = (id) => { pending.timeouts.delete(id); pending.intervals.delete(id); };
  window.clearTimeout = function clearTimeout(id) { clear(id); return native.clearTimeout(id); };
  window.clearInterval = function clearInterval(id) { clear(id); return native.clearInterval(id); };
  window.requestAnimationFrame = function requestAnimationFrame(fn) {
    const id = native.requestAnimationFrame((t) => { pending.frames.delete(id); run(fn, [t]); });
    pending.frames.add(id);
    return id;
  };
  window.cancelAnimationFrame = function cancelAnimationFrame(id) { pending.frames.delete(id); return native.cancelAnimationFrame(id); };

  // ---- observers and event streams ----
  const observers = new Set();
  for (const name of ["MutationObserver", "ResizeObserver", "IntersectionObserver", "PerformanceObserver"]) {
    const Base = window[name];
    if (typeof Base !== "function") continue;
    const Wrapped = class extends Base {
      observe(...args) { observers.add(this); return super.observe(...args); }
      disconnect() { observers.delete(this); return super.disconnect(); }
    };
    Object.defineProperty(Wrapped, "name", { value: name });
    window[name] = Wrapped;
  }
  const sources = new Set();
  if (typeof window.EventSource === "function") {
    const Base = window.EventSource;
    const Wrapped = class extends Base {
      constructor(...args) { super(...args); sources.add(this); }
      close() { sources.delete(this); return super.close(); }
    };
    Object.defineProperty(Wrapped, "name", { value: "EventSource" });
    window.EventSource = Wrapped;
  }

  // ---- what goes wrong ----
  for (const kind of ["error", "warn"]) {
    const original = console[kind];
    console[kind] = function (...args) { record(kind, args.map(text).join(" ")); return original.apply(console, args); };
  }
  window.addEventListener("error", (e) => record("pageerror", e.error ? text(e.error) : e.message));
  window.addEventListener("unhandledrejection", (e) => record("rejection", text(e.reason)));
  document.addEventListener("securitypolicyviolation", (e) => {
    record("csp", `${e.violatedDirective} ${e.blockedURI} ${e.sample || ""}`.trim(), { violatedDirective: e.violatedDirective, blockedURI: e.blockedURI, sample: e.sample });
  });

  // ---- a hidden page ----
  let defined = false;
  H.setHidden = (on) => {
    if (!defined) {
      defined = true;
      Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => H.hidden });
      Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => (H.hidden ? "hidden" : "visible") });
    }
    H.hidden = !!on;
    document.dispatchEvent(new Event("visibilitychange"));
  };

  H.live = () => ({ timeouts: pending.timeouts.size, intervals: pending.intervals.size, frames: pending.frames.size, observers: observers.size, eventSources: sources.size });
  H.animations = () => document.getAnimations().filter((a) => a.playState === "running").map((a) => ({
    name: a.animationName || a.transitionProperty || a.constructor.name,
    target: a.effect && a.effect.target ? `${a.effect.target.tagName.toLowerCase()}${a.effect.target.id ? `#${a.effect.target.id}` : ""}${a.effect.target.className && typeof a.effect.target.className === "string" ? `.${a.effect.target.className.split(" ").join(".")}` : ""}` : "",
  }));
  window.__harness = H;
})();
