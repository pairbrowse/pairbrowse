// What agents' tasks on real sites found, kept fixed (plans/overnight-2026-10-17): fast mode clicks
// by "#id", test id and calendar day, sees text in frames, takes a download as done, waits for a
// "Saving..." click and names the page's error when it stops; a run's go leaves a frozen page; a
// new tab comes as a short outline and a closed one brings no picture of the next; main-frame refs
// stay plain after a run's go; a click on a canvas is named as the canvas; the helper's reads give
// a page no user activation. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME), headless.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { liveHelper, text } from "../helpers/live-helper.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

const PAGES = {
  "/login": `<!doctype html><title>Login</title><form onsubmit="event.preventDefault()"><input aria-label="Username">
    <div class="error-message-container error"><h3 data-test="error" id="err"></h3><button type="button" class="error-button">x</button></div>
    <button type="button" id="login-button" data-test="login-button" onclick="document.getElementById('err').textContent = 'Epic sadface: Username is required'">Login</button>
    <button type="button" data-test="reset" onclick="document.title = 'reset'">Start over</button></form>`,
  "/dates": `<!doctype html><title>Dates</title><div role="grid" aria-label="October 2026"><div role="row">
    <div role="gridcell" tabindex="-1" aria-label="Choose Thursday, October 16th, 2026" onclick="document.title = 'picked 16'">16</div>
    <div role="gridcell" tabindex="-1" aria-label="Choose Friday, October 17th, 2026" onclick="document.title = 'picked 17'">17</div></div></div>`,
  "/framed": `<!doctype html><title>Framed</title><iframe style="width:400px;height:200px" srcdoc="<p>Sign in to continue</p>"></iframe>`,
  "/files": `<!doctype html><title>Files</title><a href="/report.csv">Get the report</a>`,
  "/save": `<!doctype html><title>Editor</title><button id="s" onclick="const b = this; b.disabled = true; b.textContent = 'Saving...'; setTimeout(() => { b.textContent = 'Save'; b.disabled = false; const h = document.createElement('h1'); h.textContent = 'All changes saved'; document.body.append(h); }, 1500)">Save</button>`,
  "/draw": `<!doctype html><title>Draw</title><style>body{margin:0}</style><div tabindex="0" style="position:fixed;inset:0">
    <canvas style="position:absolute;left:0;top:0;width:60vw;height:90vh;background:#eee"></canvas>
    <aside style="position:absolute;right:0;top:0;width:30vw"><button>Layers</button><button>Export image</button><p>Library of shapes and more panels</p></aside></div>`,
  "/frozen": `<!doctype html><title>Frozen</title><p>Busy</p><script>setTimeout(() => { for (;;) {} }, 300)</script>`,
  "/next": `<!doctype html><title>Next page</title><h1>Step two</h1><button onclick="document.title = 'went on'">Next</button>`,
  "/idle": `<!doctype html><title>idle</title><button onclick="window.open('about:blank')">Open</button><script>setInterval(() => { document.title = navigator.userActivation.hasBeenActive ? "active" : "idle"; }, 30)</script>`,
};

