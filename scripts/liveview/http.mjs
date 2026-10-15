// What every live view server shares: the Host, Origin and key checks, request bodies with a
// size cap, the security headers, and the viewer page with its few asset files (liveview.mjs).
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

// Loopback names only, any port: an SSH tunnel may use a different local port. Other host
// names (DNS rebinding) are refused; the key in the URL is what grants access.
export const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;

// extraHosts: the liveViewHosts you listed (say, this computer's Tailscale name), any port.
export function hostOk(host, extraHosts = []) {
  const h = String(host || "").toLowerCase();
  if (LOOPBACK.test(h)) return true;
  const m = h.match(/^([^:]+)(:\d{1,5})?$/);
  return !!m && extraHosts.includes(m[1]);
}

export function originOk(origin) {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.protocol === "http:" && LOOPBACK.test(u.host.toLowerCase());
  } catch {
    return false;
  }
}

export function keyOk(given, key) {
  const a = Buffer.from(String(given || ""));
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

// The most a request body may hold, per kind of request.
export const BODY_MAX = { approve: 2_000, profile: 20_000, input: 200_000, tabOrder: 64_000, capture: 2_000_000 };

// The body as text, or null once it grows past max (the rest isn't read).
export async function readBody(req, max) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) return null;
  }
  return body;
}

// A body that isn't JSON: undefined (JSON itself never parses to undefined).
export const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };
export const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export const NOT_JSON = "The body is not JSON.";

// The body as text, or null once it was too large and 413 has answered.
export async function readCapped(req, res, max) {
  const body = await readBody(req, max);
  if (body === null) plain(res, 413);
  return body;
}

// A route's JSON body: the value, or undefined once the answer went out (413 past max; 400
// NOT_JSON when it isn't JSON, or with object: true isn't a JSON object). Never a 500.
export async function readJsonBody(req, res, max, { object = false } = {}) {
  const body = await readCapped(req, res, max);
  if (body === null) return undefined;
  const v = parseJson(body);
  if (v === undefined || (object && !isPlainObject(v))) { json(res, 400, { error: NOT_JSON }); return undefined; }
  return v;
}

// The request path, as sent, and its parts: /<key>/<route>/<rest...>.
const pathOf = (req) => String(req.url).split("?")[0];
export const pathParts = (req) => {
  const [, key, route = "", ...rest] = pathOf(req).split("/");
  return { key, route, rest };
};

export const SECURITY_HEADERS = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY" };

// The viewer runs only its own files: no inline code or styles (it sets styles through the
// CSSOM only), frames and favicons as data: images, requests to its own origin.
export const VIEWER_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Listens on 127.0.0.1 only. port 0: any free port.
export const listen = (server, port) => new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
});

// One server-sent event.
export const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
export const json = (res, code, data) => { res.writeHead(code, { ...SECURITY_HEADERS, "content-type": "application/json" }); res.end(JSON.stringify(data)); };

// text: a plain sentence for the answer instead of the bare code.
export const plain = (res, code, text = String(code)) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(text); };

const scripts = new URL("../", import.meta.url);
const viewerHtml = readFileSync(new URL("liveview.html", scripts), "utf8");
// The page's files, read once at start from a fixed list (never a path taken from a URL). The
// side panel shares common.js and tokens.css, and an extension loads only its own files, so they
// live in ui/, the extension's root, and are served to the live view from there; so do the flat
// modules common.js and liveview.js import (vocab.js: the words and colors the helper shares;
// urls.js: the browser's own addresses; limits.js: the limits both sides keep; events.js: the
// helper's events and who gets them; helper.js: finding and asking the helper).
const ASSETS = new Map(Object.entries({
  "liveview.css": ["liveview.css", "text/css; charset=utf-8"],
  "liveview.js": ["liveview.js", "text/javascript; charset=utf-8"],
  "tokens.css": ["../ui/tokens.css", "text/css; charset=utf-8"],
  "common.js": ["../ui/common.js", "text/javascript; charset=utf-8"],
  "vocab.js": ["../ui/vocab.js", "text/javascript; charset=utf-8"],
  "urls.js": ["../ui/urls.js", "text/javascript; charset=utf-8"],
  "limits.js": ["../ui/limits.js", "text/javascript; charset=utf-8"],
  "events.js": ["../ui/events.js", "text/javascript; charset=utf-8"],
  "helper.js": ["../ui/helper.js", "text/javascript; charset=utf-8"],
  "dom.js": ["../ui/dom.js", "text/javascript; charset=utf-8"],
  "motion.js": ["../ui/motion.js", "text/javascript; charset=utf-8"],
  "words.js": ["../ui/words.js", "text/javascript; charset=utf-8"],
  "people.js": ["../ui/people.js", "text/javascript; charset=utf-8"],
  "checklist.js": ["../ui/checklist.js", "text/javascript; charset=utf-8"],
  "report.js": ["../ui/report.js", "text/javascript; charset=utf-8"],
}).map(([name, [file, type]]) => [name, { file, body: readFileSync(new URL(file, scripts)), type }]));
// Each served name and the file it is read from (relative to scripts/), for the test that every
// module the page imports is served.
export const ASSET_FILES = Object.freeze(Object.fromEntries([...ASSETS].map(([name, a]) => [name, a.file])));

const attr = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The viewer page. attrs go on <body> as data-* (the page hides what its link may not use; the
// servers refuse it either way). Its files load relative to /<key>/, so that needs the slash.
export function serveViewer(req, res, attrs) {
  const path = pathOf(req);
  if (!path.endsWith("/")) { res.writeHead(308, { ...SECURITY_HEADERS, location: `${path}/` }); return res.end(); }
  const data = Object.entries(attrs).map(([k, v]) => `data-${k}="${attr(v)}" `).join("");
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": VIEWER_CSP });
  res.end(viewerHtml.replace("<body ", `<body ${data}`));
}

// /<key>/assets/<name>: one of the files above, or 404.
export function serveAsset(res, rest) {
  const asset = rest.length === 1 ? ASSETS.get(rest[0]) : null;
  if (!asset) return plain(res, 404);
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": asset.type });
  res.end(asset.body);
}
