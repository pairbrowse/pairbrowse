// The Tools tab's routes (liveview.mjs, with daemon/tools.mjs and daemon/diagnostics.mjs): owner
// only, files by id, never a path in an answer or event, the OS opener only for the stored file,
// file identity checked before every action, and the diagnostics scrubbed.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, unlinkSync, symlinkSync, existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { startLiveView, createInvites } from "../scripts/liveview.mjs";
import { createDownloads, createRecordings, createHandoffs, openFile, downloadMarked, fileStill, handoffKind } from "../scripts/daemon/tools.mjs";
import { createDiagnostics } from "../scripts/daemon/diagnostics.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, path, { body, raw, host = `127.0.0.1:${port}`, headers = {} } = {}) {
  const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host, ...headers, ...(payload !== undefined ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}
function readStream(port, path) {
  return new Promise((resolve) => {
    let text = "";
    const req = http.get({ host: "127.0.0.1", port, path }, (res) => { res.setEncoding("utf8"); res.on("data", (d) => (text += d)); resolve({ text: () => text, close: () => req.destroy() }); });
    req.on("error", () => {});
  });
}
const eventsIn = (text, name) => text.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));
const rawEvents = (text, names) => text.split("\n\n").filter((b) => names.some((n) => b.startsWith(`event: ${n}\n`))).join("\n\n");

const SECRET = "hunter2";
const mask = (t) => String(t).split(SECRET).join("••••");

// A fake tab: its address, title, whether it's closed, and how often it was brought forward.
function fakePage(url, title) {
  return Object.assign(new EventEmitter(), { closed: false, fronted: 0, url: () => url, title: async () => title, isClosed() { return this.closed; }, async bringToFront() { this.fronted++; } });
}

