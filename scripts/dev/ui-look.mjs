#!/usr/bin/env node
// A dev tool, not plugin code: renders ui/<page> over the pages' harness (the fake helper and the
// ui server from test/helpers) to a PNG, for reviews.
//   node scripts/dev/ui-look.mjs <page> [--width 360] [--height 900] [--fixtures file.json]
//                                [--reduced-motion] [--no-bridge] [--framed] [--out file.png]
// --framed renders the page in a same-origin frame (scripts/dev/frame-proxy.mjs: the harness CSP
// forbids framing), as the browser strip frames the session switcher; the log is the frame's.
// The fixtures file is { helper: {...fake-helper fixtures}, replies: {...}, shim: {...shim fixture
// overrides}, push: [[event, data], ...] } (push goes out once the stream is open, 200 ms apart).
// Prints the PNG's path, then the page's harness log and live() counts. Exit 1 when the page
// could not load.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { patchright } from "../../test/live.mjs";
import { startFakeHelper, merge } from "../../test/helpers/fake-helper.mjs";
import { defaultFixture } from "../../test/helpers/pairbrowse-shim.mjs";
import { openPage, pages } from "../../test/helpers/ui-page.mjs";
import { startUiServer } from "../../test/helpers/ui-server.mjs";
import { inPage } from "../../test/live.mjs";
import { startFrameProxy } from "./frame-proxy.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const page = args[0];
if (!page || page.startsWith("--") || !pages().includes(page)) {
  console.error(`usage: node scripts/dev/ui-look.mjs <${pages().join("|")}> [--width 360] [--height 900] [--fixtures file.json] [--reduced-motion] [--no-bridge] [--framed] [--out file.png]`);
  process.exit(1);
}
const width = Number(value("--width", 360)), height = Number(value("--height", 900));
const given = flag("--fixtures") ? JSON.parse(readFileSync(value("--fixtures"), "utf8")) : {};
const framed = flag("--framed");
const out = value("--out", join(tmpdir(), `ui-look-${page}-${width}x${height}${framed ? "-framed" : ""}.png`));
const runtime = process.env.PAIRBROWSE_TEST_RUNTIME || join(homedir(), ".pairbrowse", "runtime");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The page in a same-origin frame: { page, harness, close } over the frame.
async function openFramed(browser, name, { helper, fixture, bridge, viewport, reducedMotion }) {
  const ui = await startUiServer({ helper, fixture, bridge });
  const proxy = await startFrameProxy({ ui });
  helper.setPageOrigin(proxy.origin);
  const top = await browser.newPage({ viewport, reducedMotion });
  await top.goto(proxy.frameUrl(name), { waitUntil: "load" });
  let frame = null;
  for (let i = 0; i < 60 && !frame; i++) { frame = top.frames().find((f) => f.url().includes(`/${name}/index.html`)) || null; if (!frame) await sleep(50); }
  if (!frame) throw new Error("the frame did not load");
  for (let i = 0; i < 60; i++) {
    const s = await inPage(frame, () => document.body?.dataset.s);
    if (s === undefined || s !== "connecting") break;
    await sleep(50);
  }
  await sleep(300);
  return {
    page: top,
    harness: { log: () => inPage(frame, () => window.__harness.log), live: () => inPage(frame, () => window.__harness.live()) },
    close: async () => { await top.close().catch(() => {}); await proxy.close(); await ui.close(); },
  };
}

let code = 0, browser = null, helper = null, ctx = null;
try {
  browser = await patchright(runtime).chromium.launch();
  helper = await startFakeHelper({ pageOrigin: null, fixtures: given.helper, replies: given.replies });
  ctx = await (framed ? openFramed : openPage)(browser, page, {
    helper, fixture: merge(defaultFixture(), given.shim || {}), bridge: !flag("--no-bridge"),
    viewport: { width, height }, reducedMotion: flag("--reduced-motion") ? "reduce" : "no-preference",
  });
  for (const [event, data] of given.push || []) { helper.push(event, data); await sleep(200); }
  await ctx.page.screenshot({ path: out, fullPage: true });
  console.log(out);
  const log = await ctx.harness.log();
  console.log(`harness log: ${log.length} entr${log.length === 1 ? "y" : "ies"}`);
  for (const e of log) console.log(`  ${e.kind}: ${e.text}`);
  console.log(`live: ${JSON.stringify(await ctx.harness.live())}`);
} catch (e) {
  console.error(`could not render ${page}: ${e?.message || e}`);
  code = 1;
} finally {
  await ctx?.close();
  await helper?.close();
  await browser?.close();
}
process.exit(code);
