// The window preview (scripts/dev/window-preview.mjs), a dev tool: its geometry and scene always;
// with PAIRBROWSE_TEST_RUNTIME, two real runs (default; --rail --reduced-motion) and their outputs.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { geometry, loadFixtures, resolveTimes, REGIONS, MOCKUP, HOST_GROUPS, FRAMES } from "../scripts/dev/window-preview.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const BAD = new Set(["error", "pageerror", "rejection", "csp"]);

test("window preview: geometry, regions and the scene", () => {
  const g = geometry();
  // 525's geometry, measured on the mockup: tab row 53, nav row 42 with the card right under it,
  // docks 205 and 346, inset 8 on the sides and the bottom, timeline 125.
  assert.deepEqual(g.strip, { x: 0, y: 0, w: 1536, h: 53 });
  assert.deepEqual(g.card, { x: 213, y: 95, w: 969, h: 796 });
  assert.deepEqual(g.nav, { x: 205, y: 53, w: 985, h: 42 });
  assert.deepEqual(g.left, { x: 0, y: 53, w: 205, h: 971 });
  assert.deepEqual(g.right, { x: 1190, y: 53, w: 346, h: 971 });
  assert.deepEqual(g.timeline, { x: 205, y: 899, w: 985, h: 125 });
  assert.equal(g.card.y + g.card.h + 8, g.timeline.y, "8 px between the card and the timeline");
  const r = geometry({ rail: true });
  assert.equal(r.card.w, 1432);
  assert.equal(r.card.h, 796);
  assert.equal(r.left.w, 44);
  assert.equal(r.right.w, 44);

  assert.deepEqual(REGIONS, ["strip", "nav", "left", "right", "timeline", "approval"]);
  for (const name of REGIONS) {
    const m = MOCKUP[name];
    assert.ok(m && m.x >= 0 && m.y >= 0 && m.x + m.w <= 1536 && m.y + m.h <= 1024, name);
  }

  const fx = loadFixtures();
  assert.equal(fx.shim.tabs.length, 3);
  assert.equal(fx.shim.tabs.filter((t) => t.active).length, 1);
  const cards = fx.helper.timeline.cards;
  assert.equal(cards.length, 6);
  for (const c of cards) {
    assert.match(c.id, /^[0-9a-f]{12}$/);
    assert.equal(fx.sample.steps.filter((s) => s.card === c.id).length, 1);
  }
  assert.equal(fx.helper.journal.done.length, 3);
  assert.equal(fx.helper.journal.left.length, 2);
  const people = fx.helper.board.people;
  assert.equal(people.length, 4);
  assert.ok(people.some((p) => p.who === "Claude Code" && p.color === "#E9763F"));
  assert.ok(people.some((p) => p.who === "Codex" && p.color === "#9B7BFA"), "Codex purple (the mockup's palette)");
  assert.ok(people.some((p) => p.who === "Gemini" && p.color === "#4B8FFB"), "Gemini blue");
  assert.deepEqual(fx.hud.peers.map((p) => [p.who, p.color]), [["Codex", "#9B7BFA"], ["Gemini", "#4B8FFB"]]);
  // The scene carries the bar the helper sends every page, and docked: in the native build the page
  // is told it is docked first (DESIGN.md Part G), so it draws no bottom bar.
  assert.ok(Array.isArray(fx.hud.bar?.items) && fx.hud.bar.items.length > 0, "the bar the helper sends every page");
  assert.equal(fx.hud.docked, true);
  const source = readFileSync(join(root, "scripts", "dev", "window-preview.mjs"), "utf8");
  const docked = source.indexOf('call(JSON.stringify({ on: true }), "docked")'), bar = source.indexOf('"bar");');
  assert.ok(docked > 0 && docked < bar, "the harness sends docked before the bar");
  assert.equal(fx.helper.approvals.pending.length, 1);
  // the mockup's sentence (the scene is the mockup's data; the card shows the reason it is given)
  assert.equal(fx.helper.approvals.pending[0].reason, "This will create a new Notion workspace with the information above.");
  assert.equal(fx.helper.session.storage.limit, 1e10, "the Storage row's figure, in the scene only");
  assert.deepEqual(HOST_GROUPS.localhost, ["nav-left", "nav-right", "timeline"]);
  assert.equal(HOST_GROUPS["127.0.0.1"].length, 4);
  assert.deepEqual([...HOST_GROUPS["127.0.0.1"], ...HOST_GROUPS.localhost].sort(), [...FRAMES].sort());

  const t = resolveTimes({ a: { t: -5, at: -2, updatedAt: -1000, n: -3 }, list: [{ t: -1 }] }, 10_000);
  assert.deepEqual(t, { a: { t: 9995, at: 9998, updatedAt: new Date(9000).toISOString(), n: -3 }, list: [{ t: 9999 }] });
  // "HH:MM" under t: that time today, or yesterday when still ahead
  const noon = new Date(2026, 9, 12, 12, 0).getTime();
  assert.equal(resolveTimes({ t: "10:24" }, noon).t, new Date(2026, 9, 12, 10, 24).getTime());
  assert.equal(resolveTimes({ t: "13:00" }, noon).t, new Date(2026, 9, 11, 13, 0).getTime());
});

