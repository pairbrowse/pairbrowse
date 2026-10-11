import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
