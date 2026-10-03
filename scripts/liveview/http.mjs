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
export const BODY_MAX = { approve: 2_000, profile: 20_000, input: 200_000 };

// The body as text, or null once it grows past max (the rest isn't read).
export async function readBody(req, max) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > max) return null;
  }
  return body;
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

export const plain = (res, code) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(String(code)); };

const scripts = new URL("../", import.meta.url);
const viewerHtml = readFileSync(new URL("liveview.html", scripts), "utf8");
// The page's files, read once at start from a fixed list (never a path taken from a URL). The
// side panel shares common.js, and an extension loads only its own files, so it lives there.
const ASSETS = new Map(Object.entries({
  "liveview.css": ["liveview.css", "text/css; charset=utf-8"],
  "liveview.js": ["liveview.js", "text/javascript; charset=utf-8"],
  "common.js": ["browser/panel/common.js", "text/javascript; charset=utf-8"],
}).map(([name, [file, type]]) => [name, { body: readFileSync(new URL(file, scripts)), type }]));

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
