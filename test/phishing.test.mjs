// Phishing protection (daemon/phishing.mjs): the list read, a host matched exactly (www. too), the
// list kept fresh (a short or failed download keeps the last one), and a listed top-level
// navigation turned into the warning page; a Continue anyway from that page lets its host through.
// The list is kept compact (a table of where names start in its file, read a piece at a time: no
// string per name, as a Set would keep, and not the file's bytes) and downloaded a piece at a time.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, renameSync, utimesSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseList, listedHost, warningPage, createPhishing, fetchList, downloadList } from "../scripts/daemon/phishing.mjs";

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

test("a list read from its file keeps only its table, finds names across pieces read, and skips lines no host name could be", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-phishing-"));
  const names = Array.from({ length: 200_000 }, (_, i) => `Site-${(i * 7919) % 1_000_003}.example${i % 5}.com`);
  const file = join(dir, "list.txt");
  writeFileSync(file, `${"x".repeat(200_000)}.example\n${names.join("\r\n")}\n${"y".repeat(70_000)}\nlast.example`);
  const used = async () => { gc(); await new Promise((r) => setTimeout(r, 50)); gc(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
  const before = await used();
  const list = parseList({ file });
  const grew = (await used()) - before;
  assert.equal(list.size, new Set(names.map((n) => n.toLowerCase())).size + 1);
  for (const n of names) if (!list.has(n.toLowerCase())) assert.fail(`${n} not found`);
  assert.equal(list.has("last.example"), true, "the last line, with no line end");
  assert.equal(list.has(`${"x".repeat(200_000)}.example`), false, "a line longer than a piece read");
  assert.equal(list.has("site-1.example9.com") || list.has("site-0.example0.co"), false);
  assert.ok(grew < 6 * 1024 * 1024, `${grew} bytes kept for a ${readFileSync(file).length}-byte list`);
  // A newer list renamed over its file changes nothing for the one read.
  writeFileSync(join(dir, "other.txt"), "other.example\n");
  renameSync(join(dir, "other.txt"), file);
  assert.equal(list.has(names[0].toLowerCase()), true);
  assert.equal([...list].length, list.size);
  list.close();
});

test("a download goes to a file a piece at a time (redirects followed); too large or a failure leaves no file and keeps the last list", async () => {
  const names = Array.from({ length: 3000 }, (_, i) => `phish-${i}.example`).join("\n");
  const server = createServer((req, res) => {
    if (req.url === "/big") { res.writeHead(200); res.write("a.example\n".repeat(2000)); res.end("b.example\n".repeat(2000)); return; }
    if (req.url === "/gone") { res.writeHead(404); res.end(); return; }
    if (req.url === "/moved") { res.writeHead(302, { location: "/list" }); res.end(); return; }
    if (req.url === "/away") { res.writeHead(302, { location: "file:///etc/passwd" }); res.end(); return; }
    res.writeHead(200, { "content-type": "text/plain" });
    res.write(names.slice(0, 1000));
    setTimeout(() => res.end(names.slice(1000)), 20);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "pb-phishing-"));
  try {
    const to = join(dir, "lists", "list.download");
    assert.equal(await fetchList(`${base}/list`, { to }), Buffer.byteLength(names));
    assert.equal(readFileSync(to, "utf8"), names);
    rmSync(to);
    assert.equal(await fetchList(`${base}/moved`, { to }), Buffer.byteLength(names), "a redirect followed");
    rmSync(to);
    await assert.rejects(fetchList(`${base}/big`, { to, max: 30_000 }), /larger than expected/);
    assert.equal(existsSync(to), false);
    await assert.rejects(fetchList(`${base}/gone`, { to }), /HTTP 404/);
    assert.equal(existsSync(to), false);
    await assert.rejects(fetchList(`${base}/away`, { to }), /bad redirect/);

    // The helper's side: the download in a process of its own, the list kept in its file and read
    // from it when first needed; a failed update keeps it, and leaves no download behind.
    await assert.rejects(downloadList(`${base}/gone`, { to }), /HTTP 404/, "its process's reason");
    assert.equal(existsSync(to), false);
    const file = join(dir, "lists", "phishing-domains.txt");
    let url = `${base}/list`;
    const logs = [];
    const phishing = createPhishing({ file, fetchText: (_u, opts) => downloadList(url, opts), log: (l) => logs.push(l) });
    await phishing.refresh(true);
    assert.equal(phishing.size(), 3000);
    assert.equal(readFileSync(file, "utf8"), names);
    assert.equal(phishing.listed("https://www.phish-2999.example/login"), true);
    assert.equal(phishing.listed("https://phish-3000.example/"), false);
    url = `${base}/gone`;
    await phishing.refresh(true);
    assert.equal(phishing.size(), 3000, "the last list stays");
    assert.match(logs.at(-1), /not updated \(HTTP 404\); the last one \(3000 sites\) stays/);
    const again = createPhishing({ file });
    assert.equal(again.load(), 3000, "read back from its file");
    assert.equal(again.listed("http://phish-0.example/"), true);
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(join(dir, "lists")), ["phishing-domains.txt"], "no download left behind");
    phishing.close();
    again.close();
  } finally {
    server.close();
  }
});

