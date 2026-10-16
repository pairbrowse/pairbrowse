#!/usr/bin/env node
// A dev tool, not plugin code: the page references for the engine's own surfaces (the native shell's
// plan 560, D5). Each is a 1x render of a shipped ui/ page, over the pages' harness (the fake
// helper and the ui server from test/helpers) with the window preview's scene
// (scripts/dev/preview/fixtures.json), so a reference can't drift from the page it stands for:
//   menu         the left dock's session switcher popover (ui/left served without the browser's API,
//                opened by its Sessions row) over the framed session picker, its first session
//                row hovered (the selected row); the popover plus PAD px of the dock around it (its
//                1 px ring, 10 px corners, the caret at the row's icon above it), the dock's other
//                parts hidden so the margin is the dock's own background alone
//   bubble       the approval card in bubble mode (ui/approve on pairbrowse.top-chrome, be9327f),
//                the scene's click approval; the whole card, as the native bubble shows it
//   field        the share card's field (ui/strip#share, "Your first name" after the helper asked
//                for a name, "Ada" typed, not focused), plus PAD px of the card around it
//   field-focus  the same field focused
//   buttons      Allow and Deny on the approval card (rest), plus PAD px of the card around them
//   PAIRBROWSE_TEST_RUNTIME=~/.pairbrowse/runtime node scripts/dev/surface-refs.mjs [--out <dir>]
// Writes <out>/<name>.png for each and <out>/references.json: per reference its file and size,
// the surface's box inside the PNG, the corner radius (computed, with its sheet token) and the
// colors in look.json's "surfaces" vocabulary (fill, text, border, selectedRow, primaryButton,
// button, buttonText, primaryText): each the sheet token, its expected hex, and where a pixel
// shows it, the point (PNG pixels), the sampled hex, the largest channel difference and pass
// (within TOLERANCE); text is expected only (glyphs are anti-aliased). "surfaces" maps the
// native harness's surface names (the native build's look harness, its --surface) to their references.
// The default out is .cache/surface-refs/ in this checkout (ignored by git), so the native
// harness reads the same place every run. Dark only: the pages are dark and the browser's color
// mixer ignores the system mode (560, "Where the look comes from today"). Exit 1 on a page error,
// rejection or CSP entry, a size that is not the expected one, or a sampled color off its token.
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchright, inPage } from "../../test/helpers/live.mjs";
import { startFakeHelper, merge } from "../../test/helpers/fake-helper.mjs";
import { startUiServer } from "../../test/helpers/ui-server.mjs";
import { defaultFixture } from "../../test/helpers/pairbrowse-shim.mjs";
import { hostProxy } from "../../test/helpers/ui-page.mjs";
import { loadFixtures, resolveTimes, until } from "./window-preview.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..");
export const DEFAULT_OUT = join(REPO, ".cache", "surface-refs");
export const PAD = 8; // px of the page around a part (menu, field, buttons): its edge and corners show
export const TOLERANCE = 3; // per channel, as 560 D5's numbers
const TOP_SHELL = "pairbrowse.top-chrome";
const BAD_KINDS = new Set(["error", "pageerror", "rejection", "csp"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each reference's PNG size at 1x; null: set by the page's content (the card's height).
export const REFERENCES = {
  menu: { w: 360 + 2 * PAD, h: 560 + 2 * PAD },
  bubble: { w: 364, h: null },
  field: { w: 296 + 2 * PAD, h: 32 + 2 * PAD },
  "field-focus": { w: 296 + 2 * PAD, h: 32 + 2 * PAD },
  buttons: { w: 86 + 12 + 88 + 2 * PAD, h: 32 + 2 * PAD }, // Allow 86, Deny 88 (measured to the mockup, 3a0f824)
};
// The native harness's surfaces (560's table) and the page parts they are put beside (D5): menus
// with the switcher popover, bubbles and dialogs with the approval card, text fields with the
// share card's field, buttons with Allow and Deny. The rest have no page part.
export const SURFACES = {
  "app-menu": ["menu"], "context-menu": ["menu"], "omnibox-popup": ["menu"],
  permission: ["bubble", "buttons"], download: ["bubble"], bookmark: ["bubble", "field", "field-focus", "buttons"],
  find: ["field", "field-focus"], tooltip: [], "dialog-alert": ["bubble", "buttons"], "dialog-auth": ["bubble", "field", "field-focus", "buttons"],
  "dialog-leave": ["bubble", "buttons"], "page-info": ["bubble"], status: [], infobar: [], extensions: ["bubble"], fullscreen: [],
  settings: [], history: [], "downloads-page": [], "bookmarks-page": [],
};
// The session switcher's rows (the picker's own data shape, as the left dock's tests give it).
const SESSIONS = { picking: false, sessions: [
  { name: "Notion Setup", tabs: 3, sites: ["notion.so", "github.com"], current: true,
    live: [{ who: "Claude", app: "Claude Code", kind: "agent" }],
    people: [{ who: "You", kind: "you", computer: "Mac" }, { who: "Claude", app: "Claude Code", kind: "agent" }] },
  { name: "Shop", tabs: 1, sites: ["shop.example"], people: [{ who: "You", kind: "you", computer: "Mac" }] },
  { name: "default", tabs: 0, sites: [], people: [] },
] };

const hex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();

// In a page: a CSS color (a token's var() or a literal) as the page computes it -> [r, g, b].
async function resolveColors(page, list) {
  return page.evaluate((items) => items.map((c) => {
    const p = document.createElement("i");
    p.style.color = c;
    document.documentElement.append(p);
    const m = getComputedStyle(p).color.match(/[\d.]+/g).map(Number);
    p.remove();
    return m.slice(0, 3).map(Math.round);
  }), list);
}
// The radius tokens of the sheet, by px.
async function radiusToken(page, px) {
  const names = ["--r-1", "--r-2", "--r-3"];
  const values = await page.evaluate((n) => n.map((k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim()), names);
  const i = values.indexOf(`${px}px`);
  return i >= 0 ? names[i] : null;
}

// The pixels at points of a PNG (decoded by the browser itself) -> [[r, g, b], ...].
async function samplePixels(browser, png, points) {
  const page = await browser.newPage({ viewport: { width: 64, height: 64 } });
  try {
    return await page.evaluate(async ([b64, pts]) => {
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d", { colorSpace: "srgb" });
      g.drawImage(bmp, 0, 0);
      return pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3)));
    }, [png.toString("base64"), points]);
  } finally {
    await page.close().catch(() => {});
  }
}

// One reference: the clip's PNG, its size, and each color's token, expected, point and sample.
// colors: { name: { token (a CSS custom property or a literal), at: [x, y] in page px, or null } }.
async function reference(browser, page, name, { clip, box, radius, colors, page: from, state }) {
  const png = await page.screenshot({ type: "png", clip });
  const names = Object.keys(colors);
  const expected = await resolveColors(page, names.map((k) => (colors[k].token.startsWith("--") ? `var(${colors[k].token})` : colors[k].token)));
  const sampledAt = names.filter((k) => colors[k].at).map((k) => [Math.round(colors[k].at[0] - clip.x), Math.round(colors[k].at[1] - clip.y)]);
  const sampled = await samplePixels(browser, png, sampledAt);
  const out = {};
  let j = 0;
  names.forEach((k, i) => {
    const want = expected[i];
    const entry = { token: colors[k].token, expected: hex(want) };
    if (colors[k].at) {
      const got = sampled[j], at = sampledAt[j++];
      const delta = Math.max(...got.map((v, c) => Math.abs(v - want[c])));
      Object.assign(entry, { at, sampled: hex(got), delta, pass: delta <= TOLERANCE });
    } else Object.assign(entry, { at: null, sampled: null });
    out[k] = entry;
  });
  return {
    png,
    entry: {
      file: `${name}.png`, width: clip.width, height: clip.height, page: from, state,
      box: { x: Math.round(box.x - clip.x), y: Math.round(box.y - clip.y), w: Math.round(box.w), h: Math.round(box.h) },
      radius: { px: radius, token: await radiusToken(page, radius) },
      colors: out,
    },
  };
}

const rectIn = (page, sel) => page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; }, sel);
const radiusOf = (page, sel) => page.evaluate((s) => parseFloat(getComputedStyle(document.querySelector(s)).borderTopLeftRadius), sel);
const padded = (r, p = PAD) => ({ x: Math.round(r.x) - p, y: Math.round(r.y) - p, width: Math.round(r.w) + 2 * p, height: Math.round(r.h) + 2 * p });
// A page's harness log entries (the prelude's), tagged with the page.
async function harnessLog(target, label, log) {
  const entries = await inPage(target, () => window.__harness?.log || [{ kind: "error", text: "harness missing" }]).catch(() => [{ kind: "error", text: "harness missing" }]);
  for (const e of entries) log.push({ page: label, kind: e.kind, text: e.text });
}
async function newPage(browser, viewport, label, log) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 1, reducedMotion: "reduce" });
  page.on("pageerror", (e) => log.push({ page: label, kind: "pageerror", text: String(e).slice(0, 500) }));
  return page;
}

