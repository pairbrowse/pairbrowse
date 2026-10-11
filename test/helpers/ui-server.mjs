// The pages' harness ui server: the files under ui/ over loopback http, on an origin of their own
// (the helper is on another, as chrome://pairbrowse and the helper will be), under the chrome
// pages' CSP. Each page gets the harness scripts as same-origin <script src> tags before its first
// script: the prelude, the window.pairbrowse shim and, for the bridge period, chrome.*. The
// native build's 520 patch inserts the real adapter the same way at pack time, so a page's
// contract is only "window.pairbrowse exists before my first script, or is absent". Never
// page.route: Patchright's init scripts go through routes as inline script, which this CSP refuses.
import http from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, posix, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SECURITY_HEADERS, listen, plain } from "../../scripts/liveview/http.mjs";
import { defaultFixture, shimScript, bridgeChromeScript } from "./pairbrowse-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const UI_ROOT = join(here, "..", "..", "ui");
const PRELUDE = readFileSync(join(here, "ui-prelude.js"), "utf8");

// The live view's VIEWER_CSP (scripts/liveview/http.mjs) widened to a chrome page's own images,
// media and its helper, plus Chromium WebUI's Trusted Types enforcement (ui/webui/webui_util.cc
// EnableTrustedTypesCSP); `static-types` is one of its default policy names, the only one a
// PairBrowse page may use. Framing mirrors what the native 520 patch sets: frame-src 'self' on
// every chrome page; frame-ancestors 'self', with X-Frame-Options lifted to SAMEORIGIN, on /picker
// only (the session switcher the strip and the left dock frame); every other page refuses any frame.
export const FRAMEABLE = new Set(["picker"]);
export const PAGE_CSP = (helperOrigin, page = "") => `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; frame-src 'self'; connect-src 'self' ${helperOrigin}; base-uri 'none'; form-action 'none'; frame-ancestors ${FRAMEABLE.has(page) ? "'self'" : "'none'"}; require-trusted-types-for 'script'; trusted-types static-types`;

const TYPES = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  svg: "image/svg+xml", png: "image/png", json: "application/json", woff2: "font/woff2" };

// The harness tags go before the page's first <script, else before </head>, else at the end.
export function insertTags(html, tags) {
  const lower = html.toLowerCase();
  const at = lower.indexOf("<script");
  if (at >= 0) return html.slice(0, at) + tags + html.slice(at);
  const head = lower.indexOf("</head>");
  if (head >= 0) return html.slice(0, head) + tags + html.slice(head);
  return html + tags;
}

export async function startUiServer({ helper, fixture = defaultFixture(), bridge = true, root = UI_ROOT } = {}) {
  let current = fixture;
  const tags = '<script src="/__harness/prelude.js"></script><script src="/__harness/pairbrowse-api.js"></script>' + (bridge ? '<script src="/__harness/chrome.js"></script>' : "");
  const js = (res, body) => { res.writeHead(200, { ...SECURITY_HEADERS, "content-type": TYPES.js }); res.end(body); };
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") return plain(res, 405);
    let path;
    try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { return plain(res, 400); }
    if (path === "/__harness/prelude.js") return js(res, PRELUDE);
    if (path === "/__harness/pairbrowse-api.js") return js(res, shimScript({ ...current, helper: { origin: helper.origin, key: helper.key } }));
    if (path === "/__harness/chrome.js") return js(res, bridgeChromeScript(helper.base));
    const clean = posix.normalize(path);
    const parts = clean.split("/").filter(Boolean);
    if (clean.includes("..") || clean.includes("\0") || !parts.length || parts.some((p) => p.startsWith(".")) || parts[0] === "__harness") return plain(res, 404);
    const file = join(root, ...parts);
    try { if (!statSync(file).isFile()) return plain(res, 404); } catch { return plain(res, 404); }
    const ext = parts.at(-1).split(".").pop().toLowerCase();
    const type = TYPES[ext];
    if (!type) return plain(res, 404);
    if (ext === "html") {
      const page = parts.length === 2 && parts[1] === "index.html" ? parts[0] : "";
      res.writeHead(200, { ...SECURITY_HEADERS, ...(FRAMEABLE.has(page) ? { "x-frame-options": "SAMEORIGIN" } : {}), "content-type": type, "content-security-policy": PAGE_CSP(helper.origin, page) });
      return res.end(insertTags(readFileSync(file, "utf8"), tags));
    }
    res.writeHead(200, { ...SECURITY_HEADERS, "content-type": type });
    res.end(readFileSync(file));
  });
  await listen(server, 0);
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: (page) => `${origin}/${page}/index.html`,
    fixture: (next) => { current = next; },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
