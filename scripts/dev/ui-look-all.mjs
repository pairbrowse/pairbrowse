#!/usr/bin/env node
// A dev tool, not plugin code: renders every visible page over the pages' harness to PNGs, at its
// DESIGN.md Part B size on the 1536 x 1024 window, for reviews (scripts/dev/ui-look.mjs renders one).
//   node scripts/dev/ui-look-all.mjs [--out dir] [--only a,b] [--reduced-motion]
// Each shot uses scripts/dev/look/<page>.json, a shot's shim merged over the file's. The default
// folder is <tmpdir>/pairbrowse-ui-look. Prints one line per shot (name, size, path, the number of
// error, pageerror, rejection and csp log entries); exit 1 when a shot failed to render or logged
// one of those. Sizes: the strip's tab row is 44 px; the docks 200 and 330 wide by 936 (1024 - 88);
// the contents area 1536 - 200 - 330 - 16 = 990 by 928; the timeline 130 tall; the approve card
// 360; the nav fragments 3 x 28 + 2 x 4 + 16 = 108; the switcher, Share and the menu their B widths.
// capture is left out: a hidden page with no UI.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { patchright } from "../../test/live.mjs";
import { merge } from "../../test/helpers/fake-helper.mjs";
import { renderPage, lookFixtures } from "./ui-look.mjs";

export const SHOTS = [
  { name: "strip", page: "strip", width: 1536, height: 44 },
  { name: "strip-nav-left", page: "strip", hash: "nav-left", width: 108, height: 44 },
  { name: "strip-nav-right", page: "strip", hash: "nav-right", width: 108, height: 44 },
  { name: "strip-switcher", page: "strip", hash: "switcher", width: 360, height: 560 },
  { name: "strip-share", page: "strip", hash: "share", width: 320, height: 420 },
  { name: "strip-menu", page: "strip", hash: "menu", width: 280, height: 320 },
  { name: "left", page: "left", width: 200, height: 936 },
  { name: "left-rail", page: "left", width: 44, height: 936, shim: { layout: { left: 1 } } },
  { name: "right", page: "right", width: 330, height: 936 },
  { name: "newtab", page: "newtab", width: 990, height: 928 },
  { name: "picker", page: "picker", width: 990, height: 928 },
  { name: "screen", page: "screen", width: 990, height: 928 },
  { name: "approve", page: "approve", width: 360, height: 300 },
  { name: "settings", page: "settings", width: 990, height: 928 },
  { name: "timeline", page: "timeline", width: 990, height: 130 },
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
      const file = lookFixtures(shot.page);
      const fixtures = shot.shim ? { ...file, shim: merge(file.shim || {}, shot.shim) } : file;
      try {
        const r = await renderPage(browser, { page: shot.page, width: shot.width, height: shot.height, fixtures, hash: shot.hash || "", reducedMotion: args.includes("--reduced-motion"), out });
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
