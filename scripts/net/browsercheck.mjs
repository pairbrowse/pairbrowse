// The browser's side of a session's egress check (spec server-mode C6 (2), (3)): in an internal
// about:blank tab of the just-started browser, before any saved tab loads, (2) the check address
// read with the DevTools protocol's Network.loadNetworkResource, which loads it as the tab's own
// network context does (through the session's proxy and its strict switches), and (3) a WebRTC
// gathering against a STUN server, whose candidates show whether a page could learn an address
// other than the proxy's exit. net/verdict.mjs judges both. Every await on the browser is bounded
// (within); a step that doesn't answer in time is a failure, never a pass. The tab is closed after,
// whatever happened. Nothing here logs, and no answer leaves the helper but its ip and loc.
//
// Node's standard library only.
import { within } from "../util.mjs";
import { CHECK_MS, STUN_URL, BODY_MAX, parseTrace } from "./probe.mjs";

// How long the WebRTC gathering may take, and the most candidates kept.
export const GATHER_MS = 5000;
const MAX_CANDIDATES = 64;
const CLOSE_MS = 2000;

class CheckError extends Error {
  constructor(problem, timedOut = false) { super(problem); this.timedOut = timedOut; }
}

// The page's WebRTC gathering (runs in the tab): the candidate lines, and whether it completed.
function gatherInPage({ stun, ms, max }) {
  return new Promise((resolve) => {
    const lines = [];
    let pc;
    const done = (complete, problem = "") => {
      try { pc?.close(); } catch { /* closing a closed connection */ }
      resolve({ complete, candidates: lines.slice(0, max), problem });
    };
    const timer = setTimeout(() => done(false), ms);
    try {
      pc = new RTCPeerConnection({ iceServers: [{ urls: stun }] });
      pc.onicecandidate = (e) => {
        if (e.candidate) { if (e.candidate.candidate) lines.push(e.candidate.candidate); return; }
        clearTimeout(timer);
        done(true);
      };
      pc.createDataChannel("pairbrowse-check");
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch((e) => { clearTimeout(timer); done(false, String(e?.name || "error")); });
    } catch (e) {
      clearTimeout(timer);
      done(false, String(e?.name || "RTCPeerConnection unavailable"));
    }
  });
}

// checkInBrowser(context, { checkUrl, stun, timeoutMs, gatherMs }): context the browser's (a
// Playwright BrowserContext). { browser, webrtc }: browser { ok: true, ip, loc } or { ok: false,
// step, problem, timedOut } (the shape of net/probe.mjs probeEgress's answer); webrtc { ok: true,
// candidates: [lines] } or { ok: false, problem, timedOut }. Never throws.
export async function checkInBrowser(context, { checkUrl, stun = STUN_URL, timeoutMs = CHECK_MS, gatherMs = GATHER_MS } = {}) {
  const failed = (e, step) => ({ ok: false, step, problem: e instanceof CheckError ? e.message : `failed (${e?.name || "error"})`, timedOut: !!e?.timedOut });
  let page = null, cdp = null;
  const result = { browser: null, webrtc: null };
  let step = "tab";
  // A browser call within ms; a late answer of newPage is closed when it comes.
  const bounded = async (name, promise, ms = timeoutMs) => {
    step = name;
    const r = await within(ms, Promise.resolve(promise).then((value) => ({ value }), (error) => ({ error })));
    if (r === null) throw new CheckError(`timed out (${name}, ${ms} ms)`, true);
    if (r.error) throw r.error;
    return r.value;
  };
  try {
    const opening = Promise.resolve().then(() => context.newPage());
    page = await bounded("tab", opening).catch((e) => {
      opening.then((p) => within(CLOSE_MS, p.close()).catch(() => {}), () => {});
      throw e;
    });
    cdp = await bounded("devtools", context.newCDPSession(page));
  } catch (e) {
    const f = failed(e, step);
    result.browser = f;
    result.webrtc = { ok: false, problem: `the check tab ${f.problem}`, timedOut: f.timedOut };
    await close(page, cdp);
    return result;
  }

  // (2) The check address as the tab loads it.
  const started = Date.now();
  const left = () => Math.max(1, timeoutMs - (Date.now() - started));
  try {
    const tree = await bounded("frame", cdp.send("Page.getFrameTree"), left());
    const frameId = tree?.frameTree?.frame?.id;
    if (!frameId) throw new CheckError("the check tab has no frame");
    const res = await bounded("load", cdp.send("Network.loadNetworkResource", { frameId, url: checkUrl, options: { disableCache: true, includeCredentials: false } }), left());
    const r = res?.resource || {};
    if (!r.success) throw new CheckError(`the check address didn't load (${r.netErrorName || (r.httpStatusCode ? `status ${r.httpStatusCode}` : "error")})`);
    if (r.httpStatusCode !== 200) throw new CheckError(`the check address answered status ${r.httpStatusCode}`);
    if (!r.stream) throw new CheckError("the check address answered nothing");
    let body = Buffer.alloc(0);
    try {
      for (;;) {
        const chunk = await bounded("read", cdp.send("IO.read", { handle: r.stream, size: 16 * 1024 }), left());
        if (chunk?.data) body = Buffer.concat([body, Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8")]);
        if (body.length > BODY_MAX) throw new CheckError("the check address answered more than a check needs");
        if (chunk?.eof || !chunk?.data) break;
      }
    } finally {
      await within(CLOSE_MS, cdp.send("IO.close", { handle: r.stream }).catch(() => {}));
    }
    const { ip, loc } = parseTrace(body.toString("utf8"));
    if (!ip) throw new CheckError("the check address answered without an ip= line");
    result.browser = { ok: true, ip, loc };
  } catch (e) {
    result.browser = failed(e, step);
  }

  // (3) The WebRTC gathering, bounded in the page and again here.
  try {
    const g = await bounded("webrtc", page.evaluate(gatherInPage, { stun, ms: gatherMs, max: MAX_CANDIDATES }), gatherMs + 2000);
    const candidates = Array.isArray(g?.candidates) ? g.candidates.filter((c) => typeof c === "string").map((c) => c.slice(0, 500)) : [];
    if (g?.problem) result.webrtc = { ok: false, problem: `the WebRTC gathering failed (${String(g.problem).slice(0, 60)})`, timedOut: false };
    else if (!g?.complete) result.webrtc = { ok: false, problem: `the WebRTC gathering didn't finish within ${gatherMs} ms`, timedOut: true };
    else result.webrtc = { ok: true, candidates };
  } catch (e) {
    const f = failed(e, "webrtc");
    result.webrtc = { ok: false, problem: f.problem, timedOut: f.timedOut };
  }
  await close(page, cdp);
  return result;
}

// The check tab and its DevTools session gone, each within a bound.
async function close(page, cdp) {
  if (cdp) await within(CLOSE_MS, Promise.resolve().then(() => cdp.detach()).catch(() => {}));
  if (page) await within(CLOSE_MS, Promise.resolve().then(() => page.close()).catch(() => {}));
}
