// No browser engine's product name anywhere a person reads in ui/**: page text, the attributes that
// show or are spoken (placeholder, title, aria-*, alt, value, label), CSS content and the strings in
// the scripts that reach the page. chrome:// addresses and code identifiers (chrome.storage,
// chromeMediaSource, the "chromium" engine value, the top-chrome host) are not text and pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../ui", import.meta.url));
const NAME = /chrom(e|ium)/i;
const bare = (s) => s.replace(/chrome:(\/\/|\\\/\\\/)[^\s"'`)<]*/gi, "");
const named = (s) => NAME.test(bare(s));

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(join(dir, d.name)) : [join(dir, d.name)]);
}

// The string and template literals of a script, comments and regex literals left out.
export function jsStrings(src) {
  const out = [];
  let i = 0, prev = "";
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === "/" && n === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
    if (c === "/" && n === "*") { i = src.indexOf("*/", i + 2); if (i < 0) break; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, s = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") { s += src[j] + src[j + 1]; j += 2; continue; } s += src[j++]; }
      out.push(s); i = j + 1; prev = c; continue;
    }
    if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev))) { // a regex literal
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "[") cls = true; else if (src[j] === "]") cls = false; else if (src[j] === "/" && !cls) break;
        j++;
      }
      i = j + 1; prev = "/"; continue;
    }
    if (!/\s/.test(c)) prev = /[\w$]/.test(c) ? "a" : c;
    i++;
  }
  return out;
}
// A literal is text when it reads as words: a space or a capital. One lowercase token is a value or an id.
const prose = (s) => /\s/.test(s) || /[A-Z]/.test(s);

export function htmlTexts(src) {
  const s = src.replace(/<!--[\s\S]*?-->/g, "");
  const out = [];
  const body = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  for (const m of body.matchAll(/>([^<]+)</g)) out.push(m[1]);
  for (const m of s.matchAll(/\s(placeholder|title|aria-[\w-]+|alt|value|label|content)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const v = m[3] ?? m[4];
    if (m[1].toLowerCase() !== "value" || prose(v)) out.push(v); // a radio's value="chromium" is data, a button's value is text
  }
  for (const m of s.matchAll(/<title>([^<]*)<\/title>/gi)) out.push(m[1]);
  return out;
}

export function scan(file, src) {
  const hits = [];
  if (file.endsWith(".html") || file.endsWith(".svg")) {
    for (const t of htmlTexts(src)) if (named(t)) hits.push(t.trim());
    for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) for (const t of jsStrings(m[1])) if (prose(t) && named(t)) hits.push(t);
  } else if (file.endsWith(".js") || file.endsWith(".mjs")) {
    for (const t of jsStrings(src)) if (prose(t) && named(t)) hits.push(t);
  } else if (file.endsWith(".css")) {
    for (const m of src.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/content\s*:\s*("([^"]*)"|'([^']*)')/g)) if (named(m[2] ?? m[3])) hits.push(m[2] ?? m[3]);
  } else if (file.endsWith(".json")) {
    const walk = (v) => typeof v === "string" ? (prose(v) && named(v) ? hits.push(v) : 0) : v && typeof v === "object" ? Object.values(v).forEach(walk) : 0;
    walk(JSON.parse(src));
  }
  return hits;
}

test("the scanner finds the name in text and passes addresses and identifiers", () => {
  assert.deepEqual(scan("a.html", '<b>Another Chromium here</b><input placeholder="/Applications/Chromium.app"><a href="chrome://settings" title="Chrome settings">x</a>'),
    ["Another Chromium here", "/Applications/Chromium.app", "Chrome settings"]);
  assert.deepEqual(scan("a.html", '<a href="chrome://settings">Browser settings</a><div data-k="chromium">ok</div><input type="radio" value="chromium">'), []);
  assert.deepEqual(scan("a.js", 'const a = { chromium: "Chromium" }; // Chromium here\nx.textContent = `Open ${"chrome://history"}`;\nconst r = /^chrome:\\/\\/x"/; const k = "chromium"; chrome.storage; const h = "pairbrowse.top-chrome";'), ["Chromium"]);
  assert.deepEqual(scan("a.js", 'say("Enter a Chromium-based browser")'), ["Enter a Chromium-based browser"]);
});

test("no engine product name a person can read in ui/**", () => {
  const found = [];
  for (const f of files(ROOT)) {
    if (!/\.(html|svg|js|mjs|css|json)$/.test(f)) continue;
    for (const h of scan(f, readFileSync(f, "utf8"))) found.push(`${relative(ROOT, f)}: ${h}`);
  }
  assert.deepEqual(found, []);
});