// width and height from a PNG's IHDR.
function png(file) {
  const b = readFileSync(file);
  assert.equal(b.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

function run(extra, geo, more = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), "pb-wp-"));
  try {
    const r = spawnSync(process.execPath, ["scripts/dev/window-preview.mjs", "--out", dir, "--mockup", "ui/icon128.png", ...extra], { cwd: root, encoding: "utf8", timeout: 220_000 });
    assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.deepEqual(png(join(dir, "window.png")), { w: 1536, h: 1024 });
    assert.deepEqual(png(join(dir, "window@2x.png")), { w: 3072, h: 2048 });
    for (const f of ["contents.png", "contents@2x.png", "side-by-side.png", ...REGIONS.map((n) => join("regions", `${n}.png`))]) {
      const { w, h } = png(join(dir, f));
      assert.ok(w > 0 && h > 0, f);
    }
    for (const c of loadFixtures().helper.timeline.cards) assert.ok(existsSync(join(dir, "pictures", `${c.id}.jpg`)), c.id);
    const log = JSON.parse(readFileSync(join(dir, "harness-log.json"), "utf8"));
    assert.deepEqual(log.filter((e) => BAD.has(e.kind)), []);
    const frames = JSON.parse(readFileSync(join(dir, "frames.json"), "utf8"));
    assert.deepEqual(frames.frames.map((f) => f.name).sort(), [...FRAMES].sort());
    for (const f of frames.frames) assert.notEqual(f.s, "connecting", f.name);
    assert.ok(frames.streams.byHost["127.0.0.1"] <= 4);
    assert.ok(frames.streams.byHost.localhost <= 3);
    // One shared stream per helper host (ui/common.js helperStream); the nav fragments open none.
    assert.equal(frames.streams.total, extra.includes("--one-host") ? 1 : 2, "one event stream per helper host");
    for (const f of frames.frames.filter((x) => x.name.startsWith("nav-"))) assert.equal(f.live?.eventSources, 0, `${f.name} opens no stream`);
    assert.equal(frames.thumbs.loaded, frames.thumbs.cards, "every timeline picture loaded");
    for (const k of ["strip", "nav", "left", "right", "timeline", "card"]) assert.deepEqual(frames.rects[k], geo[k], k);
    more(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("window preview: the default run", { skip: !runtime, timeout: 240_000 }, () => run([], geometry()));
test("window preview: rails and reduced motion", { skip: !runtime, timeout: 240_000 }, () => run(["--rail", "--reduced-motion"], geometry({ rail: true })));
test("window preview: one helper host, one event stream", { skip: !runtime, timeout: 240_000 }, () => run(["--one-host"], geometry()));
// --plain: the same page as plain Chromium shows it (not docked), with the 30 px bottom bar.
test("window preview: --plain writes the plain-Chromium contents", { skip: !runtime, timeout: 240_000 }, () => run(["--one-host", "--plain"], geometry(), (dir) => {
  const plain = png(join(dir, "contents-plain.png")), docked = png(join(dir, "contents.png"));
  assert.deepEqual(plain, docked, "the contents card's size");
  // Docked, the page's bottom rows are the sample page; plain, the bar's navy (#0B1421 at 96%).
  assert.notDeepEqual(readFileSync(join(dir, "contents-plain.png")), readFileSync(join(dir, "contents.png")), "the bar shows only in the plain capture");
}));
