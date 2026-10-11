// The session's timeline (scripts/daemon/timeline.mjs): the pictures already sent to agents,
// kept per session in a folder, capped with pins kept, notes, deletion, off by one switch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTimeline } from "../scripts/daemon/timeline.mjs";

const folder = () => join(mkdtempSync(join(tmpdir(), "pb-timeline-")), "timeline");
const jpeg = (n) => Buffer.from([0xff, 0xd8, 0xff, n & 0xff, (n >> 8) & 0xff]).toString("base64");
const jpgs = (dir) => readdirSync(dir).filter((f) => f.endsWith(".jpg"));
const index = (dir) => JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));

test("a picture is written once, with a masked caption, who and the goal log's step", async () => {
  const dir = folder();
  let t = 1000;
  const tl = createTimeline({ dir: () => dir, mask: (s) => s.replaceAll("hunter2", "••••"), step: () => ({ url: "https://a.example/form", title: "Form" }), now: () => t++ });
  await tl.record({ data: jpeg(1), caption: "Typed hunter2 into Password", who: "Ada · Claude Code" });
  await tl.record({ data: jpeg(2), caption: "Clicked Continue", who: "Ada · Claude Code" });
  const cards = tl.cards();
  assert.equal(cards.length, 2);
  assert.equal(cards[0].caption, "Typed •••• into Password");
  assert.equal(cards[1].caption, "Clicked Continue", "newest last");
  assert.match(cards[0].id, /^[0-9a-f]{12}$/);
  assert.deepEqual({ ...cards[0], id: "" }, { id: "", t: 1000, caption: "Typed •••• into Password", step: { url: "https://a.example/form", title: "Form" }, who: "Ada · Claude Code", pinned: false, note: false });
  assert.deepEqual(readFileSync(join(dir, `${cards[0].id}.jpg`)), Buffer.from(jpeg(1), "base64"));
  assert.deepEqual(await tl.picture(cards[1].id), Buffer.from(jpeg(2), "base64"));
  assert.doesNotMatch(readFileSync(join(dir, "index.json"), "utf8"), /hunter2/);
  assert.equal(index(dir).cards.length, 2);
});

test("past the cap the oldest unpinned go first; pinned ones stay, at most pinMax of them", async () => {
  const dir = folder();
  const tl = createTimeline({ dir: () => dir, cap: 200, pinMax: 3 });
  for (let i = 0; i < 205; i++) await tl.record({ data: jpeg(i), caption: `p${i}`, who: "A" });
  let cards = tl.cards();
  assert.equal(cards.length, 200);
  assert.equal(jpgs(dir).length, 200);
  assert.equal(cards[0].caption, "p5", "the five oldest are gone");

  const dir2 = folder();
  const tl2 = createTimeline({ dir: () => dir2, cap: 200, pinMax: 3 });
  for (let i = 0; i < 3; i++) await tl2.record({ data: jpeg(i), caption: `p${i}`, who: "A" });
  const first = tl2.cards();
  for (const c of first) assert.equal((await tl2.pin(c.id, true)).pinned, true);
  for (let i = 3; i < 206; i++) await tl2.record({ data: jpeg(i), caption: `p${i}`, who: "A" });
  cards = tl2.cards();
  assert.equal(cards.length, 203);
  assert.equal(jpgs(dir2).length, 203);
  assert.deepEqual(cards.slice(0, 3).map((c) => c.caption), ["p0", "p1", "p2"], "pinned cards stay past the cap");
  assert.equal(cards[3].caption, "p6");
  const r = await tl2.pin(cards[10].id, true);
  assert.ok(r.error, "no more than pinMax pins");
  assert.equal((await tl2.pin(first[0].id, false)).pinned, false, "unpinning works");
});

test("a note is a card without a picture, said in the bar once; empty or long notes are refused", async () => {
  const dir = folder();
  const said = [];
  const tl = createTimeline({ dir: () => dir, onNote: (text) => said.push(text) });
  const card = await tl.note("  Check the VAT field ");
  assert.equal(card.note, true);
  assert.equal(card.caption, "Check the VAT field");
  assert.deepEqual(said, ["Check the VAT field"]);
  assert.equal(jpgs(dir).length, 0);
  assert.equal(await tl.picture(card.id), null);
  assert.ok((await tl.note("")).error);
  assert.ok((await tl.note("   ")).error);
  assert.ok((await tl.note("x".repeat(201))).error);
  assert.equal(said.length, 1);
  assert.equal(tl.cards().length, 1);
  const masked = createTimeline({ dir: () => dir, mask: (s) => s.replaceAll("hunter2", "••••"), onNote: (text) => said.push(text) });
  await masked.note("Password is hunter2");
  assert.equal(said.at(-1), "Password is ••••", "the bar gets the masked note");
  assert.ok(!readFileSync(join(dir, "index.json"), "utf8").includes("hunter2"));
});

