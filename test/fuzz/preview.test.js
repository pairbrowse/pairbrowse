// Property-based fuzzing of the document preview's sanitizer (daemon/preview.mjs): whatever HTML
// textutil hands over, the rebuilt body holds only allowlisted tags and attributes, no link or
// event handler, no raw "<" in its text, and the page's <head> starts with the CSP meta.
// Run with: npm ci && npm run test:fuzz
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { sanitizeDocumentHtml, previewPage, ALLOWED_TAGS, ALLOWED_ATTRS, PREVIEW_CSP } from "../../scripts/daemon/preview.mjs";

const TAGS = ["p", "a", "script", "SCRIPT", "img", "iframe", "svg", "style", "form", "input", "base", "meta", "link", "object", "embed", "div", "span", "td", "ol", "li", "x-y", "textarea", "b"];
const ATTRS = ["href", "src", "onerror", "onclick", "OnLoad", "style", "class", "type", "start", "action", "http-equiv", "srcdoc", "colspan", "data-x", "xlink:href"];
const VALUES = ["position:fixed;top:0;z-index:2147483647", "Z-INDEX:9", "content:'x'", "javascript:alert(1)", " JaVaScRiPt:x", "data:text/html,<script>x</script>", "url(https://e.example)", "color:red", "u&#114;l(x)", "x\" onerror=\"y", "'", "\"", "<", ">", "&", "1", ""];
const quote = fc.constantFrom("\"", "'", "");
const attr = fc.tuple(fc.constantFrom(...ATTRS), fc.constantFrom(...VALUES), quote).map(([n, v, q]) => (q ? `${n}=${q}${v}${q}` : `${n}=${v.replace(/\s/g, "")}`));
const open = fc.tuple(fc.constantFrom(...TAGS), fc.array(attr, { maxLength: 3 }), fc.boolean()).map(([t, as, self]) => `<${t}${as.map((a) => ` ${a}`).join("")}${self ? "/" : ""}>`);
const close = fc.constantFrom(...TAGS).map((t) => `</${t}>`);
const bits = fc.oneof(open, close, fc.constantFrom("<!--", "-->", "<!doctype html>", "<?x?>", "<", ">", "&", "text", "<body>", "</body>", "<head><style>p{}</style></head>", "<head><style>body header.pb-preview{display:none!important}</style></head>",
  "<head><style>p.p1 {margin: 0}</style></head>", "<head><style>p.p1{position:fixed;z-index:9}</style></head>"), fc.string({ maxLength: 8 }));
const html = fc.array(bits, { maxLength: 30 }).map((xs) => xs.join(""));

test("only allowed tags and attributes, no href or handler, no raw < in text", () => {
  fc.assert(fc.property(html, (input) => {
    const { body, css } = sanitizeDocumentHtml(input);
    assert.ok(!/[<\\]|url\s*\(|@import/i.test(css), css);
    // The head css is only textutil's own rules, and nothing kept lifts a box over the header.
    assert.ok(css === "" || /^(\s*[a-z][a-z0-9]*\.[a-z]+\d+(\s*,\s*[a-z][a-z0-9]*\.[a-z]+\d+)*\s*\{[^{}]*\})+\s*$/i.test(css), css);
    assert.doesNotMatch(css, /position\s*:|z-index|content\s*:|pb-preview/i);
    const tags = [...body.matchAll(/<(\/?)([^\s>/]*)([^>]*)>/g)];
    for (const [, , name, attrs] of tags) {
      for (const [, v] of attrs.matchAll(/\sstyle="([^"]*)"/g)) assert.doesNotMatch(v, /position\s*:|z-index|content\s*:/i, `style ${v}`);
      for (const [, v] of attrs.matchAll(/\sclass="([^"]*)"/g)) assert.doesNotMatch(v, /(^|\s)pb-/i, `class ${v}`);
      assert.ok(ALLOWED_TAGS.has(name), `tag ${name} in ${body}`);
      const rest = attrs.replace(/\s([a-z-]+)="[^"<>]*"/g, (m, a) => { assert.ok(ALLOWED_ATTRS.has(a) || ["start", "type"].includes(a), `attr ${a}`); return ""; });
      assert.equal(rest.trim(), "", `leftover in a tag: ${attrs}`);
      // Names only (a value is escaped text: " onerror=" inside one is just characters).
      assert.doesNotMatch(attrs.replace(/="[^"]*"/g, ""), /\shref|\son\w+/i);
    }
    const text = body.replace(/<\/?[a-z0-9]+(\s[a-z-]+="[^"<>]*")*>/g, "");
    assert.ok(!text.includes("<"), `raw < in ${body}`);
  }), { numRuns: 5000 });
});

test("the page's <head> starts with the CSP meta, whatever the name and body", () => {
  fc.assert(fc.property(fc.string({ maxLength: 40 }), html, (name, input) => {
    const page = previewPage({ name, ...sanitizeDocumentHtml(input) });
    assert.ok(page.startsWith(`<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`));
    assert.ok(!/<script/i.test(page));
  }), { numRuns: 2000 });
});
