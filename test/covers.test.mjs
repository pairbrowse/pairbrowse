// Card fields covered in pictures that leave the host's screen (daemon/covers.mjs): what counts,
// how a child frame's rectangles land in the main view, the fractions sent, the loop that keeps
// them fresh, the recorder's covers op and the capture core's checks (ui/capture).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { hitsOf, mapToFrame, toFractions, createCoverLoop, agentPicture, RECTS_MAX, COVER_COLOR } from "../scripts/daemon/covers.mjs";
import { createRecorder } from "../scripts/daemon/recorder.mjs";
import { coversIn, rectsIn, COVER_COLOR as UI_COVER, COVERS_MAX, paintCovers } from "../ui/capture/capture.js";
import { record } from "../ui/capture/record.js";
import { sleep } from "./helpers/util.mjs";

test("covered: card, security code, expiry and one-time code fields, a card number anywhere; not the ZIP or the name on the card", () => {
  const field = (hints, value = "") => [hints, value, 10, 20, 100, 30];
  const read = {
    w: 800, h: 600,
    fields: [
      field("text cc-number numeric cardnumber"), // empty, by its kind
      field("text   cvc  Security code"),
      field("text cc-exp   Expiry (MM/YY)"),
      field("text one-time-code"),
      field("text  note  Notes", "4242 4242 4242 4242"), // a card number typed anywhere
      field("text postal-code  zip  ZIP code", "94107"),
      field("text cc-name  name  Name on card", "Ada Lovelace"),
      field("email email  email  Email", "ada@example.com"),
    ],
    texts: [["4242 4242 4242 4242", 1, 2, 3, 4], ["Order 1234 5678 9012", 5, 6, 7, 8], ["Ref 12 4242 4242 4242 4242", 9, 9, 9, 9]],
  };
  assert.equal(hitsOf(read).length, 7);
  assert.deepEqual(hitsOf(read).slice(-2), [[1, 2, 3, 4], [9, 9, 9, 9]], "the card runs only, not an order number");
  assert.deepEqual(hitsOf(null), []);
  assert.deepEqual(hitsOf({ fields: [["cvc", "", "x", 1, 1, 1]], texts: "no" }), [], "malformed reads cover nothing of their own");
});

test("a child frame's rectangles land in the main view through its box, clipped to it", () => {
  // A 400x200 frame drawn at (100, 50), 1:1.
  assert.deepEqual(mapToFrame([[10, 20, 30, 40]], 400, 200, { x: 100, y: 50, width: 400, height: 200 }), [[110, 70, 30, 40]]);
  // Scaled to half its size.
  assert.deepEqual(mapToFrame([[100, 100, 40, 20]], 400, 200, { x: 0, y: 0, width: 200, height: 100 }), [[50, 50, 20, 10]]);
  // Partly outside the frame: clipped; wholly outside: gone.
  assert.deepEqual(mapToFrame([[380, 10, 50, 10], [500, 10, 10, 10]], 400, 200, { x: 0, y: 0, width: 400, height: 200 }), [[380, 10, 20, 10]]);
  assert.deepEqual(mapToFrame([[0, 0, 1, 1]], 0, 200, { x: 0, y: 0, width: 400, height: 200 }), []);
  assert.deepEqual(mapToFrame([[0, 0, 1, 1]], 400, 200, null), []);
});

test("fractions of the view: padded, clipped, rounded outward; too many cover the whole view", () => {
  const [r] = toFractions([[100, 100, 200, 50]], 1000, 500, 4);
  assert.deepEqual(r, [0.096, 0.192, 0.208, 0.116]);
  assert.deepEqual(toFractions([[-50, -50, 60, 60]], 100, 100, 0), [[0, 0, 0.1, 0.1]]);
  assert.deepEqual(toFractions([[200, 200, 10, 10]], 100, 100, 0), []);
  for (const [x, y, w, h] of toFractions([[0, 0, 1000, 500], [999, 499, 5, 5]], 1000, 500)) assert.ok(x >= 0 && y >= 0 && x + w <= 1 + 1e-9 && y + h <= 1 + 1e-9);
  assert.deepEqual(toFractions(Array.from({ length: RECTS_MAX + 1 }, (_, i) => [i, 0, 1, 1]), 1000, 500), [[0, 0, 1, 1]]);
  assert.equal(toFractions([], 0, 0), null);
  assert.equal(COVER_COLOR, UI_COVER, "one color on both sides");
});

test("the loop: each wanted page's covers to its subscribers, a page that didn't answer keeps its last", async () => {
  const a = { isClosed: () => false }, b = { isClosed: () => false };
  let answer = new Map([[a, [[0.1, 0.1, 0.2, 0.2]]], [b, []]]);
  const ticks = [];
  const loop = createCoverLoop({ every: 60_000, rectsOf: async (p) => answer.get(p) ?? null, compose: async () => "COVERED" });
  try {
    loop.want(() => [a]);
    loop.want(async () => [b, a]);
    loop.onTick((got) => ticks.push(got));
    await loop.tick();
    assert.deepEqual(ticks[0].get(a), [[0.1, 0.1, 0.2, 0.2]]);
    assert.deepEqual(ticks[0].get(b), []);
    answer = new Map(); // nobody answers
    await loop.tick();
    assert.deepEqual(ticks[1].get(a), [[0.1, 0.1, 0.2, 0.2]], "kept");
    // picture: covered when there are covers, as it is when none, never when unknown or not drawn.
    assert.equal(await loop.picture(a, "JPEG"), "COVERED");
    assert.equal(await loop.picture(b, "JPEG"), "JPEG");
    assert.equal(await loop.picture({ isClosed: () => false }, "JPEG"), null, "never read, no answer: not sent");
    const failing = createCoverLoop({ every: 60_000, rectsOf: async () => [[0, 0, 1, 1]], compose: async () => { throw new Error("no"); } });
    assert.equal(await failing.picture(a, "JPEG"), null);
    failing.close();
  } finally { loop.close(); }
});

