// A handoff step: the user's turn (a sign-in, a CAPTCHA), until a text shows or goes.
import { waitOrDisconnect } from "./common.mjs";

// How long a handoff waits for the user (a sign-in, a CAPTCHA).
const HANDOFF_MS = 10 * 60_000;

export async function handoff({ page, arg, hooks, fail }) {
  hooks.status(arg.say || "Your turn", "you");
  hooks.activity(`Waiting for you: ${arg.say || ""}`);
  const target = arg.until ? page.getByText(arg.until).first().waitFor({ state: "visible", timeout: HANDOFF_MS })
    : page.getByText(arg.untilGone).first().waitFor({ state: "hidden", timeout: HANDOFF_MS });
  let ok;
  try { ok = await waitOrDisconnect(target.then(() => true, () => false), hooks.signal); }
  finally { hooks.status("", "clear"); } // also when the participant disconnected
  if (!ok) return fail(`The user didn't finish within ${HANDOFF_MS / 60_000} minutes.`);
}
