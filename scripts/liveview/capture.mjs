// The capture page's channel (a PairBrowse build that declares one; native-engine capturePages):
// the helper asks the browser's own capture page for a tab's picture and sound (share) or a
// recording (record) with a `capture` event on the owner streams of the browser's own pages, and
// the page answers on POST capture/reply. Nothing reaches a viewer, a guest or the live view page
// (liveview.mjs sends the event only to `?page=` streams), and nothing here starts a capture: the
// page does, only once it has said hello.
//
// call(to, arg, ms): sends { n, to, ...arg } and resolves with the page's value, or rejects with
// its error, or "the capture page didn't answer" after ms. reply(body): the page's answer
// ({ n, value } or { n, error }) or its hello ({ hello: true, caps: { share, record } }); false
// for a body that isn't one. ready(): a hello came since the browser started. whenReady(ms):
// resolves true at the hello (at once if it came), false after ms or when the browser closes
// (at most CAPTURE_WAITING_MAX wait; one more resolves false at once). reset(): the browser
// closed: every waiting call is rejected, every hello wait ends false and the hello is forgotten.
export const CAPTURE_WAITING_MAX = 64;
// The channel's limits are the capture page's too: ui/limits.js holds them for both sides.
import { CAPTURE_ERROR_MAX, CAPTURE_SDP_MAX, CAPTURE_VALUE_MAX } from "../../ui/limits.js";
export { CAPTURE_ERROR_MAX, CAPTURE_SDP_MAX, CAPTURE_VALUE_MAX };
const TARGETS = new Set(["share", "record"]);

export function createCaptureChannel({ send, log = () => {} }) {
  const waiting = new Map(); // n -> { resolve, reject, timer }
  let seq = 0;
  let hello = null; // { share, record } once the page said hello
  const helloWaits = new Set(); // { resolve, timer }: whenReady() calls waiting for the hello
  const endWaits = (value) => { for (const w of helloWaits) { clearTimeout(w.timer); w.resolve(value); } helloWaits.clear(); };

  function whenReady(ms = 3000) {
    if (hello) return Promise.resolve(true);
    if (helloWaits.size >= CAPTURE_WAITING_MAX) return Promise.resolve(false);
    return new Promise((resolve) => {
      const w = { resolve };
      w.timer = setTimeout(() => { helloWaits.delete(w); resolve(false); }, Math.max(0, ms));
      helloWaits.add(w);
    });
  }

  function call(to, arg = {}, ms = 8000) {
    if (!TARGETS.has(to)) return Promise.reject(new Error(`no capture call "${to}"`));
    if (waiting.size >= CAPTURE_WAITING_MAX) return Promise.reject(new Error("too many capture calls waiting"));
    const n = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(n); reject(new Error("the capture page didn't answer")); }, ms);
      waiting.set(n, { resolve, reject, timer });
      try { send({ ...(arg && typeof arg === "object" ? arg : {}), n, to }); } catch (e) { clearTimeout(timer); waiting.delete(n); reject(e); }
    });
  }

  // A size the answer may have: an SDP up to CAPTURE_SDP_MAX, a recording's piece (base64 of
  // 1 MB) up to CAPTURE_VALUE_MAX in all.
  const fits = (v) => {
    if (v === undefined || v === null) return true;
    if (typeof v === "string") return v.length <= CAPTURE_VALUE_MAX;
    if (typeof v === "object" && "sdp" in v && (typeof v.sdp !== "string" || v.sdp.length > CAPTURE_SDP_MAX)) return false;
    try { return JSON.stringify(v).length <= CAPTURE_VALUE_MAX; } catch { return false; }
  };

  function reply(body) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return false;
    if (body.hello === true) {
      const caps = body.caps && typeof body.caps === "object" ? body.caps : {};
      hello = { share: caps.share === true, record: caps.record === true };
      log(`capture page: ready (share ${hello.share}, record ${hello.record})`);
      endWaits(true);
      return true;
    }
    const n = body.n;
    if (!Number.isSafeInteger(n) || n <= 0) return false;
    if ("error" in body && (typeof body.error !== "string" || body.error.length > CAPTURE_ERROR_MAX)) return false;
    if (!fits(body.value)) return false;
    const w = waiting.get(n);
    if (!w) return true; // late or unknown: dropped
    waiting.delete(n);
    clearTimeout(w.timer);
    if (typeof body.error === "string") w.reject(new Error(body.error));
    else w.resolve(body.value);
    return true;
  }

  function reset() {
    hello = null;
    endWaits(false);
    for (const [n, w] of waiting) { clearTimeout(w.timer); w.reject(new Error("the browser closed")); waiting.delete(n); }
  }

  return { call, reply, reset, whenReady, ready: () => !!hello, caps: () => (hello ? { ...hello } : null), waiting: () => waiting.size };
}
