// The A13 container harness (test/optin/server/container.mjs) and the graphics spike's scrubber
// (test/optin/server/scrub.mjs), without Docker: the image recipe, the run arguments (the sandbox's
// user namespaces allowed, nothing looser), and what a measurement keeps.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE_IMAGE, PLATFORM, SECCOMP_DENY, UID, USER, dockerfile, imageTag, runArgs, seccompProfile } from "./optin/server/container.mjs";
import { graphicsSwitches, scrubProbe, scrubSystemInfo, scrubText } from "./optin/server/scrub.mjs";

test("the image: node:22-bookworm with Xvfb, xauth, fonts and Mesa, run as a normal user", () => {
  const recipe = dockerfile();
  assert.equal(BASE_IMAGE, "node:22-bookworm");
  assert.match(recipe, /^FROM node:22-bookworm$/m);
  for (const pkg of ["xvfb", "xauth", "fontconfig", "fonts-liberation", "fonts-noto-color-emoji", "libgl1-mesa-dri", "mesa-vulkan-drivers"]) assert.match(recipe, new RegExp(`\\b${pkg}\\b`), pkg);
  assert.match(recipe, new RegExp(`useradd [^\\n]*--uid ${UID} [^\\n]*${USER}`));
  assert.match(recipe, new RegExp(`^USER ${USER}$`, "m"), "the last user is not root");
  assert.notEqual(UID, 0);
  // The tag follows the recipe.
  assert.match(imageTag(), /^pairbrowse-test-server:[0-9a-f]{12}$/);
  assert.equal(imageTag(), imageTag());
});

test("the run: its own seccomp profile, every capability dropped, no new privileges, a normal user, never privileged", () => {
  const args = runArgs({ name: "pb-x", label: "pairbrowse-test=pb-x", seccompFile: "/tmp/s.json", image: "img", mounts: [{ from: "/a", to: "/repo" }, { from: "/b", to: "/out", readOnly: false }], env: { A: "1" } });
  const pair = (flag, value) => args.some((a, i) => a === flag && args[i + 1] === value);
  assert.ok(pair("--security-opt", "seccomp=/tmp/s.json"));
  assert.ok(pair("--security-opt", "no-new-privileges"));
  assert.ok(pair("--cap-drop", "ALL"));
  assert.ok(pair("--user", `${UID}:${UID}`));
  assert.ok(pair("--platform", PLATFORM));
  assert.ok(pair("--label", "pairbrowse-test=pb-x"));
  assert.ok(args.includes("--rm"), "Docker removes it when it stops");
  assert.ok(pair("-v", "/a:/repo:ro"), "mounts are read-only unless asked");
  assert.ok(pair("-v", "/b:/out"));
  assert.ok(pair("-e", "A=1"));
  for (const a of args) assert.doesNotMatch(a, /privileged|unconfined|--cap-add|no-sandbox/);
  assert.deepEqual(args.slice(-3), ["img", "sleep", "7200"], "it stops by itself");
});

test("the seccomp profile allows the sandbox's namespaces and refuses calls no browser needs", () => {
  const p = seccompProfile();
  assert.equal(p.defaultAction, "SCMP_ACT_ALLOW");
  assert.equal(p.syscalls.length, 1);
  assert.equal(p.syscalls[0].action, "SCMP_ACT_ERRNO");
  const denied = new Set(p.syscalls[0].names);
  assert.deepEqual([...denied].sort(), [...SECCOMP_DENY].sort());
  for (const call of ["unshare", "clone", "clone3", "chroot", "seccomp", "prctl"]) assert.ok(!denied.has(call), `${call} stays allowed (the browser's sandbox)`);
  for (const call of ["mount", "ptrace", "kexec_load", "init_module", "bpf", "setns", "reboot", "keyctl", "userfaultfd", "io_uring_setup", "io_uring_enter", "io_uring_register"]) assert.ok(denied.has(call), `${call} is refused`);
});

test("a measurement keeps no paths, no command line and no machine revision", () => {
  const info = {
    gpu: { devices: [{ vendorId: 4203, deviceId: 0, vendorString: "Apple", deviceString: "Apple M2" }], auxAttributes: { glRenderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)", path: "/Users/someone/Library/x" } },
    modelName: "MacBookPro", modelVersion: "18.2",
    commandLine: "/Users/someone/.pairbrowse/browser/PairBrowse.app/x --user-data-dir=/var/folders/ab/T/p --use-angle=swiftshader --enable-unsafe-swiftshader --remote-debugging-pipe --enable-features=Vulkan,Foo --headless",
  };
  const kept = scrubSystemInfo(info);
  assert.equal(kept.commandLine, undefined);
  assert.equal(kept.modelVersion, undefined);
  assert.equal(kept.modelName, "MacBookPro");
  assert.deepEqual(kept.switches, ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-features=Vulkan,Foo", "--headless"]);
  assert.equal(kept.gpu.auxAttributes.path, "<path>");
  assert.equal(kept.gpu.devices[0].deviceString, "Apple M2");
  assert.doesNotMatch(JSON.stringify(kept), /someone|var\/folders/);
  assert.equal(scrubSystemInfo(null), null);
  assert.deepEqual(graphicsSwitches(""), []);
  assert.equal(scrubText("at /home/pb/h/browser and /tmp/x/y, /repo/test"), "at <path> and <path> <path>");
  assert.deepEqual(scrubProbe({ webgl: { renderer: "x" }, error: "in /tmp/a" }), { webgl: { renderer: "x" }, error: "in <path>" });
});
