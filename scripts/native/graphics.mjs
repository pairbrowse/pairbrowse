// The native build's graphics, pure (server-mode spec, Phase E). For now: the one WebGPU shape the
// engine reads.

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// The engine pack's collector reports WebGPU as { info: { vendor, architecture, device,
// description }, limits, ... }; the engine's profile import reads webgpu.vendor and its siblings at
// the top. A profile with the nested form is flattened (info's fields, then its limits), from
// whichever layer it comes. Anything else (already flat, no adapter, not an object) comes back as
// it was, the same object; a flattened profile is a new object, the given one is never changed.
export function normalizeWebgpu(profile) {
  const webgpu = profile?.webgpu;
  if (!isObject(profile) || !isObject(webgpu) || !isObject(webgpu.info) || webgpu.vendor) return profile;
  return { ...profile, webgpu: { ...webgpu.info, limits: webgpu.limits } };
}
