// Card fields covered in pictures that leave the host's screen (daemon/covers.mjs): what counts,
// how a child frame's rectangles land in the main view, the fractions sent, the loop that keeps
// them fresh, the recorder's covers op and the capture core's checks (ui/capture).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { hitsOf, mapToFrame, toFractions, createCoverLoop, agentPicture, coverRects, unionRects, RECTS_MAX, COVER_COLOR, WHOLE } from "../scripts/daemon/covers.mjs";
import { createRecorder } from "../scripts/daemon/recorder.mjs";
import { coversIn, rectsIn, setCovers, rectsAt, COVER_COLOR as UI_COVER, COVERS_MAX, paintCovers } from "../ui/capture/capture.js";
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
    // picture: covered when there are covers, as it is when none, never when unknown or not drawn
    // (a picture taken before the reads: they came after it).
    assert.equal(await loop.picture(a, "JPEG", 0), "COVERED");
    assert.equal(await loop.picture(b, "JPEG", 0), "JPEG");
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
  // Only the pages read this time, with when the reads began.
  sent.length = 0;
  await rec.sendCovers(new Map([[page, [[0, 0, 0.5, 0.5]]]]), { mark: 12.5, fresh: new Set() });
  assert.deepEqual(sent, [], "not read this time: not sent again");
  await rec.sendCovers(new Map([[page, [[0, 0, 0.5, 0.5]]]]), { mark: 12.5, fresh: new Set([page]) });
  assert.deepEqual(sent, [{ op: "covers", covers: { T7: [[0, 0, 0.5, 0.5]] }, mark: 12.5 }]);
  assert.deepEqual(await rec.coverPages(), [], "not recording: no pages of its own");
  assert.equal(await rec.coverPicture("JPEG", [[0, 0, 1, 1]]), "PICTURE");
  // Nowhere to capture: nothing (never drawn in the page's own renderer).
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
  assert.equal(await agentPicture("P", page, true, { before: [], rectsOf: async () => [[0, 0, 1, 1]], compose }), "P+1");
  assert.equal(await agentPicture("P", page, true, { before: [[0.5, 0.5, 0.1, 0.1]], rectsOf: async () => [[0, 0, 1, 1]], compose }), "P+2", "covers before and after the picture, both");
  assert.equal(await agentPicture("P", page, true, { before: [], rectsOf: async () => [], compose }), "P", "nothing to cover");
  assert.equal(await agentPicture("P", page, true, { before: [], rectsOf: async () => null, compose }), "", "the page didn't answer: no picture");
  assert.equal(await agentPicture("P", page, true, { rectsOf: async () => [], compose }), "", "no covers from before the picture: no picture");
  assert.equal(await agentPicture("P", page, true, { before: [], rectsOf: async () => [[0, 0, 1, 1]], compose: async () => null }), "", "not drawn: no picture");
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

test("the loop: a page that keeps not answering is covered whole, a picture waits for a read after it, a navigation covers the page at once", async () => {
  const handlers = [];
  const main = {};
  const a = { isClosed: () => false, mainFrame: () => main, on: (ev, fn) => handlers.push([ev, fn]) };
  let answer = [[0.1, 0.1, 0.1, 0.1]];
  const ticks = [];
  const loop = createCoverLoop({ every: 60_000, staleMs: 400, rectsOf: async () => answer, mark: async () => 7, compose: async (_p, d, r) => `${d}:${r.length}` });
  try {
    loop.want(() => [a]);
    loop.onTick((got, info) => ticks.push({ got, info }));
    await loop.tick();
    assert.equal(ticks[0].info.mark, 7);
    assert.ok(ticks[0].info.fresh.has(a));
    answer = null;
    await loop.tick();
    assert.ok(!ticks[1].info.fresh.has(a), "no answer yet: not fresh, the last kept");
    await sleep(450);
    await loop.tick();
    assert.deepEqual(ticks[2].got.get(a), WHOLE, "no answer for staleMs: covered whole");
    assert.ok(ticks[2].info.fresh.has(a));
    // A picture taken now waits for the next read, then gets it joined with the one before.
    answer = [[0.5, 0.5, 0.1, 0.1]];
    await sleep(150); // the whole view's read more than LAG_MS before the picture: only it in force
    const pending = loop.picture(a, "JPEG");
    await sleep(20);
    await loop.tick();
    assert.equal(await pending, "JPEG:2", "the read after it and the whole view in force before");
    // No read after the picture in time: not sent.
    assert.equal(await loop.rectsSince(a, Date.now() + 10_000, 50), null);
    // The main frame navigated: covered whole at once, where covers are drawn as they come.
    const [, onNav] = handlers.find(([ev]) => ev === "framenavigated");
    onNav({});
    onNav(main);
    await sleep(0);
    const nav = ticks.at(-1);
    assert.deepEqual(nav.got.get(a), WHOLE);
    assert.equal(nav.info.mark, null);
  } finally { loop.close(); }
});

