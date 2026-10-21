// The canvas bridge is gone from the build (spec server-mode E1, engine patch 960; acceptance
// "Canvas bridge": opt-in, a local listener, no connection arrives). In the A13 container the
// native Linux build is started straight through the driver with the bridge's six switches
// pointing at a listener on loopback, a page draws on canvases and in WebGL and reads pixels back,
// and nothing ever connects: the renderers never see the switches (960 stops forwarding them), the
// bridge client is a stub, and the page draws as before. The browser runs as the normal user with
// its sandbox on (never --no-sandbox: the build is checked as it ships, nothing weakened for the
// test). The run inside is test/optin/server/canvas-bridge-run.mjs.
//
// Needs Docker (OrbStack on a Mac), PAIRBROWSE_TEST_DOCKER=1 and PAIRBROWSE_TEST_RUNTIME; the
// pinned Linux build and engine pack from PAIRBROWSE_TEST_LINUX_ARCHIVE and
// PAIRBROWSE_TEST_ENGINE_ARCHIVE (local files matching the pins), else from the release.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerReady, startContainer } from "./server/container.mjs";
import { prepareNativeCache } from "./server/native-cache.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SKIP = (!runtime || process.env.PAIRBROWSE_TEST_DOCKER !== "1") && "set PAIRBROWSE_TEST_DOCKER=1 and PAIRBROWSE_TEST_RUNTIME";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("canvas bridge dead: with its switches pointing at a local listener, no connection arrives, the renderers never get them, the page draws", { skip: SKIP, timeout: 2_400_000 }, async (t) => {
  assert.ok(dockerReady(), "Docker answers");
  const cache = await prepareNativeCache({ log: console.log });
  const c = startContainer({ name: "pb-canvas-bridge", repo, log: console.log, mounts: [{ from: runtime, to: "/runtime" }, { from: cache, to: "/cache" }] });
  let r;
  try {
    const out = await c.node("/repo/test/optin/server/canvas-bridge-run.mjs", [], { ms: 2_100_000 });
    const line = out.out.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `the run printed its result:\n${out.out.slice(-6000)}`);
    r = JSON.parse(line.slice("RESULT ".length));
  } finally { c.stop(); }
  t.diagnostic(JSON.stringify(r, null, 1).slice(0, 6000));
  assert.equal(r.error, undefined, r.error);
  assert.notEqual(r.uid, 0, "a normal user");
  assert.equal(r.noSandboxSwitch, false, "the sandbox stays on");
  assert.ok(r.browserHasSwitch, "the bridge switches reached the browser process (the build is tested as it ships)");
  assert.ok(r.children > 0, "the browser's own processes run");
  assert.equal(r.childrenWithSwitch, 0, "no renderer, GPU or utility process got a bridge switch (960 stops forwarding them)");
  assert.equal(r.connections, 0, `nothing connected to the listener: ${JSON.stringify(r.heads)}`);
  assert.ok(r.page?.canvas?.first && r.page.canvas.first === r.page.canvas.second, "the page draws, locally");
  assert.ok(r.page?.webgl?.available, "WebGL draws, locally");
});