// The whole Tools setup: the real stores over a temp folder, the opener with a recording spawn.
async function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pb-tools-")));
  const dl = join(dir, "Downloads");
  mkdirSync(dl);
  const spawned = [];
  let platform = "darwin";
  const spawn = (cmd, args) => { spawned.push([cmd, ...args]); const c = new EventEmitter(); c.unref = () => {}; setImmediate(() => c.emit("spawn")); return c; };
  let session = "default";
  const downloads = createDownloads({ session: () => session });
  const recordings = createRecordings({ file: join(dir, "recordings.json") });
  const handoffs = createHandoffs();
  const logFile = join(dir, "daemon.log");
  writeFileSync(logFile, "");
  const diagnostics = createDiagnostics({ version: "9.9.9", browser: async () => ({ engine: "chromium", version: "142.0.0.0", build: null }), agents: () => 1, logFile, home: "/Users/x", mask });
  // macOS's download mark, stood in: every file has it unless unmark()ed.
  const unmarked = new Set();
  const xattr = async (p) => (unmarked.has(p) ? null : "0081;68a1b2c3;Chromium;");
  const tools = { downloads, recordings, handoffs, diagnostics, open: (p, how) => openFile(p, how, { platform, spawn }), marked: (p) => downloadMarked(p, { platform, xattr }) };
  const pageA = fakePage("https://shop.example/checkout?step=2&token=abc", `Checkout ${SECRET}`);
  const pageB = fakePage("https://bank.example/login", "Bank login");
  const pages = [pageA, pageB];
  let recState = { recording: false, since: 0 };
  let saveNext = null;
  const invites = createInvites();
  const view = await startLiveView({
    getContext: async () => ({ pages: () => pages.filter((p) => !p.closed) }), currentUrl: async () => pageA.url(), invites, mask, tools,
    recordState: () => recState,
    onRecord: async (on) => {
      if (on) { recState = { recording: true, since: Date.now() }; return { text: "Recording the browser (1280x840)." }; }
      recState = { recording: false, since: 0 };
      const path = saveNext;
      writeFileSync(path, "video-bytes");
      recordings.add({ path, at: Date.now() - 5000, ms: 5000, size: 11 });
      return { text: `Saved the recording (5 s, 0.0 MB) to ${path}.`, path };
    },
  });
  const key = view.url.split("/").at(-2);
  const file = (name, body = "data") => { const p = join(dl, name); writeFileSync(p, body); return p; };
  const download = (name, { page = pageA, by = { label: "Claude (Mac)", color: "#4fd1e8" } } = {}) => {
    const id = downloads.add({ name, host: new URL(page.url()).host, title: "", by });
    downloads.done(id, file(name));
    return id;
  };
  return {
    dir, dl, view, key, invites, tools, downloads, recordings, handoffs, spawned, pageA, pageB, pages, logFile, file, download,
    unmark: (p) => unmarked.add(p), setPlatform: (p) => { platform = p; }, setSession: (s) => { session = s; }, saveAs: (p) => { saveNext = p; },
    done: () => { view.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const TOOL_ROUTES = [["GET", "downloads.json"], ["POST", "downloads/0123456789ab/open"], ["POST", "downloads/0123456789ab/reveal"], ["GET", "recordings.json"],
  ["POST", "recordings/0123456789ab/open"], ["POST", "recordings/0123456789ab/reveal"], ["DELETE", "recordings/0123456789ab"], ["GET", "handoffs.json"],
  ["POST", "handoffs/0123456789ab/show"], ["GET", "diagnostics.json"], ["POST", "diagnostics/report"]];

test("rights: the owner's key and the pages key only; invite links 403; never on the join-code port; 404 without tools", async () => {
  const t = await setup();
  try {
    for (const k of [t.key, t.view.pagesKey]) {
      for (const path of ["downloads.json", "recordings.json", "handoffs.json", "diagnostics.json"]) assert.equal((await request(t.view.port, "GET", `/${k}/${path}`)).status, 200, path);
    }
    const w = t.invites.create({ role: "watch", label: "W" });
    const d = t.invites.create({ role: "drive", label: "D" });
    for (const k of [w.key, d.key]) for (const [method, path] of TOOL_ROUTES) {
      assert.equal((await request(t.view.port, method, `/${k}/${path}`, { body: method === "POST" ? {} : undefined })).status, 403, `${method} /${path}`);
    }
    const c = t.invites.create({ role: "drive", label: "C", share: "code" });
    for (const k of [c.key, t.key]) for (const [method, path] of TOOL_ROUTES) {
      assert.notEqual((await request(t.view.guestPort, method, `/${k}/${path}`, { body: method === "POST" ? {} : undefined }).catch(() => ({ status: 0 }))).status, 200, `the join-code port: ${method} /${path}`);
      if (method === "GET") assert.notEqual((await request(t.view.port, method, `/${c.key}/${path}`)).status, 200, `a join code on the owner's port: ${path}`);
    }
    assert.equal(t.spawned.length, 0);
  } finally { t.done(); }
  const bare = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank" });
  try {
    const k = bare.url.split("/").at(-2);
    for (const [method, path] of TOOL_ROUTES) assert.equal((await request(bare.port, method, `/${k}/${path}`, { body: method === "GET" ? undefined : {} })).status, 404, `${method} /${path}`);
  } finally { bare.close(); }
});

test("downloads: the contract's fields, this session only, masked titles, hosts not addresses", async () => {
  const t = await setup();
  try {
    const id = t.download("report.pdf");
    t.downloads.setTitle(id, await t.pageA.title());
    t.setSession("other");
    t.download("elsewhere.pdf");
    t.setSession("default");
    const r = await request(t.view.port, "GET", `/${t.key}/downloads.json`);
    const { items } = JSON.parse(r.text);
    assert.equal(items.length, 1, "this browser session's downloads only");
    const it = items[0];
    assert.deepEqual(Object.keys(it).sort(), ["at", "by", "from", "id", "name", "size", "state"]);
    assert.deepEqual(Object.keys(it.from).sort(), ["host", "title"]);
    assert.equal(it.id, id);
    assert.match(it.id, /^[0-9a-f]{12}$/);
    assert.equal(it.name, "report.pdf");
    assert.equal(it.size, 4);
    assert.equal(it.state, "done");
    assert.deepEqual(it.from, { host: "shop.example", title: "Checkout ••••" });
    assert.deepEqual(it.by, { label: "Claude (Mac)", color: "#4fd1e8" });
    assert.ok(!r.text.includes(SECRET) && !r.text.includes(t.dir) && !r.text.includes("checkout?"));
  } finally { t.done(); }
});

test("open and reveal: ids only, the stored file's path, cross-site refused, the opener per platform", async () => {
  const t = await setup();
  try {
    const id = t.download("statement.pdf");
    const p = join(t.dl, "statement.pdf");
    // The body is ignored: never a path from the page.
    assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: { path: "/etc/passwd" } })).status, 200);
    assert.deepEqual(t.spawned.at(-1), ["open", p]);
    assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/reveal`, { body: {} })).status, 200);
    assert.deepEqual(t.spawned.at(-1), ["open", "-R", p]);
    const before = t.spawned.length;
    for (const bad of ["..%2Fx/open", "zz/open", "0123456789abc/open", `${id}/open/extra`, `${id}/run`, `${id}`, "0123456789ab/open"]) {
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${bad}`, { body: {} })).status, 404, bad);
    }
    // Another website can't post here: 403, nothing spawned, nothing changed.
    assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {}, headers: { origin: "https://evil.example" } })).status, 403);
    const rid = t.recordings.add({ path: t.file("PairBrowse recording.webm", "vid"), at: 1, ms: 2, size: 3 }).id;
    assert.equal((await request(t.view.port, "DELETE", `/${t.key}/recordings/${rid}`, { body: {}, headers: { origin: "https://evil.example" } })).status, 403);
    assert.ok(existsSync(join(t.dl, "PairBrowse recording.webm")), "nothing deleted");
    assert.equal(t.spawned.length, before);
    for (const [platform, open, reveal] of [["darwin", ["open", p], ["open", "-R", p]], ["linux", ["xdg-open", p], ["xdg-open", dirname(p)]], ["win32", ["explorer", p], ["explorer", `/select,${p}`]]]) {
      t.setPlatform(platform);
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {} })).status, 200);
      assert.deepEqual(t.spawned.at(-1), open, `${platform} open`);
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/reveal`, { body: {} })).status, 200);
      assert.deepEqual(t.spawned.at(-1), reveal, `${platform} reveal`);
    }
    // An opener that won't start is an answer, not a crash.
    const failing = await openFile(p, "open", { platform: "darwin", spawn: () => { const c = new EventEmitter(); setImmediate(() => c.emit("error", Object.assign(new Error("x"), { code: "ENOENT" }))); return c; } });
    assert.deepEqual(failing, { error: "ENOENT" });
    assert.deepEqual(await openFile(p, "open", { platform: "darwin", spawn: () => { throw Object.assign(new Error("x"), { code: "EACCES" }); } }), { error: "EACCES" });
  } finally { t.done(); }
});

test("open: any download; programs and scripts only with a confirm (428); not before a download is done", async () => {
  const t = await setup();
  try {
    for (const name of ["x.zip", "x.bin", "x.pdf"]) {
      const id = t.download(name);
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {} })).status, 200, name);
      assert.deepEqual(t.spawned.at(-1), ["open", join(t.dl, name)], name);
    }
    const programs = ["x.command", "x.sh", "x.pkg", "x.dmg", "x.exe", "x.py", "x.js", "x.jar", "x.ps1", "x.scpt", "x.tool", "X.COMMAND",
      "x.html", "x.htm", "x.svg", "x.svgz", "x.xhtml", "x.mhtml", "x.webarchive", "x.url", "x.webloc", "X.HTML"];
    for (const name of programs) {
      const id = t.download(name);
      const before = t.spawned.length;
      for (const body of [undefined, {}, { confirm: "yes" }, { confirm: 1 }]) {
        const r = await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, body === undefined ? {} : { body });
        assert.equal(r.status, 428, `${name} ${JSON.stringify(body)}`);
        assert.deepEqual(JSON.parse(r.text), { confirm: "This is a program or script. Open it anyway?" });
      }
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { raw: "not json" })).status, 428, name);
      assert.equal(t.spawned.length, before, `${name}: nothing opened before the confirm`);
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/reveal`, { body: {} })).status, 200, name);
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: { confirm: true, path: "/etc/passwd" } })).status, 200, name);
      assert.deepEqual(t.spawned.at(-1), ["open", join(t.dl, name)], `${name}: the stored file, with the confirm`);
    }
    const going = t.downloads.add({ name: "big.pdf", host: "shop.example" });
    assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${going}/open`, { body: {} })).status, 409, "in progress");
    t.downloads.failed(going);
    assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${going}/reveal`, { body: {} })).status, 409, "failed");
    const spawnedNow = t.spawned.length;
    assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${going}/open`, { body: { confirm: true } })).status, 409, "failed, confirmed");
    assert.equal(t.spawned.length, spawnedNow, "nothing more spawned");
  } finally { t.done(); }
});

test("a file replaced or turned into a symlink answers 410, untouched, nothing spawned", async () => {
  const t = await setup();
  try {
    const id = t.download("a.pdf");
    const p = join(t.dl, "a.pdf");
    // Replaced: a new file (a new inode) renamed over it.
    writeFileSync(`${p}.new`, "data");
    renameSync(`${p}.new`, p);
    for (const how of ["open", "reveal"]) assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/${how}`, { body: {} })).status, 410, how);
    const id2 = t.download("b.pdf");
    const p2 = join(t.dl, "b.pdf");
    unlinkSync(p2);
    symlinkSync(p, p2);
    assert.equal(fileStill(t.downloads.entry(id2)), false);
    assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id2}/open`, { body: {} })).status, 410);
    // A recording replaced: delete refuses and leaves it there.
    const rp = t.file("r.webm", "vid");
    const rid = t.recordings.add({ path: rp, at: 1, ms: 2, size: 3 }).id;
    writeFileSync(`${rp}.new`, "other video");
    renameSync(`${rp}.new`, rp);
    for (const [method, path] of [["POST", `recordings/${rid}/open`], ["POST", `recordings/${rid}/reveal`], ["DELETE", `recordings/${rid}`]]) {
      assert.equal((await request(t.view.port, method, `/${t.key}/${path}`, { body: {} })).status, 410, `${method} ${path}`);
    }
    assert.equal(readFileSync(rp, "utf8"), "other video", "left as it was");
    const sp = t.file("s.webm", "vid");
    const sid = t.recordings.add({ path: sp, at: 1, ms: 2, size: 3 }).id;
    unlinkSync(sp);
    symlinkSync(rp, sp);
    assert.equal((await request(t.view.port, "DELETE", `/${t.key}/recordings/${sid}`, { body: {} })).status, 410);
    assert.ok(existsSync(rp) && existsSync(sp));
    assert.equal(t.spawned.length, 0);
  } finally { t.done(); }
});

test("recordings: only the helper's own, deleted by id; the index stays 0600; owners hear saved and removed", async () => {
  const t = await setup();
  const owner = await readStream(t.view.port, `/${t.key}/events?page=right`);
  const guest = await readStream(t.view.port, `/${t.invites.create({ role: "drive", label: "G" }).key}/events?panel=1`);
  try {
    await wait(50);
    const mine = t.file("PairBrowse recording 1.webm", "video");
    const other = t.file("Holiday.mp4", "not ours");
    const item = t.recordings.add({ path: mine, at: 1000, ms: 4000, size: 5 });
    let r = JSON.parse((await request(t.view.port, "GET", `/${t.key}/recordings.json`)).text);
    assert.deepEqual(r.recording, { on: false, since: 0 });
    assert.equal(r.items.length, 1, "a file the helper didn't record isn't listed");
    assert.deepEqual(r.items[0], { id: item.id, name: "PairBrowse recording 1.webm", size: 5, at: 1000, duration: 4000 });
    assert.equal((await request(t.view.port, "POST", `/${t.key}/recordings/${item.id}/open`, { body: {} })).status, 200);
    assert.deepEqual(t.spawned.at(-1), ["open", mine]);
    assert.equal((await request(t.view.port, "DELETE", `/${t.key}/recordings/0123456789ab`, { body: {} })).status, 404, "no such recording");
    assert.equal((await request(t.view.port, "DELETE", `/${t.key}/recordings/${item.id}`, { body: { path: other } })).status, 200);
    assert.equal(existsSync(mine), false);
    assert.equal(existsSync(other), true, "the body names nothing");
    const index = join(t.dir, "recordings.json");
    assert.ok(!readFileSync(index, "utf8").includes(item.id));
    assert.equal((statSync(index).mode & 0o777).toString(8), "600");
    assert.equal((await request(t.view.port, "DELETE", `/${t.key}/recordings/${item.id}`, { body: {} })).status, 404, "gone");
    // Saved from the route (the agent's pairbrowse_record stop takes the same recorder hook).
    t.saveAs(join(t.dl, "PairBrowse recording 2.webm"));
    const started = await request(t.view.port, "POST", `/${t.key}/record`, { body: { on: true } });
    assert.equal(JSON.parse(started.text).text, "Recording the browser.");
    const stopped = await request(t.view.port, "POST", `/${t.key}/record`, { body: { on: false } });
    const answer = JSON.parse(stopped.text);
    assert.equal(stopped.status, 200);
    assert.equal(Object.hasOwn(answer, "path"), false, "no path in POST record's answer");
    assert.equal(answer.text, 'Saved the recording as "PairBrowse recording 2.webm" in your downloads folder.');
    assert.ok(!stopped.text.includes(t.dir) && !stopped.text.includes("/"), stopped.text);
    assert.equal(answer.item.name, "PairBrowse recording 2.webm");
    r = JSON.parse((await request(t.view.port, "GET", `/${t.key}/recordings.json`)).text);
    assert.equal(r.items[0].id, answer.item.id, "listed first");
    await wait(50);
    const recs = eventsIn(owner.text(), "record");
    const removed = recs.find((e) => e.op === "removed");
    assert.deepEqual(removed, { recording: false, since: 0, op: "removed", id: item.id });
    const saved = recs.filter((e) => e.op === "saved").at(-1);
    assert.deepEqual(saved, { recording: false, since: 0, op: "saved", item: answer.item });
    assert.equal(eventsIn(guest.text(), "record").length, 0, "guests never hear of recordings");
    assert.ok(!rawEvents(owner.text(), ["record"]).includes(t.dir));
    // A failed stop is scrubbed: no folder in it.
    const fail = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", tools: t.tools, onRecord: async () => ({ text: `Couldn't save to ${homedir()}/Downloads/x.webm.`, error: true }) });
    try {
      const k = fail.url.split("/").at(-2);
      const f = await request(fail.port, "POST", `/${k}/record`, { body: { on: false } });
      assert.equal(f.status, 409);
      assert.ok(!f.text.includes(homedir()) && !JSON.parse(f.text).path, f.text);
    } finally { fail.close(); }
  } finally { owner.close(); guest.close(); t.done(); }
});

