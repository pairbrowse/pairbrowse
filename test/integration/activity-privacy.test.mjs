// What the session's activity log keeps on disk (activity.json): field names, never what was typed
// or chosen, and addresses as origin and path only. Live: a real helper and browser
// (PAIRBROWSE_TEST_RUNTIME), headless, on its default (kept) session.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { session, testBase } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("a typed email, a chosen option and an address's query never reach activity.json", { skip: !runtime, timeout: 120_000 }, async () => {
  const site = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Sign up</title><form onsubmit="return false"><label>Email <input id=e></label><label>Plan <select id=p><option>Free</option><option>Gold-7731</option></select></label></form>`);
  });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "actpriv-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, browserArgs: ["--headless=new"], display: "none", screenshots: false }));
  const daemon = spawnDaemon(h);
  const socketPath = join(h, "run", "browser.sock");
  for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
  const a = await session(socketPath, "w");
  try {
    const url = `http://127.0.0.1:${site.address().port}/signup?code=QX-55910&ref=tok_8812#frag-7`;
    await a.tool("browser_navigate", { url });
    const fields = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Email: "ada.secret@example.com" } }, { select: { Plan: "Gold-7731" } }] }));
    assert.match(fields, /^Done/, fields);
    const snap = text(await a.tool("browser_snapshot"));
    const ref = snap.match(/textbox "Email" \[ref=(e\d+)\]/)?.[1];
    assert.ok(ref, snap);
    await a.tool("browser_type", { element: "Email", target: ref, text: "grace.typed@example.com" });
    await a.tool("browser_select_option", { element: "Plan", target: snap.match(/combobox "Plan" \[ref=(e\d+)\]/)?.[1], values: ["Free"] });
    const file = join(h, "activity.json");
    let kept = "";
    for (let i = 0; i < 60 && !/Typed into/.test(kept); i++) { await sleep(100); try { kept = readFileSync(file, "utf8"); } catch {} }
    assert.match(kept, /Typed into \*\*Email\*\*/, kept);
    assert.match(kept, /Opened http:\/\/127\.0\.0\.1:\d+\/signup"/, "the address as origin and path");
    for (const v of ["ada.secret", "grace.typed", "Gold-7731", "QX-55910", "tok_8812", "frag-7", "code="]) assert.ok(!kept.includes(v), `${v} in activity.json:\n${kept}`);
  } finally {
    a.sock.destroy();
    await stopDaemon(daemon);
    rmSync(h, { recursive: true, force: true });
    site.close();
  }
});
