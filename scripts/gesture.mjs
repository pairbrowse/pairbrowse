// The helper's reads of a page never count as the person's click. The driver runs every evaluate
// (the helper's page reads, snapshots, locator reads, the HUD's calls) through the browser's
// Runtime.callFunctionOn with userGesture: true, which gives the page user activation: a page that
// only waits for activation could then open a popup or start what browsers keep for a person's
// click, after an agent merely read it. Here that flag is turned off for every such call. Real
// input (clicks, key presses, typing: Input.* events) activates the page as before.
const PATCHED = Symbol.for("pairbrowse.noReadGesture");

// A call's parameters as they go to the browser: a function call without the user gesture.
export function readParams(method, params) {
  if (method !== "Runtime.callFunctionOn" || !params || params.userGesture !== true) return params;
  return { ...params, userGesture: false };
}

// A session class's send, wrapped once (proto: the prototype of the driver's CDP session).
// Returns whether it is wrapped now (by this call or an earlier one).
export function patchSend(proto) {
  if (!proto || typeof proto.send !== "function") return false;
  if (proto[PATCHED]) return true;
  const send = proto.send;
  proto.send = function (method, params, ...rest) { return send.call(this, method, readParams(method, params), ...rest); };
  Object.defineProperty(proto, PATCHED, { value: true });
  return true;
}

// core: the driver's core bundle (patchright-core or playwright-core lib/coreBundle). Its CDP
// session class isn't exported, so it is taken from the first page the driver makes (its keyboard
// talks through that session), before the page shows anything. Returns whether it could hook into
// the page class at all; whether the session was found shows with the first page: hooked() says
// so from then on, and onMiss() is called once when that page's session couldn't be found (the
// driver's internals changed: its reads keep their gesture, and the helper logs that).
let state = { tried: false, hooked: false };
export const hooked = () => state.hooked;
export function installNoReadGesture(core, { onMiss = () => {} } = {}) {
  const P = core?.server?.Page?.prototype;
  if (!P) return false;
  if (P[PATCHED]) return true;
  state = { tried: false, hooked: false };
  const hook = (page) => {
    if (state.hooked) return;
    let ok = false;
    try {
      const client = page?.delegate?.rawKeyboard?._client || page?.delegate?._mainFrameSession?._client;
      ok = !!client && patchSend(Object.getPrototypeOf(client));
    } catch {}
    if (ok) state.hooked = true;
    else if (!state.tried) { state.tried = true; try { onMiss(); } catch {} }
  };
  for (const name of ["mainFrame", "reportAsNew"]) {
    const orig = P[name];
    if (typeof orig !== "function") continue;
    P[name] = function (...args) { hook(this); return orig.apply(this, args); };
  }
  Object.defineProperty(P, PATCHED, { value: true });
  return true;
}