test("hand-offs: listed with the agent and its tab, masked; removed when cleared or the tab closes; show brings the tab forward; guests never hear", async () => {
  const t = await setup();
  const owner = await readStream(t.view.port, `/${t.key}/events?page=right`);
  const guest = await readStream(t.view.port, `/${t.invites.create({ role: "watch", label: "G" }).key}/events?panel=1`);
  try {
    await wait(50);
    t.handoffs.set("status:p1", { text: `Sign in please, the code is ${SECRET}`, page: t.pageB, by: { label: "Claude (Mac)", color: "#4fd1e8" } });
    t.handoffs.set("check", { text: "Solve the check in this tab", page: t.pageA, kind: "captcha", by: { label: "PairBrowse", color: "" } });
    const r = await request(t.view.port, "GET", `/${t.key}/handoffs.json`);
    const { items } = JSON.parse(r.text);
    assert.equal(items.length, 2);
    const login = items.find((h) => h.by.label === "Claude (Mac)");
    assert.deepEqual(Object.keys(login).sort(), ["at", "by", "id", "kind", "tab", "text"]);
    assert.equal(login.kind, "login");
    assert.equal(login.text, "Sign in please, the code is ••••");
    assert.deepEqual(Object.keys(login.tab).sort(), ["host", "id", "title"]);
    assert.equal(login.tab.host, "bank.example");
    assert.equal(login.tab.title, "Bank login");
    const check = items.find((h) => h.kind === "captcha");
    assert.deepEqual(check.by, { label: "PairBrowse", color: "" });
    assert.equal(check.tab.title, "Checkout ••••");
    assert.ok(!r.text.includes(SECRET) && !r.text.includes("checkout?"));
    // Setting the same key again keeps its id.
    assert.equal(t.handoffs.set("status:p1", { text: "Sign in again", page: t.pageB }), login.id);
    assert.equal((await request(t.view.port, "POST", `/${t.key}/handoffs/${login.id}/show`, { body: {} })).status, 200);
    assert.equal(t.pageB.fronted, 1);
    assert.equal((await request(t.view.port, "POST", `/${t.key}/handoffs/0123456789ab/show`, { body: {} })).status, 404);
    t.handoffs.clear("status:p1");
    // The tab closes: the store forgets it (the helper's onTabClosed), and a closed tab answers 409 meanwhile.
    t.pageA.closed = true;
    const shown = await request(t.view.port, "POST", `/${t.key}/handoffs/${check.id}/show`, { body: {} });
    assert.ok(shown.status === 404 || shown.status === 409, String(shown.status));
    assert.equal(JSON.parse((await request(t.view.port, "GET", `/${t.key}/handoffs.json`)).text).items.length, 0, "a closed tab's hand-off isn't listed");
    t.handoffs.forgetPage(t.pageA);
    assert.equal(t.handoffs.entry(check.id), null);
    await wait(80);
    const ev = eventsIn(owner.text(), "handoffs");
    assert.deepEqual(ev.map((e) => e.op), ["add", "add", "add", "remove", "remove"]);
    assert.equal(ev[0].item.text, "Sign in please, the code is ••••");
    assert.equal(ev[3].id, login.id);
    assert.equal(ev[4].id, check.id);
    assert.ok(!rawEvents(owner.text(), ["handoffs"]).includes(SECRET));
    assert.equal(eventsIn(guest.text(), "handoffs").length, 0);
    assert.equal(handoffKind("Enter your card number"), "payment");
  } finally { owner.close(); guest.close(); t.done(); }
});

