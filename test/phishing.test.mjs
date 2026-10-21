// The phishing list as the helper keeps it (scripts/daemon/phishing.mjs parseList): exact host
// names, a "www." in front counting too, lines that aren't host names left out, and kept compact
// (the text's bytes and an index: no string per name, as a Set would keep).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createServer } from "node:http";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseList, listedHost, fetchList, createPhishing } from "../scripts/daemon/phishing.mjs";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc"); // a full collection, so what is measured is what stays

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

test("every name of a large list is found and nothing else; it keeps less memory than a Set", () => {
  const names = Array.from({ length: 200_000 }, (_, i) => `site-${(i * 7919) % 1_000_003}.example${i % 5}.com`);
  const text = names.join("\n");
  const list = parseList(text);
  assert.equal(list.size, new Set(names).size);
  for (let i = 0; i < names.length; i += 97) assert.equal(list.has(names[i]), true, names[i]);
  for (let i = 0; i < 2000; i++) assert.equal(list.has(`site-${i}.example9.com`), false);
  assert.equal(list.has(names[0] + "x"), false);
  assert.equal(list.has("a" + names[0]), false);
  // What it keeps: the text's bytes and a table of where names start, not a string per name.
  const used = () => { gc(); const m = process.memoryUsage(); return m.heapUsed + m.external; };
  const before = used();
  const kept = parseList(text);
  const grew = used() - before;
  assert.equal(kept.size, list.size);
  assert.ok(grew < text.length + 16 * names.length, `${grew} bytes kept for ${text.length} bytes of names`);
  const b0 = used();
  const set = new Set(text.split("\n"));
  const setGrew = used() - b0;
  assert.ok(set.size && grew < setGrew, `list ${grew}, Set ${setGrew}`);
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
