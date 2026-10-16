// Accessible names only where the engine allows one. The browser's debug build checks every page on
// chrome:// (blink AXObject::SimplifyName): a name on a role that ARIA says cannot be named aborts
// the renderer, and the page crashes as soon as the accessibility tree is read. The prohibited
// roles are blink's RoleIsNameProhibited (ax_utilities_generated_naming.cc): caption, code,
// definition (dd), deletion, emphasis, generic (div, span, b, i, kbd, small, pre, an a without
// href...), insertion, mark, none, paragraph, strong, subscript, suggestion, superscript, term (dt,
// dfn) and time. The names it counts: aria-label, aria-labelledby and, for a term alone, its own
// text (blink names a term from its contents, so any dt or dfn with text trips it; seen: <kbd
// aria-label>, then settings' <dt>Running in</dt>, then the right dock's request count). A title
// is not a name there (blink makes it the description), and a focusable element is exempt.
// Part 1, static (every machine): every ui/<page>/index.html and the names its scripts set.
// Part 2, rendered (PAIRBROWSE_TEST_RUNTIME): every review shot and every page over the default
// fixtures, with every hidden element shown, read through the accessibility tree the engine builds.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { patchright } from "./helpers/live.mjs";
import { pages, openPage, runtime, sleep } from "./helpers/ui-page.mjs";
import { startFakeHelper, merge } from "./helpers/fake-helper.mjs";
import { UI_ROOT } from "./helpers/ui-server.mjs";
import { defaultFixture } from "./helpers/pairbrowse-shim.mjs";
import { SHOTS } from "../scripts/dev/ui-look-all.mjs";
import { lookFixtures } from "../scripts/dev/ui-look.mjs";

// The accessibility tree's role names (CDP) that blink refuses a name on.
const PROHIBITED_ROLES = new Set(["caption", "code", "definition", "deletion", "emphasis", "generic", "insertion", "mark", "none",
  "paragraph", "strong", "subscript", "suggestion", "superscript", "term", "time", "SectionWithoutName"]);
// The same for an ARIA role attribute (none and presentation give way to the tag once named).
const PROHIBITED_ARIA = new Set(["caption", "code", "definition", "deletion", "emphasis", "generic", "insertion", "mark", "paragraph",
  "strong", "subscript", "suggestion", "superscript", "term", "time"]);
// Tags whose own role is one of them.
const PROHIBITED_TAGS = new Set(["div", "span", "p", "b", "i", "u", "s", "small", "kbd", "samp", "var", "code", "em", "strong", "mark",
  "time", "del", "ins", "sub", "sup", "dt", "dd", "dfn", "pre", "bdi", "bdo", "data", "q", "cite", "caption", "ruby", "rt", "rp", "font", "center"]);
const TERM_TAGS = new Set(["dt", "dfn"]);
const FOCUSABLE_TAGS = new Set(["button", "input", "select", "textarea", "summary", "iframe"]);

const root = join(UI_ROOT, "..");
const read = (p) => readFileSync(p, "utf8");
const attrOf = (a, name) => { const m = a.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")); return m ? (m[2] ?? m[3] ?? m[4]) : null; };
const hasAttr = (a, name) => new RegExp(`(?:^|\\s)${name}(?:\\s*=|\\s|$)`, "i").test(a);

// Whether an element (its tag and attribute text) may carry a name, as blink decides it.
function nameProhibited(tag, a) {
  if (hasAttr(a, "tabindex") || hasAttr(a, "contenteditable") || FOCUSABLE_TAGS.has(tag) || (tag === "a" && hasAttr(a, "href"))) return false;
  const role = (attrOf(a, "role") || "").trim().split(/\s+/)[0].toLowerCase();
  if (role && role !== "none" && role !== "presentation") return PROHIBITED_ARIA.has(role);
  return PROHIBITED_TAGS.has(tag) || (tag === "a" && !hasAttr(a, "href"));
}
const named = (a) => ["aria-label", "aria-labelledby"].some((n) => (attrOf(a, n) || "").trim() !== "");

// Every start tag of a page: { tag, attrs, line, text (up to its end tag, for the terms) }.
function tags(html) {
  const out = [];
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    const tag = m[1].toLowerCase();
    const end = html.indexOf(`</${tag}`, m.index);
    out.push({ tag, attrs: m[2], line: html.slice(0, m.index).split("\n").length, text: end > 0 ? html.slice(m.index + m[0].length, end).replace(/<[^>]*>/g, "").trim() : "" });
  }
  return out;
}

// The problems in one page's markup, as "file:line <tag ...>: why" strings.
function htmlProblems(file, html) {
  const out = [];
  for (const t of tags(html)) {
    const at = `${relative(root, file)}:${t.line} <${t.tag}${t.attrs.length > 60 ? t.attrs.slice(0, 60) + "…" : t.attrs}>`;
    const role = (attrOf(t.attrs, "role") || "").trim().split(/\s+/)[0].toLowerCase();
    if (named(t.attrs) && nameProhibited(t.tag, t.attrs)) out.push(`${at}: a name on a role that can't be named`);
    if ((TERM_TAGS.has(t.tag) && !role) || role === "term") out.push(`${at}: a term is named by its own text, and a term can't be named`);
    if (named(t.attrs) && attrOf(t.attrs, "aria-hidden") === "true") out.push(`${at}: a name on an element hidden from assistive technology`);
  }
  return out;
}

