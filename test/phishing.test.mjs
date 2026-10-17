// Phishing protection (daemon/phishing.mjs): the list read, a host matched exactly (www. too), the
// list kept fresh (a short or failed download keeps the last one), and a listed top-level
// navigation turned into the warning page; a Continue anyway from that page lets its host through.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseList, listedHost, warningPage, createPhishing } from "../scripts/daemon/phishing.mjs";

const big = (extra = []) => [...Array.from({ length: 1200 }, (_, i) => `filler${i}.example`), ...extra].join("\n");

test("the list: host names only; a host matches itself and with www., never its parent or a lookalike", () => {
  const l = parseList("# comment\nEvil.Example\n\nbad name!\nlogin-paypal.example.net\nnodot\n");
  assert.deepEqual([...l].sort(), ["evil.example", "login-paypal.example.net"]);
  assert.ok(listedHost(l, "evil.example") && listedHost(l, "WWW.evil.example") && listedHost(l, "evil.example."));
  assert.ok(!listedHost(l, "example") && !listedHost(l, "notevil.example") && !listedHost(l, "a.evil.example.com") && !listedHost(l, ""));
});

test("refresh: a good download replaces the list on disk; a short or failed one keeps the last", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "phish-")), "lists", "p.txt");
  const logs = [];
  let text = big(["evil.example"]);
  const p = createPhishing({ file, fetchText: async () => text, log: (l) => logs.push(l) });
  await p.refresh(true);
  assert.ok(existsSync(file) && p.listed("https://evil.example/login"));
  text = "only.example";
  await p.refresh(true);
  assert.ok(p.listed("http://www.evil.example/"), "a short list doesn't replace it");
  const failing = createPhishing({ file, fetchText: async () => { throw new Error("offline"); }, log: (l) => logs.push(l) });
  failing.load();
  await failing.refresh(true);
  assert.ok(failing.listed("https://evil.example/"), "the one on disk stays");
  assert.ok(!p.listed("https://good.example/") && !p.listed("ftp://evil.example/") && !p.listed("not a url"));
  assert.ok(logs.some((l) => /not updated \(offline\)/.test(l)));
});

test("a listed top-level navigation shows the warning; a Continue anyway from that warning lets the host through; frames and other sites pass", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "phish-")), "p.txt");
  writeFileSync(file, big(["evil.example"]));
  let on = true;
  const p = createPhishing({ file, enabled: () => on });
  p.load();
  const gone = [];
  const page = { url: "https://start.example/", goto: async (u) => { gone.push(u); page.url = u; } };
  const main = { page: () => page, url: () => page.url };
  const req = (url, frame = main, nav = true) => ({ isNavigationRequest: () => nav, frame: () => frame, url: () => url });
  page.mainFrame = () => main;
  p.onRequest(req("https://good.example/"));
  p.onRequest(req("https://evil.example/x", { page: () => page, url: () => "" }));
  p.onRequest(req("https://evil.example/x", main, false));
  assert.equal(gone.length, 0, "other sites, frames and subresources pass");
  p.onRequest(req("https://evil.example/x"));
  assert.equal(gone.length, 1);
  assert.match(decodeURIComponent(gone[0]), /Deceptive site ahead[\s\S]*evil\.example[\s\S]*Continue anyway/);
  // Another page asking for it again is stopped again; the warning page's own link lets it through.
  page.url = "https://other.example/";
  p.onRequest(req("https://evil.example/x"));
  assert.equal(gone.length, 2);
  page.url = gone[1];
  p.onRequest(req("https://evil.example/x"));
  assert.equal(gone.length, 2, "Continue anyway from its warning");
  p.onRequest(req("https://www.evil.example/y"));
  assert.equal(gone.length, 3, "only the host let through");
  on = false;
  p.onRequest(req("https://www.evil.example/y"));
  assert.equal(gone.length, 3, "off: nothing stopped");
  assert.doesNotMatch(warningPage("https://x.example/\"><script>", "x.example", "n"), /<script>/, "the address escaped");
});
