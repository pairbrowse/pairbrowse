// The pages' common suite: every ui/<page>/index.html, checked the same way.
// Part 1, static (every machine): no inline script, handler or style; the sheet linked first and
// not copied; the logo untouched and never inlined; css colors are sheet values; no markup sinks
// (Trusted Types); reduced motion honoured, no blur, no animated glow (static light is the sheet's tokens).
// Part 2, the harness's own fakes (every machine): the window.pairbrowse shim in node:vm, the
// fake helper's refusals, CORS, burst order and routes.
// Part 3, rendered (PAIRBROWSE_TEST_RUNTIME): each page over the fake helper and the ui server,
// under the chrome pages' CSP: no error, CSP or Trusted Types entry; accessible names; Tab
// reaches every control with the 2 px --accent ring; nothing ticks while hidden; nothing moves
// under reduced motion.
// A page subset adds its own test/ui-<page>.test.mjs (test/ui-right.test.mjs is the template).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { patchright, inPage } from "./live.mjs";
import { pages, openPage, runtime } from "./helpers/ui-page.mjs";
import { startFakeHelper } from "./helpers/fake-helper.mjs";
import { startUiServer, UI_ROOT, PAGE_CSP, FRAMEABLE } from "./helpers/ui-server.mjs";
import { SHOTS } from "../scripts/dev/ui-look-all.mjs";
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

