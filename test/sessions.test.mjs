import "./helpers/home.mjs";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PAIRBROWSE_HOME = mkdtempSync(join(tmpdir(), "pb-sessions-"));
const s = await import("../scripts/sessions.mjs");
const { readSavedTabs } = await import("../scripts/tabs.mjs");

test("session names are safe folder names", () => {
  for (const ok of ["default", "replybay", "client-x", "Client_2"]) assert.equal(s.validName(ok), true, ok);
  for (const bad of ["", "../x", "a/b", ".hidden", "-x", "x".repeat(41), "a b"]) assert.equal(s.validName(bad), false, bad);
});

test("clean sessions are throwaway and never remembered", () => {
  s.createSession("clean-123");
  s.createSession("client-x");
  s.rememberSession("clean-123");
  assert.equal(s.currentSession(), "default", "a throwaway session isn't remembered");
  s.rememberSession("client-x");
  assert.equal(s.currentSession(), "client-x");
  s.sweepTemporary();
  assert.deepEqual(s.listSessions().map((x) => x.name).sort(), ["client-x", "default"]);
  assert.throws(() => s.deleteSession("default"));
});

test("who used a session: names and kinds only, newest first, deduplicated and capped", () => {
  s.createSession("people-x");
  s.recordPerson("people-x", { who: "You", computer: "Mac", kind: "you" }, 1);
  s.recordPerson("people-x", { who: "Alice", app: "Claude Code", computer: "Linux", kind: "guest", url: "https://secret.example/" }, 2);
  s.recordPerson("people-x", { who: "You", computer: "Mac", kind: "you" }, 3);
  const people = s.readPeople("people-x");
  assert.deepEqual(people.map((p) => p.who), ["You", "Alice"]);
  assert.equal(people[0].at, 3);
  assert.ok(!("url" in people[1]));
  for (let i = 0; i < 20; i++) s.recordPerson("people-x", { who: `P${i}`, kind: "agent" });
  assert.equal(s.readPeople("people-x").length, 12);
  s.recordPerson("clean-9", { who: "You", kind: "you" });
  assert.deepEqual(s.readPeople("clean-9"), [], "throwaway sessions keep nothing");
  mkdirSync(s.timelineDir("people-x"), { recursive: true });
  writeFileSync(join(s.timelineDir("people-x"), "index.json"), "{\"cards\":[]}");
  s.deleteSession("people-x");
  assert.deepEqual(s.readPeople("people-x"), []);
  assert.equal(existsSync(s.timelineDir("people-x")), false, "the timeline goes with the session");
});

test("a session's timeline folder sits beside its files, never listed as a session", () => {
  assert.equal(s.timelineDir("default"), join(process.env.PAIRBROWSE_HOME, "timeline"));
  assert.ok(s.timelineDir("x").endsWith(join("sessions", "x.timeline")));
  s.createSession("tl-y");
  mkdirSync(s.timelineDir("tl-y"), { recursive: true });
  assert.ok(!s.listSessions().some((x) => x.name.includes("timeline")), "a <name>.timeline folder isn't a session");
  assert.ok(s.listSessions().some((x) => x.name === "tl-y"));
  s.deleteSession("tl-y");
  assert.equal(existsSync(s.timelineDir("tl-y")), false);
});

test("saved tabs keep their order and only web pages", () => {
  const f = join(process.env.PAIRBROWSE_HOME, "t.json");
  writeFileSync(f, JSON.stringify({ tabs: [{ url: "https://a.test/" }, { url: "chrome://settings" }, { url: "file:///etc/passwd" }, { url: "http://b.test/" }], active: 9 }));
  const { tabs, active } = readSavedTabs(f);
  assert.deepEqual(tabs.map((t) => t.url), ["https://a.test/", "http://b.test/"]);
  assert.equal(active, 1, "active index is clamped");
  assert.deepEqual(readSavedTabs(join(process.env.PAIRBROWSE_HOME, "missing.json")).tabs, []);
});

