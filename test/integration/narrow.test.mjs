// Compact layouts: at a narrow window a site folds its search box into a "Search" button, its menu
// into a hamburger (with ARIA, or a CSS-only checkbox). Fast mode opens the one control that
// clearly unfolds what it looks for, never a form's own answers or a submit; browser_find and a
// narrow page's snapshot name the folded controls with their refs. The same pages wide need none
// of it. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME), headless.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { session, testBase } from "../helpers/live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

const NARROW = "@media (max-width: 900px)";
const PAGES = {
  // A search box that a narrow window folds behind a "Search" link (its script opens the box; the
  // link goes to a search page without it).
  "/": `<!doctype html><title>Docs</title><style>.box{display:inline-block} .toggle{display:none} ${NARROW}{.box{display:none} .box.open{display:inline-block} .toggle{display:inline}}</style>
<header><a href="/">Home</a> <div class=search><a class=toggle href="/search">Search</a><form class=box action="/results"><input name=q aria-label="Search docs" placeholder="Search docs"></form></div></header>
<main><h1>Welcome</h1></main>
<script>document.querySelector(".toggle").onclick = (e) => { e.preventDefault(); document.querySelector(".box").classList.add("open"); };</script>`,
  // A menu behind a hamburger that says what it controls (aria-expanded, aria-controls).
  "/menu": `<!doctype html><title>Shop</title><style>#nav{display:block} #ham{display:none} ${NARROW}{#nav{display:none} #nav.open{display:block} #ham{display:inline}}</style>
<header><button id=ham aria-expanded=false aria-controls=nav aria-label="Menu">=</button><nav id=nav><a href="/pricing">Pricing</a> <a href="/about">About</a></nav></header><main><h1>Shop</h1></main>
<script>ham.onclick = () => { const o = nav.classList.toggle("open"); ham.setAttribute("aria-expanded", String(o)); };</script>`,
  // A CSS-only menu: a hidden checkbox and the label that shows (no ARIA, no script).
  "/css": `<!doctype html><title>Blog</title><style>#t{display:none} label[for=t]{display:none} .links{display:block} ${NARROW}{label[for=t]{display:inline} .links{display:none} #t:checked ~ .links{display:block}}</style>
<header><input type=checkbox id=t><label for=t>&#9776;</label><div class=links><a href="/archive">Archive</a></div></header><main><h1>Blog</h1></main>`,
  // A form's own answers are never flipped to unfold a field: "State" shows only for some answers.
  "/form": `<!doctype html><title>Form</title><form><label><input type=checkbox id=us aria-controls=st onchange="st.hidden = !this.checked"> I live in the US</label>
<div id=st hidden><label for=s>State</label> <input id=s></div><label for=n>Name</label> <input id=n><button>Save</button></form>`,
  // A button that only runs the page's scripts, named like the hidden field beside it: never
  // clicked for the agent (it could send something). A link shown only wide, and a visible one
  // that only holds its name.
  "/sub": `<!doctype html><title>News</title><style>.wide{display:inline} ${NARROW}{.wide{display:none}}</style>
<div><div style="display:none"><input aria-label="Newsletter email"></div><button onclick="window.sent = 1; document.title = 'Subscribed'">Newsletter signup</button></div>
<nav><a class=wide href="/pricing">Plans</a></nav><main><a href="/archive">Plans archive</a></main>`,
  // A form's own submit button that says it controls the hidden part (a GET form: the click checks
  // call its submit safe): never clicked to unfold it.
  "/coupon": `<!doctype html><title>Cart</title><form action="/results" method=get><input name=q aria-label="Item"><button aria-controls=more>Coupon</button><div id=more hidden><input aria-label="Coupon"></div></form>`,
  // A toggle that is a link to another site: never followed. One that only says "#" but whose
  // script leaves for another site: the run stops there and the tab comes back.
  "/away": `<!doctype html><title>Away</title><a href="http://localhost:PORT/pricing" aria-controls=p1 aria-expanded=false>Promo</a><div id=p1 hidden><input aria-label="Promo code"></div>`,
  "/jump": `<!doctype html><title>Jump</title><a href="#" aria-controls=p2 aria-expanded=false onclick="location.href='http://localhost:PORT/pricing'; return false">Gift</a><div id=p2 hidden><input aria-label="Gift code"></div>`,
  "/pricing": `<!doctype html><title>Pricing</title><h1>Pricing</h1>`,
  "/archive": `<!doctype html><title>Archive</title><h1>Archive</h1>`,
  "/results": `<!doctype html><title>Results</title><h1>Results</h1>`,
};

