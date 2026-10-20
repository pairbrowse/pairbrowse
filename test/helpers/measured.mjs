// A validation[build] entry with measured evidence (spec server-mode E6, E8), for tests that need a
// validated or failed profile: the measurement in native/validate.mjs measuredRecord's shape, of
// the entry's own runtime key and engine pack (a validated or failed entry always names one). No
// project code is loaded here.
export const RUNTIME_KEY = "e".repeat(64);
export const MEASURED_PACK = "f".repeat(64);

export function measuredEntry({ status = "validated", at = "2026-10-21T09:00:00Z", pack = MEASURED_PACK, items = [], runtimeKey = RUNTIME_KEY } = {}) {
  const graphics = {
    at, runtimeKey, pack,
    runtime: { platform: "linux", arch: "x64", display: "xvfb", emulated: false, sandbox: { on: true, page: [] } },
    backend: { kind: "software", vendor: 0, device: 0, renderer: "llvmpipe", driver: "22.3.6", source: "systeminfo" },
    webgl: null, webgl2: null, webgpu: null, canvas: null, fonts: null, media: null, screen: null, locale: null, navigator: null,
  };
  return { status, at, pack, runtimeKey, graphics, items };
}
