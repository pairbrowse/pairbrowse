// A scroll as a wheel makes it. A mouse wheel turns in notches, and the browser reports each notch
// as one wheel event of a fixed size for the platform: 40 px on macOS (its line scroll), 100 px
// on Windows (three lines of 33.3), 120 px on Linux (X11's wheel unit), each with wheelDeltaY 120.
// Pixel-sized wheel events under a fixed wheelDeltaY are a pair no wheel or trackpad makes (the
// ordinary-browser measurement's gap 9), so a scroll is planned as whole notches in short flicks:
// a flick of 2 to 5 notches, 28 to 60 ms apart and slowing as the wheel's turn runs out, then a
// pause of 120 to 350 ms before the next flick, as a finger does. A scroll under half a notch is
// one notch; the rest of a scroll that is not a whole number of notches is left to the next one
// (a page's position is read back after each, never assumed). The native build's engine pack
// plans its own wheel the same way (its wheelNotch option is this notch); PairBrowse's own steps
// (runner/steps/scroll.mjs) use this. Pure; Node's standard library only.
export const WHEEL_NOTCH = Object.freeze({ macos: 40, windows: 100, linux: 120 });
const PLATFORM_NAMES = { darwin: "macos", win32: "windows", linux: "linux" };

// The notch, in px, of the platform pages are told about: "macos", "windows" or "linux" (a
// process.platform name is read too); an unknown name gives this computer's.
export function wheelNotch(platform = process.platform) {
  const name = PLATFORM_NAMES[platform] ?? platform;
  return WHEEL_NOTCH[name] ?? WHEEL_NOTCH[PLATFORM_NAMES[process.platform]] ?? WHEEL_NOTCH.linux;
}

// The steps of one scroll of amount px (its sign the direction) in notches of notch px:
// [{ delta, sleepMs }], delta a whole notch with the scroll's sign, sleepMs the wait after it (0
// after the last). rng: a function giving [0, 1), for tests.
export function wheelFlicks(amount, notch = wheelNotch(), rng = Math.random) {
  const out = [];
  if (!(Math.abs(amount) > 0) || !(notch > 0)) return out;
  const n = Math.max(1, Math.round(Math.abs(amount) / notch));
  const sign = amount > 0 ? 1 : -1;
  let i = 0;
  while (i < n) {
    const burst = Math.min(n - i, 2 + Math.floor(rng() * 4));
    for (let k = 0; k < burst; k++, i++) {
      const last = i === n - 1;
      const gap = 28 + 32 * (k / Math.max(1, burst - 1)) + rng() * 25;
      out.push({ delta: sign * notch, sleepMs: last ? 0 : Math.round(k === burst - 1 ? 120 + rng() * 230 : gap) });
    }
  }
  return out;
}