async function helper(width) {
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "narrow-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new", `--window-size=${width},900`], display: "none", screenshots: false }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h }, stdio: ["ignore", out, out] });
  const socketPath = join(h, "run", "browser.sock");
  for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
  const a = await session(socketPath, "w");
  assert.match(text(await a.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
  const stop = async () => {
    a.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    rmSync(h, { recursive: true, force: true });
  };
  return { a, h, stop };
}

test("compact layouts: fast mode unfolds a folded search box and menus; find and snapshots name the folded controls", { skip: !runtime, timeout: 240_000 }, async () => {
  const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end((PAGES[new URL(req.url, "http://x").pathname] || "").replaceAll("PORT", String(site.address().port))); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const url = (p) => `http://127.0.0.1:${site.address().port}${p}`;
  try { for (const width of [760, 1280]) {
    const { a, h, stop } = await helper(width);
    const narrow = width < 900;
    try {
      // The search box: unfolded (narrow), typed into, sent.
      await a.tool("browser_navigate", { url: url("/") });
      const s = text(await a.tool("pairbrowse_run", { steps: [{ fill: { "Search docs": "flexbox" } }] }));
      assert.match(s, /^Done: 1 steps/, `${width}: ${s}`);
      assert.match(text(await a.tool("browser_snapshot")), /textbox "Search docs"[^\n]*: flexbox/);
      // A link in a menu behind a hamburger (aria-controls), and in a CSS-only menu.
      await a.tool("browser_navigate", { url: url("/menu") });
      if (narrow) {
        const f = text(await a.tool("browser_find", { text: "Pricing" }));
        assert.match(f, /No matches/, f);
        assert.match(f, /hidden behind a control[^\n]*button "Menu" \(ref e\d+, opens the part that holds it\)/, f);
        const snap = text(await a.tool("browser_snapshot"));
        assert.match(snap, /laid out for a narrow window[^\n]*button "Menu" \(ref e\d+/, snap);
      }
      const m = text(await a.tool("pairbrowse_run", { steps: [{ click: "Pricing" }, { waitFor: "Pricing" }] }));
      assert.match(m, /^Done: 2 steps/, `${width}: ${m}`);
      await a.tool("browser_navigate", { url: url("/css") });
      const c = text(await a.tool("pairbrowse_run", { steps: [{ click: "Archive" }, { waitFor: "Archive" }] }));
      assert.match(c, /^Done: 2 steps/, `${width}: ${c}`);
      // A script button beside a hidden field is never clicked for it; a link shown only wide is
      // never traded for a shown one that holds its name, and its address is given.
      await a.tool("browser_navigate", { url: url("/sub") });
      const sub = text(await a.tool("pairbrowse_run", { steps: [{ fill: { "Newsletter email": "a@b.co" } }] }));
      assert.match(sub, /No field "Newsletter email" shows\.[^\n]*button "Newsletter signup"/, sub);
      assert.match(sub, /Page: News /, "never clicked");
      const plans = text(await a.tool("pairbrowse_run", { steps: [{ click: "Plans" }] }));
      if (narrow) assert.match(plans, /"Plans" doesn't show[^\n]*Its link goes to http:\/\/127\.0\.0\.1:\d+\/pricing: open that with browser_navigate/, plans);
      else assert.match(plans, /^Done: 1 steps[^\n]*\nPage: Pricing/, plans);
      // A form's submit button is never pressed to unfold a field, even in a form the checks call safe.
      await a.tool("browser_navigate", { url: url("/coupon") });
      const cp = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Coupon: "SAVE10" } }] }));
      assert.match(cp, /^Stopped at step 1 of 1: "Coupon"/, cp);
      assert.match(cp, /Page: Cart /, `never submitted: ${cp}`);
      // A toggle that links to another site is never followed; one whose script leaves is undone.
      await a.tool("browser_navigate", { url: url("/away") });
      const aw = text(await a.tool("pairbrowse_run", { steps: [{ fill: { "Promo code": "X1" } }] }));
      assert.match(aw, /Page: Away /, `never followed: ${aw}`);
      await a.tool("browser_navigate", { url: url("/jump") });
      const jp = text(await a.tool("pairbrowse_run", { steps: [{ fill: { "Gift code": "X2" } }] }));
      assert.match(jp, /went to another site \(http:\/\/localhost:\d+\), so the run stopped and went back/, jp);
      assert.match(text(await a.tool("browser_snapshot")), /Page Title: Jump|Jump/);
      // A form's checkbox is an answer: never ticked to unfold "State".
      await a.tool("browser_navigate", { url: url("/form") });
      const st = text(await a.tool("pairbrowse_run", { steps: [{ fill: { State: "Ohio" } }] }));
      assert.match(st, /"State" is hidden right now: the form shows it only for some answers/, st);
      assert.match(text(await a.tool("browser_snapshot")), /checkbox "I live in the US"(?! \[checked\])/);
    } catch (e) {
      throw new Error(`${width}px: ${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-1500); } catch { return ""; } })()}`);
    } finally {
      await stop();
    }
  } } finally { site.close(); }
});
