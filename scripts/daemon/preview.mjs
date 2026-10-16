// Read-only previews of downloads the browser doesn't show itself (daemon/toolstab.mjs openWay): a
// .csv or .log as escaped plain text, and on macOS a Word-type document (.doc, .docx, .rtf, .odt)
// converted by textutil to HTML, rebuilt from an allowlist of tags and attributes, under a content
// security policy that runs no script and loads nothing. The page opens in a person's tab (no
// agent reads or acts in it). No key, token or button is ever in the file. Files live in
// ~/.pairbrowse/previews (0700, files 0600), named by the download's id and a random suffix (one
// file per tab), removed when the tab
// closes, at helper start and exit, and when the browser closes. Node's standard library only.
import { randomBytes } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { mkdirSync, lstatSync, chmodSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { paths } from "../paths.mjs";
import { within } from "../util.mjs";

export const PREVIEW_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
export const DOCUMENT_NOTE = "Read-only preview. To edit, use Open in Word in PairBrowse's Downloads.";
export const TEXT_NOTE = "Read-only preview.";
const PREVIEW_FAILED = "PairBrowse couldn't make a preview of this document. Use Open in Word to open it in its app.";
const TEXTUTIL = "/usr/bin/textutil";
const RAW_MAX = 10 * 1024 * 1024; // textutil's HTML; larger answers "Use Open in Word"
const ID = /^[0-9a-f]{12}$/;

// CSS that could load, run or escape anything: the whole of it is dropped (fail closed).
const BAD_CSS = /[<\\]|url\s*\(|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i;
// What could lift a box over the fixed header (a positioned box with a z-index) or write text: a
// style attribute or head rule with one of these is dropped.
const LIFT = /position\s*:|z-index|content\s*:/i;
// A style attribute's value is entity-decoded by the parser (a character reference can spell url), so an & drops it too.
const badStyle = (v) => BAD_CSS.test(v) || v.includes("&") || LIFT.test(v);
// textutil's own selector form (p.p1, span.s1, td.td1, a list of them); the header has no such class.
const TEXTUTIL_SELECTORS = /^\s*[a-z][a-z0-9]*\.[a-z]+\d+(\s*,\s*[a-z][a-z0-9]*\.[a-z]+\d+)*\s*$/i;
// The document's head CSS, kept only when it is all plain rules in textutil's form, none of which
// loads, escapes or lifts anything; else none of it (fail closed). Rules on other selectors (body,
// header, .pb-preview, *) could out-rank the header's own, so they never get in. Pure.
export function keptCss(css) {
  const t = String(css ?? "");
  if (BAD_CSS.test(t) || LIFT.test(t)) return "";
  // One pass: each rule is "selectors { declarations }", with no brace inside either part.
  for (let at = 0; ;) {
    const open = t.indexOf("{", at);
    if (open < 0) return t.slice(at).trim() ? "" : t;
    const close = t.indexOf("}", open + 1);
    if (close < 0 || t.slice(open + 1, close).includes("{")) return "";
    const selectors = t.slice(at, open);
    if (selectors.includes("}") || selectors.length > 4096 || !TEXTUTIL_SELECTORS.test(selectors)) return "";
    at = close + 1;
  }
}
// Every run stops at the next '<', so a tag that never closes fails there (linear, never a scan
// to the end of the text per '<'); comments go in stripComments first.
const TAG = /<![^<>]*>|<\?[^<>]*>|<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
export const DROP_WITH_CONTENT = new Set(["script", "style", "title", "head", "iframe", "frame", "frameset", "object", "embed", "applet", "noscript", "noembed",
  "noframes", "template", "svg", "math", "textarea", "select", "option", "button", "video", "audio", "canvas", "map", "xmp", "plaintext", "listing"]);
export const ALLOWED_TAGS = new Set(["p", "span", "div", "br", "b", "i", "u", "s", "strike", "strong", "em", "sub", "sup", "small", "big", "a", "ul", "ol", "li",
  "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "code", "hr"]);
export const ALLOWED_ATTRS = new Set(["class", "style", "colspan", "rowspan", "align", "valign", "width", "height", "dir", "lang", "border", "cellpadding", "cellspacing"]);
const LIST_ATTRS = new Set(["start", "type"]);
const LIST_TAGS = new Set(["ol", "ul", "li"]);

const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => escText(s).replace(/"/g, "&quot;");
const strayText = (s) => String(s).replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The attributes kept on an allowed tag, re-serialized in double quotes.
function keptAttrs(name, raw) {
  if (name === "a") return ""; // links are inert: no href, nothing else
  const out = [];
  for (const [, n, dq, sq, bare] of String(raw || "").matchAll(ATTR)) {
    const key = n.toLowerCase();
    if (!(ALLOWED_ATTRS.has(key) || (LIST_ATTRS.has(key) && LIST_TAGS.has(name)))) continue;
    if (out.some((a) => a.startsWith(`${key}=`))) continue;
    const value = dq ?? sq ?? bare ?? "";
    if (key === "style" && badStyle(value)) continue;
    // The header's own class names stay the header's.
    const v = key === "class" ? value.split(/\s+/).filter((c) => c && !/^pb-/i.test(c)).join(" ") : value;
    if (key === "class" && !v) continue;
    out.push(`${key}="${escAttr(v)}"`);
  }
  return out.length ? ` ${out.join(" ")}` : "";
}

// Where the content of a dropped element ends: after its matching close tag (same name, nesting
// counted), or the end of the text when it never closes.
function skipPast(html, from, name) {
  const re = new RegExp(`<(/?)${name}(?=[\\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*>`, "gi");
  re.lastIndex = from;
  let depth = 1;
  for (let m; (m = re.exec(html));) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return re.lastIndex;
  }
  return html.length;
}

// Comments out, in one pass; one never closed runs to the end, as a browser reads it.
function stripComments(t) {
  let out = "";
  for (let i = 0; ;) {
    const a = t.indexOf("<!--", i);
    if (a < 0) return out + t.slice(i);
    out += t.slice(i, a);
    const b = t.indexOf("-->", a + 4);
    if (b < 0) return out;
    i = b + 3;
  }
}

// The text between the first open tag `re` matches and the close tag `close` after it (or null),
// searched once each way: linear.
function between(text, from, open, close) {
  open.lastIndex = from;
  const o = open.exec(text);
  if (!o) return null;
  const start = o.index + o[0].length;
  close.lastIndex = start;
  const c = close.exec(text);
  return c ? { inner: text.slice(start, c.index), end: c.index + c[0].length } : { inner: text.slice(start), end: -1 };
}

// textutil's HTML, rebuilt from an allowlist (never a blacklist): { css, body }. Pure.
export function sanitizeDocumentHtml(html) {
  const text = stripComments(String(html ?? ""));
  const h = between(text, 0, /<head\b[^<>]*>/gi, /<\/head\s*>/gi);
  const head = h && h.end >= 0 ? h.inner : "";
  const styles = [];
  for (let at = 0; ;) {
    const st = between(head, at, /<style\b[^<>]*>/gi, /<\/style\s*>/gi);
    if (!st || st.end < 0) break;
    styles.push(st.inner);
    at = st.end;
  }
  const css = keptCss(styles.join("\n"));
  const open = /<body\b(?:[^<>"']|"[^"]*"|'[^']*')*>/i.exec(text);
  let src = text;
  if (open) {
    const rest = text.slice(open.index + open[0].length);
    const close = rest.search(/<\/body\s*>/i);
    src = close >= 0 ? rest.slice(0, close) : rest;
  }
  let body = "";
  let last = 0;
  const re = new RegExp(TAG.source, "g");
  for (let m; (m = re.exec(src));) {
    body += strayText(src.slice(last, m.index));
    last = re.lastIndex;
    const name = m[1]?.toLowerCase();
    if (!name) continue; // a comment, doctype or processing instruction
    const closing = m[0][1] === "/";
    if (DROP_WITH_CONTENT.has(name)) {
      if (!closing) { last = skipPast(src, re.lastIndex, name); re.lastIndex = last; }
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) continue; // the tag goes, its text stays
    body += closing ? `</${name}>` : `<${name}${keptAttrs(name, m[2])}>`;
  }
  body += strayText(src.slice(last));
  return { css, body };
}

// The fixed header and page colors (the tokens' frame, ink, ink-2 and edge).
// It comes after the document's own CSS and wins: the document's CSS only styles its own textutil
// classes (keptCss), no kept style positions a box with a z-index, and the header's rules are
// !important, so a document can't hide, rewrite or cover the header.
const HEADER_CSS = "html{background:#ffffff;color:#000000}body{margin:0}" +
  ".pb-preview{display:block!important;position:sticky!important;top:0!important;visibility:visible!important;opacity:1!important;transform:none!important;" +
  "padding:10px 16px!important;margin:0!important;background:#101D2D!important;color:#F1F5FA!important;border-bottom:1px solid #293B50!important;" +
  "font:13px system-ui,sans-serif!important;z-index:2147483647!important}" +
  ".pb-preview strong{display:inline!important;visibility:visible!important;color:#F1F5FA!important;font:600 13px system-ui,sans-serif!important}" +
  ".pb-preview span{display:inline!important;visibility:visible!important;color:#A2B2C6!important;font:13px system-ui,sans-serif!important}" +
  ".pb-preview::before,.pb-preview::after,.pb-preview *::before,.pb-preview *::after{content:none!important}" +
  "main{padding:16px}.pb-text{white-space:pre-wrap;font:13px ui-monospace,Menlo,monospace;margin:0}";

// The preview page: the CSP meta first in <head>, then the file's name and the note. Pure.
export function previewPage({ name, css = "", body = "", note = DOCUMENT_NOTE }) {
  const n = escText(name).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  // No lang on the page (the document can be in any language); the header is PairBrowse's English.
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}"><meta charset="utf-8"><meta name="referrer" content="no-referrer">` +
    `<title>${n}</title><style>${keptCss(css)}</style><style>${HEADER_CSS}</style></head>` +
    `<body><header class="pb-preview" lang="en" aria-label="Read-only preview"><strong>${n}</strong> <span>${escText(note)}</span></header><main>${body}</main></body></html>`;
}

// A plain-text file as a preview page: every character escaped. Pure.
export function textPreviewPage(text, name) {
  return previewPage({ name, body: `<pre class="pb-text">${escText(text)}</pre>`, note: TEXT_NOTE });
}

// make(entry, kind): kind "text" or "document"; resolves { path, drop } or { error }. Never throws.
// clear(): empties the folder (sync); a symlink in its place is never followed.
export function createPreviews({ dir = paths.previews, execFile = nodeExecFile, textutilMs = 20_000 } = {}) {
  function ensureDir() {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
      chmodSync(dir, 0o700);
      return true;
    } catch { return false; }
  }
  // textutil, no shell: resolves true when it exited cleanly (or false); never rejects.
  const convert = (args) => new Promise((resolve) => {
    try {
      execFile(TEXTUTIL, args, { timeout: textutilMs, windowsHide: true, maxBuffer: 65536 }, (err) => resolve(!err));
    } catch { resolve(false); }
  });
  async function documentHtml(entry) {
    const raw = join(dir, `${entry.id}-${randomBytes(4).toString("hex")}.textutil.html`);
    const format = extname(String(entry.path)).slice(1).toLowerCase();
    try {
      const ok = await within(textutilMs + 1000, convert(["-convert", "html", "-format", format, "-noload", "-nostore", "-strip", "-output", raw, "--", entry.path]));
      if (ok !== true) return null;
      // textutil exits 0 and writes nothing when it can't read the file: the output is the answer.
      const st = lstatSync(raw);
      if (!st.isFile() || st.isSymbolicLink() || st.size > RAW_MAX) return null;
      return readFileSync(raw, "utf8");
    } catch { return null; } finally { try { rmSync(raw, { force: true }); } catch {} }
  }
  async function make(entry, kind) {
    const failed = { error: kind === "document" ? PREVIEW_FAILED : "PairBrowse couldn't make a preview of this file." };
    if (!entry?.path || !ID.test(String(entry.id || "")) || !ensureDir()) return failed;
    let page;
    if (kind === "text") {
      try { page = textPreviewPage(readFileSync(entry.path, "utf8"), entry.name || ""); } catch { return failed; }
    } else if (kind === "document") {
      const html = await documentHtml(entry);
      if (html === null) return failed;
      page = previewPage({ name: entry.name || "", ...sanitizeDocumentHtml(html), note: DOCUMENT_NOTE });
    } else return failed;
    // One file per tab: closing one tab never removes what another shows.
    const out = join(dir, `${entry.id}-${randomBytes(4).toString("hex")}.html`);
    const tmp = `${out}.tmp`;
    try {
      rmSync(tmp, { force: true });
      writeFileSync(tmp, page, { mode: 0o600, flag: "wx" });
      chmodSync(tmp, 0o600);
      renameSync(tmp, out);
    } catch { try { rmSync(tmp, { force: true }); } catch {} return failed; }
    return { path: out, drop: () => { try { rmSync(out, { force: true }); } catch {} } };
  }
  function clear() {
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) return;
      for (const f of readdirSync(dir)) { try { rmSync(join(dir, f), { force: true, recursive: true }); } catch {} }
    } catch {}
  }
  return { make, clear, dir };
}
