// An agent hears what the page says is wrong with what it filled, and a recording of the browser
// is saved as a video file. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
// PAIRBROWSE_TEST_EXECUTABLE runs it on another build (the PairBrowse browser, a native build with
// its capture page); PAIRBROWSE_TEST_JOINER_EXECUTABLE is taken as that build too when only it is
// set (the acceptance matrix sets the native build there).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { session, testBase } from "../helpers/live.mjs";
import { sleep, text } from "../helpers/util.mjs";
import { spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

// A form whose email field shows its own error once left, a dropdown, and something that moves.
const PAGE = `<!doctype html><title>Form</title><body>
<label for=e>Email</label> <input id=e type=email aria-describedby=eh><span id=eh></span>
<label for=n>Name</label> <input id=n>
<form novalidate><label for=u>Username</label> <input id=u pattern="[A-Z]+"></form>
<label for=ph>Phone</label> <input id=ph>
<label for=c>Country</label> <select id=c><option>Belgium</option><option>Netherlands</option></select>
<div><input type=checkbox id=t aria-label="I agree to the terms" style="position:absolute;opacity:0;width:1px;height:1px"><p onclick="t.click()" style="cursor:pointer">I agree to the terms</p></div>
<div id=dot style="width:40px;height:40px;background:#d97757;position:relative"></div>
<script>
ph.addEventListener("blur", () => { const d = ph.value.replace(/\\D/g, ""); if (d.length === 10) ph.value = "+1 " + d.slice(0, 3) + " " + d.slice(3, 6) + " " + d.slice(6); });
e.addEventListener("blur", () => { const bad = !e.validity.valid; e.setAttribute("aria-invalid", String(bad)); eh.textContent = bad ? "Enter an email address like name@example.com" : ""; });
let x = 0; setInterval(() => { x = (x + 4) % 400; dot.style.left = x + "px"; }, 16);
</script>`;

test("the page's own errors come back with the run, and a recording is saved as a video", { skip: !runtime, timeout: 180_000 }, async () => {
  const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = testBase();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "rec-"));
  // Downloads go to an ordinary folder in the home folder (rules/downloads.mjs): the helper gets a
  // home folder of its own, never the account's.
  const user = mkdtempSync(join(base, "user-"));
  const downloads = join(user, "downloads");
  mkdirSync(downloads);
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = process.env.PAIRBROWSE_TEST_EXECUTABLE || process.env.PAIRBROWSE_TEST_JOINER_EXECUTABLE || createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  // A PairBrowse build (its PairBrowse-build.json beside the program) runs as the PairBrowse
  // browser, its capture page recording, on the mock keychain as every test launch of it.
  const native = existsSync(join(dirname(executablePath), "..", "Resources", "PairBrowse-build.json"));
  const engine = native ? { browserEngine: "pairbrowse", chromeArgs: ["--headless=new", "--use-mock-keychain", "--password-store=basic"] } : { chromeArgs: ["--headless=new"] };
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, ...engine, display: "none", screenshots: false, downloadsDir: downloads }));
  const daemon = spawnDaemon(h, { env: { HOME: user } });
  let a;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    a = await session(socketPath, "r");
    assert.match(text(await a.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    const url = `http://127.0.0.1:${site.address().port}/`;
    assert.ok(!(await a.tool("browser_navigate", { url })).result?.isError);

    // Recording asked for right as the browser came up (a build with its capture page may not
    // have said hello yet: the helper waits for it a little rather than refusing).
    const early = text(await a.tool("pairbrowse_record", { action: "start" }));
    assert.match(early, /Recording the browser \(\d+x\d+\)/, early);
    await sleep(1500);
    const earlySaved = text(await a.tool("pairbrowse_record", { action: "stop" }, 90_000));
    assert.match(earlySaved, /Saved the recording \(\d+ s, [\d.]+ MB\) to /, earlySaved);
    assert.equal(readdirSync(downloads).length, 1, "the early recording");

    // A value the page doesn't accept: the run says so, in the page's own words.
    const bad = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Email: "not an email", Name: "Ada" } }, { select: { Country: "Netherlands" } }] }));
    assert.match(bad, /Check before going on, the page says: "Email": Enter an email address like name@example\.com/, bad);
    assert.doesNotMatch(bad, /"Name"|"Country"/, "only the field that's wrong");
    // A form that switched the browser's check off (novalidate) checks fields itself: its pattern isn't reported.
    const own = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Username: "ada" } }] }));
    assert.doesNotMatch(own, /"Username"/, own);
    const good = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Email: "ada@example.com" } }] }));
    assert.doesNotMatch(good, /"Email"/, good);
    // A field that only formats the number (a phone mask) kept it: the run goes on.
    const phone = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Phone: "4155550142" } }, { select: { Country: "Belgium" } }] }));
    assert.match(phone, /^Done: 2 steps/, phone);
    assert.match(phone, /"Phone": shows "\+1 415 555 0142": the field put \+1 in front/, phone);
    // A styled box: the real checkbox hidden, its text beside it clicked instead, and checked.
    const box = text(await a.tool("pairbrowse_run", { steps: [{ check: "I agree to the terms" }] }));
    assert.match(box, /^Done: 1 steps/, box);
    const after = text(await a.tool("browser_snapshot"));
    assert.match(after, /checkbox "I agree to the terms" \[checked\]/, after.slice(0, 600));

    // A recording: the tab in front, then another tab, saved in Downloads.
    const started = text(await a.tool("pairbrowse_record", { action: "start" }));
    assert.match(started, /Recording the browser \(\d+x\d+\)/, started);
    assert.match(text(await a.tool("pairbrowse_record", { action: "start" })), /Already recording/);
    await sleep(1500);
    await a.tool("browser_tabs", { action: "new" });
    await a.tool("browser_navigate", { url });
    await sleep(1500);
    assert.match(text(await a.tool("pairbrowse_record", { action: "status" })), /Recording, \d+ s so far/);
    const saved = text(await a.tool("pairbrowse_record", { action: "stop" }, 90_000));
    assert.match(saved, /Saved the recording \(\d+ s, [\d.]+ MB\) to /, saved);
    const files = readdirSync(downloads).sort(); // named by when they started: the early one first
    assert.equal(files.length, 2, files.join(", "));
    for (const f of files) assert.match(f, /^PairBrowse recording \d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d\.(mp4|webm)$/);
    const file = join(downloads, files[1]);
    assert.ok(statSync(file).size > 10_000, `a real video (${statSync(file).size} bytes)`);
    const head = readFileSync(file).subarray(0, 12);
    assert.ok(head.subarray(4, 8).toString() === "ftyp" || head.readUInt32BE(0) === 0x1a45dfa3, "an MP4 or WebM file");
    assert.equal((statSync(file).mode & 0o777).toString(8), "600");
    assert.match(text(await a.tool("pairbrowse_record", { action: "stop" })), /Not recording/);
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-2000); } catch { return ""; } })()}`);
  } finally {
    a?.sock.destroy();
    await stopDaemon(daemon);
    site.close();
    rmSync(h, { recursive: true, force: true });
    rmSync(user, { recursive: true, force: true });
  }
});
