// The pages' common suite: every ui/<page>/index.html, checked the same way.
// Part 1, static (every machine): no inline script, handler or style; the sheet linked first and
// not copied; the logo untouched and never inlined; css colors are sheet values; no markup sinks
// (Trusted Types); reduced motion honoured, no blur or glow.
// Part 2, the harness's own fakes (every machine): the window.pairbrowse shim in node:vm, the
// fake helper's refusals, CORS, burst order and routes.
// Part 3, rendered (PAIRBROWSE_TEST_RUNTIME): each page over the fake helper and the ui server,
// under the chrome pages' CSP: no error, CSP or Trusted Types entry; accessible names; Tab
// reaches every control with the 2 px --accent ring; nothing ticks while hidden; nothing moves
// under reduced motion.
// A page subset adds its own test/ui-<page>.test.mjs (test/ui-right.test.mjs is the template).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { patchright } from "./live.mjs";
import { pages, openPage, runtime } from "./helpers/ui-page.mjs";
import { startFakeHelper } from "./helpers/fake-helper.mjs";
import { startUiServer, UI_ROOT, PAGE_CSP } from "./helpers/ui-server.mjs";
import { defaultFixture, shimScript } from "./helpers/pairbrowse-shim.mjs";

// Known debts of today's pages. An entry is a debt the named subset removes with its fix, never
// a permanent allowance: the suite asserts each one is still true, so the fix fails here until
// its entry goes. New pages get none.
const DEBT = {
};
const debt = (page, kind) => DEBT[page]?.[kind];
const fixed = (page, kind) => `${page}: fixed? remove DEBT.${page}["${kind}"] (${debt(page, kind)})`;

const root = resolve(UI_ROOT, "..");
const read = (p) => readFileSync(p, "utf8");
const filesOf = (page, exts) => readdirSync(join(UI_ROOT, page)).filter((f) => exts.some((e) => f.endsWith(e))).map((f) => join(UI_ROOT, page, f));
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// ---- the sheet (copied from test/tokens.test.mjs, which keeps pinning it) ----
const sheet = read(join(UI_ROOT, "tokens.css"));
const props = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]));
const sheetPlain = noComments(sheet);
const dark = props(sheetPlain.match(/^:root\s*\{([^}]*)\}/m)[1]);
const lightBlock = sheetPlain.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{\s*:root\[data-scheme="system"\]\s*\{([^}]*)\}/);
const light = { ...dark, ...props(lightBlock ? lightBlock[1] : "") };
const TOKEN_NAMES = [...new Set([...sheetPlain.matchAll(/--([a-z0-9-]+)\s*:/g)].map(([, k]) => k))];
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
// CSS named colors (CSS Color 4) a page may not use: the sheet names every color.
const NAMED = new Set(("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral " +
  "cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred " +
  "darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite " +
  "forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush lawngreen " +
  "lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
  "lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
  "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
  "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon " +
  "sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
  "whitesmoke yellow yellowgreen").split(" "));
const COLOR_PROPS = /^(color|background(-color)?|border(-(top|right|bottom|left))?(-color)?|outline(-color)?|fill|stroke|box-shadow|text-shadow|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?)$/;

