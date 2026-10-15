// Read-only previews (daemon/preview.mjs): textutil's HTML rebuilt from an allowlist, the page
// under a CSP that runs no script and loads nothing, plain text escaped, and the previews folder
// emptied without following a symlink.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeDocumentHtml, previewPage, textPreviewPage, createPreviews, PREVIEW_CSP, ALLOWED_TAGS, ALLOWED_ATTRS } from "../scripts/daemon/preview.mjs";

const clean = (body, head = "") => sanitizeDocumentHtml(`<html><head>${head}</head><body>${body}</body></html>`);
const NEVER = [/<script/i, /\son\w+\s*=/i, /href/i, /javascript:/i, /vbscript:/i, /<form/i, /<input/i, /<iframe/i, /<object/i, /<embed/i, /<base/i, /<link/i, /<meta/i, /<svg/i, /<img/i, /src=/i];

test("the payload battery: scripts, handlers, links, frames, forms and styles never survive", () => {
  const cases = [
    ["<script>alert(1)</script>ok", "ok"],
    ["<SCRIPT >alert(1)</SCRIPT>ok", "ok"],
    ["a<script>alert(1)", "a"],
    ["<img src=x onerror=alert(1)>pic", "pic"],
    ['<a href=" JaVaScRiPt:alert(1)">t</a>', "<a>t</a>"],
    ['<a href="data:text/html,<script>x</script>">d</a>', "<a>d</a>"],
    ["<a href='vbscript:msgbox(1)'>v</a>", "<a>v</a>"],
    ['<meta http-equiv="refresh" content="0;url=https://evil.example">m', "m"],
    ['<form action="https://evil.example"><input name=q>Field</form>', "Field"],
    ['<iframe src="https://evil.example">inside</iframe>after', "after"],
    ['<object data="x">inside</object>after', "after"],
    ["<embed src=x></embed>after", "after"],
    ['<base href="https://evil.example/">b', "b"],
    ['<link rel="stylesheet" href="https://evil.example/x.css">l', "l"],
    ["<svg onload=alert(1)><circle/></svg>after", "after"],
    ["<!-- a comment <script>x</script> -->c", "c"],
    ["<p onclick='x()' class='k'>q</p>", '<p class="k">q</p>'],
    ["<p class=k onmouseover=x()>u</p>", '<p class="k">u</p>'],
    ['<p style="background:url(https://evil.example/x.png)">s</p>', "<p>s</p>"],
    ['<p style="color: red">s</p>', '<p style="color: red">s</p>'],
    ['<p style="u&#114;l(x)">e</p>', "<p>e</p>"],
    ['<td colspan="2" title="x">c</td>', '<td colspan="2">c</td>'],
    ['<ol start="3" type="a"><li type="i">x</li></ol><p type="x">y</p>', '<ol start="3" type="a"><li type="i">x</li></ol><p>y</p>'],
    ["a < b and c > d", "a &lt; b and c &gt; d"],
    ['<p class="a&quot;b">x</p>', '<p class="a&amp;quot;b">x</p>'],
    ["<textarea><p>inside</p></textarea>after", "after"],
    ["<div><div>nested</div></div>", "<div><div>nested</div></div>"],
  ];
  for (const [input, want] of cases) {
    const { body } = clean(input);
    assert.equal(body, want, input);
    for (const bad of NEVER) assert.doesNotMatch(body, bad, `${input}: ${bad}`);
  }
});

test("head styles: kept when plain, dropped whole when they could load or escape", () => {
  assert.equal(clean("x", "<style>p.p1 {margin: 0; font: 12px Helvetica}</style>").css, "p.p1 {margin: 0; font: 12px Helvetica}");
  for (const css of ["@import 'https://evil.example/x.css';", "p{background:url(x)}", "p{width:expression(alert(1))}", "p{behavior: url(x.htc)}", "p{-moz-binding:x}", "p{content:'\\3c'}", "p{color:red} <!-- x"]) {
    assert.equal(clean("x", `<style>${css}</style>`).css, "", css);
  }
  // A style ends at its first close tag: what follows in <head> is never css.
  assert.equal(clean("x", "<style>p.p1{color:red}</style><script>x</script>").css, "p.p1{color:red}");
  // A style in the body is dropped with its content.
  assert.equal(clean("<style>p{color:red}</style>t").body, "t");
  // No body tag: the whole input is the body.
  assert.equal(sanitizeDocumentHtml("<b>bold</b><script>x</script>").body, "<b>bold</b>");
});

test("the page: the CSP meta first in <head>, the name escaped in title and header, the note", () => {
  const name = 'evil<img src=x onerror=alert(1)>".docx';
  const html = previewPage({ name, css: "p{color:red}", body: "<p>x</p>" });
  assert.match(html, new RegExp(`^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}">`));
  assert.ok(!html.includes("<img"), "the name is escaped");
  assert.ok(html.includes("<title>evil&lt;img src=x onerror=alert(1)&gt;&quot;.docx</title>"));
  assert.ok(html.includes("<strong>evil&lt;img src=x onerror=alert(1)&gt;&quot;.docx</strong>"));
  assert.ok(html.includes("Read-only preview. To edit, use Open in Word in PairBrowse&#39;s Downloads.") || html.includes("Read-only preview. To edit, use Open in Word in PairBrowse's Downloads."));
  assert.ok(html.includes('<meta name="referrer" content="no-referrer">'));
  assert.ok(!/animation|transition/.test(html), "no motion");
  // A css that slipped through is still not written.
  assert.ok(!previewPage({ name: "n", css: "</style><script>x</script>" }).includes("<script"));
});