// The review tool (scripts/dev/ui-look-all.mjs) keeps up with the pages: every visible page has a
// review fixture and a shot, and the two copied fixtures stay equal to the tests' own.
test("every visible page has a review fixture and a shot", () => {
  const visible = pages().filter((p) => p !== "capture");
  assert.deepEqual([...new Set(SHOTS.map((s) => s.page))].sort(), visible);
  const look = join(root, "scripts", "dev", "look");
  for (const page of visible) {
    const fx = JSON.parse(read(join(look, `${page}.json`)));
    assert.ok(fx && typeof fx === "object" && !Array.isArray(fx), `look/${page}.json is an object`);
    for (const k of Object.keys(fx)) assert.ok(["helper", "replies", "shim", "push"].includes(k), `look/${page}.json: unknown key ${k}`);
    for (const entry of fx.push || []) assert.ok(Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string", `look/${page}.json: a push entry is [event, data]`);
  }
  assert.deepEqual(JSON.parse(read(join(look, "approve.json"))), JSON.parse(read(join(root, "test", "fixtures", "ui-approve.json"))));
  assert.deepEqual(JSON.parse(read(join(look, "settings.json"))), JSON.parse(read(join(root, "test", "fixtures", "ui-settings.json"))));
  for (const shot of SHOTS) {
    assert.ok(Number.isInteger(shot.width) && shot.width > 0 && Number.isInteger(shot.height) && shot.height > 0, `${shot.name}: a size`);
    if (shot.hash !== undefined) assert.ok(["nav-left", "nav-right", "share"].includes(shot.hash), `${shot.name}: one of the strip's modes`);
  }
});

// ---- one event stream per origin (common.js helperStream) ----
const uiScripts = () => readdirSync(UI_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(join(UI_ROOT, d.name)).filter((f) => f.endsWith(".js")).map((f) => join(UI_ROOT, d.name, f)))
  .concat(readdirSync(UI_ROOT).filter((f) => f.endsWith(".js") && f !== "common.js").map((f) => join(UI_ROOT, f)));

test("only ui/common.js opens an event stream to the helper", () => {
  const common = read(join(UI_ROOT, "common.js"));
  assert.match(common, /new EventSource\(/, "common.js holds the one stream");
  for (const f of uiScripts()) {
    // The code only: a comment may name the route the shared stream opens.
    const js = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
    assert.ok(!/new EventSource\b/.test(js), `${relative(root, f)} opens no stream of its own`);
    // The one exception: the capture page's own keyed stream (page=capture with its launch capture
    // key, which helperStream has no place for; transport-native.js keyedStream), and no other route.
    const routes = js.match(/events\?[^`'"]*/g) || [];
    if (relative(UI_ROOT, f) === join("capture", "transport-native.js")) {
      assert.deepEqual(routes, ["events?panel=1&page=capture&ck=${encodeURIComponent(ck)}"], `${relative(root, f)} names only the capture page's keyed stream`);
    } else assert.deepEqual(routes, [], `${relative(root, f)} names no stream route`);
  }
});

test("every event a page listens to on the shared stream is in STREAM_EVENTS", async () => {
  const { STREAM_EVENTS, OWN_STREAM_EVENTS } = await import(join(UI_ROOT, "common.js"));
  let checked = 0;
  for (const f of uiScripts()) {
    const js = read(f);
    if (!/\bhelperStream\b/.test(js)) continue;
    // A page kind's own events (the capture page's calls) only in a file whose stream is of that kind.
    const kinds = [...js.matchAll(/\bkind:\s*["']([a-z]+)["']/g)].map(([, k]) => k);
    for (const [, name] of js.matchAll(/\bon\(\s*["']([^"']+)["']/g)) {
      const own = kinds.some((k) => Object.hasOwn(OWN_STREAM_EVENTS, k) && OWN_STREAM_EVENTS[k].includes(name));
      assert.ok(STREAM_EVENTS.includes(name) || own, `${relative(root, f)}: on("${name}") is not in STREAM_EVENTS`);
      checked++;
    }
  }
  assert.ok(checked > 20, `the pages' handlers were found (${checked})`);
});

// A page kind's own events never reach the shared stream: none is in STREAM_EVENTS (so the stream's
// holder never relays or replays one), and only the capture page has any.
test("own-stream events stay off the shared stream", async () => {
  const { STREAM_EVENTS, OWN_STREAM_EVENTS } = await import(join(UI_ROOT, "common.js"));
  assert.deepEqual(Object.keys(OWN_STREAM_EVENTS), ["capture"]);
  assert.deepEqual(OWN_STREAM_EVENTS.capture, ["capture"]);
  for (const names of Object.values(OWN_STREAM_EVENTS)) for (const n of names) assert.ok(!STREAM_EVENTS.includes(n), `${n} is in STREAM_EVENTS`);
  const common = read(join(UI_ROOT, "common.js"));
  assert.match(common, /if \(ownEvents\.length\) shared = false;/, "a kind with own events always gets its own stream");
  assert.match(common, /es = openStream\(base, ownKind, \{ event: deliver, state: setState \}, ownEvents\);/, "only the page's own stream listens for them");
  assert.equal([...common.matchAll(/ownEvents\)/g)].length, 1, "the shared stream (openHeld) never does");
});

test("the strip's nav fragments never connect", () => {
  const js = read(join(UI_ROOT, "strip", "strip.js"));
  const ensure = js.match(/async function ensureStream\(\) \{([\s\S]*?)\n\}/);
  assert.ok(ensure, "ensureStream guards the stream");
  assert.match(ensure[1], /^\s*if \(navMode\(\)\) \{/, "the nav check comes first");
  assert.match(js, /const navMode = \(\) => mode === "nav-left" \|\| mode === "nav-right";/);
  assert.equal([...js.matchAll(/\bconnect\(/g)].length, 2, "connect is defined once and called only from ensureStream");
  assert.match(ensure[1], /connect\(url\)/);
});

// ---- Part 2: the harness's own fakes ----

test("the shim: the cross-slot bubbles (530 E1) only with the fixture's bubbles", async () => {
  const run = (fixture) => { const sandbox = { queueMicrotask, JSON, Promise, Object, Math, Number, String, Array }; sandbox.window = sandbox; vm.runInNewContext(shimScript(fixture), sandbox); return sandbox; };
  assert.equal(run(defaultFixture()).pairbrowse.bubbles, undefined, "a build without them by default");
  const { pairbrowse: pb, __pairbrowse: controls } = run({ ...defaultFixture(), bubbles: true });
  const closed = [];
  pb.bubbles.addObserver({ onClosed: (kind, byEscape) => closed.push([kind, byEscape]) });
  assert.deepEqual(JSON.parse(JSON.stringify(await pb.bubbles.open(0, { x: 1, y: 2, width: 3, height: 4 }, ""))), { shown: true });
  assert.equal(controls.bubbles.open, 0);
  await pb.bubbles.open(1, { x: 1, y: 2, width: 3, height: 4 }, "");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(closed, [[0, false]], "one bubble at a time");
  controls.bubbles.closed(1, true);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(closed.at(-1), [1, true]);
  assert.equal(controls.bubbles.open, null);
});

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
  assert.deepEqual(Object.keys(pb).sort(), ["BubbleKind", "DockState", "NetworkState", "SecurityLevel", "agent", "approval", "files", "layout", "omnibox", "session", "tabs", "windows"]);
  assert.equal(pb.DockState.kOpen, 2);
  assert.deepEqual({ ...pb.BubbleKind }, { kSwitcher: 0, kShare: 1, kPicture: 2, kAppMenu: 3 });
  // The approval bubble's host (530): setPending(count, targetId) is recorded, nothing more.
  assert.equal(await pb.approval.setPending(2, "T11"), undefined);
  assert.deepEqual(plainCopy(controls.calls.at(-1)), { iface: "approval", method: "setPending", args: [2, "T11"] });

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

test("the fake helper serves approvals to approve.js's contract", async () => {
  const pageOrigin = "http://127.0.0.1:1";
  const OLDER = JSON.parse(read(join(root, "test", "fixtures", "ui-approve.json"))).push[0][1].item;
  const helper = await startFakeHelper({ pageOrigin });
  const approve = (body) => request(`${helper.base}approve`, { method: "POST", headers: { origin: pageOrigin, "content-type": "application/json" }, body: JSON.stringify(body) });
  const pending = async () => { const r = await request(`${helper.base}approvals.json`); return { status: r.status, body: JSON.parse(r.text) }; };
  try {
    assert.deepEqual(await pending(), { status: 200, body: { pending: [] } });
    helper.push("approval", { op: "add", item: OLDER });
    assert.deepEqual(await pending(), { status: 200, body: { pending: [OLDER] } });
    assert.equal((await approve({ id: OLDER.id, answer: "maybe" })).status, 400);
    assert.equal((await approve({ id: "", answer: "allow" })).status, 400);
    const unknown = await approve({ id: "ap-unknown", answer: "allow" });
    assert.equal(unknown.status, 404);
    assert.deepEqual(JSON.parse(unknown.text), { ok: false });
    // An answer for a pending id: 200, a withdraw event on the stream, and the list empties.
    const withdrawn = new Promise((resolveIt) => {
      const req = http.get(`${helper.base}events?page=approve`, (res) => {
        let text = "", sent = false;
        res.on("data", (c) => {
          text += c;
          if (!sent && text.includes("event: layout\n")) { sent = true; approve({ id: OLDER.id, answer: "allow" }).then((r) => { text += `\n#answer ${r.status} ${r.text}\n`; }); }
          const m = /event: approval\ndata: (.+)\n/.exec(text);
          if (m) { req.destroy(); resolveIt({ event: JSON.parse(m[1]) }); }
        });
      });
      req.on("error", () => {});
    });
    const { event } = await withdrawn;
    assert.deepEqual(event, { op: "withdraw", item: { id: OLDER.id } });
    assert.deepEqual(await pending(), { status: 200, body: { pending: [] } });
    assert.equal((await approve({ id: OLDER.id, answer: "allow" })).status, 404, "gone once answered");
    // A join answer ({ id, allow }) keeps today's default.
    const join_ = await approve({ id: "j1", allow: true });
    assert.equal(join_.status, 200);
    assert.deepEqual(JSON.parse(join_.text), { ok: true });
  } finally {
    await helper.close();
  }
  const none = await startFakeHelper({ fixtures: { approvals: null } });
  try {
    assert.equal((await request(`${none.base}approvals.json`)).status, 404, "null: none pending");
  } finally {
    await none.close();
  }
});

test("the fake helper serves the tools routes to the contract", async () => {
  const pageOrigin = "http://127.0.0.1:1";
  const fixtures = {
    handoffs: { items: [{ id: "h1", kind: "2fa", text: "Enter the code", tab: { id: 1, host: "shop.example", title: "Shop" }, by: { label: "Claude", color: "#e9763f" }, at: 1 }] },
    downloads: { items: [{ id: "d1", name: "a.pdf", size: 10, at: 1, from: { host: "shop.example", title: "Shop" }, state: "done", by: { label: "Claude", color: "#e9763f" } },
      { id: "d2", name: "b.pdf", state: "done", opens: "tab" }] },
    recordings: { items: [{ id: "r1", name: "a.webm", size: 10, at: 1, duration: 3 }] },
  };
  const helper = await startFakeHelper({ pageOrigin, fixtures });
  const get = async (h, route) => { const r = await request(`${h.base}${route}`); return { status: r.status, body: r.status === 200 ? JSON.parse(r.text) : null }; };
  const send = (route, { method = "POST", origin = pageOrigin, body } = {}) => request(`${helper.base}${route}`, { method, headers: { origin, ...(body ? { "content-type": "application/json" } : {}) }, body });
  try {
    assert.deepEqual(await get(helper, "handoffs.json"), { status: 200, body: fixtures.handoffs });
    assert.deepEqual(await get(helper, "downloads.json"), { status: 200, body: fixtures.downloads });
    const recs = await get(helper, "recordings.json");
    assert.equal(recs.status, 200);
    assert.deepEqual(recs.body.recording, { on: false, since: 0 });
    assert.deepEqual(recs.body.items, fixtures.recordings.items);
    const diag = await get(helper, "diagnostics.json");
    assert.equal(diag.status, 200);
    assert.deepEqual(Object.keys(diag.body), ["helper", "browser", "connections", "joined", "errors"]);
    assert.deepEqual(Object.keys(diag.body.helper), ["version", "node", "uptime"]);
    assert.ok(["pairbrowse", "chromium", "path"].includes(diag.body.browser.engine));
    assert.deepEqual(Object.keys(diag.body.connections), ["agents", "viewers", "joiners", "streams"]);

    assert.equal((await send("downloads/d1/open")).status, 200);
    assert.deepEqual(helper.posts.at(-1), { route: "downloads", rest: ["d1", "open"], body: null });
    assert.equal((await send("downloads/d1/reveal")).status, 200);
    const unknown = await send("downloads/zz/open");
    assert.equal(unknown.status, 404);
    assert.deepEqual(JSON.parse(unknown.text), { ok: false });
    const app = await send("downloads/d1/open-app");
    assert.equal(app.status, 200);
    assert.deepEqual(JSON.parse(app.text), { ok: true, opened: "app" });
    assert.deepEqual(helper.posts.at(-1), { route: "downloads", rest: ["d1", "open-app"], body: null });
    const appUnknown = await send("downloads/zz/open-app");
    assert.equal(appUnknown.status, 404);
    assert.deepEqual(JSON.parse(appUnknown.text), { ok: false });
    assert.deepEqual(JSON.parse((await send("downloads/d1/open")).text), { ok: true }, "no `opened` unless the fixture says");
    assert.deepEqual(JSON.parse((await send("downloads/d2/open")).text), { ok: true, opened: "tab" });
    assert.equal((await send("downloads/d1/delete")).status, 404, "another action: no route");
    assert.equal((await send("downloads/d1")).status, 404);
    assert.equal((await send("recordings/r1/reveal")).status, 200);
    assert.equal((await send("recordings/r1/open-app")).status, 404, "recordings have no open-app");
    assert.equal((await send("handoffs/h1/show")).status, 200);
    assert.equal((await send("handoffs/h1/open")).status, 404);
    assert.equal((await send("handoffs/h1/show", { origin: "http://evil.example" })).status, 403, "a foreign Origin");
    const report = await send("diagnostics/report");
    assert.equal(report.status, 200);
    assert.equal(typeof JSON.parse(report.text).text, "string");
    assert.equal((await send("diagnostics/send")).status, 404, "no send route");

    assert.equal((await send("recordings/r1", { method: "DELETE", origin: "http://evil.example" })).status, 403, "DELETE from a foreign Origin");
    assert.equal(helper.deletes.length, 0);
    assert.equal((await send("recordings/r1", { method: "DELETE" })).status, 200);
    assert.equal((await send("recordings/r1", { method: "DELETE" })).status, 404, "gone once deleted");
    assert.deepEqual(helper.deletes, [{ route: "recordings", rest: ["r1"] }]);
    assert.deepEqual((await get(helper, "recordings.json")).body.items, []);
    assert.equal((await send("recordings/r1/open")).status, 404, "a deleted recording opens nothing");

    // POST layout's tab: in the answer and the event, never in layout.json.
    const evented = new Promise((resolveIt) => {
      const req = http.get(`${helper.base}events?panel=1`, (res) => {
        let text = "", sent = false;
        res.on("data", (c) => {
          text += c;
          if (!sent && text.includes("event: layout\n")) { sent = true; send("layout", { body: JSON.stringify({ right: "open", tab: "tools" }) }).then((r) => { text += `\n#answer ${r.text}\n`; }); }
          const m = [...text.matchAll(/event: layout\ndata: (.+)\n/g)];
          if (m.length === 2) { req.destroy(); resolveIt(JSON.parse(m[1][1])); }
        });
      });
      req.on("error", () => {});
    });
    assert.deepEqual(await evented, { left: "open", right: "open", strip: 88, tab: "tools" });
    const answer = await send("layout", { body: '{"tab":"tools"}' });
    assert.equal(answer.status, 200);
    assert.deepEqual(JSON.parse(answer.text), { left: "open", right: "open", strip: 88, tab: "tools" }, "the answer carries the tab");
    assert.deepEqual((await get(helper, "layout.json")).body, { left: "open", right: "open", strip: 88 }, "the tab is never kept");
    const bad = await send("layout", { body: '{"tab":"nope"}' });
    assert.equal(bad.status, 409);
    assert.deepEqual(JSON.parse(bad.text), { error: "tab is agent, page, pictures or tools." });
  } finally {
    await helper.close();
  }
  const none = await startFakeHelper({ fixtures: { handoffs: null, downloads: null, recordings: null, diagnostics: null, report: null } });
  try {
    for (const route of ["handoffs.json", "downloads.json", "recordings.json", "diagnostics.json"]) assert.equal((await get(none, route)).status, 404, `${route}: null is 404`);
    assert.equal((await request(`${none.base}diagnostics/report`, { method: "POST" })).status, 404);
    assert.equal((await request(`${none.base}recordings/r1`, { method: "DELETE" })).status, 404);
  } finally {
    await none.close();
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
    // Framing, as the native 520 patch sets it: every page may frame its own origin; only the
    // picker may be framed, by its own origin only; every other page refuses any frame.
    assert.deepEqual([...FRAMEABLE], ["picker"]);
    for (const page of pages()) {
      const r = await request(ui.url(page));
      const csp = r.headers["content-security-policy"];
      assert.equal(csp, PAGE_CSP(helper.origin, page), page);
      assert.match(csp, /; frame-src 'self';/, page);
      if (page === "picker") {
        assert.match(csp, /; frame-ancestors 'self';/);
        assert.equal(r.headers["x-frame-options"], "SAMEORIGIN");
      } else {
        assert.match(csp, /; frame-ancestors 'none';/, page);
        assert.equal(r.headers["x-frame-options"], "DENY", page);
      }
    }
    assert.equal((await request(`${ui.origin}/picker/picker.css`)).headers["x-frame-options"], "DENY", "only the picker's page itself");
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
  // A roving composite's member out of the Tab order: the close inside an inactive tab (role=tab,
  // tabindex -1) is reached by the arrows on its tab and closed with Delete (test/ui-strip.test.mjs).
  // Every visible control stays in the list (the name check reads all of them); the flag only lets
  // the Tab check skip these, and inTablist proves the exception covers nothing else.
  const roving = (el) => el.getAttribute("tabindex") === "-1" && !!el.closest('[role=tab][tabindex="-1"]');
  // A radio group is one Tab stop, its checked radio; the others are reached by the arrows (the
  // browser's own radio group). Only an unchecked radio whose group has a checked one is skipped.
  const radioPeer = (el) => el.type === "radio" && !el.checked && !!el.name && !!el.form?.querySelector?.(`input[type=radio][name="${CSS.escape(el.name)}"]:checked`)
    || (el.type === "radio" && !el.checked && !!el.name && !el.form && !!document.querySelector(`input[type=radio][name="${CSS.escape(el.name)}"]:checked`));
  return [...document.querySelectorAll(selector)].filter((el) => el.checkVisibility() && !el.disabled).map((el, i) => {
    el.dataset.harnessId = String(i);
    const r = roving(el);
    return { id: String(i), tag: el.tagName.toLowerCase(), elId: el.id, name: label(el), roving: r || radioPeer(el), inTablist: (r && !!el.closest("[role=tab]").closest("[role=tablist]")) || radioPeer(el) };
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
            const tabbable = list.filter((c) => !c.roving);
            const stray = list.filter((c) => c.roving && !c.inTablist).map((c) => `${c.tag}#${c.elId}`);
            assert.deepEqual(stray, [], `${page}: out of the Tab order outside a tablist's tab`);
            const reached = new Map();
            for (let i = 0; i < tabbable.length + 5; i++) {
              await ctx.page.keyboard.press("Tab");
              const at = await ctx.inPage(() => {
                const el = document.activeElement;
                if (!el || el === document.body) return null;
                const s = getComputedStyle(el);
                return { id: el.dataset.harnessId ?? null, tag: el.tagName.toLowerCase(), elId: el.id, style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor };
              });
              if (at?.id != null && !reached.has(at.id)) reached.set(at.id, at);
            }
            const missing = tabbable.filter((c) => !reached.has(c.id)).map((c) => `${c.tag}#${c.elId}`);
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

test("only same-origin pages frame the picker, and no other page can be framed", { skip: !runtime, timeout: 60_000 }, async () => {
  const browser = await patchright(runtime).chromium.launch();
  const helper = await startFakeHelper({});
  const ctx = await openPage(browser, "strip", { helper, viewport: { width: 1536, height: 640 } });
  let foreign = null;
  try {
    await ctx.inPage(() => {
      for (const [id, src] of [["t-picker", "../picker/index.html"], ["t-right", "../right/index.html"]]) {
        const f = document.createElement("iframe");
        f.id = id;
        f.addEventListener("load", () => { f.dataset.loaded = "1"; });
        f.src = src;
        document.body.append(f);
      }
    });
    // Both frames finish navigating first (a refused frame still fires load), so the right page's
    // refusal is not just a frame that has not loaded yet.
    const loaded = () => ctx.inPage(() => ["t-picker", "t-right"].every((id) => document.getElementById(id).dataset.loaded === "1"));
    for (let i = 0; i < 100 && !(await loaded()); i++) await ctx.page.waitForTimeout(50);
    assert.equal(await loaded(), true, "both frames finished navigating");
    const probe = () => ctx.inPage(() => {
      const read = (id, fn) => { try { return fn(document.getElementById(id).contentDocument); } catch { return false; } };
      return {
        picker: read("t-picker", (d) => d?.documentElement?.dataset.host === "frame"),
        right: read("t-right", (d) => !!d?.querySelector('script[src="right.js"]')),
      };
    });
    let seen = await probe();
    for (let i = 0; i < 60 && !seen.picker; i++) { await ctx.page.waitForTimeout(50); seen = await probe(); }
    assert.equal(seen.picker, true, "a same-origin page frames the picker");
    assert.equal(seen.right, false, "a page other than the picker refuses the frame");
    // Cross origin: an opaque origin (about:blank) framing the picker gets nothing.
    foreign = await browser.newPage();
    await foreign.setContent(`<iframe src="${ctx.ui.url("picker")}"></iframe>`);
    await foreign.waitForTimeout(2000);
    const framed = [];
    for (const f of foreign.frames()) framed.push(await f.evaluate(() => document.documentElement?.dataset.host === "frame").catch(() => false));
    assert.deepEqual(framed.filter(Boolean), [], "a foreign origin never renders the picker");
  } finally {
    await foreign?.close();
    await ctx.close();
    await helper.close();
    await browser.close();
  }
});

test("seven pages on one origin share one event stream, which passes on when its page closes", { skip: !runtime, timeout: 120_000 }, async () => {
  const browser = await patchright(runtime).chromium.launch();
  const helper = await startFakeHelper({ pageOrigin: null });
  const ui = await startUiServer({ helper, fixture: defaultFixture() });
  helper.setPageOrigin(ui.origin);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const context = await browser.newContext({ viewport: { width: 1536, height: 900 } });
    const NAMES = ["strip", "strip#nav-left", "strip#nav-right", "left", "right", "timeline", "approve"];
    const open = {};
    for (const n of NAMES) {
      const [page, hash] = n.split("#");
      const p = await context.newPage();
      await p.goto(ui.url(page) + (hash ? `#${hash}` : ""), { waitUntil: "load" });
      open[n] = p;
    }
    const ev = (n, fn, arg) => inPage(open[n], fn, arg);
    const until = async (what, fn) => { for (let i = 0; i < 120; i++) { if (await fn()) return; await sleep(50); } assert.fail(`timed out waiting for ${what}`); };
    const STREAM_PAGES = ["strip", "left", "right", "timeline", "approve"];
    const NAV = ["strip#nav-left", "strip#nav-right"];
    for (const n of STREAM_PAGES) await until(`${n} live`, () => ev(n, () => document.body.dataset.s === "live"));
    for (const n of NAV) assert.equal(await ev(n, () => document.body.dataset.s), undefined, `${n} has no state attribute`);
    await sleep(300);
    const live = async () => Object.fromEntries(await Promise.all(NAMES.filter((n) => open[n]).map(async (n) => [n, await ev(n, () => window.__harness.live())])));
    const before = await live();
    assert.equal(helper.streams.size, 1, "one stream to the helper");
    assert.equal(helper.gets.filter((r) => r === "events").length, 1, "one events request");
    assert.equal(Object.values(before).reduce((n, l) => n + l.eventSources, 0), 1, "one EventSource across the seven pages");
    for (const n of NAV) assert.equal(before[n].eventSources, 0, `${n} opens no stream`);
    assert.deepEqual([...helper.streams].map((s) => s.panel), [true], "never a viewer stream");

    const rightText = () => ev("right", () => document.getElementById("collaboration").textContent);
    const collab0 = await rightText();
    helper.set("collaboration", { participants: [{ id: "p1", label: "Ana" }], guests: [{ label: "Ana", role: "drive" }] });
    await until("the strip's pill", () => ev("strip", () => document.getElementById("pill").dataset.state === "live"));
    await until("left's guests", () => ev("left", () => document.querySelectorAll("#guests li").length === 1));
    await until("right's collaboration line", async () => (await rightText()) !== collab0);
    helper.set("activity", [{ t: Date.now(), who: "Claude", text: "typed" }]);
    await until("the timeline driving", () => ev("timeline", () => document.body.dataset.driving === "true"));
    helper.push("join", [{ id: "j1", name: "Bo", role: "drive", state: "pending" }]);
    await until("approve's pending", () => ev("approve", () => document.body.dataset.pending === "1"));
    await until("right's join banner", () => ev("right", () => !!document.querySelector("#joins .join")));
    // Both docks on one surface (the mockup's dock tone): neither reads as a separate panel.
    const surface = () => getComputedStyle(document.body).backgroundColor;
    assert.equal(await ev("right", surface), await ev("left", surface), "left and right docks share one background");

    // The page holding the stream closes: the lock passes and another page opens it.
    const holder = Object.entries(await live()).find(([, l]) => l.eventSources === 1)?.[0];
    assert.equal(holder, "strip", "the first page holds the stream");
    const logs = {};
    logs.strip = await ev("strip", () => window.__harness.log);
    await open.strip.close();
    delete open.strip;
    await until("a second events request", async () => helper.gets.filter((r) => r === "events").length === 2 && helper.streams.size === 1);
    const collab1 = await rightText();
    helper.set("collaboration", { participants: [], guests: [] });
    await until("left's empty line", () => ev("left", () => !document.getElementById("guests-empty").hidden && document.querySelectorAll("#guests li").length === 0));
    await until("right's collaboration line again", async () => (await rightText()) !== collab1);
    assert.equal(helper.streams.size, 1, "still one stream");
    await sleep(300);
    const after = await live();
    assert.equal(Object.values(after).reduce((n, l) => n + l.eventSources, 0), 1, "one EventSource after the handover");

    // A page still on an older address (a dead key, learned before the holder's) says hello: the
    // stream stays where it is.
    const gets = helper.gets.filter((r) => r === "events").length;
    await ev("left", (origin) => {
      const ch = new BroadcastChannel("pairbrowse-stream " + origin);
      ch.postMessage({ t: "hello", id: "stale", base: origin + "/dead-key/", kind: "", since: 1 });
      ch.close();
    }, helper.origin);
    await sleep(400);
    assert.equal(helper.gets.filter((r) => r === "events").length, gets, "no new events request");
    assert.equal(helper.streams.size, 1, "the stream did not move");
    const collab2 = await rightText();
    helper.set("collaboration", { participants: [{ id: "p2", label: "Bea" }], guests: [] });
    await until("right still follows the stream", async () => (await rightText()) !== collab2);

    for (const n of Object.keys(open)) logs[n] = await ev(n, () => window.__harness.log);
    for (const [n, log] of Object.entries(logs)) {
      const bad = log.filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind));
      assert.deepEqual(bad, [], `${n}: no error, rejection or CSP entry`);
    }
    for (const n of Object.keys(after)) {
      assert.equal(after[n].intervals, before[n].intervals, `${n}: no new interval`);
      assert.equal(after[n].frames, before[n].frames, `${n}: no new frame loop`);
      assert.ok(after[n].timeouts <= before[n].timeouts + 2, `${n}: only the drive and checklist timeouts (${before[n].timeouts} -> ${after[n].timeouts})`);
    }
    await context.close();
  } finally {
    await ui.close();
    await helper.close();
    await browser.close();
  }
});
