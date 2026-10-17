// The host's own agent reads a checkout page as it is (card fields in the page and in a payment
// frame), and a snapshot or find asked into a file of the agent's naming comes in the result
// instead. (A joiner's agent reads card numbers masked: test/integration/shared-mode.test.mjs,
// test/output.test.mjs.) Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME), headless.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { session, testBase } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const serve = (pages) => createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(pages[req.url.split("?")[0]] ?? pages["/"]); });
const listen = async (s) => { await new Promise((r) => s.listen(0, "127.0.0.1", r)); return s.address().port; };

// Values typed, and what must never show of them.
const MAIN_CARD = "4242 4242 4242 4242";
const FRAME_CARD = "5555 5555 5555 4444";
const EXPIRY = "11 / 29";
const MAIN_CVC = "731";
const FRAME_CVC = "864";
const ORDER = "1234 5678 9012 3456"; // 16 digits, not a card (its checksum fails)

test("the host's agent reads card fields as they are, in the page and in a payment frame; no agent-named files", { skip: !runtime, timeout: 180_000 }, async () => {
  // The payment frame, as a payment provider's is: its CVC unlabeled, known by its autocomplete.
  // (Same origin: the browser blocks a loopback page's frames on other loopback ports.)
  const site = serve({
    "/frame": `<!doctype html><title>Pay frame</title><label>Card number <input id=cn autocomplete=cc-number inputmode=numeric placeholder="1234 1234 1234 1234"></label>
<input id=ex aria-label="Expiration date MM / YY" placeholder="MM / YY"><input id=cv autocomplete=cc-csc placeholder="123"><label>ZIP <input id=zf></label>`,
    "/": `<!doctype html><title>Checkout</title><h1>Checkout</h1><p>Last time you paid with ${MAIN_CARD}. Order ${ORDER}.</p>
<form onsubmit="return false"><label>Card number <input id=c></label><label>Security code <input id=s></label><input id=k autocomplete=cc-csc aria-label="Code"><label>ZIP code <input id=z></label><label>Order number <input id=o></label></form>
<iframe src="/frame" width=500 height=300></iframe>`,
  });
  const port = await listen(site);
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "cards-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, browserArgs: ["--headless=new"], display: "none", screenshots: false }));
  const daemon = spawnDaemon(h);
  const socketPath = join(h, "run", "browser.sock");
  for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
  const a = await session(socketPath, "w");
  const read = [];
  const got = async (tool, args) => { const t = text(await a.tool(tool, args)); read.push(`[${tool}] ${t}`); return t; };
  try {
    await got("browser_navigate", { url: `http://127.0.0.1:${port}/checkout` });
    let snap = "";
    for (let i = 0; i < 40 && !/f\d+e\d+/.test(snap); i++) { snap = await got("browser_snapshot"); if (!/f\d+e\d+/.test(snap)) await sleep(250); }
    const ref = (re) => { const m = snap.match(re); assert.ok(m, `${re} in\n${snap}`); return m[1]; };
    const card = ref(/textbox "Card number" \[ref=(e\d+)\]/);
    const sec = ref(/textbox "Security code" \[ref=(e\d+)\]/);
    const code = ref(/textbox "Code" \[ref=(e\d+)\]/);
    const zip = ref(/textbox "ZIP code" \[ref=(e\d+)\]/);
    const order = ref(/textbox "Order number" \[ref=(e\d+)\]/);
    const fCard = ref(/textbox "Card number" \[ref=(f\d+e\d+)\]/);
    const fExp = ref(/textbox "Expiration date MM \/ YY" \[ref=(f\d+e\d+)\]/);
    const fCvc = ref(/textbox(?: "123")? \[ref=(f\d+e\d+)\]/);
    const filled = await got("browser_fill_form", { fields: [
      { name: "Card number", type: "textbox", target: card, value: MAIN_CARD },
      { name: "Security code", type: "textbox", target: sec, value: "4471" },
      { name: "Code", type: "textbox", target: code, value: MAIN_CVC },
      { name: "ZIP code", type: "textbox", target: zip, value: "94107" },
      { name: "Order number", type: "textbox", target: order, value: ORDER },
    ] });
    assert.ok(!/### Error/.test(filled), filled);
    await got("browser_type", { element: "Card number", target: fCard, text: FRAME_CARD });
    await got("browser_type", { element: "Expiry", target: fExp, text: EXPIRY });
    await got("browser_type", { element: "Security code", target: fCvc, text: FRAME_CVC });
    snap = await got("browser_snapshot");
    const find = await got("browser_find", { text: "textbox" });
    const findFile = await got("browser_find", { regex: "/card number/i", filename: "cards.md" });
    const run = await got("pairbrowse_run", { steps: [{ fill: { "Order number": ORDER } }] });
    assert.match(run, /^Done/, run);

    // The host's own agent reads the page as it is: what it filled, in the page and in the frame.
    assert.match(snap, /textbox "Card number" \[ref=e\d+\]: 4242 4242 4242 4242/, snap);
    assert.match(snap, /text: 5555 5555 5555 4444/, snap);
    assert.match(snap, /text: 11 \/ 29/, snap);
    assert.match(find, /textbox "Security code" \[ref=e\d+\]: "?4471/, find);
    assert.ok(snap.includes(ORDER) && /paid with 4242 4242 4242 4242\./.test(snap), snap);
    // Asked into a file of its naming, a find comes in the result (the file would skip the
    // saved-password masking every result gets).
    assert.match(findFile, /Found \d+ match/, findFile);
    assert.ok(!existsSync(join(h, "cards.md")) && !existsSync(join(h, "files", "cards.md")), "no file of the agent's naming");
  } finally {
    a.sock.destroy();
    await stopDaemon(daemon);
    rmSync(h, { recursive: true, force: true });
    site.close();
  }
});