// menu: the left dock's switcher popover, opened by its Sessions row (served without the browser's
// API, a plain browser: in the browser the row opens the browser's own bubble), the picker framed
// in it with its first session row hovered.
async function renderMenu(browser, { ui, log }) {
  const page = await newPage(browser, { width: 420, height: 936 }, "left (switcher)", log);
  try {
    await page.goto(ui.url("left"), { waitUntil: "load" });
    if (!await until(page, () => document.body.dataset.dock === "open", 5000)) throw new Error("the left dock did not lay out");
    await page.click("#nav-sessions");
    let frame = null;
    for (let i = 0; i < 100 && !frame; i++) {
      const f = page.frames().find((x) => x.url().includes("/picker/index.html"));
      if (f && await inPage(f, () => document.documentElement.dataset.mount === "frame" && document.body?.dataset.s === "ready").catch(() => false)) frame = f;
      else await sleep(50);
    }
    if (!frame) throw new Error("the framed picker did not load");
    const row = await frame.locator(".sessions .choice").first().boundingBox();
    if (!row) throw new Error("no session row in the picker");
    await page.mouse.move(row.x + row.width - 40, row.y + row.height / 2);
    // The clip's margin shows the dock under the popover only: the dock's other parts (its rows and
    // sections) are hidden from the render, nothing else is touched.
    await page.evaluate(() => { for (const el of document.body.children) if (el.id !== "switcher" && el.tagName !== "SCRIPT") el.style.visibility = "hidden"; });
    await sleep(400);
    const pop = await rectIn(page, "#switcher");
    const result = await reference(browser, page, "menu", {
      clip: padded(pop), box: pop, radius: await radiusOf(page, "#switcher"),
      page: "ui/left: the session switcher popover (#switcher, from the Sessions row) over the framed ui/picker", state: "open; the first session row hovered; the dock's other parts hidden",
      colors: {
        fill: { token: "--sidebar", at: [pop.x + 6, pop.y + pop.h / 2] },
        text: { token: "--ink", at: null },
        border: { token: "--edge", at: [pop.x - 1, pop.y + pop.h / 2] },
        selectedRow: { token: "--hover", at: [row.x + 4, row.y + row.height / 2] },
      },
    });
    await harnessLog(page, "left (switcher)", log);
    await harnessLog(frame, "picker (framed)", log);
    return [["menu", result]];
  } finally {
    await page.close().catch(() => {});
  }
}

