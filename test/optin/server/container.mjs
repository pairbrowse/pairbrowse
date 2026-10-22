// The one Linux container the server-mode opt-in tests run in (server-mode spec A13): Debian
// bookworm with Node 22 (node:22-bookworm), Xvfb and xauth for the helper's private virtual screen,
// fonts, Mesa (llvmpipe, lavapipe) and the libraries the PairBrowse Linux build needs, run as a
// normal user so the browser's sandbox stays on (decision U1). Phase A, C and E opt-in tests use it.
//
// The sandbox needs user namespaces, which Docker's default seccomp profile refuses (unshare and
// clone with CLONE_NEWUSER). The container gets its own test profile instead (seccompProfile):
// every call allowed except a fixed list no browser needs (kernel modules, mounts, reboot, keys,
// tracing other processes, clocks, io_uring); every capability dropped, no new privileges, never
// --privileged. It is a deny list, so it is looser than Docker's default (an allow list) for every
// call nobody listed: fine for a throwaway test container, not the advice for a server
// (docs/configuration.md recommends Docker's default with only the namespace rules relaxed). Under
// x64 emulation (an Apple Silicon Mac) the emulator refuses every seccomp filter, so there the
// browser runs with its namespace layer only (its sandbox page says so); that it gets seccomp-BPF
// too on an x64 host is still to be confirmed there (graphics-spike.test.mjs requires it).
//
// The container never outlives its test (the two-machines.test.mjs pattern): any left by an
// interrupted run with the same label goes before it starts; it goes after the run, on Ctrl+C or
// a kill, and, through a watcher outside the test's process group, whenever the test process ends
// however it ended; failing all that it stops by itself after two hours and Docker removes it.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGES as FONT_PACKAGES, freePackages } from "../../../scripts/native/fontsetup.mjs";

export const BASE_IMAGE = "node:22-bookworm";
// The PairBrowse Linux build is x64 only (native/install.mjs nativeLayout); on an Apple Silicon
// Mac the container runs under emulation.
export const PLATFORM = "linux/amd64";
export const USER = "pb";
export const UID = 1001;
// How long a container lives at most, in seconds (its command is a sleep).
export const LIFETIME_S = 7200;

// The packages: the virtual screen, fonts (Latin, CJK, emoji, the fontconfig cache), Mesa's
// software GL and Vulkan drivers (llvmpipe, lavapipe) with the loaders, and the shared libraries
// the browser links against.
export const PACKAGES = [
  "xvfb", "xauth",
  "fontconfig", "fonts-liberation", "fonts-noto-core", "fonts-noto-cjk", "fonts-noto-color-emoji", "fonts-dejavu-core",
  "libgl1", "libegl1", "libgles2", "libgl1-mesa-dri", "libglx-mesa0", "libegl-mesa0", "libgbm1", "mesa-vulkan-drivers", "libvulkan1", "mesa-utils", "vulkan-tools",
  "libasound2", "libatk-bridge2.0-0", "libatk1.0-0", "libatspi2.0-0", "libcairo2", "libcups2", "libdbus-1-3", "libdrm2",
  "libglib2.0-0", "libgtk-3-0", "libnspr4", "libnss3", "libpango-1.0-0", "libx11-6", "libx11-xcb1", "libxcb1", "libxcomposite1",
  "libxdamage1", "libxext6", "libxfixes3", "libxkbcommon0", "libxrandr2", "libxshmfence1", "libxss1", "libxtst6", "xdg-utils",
  "ca-certificates", "xz-utils",
];

// The image, built once per recipe: the packages and the normal user. Nothing from the repo or a
// home goes into it (they are mounted read-only at run time).
export function dockerfile() {
  return [
    `FROM ${BASE_IMAGE}`,
    "ENV DEBIAN_FRONTEND=noninteractive",
    `RUN apt-get update && apt-get install -y --no-install-recommends ${PACKAGES.join(" ")} && rm -rf /var/lib/apt/lists/*`,
    `RUN useradd --create-home --uid ${UID} --shell /bin/bash ${USER}`,
    `USER ${USER}`,
    `WORKDIR /home/${USER}`,
    "",
  ].join("\n");
}

