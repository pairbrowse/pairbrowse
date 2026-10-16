// WCAG AA contrast of the design tokens (ui/tokens.css) in every variant the sheet has: dark (the
// default), light (the live view under a light system scheme), and each of them under increased
// contrast (prefers-contrast: more). Text pairs need 4.5:1, UI parts (a field's border, a button's
// ring, the focus ring) 3:1 (WCAG 1.4.3 and 1.4.11). The pairs are a declared list plus every
// rule in the page sheets that sets both a token color and a token background, so a new pairing
// in a page is checked without being listed here. Only the standard library: the sheet is parsed
// here, var() chains resolved, and translucent fills laid over the surface under them.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(root + p, "utf8");
const strip = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const sheet = strip(read("ui/tokens.css"));

// ---- the sheet: blocks of custom properties, by the at-rule they sit under ----
// Returns [{ media, selector, props }] in source order; media is "" at the top level.
function blocks(css) {
  const out = [];
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf("{", i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (j < text.length && depth) { if (text[j] === "{") depth++; else if (text[j] === "}") depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith("@media")) walk(body, head.slice(6).trim());
      else if (!head.startsWith("@")) {
        const props = Object.fromEntries([...body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
        if (Object.keys(props).length) out.push({ media, selector: head, props });
      }
      i = j;
    }
  };
  walk(css, "");
  return out;
}
const BLOCKS = blocks(sheet);
const LIGHT = /prefers-color-scheme:\s*light/, MORE = /prefers-contrast:\s*more/;
// A block applies to a variant when its media query is one the variant matches (every feature
// named in it), and its selector matches the root the variant renders: the extension pages are
// plain :root, the live view :root[data-scheme="system"] (only that page follows a light scheme).
const VARIANTS = {
  dark: { light: false, more: false, scheme: false },
  light: { light: true, more: false, scheme: true },
  "dark, more contrast": { light: false, more: true, scheme: false },
  "light, more contrast": { light: true, more: true, scheme: true },
};
function tokens(v) {
  const t = {};
  for (const b of BLOCKS) {
    if (LIGHT.test(b.media) && !v.light) continue;
    if (MORE.test(b.media) && !v.more) continue;
    if (b.media && !LIGHT.test(b.media) && !MORE.test(b.media)) continue; // reduced motion and the like
    const sels = b.selector.split(",").map((s) => s.trim());
    if (!sels.some((s) => s === ":root" || (v.scheme && s === ':root[data-scheme="system"]'))) continue;
    Object.assign(t, b.props);
  }
  return t;
}
// var(--x) and var(--x, fallback), followed through every link.
function resolve(t, value, seen = new Set()) {
  return String(value).replace(/var\(\s*--([a-z0-9-]+)\s*(?:,\s*([^()]*))?\)/g, (_, k, fb) => {
    if (seen.has(k)) throw new Error(`--${k} refers to itself`);
    if (t[k] === undefined) { assert.ok(fb !== undefined, `--${k} is not a token`); return resolve(t, fb, seen); }
    return resolve(t, t[k], new Set([...seen, k]));
  });
}
const T = Object.fromEntries(Object.entries(VARIANTS).map(([name, v]) => {
  const raw = tokens(v);
  return [name, Object.fromEntries(Object.keys(raw).map((k) => [k, resolve(raw, `var(--${k})`)]))];
}));

// ---- colors ----
// "#rgb", "#rrggbb", "#rrggbbaa", "rgb(r g b / a)", "rgba(r, g, b, a)" -> [r, g, b, a]; else null.
function rgba(c) {
  const s = String(c).trim().toLowerCase();
  let m = s.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((x) => x + x).join("");
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1);
  }
  m = s.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : +m[4]];
  return null;
}
const over = (top, under) => top.slice(0, 3).map((c, i) => c * top[3] + under[i] * (1 - top[3])).concat(1);
const lum = ([r, g, b]) => {
  const [R, G, B] = [r, g, b].map((v) => v / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
};
// The contrast of fg on bg laid over the page surface `base` (for a translucent bg or fg).
function contrast(t, fg, bg, base = "bg") {
  const color = (k) => { const c = rgba(t[k] ?? k); assert.ok(c, `${k} (${t[k]}) is a color`); return c; };
  const under = color(base);
  const b = over(color(bg), under), f = over(color(fg), b);
  const [x, y] = [lum(f), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// ---- the pairs ----
// Only the live view follows a light scheme; the extension pages under ui/ are always dark. So the
// light variants check the live view's sheet and the surfaces the light block sets.
const DARK_ONLY = new Set(["dark", "dark, more contrast"]);
// Opaque surfaces text sits on, and the text colors.
const SURFACES = ["bg", "chrome", "sidebar", "elevated", "panel", "inset", "column", "btn"];
const LIGHT_SURFACES = ["bg", "chrome", "sidebar", "elevated"];
const TEXT = ["ink", "ink-2", "muted", "accent-ink"];
// State colors are text too (an error line, a warning, "connected"), on the page surfaces.
const STATE = ["ok", "warn", "bad"];
const PAGE = ["bg", "chrome", "sidebar", "elevated"];
// Declared pairs for a variant: [kind, fg, bg]. Text is 4.5:1, ui 3:1.
const declared = (variant) => {
  const surfaces = DARK_ONLY.has(variant) ? SURFACES : LIGHT_SURFACES;
  return [
    ...TEXT.flatMap((fg) => surfaces.map((bg) => ["text", fg, bg])),
    ...STATE.flatMap((fg) => PAGE.map((bg) => ["text", fg, bg])),
    ...["ink", "ink-2"].map((fg) => ["text", fg, "hover"]),
    // A text field's border and the focus ring (2 px of --accent) on every surface; a plain
    // button's ring on the surfaces buttons sit on (its label names it, the ring only frames it).
    ...surfaces.flatMap((bg) => [["ui", "edge-input", bg], ["ui", "accent", bg]]),
    ...["bg", "chrome", "sidebar", "panel"].map((bg) => ["ui", "edge-btn", bg]),
    ["ui", "spark", "bg"], ["ui", "spark", "chrome"], ["ui", "spark", "sidebar"],
    // Primary buttons: white on the accent fill (Allow, Save, the new tab's Ask), at rest and hovered.
    ["text", "#ffffff", "accent-fill"], ["text", "#ffffff", "accent-fill-hover"],
    ["text", "bg", "accent"],
  ];
};
// Pairs the page sheets make: a rule that sets `color: var(--x)` and `background: var(--y)`.
const SHEETS = readdirSync(root + "ui", { withFileTypes: true }).filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(root + "ui/" + d.name).filter((f) => f.endsWith(".css")).map((f) => `ui/${d.name}/${f}`))
  .concat("scripts/liveview.css");
function usedPairs() {
  const out = new Map();
  for (const f of SHEETS) {
    for (const [, sel, body] of strip(read(f)).matchAll(/([^{}]*)\{([^{}]*)\}/g)) {
      const fg = body.match(/(?:^|;)\s*color\s*:\s*var\(--([a-z0-9-]+)\)\s*(?:!important\s*)?(?:;|$)/)?.[1];
      const bg = body.match(/(?:^|;)\s*background(?:-color)?\s*:\s*var\(--([a-z0-9-]+)\)\s*(?:!important\s*)?(?:;|$)/)?.[1];
      if (!fg || !bg) continue;
      const key = `${fg} on ${bg}`;
      const prev = out.get(key);
      const live = f.startsWith("scripts/") || Boolean(prev?.live);
      out.set(key, { fg, bg, live, where: prev?.where ?? `${f}: ${sel.trim().replace(/\s+/g, " ").slice(0, 80)}` });
    }
  }
  return [...out.values()];
}
// Tokens that are not text colors on that rule's own fill: page-local tokens the sheet does not
// define (screen.css's --pill, checked in test/tokens.test.mjs over white and black pages).
const LOCAL = new Set(["pill"]);
// Translucent fills sit on the dock or page under them; checked over each of these.
const BASES = ["bg", "sidebar", "elevated"];

// Exceptions, each with its reason. Key: "variant: kind fg on bg" (variant "*" for all).
const EXCEPTIONS = new Map([
  // A disabled button's label: WCAG 1.4.3 exempts inactive controls; it is dimmed on purpose.
  ["*: text muted on hover", "a disabled control's label (approve.css button:disabled); inactive UI is exempt (WCAG 1.4.3)"],
]);
const excepted = (variant, key) => EXCEPTIONS.get(`${variant}: ${key}`) ?? EXCEPTIONS.get(`*: ${key}`);

test("the sheet has the four variants and every var() chain resolves to a value", () => {
  assert.ok(BLOCKS.some((b) => LIGHT.test(b.media)), "a light block");
  assert.ok(BLOCKS.some((b) => MORE.test(b.media)), "an increased contrast block (prefers-contrast: more)");
  for (const [name, t] of Object.entries(T)) {
    for (const k of [...SURFACES, ...TEXT, ...STATE, "hover", "edge", "edge-input", "edge-btn", "accent", "spark"]) {
      assert.ok(rgba(t[k]), `${name}: --${k} resolves to a color (${t[k]})`);
    }
  }
});

test("declared pairs meet AA in light, dark and increased contrast", () => {
  const fails = [];
  for (const [name, t] of Object.entries(T)) {
    for (const [kind, fg, bg] of declared(name)) {
      const min = kind === "text" ? 4.5 : 3, key = `${kind} ${fg} on ${bg}`;
      const r = contrast(t, fg, bg);
      if (r < min && !excepted(name, key)) fails.push(`${name}: ${key} is ${r.toFixed(2)}:1 (needs ${min})`);
    }
  }
  assert.deepEqual(fails, []);
});

test("every color-on-background pair the page sheets make meets AA in every variant", () => {
  const pairs = usedPairs().filter((p) => !LOCAL.has(p.fg) && !LOCAL.has(p.bg));
  assert.ok(pairs.length >= 20, `found ${pairs.length} pairs`);
  const fails = [];
  for (const [name, t] of Object.entries(T)) {
    for (const { fg, bg, where, live } of pairs) {
      if (!live && !DARK_ONLY.has(name)) continue; // an extension page: always dark
      const key = `text ${fg} on ${bg}`;
      if (excepted(name, key)) continue;
      const translucent = rgba(t[bg])[3] < 1;
      for (const base of translucent ? BASES : ["bg"]) {
        const r = contrast(t, fg, bg, base);
        if (r < 4.5) fails.push(`${name}: ${key}${translucent ? ` over --${base}` : ""} is ${r.toFixed(2)}:1 (${where})`);
      }
    }
  }
  assert.deepEqual(fails, []);
});

test("increased contrast raises the quiet colors: muted text and the dividers", () => {
  for (const scheme of ["dark", "light"]) {
    const base = T[scheme], more = T[`${scheme}, more contrast`];
    for (const bg of PAGE) {
      assert.ok(contrast(more, "muted", bg) > contrast(base, "muted", bg), `${scheme}: --muted on --${bg}`);
      const r = contrast(more, "edge", bg);
      assert.ok(r >= 3, `${scheme}, more contrast: a divider (--edge) on --${bg} is ${r.toFixed(2)}:1`);
    }
  }
});

test("every exception is still needed", () => {
  for (const [key, why] of EXCEPTIONS) {
    assert.ok(why.length > 20, `${key} says why`);
    const [variant, rest] = key.split(": ");
    const [kind, fg, , bg] = rest.split(" ");
    const min = kind === "text" ? 4.5 : 3;
    const names = variant === "*" ? Object.keys(T) : [variant];
    assert.ok(names.some((n) => contrast(T[n], fg, bg) < min), `${key} passes everywhere now; drop it`);
  }
});
