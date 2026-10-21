// The server setup's fonts on a Linux host without a GPU (spec server-mode step 52; decision 11's
// free fonts and its alias route to measure): in a container built from the A13 image with the
// setup's Debian packages (test/optin/server/container.mjs fontsDockerfile), the setup command
// runs as the normal user, then the pinned native Linux build shows a page that reads fonts by
// width, as font checks do: colour emoji and CJK drawn, Microsoft's core fonts found, and with
// pairbrowse.fontStandIns on, Segoe UI, Calibri and Cambria found where the open stand-ins answer
// for them (off: not found, the stand-ins kept from the browser). The run inside is
// test/optin/server/fonts-run.mjs.
//
// Needs Docker (OrbStack on a Mac), PAIRBROWSE_TEST_DOCKER=1, PAIRBROWSE_TEST_RUNTIME, network
// access (the image's packages, Selawik's release), and PAIRBROWSE_TEST_COREFONTS_EULA=accept:
// setting it is your own acceptance of Microsoft's EULA for the core fonts
// (scripts/native/corefonts-eula.txt), which the image's package then installs.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dockerReady, ensureFontsImage, startContainer } from "./server/container.mjs";
import { prepareNativeCache } from "./server/native-cache.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SKIP = (!runtime || process.env.PAIRBROWSE_TEST_DOCKER !== "1") ? "set PAIRBROWSE_TEST_DOCKER=1 and PAIRBROWSE_TEST_RUNTIME"
  : process.env.PAIRBROWSE_TEST_COREFONTS_EULA !== "accept" ? "set PAIRBROWSE_TEST_COREFONTS_EULA=accept once you have read and accepted Microsoft's EULA (scripts/native/corefonts-eula.txt)" : false;
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("server fonts: the setup's set in the container; colour emoji, CJK and core fonts found; Segoe UI, Calibri and Cambria found by width only with the stand-ins on", { skip: SKIP, timeout: 3_000_000 }, async (t) => {
  assert.ok(dockerReady(), "Docker answers");
  const cache = await prepareNativeCache({ log: console.log });
  const image = ensureFontsImage(console.log);
  const c = startContainer({ name: "pb-fonts", repo, image, log: console.log, mounts: [{ from: runtime, to: "/runtime" }, { from: cache, to: "/cache" }] });
  let r;
  try {
    const run = await c.node("/repo/test/optin/server/fonts-run.mjs", [], { ms: 2_700_000 });
    const line = run.out.split("\n").find((l) => l.startsWith("RESULT "));
    assert.ok(line, `the run finished:\n${run.out.slice(-6000)}`);
    r = JSON.parse(line.slice("RESULT ".length));
  } finally { c.stop(); }
  t.diagnostic(JSON.stringify({ install: r.install, check: r.check, off: r.off, on: r.on, lines: r.launchLines }, null, 1).slice(0, 12000));
  assert.equal(r.error, undefined, `${r.error}\n--- daemon.log ---\n${r.log || ""}`);
  assert.notEqual(r.uid, 0, "a normal user");
  // The setup: nothing asked, nothing run with sudo (the packages are there), Selawik pinned.
  assert.equal(r.install.code, 0, r.install.out);
  assert.doesNotMatch(r.install.out, /Type "yes"|sudo/, "the image's packages: no question, no sudo");
  assert.match(r.check.out, /Microsoft's core fonts: installed/);
  assert.match(r.check.out, /Selawik 1\.01: installed/);
  assert.match(r.check.out, /the browser reads its fonts through PairBrowse's font configuration/);
  assert.ok(r.launchLines.some((l) => l.includes("stand-ins for the Windows names off")) && r.launchLines.some((l) => l.includes("stand-ins for the Windows names on")), r.launchLines.join("\n"));
  for (const [state, page] of [["off", r.off], ["on", r.on]]) {
    assert.ok(page.colorEmojiPixels > 0, `${state}: emoji draw in colour (fonts-noto-color-emoji reaches the browser)`);
    assert.equal(page.cjk, true, `${state}: CJK text has its font`);
    assert.deepEqual(page.controlFound, [], `${state}: no made-up font is found`);
    for (const f of ["Arial", "Times New Roman", "Courier New", "Verdana", "Georgia", "Trebuchet MS", "Impact"]) assert.ok(page.found.includes(f), `${state}: ${f} (the core fonts package) found: ${JSON.stringify(page.found)}`);
  }
  for (const f of ["Segoe UI", "Calibri", "Cambria"]) {
    assert.ok(!r.off.found.includes(f), `off: ${f} not found (its stand-in kept from the browser): ${JSON.stringify(r.off.found)}`);
    // Segoe UI depends on the engine taking Selawik for it as a metric-compatible family: if this
    // one fails while Calibri and Cambria pass, that is what the measurement records.
    assert.ok(r.on.found.includes(f), `on: ${f} found by width where its open stand-in answers: ${JSON.stringify(r.on.found)}`);
  }
});
