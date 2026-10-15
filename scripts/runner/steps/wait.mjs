// A waitFor or expect step: wait for text or a field to show.
import { visibleSoon } from "../locate.mjs";
import { waitOrDisconnect } from "./common.mjs";

export async function wait({ page, kind, arg, hooks, fail }) {
  // Page text, or a field shown by its placeholder or label ("Enter your email").
  const shown = page.getByText(String(arg)).or(page.getByPlaceholder(String(arg))).or(page.getByLabel(String(arg)));
  const ok = await waitOrDisconnect(visibleSoon(shown, kind === "expect" ? 3000 : 15000), hooks.signal);
  if (!ok) return fail(`"${arg}" didn't appear.`);
}