// The names a page's scripts set: on an element they create (el("span", { ariaLabel }),
// createElement) or find by id ($("x"), getElementById), judged by its tag and the role the same
// file gives it, or for an id by the page's own markup.
function jsProblems(file, js, byId) {
  const out = [];
  const code = js.replace(/^\s*\/\/.*$/gm, "");
  const at = (i) => `${relative(root, file)}:${code.slice(0, i).split("\n").length}`;
  for (const m of code.matchAll(/\b(?:el|createElement)\(\s*["'](dt|dfn)["']/g)) out.push(`${at(m.index)}: creates a <${m[1]}> (a term is named by its own text)`);
  for (const m of code.matchAll(/setAttribute\(\s*["']role["']\s*,\s*["']term["']/g)) out.push(`${at(m.index)}: role="term" (named by its own text)`);
  for (const m of code.matchAll(/\bel\(\s*["']([a-z0-9]+)["']\s*,\s*\{([^{}]*)\}/g)) {
    if (/\baria(Label|LabelledBy)\s*:/.test(m[2]) && !/\btabIndex\s*:/.test(m[2]) && nameProhibited(m[1], "")) out.push(`${at(m.index)}: el("${m[1]}", { ariaLabel }) names a role that can't be named`);
  }
  // Variables bound to a created element or one found by id.
  const vars = new Map();
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:el|document\.createElement)\(\s*["']([a-z0-9]+)["']/g)) vars.set(m[1], { tag: m[2], attrs: "" });
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:\$|document\.getElementById)\(\s*["']([\w-]+)["']\s*\)/g)) if (byId.has(m[2])) vars.set(m[1], { ...byId.get(m[2]), id: m[2] });
  const writes = [
    ...[...code.matchAll(/\b([A-Za-z_$][\w$]*)\.(?:setAttribute\(\s*["']aria-label(?:ledby)?["']|ariaLabel\s*=)/g)].map((m) => ({ i: m.index, v: m[1] })),
    ...[...code.matchAll(/(?:\$|document\.getElementById)\(\s*["']([\w-]+)["']\s*\)\.(?:setAttribute\(\s*["']aria-label(?:ledby)?["']|ariaLabel\s*=)/g)].map((m) => ({ i: m.index, id: m[1] })),
  ];
  for (const w of writes) {
    const target = w.id ? { ...byId.get(w.id), id: w.id } : vars.get(w.v);
    if (!target?.tag) continue;
    // A role or tabindex the same file gives the variable counts as part of its markup.
    let attrs = target.attrs;
    if (w.v) {
      const role = code.match(new RegExp(`\\b${w.v.replace(/\$/g, "\\$")}\\.setAttribute\\(\\s*["']role["']\\s*,\\s*["']([a-z]+)["']`))?.[1];
      if (role) attrs += ` role="${role}"`;
      if (new RegExp(`\\b${w.v.replace(/\$/g, "\\$")}\\.(tabIndex\\s*=|setAttribute\\(\\s*["']tabindex["'])`).test(code)) attrs += " tabindex=0";
    }
    if (nameProhibited(target.tag, attrs)) out.push(`${at(w.i)}: names <${target.tag}${target.id ? ` id="${target.id}"` : ""}>, a role that can't be named`);
  }
  return out;
}

const pageFiles = (page, exts) => readdirSync(join(UI_ROOT, page)).filter((f) => exts.some((e) => f.endsWith(e))).map((f) => join(UI_ROOT, page, f));
const idsOf = (html) => new Map(tags(html).filter((t) => attrOf(t.attrs, "id")).map((t) => [attrOf(t.attrs, "id"), { tag: t.tag, attrs: t.attrs }]));

// ---- Part 1: static ----

test("the static checks catch what crashed the debug build", () => {
  const html = '<dl><dt>Running in</dt><dd>x</dd></dl><kbd aria-label="Slash">/</kbd><span id="n" class="count" hidden></span><div role="group" aria-label="ok"></div><button aria-label="ok"></button><pre tabindex="0" aria-label="ok"></pre><span title="ok">t</span><svg aria-hidden="true" aria-label="x"></svg>';
  const got = htmlProblems(join(UI_ROOT, "x", "index.html"), html);
  assert.equal(got.length, 3, got.join("\n"));
  assert.match(got[0], /<dt>: a term/);
  assert.match(got[1], /<kbd aria-label="Slash">: a name on a role/);
  assert.match(got[2], /<svg aria-hidden="true" aria-label="x">: a name on an element hidden/);
  const js = 'const c = $("n");\nc.setAttribute("aria-label", words);\nconst more = el("span", {});\nmore.setAttribute("role", "img");\nmore.setAttribute("aria-label", "2 more");\nconst x = el("b", { ariaLabel: "no" });\nconst t = el("dfn", {});';
  const fromJs = jsProblems(join(UI_ROOT, "x", "x.js"), js, idsOf(html));
  assert.deepEqual(fromJs.map((p) => p.replace(/^ui\/x\/x\.js:/, "")), [
    '7: creates a <dfn> (a term is named by its own text)',
    '6: el("b", { ariaLabel }) names a role that can\'t be named',
    '2: names <span id="n">, a role that can\'t be named',
  ]);
});

for (const page of pages()) {
  test(`${page}: names only where Chromium allows them (static)`, () => {
    const htmlFile = join(UI_ROOT, page, "index.html");
    const html = read(htmlFile);
    const problems = htmlProblems(htmlFile, html);
    const byId = idsOf(html);
    for (const f of pageFiles(page, [".js", ".mjs"])) problems.push(...jsProblems(f, read(f), byId));
    assert.deepEqual(problems, [], `${page}:\n${problems.join("\n")}`);
  });
}

test("the shared scripts set names only where the engine allows them (static)", () => {
  const problems = readdirSync(UI_ROOT).filter((f) => f.endsWith(".js")).flatMap((f) => jsProblems(join(UI_ROOT, f), read(join(UI_ROOT, f)), new Map()));
  assert.deepEqual(problems, [], problems.join("\n"));
});

// ---- Part 2: rendered ----

// The named nodes on prohibited roles in every frame of a page: "role "name" <outer html>".
async function renderedProblems(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const frames = [];
    (function walk(t) { frames.push(t.frame.id); for (const c of t.childFrames || []) walk(c); })(frameTree);
    const out = [];
    for (const frameId of frames) {
      const { nodes } = await cdp.send("Accessibility.getFullAXTree", { frameId });
      for (const n of nodes) {
        if (n.ignored || !PROHIBITED_ROLES.has(n.role?.value) || !n.name?.value) continue;
        if (n.properties?.some((p) => p.name === "focusable" && p.value?.value)) continue;
        let html = "";
        if (n.backendDOMNodeId) {
          const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: n.backendDOMNodeId });
          html = (await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function () { return this.outerHTML.slice(0, 160); }", returnByValue: true })).result.value;
        }
        out.push(`${n.role.value} ${JSON.stringify(n.name.value)} ${html}`);
      }
    }
    return out;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

// Shows what waits hidden (the hidden attribute, closed details and dialogs) in every frame, so a
// name on a part that appears later (a count, a confirm, the diagnostics) is read too.
async function revealAll(page) {
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      for (const e of document.querySelectorAll("[hidden]")) e.removeAttribute("hidden");
      for (const d of document.querySelectorAll("details")) d.open = true;
      for (const d of document.querySelectorAll("dialog")) d.setAttribute("open", "");
    }).catch(() => {});
  }
  await page.waitForTimeout(150);
}


test("every page's accessibility tree has names only where the engine allows them", { skip: !runtime, timeout: 300_000 }, async (t) => {
  const browser = await patchright(runtime).chromium.launch();
  // The review shots (their fixtures, hash modes and the extension host), then every page over
  // the default fixtures.
  const scenes = [...SHOTS, ...pages().map((page) => ({ name: `${page} (default fixtures)`, page, width: 969, height: 900, fixtures: {} }))];
  try {
    await t.test("the check sees a named term and a named generic", async () => {
      const helper = await startFakeHelper({});
      const ctx = await openPage(browser, "newtab", { helper });
      try {
        await ctx.page.evaluate(() => {
          const dl = document.createElement("dl");
          const dt = document.createElement("dt"); dt.textContent = "Running in";
          const span = document.createElement("span"); span.setAttribute("aria-label", "3 requests"); span.textContent = "3";
          dl.append(dt); document.body.append(dl, span);
        });
        const got = await renderedProblems(ctx.page);
        assert.ok(got.some((p) => p.startsWith('term "Running in"')), got.join("\n"));
        assert.ok(got.some((p) => p.startsWith('generic "3 requests"')), got.join("\n"));
      } finally {
        await ctx.close();
        await helper.close();
      }
    });
    for (const scene of scenes) {
      await t.test(scene.name, async () => {
        const file = scene.fixtures || lookFixtures(scene.page);
        const fixtures = scene.shim ? { ...file, shim: merge(file.shim || {}, scene.shim) } : file;
        const helper = await startFakeHelper({ pageOrigin: null, fixtures: fixtures.helper, replies: fixtures.replies });
        const ctx = await openPage(browser, scene.page, { helper, fixture: merge(defaultFixture(), fixtures.shim || {}), native: scene.native !== false, viewport: { width: scene.width, height: scene.height } });
        try {
          for (const [event, data] of fixtures.push || []) { helper.push(event, data); await sleep(200); }
          if (scene.hash) { await ctx.page.evaluate((h) => { location.hash = h; }, "#" + scene.hash); await sleep(800); }
          const shown = await renderedProblems(ctx.page);
          assert.deepEqual(shown, [], `${scene.name}, as it renders`);
          await revealAll(ctx.page);
          const all = await renderedProblems(ctx.page);
          assert.deepEqual(all, [], `${scene.name}, every hidden part shown`);
        } finally {
          await ctx.close();
          await helper.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});
