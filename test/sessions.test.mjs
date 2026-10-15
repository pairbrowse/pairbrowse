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