test("downloads events reach the owner's streams only, masked", async () => {
  const t = await setup();
  const owner = await readStream(t.view.port, `/${t.key}/events?page=right`);
  const guest = await readStream(t.view.port, `/${t.invites.create({ role: "drive", label: "G" }).key}/events?panel=1`);
  try {
    await wait(50);
    const id = t.download("inv.pdf");
    t.downloads.setTitle(id, `Invoice ${SECRET}`);
    await wait(50);
    const ev = eventsIn(owner.text(), "downloads");
    assert.deepEqual(ev.map((e) => e.op), ["add", "update", "update"]);
    assert.equal(ev[0].item.state, "in-progress");
    assert.equal(ev[1].item.state, "done");
    assert.equal(ev[2].item.from.title, "Invoice ••••");
    assert.equal(eventsIn(guest.text(), "downloads").length, 0);
    const raw = rawEvents(owner.text(), ["downloads"]);
    assert.ok(!raw.includes(SECRET) && !raw.includes(t.dir) && !raw.includes(homedir()));
  } finally { owner.close(); guest.close(); t.done(); }
});

test("diagnostics: the contract's fields, errors scrubbed, the report by role counts", async () => {
  const t = await setup();
  const key43 = "Zx9_" + "k".repeat(39);
  assert.equal(key43.length, 43);
  try {
    const lines = [];
    for (let i = 0; i < 30; i++) {
      const what = [`saved password ${SECRET} rejected`, `joining with ${key43} failed`, "error loading https://site.example/path?q=1", "error mailing bob@example.com",
        "failed to write /Users/x/Downloads/tax.pdf", "failed: see ~/.pairbrowse/sessions/a/log"][i % 6];
      lines.push(`2026-10-12T10:00:${String(i).padStart(2, "0")}.000Z session ${what}`);
    }
    writeFileSync(t.logFile, lines.join("\n") + "\n");
    const w = t.invites.create({ role: "watch", label: "Wanda Watcher" });
    const guest = await readStream(t.view.port, `/${w.key}/events?panel=1`);
    try {
      await wait(50);
      const r = await request(t.view.port, "GET", `/${t.key}/diagnostics.json`);
      const d = JSON.parse(r.text);
      assert.deepEqual(Object.keys(d).sort(), ["browser", "connections", "errors", "helper", "joined"]);
      assert.deepEqual(Object.keys(d.helper).sort(), ["node", "uptime", "version"]);
      assert.equal(d.helper.version, "9.9.9");
      assert.deepEqual(d.browser, { engine: "chromium", version: "142.0.0.0", build: null });
      assert.deepEqual(Object.keys(d.connections).sort(), ["agents", "joiners", "streams", "viewers"]);
      assert.equal(d.connections.agents, 1);
      assert.equal(d.connections.streams, 1);
      assert.deepEqual(d.joined, [{ label: "Wanda Watcher", role: "watch" }], "names are in the local view");
      assert.equal(d.errors.length, 20);
      const all = d.errors.map((e) => e.text).join("\n");
      for (const want of ["site.example", "[email]", "[path]", "~/.pairbrowse/sessions/a/log", "[key]"]) assert.ok(all.includes(want), want);
      assert.ok(!r.text.includes(SECRET) && !r.text.includes(key43) && !r.text.includes("/path?q") && !r.text.includes("bob@"));
      assert.ok(d.errors.every((e) => e.where === "session" && Number.isFinite(e.at)));
      const rep = await request(t.view.port, "POST", `/${t.key}/diagnostics/report`, { body: { include: "everything" } });
      assert.equal(rep.status, 200);
      const { text } = JSON.parse(rep.text);
      assert.match(text, /Joined: 0 drive, 1 watch/);
      assert.ok(!text.includes("Wanda"), "the report names nobody");
      assert.ok(!text.includes(SECRET) && !text.includes(key43) && !text.includes("bob@") && !text.includes("/Users/x"));
      assert.ok(text.split("\n").every((l) => l.length <= 200));
      assert.equal((await request(t.view.port, "POST", `/${t.key}/diagnostics/other`, { body: {} })).status, 404);
    } finally { guest.close(); }
  } finally { t.done(); }
});

