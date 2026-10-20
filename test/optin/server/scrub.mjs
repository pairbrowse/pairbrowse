// What a graphics measurement keeps before it becomes a test fixture (test/fixtures/systeminfo-*.json,
// probe-*.json): the browser's SystemInfo answer and the page probe's, without anything that names
// the machine or its user. Pure: the spike (graphics-spike.test.mjs) and the fixtures' unit test
// (test/graphics-fixtures.test.mjs) share it.

// The command line is dropped (paths, keys, the profile folder); only its switch names are kept,
// for the switches that pick the graphics path. modelVersion is the machine's own revision.
export const GRAPHICS_SWITCH = /^(?:use-gl|use-angle|use-vulkan|use-webgpu-adapter|enable-unsafe-swiftshader|enable-unsafe-webgpu|disable-gpu|disable-gpu-compositing|disable-software-rasterizer|ignore-gpu-blocklist|enable-features|disable-features|headless|ozone-platform)$/;

// Absolute paths under a home, the temp folders or a container's mounts, in any string.
const PATHS = /(?:\/Users\/[^\s"]*|\/home\/[^\s"]*|\/root\/[^\s"]*|\/private\/(?:var|tmp)\/[^\s"]*|\/var\/folders\/[^\s"]*|\/tmp\/[^\s"]*|\/repo\/[^\s"]*|\/cache\/[^\s"]*|\/out\/[^\s"]*)/g;
export const scrubText = (s) => s.replace(PATHS, "<path>");

function deep(value) {
  if (typeof value === "string") return scrubText(value);
  if (Array.isArray(value)) return value.map(deep);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deep(v)]));
  return value;
}

// The graphics switches a command line carries, as "--name" or "--name=value" (feature lists kept,
// they name no path).
export function graphicsSwitches(commandLine = "") {
  const out = [];
  for (const arg of String(commandLine).split(/\s+/)) {
    const m = /^--([^=]+)(=.*)?$/.exec(arg);
    if (m && GRAPHICS_SWITCH.test(m[1])) out.push(scrubText(arg));
  }
  return out;
}

// SystemInfo.getInfo's answer, kept: gpu (devices, auxAttributes, featureStatus, workarounds, decode
// and encode profiles) and modelName; commandLine becomes its graphics switches.
export function scrubSystemInfo(info) {
  if (!info || typeof info !== "object") return info ?? null;
  const { commandLine, modelVersion, ...rest } = info;
  void modelVersion;
  return { ...deep(rest), switches: graphicsSwitches(commandLine) };
}

// A probe's answer, kept: every string scrubbed of paths.
export const scrubProbe = (probe) => deep(probe ?? null);

// The fixtures in test/fixtures: file name, the spike result it comes from (<platform>-<candidate>-<mode>),
// and the part kept.
export const FIXTURES = [
  ["systeminfo-macos-metal.json", "macos-auto-persona", "systemInfo"],
  ["systeminfo-linux-xvfb-llvmpipe.json", "linux-auto-real", "systemInfo"],
  ["systeminfo-linux-xvfb-swiftshader.json", "linux-swiftshader-real", "systemInfo"],
  ["systeminfo-linux-xvfb-lavapipe.json", "linux-mesa-vulkan-real", "systemInfo"],
  ["systeminfo-linux-disable-gpu.json", "linux-disable-gpu-real", "systemInfo"],
  ["probe-macos-metal.json", "macos-auto-persona", "probe"],
  ["probe-linux-llvmpipe-persona.json", "linux-auto-persona", "probe"],
  ["probe-linux-llvmpipe-real.json", "linux-auto-real", "probe"],
  ["probe-linux-swiftshader-real.json", "linux-swiftshader-real", "probe"],
  ["probe-linux-webgpu-fallback-real.json", "linux-webgpu-unsafe-real", "probe"],
  ["probe-linux-disable-gpu.json", "linux-disable-gpu-real", "probe"],
];

