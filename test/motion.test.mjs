import { test } from "node:test";
import assert from "node:assert/strict";
import { createMotion, plan, rng, sample, speedAt, DEFAULTS } from "../scripts/motion.mjs";

// Random start and end points of moves of every length, from a fixed seed.
function moves(n, seed = "moves") {
  const r = rng(seed), out = [];
  for (let i = 0; i < n; i++) {
    const from = { x: r() * 1600, y: r() * 1000 };
    const d = 4 + r() * 1200, a = r() * 2 * Math.PI;
    out.push({ from, to: { x: from.x + d * Math.cos(a), y: from.y + d * Math.sin(a) }, w: 8 + r() * 80 });
  }
  return out;
}
const along = (p, from, to) => {
  const dx = to.x - from.x, dy = to.y - from.y, d2 = dx * dx + dy * dy;
  return ((p.x - from.x) * dx + (p.y - from.y) * dy) / d2;
};

test("a move starts at its start and ends exactly at its end", () => {
  for (const [i, m] of moves(300).entries()) {
    const p = plan(m.from, m.to, { targetW: m.w, rng: rng(i), tremor: i % 2 ? 0.5 : 0 });
    const start = p.at(0), end = p.at(p.duration);
    assert.ok(Math.hypot(start.x - m.from.x, start.y - m.from.y) < 1e-9);
    assert.deepEqual(end, m.to);
    assert.deepEqual(p.at(p.duration + 500), m.to, "stays there");
    const pts = sample(p, 120);
    assert.deepEqual({ x: pts.at(-1).x, y: pts.at(-1).y }, m.to);
    assert.ok(pts.every((q, k) => k === 0 || q.t > pts[k - 1].t), "time only goes forward");
  }
});

test("without overshoot, progress toward the target never goes back", () => {
  for (const [i, m] of moves(200).entries()) {
    const p = plan(m.from, m.to, { targetW: m.w, rng: rng(i), maxOvershoot: 0, gainSpread: 0.05 });
    let last = 0;
    for (let t = 0; t <= p.duration; t += 2) {
      const s = along(p.at(t), m.from, m.to);
      assert.ok(s >= last - 1e-9, `move ${i} went back at ${t} ms`);
      last = s;
    }
    assert.ok(last <= 1 + 1e-9 && Math.abs(along(p.at(p.duration), m.from, m.to) - 1) < 1e-9);
  }
});

test("an overshoot is small, sometimes happens, and the move still homes in", () => {
  let overs = 0, primaries = 0;
  for (const [i, m] of moves(400).entries()) {
    const D = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
    const p = plan(m.from, m.to, { targetW: m.w, rng: rng(`o${i}`) });
    const bound = Math.min(DEFAULTS.maxOvershoot * D, DEFAULTS.maxOvershootPx) + 1;
    let most = 0;
    for (let t = 0; t <= p.duration; t += 2) most = Math.max(most, (along(p.at(t), m.from, m.to) - 1) * D);
    assert.ok(most <= bound, `move ${i}: ${most.toFixed(1)} px past, bound ${bound.toFixed(1)}`);
    if (D >= DEFAULTS.correctFrom) { primaries++; if (most > 0.5) overs++; }
  }
  const share = overs / primaries;
  assert.ok(share > 0.05 && share < 0.4, `overshoot share ${share.toFixed(2)}`);
});

test("duration grows with distance and difficulty, within its limits", () => {
  for (const [i, m] of moves(300).entries()) {
    const p = plan(m.from, m.to, { targetW: m.w, rng: rng(i) });
    if (p.duration === 0) continue;
    assert.ok(p.duration >= DEFAULTS.minMs && p.duration <= DEFAULTS.maxMs, String(p.duration));
  }
  const mean = (d, w) => {
    let sum = 0;
    for (let i = 0; i < 50; i++) sum += plan({ x: 0, y: 0 }, { x: d, y: 0 }, { targetW: w, rng: rng(i) }).duration;
    return sum / 50;
  };
  assert.ok(mean(100, 24) < mean(600, 24));
  assert.ok(mean(400, 60) < mean(400, 10), "small targets take longer");
  const quick = plan({ x: 0, y: 0 }, { x: 2000, y: 0 }, { rng: rng(1), minMs: 120, maxMs: 450 });
  assert.ok(quick.duration <= 450);
  assert.equal(plan({ x: 5, y: 5 }, { x: 5.4, y: 5 }).duration, 0, "a sub-pixel move is a jump");
});

test("speed is one bell that peaks before the middle and never stops on the way", () => {
  let early = 0;
  for (const [i, m] of moves(200).entries()) {
    const D = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
    if (D < 100) continue;
    const p = plan(m.from, m.to, { targetW: m.w, rng: rng(i) });
    let peak = 0, peakAt = 0, stopped = false;
    for (let t = 1; t < p.duration - 1; t += 1) {
      const v = speedAt(p, t);
      if (v > peak) { peak = v; peakAt = t; }
      if (t > p.duration * 0.05 && t < p.duration * 0.9 && v < 1e-6) stopped = true;
    }
    assert.ok(!stopped, `move ${i} stopped on the way`);
    if (peakAt / p.duration < 0.5) early++;
  }
  assert.ok(early > 0, "peaks come before the middle");
});

test("the same seed gives the same move; another seed a different one", () => {
  const from = { x: 10, y: 20 }, to = { x: 700, y: 380 };
  const a = sample(plan(from, to, { rng: rng(42), tremor: 0.4 }));
  const b = sample(plan(from, to, { rng: rng(42), tremor: 0.4 }));
  const c = sample(plan(from, to, { rng: rng(43), tremor: 0.4 }));
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(rng("x")(), rng("x")());
});

test("the model is self-contained, so the page script can carry it", () => {
  const copy = new Function(`return (${createMotion.toString()})()`)();
  const from = { x: 0, y: 0 }, to = { x: 300, y: 200 };
  assert.deepEqual(sample(copy.plan(from, to, { rng: copy.rng(7) })), sample(plan(from, to, { rng: rng(7) })));
});
