// What live view guests see of the host's tab (liveview/guest-frames.mjs): each frame with its card
// fields covered first, never one that couldn't be, never a person's own tab; the newest waits
// while one is covered, those in between dropped.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createGuestFrames } from "../scripts/liveview/guest-frames.mjs";
import { sleep } from "./helpers/util.mjs";

const stream = () => ({ writableLength: 0, destroyed: false, out: [], write(s) { this.out.push(JSON.parse(s.split("\ndata: ")[1])); } });

test("guests get each frame covered, nothing when it can't be, nothing of a person's tab; the owner's streams are left alone", async () => {
  const guest = stream(), owner = stream();
  const viewers = new Set([guest, owner]);
  const linkGuests = new Map([[guest, { id: "i1" }]]);
  const page = {}, mine = {};
  const wanted = [];
  let answer = (data) => `covered:${data}`;
  const covers = { want: (fn) => wanted.push(fn), picture: async (_p, data) => answer(data) };
  const g = createGuestFrames({ covers, viewers, linkGuests, shownPage: () => page, personTab: (p) => p === mine });
  assert.deepEqual(wanted.map((fn) => fn()), [[page]], "the shown tab's covers are kept fresh while a guest is there");
  g.frame({ img: "A", w: 10, h: 10 }, page);
  await sleep(10);
  assert.deepEqual(guest.out, [{ img: "covered:A", w: 10, h: 10 }]);
  assert.deepEqual(owner.out, []);
  answer = () => null;
  g.frame({ img: "B", w: 10, h: 10 }, page);
  await sleep(10);
  assert.equal(guest.out.length, 1, "not covered: not sent");
  answer = (data) => data;
  g.frame({ img: "C", w: 10, h: 10 }, mine);
  await sleep(10);
  assert.equal(guest.out.length, 1, "a person's own tab: never");
  assert.deepEqual(await g.coverFrame({ img: "D" }, null), null, "no page: unknown, not sent");
  assert.equal(await g.coverImage(page, "E"), "E");
  linkGuests.clear();
  assert.deepEqual(wanted[0](), [], "no guests: nothing wanted");
});

test("while one frame is covered the newest waits; the ones in between are dropped", async () => {
  const guest = stream();
  const viewers = new Set([guest]);
  const linkGuests = new Map([[guest, {}]]);
  const page = {};
  const covers = { want: () => {}, picture: async (_p, data) => { await sleep(30); return data; } };
  const g = createGuestFrames({ covers, viewers, linkGuests, shownPage: () => page, personTab: () => false });
  for (const img of ["1", "2", "3", "4"]) g.frame({ img }, page);
  await sleep(150);
  assert.deepEqual(guest.out.map((f) => f.img), ["1", "4"]);
});

test("without covers (no helper behind the live view) frames pass as they are", async () => {
  const guest = stream();
  const g = createGuestFrames({ viewers: new Set([guest]), linkGuests: new Map([[guest, {}]]), shownPage: () => null, personTab: () => false });
  g.frame({ img: "Z" }, {});
  await sleep(10);
  assert.deepEqual(guest.out, [{ img: "Z" }]);
});
