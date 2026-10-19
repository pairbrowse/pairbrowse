// HTTPS pages keep their certificate and padlock with the helper's page script and phishing check
// in place (browser/launch.mjs addPageScript): the document the page shows is the site's own
// response with its TLS certificate, and a bad certificate still stops the page. The same page
// under a Patchright init script loses its certificate (what the address bar showed as "Not
// secure"), which shows the check tells the two apart. Needs PAIRBROWSE_TEST_RUNTIME and the
// network (skipped offline).
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPageScript } from "../../scripts/daemon/browser/launch.mjs";
import { createPhishing } from "../../scripts/daemon/phishing.mjs";
import { hudScript } from "../../scripts/browser.mjs";
import { ensureHud } from "../helpers/live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SECURE = "https://example.com/";
const BAD_CERT = "https://expired.badssl.com/";
const online = runtime ? await fetch(SECURE, { method: "HEAD", signal: AbortSignal.timeout(8000) }).then(() => true, () => false) : false;

// The page's own response as the browser has it: its TLS details (null for a document the driver
// fulfilled itself, which the address bar shows as "Not secure") or the navigation's error.
async function securityOf(page, url) {
  try {
    const res = await page.goto(url, { waitUntil: "load", timeout: 20_000 });
    const tls = await res.securityDetails();
    return { subject: tls?.subjectName || null, protocol: tls?.protocol || null, error: null };
  } catch (e) { return { subject: null, error: e.message }; }
}

test("HTTPS pages keep their padlock under the helper's page script; bad certificates still stop", { skip: !runtime || !online, timeout: 90_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch({ headless: true });
  try {
    const { source, name } = hudScript();
    const ctx = await browser.newContext();
    assert.equal(await addPageScript(ctx, "patchright", source), false);
    const file = join(mkdtempSync(join(tmpdir(), "padlock-")), "p.txt");
    writeFileSync(file, Array.from({ length: 1200 }, (_, i) => `f${i}.example`).join("\n"));
    const phishing = createPhishing({ file });
    phishing.load();
    phishing.watch(ctx);
    const page = await ctx.newPage();
    const ok = await securityOf(page, SECURE);
    assert.equal(ok.error, null);
    assert.ok(ok.subject && ok.protocol, `the site's own TLS certificate: ${JSON.stringify(ok)}`);
    await ensureHud(page, source, name); // the page script still comes in as the page loads
    assert.equal(await page.evaluate((n) => typeof window[n], name), "function");
    const bad = await securityOf(page, BAD_CERT);
    assert.match(String(bad.error), /ERR_CERT/);

    const rewritten = await browser.newContext();
    await rewritten.addInitScript({ content: "void 0" });
    const before = await securityOf(await rewritten.newPage(), SECURE);
    assert.equal(before.error, null);
    assert.equal(before.subject, null, "a Patchright init script takes the certificate away (the bug this guards)");
  } finally { await browser.close(); }
});
