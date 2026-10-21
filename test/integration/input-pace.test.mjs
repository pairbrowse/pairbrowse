// The adaptive input pace (server-mode spec, step 51), measured where the keys land: the native
// build types quickly on a plain page (the fast typist's rhythm, about 25 ms between keys) and at an
// everyday typist's (about 150 ms) on a page that carries a scoring widget (an invisible one: only
// its script), in a sign-in form, and on a page once a widget loads there; each result says which.
// Every page is local; the widget's script and frame are empty stand-ins at the widget maker's path.
// Needs macOS, PAIRBROWSE_TEST_RUNTIME, PAIRBROWSE_TEST_ENGINE (copied into the test's home) and
// PAIRBROWSE_TEST_EXECUTABLE (the native build's Contents/MacOS/pairbrowse). It opens a real window.
import "../helpers/home.mjs";
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { attachDaemon, session, testBase } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";
import { nativeManifest } from "../../scripts/native-engine.mjs";
import { MEASURING_BUSY } from "../../scripts/daemon/browser/graphics.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const engine = process.env.PAIRBROWSE_TEST_ENGINE;
const exe = process.env.PAIRBROWSE_TEST_EXECUTABLE;
const native = (() => { try { return !!(runtime && engine && exe && nativeManifest(exe).version); } catch { return false; } })();
const SKIP = process.platform !== "darwin" ? "macOS only" : !native ? "set PAIRBROWSE_TEST_RUNTIME, PAIRBROWSE_TEST_ENGINE and PAIRBROWSE_TEST_EXECUTABLE (a native build for macOS)" : false;

// Each page's field reports its keys as the page sees them: the median time between one key going
// down and the next, and the share of keys still down when the next goes down. Only the typed
// characters count; a field emptied (PairBrowse clears one before it types) starts again.
const METER = `<p id=meter>keys: none</p><script>
let downs = [], overlaps = [], held = null;
addEventListener("input", (e) => { if (e.target.value === "") { downs = []; overlaps = []; held = null; } }, true);
addEventListener("keydown", (e) => {
  if (e.key.length !== 1 || e.repeat) return;
  if (held) overlaps.push(held.up === null);
  held = { key: e.key, at: e.timeStamp, up: null };
  downs.push(held);
  report();
}, true);
addEventListener("keyup", (e) => { const d = downs.findLast((x) => x.key === e.key && x.up === null); if (d) d.up = e.timeStamp; }, true);
function report() {
  const gaps = downs.slice(1).map((d, i) => d.at - downs[i].at).sort((a, b) => a - b);
  const median = gaps.length ? gaps[gaps.length >> 1] : 0;
  document.getElementById("meter").textContent = "keys: " + downs.length + " median " + Math.round(median) + " overlap " + Math.round(100 * overlaps.filter(Boolean).length / Math.max(1, overlaps.length));
}
</script>`;
const page = (body, head = "") => `<!doctype html><html><head><title>Pace</title>${head}</head><body>${body}${METER}</body></html>`;
const PAGES = {
  "/plain": () => page(`<label>Search <input id=q name=q type=search></label>`),
  // An invisible, score-based widget: its script only (empty here), at the maker's path.
  "/scored": () => page(`<label>Message <input id=m name=message></label>`, `<script src="/recaptcha/api.js?render=site-key" async></script>`),
  "/login": () => page(`<form action="/" onsubmit="return false"><label>Email <input id=e type=email name=email autocomplete=username></label><label>Password <input id=p type=password name=password autocomplete=current-password></label><button>Sign in</button></form>`),
  // A widget that comes later: its frame put in by the page's own button.
  "/late": () => page(`<label>Comment <input id=c name=comment></label><button onclick="const f=document.createElement('iframe');f.src='/turnstile/v0/frame';f.style='width:1px;height:1px;border:0';document.body.append(f)">Load check</button>`),
  "/recaptcha/api.js": () => "",
  "/turnstile/v0/frame": () => "<!doctype html><title>frame</title>",
};

let site, home, h;
const logText = () => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } };
const why = () => `\n--- daemon.log ---\n${logText().slice(-3000)}`;