// The image's tag names its recipe, so a changed package list builds a new one.
export const imageTag = () => `pairbrowse-test-server:${createHash("sha256").update(dockerfile()).digest("hex").slice(0, 12)}`;

// The image with the server setup's font set (spec step 52; test/optin/server-fonts.test.mjs and
// linux-graphics.test.mjs): the base image and the setup's own Debian packages (native/fontsetup.mjs
// PACKAGES: emoji, CJK, the open stand-ins), and, with core, Debian's contrib section added and
// Microsoft's core fonts through Debian's own package (whose download it checks against its own
// SHA-256 sums). That one is built only for a person who set PAIRBROWSE_TEST_COREFONTS_EULA=accept,
// their acceptance of Microsoft's EULA (scripts/native/corefonts-eula.txt); Debian's package asks
// nothing itself. Without core (the free set alone) the setup names the core fonts as absent.
export function fontsDockerfile(base = imageTag(), { core = true } = {}) {
  const plan = FONT_PACKAGES.debian;
  const contrib = core ? `sed -i -E 's/^(Components: .*main)$/\\1 ${plan.component}/' /etc/apt/sources.list.d/debian.sources && ` : "";
  return [
    `FROM ${base}`,
    "USER root",
    "ENV DEBIAN_FRONTEND=noninteractive",
    `RUN ${contrib}apt-get update && apt-get install -y --no-install-recommends ${[...freePackages(plan), ...(core ? [plan.core] : [])].join(" ")} && rm -rf /var/lib/apt/lists/*`,
    `USER ${USER}`,
    "",
  ].join("\n");
}
export const fontsImageTag = (opts = {}) => `pairbrowse-test-server-fonts:${createHash("sha256").update(fontsDockerfile(imageTag(), opts)).digest("hex").slice(0, 12)}`;

// Builds the fonts image (with or without the core fonts) when this recipe has none yet.
export function ensureFontsImage(log = () => {}, opts = {}) {
  ensureImage(log);
  const tag = fontsImageTag(opts);
  try { sh(["image", "inspect", tag], 30_000); return tag; } catch {}
  log(`building ${tag} (once)`);
  sh(["build", "--platform", PLATFORM, "-t", tag, "-"], 1_800_000, fontsDockerfile(imageTag(), opts));
  return tag;
}

// Calls the container refuses (EPERM), Docker's default refusals among them (io_uring included). The
// browser's namespace sandbox needs unshare and clone with new user, PID and network namespaces and
// chroot, which stay allowed; none of these.
export const SECCOMP_DENY = [
  "acct", "add_key", "bpf", "clock_adjtime", "clock_settime", "create_module", "delete_module", "finit_module",
  "fsconfig", "fsmount", "fsopen", "fspick", "get_kernel_syms", "init_module", "io_uring_enter", "io_uring_register",
  "io_uring_setup", "ioperm", "iopl", "kcmp",
  "kexec_file_load", "kexec_load", "keyctl", "lookup_dcookie", "mount", "mount_setattr", "move_mount",
  "name_to_handle_at", "nfsservctl", "open_by_handle_at", "open_tree", "perf_event_open", "pivot_root",
  "process_vm_readv", "process_vm_writev", "ptrace", "query_module", "quotactl", "quotactl_fd", "reboot",
  "request_key", "setns", "settimeofday", "stime", "swapoff", "swapon", "sysfs", "_sysctl", "umount",
  "umount2", "uselib", "userfaultfd", "ustat", "vm86", "vm86old",
];

export function seccompProfile() {
  return {
    defaultAction: "SCMP_ACT_ALLOW",
    architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32", "SCMP_ARCH_AARCH64"],
    syscalls: [{ names: SECCOMP_DENY, action: "SCMP_ACT_ERRNO", errnoRet: 1 }],
  };
}

