// The Tools tab's routes (liveview.mjs, with daemon/tools.mjs and daemon/diagnostics.mjs): owner
// only, files by id, never a path in an answer or event, the OS opener only for the stored file,
// file identity checked before every action, and the diagnostics scrubbed.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { EventEmitter } from "node:events";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, unlinkSync, symlinkSync, existsSync, readFileSync, readdirSync, statSync, realpathSync, copyFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { startLiveView, createInvites } from "../scripts/liveview.mjs";
import { createDownloads, createRecordings, createHandoffs, openFile, downloadMarked, keepDownloadMark, fileStill, handoffKind, createPersonTabs } from "../scripts/daemon/tools.mjs";
import { createPreviews } from "../scripts/daemon/preview.mjs";
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
  // The person's tab, stood in: each openTab call recorded as [url, onClose]; fail() makes the next ones fail.
  const tabs = [];
  let tabFails = false;
  let engine = null;
  const personTabs = createPersonTabs();
  // textutil, stood in: it writes docHtml to its -output path (null: writes nothing; "hang": never answers).
  const execs = [];
  let docHtml = "<html><head><style>p.p1 {margin: 0}</style></head><body><p class=\"p1\">Hello</p></body></html>";
  const execFile = (cmd, args, opts, cb) => {
    execs.push({ cmd, args, opts });
    if (docHtml === "hang") return {};
    if (docHtml !== null) writeFileSync(args[args.indexOf("-output") + 1], docHtml);
    setImmediate(() => cb(null, "", ""));
    return {};
  };
  const previewDir = join(dir, "previews");
  const previews = createPreviews({ dir: previewDir, execFile, textutilMs: 300 });
  const tools = { downloads, recordings, handoffs, diagnostics, open: (p, how) => openFile(p, how, { platform, spawn }), marked: (p) => downloadMarked(p, { platform, xattr }),
    openTab: async (url, onClose) => { tabs.push([url, onClose]); return tabFails ? { error: "The file couldn't be shown in a tab." } : { ok: true }; },
    preview: (e, kind) => previews.make(e, kind), engine: () => engine, get platform() { return platform; }, personTab: (p) => personTabs.has(p) };
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
    dir, dl, view, key, invites, tools, downloads, recordings, handoffs, spawned, pageA, pageB, pages, logFile, file, download, tabs, execs, previewDir, previews, personTabs,
    failTabs: (on = true) => { tabFails = on; }, setEngine: (e) => { engine = e; }, setDocHtml: (h) => { docHtml = h; },
    unmark: (p) => unmarked.add(p), setPlatform: (p) => { platform = p; }, setSession: (s) => { session = s; }, saveAs: (p) => { saveNext = p; },
    done: () => { view.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

const TOOL_ROUTES = [["GET", "downloads.json"], ["POST", "downloads/0123456789ab/open"], ["POST", "downloads/0123456789ab/reveal"], ["POST", "downloads/0123456789ab/open-app"], ["GET", "recordings.json"],
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
    // A file the browser doesn't render (a .pdf opens in a tab: see the tests below).
    const id = t.download("statement.zip");
    const p = join(t.dl, "statement.zip");
    // The body is ignored: never a path from the page.
    const opened = await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: { path: "/etc/passwd" } });
    assert.equal(opened.status, 200);
    assert.deepEqual(JSON.parse(opened.text), { ok: true, opened: "app" });
    assert.deepEqual(t.spawned.at(-1), ["open", p]);
    const revealed = await request(t.view.port, "POST", `/${t.key}/downloads/${id}/reveal`, { body: {} });
    assert.equal(revealed.status, 200);
    assert.deepEqual(JSON.parse(revealed.text), { ok: true }, "Reveal says only ok");
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
    for (const name of ["x.zip", "x.bin"]) {
      const id = t.download(name);
      assert.equal((await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {} })).status, 200, name);
      assert.deepEqual(t.spawned.at(-1), ["open", join(t.dl, name)], name);
    }
    // A pdf opens in the person's tab: nothing spawned, the file's own file:// URL.
    {
      const id = t.download("x.pdf");
      const before = t.spawned.length;
      const r = await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {} });
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.text), { opened: "tab" });
      assert.equal(t.spawned.length, before, "x.pdf: nothing spawned");
      assert.equal(t.tabs.at(-1)[0], pathToFileURL(join(t.dl, "x.pdf")).href);
    }
    const PROGRAM = "This is a program or script. Open it anyway?";
    const WEB = "This is a web page saved to your computer. It opens in your web browser and can run its own scripts. Open it anyway?";
    const programs = [["x.command", PROGRAM], ["x.sh", PROGRAM], ["x.pkg", PROGRAM], ["x.dmg", PROGRAM], ["x.exe", PROGRAM], ["x.py", PROGRAM], ["x.js", PROGRAM], ["x.jar", PROGRAM], ["x.ps1", PROGRAM], ["x.scpt", PROGRAM], ["x.tool", PROGRAM], ["X.COMMAND", PROGRAM],
      ["x.html", WEB], ["x.htm", WEB], ["x.svg", WEB], ["x.svgz", WEB], ["x.xhtml", WEB], ["x.mhtml", WEB], ["x.webarchive", WEB], ["x.url", WEB], ["x.webloc", WEB], ["X.HTML", WEB]];
    for (const [name, sentence] of programs) {
      const id = t.download(name);
      const before = t.spawned.length;
      for (const body of [undefined, {}, { confirm: "yes" }, { confirm: 1 }]) {
        const r = await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, body === undefined ? {} : { body });
        assert.equal(r.status, 428, `${name} ${JSON.stringify(body)}`);
        assert.deepEqual(JSON.parse(r.text), { confirm: sentence }, name);
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
    assert.equal(t.tabs.length, 0, "no tab opened");
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
    const recOpen = await request(t.view.port, "POST", `/${t.key}/recordings/${item.id}/open`, { body: {} });
    assert.equal(recOpen.status, 200);
    assert.deepEqual(JSON.parse(recOpen.text), { ok: true }, "a recording's open stays { ok: true }");
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
    // Word-type documents become a preview on macOS (see below); elsewhere, and every other office
    // format anywhere, open with their default app.
    const office = ["x.doc", "x.docx", "x.xls", "x.xlsx", "x.ppt", "x.pptx", "x.odt", "x.ods", "x.odp", "x.rtf", "x.pages", "x.numbers", "x.key", "X.DOCX"];
    for (const platform of ["darwin", "linux"]) {
      t.setPlatform(platform);
      for (const name of office) {
        const id = t.download(name);
        const r = await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {} });
        assert.equal(r.status, 200, name);
        const opener = platform === "darwin" ? ["open", join(t.dl, name)] : ["xdg-open", join(t.dl, name)];
        if (platform === "darwin" && /\.(docx?|rtf|odt)$/i.test(name)) assert.deepEqual(JSON.parse(r.text), { opened: "preview" }, name);
        else assert.deepEqual(t.spawned.at(-1), opener, `${platform} ${name}`);
      }
    }
    t.setPlatform("darwin");
    const before = t.spawned.length;
    const rid = t.recordings.add({ path: t.file("notes.docx", "doc"), at: 1, ms: 2, size: 3 }).id;
    assert.equal((await request(t.view.port, "POST", `/${t.key}/recordings/${rid}/open`, { body: { confirm: true } })).status, 409, "a recording's id keeps its list");
    assert.equal(t.spawned.length, before);
    // Each opens: in the person's tab, as a preview there, or with its app (Playwright's Chromium
    // here: the codec types go to their app).
    const way = { "a.pdf": "tab", "a.png": "tab", "a.jpg": "tab", "a.jpeg": "tab", "a.gif": "tab", "a.webp": "tab", "a.heic": "app", "a.txt": "tab", "a.csv": "preview", "a.json": "tab", "a.md": "tab",
      "a.mp4": "app", "a.mov": "app", "a.webm": "tab", "a.m4v": "app", "a.mp3": "tab", "a.wav": "tab", "a.m4a": "app" };
    for (const [name, how] of Object.entries(way)) {
      const id = t.download(name);
      const tabsBefore = t.tabs.length;
      const r = await request(t.view.port, "POST", `/${t.key}/downloads/${id}/open`, { body: {} });
      assert.equal(r.status, 200, name);
      if (how === "app") { assert.deepEqual(JSON.parse(r.text), { ok: true, opened: "app" }, name); assert.deepEqual(t.spawned.at(-1), ["open", join(t.dl, name)], name); assert.equal(t.tabs.length, tabsBefore, name); }
      else { assert.deepEqual(JSON.parse(r.text), { opened: how }, name); assert.equal(t.tabs.length, tabsBefore + 1, name); }
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

test("a saved download keeps the browser's mark: copied across, never invented", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-mark-"));
  try {
    const from = join(dir, "from.pdf"), to = join(dir, "to.pdf");
    writeFileSync(from, "%PDF-1.4"); copyFileSync(from, to);
    // Fakes: the mark moves as read, and no mark on the source writes nothing.
    const wrote = [];
    assert.equal(await keepDownloadMark(from, to, { platform: "darwin", read: async () => "0081;1;PairBrowse;\n", write: async (p, v) => { wrote.push([p, v]); return true; } }), true);
    assert.deepEqual(wrote, [[to, "0081;1;PairBrowse;"]]);
    assert.equal(await keepDownloadMark(from, to, { platform: "darwin", read: async () => null, write: async () => { throw new Error("never"); } }), false);
    assert.equal(await keepDownloadMark(from, to, { platform: "linux" }), false);
    if (process.platform === "darwin") {
      // The real thing: Node's copy drops the attribute; keepDownloadMark brings it back.
      const { execFileSync } = await import("node:child_process");
      execFileSync("/usr/bin/xattr", ["-w", "com.apple.quarantine", "0081;1;PairBrowse;", from]);
      const copy = join(dir, "copy.pdf"); copyFileSync(from, copy);
      assert.equal(await downloadMarked(copy), false, "a plain copy loses the mark");
      assert.equal(await keepDownloadMark(from, copy), true);
      assert.equal(await downloadMarked(copy), true);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const post = (t, id, verb = "open", body = {}) => request(t.view.port, "POST", `/${t.key}/downloads/${id}/${verb}`, { body });

test("open: renderable types open in a person's tab; the codec types only in the macOS PairBrowse build", async () => {
  const t = await setup();
  const owner = await readStream(t.view.port, `/${t.key}/events?page=right`);
  try {
    await wait(50);
    const names = ["pdf", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "webm", "ogv", "mp3", "wav", "ogg", "oga", "opus", "flac", "txt", "md", "json"].flatMap((x) => [`a.${x}`, `B.${x.toUpperCase()}`]);
    for (const name of names) {
      const id = t.download(name);
      const before = t.spawned.length;
      const r = await post(t, id);
      assert.equal(r.status, 200, name);
      assert.deepEqual(JSON.parse(r.text), { opened: "tab" }, name);
      assert.equal(t.spawned.length, before, `${name}: nothing spawned`);
      assert.equal(t.tabs.at(-1)[0], pathToFileURL(join(t.dl, name)).href, name);
      assert.ok(!r.text.includes(t.dir), "no path in the answer");
    }
    // mp4, m4v, m4a: a tab only with the PairBrowse build on macOS.
    for (const [platform, engine, tab] of [["darwin", "pairbrowse", true], ["darwin", "chromium", false], ["darwin", null, false], ["linux", "pairbrowse", false], ["win32", "pairbrowse", false]]) {
      t.setPlatform(platform);
      t.setEngine(engine);
      for (const name of ["a.mp4", "a.m4v", "A.M4A"]) {
        const id = t.download(name);
        const tabs = t.tabs.length, spawned = t.spawned.length;
        const r = await post(t, id);
        assert.equal(r.status, 200, `${platform} ${engine} ${name}`);
        if (tab) { assert.deepEqual(JSON.parse(r.text), { opened: "tab" }); assert.equal(t.spawned.length, spawned); }
        else { assert.deepEqual(JSON.parse(r.text), { ok: true, opened: "app" }); assert.equal(t.tabs.length, tabs, `${platform} ${engine} ${name}: no tab`); assert.equal(t.spawned.length, spawned + 1); }
      }
    }
    t.setPlatform("darwin");
    t.setEngine("pairbrowse");
    // mov and aac: always their app.
    for (const name of ["a.mov", "a.aac"]) {
      const id = t.download(name);
      const tabs = t.tabs.length;
      assert.deepEqual(JSON.parse((await post(t, id)).text), { ok: true, opened: "app" }, name);
      assert.equal(t.tabs.length, tabs, name);
      assert.deepEqual(t.spawned.at(-1), ["open", join(t.dl, name)]);
    }
    // The checks come before any tab: the mark (409), a replaced file (410), a download in progress (409).
    const tabsNow = t.tabs.length;
    const unmarked = t.download("u.pdf");
    t.unmark(join(t.dl, "u.pdf"));
    assert.equal((await post(t, unmarked)).status, 409, "no mark");
    const replaced = t.download("r.pdf");
    writeFileSync(join(t.dl, "r.pdf.new"), "data");
    renameSync(join(t.dl, "r.pdf.new"), join(t.dl, "r.pdf"));
    assert.equal((await post(t, replaced)).status, 410, "replaced");
    const going = t.downloads.add({ name: "g.pdf", host: "shop.example" });
    assert.equal((await post(t, going)).status, 409, "in progress");
    assert.equal(t.tabs.length, tabsNow, "no tab before the checks pass");
    // A tab that can't open: 409 with its sentence, nothing spawned instead.
    t.failTabs();
    const spawned = t.spawned.length;
    const f = await post(t, t.download("f.pdf"));
    assert.equal(f.status, 409);
    assert.equal(JSON.parse(f.text).error, "The file couldn't be shown in a tab.");
    assert.equal(t.spawned.length, spawned);
    await wait(80);
    const events = rawEvents(owner.text(), ["downloads"]);
    assert.ok(events.length > 0 && !events.includes(t.dir) && !events.includes("file:"), "no path in the downloads events");
  } finally { owner.close(); t.done(); }
});

test("open: csv and log as an escaped text preview in the person's tab", async () => {
  const t = await setup();
  try {
    for (const name of ["a.csv", "b.log", "C.CSV"]) {
      const p = t.file(name, "x,<script>alert(1)</script>,&amp;\n2,3");
      const id = t.downloads.add({ name, host: "shop.example" });
      t.downloads.done(id, p);
      const r = await post(t, id);
      assert.equal(r.status, 200, name);
      assert.deepEqual(JSON.parse(r.text), { opened: "preview" });
      const [url, onClose] = t.tabs.at(-1);
      const out = fileURLToPath(url);
      assert.equal(dirname(out), t.previewDir);
      assert.match(out.slice(t.previewDir.length + 1), new RegExp(`^${id}-[0-9a-f]{8}\\.html$`), "the download's id and a random suffix: one file per tab");
      const html = readFileSync(out, "utf8");
      assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;") && !html.includes("<script"), "escaped");
      assert.ok(html.includes("&amp;amp;"), "an entity in the file shows as written");
      assert.match(html, /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/);
      assert.equal(statSync(out).mode & 0o777, 0o600);
      assert.equal(statSync(t.previewDir).mode & 0o777, 0o700);
      onClose();
      assert.ok(!existsSync(out), "closing the tab removes it");
    }
    assert.equal(t.spawned.length, 0);
    assert.equal(t.execs.length, 0, "no textutil for text");
  } finally { t.done(); }
});

test("open: documents on macOS become a sanitized textutil preview; elsewhere their app", async () => {
  const t = await setup();
  try {
    t.setDocHtml(`<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/"><link rel=stylesheet href="https://evil.example/x.css">
<style>p.p1 {margin: 0; font: 12px Helvetica}</style></head><body onload="x()"><p class="p1" onclick="x()">Hi <a href="javascript:alert(1)">link</a></p>
<script>alert(1)</script><iframe src="https://evil.example"></iframe><object data=x></object><form action="https://evil.example"><input name=q>Text</form><img src=x onerror=alert(1)><embed src=x></body></html>`);
    for (const name of ["a.docx", "b.doc", "c.rtf", "d.odt", "E.DOCX"]) {
      const id = t.download(name);
      const execs = t.execs.length;
      const r = await post(t, id);
      assert.equal(r.status, 200, name);
      assert.deepEqual(JSON.parse(r.text), { opened: "preview" }, name);
      assert.equal(t.execs.length, execs + 1, "textutil once");
      const { cmd, args, opts } = t.execs.at(-1);
      assert.equal(cmd, "/usr/bin/textutil");
      const raw = args[args.indexOf("-output") + 1];
      assert.deepEqual(args, ["-convert", "html", "-format", name.split(".").pop().toLowerCase(), "-noload", "-nostore", "-strip", "-output", raw, "--", join(t.dl, name)]);
      assert.equal(opts.shell, undefined, "no shell");
      assert.equal(opts.timeout, 300);
      assert.ok(raw.startsWith(t.previewDir) && raw.endsWith(".textutil.html"));
      assert.ok(!existsSync(raw), "the temporary output is gone");
      const out = fileURLToPath(t.tabs.at(-1)[0]);
      assert.equal(dirname(out), t.previewDir);
      assert.match(out.slice(t.previewDir.length + 1), new RegExp(`^${id}-[0-9a-f]{8}\\.html$`));
      const html = readFileSync(out, "utf8");
      assert.match(html, /^<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/);
      for (const bad of [/<script/i, /\son\w+=/i, /href/i, /javascript:/i, /<form/i, /<iframe/i, /<object/i, /<embed/i, /<base/i, /<link/i, /http-equiv="refresh"/i]) assert.doesNotMatch(html, bad, `${name}: ${bad}`);
      assert.ok(html.includes(`<strong>${name}</strong>`) && html.includes("Read-only preview. To edit, use Open in Word in PairBrowse's Downloads."));
      assert.ok(html.includes("<a>link</a>") && html.includes("Text"), "text kept");
      assert.ok(!html.includes(t.key) && !html.includes(t.view.pagesKey), "no key in the file");
      assert.equal(statSync(out).mode & 0o777, 0o600);
      assert.equal(statSync(t.previewDir).mode & 0o777, 0o700);
      t.tabs.at(-1)[1]();
      assert.ok(!existsSync(out), "closing the tab removes it");
    }
    // textutil wrote nothing, or never answered: 409 with the sentence, no tab, nothing left.
    for (const html of [null, "hang"]) {
      t.setDocHtml(html);
      const id = t.download(`z${html}.docx`);
      const tabs = t.tabs.length;
      const r = await post(t, id);
      assert.equal(r.status, 409, String(html));
      assert.equal(JSON.parse(r.text).error, "PairBrowse couldn't make a preview of this document. Use Open in Word to open it in its app.");
      assert.equal(t.tabs.length, tabs, "no tab");
      assert.deepEqual(readdirSync(t.previewDir), [], "nothing left in previews/");
    }
    // A tab that can't open: the preview goes too.
    t.setDocHtml("<p>x</p>");
    t.failTabs();
    assert.equal((await post(t, t.download("y.docx"))).status, 409);
    assert.deepEqual(readdirSync(t.previewDir), []);
    t.failTabs(false);
    // Linux and Windows: their app, no textutil.
    for (const platform of ["linux", "win32"]) {
      t.setPlatform(platform);
      const execs = t.execs.length;
      const id = t.download(`w-${platform}.docx`);
      assert.deepEqual(JSON.parse((await post(t, id)).text), { ok: true, opened: "app" }, platform);
      assert.equal(t.execs.length, execs);
    }
    // clear(): the folder stays, emptied.
    writeFileSync(join(t.previewDir, "left.html"), "x");
    t.previews.clear();
    assert.ok(existsSync(t.previewDir));
    assert.deepEqual(readdirSync(t.previewDir), []);
  } finally { t.done(); }
});

test("open-app: documents only, with their app, after the same checks", async () => {
  const t = await setup();
  try {
    const id = t.download("plan.docx");
    const r = await post(t, id, "open-app");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { ok: true, opened: "app" });
    assert.deepEqual(t.spawned.at(-1), ["open", join(t.dl, "plan.docx")]);
    for (const name of ["a.doc", "a.rtf", "a.odt", "A.DOCX"]) assert.equal((await post(t, t.download(name), "open-app")).status, 200, name);
    const spawned = t.spawned.length;
    const pdf = await post(t, t.download("a.pdf"), "open-app");
    assert.equal(pdf.status, 409);
    assert.equal(JSON.parse(pdf.text).error, "Open in Word is for documents (.doc, .docx, .rtf, .odt). Use Open.");
    const unmarked = t.download("u.docx");
    t.unmark(join(t.dl, "u.docx"));
    assert.equal((await post(t, unmarked, "open-app")).status, 409, "no mark");
    const replaced = t.download("r.docx");
    writeFileSync(join(t.dl, "r.docx.new"), "data");
    renameSync(join(t.dl, "r.docx.new"), join(t.dl, "r.docx"));
    assert.equal((await post(t, replaced, "open-app")).status, 410, "replaced");
    assert.equal((await post(t, "0123456789ab", "open-app")).status, 404, "unknown id");
    const rid = t.recordings.add({ path: t.file("rec.docx", "d"), at: 1, ms: 1, size: 1 }).id;
    assert.equal((await request(t.view.port, "POST", `/${t.key}/recordings/${rid}/open-app`, { body: {} })).status, 404, "recordings have no open-app");
    assert.equal(t.spawned.length, spawned);
    assert.equal(t.tabs.length, 0);
  } finally { t.done(); }
});

test("confirm wording by kind; openWay's choices", async () => {
  const { confirmFor, openWay, PROGRAMS, WEB_FILES } = await import("../scripts/daemon/tools.mjs");
  for (const x of ["html", "htm", "xhtml", "svg", "svgz", "shtml", "mht", "mhtml", "webarchive", "url", "webloc", "inetloc"]) {
    assert.equal(confirmFor(`a.${x}`), "This is a web page saved to your computer. It opens in your web browser and can run its own scripts. Open it anyway?", x);
    assert.ok(PROGRAMS.has(x) && WEB_FILES.has(x));
  }
  for (const x of ["sh", "pkg", "app", "command", "exe", "ps1"]) assert.equal(confirmFor(`a.${x}`), "This is a program or script. Open it anyway?", x);
  for (const x of ["pdf", "docx", "zip", "csv"]) assert.equal(confirmFor(`a.${x}`), null, x);
  const all = { tab: true, preview: true, platform: "darwin", engine: "pairbrowse", size: 10 };
  assert.equal(openWay("a.pdf", all), "tab");
  assert.equal(openWay("a.pdf", { ...all, tab: false }), "app");
  assert.equal(openWay("a.csv", { ...all, size: 10 * 1024 * 1024 + 1 }), "app", "too big for a text preview");
  assert.equal(openWay("a.docx", { ...all, size: 50 * 1024 * 1024 + 1 }), "app", "too big for a document preview");
  assert.equal(openWay("a.docx", { ...all, preview: false }), "app");
  assert.equal(openWay("a.docx", all), "document");
  assert.equal(openWay("a.log", all), "text");
  assert.equal(openWay("a.html", all), "app");
});

test("the person's tab: the owner's lists mark it personal; guests never list, pick, close or type into it", async () => {
  const t = await setup();
  const person = Object.assign(fakePage("file:///Users/x/Downloads/note.txt", "note.txt PB-PERSON-ONLY"), { async close() { this.closed = true; } });
  t.pages.push(person);
  t.personTabs.add(person);
  const w = t.invites.create({ role: "watch", label: "W" });
  const d = t.invites.create({ role: "drive", label: "D" });
  const guest = await readStream(t.view.port, `/${w.key}/events`);
  try {
    const owner = JSON.parse((await request(t.view.port, "GET", `/${t.key}/state.json`)).text).tabs;
    assert.deepEqual(owner.map((x) => !!x.personal), [false, false, true]);
    assert.ok(!("personal" in owner[0]), "only set when true");
    const strip = JSON.parse((await request(t.view.port, "GET", `/${t.key}/tabs.json`)).text);
    assert.equal(strip.find((x) => x.i === 2)?.personal, true);
    for (const k of [w.key, d.key]) {
      const tabs = JSON.parse((await request(t.view.port, "GET", `/${k}/state.json`)).text).tabs;
      assert.deepEqual(tabs.map((x) => x.i), [0, 1], "a guest's list leaves it out");
    }
    await wait(80);
    const streamed = eventsIn(guest.text(), "tabs");
    assert.ok(streamed.length && streamed.every((list) => list.every((x) => x.i !== 2)), "the invite stream's tabs leave it out");
    assert.ok(!guest.text().includes("PB-PERSON-ONLY") && !guest.text().includes("file:"));
    // A drive guest picking or closing it: nothing happens.
    for (const ev of [{ i: 2 }, { close: 2 }]) assert.equal((await request(t.view.port, "POST", `/${d.key}/tab`, { body: ev })).status, 204, JSON.stringify(ev));
    await wait(50);
    assert.equal(person.closed, false, "not closed");
    assert.equal(person.fronted, 0, "not brought forward");
    const after = JSON.parse((await request(t.view.port, "GET", `/${t.key}/state.json`)).text).tabs;
    assert.equal(after.find((x) => x.i === 2).shown, false, "not shown");
  } finally { guest.close(); t.done(); }
});

test("a document preview's tab tells the owner which download it shows (preview), never guests; a text preview's doesn't", async () => {
  const t = await setup();
  const opened = [];
  const real = t.tools.openTab;
  t.tools.openTab = async (url, onClose) => {
    await real(url, onClose);
    const page = Object.assign(fakePage(url, "preview"), { async close() { this.closed = true; } });
    t.pages.push(page);
    t.personTabs.add(page);
    opened.push(page);
    return { ok: true, page };
  };
  const w = t.invites.create({ role: "watch", label: "W" });
  try {
    const doc = t.download("plan.docx");
    assert.deepEqual(JSON.parse((await post(t, doc)).text), { opened: "preview" });
    const p = t.file("a.csv", "a,b");
    const csv = t.downloads.add({ name: "a.csv", host: "shop.example" });
    t.downloads.done(csv, p);
    assert.deepEqual(JSON.parse((await post(t, csv)).text), { opened: "preview" });
    const strip = JSON.parse((await request(t.view.port, "GET", `/${t.key}/tabs.json`)).text);
    assert.deepEqual(strip.find((x) => x.i === 2)?.preview, { id: doc, kind: "document" }, "the document's tab");
    assert.equal(strip.find((x) => x.i === 3)?.personal, true);
    assert.ok(!("preview" in strip.find((x) => x.i === 3)), "a text preview has no Open in Word");
    const owner = JSON.parse((await request(t.view.port, "GET", `/${t.key}/state.json`)).text).tabs;
    assert.deepEqual(owner.find((x) => x.i === 2)?.preview, { id: doc, kind: "document" });
    const guest = (await request(t.view.port, "GET", `/${w.key}/state.json`)).text;
    assert.ok(!guest.includes(doc) && !guest.includes("preview\""), "guests never get it");
  } finally { for (const p of opened) p.closed = true; t.done(); }
});
