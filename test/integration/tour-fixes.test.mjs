// What a live tour of the browser found, kept fixed: leaving an error page is no failure; a fast
// mode click takes the control named so, not one that only contains the name; the dock's "your
// turn" goes with the bar's; a dismissed dialog says so. Live: a real helper and browser
// (PAIRBROWSE_TEST_RUNTIME), headless.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { liveHelper, text } from "../helpers/live-helper.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

async function site(pages) {
  const s = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const p = pages[path];
    if (p === undefined) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(p);
  });
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return { url: (p) => `http://127.0.0.1:${s.address().port}${p}`, close: () => s.close() };
}

test("leaving a browser error page reports where it went, not an interrupted navigation", { skip: !runtime, timeout: 120_000 }, async () => {
  const web = await site({ "/ok": "<!doctype html><title>Fine</title><h1>Fine</h1>" });
  const { a, stop } = await liveHelper(runtime, { prefix: "nav-" });
  try {
    await a.tool("browser_navigate", { url: web.url("/missing") }); // an empty 404: the browser's own error page
    const r = await a.tool("browser_navigate", { url: web.url("/ok") });
    assert.ok(!r.result?.isError, text(r));
    assert.match(text(r), /Fine/);
    assert.doesNotMatch(text(r), /interrupted/);
  } finally {
    await stop();
    web.close();
  }
});

test("a fast mode click takes the control named most like it, and a link that goes nowhere is no Done", { skip: !runtime, timeout: 120_000 }, async () => {
  const web = await site({
    "/issues": `<!doctype html><title>Issues</title><header><nav><a href="/code">Code</a> <a href="/pulls">Pull requests <span>10</span></a></nav></header>
<main><ul><li>Bug in parser <button aria-haspopup="menu" onclick="document.title='menu opened'">2 linked pull requests</button></li></ul>
<a href="/dead" onclick="event.preventDefault()">Dead link</a></main>`,
    "/pulls": "<!doctype html><title>Pulls</title><h1>Pull requests</h1>",
    "/dead": "<!doctype html><title>Dead</title>",
  });
  const { a, stop } = await liveHelper(runtime, { prefix: "click-" });
  try {
    await a.tool("browser_navigate", { url: web.url("/issues") });
    const r = text(await a.tool("pairbrowse_run", { steps: [{ click: "Pull requests" }] }));
    assert.match(r, /^Done/, r);
    assert.match(r, /Page: Pulls/, `the navigation's link, not the row's button: ${r}`);
    await a.tool("browser_navigate", { url: web.url("/issues") });
    const d = text(await a.tool("pairbrowse_run", { steps: [{ click: "Dead link" }] }));
    assert.match(d, /^Stopped at step 1 of 1: Clicked link "Dead link" for "Dead link", which links to http:\/\/127\.0\.0\.1:\d+\/dead, but the page stayed on/, d);
  } finally {
    await stop();
    web.close();
  }
});

test("the docks' \"your turn\" goes when the bar's does: the agent acting again clears both", { skip: !runtime, timeout: 120_000 }, async () => {
  const web = await site({ "/a": "<!doctype html><title>A</title><a href='/b'>B</a>", "/b": "<!doctype html><title>B</title>" });
  const { a, stop } = await liveHelper(runtime, { prefix: "turn-" });
  try {
    await a.tool("browser_navigate", { url: web.url("/a") });
    const live = text(await a.tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
    const board = async () => {
      const ctl = new AbortController();
      const res = await fetch(`${live}events?panel=1`, { signal: ctl.signal });
      const reader = res.body.getReader();
      let got = "";
      const end = Date.now() + 3000;
      while (Date.now() < end && !/event: board\n/.test(got)) { const n = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ value: null }), 500))]); if (n.value) got += new TextDecoder().decode(n.value); }
      ctl.abort();
      const block = got.split("\n\n").filter((b) => b.startsWith("event: board\n")).at(-1);
      return block ? JSON.parse(block.slice(block.indexOf("data: ") + 6)) : null;
    };
    // The board goes out a moment after a change (debounced): read until it says so, at most 5 s.
    const agentUntil = async (ok) => { let e = null; for (const end = Date.now() + 5000; Date.now() < end && !ok(e); ) e = (await board())?.people.find((p) => p.kind === "agent") || null; return e; };
    await a.tool("pairbrowse_status", { kind: "you", text: "Sign in please" });
    assert.equal((await agentUntil((e) => e?.status === "you"))?.status, "you");
    await a.tool("browser_navigate", { url: web.url("/b") });
    const after = await agentUntil((e) => e && e.status !== "you");
    assert.notEqual(after?.status, "you", JSON.stringify(after));
    assert.equal(after?.task, "");
  } finally {
    await stop();
    web.close();
  }
});

