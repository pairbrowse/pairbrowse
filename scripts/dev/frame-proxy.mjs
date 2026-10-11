// A dev and test tool, not plugin code: a loopback proxy in front of the pages' harness ui server
// (test/helpers/ui-server.mjs) that lets a page be framed by a same-origin parent, as the browser
// strip frames the session switcher. The harness serves every page with frame-ancestors 'none'
// and X-Frame-Options DENY (a chrome tab page's own rule); here they become 'self' and SAMEORIGIN,
// nothing else changes. It also serves the stand-in parent:
//   /__frame.html?page=<name>  an iframe of /<name>/index.html filling the window
//   /__frame.js                keeps the frame's notices in window.__notes (same origin, from the
//                              iframe's window only, the checks a real parent makes)
// startFrameProxy({ ui }) -> { origin, url(page), frameUrl(page), close() }. Node stdlib only.
import http from "node:http";

const PARENT_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'";
const PARENT_CSS = "html,body{margin:0;height:100%} iframe{border:0;width:100%;height:100%;display:block}\n";
const PARENT_JS = `window.__notes = [];
addEventListener("message", (e) => {
  if (e.origin !== location.origin || e.source !== document.getElementById("frame").contentWindow) return;
  window.__notes.push(e.data);
});
`;
const PAGE = /^[a-z][a-z0-9-]{0,31}$/;

const parentHtml = (page) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/__frame.css"><title>Framed</title></head><body><iframe id="frame" src="/${page}/index.html" title="${page}"></iframe><script src="/__frame.js"></script></body></html>`;

export async function startFrameProxy({ ui }) {
  const target = new URL(ui.origin);
  const send = (res, code, type, body, extra = {}) => {
    res.writeHead(code, { "cache-control": "no-store", "x-content-type-options": "nosniff", "content-type": type, ...extra });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    if (req.method !== "GET") return send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/__frame.html") {
      const page = url.searchParams.get("page") || "";
      if (!PAGE.test(page)) return send(res, 404, "text/plain; charset=utf-8", "Not found");
      return send(res, 200, "text/html; charset=utf-8", parentHtml(page), { "content-security-policy": PARENT_CSP });
    }
    if (url.pathname === "/__frame.css") return send(res, 200, "text/css; charset=utf-8", PARENT_CSS);
    if (url.pathname === "/__frame.js") return send(res, 200, "text/javascript; charset=utf-8", PARENT_JS);
    const up = http.request({ hostname: target.hostname, port: target.port, path: req.url, method: "GET", headers: { accept: req.headers.accept || "*/*" } }, (r) => {
      const headers = { ...r.headers };
      if (headers["content-security-policy"]) headers["content-security-policy"] = String(headers["content-security-policy"]).replace("frame-ancestors 'none'", "frame-ancestors 'self'");
      if (headers["x-frame-options"]) headers["x-frame-options"] = "SAMEORIGIN";
      res.writeHead(r.statusCode || 502, headers);
      r.pipe(res);
    });
    up.on("error", () => { if (!res.headersSent) send(res, 502, "text/plain; charset=utf-8", "Bad gateway"); else res.destroy(); });
    up.end();
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    url: (page) => `${origin}/${page}/index.html`,
    frameUrl: (page) => `${origin}/__frame.html?page=${encodeURIComponent(page)}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