test("remove deletes the file and the card; malformed ids touch nothing", async () => {
  const dir = folder();
  const tl = createTimeline({ dir: () => dir });
  await tl.record({ data: jpeg(1), caption: "a", who: "A" });
  await tl.record({ data: jpeg(2), caption: "b", who: "A" });
  const [a] = tl.cards();
  assert.equal(await tl.remove(a.id), true);
  assert.equal(existsSync(join(dir, `${a.id}.jpg`)), false);
  assert.deepEqual(tl.cards().map((c) => c.caption), ["b"]);
  for (const bad of ["../x", "zz", "0123456789ab", a.id, "../index"]) assert.equal(await tl.remove(bad), false, bad);
  assert.equal(await tl.picture("../index"), null);
  assert.equal(await tl.picture("../index.json"), null);
  assert.equal(jpgs(dir).length, 1);
  assert.ok(existsSync(join(dir, "index.json")));
});

test("timeline: false writes nothing and answers nothing", async () => {
  const dir = folder();
  const said = [];
  const tl = createTimeline({ dir: () => dir, enabled: false, onNote: (t) => said.push(t) });
  assert.equal(tl.enabled, false);
  await tl.record({ data: jpeg(1), caption: "a", who: "A" });
  assert.equal(existsSync(dir), false, "no folder");
  assert.equal(tl.cards(), null);
  assert.ok((await tl.note("hi")).error);
  assert.ok((await tl.remove("0123456789ab")).error);
  assert.ok((await tl.pin("0123456789ab", true)).error);
  assert.equal(await tl.picture("0123456789ab"), null);
  assert.deepEqual(said, []);
});

test("a restart keeps the cards and pictures; a corrupt index reads as empty", async () => {
  const dir = folder();
  const tl = createTimeline({ dir: () => dir });
  await tl.record({ data: jpeg(7), caption: "kept", who: "A" });
  const [card] = tl.cards();
  const again = createTimeline({ dir: () => dir });
  assert.deepEqual(again.cards(), [card]);
  assert.deepEqual(await again.picture(card.id), Buffer.from(jpeg(7), "base64"));

  const broken = folder();
  mkdirSync(broken, { recursive: true });
  writeFileSync(join(broken, "index.json"), "{ not json");
  const logged = [];
  const tl2 = createTimeline({ dir: () => broken, log: (...a) => logged.push(a.join(" ")) });
  assert.deepEqual(tl2.cards(), []);
  assert.equal(logged.length, 1);
  await tl2.record({ data: jpeg(1), caption: "fresh", who: "A" });
  assert.equal(tl2.cards().length, 1);
});

test("a session switch lists that session's folder", async () => {
  const a = folder(), b = folder();
  let dir = a;
  const tl = createTimeline({ dir: () => dir });
  await tl.record({ data: jpeg(1), caption: "in a", who: "A" });
  dir = b;
  assert.deepEqual(tl.cards(), []);
  await tl.record({ data: jpeg(2), caption: "in b", who: "A" });
  assert.deepEqual(tl.cards().map((c) => c.caption), ["in b"]);
  dir = a;
  assert.deepEqual(tl.cards().map((c) => c.caption), ["in a"]);
});

test("onChange fires once per record, remove, pin and note, with the card", async () => {
  const dir = folder();
  const tl = createTimeline({ dir: () => dir });
  const seen = [];
  const off = tl.onChange((c) => seen.push([c.op, c.card.caption]));
  await tl.record({ data: jpeg(1), caption: "a", who: "A" });
  const [card] = tl.cards();
  await tl.pin(card.id, true);
  await tl.note("n");
  await tl.remove(card.id);
  assert.deepEqual(seen, [["add", "a"], ["pin", "a"], ["add", "n"], ["remove", "a"]]);
  off();
  await tl.note("m");
  assert.equal(seen.length, 4);
});

test("a burst of records lands in order, each with its file", async () => {
  const dir = folder();
  const tl = createTimeline({ dir: () => dir });
  await Promise.all(Array.from({ length: 20 }, (_, i) => tl.record({ data: jpeg(i), caption: `b${i}`, who: "A" })));
  assert.deepEqual(tl.cards().map((c) => c.caption), Array.from({ length: 20 }, (_, i) => `b${i}`));
  assert.deepEqual(index(dir).cards.map((c) => c.caption), tl.cards().map((c) => c.caption));
  assert.equal(jpgs(dir).length, 20);
});