test("a dialog dismissed says Dismissed; an alert PairBrowse closed is said once, truly", { skip: !runtime, timeout: 120_000 }, async () => {
  const web = await site({ "/d": "<!doctype html><title>D</title><button onclick=\"document.title = confirm('Leave?') ? 'yes' : 'no'\">Ask</button><button onclick=\"alert('Hello')\">Shout</button>" });
  const { a, stop } = await liveHelper(runtime, { prefix: "dlg-" });
  try {
    await a.tool("browser_navigate", { url: web.url("/d") });
    const snap = text(await a.tool("browser_snapshot"));
    const ref = (n) => snap.match(new RegExp(`button "${n}" \\[ref=(e\\d+)\\]`))[1];
    await a.tool("browser_click", { target: ref("Ask"), element: "Ask" });
    const r = text(await a.tool("browser_handle_dialog", { accept: false }));
    assert.match(r, /Dismissed/, r);
    assert.doesNotMatch(r, /Accepted/);
    const s = text(await a.tool("browser_click", { target: ref("Shout"), element: "Shout" }));
    assert.doesNotMatch(s, /can be handled by browser_handle_dialog/, s);
  } finally {
    await stop();
    web.close();
  }
});

test("a session switch and back: each agent's tab comes back as its own, even on the same address", { skip: !runtime, timeout: 180_000 }, async () => {
  const web = await site({ "/same": "<!doctype html><title>Same</title>", "/a": "<!doctype html><title>A</title>", "/b": "<!doctype html><title>B</title>" });
  const { a, agent, stop } = await liveHelper(runtime, { prefix: "own-", env: { PAIRBROWSE_TEST_ACTIVE_MS: "800" } });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const b = await agent("b");
    await a.tool("browser_navigate", { url: web.url("/same") });
    assert.ok(!(await b.tool("browser_tabs", { action: "new", url: web.url("/same") })).result.isError);
    const current = (t) => Number(t.match(/^- (\d+): \(current\)/m)?.[1]);
    const beforeA = current(text(await a.tool("browser_tabs", { action: "list" })));
    const beforeB = current(text(await b.tool("browser_tabs", { action: "list" })));
    assert.notEqual(beforeA, beforeB);
    // An agent holding its tab is at work, however quiet: no switch.
    await b.tool("pairbrowse_collaboration", { action: "acquire" });
    await sleep(1500);
    assert.match(text(await a.tool("pairbrowse_session", { action: "new" })), /using the browser|leased/, "refused");
    await b.tool("pairbrowse_collaboration", { action: "release" });
    await sleep(1500); // both idle now
    assert.match(text(await a.tool("pairbrowse_session", { action: "new" })), /clean/);
    await sleep(1200);
    const list = text(await a.tool("pairbrowse_session", { action: "list" }));
    assert.match(list, /default, 2 saved tabs/, list);
    assert.match(text(await a.tool("pairbrowse_session", { action: "use", name: "default" })), /Now using session "default"/);
    await sleep(3000); // the tabs reopen
    await a.tool("browser_navigate", { url: web.url("/a") });
    await b.tool("browser_navigate", { url: web.url("/b") });
    const tabs = text(await a.tool("browser_tabs", { action: "list" }));
    const at = (p) => Number(tabs.match(new RegExp(`^- (\\d+):[^\\n]*${p}\\)`, "m"))?.[1]);
    const offset = tabs.split("\n").filter((l) => /^- \d+:/.test(l)).length - 2; // a start tab left in front, if any
    assert.equal(at("/a") - offset, beforeA, tabs);
    assert.equal(at("/b") - offset, beforeB, tabs);
  } finally {
    await stop();
    web.close();
  }
});

test("an agent whose tab closed with no other tab open isn't told the others are in use", { skip: !runtime, timeout: 120_000 }, async () => {
  const web = await site({ "/x": "<!doctype html><title>X</title>" });
  const { a, stop } = await liveHelper(runtime, { prefix: "lost-" });
  try {
    await a.tool("browser_navigate", { url: web.url("/x") });
    const list = text(await a.tool("browser_tabs", { action: "list" }));
    for (const line of list.split("\n").filter((l) => /^- \d+:/.test(l)).reverse()) await a.tool("browser_tabs", { action: "close", index: Number(line.match(/^- (\d+)/)[1]) });
    const after = text(await a.tool("browser_tabs", { action: "list" }));
    assert.doesNotMatch(after, /in use by other agents/, after);
  } finally {
    await stop();
    web.close();
  }
});
