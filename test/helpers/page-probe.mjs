// Reading a test page from the test, now that the helper refuses page scripts (browser_evaluate):
// each page served by a probe server holds a request open to /__probe; a probe releases them with
// a function's source and the address of the page it's meant for, that page runs it and posts the
// result back, any other answers "skip" and asks again a moment later. Only for the test's own
// fixture pages. A page at a name that resolves to this computer needs the browser started with
// --disable-features=LocalNetworkAccessChecks to reach the server again.
import { createServer } from "node:http";

export const PROBE_SCRIPT = `<script>(function poll() {
  fetch("/__probe").then((r) => r.json()).then(async ({ src, href }) => {
    if (href && location.href !== href) { await fetch("/__probe", { method: "POST", body: '{"skip":true}' }); await new Promise((r) => setTimeout(r, 300)); return; }
    let out;
    try { out = { v: await (0, eval)("(" + src + ")")() }; } catch (e) { out = { e: String(e) }; }
    await fetch("/__probe", { method: "POST", body: JSON.stringify(out) });
  }).then(poll, () => setTimeout(poll, 300));
})();</script>`;

// serve(req, res) answers every other request. Returns { server, probe(fnSource, href, ms) }:
// the function's result in the page at href (any page when href is empty), or undefined when no
// page answered in time.
export function probeServer(serve) {
  const held = new Set();
  let pending = null; // { body, resolve }
  const server = createServer((req, res) => {
    if (req.url !== "/__probe") return serve(req, res);
    if (req.method === "GET") {
      if (pending) return res.end(pending.body);
      held.add(res);
      res.on("close", () => held.delete(res));
      return;
    }
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => {
      res.end();
      let out = {};
      try { out = JSON.parse(b); } catch { /* a page mid-unload */ }
      if (out.skip || !pending) return;
      const p = pending;
      pending = null;
      p.resolve(out.e ? undefined : out.v);
    });
  });
  const probe = (src, href = "", ms = 5000) => new Promise((resolve) => {
    const timer = setTimeout(() => { if (pending?.resolve === done) pending = null; resolve(undefined); }, ms);
    function done(v) { clearTimeout(timer); resolve(v); }
    pending = { body: JSON.stringify({ src, href }), resolve: done };
    for (const res of held) res.end(pending.body);
    held.clear();
  });
  return { server, probe };
}
