// The graphics backend the browser process uses (server-mode spec E3): SystemInfo.getInfo on a
// browser-level session over the driver's pipe (no TCP port is ever opened), read into one small
// record. An answer that doesn't come within its bound, or doesn't read, is "unverified", never
// assumed hardware or software. The renderer, IDs and driver are this computer's: they go to the
// profile's 0600 file as evidence, never into reports or to joiners (only kind and status do).
// Node's standard library only.
import { within } from "../util.mjs";

// How long the read may take, per step (the session, the answer).
export const BACKEND_MS = 5000;
// A software renderer by its name (Mesa's llvmpipe, softpipe and lavapipe, the engine's
// SwiftShader), as native/validate.mjs reads renderer strings.
const SOFTWARE = /llvmpipe|softpipe|lavapipe|swiftshader|software rasterizer|basic render driver/i;
const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const clean = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max) : "");
const id = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

// A record that says nothing was learnt, with the reason (no IDs, no strings).
export const unverifiedBackend = (reason) => ({ kind: "unverified", vendor: null, device: null, renderer: null, driver: null, source: "systeminfo", reason });

// The GPU found but not used: compositing in software and no WebGL at all (not even the software
// fallback, "unavailable_software", whose renderer the answer then names).
const gpuRefused = (status) => plainObject(status) && /^(disabled|unavailable)_software/.test(String(status.gpu_compositing))
  && /^(disabled|unavailable)_off/.test(String(status.webgl));

// SystemInfo.getInfo's answer as { kind: "hardware" | "software" | "unverified", vendor, device
// (the active GPU's PCI vendor and device IDs), renderer (the GL renderer the GPU process uses,
// ANGLE's string), driver (its version), source: "systeminfo", reason (unverified only) }.
// software: GPU rendering turned off (gl=disabled, --disable-gpu: the browser rasterizes on the CPU;
// or the engine's blocklist refused the GPU it found, which still names it: compositing then runs
// in software and pages get no WebGL, as the open build does over Mesa's llvmpipe under Xvfb) or a
// software renderer's name in the renderer, the device or ANGLE's implementation (Mesa's llvmpipe
// under Xvfb, SwiftShader). hardware: any other renderer that names itself. Anything else
// (no gpu part, no devices, an empty renderer) is unverified. Never throws.
export function parseSystemInfo(info) {
  const gpu = plainObject(info) && plainObject(info.gpu) ? info.gpu : null;
  if (!gpu) return unverifiedBackend("the browser's answer has no graphics part");
  const devices = Array.isArray(gpu.devices) ? gpu.devices.filter(plainObject) : [];
  // The engine lists the GPU in use first; a device marked active wins where the answer marks one.
  const device = devices.find((d) => d.active === true) ?? devices[0] ?? null;
  const aux = plainObject(gpu.auxAttributes) ? gpu.auxAttributes : {};
  const renderer = clean(aux.glRenderer, 160) || clean(device?.deviceString, 160);
  const parts = clean(aux.glImplementationParts, 80);
  const base = { vendor: id(device?.vendorId), device: id(device?.deviceId), renderer: renderer || null, driver: clean(device?.driverVersion, 80) || null, source: "systeminfo" };
  if (/\bgl=disabled\b/.test(parts) || /^disabled$/i.test(renderer) || gpuRefused(gpu.featureStatus)) return { kind: "software", ...base, renderer: "software rasterizer (GPU rendering off)" };
  if (!device && !renderer) return unverifiedBackend("the browser named no graphics device");
  if (SOFTWARE.test(renderer) || SOFTWARE.test(clean(device?.deviceString, 160)) || /\bangle=swiftshader\b/.test(parts)) return { kind: "software", ...base };
  if (!renderer) return unverifiedBackend("the browser named no renderer");
  return { kind: "hardware", ...base };
}

// The live browser's backend (ctx: the driver's browser context). Each step is bounded (ms): a
// browser that doesn't answer gives unverified with the reason. The session is detached after,
// also one that opens only after its bound. Never throws.
export async function readBackend(ctx, { ms = BACKEND_MS } = {}) {
  let browser = null;
  try { browser = ctx?.browser?.() ?? null; } catch {}
  if (!browser || typeof browser.newBrowserCDPSession !== "function") return unverifiedBackend("no browser-level session on this driver");
  let session = null;
  try {
    const opening = Promise.resolve().then(() => browser.newBrowserCDPSession()).catch(() => null);
    session = await within(ms, opening);
    if (!session) {
      opening.then((late) => late?.detach?.()).catch(() => {});
      return unverifiedBackend(`the browser opened no session within ${ms / 1000} s`);
    }
    const failed = {};
    const info = await within(ms, Promise.resolve().then(() => session.send("SystemInfo.getInfo")).catch(() => failed));
    if (info === null) return unverifiedBackend(`SystemInfo didn't answer within ${ms / 1000} s`);
    if (info === failed) return unverifiedBackend("SystemInfo refused the request");
    return parseSystemInfo(info);
  } catch {
    return unverifiedBackend("the backend read failed");
  } finally {
    if (session) await within(ms, Promise.resolve().then(() => session.detach?.()).catch(() => {}));
  }
}