before(async () => {
  if (SKIP) return;
  site = http.createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const make = PAGES[path];
    res.writeHead(make ? 200 : 404, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html", "cache-control": "no-store" });
    res.end(make ? make() : "");
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = testBase();
  mkdirSync(base, { recursive: true });
  home = mkdtempSync(join(base, "pb-pace-"));
  symlinkSync(runtime, join(home, "runtime"), "dir");
  cpSync(engine, join(home, "engine"), { recursive: true });
  // The native build, headed, humanized input on (the default), the adaptive pace (the default).
  writeFileSync(join(home, "config.json"), JSON.stringify({
    executablePath: exe, browserEngine: "pairbrowse", sessionPicker: false, screenshots: false,
    browserArgs: ["--use-mock-keychain", "--password-store=basic"],
  }));
  const daemon = spawnDaemon(home);
  const socketPath = join(home, "run", "browser.sock");
  (await attachDaemon({ socketPath, daemon, home, ms: 120_000 })).destroy();
  const agent = await session(socketPath, `p${randomBytes(2).toString("hex")}`);
  // The first start measures graphics once: calls are refused meanwhile, and retried.
  const tool = async (name, args = {}, ms = 300_000) => {
    for (let i = 0; ; i++) {
      const r = await agent.tool(name, args, ms);
      if (!text(r).includes(MEASURING_BUSY) || i > 100) return r;
      await sleep(3000);
    }
  };
  h = { daemon, agent, tool };
});

after(async () => {
  if (SKIP) return;
  h?.agent?.sock?.destroy();
  await stopDaemon(h?.daemon).catch(() => {});
  site?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

const TEXT = "the quick brown fox jumps over"; // 30 characters
// Opens a page, types TEXT into the field named label, and reads what the page measured.
async function typeOn(path, label, { open = true } = {}) {
  if (open) {
    const r = await h.tool("browser_navigate", { url: `http://127.0.0.1:${site.address().port}${path}` });
    assert.ok(!r.result?.isError, text(r) + why());
  }
  const snap = text(await h.tool("browser_snapshot"));
  const ref = snap.match(new RegExp(`(?:textbox|searchbox) "${label}"[^\\n]*\\[ref=(\\w+)\\]`))?.[1];
  assert.ok(ref, `${label} in the snapshot: ${snap.slice(0, 600)}`);
  const typed = await h.tool("browser_type", { element: label, target: ref, text: TEXT });
  assert.ok(!typed.result?.isError, text(typed) + why());
  const said = text(typed);
  const found = text(await h.tool("browser_find", { text: "keys:" }));
  const m = found.match(/keys: (\d+) median (\d+) overlap (\d+)/);
  assert.ok(m, found.slice(0, 400));
  return { keys: Number(m[1]), median: Number(m[2]), overlap: Number(m[3]), said };
}

test("fast on a plain page, an everyday typist's rhythm with a scoring widget, in a sign-in form, and once a widget loads", { skip: SKIP, timeout: 900_000 }, async () => {
  try {
    const plain = await typeOn("/plain", "Search");
    assert.equal(plain.keys, TEXT.length, "every key reached the page");
    assert.ok(plain.median < 60, `quick on a plain page: ${plain.median} ms between keys`);
    assert.match(plain.said, /Pace: fast\./);

    const scored = await typeOn("/scored", "Message");
    assert.ok(scored.median >= 110 && scored.median <= 220, `everyday with a scoring widget: ${scored.median} ms between keys`);
    assert.ok(scored.overlap < 50, `few keys overlap: ${scored.overlap}%`);
    assert.match(scored.said, /Pace: everyday \(verification widget on the page\)\./);

    const login = await typeOn("/login", "Email");
    assert.ok(login.median >= 110 && login.median <= 220, `everyday in a sign-in form: ${login.median} ms between keys`);
    assert.match(login.said, /Pace: everyday \(sign-in form\)\./);

    const before = await typeOn("/late", "Comment");
    assert.ok(before.median < 60, `quick before the widget: ${before.median} ms`);
    const snap = text(await h.tool("browser_snapshot"));
    const button = snap.match(/button "Load check"[^\n]*\[ref=(\w+)\]/)?.[1];
    assert.ok(button, snap.slice(0, 600));
    const clicked = await h.tool("browser_click", { element: "Load check", target: button });
    assert.ok(!clicked.result?.isError, text(clicked));
    assert.match(text(clicked), /Pace: fast\./, "the click went before the widget was there");
    await sleep(500);
    const after = await typeOn("/late", "Comment", { open: false });
    assert.equal(after.keys, TEXT.length, "the field was cleared and typed again");
    assert.ok(after.median >= 110 && after.median <= 220, `everyday once the widget is there: ${after.median} ms between keys`);
    assert.match(after.said, /Pace: everyday \(verification widget on the page\)\./);
  } catch (e) {
    throw new Error(`${e.message}${why()}`);
  }
});
