// How an agent's pointer moves from one point to another, modelled on how a person's hand moves a
// mouse: an aimed reach is one fast primary submovement that lands a little short (sometimes a
// little past) and one or two small corrective submovements that start before it has finished, so
// the speed never drops to zero on the way (Meyer et al. 1988, Flash and Henis 1991). Each
// submovement follows the minimum-jerk profile s(u) = 10u^3 - 15u^4 + 6u^5 (Flash and Hogan 1985);
// added together they give a bell-shaped speed that peaks before the middle and tails off while
// homing in. The time a move takes follows Fitts' law, a + b log2(D / W + 1), from the distance D
// and the target's smaller side W. The primary bows slightly to one side, and an optional 8-12 Hz
// tremor adds the small shake of a hand at rest.
//
// createMotion() is self-contained (it uses nothing from outside its own body), so the page script
// (scripts/hud.js) gets the same code: browser.mjs puts createMotion's source into it.
// Everything random comes from the rng passed in; with a seeded rng (rng(seed)) a plan is the same
// every time.

export function createMotion() {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // A small, fast seeded generator (mulberry32). seed: a number or a string.
  function rng(seed = 1) {
    let a = 0x811c9dc5;
    const s = String(seed);
    for (let i = 0; i < s.length; i++) a = Math.imul(a ^ s.charCodeAt(i), 0x01000193);
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // A standard normal sample.
  function gauss(random) {
    let u = 0;
    while (u === 0) u = random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  }
  // Minimum jerk: position fraction at time fraction u, and its speed (d/du).
  const minJerk = (u) => { const t = clamp(u, 0, 1); return t * t * t * (10 + t * (-15 + 6 * t)); };
  const minJerkSpeed = (u) => (u <= 0 || u >= 1 ? 0 : 30 * u * u * (1 - u) * (1 - u));

  const DEFAULTS = {
    targetW: 24, // the target's smaller side, px
    fittsA: 110, fittsB: 165, // ms, ms per bit: within the range measured for mouse pointing
    minMs: 80, maxMs: 1600, // limits on the whole move
    speed: 1, // > 1 is faster: every duration is divided by it
    timeNoise: 0.1, // spread of the duration, as a log-normal factor
    gain: 0.95, gainSpread: 0.05, // where the primary lands, as a fraction of the way
    maxOvershoot: 0.06, maxOvershootPx: 18, // how far past the target the primary may go
    lateral: 0.02, // sideways error of the primary's landing, as a fraction of the distance
    curve: 0.06, // how far the primary bows sideways at most, as a fraction of its length
    side: 0, // which side it bows: 1 or -1 (a hand's habit), 0 for either
    tremor: 0, tremorHz: 10, // px, Hz: the small shake of the hand (0: none)
    correctFrom: 60, // px: shorter moves are one submovement
  };

  // Plans a move from -> to. Returns { duration, subs, at(ms) -> { x, y } }: at(0) is from,
  // at(duration) (and anything later) is exactly to.
  function plan(from, to, options = {}) {
    const o = { ...DEFAULTS, ...options };
    const random = typeof o.rng === "function" ? o.rng : Math.random;
    const dx = to.x - from.x, dy = to.y - from.y;
    const D = Math.hypot(dx, dy);
    const end = { x: to.x, y: to.y };
    if (!(D >= 1)) return { duration: 0, subs: [], at: () => ({ ...end }) };
    const ux = dx / D, uy = dy / D; // along the move
    const nx = -uy, ny = ux; // across it
    const W = Math.max(4, Number(o.targetW) || DEFAULTS.targetW);
    const id = Math.log2(D / W + 1);
    const speed = Math.max(0.1, Number(o.speed) || 1);
    const lo = Math.max(1, o.minMs / speed), hi = Math.max(lo, o.maxMs / speed);
    const duration = clamp(((o.fittsA + o.fittsB * id) * Math.exp(gauss(random) * o.timeNoise)) / speed, lo, hi);

    // Submovements: { t0, T, dx, dy, bow }, each a minimum-jerk step of (dx, dy) over [t0, t0 + T].
    const subs = [];
    if (D < o.correctFrom) {
      subs.push({ t0: 0, T: duration, dx, dy, bow: 0 });
    } else {
      const over = Math.min(o.maxOvershoot, o.maxOvershootPx / D);
      const gain = clamp(o.gain + gauss(random) * o.gainSpread, 0.8, 1 + over);
      const side = clamp(gauss(random) * o.lateral, -2 * o.lateral, 2 * o.lateral) * D;
      const p1 = { x: dx * gain + nx * side, y: dy * gain + ny * side };
      const bowSide = o.side > 0 ? 1 : o.side < 0 ? -1 : random() < 0.5 ? -1 : 1;
      const bow = bowSide * o.curve * (0.35 + 0.65 * random()) * Math.hypot(p1.x, p1.y);
      // The primary takes about 80% of the time; the correction starts before it ends.
      const T1 = duration * (0.74 + 0.1 * random());
      subs.push({ t0: 0, T: T1, dx: p1.x, dy: p1.y, bow });
      const left = { x: dx - p1.x, y: dy - p1.y };
      const start2 = T1 * (0.72 + 0.14 * random());
      if (D > 8 * W && random() < 0.3) {
        // Two corrections: most of the rest, then the last few pixels.
        const f = 0.8 + 0.12 * random();
        const err = Math.min(3, W / 4);
        const e = clamp(gauss(random), -2, 2) * err; // sideways only, so it never sets the move back
        const p2 = { x: left.x * f + nx * e, y: left.y * f + ny * e };
        const T2 = (duration - start2) * 0.6;
        const start3 = start2 + T2 * (0.7 + 0.15 * random());
        subs.push({ t0: start2, T: T2, dx: p2.x, dy: p2.y, bow: 0 });
        subs.push({ t0: start3, T: duration - start3, dx: left.x - p2.x, dy: left.y - p2.y, bow: 0 });
      } else {
        subs.push({ t0: start2, T: duration - start2, dx: left.x, dy: left.y, bow: 0 });
      }
    }
    const tremor = Math.max(0, Number(o.tremor) || 0);
    const phase = tremor ? random() * 2 * Math.PI : 0;
    const hz = o.tremorHz * (0.9 + 0.2 * random());

    function at(ms) {
      if (!(ms < duration)) return { ...end };
      const t = Math.max(0, ms);
      let x = from.x, y = from.y;
      for (const s of subs) {
        const u = (t - s.t0) / s.T;
        if (u <= 0) continue;
        const p = minJerk(u);
        x += s.dx * p;
        y += s.dy * p;
        if (s.bow && u < 1) {
          // Sideways bow, across the whole move: zero at both ends, widest in the middle.
          const off = s.bow * 4 * p * (1 - p);
          x += nx * off;
          y += ny * off;
        }
      }
      if (tremor) {
        // Fades in and out so the move still starts and ends exactly on its points.
        const fade = Math.sin(Math.PI * (t / duration));
        const w = (2 * Math.PI * hz * t) / 1000 + phase;
        x += tremor * fade * Math.sin(w);
        y += tremor * fade * Math.sin(w * 0.93 + 1);
      }
      return { x, y };
    }
    return { duration, subs, at };
  }

  // The plan's speed along the straight line (px per ms) at ms, without bow or tremor.
  function speedAt(p, ms) {
    let vx = 0, vy = 0;
    for (const s of p.subs) {
      const v = minJerkSpeed((ms - s.t0) / s.T) / s.T;
      vx += s.dx * v;
      vy += s.dy * v;
    }
    return Math.hypot(vx, vy);
  }

  // Points every 1000 / hz ms, the last one exactly on the end: [{ x, y, t }].
  function sample(p, hz = 60) {
    const step = 1000 / hz, out = [];
    for (let t = step; t < p.duration; t += step) out.push({ ...p.at(t), t });
    out.push({ ...p.at(p.duration), t: p.duration });
    return out;
  }

  return { rng, gauss, minJerk, plan, speedAt, sample, DEFAULTS };
}

export const { rng, gauss, minJerk, plan, speedAt, sample, DEFAULTS } = createMotion();
