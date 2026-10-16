#!/usr/bin/env node
// A dev tool, not plugin code: renders every visible page over the pages' harness to PNGs, at its
// DESIGN.md Part B size on the 1536 x 1024 window, for reviews (scripts/dev/ui-look.mjs renders one).
//   node scripts/dev/ui-look-all.mjs [--out dir] [--only a,b] [--reduced-motion]
// Each shot uses scripts/dev/look/<page>.json, a shot's shim merged over the file's. The default
// folder is <tmpdir>/pairbrowse-ui-look. Prints one line per shot (name, size, path, the number of
// error, pageerror, rejection and csp log entries); exit 1 when a shot failed to render or logged
// one of those. Sizes: 525's window (DESIGN.md B1, the window preview's geometry): the strip's tab
// row 1536 x 47; the docks 205 and 346 wide by 977 (1024 - 47), both rails 44 by 977; the contents
// card 969 x 802; the timeline 985 x 125; the approve card 360; the nav fragments 3 x 28 + 2 x 4 +
// 16 = 108; Share its B width. right-extension is the right dock as
// the open build's side panel shows it (no window.pairbrowse: the header, Share in the session
// card, the Live pill, the You row, the profile sections in Tools); the *-empty shots have a
// helper connected and nothing in the scene (no people, steps, cards or approvals; one new tab).
// capture is left out: a hidden page with no UI.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { patchright } from "../../test/helpers/live.mjs";
import { merge } from "../../test/helpers/fake-helper.mjs";
import { renderPage, lookFixtures } from "./ui-look.mjs";

// A helper connected, nothing in it: its default fixtures, and the browser with one new tab and no owners.
export const EMPTY = { helper: {}, shim: { tabs: [{
  id: 21, index: 0, window: 1, title: "New tab", url: "chrome://pairbrowse/newtab", favicon: null, defaultFavicon: true, networkState: 0,
  muted: false, audible: false, pinned: false, group: null, groupTitle: null, groupColor: null,
  active: true, selected: true, blocked: false, width: 1280, height: 800, targetId: "T21", canGoBack: false, canGoForward: false,
}], owners: { agents: [], colors: [] } } }; // empty lists replace the default owners whole (merge keeps an object's keys)
export const SHOTS = [
  { name: "strip", page: "strip", width: 1536, height: 47 },
  { name: "strip-nav-left", page: "strip", hash: "nav-left", width: 108, height: 44 },
  { name: "strip-nav-right", page: "strip", hash: "nav-right", width: 108, height: 44 },
  { name: "strip-share", page: "strip", hash: "share", width: 320, height: 420 },
  { name: "strip-empty", page: "strip", width: 1536, height: 47, fixtures: EMPTY },
  { name: "left", page: "left", width: 205, height: 977 },
  { name: "left-rail", page: "left", width: 44, height: 977, shim: { layout: { left: 1 } } },
  { name: "left-empty", page: "left", width: 205, height: 977, fixtures: EMPTY },
  { name: "right", page: "right", width: 346, height: 977 },
  { name: "right-rail", page: "right", width: 44, height: 977, shim: { layout: { right: 1 } } },
  { name: "right-empty", page: "right", width: 346, height: 977, fixtures: EMPTY },
  { name: "right-extension", page: "right", width: 346, height: 977, native: false },
  { name: "newtab", page: "newtab", width: 969, height: 802 },
  { name: "picker", page: "picker", width: 969, height: 802 },
  { name: "screen", page: "screen", width: 969, height: 802 },
  { name: "approve", page: "approve", width: 360, height: 300 },
  { name: "settings", page: "settings", width: 969, height: 802 },
  { name: "sessions", page: "sessions", width: 969, height: 802 },
  { name: "activity", page: "activity", width: 969, height: 802 },
  { name: "timeline", page: "timeline", width: 985, height: 125 },
];
const BAD = new Set(["error", "pageerror", "rejection", "csp"]);

async function main(args) {
  const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
  const dir = value("--out", join(tmpdir(), "pairbrowse-ui-look"));
  const only = args.includes("--only") ? new Set(value("--only", "").split(",").filter(Boolean)) : null;
  const shots = only ? SHOTS.filter((s) => only.has(s.name)) : SHOTS;
  if (only && shots.length !== only.size) {
    console.error(`unknown shot: ${[...only].filter((n) => !SHOTS.some((s) => s.name === n)).join(", ")} (shots: ${SHOTS.map((s) => s.name).join(", ")})`);
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  const runtime = process.env.PAIRBROWSE_TEST_RUNTIME || join(homedir(), ".pairbrowse", "runtime");
  let code = 0;
  const browser = await patchright(runtime).chromium.launch();
  try {
    for (const shot of shots) {
      const out = join(dir, `${shot.name}.png`);
      const file = shot.fixtures || lookFixtures(shot.page);
      const fixtures = shot.shim ? { ...file, shim: merge(file.shim || {}, shot.shim) } : file;
      try {
        const r = await renderPage(browser, { page: shot.page, width: shot.width, height: shot.height, fixtures, hash: shot.hash || "", reducedMotion: args.includes("--reduced-motion"), native: shot.native !== false, out });
        const bad = r.log.filter((e) => BAD.has(e.kind));
        console.log(`${shot.name} ${shot.width}x${shot.height} ${out} ${bad.length}`);
        for (const e of bad) console.log(`  ${e.kind}: ${e.text}`);
        if (bad.length) code = 1;
      } catch (e) {
        console.log(`${shot.name} ${shot.width}x${shot.height} could not render: ${e?.message || e}`);
        code = 1;
      }
    }
  } finally {
    await browser.close();
  }
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(await main(process.argv.slice(2)));