// ---- page files ----
const attrs = (html, tag) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, "gi"))].map(([, a]) => a);
const attr = (a, name) => { const m = a.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i")); return m ? (m[2] ?? m[3] ?? m[4]) : null; };
const inUi = (file) => { const r = relative(UI_ROOT, file); return !!r && !r.startsWith("..") && !r.startsWith("/"); };

// Rules over a page's css: { missingReduced, longTransitions, infinite, glowFrames, blur }.
function motion(page) {
  const out = { missingReduced: [], longTransitions: [], infinite: [], glowFrames: [], blur: [] };
  for (const f of filesOf(page, [".css"])) {
    const css = noComments(read(f));
    const name = relative(root, f);
    if (/\b(transition|animation)\s*:/.test(css) && !/@media\s*\(prefers-reduced-motion:\s*reduce\)/.test(css)) out.missingReduced.push(name);
    if (/backdrop-filter/.test(css) || /filter\s*:[^;]*blur\(/.test(css)) out.blur.push(name);
    // Rules outside the reduced-motion block (it only turns motion off).
    const plain = css.replace(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
    for (const [, sel, body] of plain.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
      const live = /(^|[\s,>+~])\.live\b/.test(sel.trim()) && !/,/.test(sel); // the Live dot: the one pulse
      for (const [, value] of body.matchAll(/(?:^|;)\s*transition\s*:\s*([^;]+)/g)) {
        const times = [...value.replace(/var\(--t\)/g, "160ms").matchAll(/(\d*\.?\d+)(ms|s)\b/g)].map(([, n, u]) => Number(n) * (u === "s" ? 1000 : 1));
        if (times.some((t) => t > 200)) out.longTransitions.push(`${name}: ${sel.trim()} { transition: ${value.trim()} }`);
      }
      for (const [, value] of body.matchAll(/(?:^|;)\s*animation(?:-iteration-count)?\s*:\s*([^;]+)/g)) {
        if (/\binfinite\b/.test(value) && !live) out.infinite.push(`${name}: ${sel.trim()}`);
      }
    }
    for (const [, kf] of plain.matchAll(/@keyframes\s+([\w-]+)/g)) {
      if (!/^(pulse|glow)/i.test(kf)) continue;
      const users = [...plain.matchAll(new RegExp(`([^{}@]+)\\{[^{}]*animation(?:-name)?\\s*:[^;}]*\\b${kf}\\b`, "g"))].map(([, s]) => s.trim());
      if (!users.length || users.some((s) => !/(^|[\s>+~])\.live$/.test(s))) out.glowFrames.push(`${name}: @keyframes ${kf} on ${users.join(", ") || "nothing"}`);
    }
  }
  return out;
}

const LOGO = read(join(UI_ROOT, "logo.svg"));
const LOGO_SIGNATURE = LOGO.match(/\sd="([^"]+)"/)[1].slice(0, 40);
const SINKS = /\binnerHTML\b|\bouterHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b|\beval\(|\bnew Function\b|setAttribute\(\s*["']style["']/;

test("the DEBT table names only pages that exist", () => {
  for (const page of Object.keys(DEBT)) assert.ok(pages().includes(page), `DEBT.${page}: no ui/${page}/index.html`);
});

test("the logo is unchanged", () => {
  assert.equal(createHash("sha256").update(readFileSync(join(UI_ROOT, "logo.svg"))).digest("hex"), "415a3f8e100338210d7ffc070dd1d7ced24297bb682af9a4153a9f49d1bffd8a");
});

for (const page of pages()) {
  const dir = join(UI_ROOT, page);
  const htmlFile = join(dir, "index.html");
  const html = read(htmlFile);
  const jsFiles = filesOf(page, [".js", ".mjs"]);
  const cssFiles = filesOf(page, [".css"]);

  test(`${page}: static`, async (t) => {
    await t.test("no inline script, handler, style or javascript: URL", () => {
      for (const a of attrs(html, "script")) assert.ok(attr(a, "src"), `${page}: <script${a}> has no src`);
      for (const [tag] of html.matchAll(/<[a-z][^>]*>/gi)) {
        assert.doesNotMatch(tag, /\son[a-z]+\s*=/i, `${page}: handler attribute in ${tag}`);
        assert.doesNotMatch(tag, /\sstyle\s*=/i, `${page}: style attribute in ${tag}`);
      }
      assert.doesNotMatch(html, /<style\b/i, `${page}: <style>`);
      assert.doesNotMatch(html, /javascript:/i, `${page}: javascript: URL`);
    });

    await t.test("scripts and sheets are local files under ui/", () => {
      for (const a of attrs(html, "script")) {
        const src = attr(a, "src");
        assert.doesNotMatch(src, /^[a-z]+:|^\/\//i, `${page}: remote script ${src}`);
        const type = attr(a, "type");
        assert.ok(type === null || type === "module" || type === "text/javascript", `${page}: <script type=${type}>`);
        const file = resolve(dir, src);
        assert.ok(inUi(file) && existsSync(file), `${page}: ${src} is not a file under ui/`);
      }
      for (const a of attrs(html, "link")) {
        const href = attr(a, "href");
        assert.doesNotMatch(href, /^[a-z]+:|^\/\//i, `${page}: remote link ${href}`);
        const file = resolve(dir, href);
        assert.ok(inUi(file) && existsSync(file), `${page}: ${href} is not a file under ui/`);
      }
    });

    await t.test("the sheet is linked first and not copied", () => {
      const sheets = attrs(html, "link").filter((a) => /stylesheet/i.test(attr(a, "rel") || "")).map((a) => attr(a, "href"));
      if (!sheets.length) return;
      assert.equal(sheets[0], "../tokens.css", `${page}: tokens.css comes before the page's own sheet`);
      for (const href of sheets.slice(1)) assert.equal(dirname(resolve(dir, href)), dir, `${page}: ${href} is not ui/${page}/*.css`);
      for (const f of cssFiles) {
        const css = noComments(read(f));
        for (const k of TOKEN_NAMES) assert.doesNotMatch(css, new RegExp(`--${k}\\s*:`), `${relative(root, f)} redefines --${k}`);
      }
    });

    await t.test("the logo comes from ui/ and is never inlined", () => {
      const refs = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]*(?:logo\.svg|icon[^"/]*\.png))"/g), ...cssFiles.flatMap((f) => [...read(f).matchAll(/url\(\s*["']?([^"')]*(?:logo\.svg|icon[^"')/]*\.png))/g)])].map(([, r]) => r);
      for (const r of refs) assert.equal(dirname(resolve(dir, r)), UI_ROOT, `${page}: ${r} is not the ui/ root's file`);
      for (const f of [htmlFile, ...cssFiles, ...jsFiles, ...filesOf(page, [".svg"])]) assert.ok(!read(f).includes(LOGO_SIGNATURE), `${relative(root, f)} inlines the logo's path`);
    });

    await t.test("every css color is a sheet value", async () => {
      const { SPARK_COLORS } = await import("../scripts/daemon/hud.mjs");
      const allowed = new Set(["#ffffff", "#000000", ...SPARK_COLORS.map(norm)]);
      for (const tk of [dark, light]) for (const v of Object.values(tk)) { const n = norm(v); if (n) allowed.add(n); }
      for (const f of cssFiles) {
        const css = noComments(read(f));
        const name = relative(root, f);
        assert.doesNotMatch(css, /\bhsla?\(/, `${name}: hsl() colors`);
        for (const [c] of css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|oklch\((?:[^()]|\([^()]*\))*\)/g)) {
          if (/var\(--h\b/.test(c)) continue;
          if (c.startsWith("oklch")) { assert.match(c, /^oklch\((1|0) 0 0( \/ [\d.]+)?\)$/, `${name}: ${c} is not a sheet value`); continue; }
          const n = norm(c);
          assert.ok(n && allowed.has(n), `${name}: ${c} is not a sheet value`);
        }
        for (const [, prop, value] of css.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:\s*([^;{}]+)/g)) {
          if (!COLOR_PROPS.test(prop)) continue;
          for (const word of value.replace(/var\([^)]*\)|url\([^)]*\)|"[^"]*"/g, " ").toLowerCase().split(/[^a-z]+/)) assert.ok(!NAMED.has(word), `${name}: ${prop}: ${value.trim()} names a color`);
        }
      }
    });

    await t.test("no markup sinks (Trusted Types)", () => {
      const hits = jsFiles.filter((f) => SINKS.test(read(f).replace(/^\s*\/\/.*$/gm, ""))).map((f) => relative(root, f));
      if (debt(page, "trusted-types")) assert.ok(hits.length > 0, fixed(page, "trusted-types"));
      else assert.deepEqual(hits, [], `${page}: a markup sink (build nodes, or textContent)`);
    });

    await t.test("motion: reduced motion honoured, short transitions, no glow, no endless loop but the Live dot", () => {
      const m = motion(page);
      const found = [...m.missingReduced.map((f) => `${f}: transition/animation without a prefers-reduced-motion block`), ...m.longTransitions, ...m.infinite.map((s) => `${s}: an endless animation`), ...m.glowFrames, ...m.blur.map((f) => `${f}: blur`)];
      if (debt(page, "motion")) assert.ok(found.length > 0, fixed(page, "motion"));
      else assert.deepEqual(found, [], `${page}: motion`);
    });
  });
}

// ---- Part 2: the harness's own fakes ----

test("the shim: window.pairbrowse as the page contract says", async () => {
  const fixture = defaultFixture();
  fixture.helper = { origin: "http://127.0.0.1:9", key: "k" };
  const sandbox = { queueMicrotask, JSON, Promise, Object, Math, Number, String, Array };
  sandbox.window = sandbox;
  vm.runInNewContext(shimScript(fixture), sandbox);
  const { pairbrowse: pb, __pairbrowse: controls } = sandbox;
  const plainCopy = (v) => JSON.parse(JSON.stringify(v));
  assert.deepEqual(plainCopy(await pb.tabs.list()), { tabs: fixture.tabs });
  assert.deepEqual(plainCopy(await pb.session.helper()), { origin: "http://127.0.0.1:9", key: "k" });
  assert.deepEqual(Object.keys(pb).sort(), ["DockState", "NetworkState", "SecurityLevel", "agent", "files", "layout", "omnibox", "session", "tabs", "windows"]);
  assert.equal(pb.DockState.kOpen, 2);

  const seen = [];
  const remove = pb.tabs.addObserver({ onActivated: (id, w) => seen.push([id, w]) });
  await pb.tabs.activate(12);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [[12, 1]]);
  assert.ok(controls.calls.some((c) => c.iface === "tabs" && c.method === "activate" && c.args[0] === 12));
  remove();
  await pb.tabs.activate(11);
  await new Promise((r) => setImmediate(r));
  assert.equal(seen.length, 1, "remove() stops delivery");

  const layouts = [];
  pb.layout.addObserver({ onLayout: (s) => layouts.push(s) });
  const next = { ...fixture.layout, left: 1 };
  await pb.layout.set(next);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(plainCopy(layouts), [next]);

  const owners = await pb.agent.getOwners();
  assert.deepEqual(plainCopy(owners), { agents: { 11: "Claude" }, colors: { 11: "#e9763f" } });
  assert.equal(Object.getPrototypeOf(owners.agents), sandbox.Object.prototype, "a plain object, not a Map");
});

const request = (url, { method = "GET", headers = {}, body } = {}) => new Promise((resolveIt, reject) => {
  const req = http.request(url, { method, headers }, (res) => {
    let text = "";
    res.on("data", (c) => { text += c; });
    res.on("end", () => resolveIt({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on("error", reject);
  if (body !== undefined) req.write(body);
  req.end();
});

// The first events of a stream, up to `until`.
function burst(url, until) {
  return new Promise((resolveIt, reject) => {
    const req = http.get(url, (res) => {
      let text = "";
      res.on("data", (c) => {
        text += c;
        if (text.includes(`event: ${until}\n`) && text.endsWith("\n\n")) { req.destroy(); resolveIt(text); }
      });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" ? null : reject(e)));
  });
}

test("the fake helper answers as the live view does", async () => {
  const pageOrigin = "http://127.0.0.1:1";
  const helper = await startFakeHelper({ pageOrigin, fixtures: { timeline: { cards: [{ id: "0123456789ab" }] } } });
  try {
    const ok = await request(`${helper.base}state.json`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["access-control-allow-origin"], pageOrigin);
    assert.equal((await request(`${helper.origin}/wrong-key/state.json`)).status, 404);
    assert.equal((await request(`${helper.base}state.json`, { headers: { host: "evil.example" } })).status, 403);
    const pause = (origin) => request(`${helper.base}pause`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: '{"paused":true}' });
    assert.equal((await pause("http://evil.example")).status, 403);
    const paused = await pause(pageOrigin);
    assert.equal(paused.status, 200);
    assert.deepEqual(JSON.parse(paused.text), { paused: true, can: true });
    assert.equal((await request(`${helper.base}pause`, { method: "OPTIONS", headers: { origin: pageOrigin } })).status, 204);
    assert.equal((await request(`${helper.base}approve`, { method: "POST", headers: { origin: pageOrigin }, body: JSON.stringify({ pad: "x".repeat(3000) }) })).status, 413);

    const strip = await burst(`${helper.base}events?page=strip`, "agent-tabs");
    assert.ok(strip.startsWith(": hi\n\n"), "comment line first");
    assert.deepEqual([...strip.matchAll(/^event: (\S+)$/gm)].map(([, e]) => e), ["tabs", "status", "session", "collaboration", "activity", "join", "layout", "agent-tabs"]);
    const panel = await burst(`${helper.base}events?panel=1`, "layout");
    assert.doesNotMatch(panel, /agent-tabs/);

    const pushed = new Promise((resolveIt) => {
      const req = http.get(`${helper.base}events?panel=1`, (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
          if (text.includes("event: layout\n") && !text.includes("event: status\ndata: {\"text\":\"Filling\"")) helper.push("status", { text: "Filling", kind: "working" });
          if (text.includes('"text":"Filling"')) { req.destroy(); resolveIt(true); }
        });
      });
      req.on("error", () => {});
    });
    assert.equal(await pushed, true, "helper.push reaches an open stream");

    const del = () => request(`${helper.base}timeline/0123456789ab`, { method: "DELETE", headers: { origin: pageOrigin } });
    assert.equal((await del()).status, 200);
    assert.equal((await del()).status, 404);
  } finally {
    await helper.close();
  }
});

test("the ui server serves pages under the chrome pages' CSP, on an origin of their own", async () => {
  const helper = await startFakeHelper({});
  const ui = await startUiServer({ helper });
  try {
    const res = await request(ui.url("right"));
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-security-policy"], PAGE_CSP(helper.origin));
    assert.match(res.headers["content-security-policy"], /script-src 'self';.*require-trusted-types-for 'script'; trusted-types static-types$/);
    assert.notEqual(ui.origin, helper.origin);
    const at = res.text.indexOf('<script src="/__harness/prelude.js">');
    assert.ok(at >= 0 && at < res.text.indexOf('src="right.js"'), "the harness scripts come first");
    assert.equal((await request(`${ui.origin}/../package.json`)).status, 404);
    assert.equal((await request(`${ui.origin}/right/missing.js`)).status, 404);
    assert.equal((await request(`${ui.origin}/__harness/pairbrowse-api.js`)).status, 200);
  } finally {
    await ui.close();
    await helper.close();
  }
});

// ---- Part 3: rendered ----

const INTERACTIVE = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [role=button], [role=link]';

// In the page: the visible controls with their accessible names (a short computation: aria-label,
// aria-labelledby, label, text, img alt, title, placeholder).
function controls(selector) {
  const label = (el) => {
    const a = el.getAttribute("aria-label");
    if (a && a.trim()) return a.trim();
    const by = el.getAttribute("aria-labelledby");
    if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim(); if (t) return t; }
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && l.textContent.trim()) return l.textContent.trim(); }
    const wrap = el.closest("label");
    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim();
    if (!["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) && el.textContent.trim()) return el.textContent.trim();
    const img = el.querySelector("img[alt]");
    if (img && img.alt.trim()) return img.alt.trim();
    return (el.getAttribute("title") || el.getAttribute("placeholder") || "").trim();
  };
  return [...document.querySelectorAll(selector)].filter((el) => el.checkVisibility() && !el.disabled).map((el, i) => {
    el.dataset.harnessId = String(i);
    return { id: String(i), tag: el.tagName.toLowerCase(), elId: el.id, name: label(el) };
  });
}

test("every page renders cleanly over the fake helper", { skip: !runtime, timeout: 180_000 }, async (t) => {
  const browser = await patchright(runtime).chromium.launch();
  try {
    for (const page of pages()) {
      await t.test(page, async (st) => {
        const helper = await startFakeHelper({});
        let ctx = await openPage(browser, page, { helper });
        try {
          await st.test("console, CSP and Trusted Types clean", async () => {
            assert.deepEqual(ctx.errors, [], `${page}: page errors`);
            const bad = (await ctx.harness.log()).filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind));
            assert.deepEqual(bad, [], `${page}: ${bad.some((e) => /trusted-types/.test(e.violatedDirective || "")) ? "a Trusted Types violation" : "errors in the page"}`);
          });

          const list = await ctx.inPage(controls, INTERACTIVE);
          await st.test("every visible control has an accessible name", () => {
            const nameless = list.filter((c) => !c.name);
            assert.deepEqual(nameless, [], `${page}: controls without a name`);
          });

          await st.test("Tab reaches every control, with the 2 px --accent ring", async () => {
            const ring = await ctx.inPage(() => {
              const probe = document.createElement("span");
              probe.style.color = "var(--accent)";
              document.body.appendChild(probe);
              const c = getComputedStyle(probe).color;
              probe.remove();
              document.activeElement?.blur?.();
              document.body.tabIndex = -1;
              document.body.focus();
              document.body.removeAttribute("tabindex");
              return c;
            });
            const reached = new Map();
            for (let i = 0; i < list.length + 5; i++) {
              await ctx.page.keyboard.press("Tab");
              const at = await ctx.inPage(() => {
                const el = document.activeElement;
                if (!el || el === document.body) return null;
                const s = getComputedStyle(el);
                return { id: el.dataset.harnessId ?? null, tag: el.tagName.toLowerCase(), elId: el.id, style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
              });
              if (at?.id != null && !reached.has(at.id)) reached.set(at.id, at);
            }
            const missing = list.filter((c) => !reached.has(c.id)).map((c) => `${c.tag}#${c.elId}`);
            assert.deepEqual(missing, [], `${page}: not reached with Tab`);
            const unringed = [...reached.values()].filter((s) => s.style !== "solid" || s.width !== "2px" || s.color !== ring).map((s) => `${s.tag}#${s.elId} (${s.style} ${s.width} ${s.color})`);
            if (debt(page, "focus-ring")) assert.ok(unringed.length > 0, fixed(page, "focus-ring"));
            else assert.deepEqual(unringed, [], `${page}: focus without the 2 px ${ring} ring`);
          });

          await st.test("nothing ticks while hidden", async () => {
            await ctx.harness.setHidden(true);
            await ctx.page.waitForTimeout(400);
            const live = await ctx.harness.live();
            const fires0 = await ctx.harness.hiddenFires();
            await ctx.page.waitForTimeout(500);
            const fires = (await ctx.harness.hiddenFires()) - fires0;
            const count = live.timeouts + live.intervals + live.frames + live.observers;
            await ctx.harness.setHidden(false);
            if (debt(page, "hidden-timer")) assert.ok(count > 0, fixed(page, "hidden-timer"));
            else {
              assert.equal(count, 0, `${page}: timers, frames or observers live while hidden: ${JSON.stringify(live)}`);
              assert.equal(fires, 0, `${page}: callbacks ran while hidden`);
            }
          });

          await ctx.close();
          ctx = await openPage(browser, page, { helper, reducedMotion: "reduce" });
          await st.test("nothing moves under reduced motion", async () => {
            const first = (await ctx.inPage(controls, INTERACTIVE))[0];
            if (first) {
              const sel = `[data-harness-id="${first.id}"]`;
              await ctx.page.focus(sel);
              await ctx.page.hover(sel);
            }
            await ctx.page.waitForTimeout(100);
            assert.deepEqual(await ctx.harness.animations(), [], `${page}: running animations under reduced motion`);
          });
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

test("a string written to innerHTML under the page CSP is a Trusted Types entry in the log", { skip: !runtime, timeout: 60_000 }, async () => {
  const browser = await patchright(runtime).chromium.launch();
  const helper = await startFakeHelper({});
  const ctx = await openPage(browser, "newtab", { helper });
  try {
    await ctx.inPage(() => { try { document.body.appendChild(document.createElement("div")).innerHTML = "<b>x</b>"; } catch {} });
    const entries = (await ctx.harness.log()).filter((e) => e.kind === "csp");
    assert.ok(entries.some((e) => /trusted-types/.test(e.violatedDirective)), JSON.stringify(entries));
  } finally {
    await ctx.close();
    await helper.close();
    await browser.close();
  }
});
