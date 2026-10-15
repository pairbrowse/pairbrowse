#!/usr/bin/env node
// A dev tool, not plugin code: renders ui/<page> over the pages' harness (the fake helper and the
// ui server from test/helpers) to a PNG, for reviews.
//   node scripts/dev/ui-look.mjs <page> [--width 360] [--height 900] [--fixtures file.json]
//                                [--reduced-motion] [--no-bridge] [--no-native] [--hash name] [--out file.png]
// The fixtures are scripts/dev/look/<page>.json when it exists (the review fixture
// scripts/dev/ui-look-all.mjs uses too); --fixtures <file> replaces them. A fixtures file is
// { helper: {...fake-helper fixtures}, replies: {...}, shim: {...shim fixture overrides},
// push: [[event, data], ...] } (push goes out once the stream is open, 200 ms apart).
// --hash renders one of a page's hash modes (the strip's nav fragments and bubbles: nav-left,
// nav-right, switcher, share, menu): set once the page has loaded; each child frame then gets up
// to 3 s to leave "connecting", then 200 ms before the PNG. The harness serves the picker
// frameable by same-origin pages only, as the native build will, so the strip's switcher shows
// the real framed picker.
// Prints the PNG's path, then the page's harness log and live() counts. Exit 1 when the page
// could not load. --no-native leaves out the window.pairbrowse shim (the side panel host). renderPage(browser, opts)
// is the same render for scripts (ui-look-all.mjs).
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchright, inPage } from "../../test/live.mjs";
import { startFakeHelper, merge } from "../../test/helpers/fake-helper.mjs";
import { defaultFixture } from "../../test/helpers/pairbrowse-shim.mjs";
import { openPage, pages } from "../../test/helpers/ui-page.mjs";

export const LOOK_DIR = join(dirname(fileURLToPath(import.meta.url)), "look");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The review fixtures of a page: scripts/dev/look/<page>.json, else none.
export function lookFixtures(page) {
  const file = join(LOOK_DIR, `${page}.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

// Renders one page to out; starts and closes its own fake helper. -> { out, log, live }.
export async function renderPage(browser, { page, width = 360, height = 900, fixtures = lookFixtures(page), hash = "", reducedMotion = false, bridge = true, native = true, out }) {
  const given = fixtures || {};
  let helper = null, ctx = null;
  try {
    helper = await startFakeHelper({ pageOrigin: null, fixtures: given.helper, replies: given.replies });
    ctx = await openPage(browser, page, {
      helper, fixture: merge(defaultFixture(), given.shim || {}), bridge, native,
      viewport: { width, height }, reducedMotion: reducedMotion ? "reduce" : "no-preference",
    });
    for (const [event, data] of given.push || []) { helper.push(event, data); await sleep(200); }
    if (hash) {
      await ctx.page.evaluate((h) => { location.hash = h; }, "#" + hash);
      await sleep(100);
      for (const frame of ctx.page.frames()) {
        if (frame === ctx.page.mainFrame()) continue;
        for (let i = 0; i < 60; i++) {
          const s = await inPage(frame, () => document.body?.dataset.s).catch(() => undefined);
          if (s !== "connecting") break;
          await sleep(50);
        }
      }
      await sleep(200);
    }
    await ctx.page.screenshot({ path: out, fullPage: true });
    return { out, log: await ctx.harness.log(), live: await ctx.harness.live() };
  } finally {
    await ctx?.close();
    await helper?.close();
  }
}

async function main(args) {
  const flag = (name) => args.includes(name);
  const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  const page = args[0];
  if (!page || page.startsWith("--") || !pages().includes(page)) {
    console.error(`usage: node scripts/dev/ui-look.mjs <${pages().join("|")}> [--width 360] [--height 900] [--fixtures file.json] [--reduced-motion] [--no-bridge] [--no-native] [--hash name] [--out file.png]`);
    return 1;
  }
  const width = Number(value("--width", 360)), height = Number(value("--height", 900));
  const hash = flag("--hash") ? value("--hash", "") : "";
  const fixtures = flag("--fixtures") ? JSON.parse(readFileSync(value("--fixtures"), "utf8")) : lookFixtures(page);
  const out = value("--out", join(tmpdir(), `ui-look-${page}${hash ? `-${hash}` : ""}-${width}x${height}.png`));
  const runtime = process.env.PAIRBROWSE_TEST_RUNTIME || join(homedir(), ".pairbrowse", "runtime");
  let browser = null;
  try {
    browser = await patchright(runtime).chromium.launch();
    const r = await renderPage(browser, { page, width, height, fixtures, hash, reducedMotion: flag("--reduced-motion"), bridge: !flag("--no-bridge"), native: !flag("--no-native"), out });
    console.log(r.out);
    console.log(`harness log: ${r.log.length} entr${r.log.length === 1 ? "y" : "ies"}`);
    for (const e of r.log) console.log(`  ${e.kind}: ${e.text}`);
    console.log(`live: ${JSON.stringify(r.live)}`);
    return 0;
  } catch (e) {
    console.error(`could not render ${page}: ${e?.message || e}`);
    return 1;
  } finally {
    await browser?.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(await main(process.argv.slice(2)));
