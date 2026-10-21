// A page that reads what pages read of the browser's graphics (spec server-mode step 49) and
// prints it as "graphics: {json} end": WebGL and WebGL2's unmasked strings and limits, the WebGPU
// adapter (vendor, architecture, fallback, a device with the reported limits), a fixed canvas scene
// drawn twice (its pixel hashes), which common fonts resolve (and control names no computer has),
// and the screen. Served from this computer's loopback by servePage; parseGraphics reads it back
// from an agent's snapshot.
import { createServer } from "node:http";

export const GRAPHICS_PAGE = `<!doctype html><title>graphics</title><p id=g>graphics: waiting</p><script>
(async () => {
  const out = {};
  const hash = (bytes) => { let h = 0x811c9dc5; for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16) + ":" + bytes.length; };
  const gl = (kind) => {
    try {
      const c = document.createElement("canvas"); c.width = 64; c.height = 64;
      const g = c.getContext(kind);
      if (!g) return { available: false };
      const d = g.getExtension("WEBGL_debug_renderer_info");
      return { available: true, vendor: d ? g.getParameter(d.UNMASKED_VENDOR_WEBGL) : null, renderer: d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : null,
        maxTextureSize: g.getParameter(g.MAX_TEXTURE_SIZE), maxRenderbufferSize: g.getParameter(g.MAX_RENDERBUFFER_SIZE), extensions: (g.getSupportedExtensions() || []).length };
    } catch (e) { return { available: false, error: String(e && e.message || e) }; }
  };
  out.webgl = gl("webgl"); out.webgl2 = gl("webgl2");
  const scene = () => {
    const c = document.createElement("canvas"); c.width = 240; c.height = 60;
    const x = c.getContext("2d");
    const gr = x.createLinearGradient(0, 0, 240, 0); gr.addColorStop(0, "#f60"); gr.addColorStop(1, "#069");
    x.fillStyle = gr; x.fillRect(0, 0, 240, 60);
    x.textBaseline = "top"; x.font = "16px sans-serif"; x.fillStyle = "rgba(102, 204, 0, 0.7)"; x.fillText("PairBrowse probe éß 1.5", 4, 6);
    x.font = "italic 14px serif"; x.fillStyle = "#123"; x.fillText("Sphinx of black quartz", 8, 30);
    x.beginPath(); x.arc(200, 30, 18, 0, Math.PI * 2); x.strokeStyle = "#fff"; x.lineWidth = 3; x.stroke();
    return hash(x.getImageData(0, 0, 240, 60).data);
  };
  out.canvas = { first: scene(), second: scene() };
  const x = document.createElement("canvas").getContext("2d");
  const width = (f) => { x.font = "72px " + f; return x.measureText("mmmmmmmmmmlli1WQ@#").width; };
  const bases = ["monospace", "serif", "sans-serif"]; const base = bases.map(width);
  const has = (n) => bases.some((b, i) => width('"' + n + '", ' + b) !== base[i]);
  out.fonts = { found: ["DejaVu Sans", "Liberation Sans", "Noto Sans", "Arial", "Helvetica", "Times New Roman"].filter(has), controlFound: ["PairBrowse Control Sans 7f3a", "Zq Control Mono 4be1"].filter(has) };
  out.screen = { width: screen.width, height: screen.height, availWidth: screen.availWidth, availHeight: screen.availHeight, colorDepth: screen.colorDepth, dpr: devicePixelRatio };
  out.navigator = { platform: navigator.platform, cores: navigator.hardwareConcurrency, memory: navigator.deviceMemory === undefined ? null : navigator.deviceMemory };
  try {
    if (!navigator.gpu) out.webgpu = { available: false, reason: "navigator.gpu undefined" };
    else {
      const a = await Promise.race([navigator.gpu.requestAdapter(), new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
      if (a === "timeout") out.webgpu = { available: false, reason: "requestAdapter timed out" };
      else if (!a) out.webgpu = { available: false, reason: "requestAdapter returned null" };
      else {
        const limits = {}; for (const k in a.limits) if (typeof a.limits[k] === "number") limits[k] = a.limits[k];
        let device = "ok";
        try { const d = await a.requestDevice({ requiredLimits: limits }); d.destroy(); } catch (e) { device = String(e && e.message || e); }
        const info = a.info || {};
        out.webgpu = { available: true, vendor: info.vendor, architecture: info.architecture, isFallbackAdapter: info.isFallbackAdapter === undefined ? a.isFallbackAdapter : info.isFallbackAdapter, features: [...a.features].length, limits: Object.keys(limits).length, requestDevice: device };
      }
    }
  } catch (e) { out.webgpu = { available: false, reason: String(e && e.message || e) }; }
  document.getElementById("g").textContent = "graphics: " + JSON.stringify(out) + " end";
})();
</script>`;

// The page on this computer's loopback: { url, close() }.
export function servePage(html = GRAPHICS_PAGE) {
  const server = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end(html); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() })));
}

// What the page printed, from an agent's snapshot text (its quotes come back escaped), or null.
export function parseGraphics(shown) {
  const m = /graphics: (\{.*?\}) end/s.exec(String(shown));
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/\\"/g, '"')); } catch { return null; }
}