test("agents' findings on real sites stay fixed", { skip: !runtime, timeout: 240_000 }, async () => {
  const web = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (path === "/report.csv") { res.writeHead(200, { "content-type": "text/csv", "content-disposition": 'attachment; filename="report.csv"' }); res.end("a,b\n1,2\n"); return; }
    const p = PAGES[path];
    res.writeHead(p ? 200 : 404, { "content-type": "text/html" });
    res.end(p || "<title>Not found</title>");
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const port = web.address().port;
  // Two sites (two hosts) on the one server: a go between them changes the page's process.
  const one = (p) => `http://shop.pbtest.example${p}`, two = (p) => `http://app.pbother.example${p}`;
  const { a, stop } = await liveHelper(runtime, { prefix: "af-", config: { screenshots: true }, args: [`--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${port}, MAP *.pbother.example 127.0.0.1:${port}`] });
  const run = async (steps) => text(await a.tool("pairbrowse_run", { steps }, 90_000));
  // Each finding on its own: one that fails is named, and the rest still run.
  const failed = [];
  const step = async (name, fn) => { try { await fn(); } catch (e) { failed.push(`[${name}] ${String(e.message).split("\n").slice(0, 3).join(" ")}`); } };
  let r;
  try {
    await step("fast mode clicks by #id and by test id; a stop names the page's error", async () => {
      await a.tool("browser_navigate", { url: one("/login") });
      r = await run([{ click: "#login-button" }, { waitFor: "Products" }]);
      assert.match(r, /^Stopped at step 2 of 2: "Products" didn't appear \(looked in the page and its frames\)/, r);
      assert.match(r, /Errors: [^\n]*Epic sadface: Username is required/, `the page's error in the result: ${r}`);
      r = await run([{ click: "reset" }]);
      assert.match(r, /^Done/, r);
      assert.match(r, /Page: reset/, r);

    });
    await step("a calendar day by its name", async () => {
      await a.tool("browser_navigate", { url: one("/dates") });
      r = await run([{ click: "Choose Friday, October 17th, 2026" }]);
      assert.match(r, /Page: picked 17/, r);

    });
    await step("expect and waitFor look in frames", async () => {
      await a.tool("browser_navigate", { url: one("/framed") });
      r = await run([{ expect: "Sign in to continue" }]);
      assert.match(r, /^Done/, r);

    });
    await step("a link that downloads is done", async () => {
      await a.tool("browser_navigate", { url: one("/files") });
      r = await run([{ click: "Get the report" }]);
      assert.match(r, /^Done/, r);

    });
    await step("a click the page is still saving is waited for", async () => {
      await a.tool("browser_navigate", { url: one("/save") });
      r = await run([{ click: "Save" }]);
      assert.match(r, /Heading: All changes saved/, r);
      await a.tool("browser_navigate", { url: one("/save") });
      const snap = text(await a.tool("browser_snapshot"));
      const save = snap.match(/button "Save" \[ref=(e\d+)\]/)[1];
      r = text(await a.tool("browser_click", { target: save, element: "Save" }));
      assert.match(r, /heading "All changes saved"/, `the page once it was done: ${r}`);
      assert.match(r, /The page was busy \("Saving\.\.\."\)/, r);

    });
    await step("a click on a canvas names the canvas, not the panel beside it", async () => {
      await a.tool("browser_navigate", { url: one("/draw") });
      await a.tool("browser_snapshot");
      r = text(await a.tool("pairbrowse_click_at", { x: 80, y: 120, element: "the drawing area" }));
      assert.match(r, /^Clicked "the canvas" at/, r);
      assert.doesNotMatch(r, /Layers|Export/);

    });
    await step("a run's go leaves a frozen page", async () => {
      await a.tool("browser_navigate", { url: one("/frozen") });
      await new Promise((res) => setTimeout(res, 800));
      r = await run([{ go: two("/next") }]);
      assert.match(r, /^Done/, r);
      assert.match(r, /Page: Next page/, r);

    });
    await step("after a run's go, the main frame's refs come plain", async () => {
      r = text(await a.tool("browser_find", { text: "Next" }));
      assert.match(r, /\[ref=e\d+\]/, r);
      assert.doesNotMatch(r, /\bf\d+e\d+\b/, r);
      const next = r.match(/button "Next" \[ref=(e\d+)\]/)[1];
      r = text(await a.tool("browser_click", { target: next, element: "Next" }));
      assert.match(r, /went on/, `the plain ref works: ${r}`);

    });
    await step("a new tab comes as a short outline; closing it brings no picture of the next tab", async () => {
      const opened = await a.tool("browser_tabs", { action: "new", url: one("/login") });
      r = text(opened);
      assert.match(r, /### Page outline\nPage: Login/, r);
      assert.match(r, /Take a browser_snapshot for its refs/);
      assert.doesNotMatch(r, /\[ref=/, "no whole snapshot");
      const closed = await a.tool("browser_tabs", { action: "close" });
      assert.ok(!closed.result.isError, text(closed));
      assert.equal((closed.result.content || []).some((c) => c.type === "image"), false, "no picture of the tab it leaves the agent in");
      assert.doesNotMatch(text(closed), /\[ref=/);

    });
    await step("the helper's reads give the page no user activation; a real click does", async () => {
      await a.tool("browser_navigate", { url: one("/idle") });
      await a.tool("browser_snapshot");
      await run([{ expect: "Open" }]);
      await new Promise((res) => setTimeout(res, 300));
      r = text(await a.tool("browser_snapshot"));
      assert.match(r, /Page Title: idle/, r);
      const open = r.match(/button "Open" \[ref=(e\d+)\]/)[1];
      await a.tool("browser_click", { target: open, element: "Open" });
      r = text(await a.tool("browser_tabs", { action: "list" }));
      assert.match(r, /active/, `a real click activates it: ${r}`);
    });
    assert.deepEqual(failed, []);
  } finally {
    await stop();
    web.close();
  }
});