test("textPreviewPage escapes everything", () => {
  const html = textPreviewPage("<script>alert(1)</script> & \"q\" 'a'", "n<b>.csv");
  assert.ok(html.includes('<pre class="pb-text">&lt;script&gt;alert(1)&lt;/script&gt; &amp; "q" \'a\'</pre>'));
  assert.ok(!html.includes("<script") && !html.includes("<b>"));
  assert.ok(html.includes("Read-only preview."));
});

test("createPreviews: clear() keeps the folder, empties it, never follows a symlink; make() refuses a symlinked folder", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pb-preview-")));
  try {
    const dir = join(root, "previews");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.html"), "x");
    mkdirSync(join(dir, "sub"));
    const p = createPreviews({ dir });
    p.clear();
    assert.ok(existsSync(dir));
    assert.deepEqual(readdirSync(dir), []);
    // A symlink where the folder was: neither cleared through nor written into.
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep.txt"), "mine");
    const link = join(root, "linked");
    symlinkSync(elsewhere, link);
    const q = createPreviews({ dir: link });
    q.clear();
    assert.deepEqual(readdirSync(elsewhere), ["keep.txt"]);
    const src = join(root, "a.csv");
    writeFileSync(src, "a,b");
    assert.ok((await q.make({ id: "0123456789ab", path: src, name: "a.csv" }, "text")).error);
    assert.deepEqual(readdirSync(elsewhere), ["keep.txt"]);
    // A good folder: the text preview is written, then dropped.
    const r = await p.make({ id: "0123456789ab", path: src, name: "a.csv" }, "text");
    assert.ok(existsSync(r.path));
    r.drop();
    assert.ok(!existsSync(r.path));
    // An id that isn't the helper's 12-hex: refused.
    assert.ok((await p.make({ id: "../x", path: src, name: "a.csv" }, "text")).error);
    // A spawn that throws: an answer, not a crash.
    const t = createPreviews({ dir, execFile: () => { throw new Error("x"); } });
    assert.ok((await t.make({ id: "0123456789ab", path: src, name: "a.docx" }, "document")).error);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the sanitizer's output holds only allowed tags and attributes", () => {
  const { body } = clean('<div class="a" data-x="1"><span style="color:red" id="s">x</span><font face="x">f</font><table border="1"><tr><td>c</td></tr></table></div>');
  for (const [, name, attrs] of body.matchAll(/<\/?([a-z0-9]+)([^>]*)>/g)) {
    assert.ok(ALLOWED_TAGS.has(name), name);
    for (const [, a] of attrs.matchAll(/([a-z-]+)="/g)) assert.ok(ALLOWED_ATTRS.has(a), a);
  }
  assert.ok(body.includes(">f<"), "font's text kept");
});

test("the sanitizer is linear: a tag, declaration or comment that never closes costs no scan to the end per '<'", () => {
  // Timed as a ratio of CPU time (this process's, so a busy machine that leaves it waiting for a
  // core counts for nothing), per unit: one warm-up, then the best of five runs at 50k and at 200k,
  // taken in turns so both sizes see the same moment. Linear work is about 4x for 4x the input, a
  // scan to the end per '<' about 16x. Below 4 ms at 50k the clock and the collector decide more
  // than the code does, so that is the floor: a scan per '<' already takes far longer at 50k. The
  // absolute bound only catches a catastrophe.
  const cpu = (input) => {
    const t = process.cpuUsage();
    sanitizeDocumentHtml(input);
    const d = process.cpuUsage(t);
    return (d.user + d.system) / 1000;
  };
  for (const unit of ["<a x", '<a x="', "<!", "<?", "<!--", "<head>", "<head><style>", "<body x='", "<script"]) {
    const of = (n) => unit.repeat(Math.ceil(n / unit.length));
    const small = of(50_000), large = of(200_000);
    sanitizeDocumentHtml(small); // warm-up
    let t50 = Infinity, t200 = Infinity;
    for (let i = 0; i < 5; i++) { t50 = Math.min(t50, cpu(small)); t200 = Math.min(t200, cpu(large)); }
    assert.ok(t200 / Math.max(t50, 4) < 8, `${JSON.stringify(unit)}: ${t200.toFixed(1)} ms for 200k against ${t50.toFixed(1)} ms for 50k`);
    assert.ok(t200 < 1500, `${JSON.stringify(unit)}: ${Math.round(t200)} ms for 200k`);
    const { body } = sanitizeDocumentHtml(large);
    assert.ok(!/<(?!\/?[a-z0-9]+[\s>])/.test(body), `${JSON.stringify(unit)}: no raw < left`);
  }
  // An unterminated tag's text is escaped, and what follows it is still read.
  assert.equal(clean("<a x <b>bold</b>").body, "&lt;a x <b>bold</b>");
});

test("the header can't be hidden or rewritten by the document's own styles or classes", () => {
  // CSS aimed at the header (any selector not in textutil's p.p1 form) is never written.
  const css = ".pb-preview{display:none} header::after{content:'Editable'} .pb-preview span{visibility:hidden}";
  const page = previewPage({ name: "a.docx", css, body: "<p>x</p>" });
  assert.ok(page.includes("<style></style><style>html{"), "the document's css is dropped whole");
  assert.ok(!page.includes("display:none"));
  // textutil's own css first, the header's last (and !important): the header's rules win.
  const plain = "p.p1 {margin: 0.0px; font: 12.0px Helvetica}\nspan.s1 {color: #ff0000}";
  const kept = previewPage({ name: "a.docx", css: plain, body: "<p>x</p>" });
  const docAt = kept.indexOf(`<style>${plain}</style>`);
  const headerAt = kept.indexOf("<style>html{");
  assert.ok(docAt > 0 && headerAt > docAt, "the header's style block comes last");
  assert.match(page, /\.pb-preview\{display:block!important;position:sticky!important;top:0!important;visibility:visible!important/);
  assert.ok(page.includes(".pb-preview::before,.pb-preview::after,.pb-preview *::before,.pb-preview *::after{content:none!important}"));
  // A document's pb- classes are dropped; its others stay.
  assert.equal(clean('<p class="pb-preview k PB-x">x</p><p class="pb-text">y</p>').body, '<p class="k">x</p><p>y</p>');
  // The page has no language of its own; the header is English.
  assert.match(page, /^<!doctype html><html><head>/);
  assert.ok(page.includes('<header class="pb-preview" lang="en" aria-label="Read-only preview">'));
});

test("the header can't be hidden by an out-ranking head rule or covered by a lifted box", () => {
  // A more specific !important rule would beat the header's own: the whole head css goes.
  for (const css of ["body header.pb-preview{display:none!important}", "p.p1{color:red} body header.pb-preview{display:none!important}",
    "html body > header{visibility:hidden!important}", "*{opacity:0!important}", "p.p1,header{display:none}", ".p1{color:red}", "@media screen{p.p1{color:red}}",
    "p.p1{color:red", "p.p1{color:red}}", "p.p1{position:fixed;top:0;z-index:2147483647}", "span.s1{z-index:9}", "p.p1::before{content:'x'}", "p.p1:hover{color:red}", "p.p1 span.s1{color:red}"]) {
    const { css: kept } = clean("x", `<style>${css}</style>`);
    assert.equal(kept, "", css);
    assert.ok(previewPage({ name: "a.docx", css, body: "<p>x</p>" }).includes("<style></style><style>html{"), `${css}: not written`);
  }
  // textutil's own form stays: tag.class-with-number, alone or in a list.
  for (const css of ["p.p1 {margin: 0.0px 0.0px 0.0px 0.0px; font: 12.0px Helvetica}\nspan.s1 {color: #ff0000}", "td.td1, td.td2 {border: 1px solid #000}", "ul.ul1 {list-style-type: disc}\nli.li1 {margin: 0}"]) {
    assert.equal(clean("x", `<style>${css}</style>`).css, css, css);
  }
  // An inline style that could lift a box over the header (or write text) goes whole.
  const overlay = '<p style="position:fixed;top:0;left:0;right:0;height:60px;z-index:2147483647;background:#101D2D">Editable copy</p>';
  assert.equal(clean(overlay).body, "<p>Editable copy</p>");
  for (const style of ["position: absolute", "POSITION:fixed", "z-index:5", "Z-Index : 5", "content: 'x'"]) {
    assert.equal(clean(`<span style="${style}">t</span>`).body, "<span>t</span>", style);
  }
  assert.equal(clean('<span style="color:#f00; font-weight:bold">t</span>').body, '<span style="color:#f00; font-weight:bold">t</span>', "a plain style stays");
  // Linear on a long run without braces.
  const t0 = Date.now();
  assert.equal(clean("x", `<style>${"p.p1 ".repeat(400_000)}</style>`).css, "");
  assert.ok(Date.now() - t0 < 2000, "no quadratic scan");
});

test("createPreviews: the same document opened twice gets two files, so closing one tab keeps the other's", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pb-preview-")));
  try {
    const dir = join(root, "previews");
    const src = join(root, "a.csv");
    writeFileSync(src, "a,b");
    const p = createPreviews({ dir });
    const one = await p.make({ id: "0123456789ab", path: src, name: "a.csv" }, "text");
    const two = await p.make({ id: "0123456789ab", path: src, name: "a.csv" }, "text");
    assert.notEqual(one.path, two.path);
    for (const r of [one, two]) assert.match(r.path.slice(dir.length + 1), /^0123456789ab-[0-9a-f]{8}\.html$/);
    one.drop();
    assert.ok(!existsSync(one.path) && existsSync(two.path));
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), [], "no .tmp left");
    two.drop();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