test("the recorder sends covers by tab id while recording or shared to, and remembers the tab in front", async () => {
  const sent = [];
  const page = { isClosed: () => false };
  let peers = [];
  const capture = { kind: () => "page", tabRef: async () => "T7", record: async (arg) => { sent.push(arg); return arg.op === "covers" ? { front: "T7" } : arg.op === "coverPicture" ? "PICTURE" : { error: "unknown" }; } };
  const rec = createRecorder({ call: async () => null, dir: () => tmpdir(), capture, shared: () => peers, pages: async () => [page] });
  await rec.sendCovers(new Map([[page, [[0, 0, 0.5, 0.5]]]]));
  assert.deepEqual(sent, [], "nobody recording or shown: nothing sent");
  peers = [page];
  await rec.sendCovers(new Map([[page, [[0, 0, 0.5, 0.5]]]]));
  assert.deepEqual(sent, [{ op: "covers", covers: { T7: [[0, 0, 0.5, 0.5]] } }]);
  assert.deepEqual(await rec.coverPages(), [], "not recording: no pages of its own");
  assert.equal(await rec.coverPicture("JPEG", [[0, 0, 1, 1]]), "PICTURE");
  // Nowhere to capture and no page to draw in: nothing.
  const none = createRecorder({ call: async () => null, dir: () => tmpdir(), capture: { kind: () => null, tabRef: async () => null, record: async () => "X" } });
  assert.equal(await none.coverPicture("JPEG", [[0, 0, 1, 1]]), null);
});

test("the capture core takes covers only as { tabId: [[x, y, w, h] 0..1] }, at most COVERS_MAX a tab", async () => {
  assert.deepEqual([...coversIn({ T1: [[0, 0, 0.5, 1]], 12: [] })], [["12", []], ["T1", [[0, 0, 0.5, 1]]]]);
  for (const bad of [null, [], "x", { T1: [[0, 0, 2, 1]] }, { T1: [[0, 0, 1]] }, { T1: [[0, 0, NaN, 1]] }, { T1: "no" }, { T1: Array(COVERS_MAX + 1).fill([0, 0, 0, 0]) }, Object.create({ T1: [] })]) assert.equal(coversIn(bad), null, JSON.stringify(bad));
  assert.equal(rectsIn([[0, 0, -0.1, 0]]), null);
  assert.deepEqual(await record({ op: "recCovers", covers: { T1: [[0, 0, 3, 3]] } }), { error: "covers are { tabId: [[x, y, w, h], ...] }" });
  assert.deepEqual(await record({ op: "recCovers", covers: { T1: [[0.1, 0.1, 0.2, 0.2]] } }), { front: null }, "not recording: kept for the tab, no front");
  assert.deepEqual(await record({ op: "recCoverPicture", data: "", rects: [] }), { error: "a cover is { data, rects }" });
  assert.deepEqual(await record({ op: "recCoverPicture", data: "AAAA", rects: [[0, 0, 9, 9]] }), { error: "a cover is { data, rects }" });
  // Drawn rounded outward, over the picture's place on the canvas.
  const fills = [];
  paintCovers({ set fillStyle(v) { fills.push(v); }, fillRect: (...a) => fills.push(a) }, [[0.1, 0.25, 0.5, 0.5]], 10, 40, 100, 100);
  assert.deepEqual(fills, [UI_COVER, [20, 65, 50, 50]]);
  await sleep(0);
});

test("an agent's picture: a joiner's agent's covered (or none), the host's own as it is", async () => {
  const page = {};
  const compose = async (data, rects) => `${data}+${rects.length}`;
  assert.equal(await agentPicture("P", page, false, { rectsOf: async () => { throw new Error("never asked"); }, compose }), "P");
  assert.equal(await agentPicture("P", page, true, { rectsOf: async () => [[0, 0, 1, 1]], compose }), "P+1");
  assert.equal(await agentPicture("P", page, true, { rectsOf: async () => [], compose }), "P", "nothing to cover");
  assert.equal(await agentPicture("P", page, true, { rectsOf: async () => null, compose }), "", "the page didn't answer: no picture");
  assert.equal(await agentPicture("P", page, true, { rectsOf: async () => [[0, 0, 1, 1]], compose: async () => null }), "", "not drawn: no picture");
});

test("a capture that can't cover a direct picture: no connection, NoCover (joiners go to the slower route), said once", async () => {
  const { createScreenShare, NO_COVER_SHARE } = await import("../scripts/daemon/screenshare.mjs");
  const cdp = { send: async () => ({}), on() {}, off() {}, detach: async () => {} };
  const page = { isClosed: () => false, once() {}, context: () => ({ newCDPSession: async () => cdp }), evaluate: async () => [800, 600, 1, 0, 0] };
  const logs = [];
  const capture = { kind: () => "page", tabRef: async () => "T1", share: async (arg) => (arg.op === "offer" ? { error: "no cover", code: "NO_COVER" } : true) };
  const share = createScreenShare({ call: async () => null, capture, log: (...a) => logs.push(a.join(" ")) });
  for (let i = 0; i < 2; i++) await assert.rejects(share.offer(page, `j|t|${i}`, { role: "watch" }), (e) => e.code === "NO_COVER" && e.message === NO_COVER_SHARE);
  assert.deepEqual(share.peersOf(""), [], "no peer kept");
  assert.equal(logs.filter((l) => /can't cover card fields/.test(l)).length, 1);
  await share.close();
});