test("the list is read on the first navigation checked, not at start; one another helper updated is read anew", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-phishing-"));
  const file = join(dir, "p.txt");
  writeFileSync(file, big(["at-start.example"]));
  let fetched = 0;
  const p = createPhishing({ file, fetchText: async () => { fetched++; return big(); } });
  p.start();
  assert.equal(fetched, 0, "a fresh list isn't downloaded");
  // The file is replaced after start: had start read it, the list read then would still be the one
  // used (its file kept open), and at-start.example listed.
  writeFileSync(join(dir, "n.txt"), big(["first.example"]));
  renameSync(join(dir, "n.txt"), file);
  assert.equal(p.listed("https://first.example/"), true, "read on the first navigation checked");
  assert.equal(p.listed("https://at-start.example/"), false, "not read at start");
  // Another helper on this computer replaced the file.
  writeFileSync(join(dir, "n.txt"), big(["second.example"]));
  renameSync(join(dir, "n.txt"), file);
  utimesSync(file, new Date(), new Date(Date.now() + 5000));
  assert.equal(p.listed("https://second.example/"), false, "until its next look");
  await p.refresh();
  assert.equal(fetched, 0);
  assert.equal(p.listed("https://second.example/"), true);
  assert.equal(p.listed("https://first.example/"), false);
  p.close();
});

test("a download ends with its helper: a killed helper's download stops and its file goes; one left by an ended helper is removed at start", async () => {
  const { spawn } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "pb-phishing-"));
  const to = join(dir, "p.txt.1.download");
  let asked = 0, sockets = 0;
  const server = createServer((_req, res) => { asked++; res.writeHead(200); res.write("half.example\n"); }); // never ends
  server.on("connection", (s) => { sockets++; s.on("close", () => sockets--); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/list`;
  const helper = join(dir, "helper.mjs");
  writeFileSync(helper, `import { downloadList } from ${JSON.stringify(pathToFileURL(new URL("../scripts/daemon/phishing.mjs", import.meta.url).pathname).href)};
downloadList(${JSON.stringify(url)}, { to: ${JSON.stringify(to)}, ms: 60000 }).catch(() => {});\n`);
  const parent = spawn(process.execPath, [helper], { stdio: "ignore" });
  const until = async (ok, what) => { const end = Date.now() + 10_000; while (!ok()) { if (Date.now() > end) throw new Error(what); await new Promise((r) => setTimeout(r, 50)); } };
  try {
    await until(() => asked === 1 && existsSync(to), "the download started");
    parent.kill("SIGKILL");
    await until(() => !existsSync(to) && sockets === 0, "the download stopped with its helper");
  } finally { parent.kill("SIGKILL"); server.closeAllConnections(); server.close(); }

  // Left by helpers that ended (their pids gone, and the older fixed name); one of a running helper stays.
  const file = join(dir, "q.txt");
  writeFileSync(file, big(["kept.example"]));
  const dead = spawn(process.execPath, ["-e", ""]);
  await new Promise((r) => dead.on("close", r));
  for (const n of [`q.txt.${dead.pid}.download`, "q.txt.download", `q.txt.${process.pid}.download`]) writeFileSync(join(dir, n), "x");
  const p = createPhishing({ file, fetchText: async () => { throw new Error("not asked"); } });
  p.start();
  assert.equal(existsSync(join(dir, `q.txt.${dead.pid}.download`)), false);
  assert.equal(existsSync(join(dir, "q.txt.download")), false);
  assert.equal(existsSync(join(dir, `q.txt.${process.pid}.download`)), true, "a running helper's download stays");
  assert.equal(p.listed("https://kept.example/"), true);
  p.close();
  rmSync(dir, { recursive: true, force: true });
});
