// The design tokens (ui/tokens.css): one sheet for every surface PairBrowse
// styles itself. hud.js and record.js carry the same values inline; this keeps every literal color
// in those files and the page sheets equal to a sheet value or a participant color, and checks
// WCAG AA contrast for the text colors in both schemes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const UI = "ui/";
const sheet = read(UI + "tokens.css");

// Custom properties in a block: { name: value }.
const props = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
const noComments = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
const dark = props(noComments.match(/^:root\s*\{([^}]*)\}/m)[1]);
const lightBlock = noComments.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\[data-scheme="system"\]\s*\{([^}]*)\}/);
const light = { ...dark, ...props(lightBlock ? lightBlock[1] : "") };

// "#abc", "#aabbcc", "rgb(1 2 3 / .5)", "rgba(1,2,3,.5)" -> "#rrggbb" (alpha ignored); else null.
function norm(c) {
  const s = String(c).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((x) => x + x).join("");
    return h.length >= 6 ? "#" + h.slice(0, 6) : null;
  }
  m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (m) return "#" + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
  return null;
}
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(norm(a)), lum(norm(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

const REQUIRED = ["bg", "chrome", "sidebar", "elevated", "hover", "ink", "ink-2", "muted", "edge", "accent", "accent-ink", "accent-soft",
  "edge-input", "ok", "warn", "bad", "spark", "sans", "mono", "fs-1", "fs-2", "fs-3", "fw-name", "r-1", "r-2", "r-3", "t"];
const PAGES = ["right/right.css", "picker/picker.css", "newtab/newtab.css", "screen/screen.css", "settings/settings.css"].map((x) => UI + x).concat("scripts/liveview.css");

test("the sheet has every token, dark by default and light only for the live view", () => {
  for (const k of REQUIRED) assert.ok(dark[k], `--${k}`);
  assert.ok(lightBlock, "a light block under :root[data-scheme=\"system\"]");
  for (const k of ["bg", "chrome", "sidebar", "elevated", "hover", "ink", "ink-2", "muted", "edge", "edge-input", "accent-ink", "ok", "warn", "bad"]) {
    assert.notEqual(light[k], dark[k], `light --${k}`);
  }
});

test("text colors meet WCAG AA on every surface, in both schemes", () => {
  for (const [scheme, t] of [["dark", dark], ["light", light]]) {
    for (const fg of ["ink", "ink-2", "muted", "accent-ink", "ok", "warn", "bad"]) {
      for (const bg of ["bg", "chrome", "sidebar", "elevated"]) {
        const r = contrast(t[fg], t[bg]);
        assert.ok(r >= 4.5, `${scheme}: --${fg} on --${bg} is ${r.toFixed(2)}:1`);
      }
    }
    for (const fg of ["muted", "accent-ink", "ink", "ink-2"]) {
      const r = contrast(t[fg], t.hover);
      assert.ok(r >= 3, `${scheme}: --${fg} on --hover is ${r.toFixed(2)}:1`);
    }
    for (const bg of ["bg", "chrome", "sidebar", "elevated"]) {
      const r = contrast(t["edge-input"], t[bg]);
      assert.ok(r >= 3, `${scheme}: a text field's border (--edge-input) on --${bg} is ${r.toFixed(2)}:1`);
    }
    const r = contrast(t.bg, t.accent);
    assert.ok(r >= 4.5, `${scheme}: primary button text (--bg on --accent) is ${r.toFixed(2)}:1`);
    for (const bg of ["bg", "chrome", "sidebar"]) {
      const r = contrast(t.spark, t[bg]);
      assert.ok(r >= 3, `${scheme}: the spark on the tab Claude works in (--spark on --${bg}) is ${r.toFixed(2)}:1`);
    }
  }
});

// oklch() literals allowed in the sheets: white or black with alpha (shadows, a scrim), the participant chip
// (its hue is var(--h)), and the live view's light loading skeleton, which stands for a page not yet drawn.
const SKELETON = new Set(["oklch(0.97 0.004 260)", "oklch(0.93 0.008 260)", "oklch(0.45 0.03 265)"]);
const oklchAllowed = (c) => /^oklch\((1|0) 0 0 \/ [\d.]+\)$/.test(c) || /var\(--h\b/.test(c) || SKELETON.has(c);

test("every literal color in the styled files is a sheet value, a participant color, white or black", async () => {
  const { SPARK_COLORS } = await import("../scripts/daemon/hud.mjs");
  const allowed = new Set(["#ffffff", "#000000", ...SPARK_COLORS.map(norm)]);
  for (const t of [dark, light]) for (const v of Object.values(t)) { const n = norm(v); if (n) allowed.add(n); }
  assert.equal(norm(dark.spark), norm(SPARK_COLORS[0]), "--spark is Claude's own spark color");
  const files = [UI + "right/right.css", UI + "picker/picker.css", UI + "newtab/newtab.css", UI + "screen/screen.css", UI + "settings/settings.css", "scripts/liveview.css", "scripts/hud.js", UI + "capture/record.js", "scripts/tabs.mjs"];
  for (const f of files) {
    const text = read(f).replace(/%23([0-9a-fA-F]{3,8})\b/g, "#$1");
    const found = [...text.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|oklch\((?:[^()]|\([^()]*\))*\)/g)].map(([m]) => m);
    assert.ok(found.length > 0 || f.endsWith("newtab.css") || f.endsWith("settings.css"), `${f} has colors`);
    for (const c of found) {
      if (c.startsWith("oklch")) { assert.ok(oklchAllowed(c), `${f}: ${c} is not a token value`); continue; }
      if (/var\(/.test(c)) continue;
      const n = norm(c);
      assert.ok(n && allowed.has(n), `${f}: ${c} is not a token value`);
    }
  }
});

test("every token in the sheet is read by a page", () => {
  const css = PAGES.map(read).join("\n");
  for (const k of Object.keys(dark)) assert.match(css, new RegExp(`var\\(--${k}\\b`), `--${k} is used`);
  for (const f of PAGES) assert.doesNotMatch(read(f), /font(-size)?:[^;]*\b1[123]px/, `${f}: type sizes come from --fs-1..3`);
});

test("a joiner's picture page keeps its muted text at AA on the pill, even over a white page", () => {
  const css = read(UI + "screen/screen.css");
  const m = css.match(/--pill:\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)/);
  assert.ok(m, "--pill is rgb(r g b / a)");
  const [r, g, b, a] = m.slice(1).map(Number);
  assert.equal(norm(`rgb(${r} ${g} ${b})`), norm(dark.bg), "--pill is the sheet's --bg");
  for (const under of [255, 0]) {
    const over = "#" + [r, g, b].map((c) => Math.round(c * a + under * (1 - a)).toString(16).padStart(2, "0")).join("");
    for (const fg of ["muted", "ink-2", "ink"]) {
      const c = contrast(dark[fg], over);
      assert.ok(c >= 4.5, `--${fg} on the pill over ${under ? "white" : "black"} is ${c.toFixed(2)}:1`);
    }
  }
});

test("no blur, no glass and no background picture", () => {
  for (const f of ["right/right.css", "picker/picker.css", "newtab/newtab.css", "screen/screen.css"].map((x) => UI + x).concat("scripts/liveview.css")) {
    const css = read(f);
    assert.doesNotMatch(css, /backdrop-filter/, f);
    assert.doesNotMatch(css, /ntp\.png/, f);
    assert.doesNotMatch(css, /^\s*:root\s*\{[^}]*--(?!pill)[a-z-]+\s*:/m, `${f} has no tokens of its own (screen.css keeps --pill)`);
  }
  assert.equal(existsSync(root + UI + "ntp.png"), false);
  assert.equal(existsSync(root + UI + "newtab/ntp.png"), false);
  const opening = read("scripts/tabs.mjs");
  for (const re of [/backdrop-filter/, /gradient\(/, /@keyframes/, /inset 0/]) assert.doesNotMatch(opening, re, "the Opening tabs page is flat");
});

test("every page links the sheet before its own", () => {
  for (const page of ["right", "picker", "newtab", "screen"]) {
    const html = read(`${UI}${page}/index.html`);
    const a = html.indexOf('<link rel="stylesheet" href="../tokens.css">'), b = html.indexOf(`href="${page}.css"`);
    assert.ok(a >= 0 && b > a, `${page}.html`);
  }
  const lv = read("scripts/liveview.html");
  const a = lv.indexOf('<link rel="stylesheet" href="assets/tokens.css">'), b = lv.indexOf('href="assets/liveview.css"');
  assert.ok(a >= 0 && b > a, "liveview.html");
  assert.match(lv, /<html[^>]*\sdata-scheme="system"/);
});

test("the window frame's seed is the sheet's chrome navy", async () => {
  const { THEME_COLOR } = await import("../scripts/browser.mjs");
  assert.equal("#" + (THEME_COLOR >>> 0).toString(16).slice(2), norm(dark.chrome));
});

test("text that sits on --hover takes --ink-2, which keeps AA there (muted does not)", () => {
  for (const [scheme, t] of [["dark", dark], ["light", light]]) {
    const r = contrast(t["ink-2"], t.hover);
    assert.ok(r >= 4.5, `${scheme}: --ink-2 on --hover is ${r.toFixed(2)}:1`);
  }
  const css = read("scripts/liveview.css").replace(/\/\*[\s\S]*?\*\//g, "");
  const rule = css.match(/([^{}]*\.overview \[aria-current="true"\] \.last[^{}]*)\{([^}]*)\}/);
  assert.ok(rule && /color:\s*var\(--ink-2\)/.test(rule[2]), "the current tab's last action is --ink-2");
  assert.match(rule[1], /\.activity li:not\(:first-child\) code/, "older actions' code chips are --ink-2");
});

test("Claude's owner dot in the live view is the sheet's --spark, like the spark beside it", async () => {
  const { SPARK_COLORS } = await import("../scripts/daemon/hud.mjs");
  const js = read("scripts/liveview.js");
  assert.ok(js.toLowerCase().includes(`=== "${SPARK_COLORS[0].toLowerCase()}" ? "var(--spark)"`));
});

test("the Opening tabs page says each row's state in text, not by color alone", async () => {
  const { loadingHtml } = await import("../scripts/tabs.mjs");
  const html = loadingHtml([{ url: "https://example.com/", title: "Example" }]);
  for (const s of ["waiting", "opening", "failed"]) assert.match(html, new RegExp(`li\\[data-s=${s}\\] \\.h::before\\{content:"${s} · "`), s);
  assert.doesNotMatch(html, /--card\b/, "the sheet's name, --sidebar");
});