test("coverRects: frames past the read limit covered by their box, a frame whose place can't be read covers the whole view", async () => {
  const frame = (box, read = { w: 100, h: 100, fields: [], texts: [] }, opts = {}) => ({
    evaluate: async () => read,
    isDetached: () => !!opts.detached,
    frameElement: async () => {
      if (opts.boxFails) throw new Error("gone");
      return { boundingBox: async () => (opts.slow ? new Promise(() => {}) : box), dispose: async () => {} };
    },
  });
  const main = { evaluate: async () => ({ w: 1000, h: 1000, fields: [], texts: [] }) };
  const page = (children) => ({ isClosed: () => false, mainFrame: () => main, frames: () => [main, ...children] });
  const shown = { x: 100, y: 100, width: 100, height: 100 };
  // 19 frames read (nothing in them), the next ones only by their box: covered whole.
  const many = [...Array.from({ length: 19 }, () => frame(shown)), frame({ x: 500, y: 500, width: 100, height: 100 })];
  const r = await coverRects(page(many), 50);
  assert.equal(r.length, 1);
  assert.ok(r[0][0] <= 0.5 && r[0][0] + r[0][2] >= 0.6, JSON.stringify(r));
  assert.deepEqual(await coverRects(page(Array.from({ length: 80 }, () => frame(shown))), 50), [[0, 0, 1, 1]], "too many frames: the whole view");
  assert.deepEqual(await coverRects(page([frame(shown, undefined, { slow: true })]), 30), [[0, 0, 1, 1]], "a box that doesn't come: the whole view");
  assert.deepEqual(await coverRects(page([frame(shown, undefined, { boxFails: true })]), 30), [[0, 0, 1, 1]], "a box that can't be read: the whole view");
  assert.deepEqual(await coverRects(page([frame(shown, undefined, { boxFails: true, detached: true })]), 30), [], "a frame gone from the page: nothing");
  assert.deepEqual(await coverRects(page([frame(null)]), 30), [], "a frame not shown: nothing");
  assert.equal(unionRects([[0, 0, 1, 1]], [[0, 0, 1, 1]], [[0.1, 0.1, 0.1, 0.1]]).length, 2);
});

test("the capture core matches a picture to covers read after it, joined with those in force just before", () => {
  const k = "TG";
  const t0 = performance.now() - 5000; // marks are this page's clock, never from the future
  assert.equal(rectsAt(k, t0 + 100), null, "none read yet");
  setCovers(new Map([[k, [[0.1, 0.1, 0.1, 0.1]]]]), t0 + 50);
  setCovers(new Map([[k, [[0.2, 0.2, 0.1, 0.1]]]]), null); // not marked: not matched to pictures
  assert.equal(rectsAt(k, t0 + 100), null, "no read after the picture yet");
  setCovers(new Map([[k, [[0.3, 0.3, 0.1, 0.1]]]]), t0 + 120);
  assert.deepEqual(rectsAt(k, t0 + 100), [[0.1, 0.1, 0.1, 0.1], [0.3, 0.3, 0.1, 0.1]]);
  setCovers(new Map([[k, []]]), t0 + 400);
  assert.deepEqual(rectsAt(k, t0 + 380), [[0.3, 0.3, 0.1, 0.1]], "the read in force 100 ms before the picture, and the one after");
  setCovers(new Map([[k, [[0.9, 0.9, 0.1, 0.1]]]]), t0 + 200); // out of order: never matched backwards
  assert.deepEqual(rectsAt(k, t0 + 380), [[0.3, 0.3, 0.1, 0.1]]);
  setCovers(new Map([[k, []]]), performance.now() + 60_000); // a mark from the future: not matched
  assert.equal(rectsAt(k, t0 + 500), null);
});

test("the recorder finds the tab in front among all the open tabs", async () => {
  const pages = Array.from({ length: 9 }, (_, i) => ({ i, isClosed: () => false }));
  const capture = { kind: () => "page", tabRef: async (p) => `T${p.i}`, record: async (arg) => (arg.op === "covers" ? { front: "T8" } : arg.op === "start" ? { type: "video/webm", w: 10, h: 10 } : arg.op === "coverMark" ? 3 : true) };
  const rec = createRecorder({ call: async () => null, dir: () => tmpdir(), capture, pages: async () => pages, shared: () => [pages[0]] });
  await rec.sendCovers(new Map([[pages[0], []]]));
  await rec.start("front");
  try {
    const list = await rec.coverPages();
    assert.equal(list[0], pages[8], "the ninth tab, in front, first");
    assert.equal(list.length, 6);
  } finally { await rec.stop().catch(() => {}); rec.covers.close(); }
});

