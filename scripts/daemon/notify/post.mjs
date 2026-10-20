// The one way hand-off messages leave the helper (spec server-mode B6): a POST over Node's own
// http and https, https only (plain http only to this computer's loopback, for a local relay or a
// test), through agents of its own (never a proxy the environment names, never a session's proxy),
// never following a redirect, its answer read to at most 64 KB, each try bounded (10 s). One more
// try after 5 s on a server error (5xx) or a network error, none on a 4xx or a redirect (the
// request itself is wrong: trying again sends the same thing). Results never hold the address, an
// answer's text or a header: a webhook's address, a bot's token and a topic's name are credentials.
import http from "node:http";
import https from "node:https";
import { sleep } from "../../util.mjs";

export const POST_TIMEOUT_MS = 10_000;
export const RETRY_MS = 5_000;
const ANSWER_MAX = 64 * 1024;
const AGENTS = { "http:": new http.Agent({ keepAlive: false }), "https:": new https.Agent({ keepAlive: false }) };
const USER_AGENT = "PairBrowse";

// This computer's own loopback: localhost, 127.0.0.0/8 or [::1] (a URL's hostname).
export function isLoopbackHost(hostname) {
  const h = String(hostname || "").toLowerCase();
  return h === "localhost" || h === "[::1]" || /^127(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(h);
}

// Why url can't carry a hand-off message ("" when it can), never naming the address itself.
export function addressProblem(url) {
  let u;
  try { u = new URL(url); } catch { return "isn't an address"; }
  if (u.username || u.password) return "has a user name or password in it";
  if (u.protocol === "https:") return "";
  if (u.protocol === "http:") return isLoopbackHost(u.hostname) ? "" : "is plain http to another computer (use https)";
  return "isn't an https address";
}

const defaultRequest = (u, options, onAnswer) => (u.protocol === "https:" ? https : http).request(u, options, onAnswer);

// One try: { status } (the answer read and dropped, at most ANSWER_MAX of it) or { error } (a
// network error's code, or "timed out").
function once(u, body, { headers, timeoutMs, request }) {
  return new Promise((resolve) => {
    let req = null;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ error: "timed out" });
      try { req?.destroy(); } catch {}
    }, timeoutMs);
    try {
      req = request(u, { method: "POST", agent: AGENTS[u.protocol], headers: { "user-agent": USER_AGENT, ...headers, "content-length": Buffer.byteLength(body) } }, (res) => {
        let size = 0;
        const done = () => finish({ status: res.statusCode });
        res.on("data", (chunk) => { size += chunk.length; if (size > ANSWER_MAX) { res.destroy(); done(); } });
        res.on("end", done);
        res.on("close", done);
        res.on("error", done);
      });
    } catch (e) {
      finish({ error: e?.code || "couldn't send" });
      return;
    }
    req.on("error", (e) => finish({ error: e?.code || "network error" }));
    req.end(body);
  });
}

// POSTs body (a string) to url: { ok: true, status } or { ok: false, status?, error } (an HTTP
// status, a network error's code, "timed out" or why the address is refused). headers: the
// request's own. timeoutMs: each try's bound. retryMs, wait, request: for tests.
export async function httpsPost(url, body, { headers = {}, timeoutMs = POST_TIMEOUT_MS, retryMs = RETRY_MS, wait = sleep, request = defaultRequest } = {}) {
  const problem = addressProblem(url);
  if (problem) return { ok: false, error: `the address ${problem}` };
  const u = new URL(url);
  const text = String(body ?? "");
  for (let attempt = 0; ; attempt++) {
    const r = await once(u, text, { headers, timeoutMs, request });
    if (r.status >= 200 && r.status < 300) return { ok: true, status: r.status };
    const error = r.error || (r.status >= 300 && r.status < 400 ? `redirect refused (HTTP ${r.status})` : `HTTP ${r.status}`);
    const again = !!r.error || r.status >= 500;
    if (!again || attempt >= 1) return { ok: false, ...(r.status ? { status: r.status } : {}), error };
    await wait(retryMs);
  }
}