// field and field-focus: the share card alone (the strip's #share bubble), its name field shown
// the way the helper asks for it (an invite without a name).
async function renderField(browser, { ui, log }) {
  const page = await newPage(browser, { width: 320, height: 400 }, "strip (share)", log);
  try {
    await page.goto(ui.url("strip") + "#share", { waitUntil: "load" });
    if (!await until(page, () => document.body.dataset.s === "live" && document.body.dataset.mode === "share" && !document.getElementById("share-card").hidden, 5000)) throw new Error("the share card did not open");
    await page.click("#share-make");
    if (!await until(page, () => !document.getElementById("share-name-row").hidden && document.activeElement?.id === "share-name", 5000)) throw new Error("the name field did not show");
    await page.keyboard.type("Ada");
    await sleep(300);
    const f = await rectIn(page, "#share-name");
    const radius = await radiusOf(page, "#share-name");
    const shot = (name, state, border) => reference(browser, page, name, {
      clip: padded(f), box: f, radius, page: "ui/strip#share: the share card's name field (.field)", state,
      colors: {
        fill: { token: "--frame", at: [f.x + 4, f.y + f.h / 2] },
        text: { token: "--ink", at: null },
        border: { token: border, at: [f.x, f.y + f.h / 2] },
      },
    });
    const focused = await shot("field-focus", "focused, \"Ada\" typed", "--accent");
    await page.evaluate(() => document.activeElement?.blur());
    await sleep(300);
    const rest = await shot("field", "not focused, \"Ada\" typed", "--edge-input");
    await harnessLog(page, "strip (share)", log);
    return [["field", rest], ["field-focus", focused]];
  } finally {
    await page.close().catch(() => {});
  }
}