test("sensitiveValues fails closed: a frame that doesn't answer or too many frames mask every value", async () => {
  const { sensitiveValues, FRAMES_MAX } = await import("../scripts/daemon/serve/pageread.mjs");
  const { UNKNOWN_VALUES } = await import("../scripts/rules/policy.mjs");
  const frame = (list, detached = false) => ({ evaluate: async () => { if (list === null) throw new Error("no"); return list; }, isDetached: () => detached });
  const page = (frames) => ({ isClosed: () => false, frames: () => frames });
  assert.deepEqual(await sensitiveValues(page([frame([["text cc-number", "4242424242424242"], ["text  q", "shoes"]])])), ["4242424242424242"]);
  assert.equal(await sensitiveValues(page([frame([]), frame(null)])), UNKNOWN_VALUES, "a frame that didn't answer");
  assert.deepEqual(await sensitiveValues(page([frame([]), frame(null, true)])), [], "a frame gone from the page: nothing to read there");
  assert.equal(await sensitiveValues(page(Array.from({ length: FRAMES_MAX + 1 }, () => frame([])))), UNKNOWN_VALUES, "more frames than are read");
  assert.equal((await sensitiveValues(page([frame([["text   code  maxlength6", "123456"]])]))).length, 1, "a one-time code's box");
});

test("a read after the page scrolled covers the path its fields took since the read before; a read past its bounds covers the whole view", async () => {
  const { alongPath, joinReads } = await import("../scripts/daemon/covers.mjs");
  const read = (rects, sy) => Object.defineProperty(rects, "view", { value: { sx: 0, sy, w: 1000, h: 1000 } });
  // Scrolled down 200 px: the field now at 30% stood at 50% before.
  assert.deepEqual(alongPath(read([[0.1, 0.3, 0.2, 0.1]], 200), read([], 0)), [[0.1, 0.3, 0.2, 0.3]]);
  assert.deepEqual(alongPath(read([[0.1, 0.3, 0.2, 0.1]], 2), read([], 0)), [[0.1, 0.3, 0.2, 0.1]], "within the padding: as it is");
  assert.deepEqual(alongPath([[0.1, 0.3, 0.2, 0.1]], read([], 0)), [[0.1, 0.3, 0.2, 0.1]], "no scroll known: as it is");
  assert.deepEqual(joinReads(read([[0.1, 0.5, 0.2, 0.1]], 0), read([[0.1, 0.3, 0.2, 0.1]], 200)), [[0.1, 0.5, 0.2, 0.1], [0.1, 0.3, 0.2, 0.3]]);
  const main = { evaluate: async () => ({ w: 1000, h: 1000, sx: 0, sy: 0, partial: true, fields: [], texts: [] }) };
  assert.deepEqual(await coverRects({ isClosed: () => false, mainFrame: () => main, frames: () => [main] }), [[0, 0, 1, 1]], "partial: the whole view");
  const { sensitiveValues } = await import("../scripts/daemon/serve/pageread.mjs");
  const { UNKNOWN_VALUES } = await import("../scripts/rules/policy.mjs");
  assert.equal(await sensitiveValues({ isClosed: () => false, frames: () => [{ evaluate: async () => null, isDetached: () => false }] }), UNKNOWN_VALUES, "fields past the bounds: unknown");
});

test("between two reads: a field scrolled out of view is swept to the edge, a field moved inside a box is matched by its key", async () => {
  const { betweenReads, joinReads } = await import("../scripts/daemon/covers.mjs");
  const read = (rects, sy, keys = rects.map(() => null)) => Object.defineProperties(rects, { view: { value: { sx: 0, sy, w: 1000, h: 1000 } }, keys: { value: keys } });
  // Scrolled down 400 px: the field at 20% left over the top; between the reads it went from 20% up and out.
  assert.ok(betweenReads(read([[0.1, 0.2, 0.2, 0.1]], 0), read([], 400)).some((r) => r.join() === [0.1, 0, 0.2, 0.3].join()));
  // No scroll; a box inside the page moved the field from 60% to 20%: the hull of both places.
  const moved = betweenReads(read([[0.1, 0.6, 0.2, 0.1]], 0, ["m/f0.1"]), read([[0.1, 0.2, 0.2, 0.1]], 0, ["m/f0.1"]));
  assert.ok(moved.some(([x, y, w, h]) => x <= 0.1 && y <= 0.2 && y + h >= 0.7 - 1e-9 && w >= 0.2 - 1e-9), JSON.stringify(moved));
  assert.ok(joinReads(read([[0.5, 0.5, 0.1, 0.1]], 0), read([], 0)).length === 1, "the read before stays");
});