test("no tools answer or event carries a path, a key or a full address", async () => {
  const t = await setup();
  const owner = await readStream(t.view.port, `/${t.key}/events?page=right`);
  try {
    await wait(50);
    const id = t.download("plan.pdf");
    t.downloads.setTitle(id, "Plan");
    const rid = t.recordings.add({ path: t.file("rec.webm", "v"), at: 1, ms: 1, size: 1 }).id;
    t.handoffs.set("status:x", { text: "Your turn: pay", page: t.pageA, by: { label: "A", color: "#4fd1e8" } });
    writeFileSync(t.logFile, `2026-10-12T10:00:00.000Z liveview error reading ${t.dir}/x and ${homedir()}/y at https://a.example/b?c=d\n`);
    const texts = [];
    for (const path of ["downloads.json", "recordings.json", "handoffs.json", "diagnostics.json"]) texts.push((await request(t.view.port, "GET", `/${t.key}/${path}`)).text);
    for (const [method, path] of [["POST", `downloads/${id}/open`], ["POST", `downloads/${id}/reveal`], ["POST", `recordings/${rid}/reveal`], ["POST", "diagnostics/report"], ["POST", `handoffs/${t.handoffs.list()[0].id}/show`], ["DELETE", `recordings/${rid}`]]) {
      texts.push((await request(t.view.port, method, `/${t.key}/${path}`, { body: {} })).text);
    }
    await wait(80);
    texts.push(rawEvents(owner.text(), ["downloads", "handoffs", "record"]));
    for (const text of texts) {
      assert.ok(!text.includes(t.dir), text);
      assert.ok(!text.includes(homedir()), text);
      assert.ok(!/(^|[\s"'(=])\/(Users|home|private|var|tmp|Volumes|etc)\//.test(text), text);
      assert.ok(!/[A-Za-z0-9_-]{32,}/.test(text), text);
      assert.ok(!/[a-z]+:\/\/[^\s"/]+\/[^\s"]/i.test(text), text);
    }
  } finally { owner.close(); t.done(); }
});

test("close() lets go of the three stores", async () => {
  const t = await setup();
  assert.equal(t.downloads.listeners(), 1);
  assert.equal(t.recordings.listeners(), 1);
  assert.equal(t.handoffs.listeners(), 1);
  t.done();
  assert.equal(t.downloads.listeners(), 0);
  assert.equal(t.recordings.listeners(), 0);
  assert.equal(t.handoffs.listeners(), 0);
});

test("open: office formats open with their default app; recordings keep their list; pdf, images, media and text open", async () => {
  const t = await setup();
  try {
    const office = ["x.doc", "x.docx", "x.xls", "x.xlsx", "x.ppt", "x.pptx", "x.odt", "x.ods", "x.odp", "x.rtf", "x.pages", "x.numbers", "x.key", "X.DOCX"];
    for (const name of office) {
      const id = t.download(name);
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {} })).status, 200, name);
      assert.deepEqual(t.spawned.at(-1), ["open", join(t.dl, name)], name);
    }
    const before = t.spawned.length;
    const rid = t.recordings.add({ path: t.file("notes.docx", "doc"), at: 1, ms: 2, size: 3 }).id;
    assert.equal((await request(t.view.port, "POST", `/${t.key}/recordings/${rid}/open`, { body: { confirm: true } })).status, 409, "a recording's id keeps its list");
    assert.equal(t.spawned.length, before);
    for (const name of ["a.pdf", "a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.heic", "a.txt", "a.csv", "a.json", "a.md", "a.mp4", "a.mov", "a.webm", "a.m4v", "a.mp3", "a.wav", "a.m4a"]) {
      const id = t.download(name);
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {} })).status, 200, name);
      assert.deepEqual(t.spawned.at(-1), ["open", join(t.dl, name)], name);
    }
  } finally { t.done(); }
});