test("renaming a session moves its profile, tabs, people and timeline; refusals move nothing", () => {
  s.createSession("ren-a");
  writeFileSync(s.tabsFile("ren-a"), JSON.stringify({ tabs: [{ url: "https://a.test/" }] }));
  s.recordPerson("ren-a", { who: "You", kind: "you" });
  mkdirSync(s.timelineDir("ren-a"), { recursive: true });
  writeFileSync(join(s.timelineDir("ren-a"), "index.json"), "{\"cards\":[]}");
  s.rememberSession("ren-a");
  s.renameSession("ren-a", "ren-b");
  for (const of of [s.profileDir, s.tabsFile, s.peopleFile, s.timelineDir]) {
    assert.equal(existsSync(of("ren-a")), false, `${of.name} left the old name`);
    assert.equal(existsSync(of("ren-b")), true, `${of.name} has the new name`);
  }
  assert.equal(readFileSync(join(process.env.PAIRBROWSE_HOME, "session"), "utf8"), "ren-b", "the remembered session follows");
  assert.equal(s.listSessions().find((x) => x.name === "ren-b").tabs, 1);
  s.createSession("ren-c");
  for (const [from, to, why] of [["default", "x1", /default session keeps its name/], ["clean-77", "x2", /clean session/], ["ren-b", "../x", /letters, numbers/], ["ren-b", "a b", /letters, numbers/],
    ["ren-b", "clean-5", /keeps for itself/], ["ren-b", "default", /keeps for itself/], ["ren-b", "ren-c", /already exists/], ["ren-b", "REN-C", /already exists/], ["nope-zz", "x3", /No session/]]) {
    if (from === "clean-77") s.createSession(from);
    assert.throws(() => s.renameSession(from, to), why, `${from} -> ${to}`);
  }
  assert.equal(existsSync(s.profileDir("ren-b")), true, "refusals moved nothing");
  s.deleteSession("clean-77");
  // A case-only rename of the same session works.
  s.renameSession("ren-b", "Ren-B");
  assert.ok(s.listSessions().some((x) => x.name === "Ren-B"));
  assert.ok(!s.listSessions().some((x) => x.name === "ren-b"));
});

test("a rename never moves onto files of that name the session list doesn't show", () => {
  s.createSession("orph-a");
  writeFileSync(s.tabsFile("orph-a"), "{\"tabs\":[]}");
  for (const of of [s.tabsFile, s.peopleFile]) {
    writeFileSync(of("orph-b"), "{\"kept\":true}");
    assert.throws(() => s.renameSession("orph-a", "orph-b"), /already exists/, of.name);
    assert.equal(readFileSync(of("orph-b"), "utf8"), "{\"kept\":true}", `the orphan ${of.name} isn't overwritten`);
    rmSync(of("orph-b"));
  }
  mkdirSync(s.timelineDir("orph-b"), { recursive: true });
  assert.throws(() => s.renameSession("orph-a", "orph-b"), /already exists/, "an orphan timeline");
  rmSync(s.timelineDir("orph-b"), { recursive: true });
  assert.equal(existsSync(s.profileDir("orph-a")), true, "refusals moved nothing");
  s.renameSession("orph-a", "orph-b");
  assert.equal(existsSync(s.profileDir("orph-b")), true);
});

