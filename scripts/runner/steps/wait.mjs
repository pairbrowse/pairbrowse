// A waitFor or expect step: wait for text or a field to show, in the page or one of its frames
// (a sign-in box or a consent wall often lives in one), as browser_wait_for looks.
import { bounded, sleep } from "../../util.mjs";
import { waitOrDisconnect } from "./common.mjs";

const FRAMES_MAX = 12;

// Whether the text (or a field named by it) shows in the page or a frame, within timeout.
export async function shownAnywhere(page, text, timeout) {
  const until = Date.now() + timeout;
  do {
    const frames = typeof page.frames === "function" ? page.frames().slice(0, FRAMES_MAX) : [page];
    for (const root of frames.length ? frames : [page]) {
      // Page text, or a field shown by its placeholder or label ("Enter your email").
      const shown = root.getByText(text).or(root.getByPlaceholder(text)).or(root.getByLabel(text));
      for (let i = 0, n = Math.min(await bounded(shown.count(), 0), 20); i < n; i++) if (await bounded(shown.nth(i).isVisible(), false)) return true;
    }
    await sleep(200);
  } while (Date.now() < until);
  return false;
}

export async function wait({ page, kind, arg, hooks, fail }) {
  const ok = await waitOrDisconnect(shownAnywhere(page, String(arg), kind === "expect" ? 3000 : 15000), hooks.signal);
  if (!ok) return fail(`"${arg}" didn't appear (looked in the page and its frames).`);
}