// docker run's arguments. mounts: [{ from, to, readOnly }]; env: { NAME: value }. seccompFile:
// the test profile, or null for Docker's default one (which refuses the sandbox's user
// namespaces: a test that the launch is refused then). root: the container runs as root (a test
// that the launch is refused as root); otherwise the normal user.
export function runArgs({ name, label, seccompFile, root = false, mounts = [], env = {}, image = imageTag() }) {
  return [
    // --init: a process that reaps orphans as a service manager does (a killed helper's Xvfb is
    // otherwise left a zombie that still counts as running).
    "run", "-d", "--rm", "--init", "--name", name, "--label", label, "--platform", PLATFORM,
    ...(seccompFile ? ["--security-opt", `seccomp=${seccompFile}`] : []), "--security-opt", "no-new-privileges", "--cap-drop", "ALL",
    "--user", root ? "0:0" : `${UID}:${UID}`, "--shm-size", "1g",
    ...mounts.flatMap((m) => ["-v", `${m.from}:${m.to}${m.readOnly === false ? "" : ":ro"}`]),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    image, "sleep", String(LIFETIME_S),
  ];
}

const sh = (args, ms = 120_000, input) => execFileSync("docker", args, { encoding: "utf8", timeout: ms, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 64 << 20 });

// Whether this computer can run the container (Docker answers).
export function dockerReady() {
  try { sh(["version", "--format", "{{.Server.Version}}"], 30_000); return true; } catch { return false; }
}

// Builds the image when this recipe has none yet (several minutes the first time).
export function ensureImage(log = () => {}) {
  const tag = imageTag();
  try { sh(["image", "inspect", tag], 30_000); return tag; } catch {}
  log(`building ${tag} (once)`);
  sh(["build", "--platform", PLATFORM, "-t", tag, "-"], 1_800_000, dockerfile());
  return tag;
}

function removeLabelled(label) {
  let ids = [];
  try { ids = sh(["ps", "-aq", "--filter", `label=${label}`], 30_000).split(/\s+/).filter(Boolean); } catch {}
  for (const id of ids) try { sh(["rm", "-f", id], 60_000); } catch {}
}

// Removes the container once the process that started it is gone, however it ended.
function watch(name) {
  const watcher = `const { execFileSync } = require("node:child_process");
    const timer = setInterval(() => {
      try { process.kill(${process.pid}, 0); return; } catch {}
      clearInterval(timer);
      try { execFileSync("docker", ["rm", "-f", ${JSON.stringify(name)}], { stdio: "ignore", timeout: 60000 }); } catch {}
    }, 1000);`;
  spawn(process.execPath, ["-e", watcher], { detached: true, stdio: "ignore" }).unref();
}

// One command in the container: resolves { code, out } (stdout and stderr together), killed after
// ms. user: "root" only where a test needs it (the default is the normal user).
function execIn(name, argv, { env = {}, user, ms = 600_000 } = {}) {
  return new Promise((resolve) => {
    const args = ["exec", ...(user ? ["-u", user] : []), ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]), name, ...argv];
    const p = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => p.kill("SIGKILL"), ms);
    p.on("close", (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// Starts the container: { name, exec(argv, opts), node(script, args, opts), stop() }. name: also
// its label's value (pairbrowse-test=<name>). The repo is mounted read-only at /repo. seccomp:
// "test" (seccompProfile) or "default" (Docker's own); root: see runArgs. image: another image
// built on the base one (ensureFontsImage), else the base image.
export function startContainer({ name, repo, mounts = [], env = {}, seccomp = "test", root = false, image: given = null, log = () => {} }) {
  const label = `pairbrowse-test=${name}`;
  const image = given || ensureImage(log);
  removeLabelled(label);
  const dir = mkdtempSync(join(tmpdir(), "pb-container-"));
  const seccompFile = join(dir, "seccomp.json");
  writeFileSync(seccompFile, JSON.stringify(seccompProfile()));
  // Removed again in stop(), so a later test in the same process never exits through this one's.
  const handlers = [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]].map(([signal, code]) => [signal, () => { stop(); process.exit(code); }]);
  const stop = () => {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler);
    removeLabelled(label);
    rmSync(dir, { recursive: true, force: true });
  };
  for (const [signal, handler] of handlers) process.once(signal, handler);
  sh(runArgs({ name, label, seccompFile: seccomp === "default" ? null : seccompFile, root, image, env, mounts: [...(repo ? [{ from: repo, to: "/repo" }] : []), ...mounts] }), 120_000);
  watch(name);
  const exec = (argv, opts) => execIn(name, argv, opts);
  return { name, exec, node: (script, args = [], opts) => exec(["node", script, ...args], opts), stop };
}
