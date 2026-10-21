// A scroll as a wheel makes it (scripts/wheel.mjs): whole notches of the platform's size in
// short flicks, so every wheel event is one a real mouse makes.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WHEEL_NOTCH, wheelNotch, wheelFlicks } from "../scripts/wheel.mjs";
import { rng } from "../scripts/motion.mjs";

test("the notch follows the platform pages are told about", () => {
  assert.deepEqual(WHEEL_NOTCH, { macos: 40, windows: 100, linux: 120 });
  assert.deepEqual([wheelNotch("macos"), wheelNotch("windows"), wheelNotch("linux")], [40, 100, 120]);
  assert.deepEqual([wheelNotch("darwin"), wheelNotch("win32")], [40, 100], "a process.platform name reads too");
  assert.equal(wheelNotch("beos"), wheelNotch(), "an unknown name gives this computer's");
  assert.equal(wheelNotch(), WHEEL_NOTCH[{ darwin: "macos", win32: "windows", linux: "linux" }[process.platform]]);
});

test("a scroll is whole notches in flicks, the remainder left to the next scroll", () => {
  const random = rng("wheel");
  for (const [amount, notch] of [[720, 40], [-720, 40], [500, 100], [19, 40], [61, 40], [1000, 120], [-240, 120]]) {
    const steps = wheelFlicks(amount, notch, random);
    const n = Math.max(1, Math.round(Math.abs(amount) / notch));
    assert.equal(steps.length, n, `${amount} px in ${notch} px notches: ${n}`);
    for (const s of steps) assert.equal(s.delta, Math.sign(amount) * notch, "a whole notch with the scroll's sign");
    assert.equal(steps.at(-1).sleepMs, 0, "nothing after the last notch");
    for (const s of steps.slice(0, -1)) assert.ok(Number.isInteger(s.sleepMs) && s.sleepMs >= 28 && s.sleepMs <= 350, `a wait within a flick or between two: ${s.sleepMs}`);
  }
  // A long scroll has pauses between flicks (120 ms and more) and shorter waits inside them.
  const long = wheelFlicks(3000, 40, random);
  assert.ok(long.some((s) => s.sleepMs >= 120), "a pause between flicks");
  assert.ok(long.filter((s) => s.sleepMs > 0 && s.sleepMs < 120).length > long.length / 2, "most waits are within a flick");
  // Nothing to scroll, or no notch: no steps.
  assert.deepEqual([wheelFlicks(0, 40), wheelFlicks(NaN, 40), wheelFlicks(100, 0)], [[], [], []]);
  // The same seed, the same plan.
  assert.deepEqual(wheelFlicks(900, 100, rng(7)), wheelFlicks(900, 100, rng(7)));
});