test("a rename whose move fails puts back what it moved", () => {
  s.createSession("rb-x");
  writeFileSync(s.tabsFile("rb-x"), "{\"tabs\":[]}");
  mkdirSync(s.timelineDir("rb-x"), { recursive: true });
  // The timeline's move fails after the others (a stray folder of the new name is refused before
  // any move now, so the failure is made here).
  const real = fs.renameSync;
  const failing = mock.method(fs, "renameSync", (from, to) => { if (String(to) === s.timelineDir("rb-y")) throw new Error("EBUSY: in use"); return real(from, to); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => s.renameSession("rb-x", "rb-y"), /Couldn't rename/);
  } finally { failing.mock.restore(); syncBuiltinESMExports(); }
  for (const of of [s.profileDir, s.tabsFile, s.timelineDir]) assert.equal(existsSync(of("rb-x")), true, `${of.name} put back`);
  assert.equal(existsSync(s.profileDir("rb-y")), false);
  assert.equal(existsSync(s.tabsFile("rb-y")), false);
});

test("rename and delete move network.json and the map entry (C4); a config.json that can't be read stops both", () => {
  const cfg = join(process.env.PAIRBROWSE_HOME, "config.json");
  const other = { participantName: "Pat", network: { proxies: { "us-east": { server: "http://203.0.113.10:3128" } }, default: null, sessions: { "net-a": "us-east", "keep-me": null }, strict: true } };
  writeFileSync(cfg, JSON.stringify(other));
  s.createSession("net-a");
  writeFileSync(s.networkFile("net-a"), "{\"version\":1,\"checks\":[]}");
  s.renameSession("net-a", "net-b");
  assert.equal(existsSync(s.networkFile("net-a")), false, "network.json left the old name");
  assert.equal(readFileSync(s.networkFile("net-b"), "utf8"), "{\"version\":1,\"checks\":[]}", "and has the new one");
  let saved = JSON.parse(readFileSync(cfg, "utf8"));
  assert.deepEqual(saved.network.sessions, { "net-b": "us-east", "keep-me": null }, "the map entry follows the session");
  assert.equal(saved.participantName, "Pat", "everything else in config.json kept");
  assert.deepEqual(saved.network.proxies, other.network.proxies);
  // A stray network.json under a name blocks a rename onto it, like the session's other files.
  s.createSession("net-c");
  writeFileSync(s.networkFile("net-d"), "{}");
  assert.throws(() => s.renameSession("net-c", "net-d"), /already exists/);
  rmSync(s.networkFile("net-d"));
  // A config.json that can't be parsed: nothing renamed or deleted, and it is never rewritten.
  writeFileSync(cfg, "{ not json");
  assert.throws(() => s.renameSession("net-b", "net-e"), /wasn't renamed: config\.json isn't valid JSON.*proxy choice/);
  assert.equal(existsSync(s.profileDir("net-b")), true);
  assert.equal(existsSync(s.networkFile("net-b")), true);
  assert.throws(() => s.deleteSession("net-b"), /wasn't deleted: config\.json/);
  assert.equal(existsSync(s.profileDir("net-b")), true, "kept whole");
  assert.equal(readFileSync(cfg, "utf8"), "{ not json", "never rewritten");
  // A clean session's deletion (at a switch, at startup) never fails on config.json.
  s.createSession("clean-4242");
  s.deleteSession("clean-4242");
  assert.equal(existsSync(s.profileDir("clean-4242")), false);
  // No config.json, or one without a map: rename and delete go on, writing nothing.
  rmSync(cfg);
  s.renameSession("net-c", "net-f");
  assert.equal(existsSync(cfg), false, "nothing to follow: no config.json written");
  writeFileSync(cfg, JSON.stringify(other));
  // Deleted: the files and the map entry go.
  s.deleteSession("net-b");
  assert.equal(existsSync(s.networkFile("net-b")), false);
  saved = JSON.parse(readFileSync(cfg, "utf8"));
  assert.deepEqual(saved.network.sessions, { "net-a": "us-east", "keep-me": null }, "only that session's entry changed (net-b had none in this file)");
  s.createSession("net-a");
  s.deleteSession("net-a");
  assert.deepEqual(JSON.parse(readFileSync(cfg, "utf8")).network.sessions, { "keep-me": null }, "its entry goes with it");
  s.deleteSession("net-f");
  rmSync(cfg);
});

test("pairbrowse_session delete answers a config.json that can't be read and keeps the session whole", async () => {
  const { createSwitch } = await import("../scripts/daemon/sessions/switch.mjs");
  const cfg = join(process.env.PAIRBROWSE_HOME, "config.json");
  s.createSession("del-x");
  writeFileSync(s.networkFile("del-x"), "{\"version\":1,\"checks\":[]}");
  writeFileSync(cfg, "{ not json");
  const st = { session: "default", switching: false, contextPromise: null, pick: { state: "idle" } };
  const noop = () => {};
  const sw = createSwitch(st, { beforeRename: async () => {}, hostNote: noop, log: noop, notify: noop, onRenamed: noop }, {});
  const out = await sw.sessionCommand({ action: "delete", name: "del-x" });
  assert.equal(out.error, true, "answered as an error, not thrown");
  assert.match(out.text, /^Session "del-x" wasn't deleted: config\.json isn't valid JSON/);
  assert.equal(existsSync(s.profileDir("del-x")), true, "the profile kept");
  assert.equal(existsSync(s.networkFile("del-x")), true, "network.json kept");
  assert.equal(readFileSync(cfg, "utf8"), "{ not json", "config.json never rewritten");
  rmSync(cfg);
  s.deleteSession("del-x");
});

test("a rename whose move fails puts the map entry back too", () => {
  const cfg = join(process.env.PAIRBROWSE_HOME, "config.json");
  writeFileSync(cfg, JSON.stringify({ network: { proxies: {}, sessions: { "mv-x": null } } }));
  s.createSession("mv-x");
  writeFileSync(s.networkFile("mv-x"), "{}");
  const real = fs.renameSync;
  const failing = mock.method(fs, "renameSync", (from, to) => { if (String(to) === s.networkFile("mv-y")) throw new Error("EBUSY: in use"); return real(from, to); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => s.renameSession("mv-x", "mv-y"), /Couldn't rename/);
  } finally { failing.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(existsSync(s.profileDir("mv-x")), true, "the profile put back");
  assert.equal(existsSync(s.networkFile("mv-x")), true);
  assert.deepEqual(JSON.parse(readFileSync(cfg, "utf8")).network.sessions, { "mv-x": null }, "the map entry put back");
  s.deleteSession("mv-x");
  rmSync(cfg);
});

test("profileInUse: a live SingletonLock on this computer or another counts; one a gone process left doesn't", () => {
  s.createSession("lock-a");
  const dir = s.profileDir("lock-a");
  assert.equal(s.profileInUse("lock-a"), false, "no lock");
  fs.symlinkSync("here-4242", join(dir, "SingletonLock"));
  assert.equal(s.profileInUse("lock-a", { host: "here", alive: (pid) => pid === 4242 }), true, "a live process here");
  assert.equal(s.profileInUse("lock-a", { host: "here", alive: () => false }), false, "a gone process here");
  assert.equal(s.profileInUse("lock-a", { host: "elsewhere", alive: () => false }), true, "another computer's lock");
  rmSync(join(dir, "SingletonLock"));
  mkdirSync(join(dir, "pairbrowse-native"));
  fs.symlinkSync("garbled", join(dir, "pairbrowse-native", "SingletonLock"));
  assert.equal(s.profileInUse("lock-a", { host: "here", alive: () => false }), true, "the native profile's lock, unreadable: in use");
  assert.equal(s.profileInUse("no-such-session"), false);
});