// bubble and buttons: the approve page on the top-chrome host (its bubble mode), the scene's click.
async function renderBubble(browser, { log }) {
  const page = await newPage(browser, { width: 364, height: 600 }, "approve (bubble)", log);
  try {
    await page.goto(`http://${TOP_SHELL}/approve/index.html`, { waitUntil: "load" });
    if (!await until(page, () => document.documentElement.dataset.mode === "bubble" && Number(document.body.dataset.pending) >= 1 && !document.getElementById("card").hidden, 5000)) throw new Error("the approval card did not show");
    await sleep(1000); // the open and the arm (approve.js ARM_MS)
    const card = await rectIn(page, "#card");
    const allow = await rectIn(page, "#allow"), deny = await rectIn(page, "#deny");
    const bubble = await reference(browser, page, "bubble", {
      clip: { x: Math.round(card.x), y: Math.round(card.y), width: Math.round(card.w), height: Math.round(card.h) }, box: card, radius: await radiusOf(page, "#card"),
      page: "ui/approve in bubble mode (pairbrowse.top-chrome): the approval card", state: "the scene's click approval, armed",
      colors: {
        fill: { token: "--panel", at: [card.x + 6, card.y + card.h / 2] },
        text: { token: "--ink", at: null },
        border: { token: "--edge-btn", at: [card.x, card.y + card.h / 2] },
        primaryButton: { token: "--accent-fill", at: [allow.x + 6, allow.y + allow.h / 2] },
      },
    });
    const both = { x: allow.x, y: allow.y, w: deny.x + deny.w - allow.x, h: allow.h };
    const buttons = await reference(browser, page, "buttons", {
      clip: padded(both), box: both, radius: await radiusOf(page, "#allow"),
      page: "ui/approve in bubble mode: Allow (primary) and Deny (plain)", state: "rest",
      colors: {
        primaryButton: { token: "--accent-fill", at: [allow.x + 6, allow.y + allow.h / 2] },
        primaryText: { token: (await page.evaluate(() => getComputedStyle(document.getElementById("allow")).color)), at: null },
        button: { token: "--panel", at: [deny.x + 6, deny.y + deny.h / 2] },
        buttonText: { token: "--ink", at: null },
        border: { token: "--edge-btn", at: [deny.x, deny.y + deny.h / 2] },
      },
    });
    await harnessLog(page, "approve (bubble)", log);
    return [["bubble", bubble], ["buttons", buttons]];
  } finally {
    await page.close().catch(() => {});
  }
}

