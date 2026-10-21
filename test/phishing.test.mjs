// Phishing protection (daemon/phishing.mjs): the list read, a host matched exactly (www. too), the
// list kept fresh (a short or failed download keeps the last one), and a listed top-level
// navigation turned into the warning page; a Continue anyway from that page lets its host through.
// The list is kept compact (its bytes and a table of where names start: no string per name, as a
// Set would keep) and downloaded a piece at a time.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseList, listedHost, warningPage, createPhishing, fetchList } from "../scripts/daemon/phishing.mjs";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc"); // a full collection, so what is measured is what stays

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

test("the list holds host names exactly: no comments, blanks, other text, parents or children", () => {
  const list = parseList("# a comment\n\n  Bad-Site.example \nbad-site.example\nphish.test\nnot a host.example\nlocalhost\nx.y.z.example\r\n");
  assert.equal(list.size, 3);
  for (const h of ["bad-site.example", "phish.test", "x.y.z.example"]) assert.equal(list.has(h), true, h);
  for (const h of ["", "example", "site.example", "y.z.example", "a.x.y.z.example", "phish.tes", "phish.testx", "localhost", "# a comment"]) assert.equal(list.has(h), false, h);
  assert.equal(listedHost(list, "WWW.Phish.Test."), true);
  assert.equal(listedHost(list, "www.www.phish.test"), false);
  assert.equal(listedHost(list, "mail.phish.test"), false);
  assert.equal(listedHost(list, ""), false);
  const empty = parseList("");
  assert.equal(empty.size, 0);
  assert.equal(listedHost(empty, "phish.test"), false);
});

test("every name of a large list is found and nothing else; it keeps no more than the names' bytes and an index", async () => {
  const names = Array.from({ length: 200_000 }, (_, i) => `site-${(i * 7919) % 1_000_003}.example${i % 5}.com`);
  const text = names.join("\n");
  const list = parseList(text);
  assert.equal(list.size, new Set(names).size);
  for (let i = 0; i < names.length; i += 97) assert.equal(list.has(names[i]), true, names[i]);
  for (let i = 0; i < 2000; i++) assert.equal(list.has(`site-${i}.example9.com`), false);
  assert.equal(list.has(names[0] + "x"), false);
  assert.equal(list.has("a" + names[0]), false);
  // What it keeps: the text's bytes and a table of where names start, not a string per name.
  // (Buffers and typed arrays are freed a moment after a collection: it waits for that.)
  const used = async () => { gc(); await new Promise((r) => setTimeout(r, 50)); gc(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
  const before = await used();
  const kept = parseList(text);
  const grew = (await used()) - before;
  assert.equal(kept.size, list.size);
  assert.ok(grew < text.length + 16 * names.length, `${grew} bytes kept for ${text.length} bytes of names`);
});

test("a download goes to a file a piece at a time, is read back and removed; too large or a failure keeps the last list", async () => {
  const names = Array.from({ length: 3000 }, (_, i) => `phish-${i}.example`).join("\n");
  const server = createServer((req, res) => {
    if (req.url === "/big") { res.writeHead(200); res.write("a.example\n".repeat(2000)); res.end("b.example\n".repeat(2000)); return; }
    if (req.url === "/gone") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": "text/plain" });
    res.write(names.slice(0, 1000));
    setTimeout(() => res.end(names.slice(1000)), 20);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "pb-phishing-"));
  try {
    const to = join(dir, "lists", "list.download");
    const got = await fetchList(`${base}/list`, { to });
    assert.ok(Buffer.isBuffer(got));
    assert.equal(got.toString("utf8"), names);
    assert.equal(existsSync(to), false, "the download file is removed");
    await assert.rejects(fetchList(`${base}/big`, { to, max: 30_000 }), /larger than expected/);
    assert.equal(existsSync(to), false);
    await assert.rejects(fetchList(`${base}/gone`, { to }), /HTTP 404/);

    // The helper's side: the list kept in its file and loaded from it; a failed update keeps it.
    const file = join(dir, "lists", "phishing-domains.txt");
    let url = `${base}/list`;
    const phishing = createPhishing({ file, fetchText: (_u, opts) => fetchList(url, opts) });
    await phishing.refresh(true);
    assert.equal(phishing.size(), 3000);
    assert.equal(readFileSync(file, "utf8"), names);
    assert.equal(phishing.listed("https://www.phish-2999.example/login"), true);
    assert.equal(phishing.listed("https://phish-3000.example/"), false);
    url = `${base}/gone`;
    await phishing.refresh(true);
    assert.equal(phishing.size(), 3000, "the last list stays");
    const again = createPhishing({ file });
    assert.equal(again.load(), 3000, "read back from its file");
    assert.equal(again.listed("http://phish-0.example/"), true);
  } finally {
    server.close();
  }
});