test("downloads: an id from an earlier browser session answers 404 for open and reveal, nothing spawned", async () => {
  const t = await setup();
  try {
    t.setSession("work");
    const id = t.download("old.pdf");
    assert.ok(t.downloads.entry(id), "known in its own session");
    t.setSession("default");
    assert.equal(t.downloads.entry(id), null);
    for (const how of ["open", "reveal"]) assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/${how}`, { body: {} })).status, 404, how);
    assert.equal(t.spawned.length, 0);
    t.setSession("work");
    assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {} })).status, 200, "back in that session it opens again");
  } finally { t.done(); }
});

test("hand-offs: show for a hand-off with no tab answers 409 with a sentence", async () => {
  const t = await setup();
  try {
    const id = t.handoffs.set("run:step", { text: "Check your email for the code", page: null });
    const items = JSON.parse((await request(t.view.port, "GET", `/${t.key}/handoffs.json`)).text).items;
    assert.equal(items.find((h) => h.id === id).tab, null);
    const r = await request(t.view.port, "POST", `/${t.key}/handoffs/${id}/show`, { body: {} });
    assert.equal(r.status, 409);
    assert.match(JSON.parse(r.text).error, /nothing to show/);
    assert.equal(t.pageA.fronted + t.pageB.fronted, 0);
  } finally { t.done(); }
});

test("record: a failed answer keeps the recorder's own quoted words readable, masked, folders still hidden", async () => {
  const t = await setup();
  const fail = await startLiveView({ getContext: async () => ({ pages: () => [] }), currentUrl: async () => "about:blank", tools: t.tools, mask,
    onRecord: async () => ({ text: `Not recording. Start with pairbrowse_record action "start" (${SECRET}, ${homedir()}/Downloads/x.webm).`, error: true }) });
  try {
    const k = fail.url.split("/").at(-2);
    const f = await request(fail.port, "POST", `/${k}/record`, { body: { on: false } });
    assert.equal(f.status, 409);
    const text = JSON.parse(f.text).text;
    assert.match(text, /action "start"/, "the quoted word is kept");
    assert.ok(!text.includes("…"), text);
    assert.ok(!text.includes(SECRET) && text.includes("••••"), "masked");
    assert.ok(!text.includes(homedir()), "no folder");
  } finally { fail.close(); t.done(); }
});

test("open: on macOS a download without the quarantine mark is refused (409, Finder only); other systems skip the check", async () => {
  const t = await setup();
  try {
    const id = t.download("report.docx");
    const p = join(t.dl, "report.docx");
    t.unmark(p);
    const before = t.spawned.length;
    for (const body of [{}, { confirm: true }]) {
      const r = await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body });
      assert.equal(r.status, 409);
      assert.equal(JSON.parse(r.text).error, "This file lost the download mark macOS uses to protect you; show it in Finder instead.");
    }
    const prog = t.download("run.command");
    t.unmark(join(t.dl, "run.command"));
    assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${prog}/open`, { body: {} })).status, 409, "the mark first, then the confirm");
    assert.equal(t.spawned.length, before, "nothing opened");
    assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/reveal`, { body: {} })).status, 200, "Show in Finder still works");
    assert.deepEqual(t.spawned.at(-1), ["open", "-R", p]);
    for (const platform of ["linux", "win32"]) {
      t.setPlatform(platform);
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {} })).status, 200, platform);
    }
    // The reader: an empty value, a throw or a reader that never answers is no mark.
    assert.equal(await downloadMarked(p, { platform: "darwin", xattr: async () => "" }), false);
    assert.equal(await downloadMarked(p, { platform: "darwin", xattr: () => { throw new Error("x"); } }), false);
    assert.equal(await downloadMarked(p, { platform: "darwin", xattr: async () => "0081;1;Chromium;" }), true);
    assert.equal(await downloadMarked(p, { platform: "linux", xattr: async () => null }), true);
    // The real reader on this Mac: a file written here has no quarantine mark.
    if (process.platform === "darwin") assert.equal(await downloadMarked(p), false);
  } finally { t.done(); }
});