export async function main(args) {
  const value = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : null; };
  if (args.includes("--help") || args.some((a) => a.startsWith("--") && a !== "--out")) {
    console.error("usage: node scripts/dev/surface-refs.mjs [--out <dir>]");
    return 2;
  }
  const out = value("--out") || DEFAULT_OUT;
  const runtime = process.env.PAIRBROWSE_TEST_RUNTIME || join(homedir(), ".pairbrowse", "runtime");
  const fx = resolveTimes(loadFixtures(), Date.now());
  mkdirSync(out, { recursive: true });

  const log = [];
  let helper = null, ui = null, plain = null, proxy = null, browser = null, failed = false;
  try {
    helper = await startFakeHelper({ pageOrigin: null, fixtures: { ...fx.helper, sessions: SESSIONS } });
    ui = await startUiServer({ helper, fixture: { ...merge(defaultFixture(), fx.shim), owners: fx.shim.owners } });
    // The pages without window.pairbrowse (a plain browser): the left dock's framed switcher.
    plain = await startUiServer({ helper, native: false });
    proxy = await hostProxy(TOP_SHELL);
    proxy.to(ui.origin);
    browser = await patchright(runtime).chromium.launch({ args: proxy.args });

    const results = [];
    helper.setPageOrigin(plain.origin);
    results.push(...await renderMenu(browser, { ui: plain, log }));
    helper.setPageOrigin(ui.origin);
    results.push(...await renderField(browser, { ui, log }));
    helper.setPageOrigin(`http://${TOP_SHELL}`);
    results.push(...await renderBubble(browser, { log }));

    const references = {};
    for (const name of Object.keys(REFERENCES)) {
      const r = results.find(([n]) => n === name)?.[1];
      if (!r) { console.log(`${name}: not rendered`); failed = true; continue; }
      writeFileSync(join(out, r.entry.file), r.png);
      references[name] = r.entry;
      const want = REFERENCES[name];
      const sizeOk = r.entry.width === want.w && (want.h === null || r.entry.height === want.h);
      if (!sizeOk) { console.log(`${name}: ${r.entry.width} x ${r.entry.height}, expected ${want.w} x ${want.h ?? "any"}`); failed = true; }
      console.log(`${join(out, r.entry.file)}  ${r.entry.width} x ${r.entry.height}, radius ${r.entry.radius.px}${r.entry.radius.token ? ` (${r.entry.radius.token})` : ""}`);
      for (const [k, c] of Object.entries(r.entry.colors)) {
        console.log(`  ${k} ${c.token} ${c.expected}${c.at ? ` sampled ${c.sampled} at ${c.at.join(",")} ${c.pass ? "ok" : `off by ${c.delta}`}` : ""}`);
        if (c.at && !c.pass) failed = true;
      }
    }
    const bad = log.filter((e) => BAD_KINDS.has(e.kind));
    for (const e of bad) console.log(`  ${e.page} ${e.kind}: ${e.text}`);
    if (bad.length) failed = true;
    const file = join(out, "references.json");
    writeFileSync(file, JSON.stringify({ scale: 1, scheme: "dark", tolerance: TOLERANCE, pad: PAD, references, surfaces: SURFACES, log, pass: !failed }, null, 2) + "\n");
    console.log(file);
  } catch (e) {
    console.error(`could not render the references: ${e?.stack || e}`);
    failed = true;
  } finally {
    await browser?.close().catch(() => {});
    await proxy?.close();
    await ui?.close();
    await plain?.close();
    await helper?.close();
  }
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(await main(process.argv.slice(2)));
