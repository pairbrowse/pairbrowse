// A handoff step: the user's turn (a sign-in, a CAPTCHA), until a text shows or goes, or until the
// hand-off sent to the person's channels ends (hooks.turnEnded, spec server-mode B15): Done, the
// step done in the window, or a check that cleared, finishes the step; any other end stops the run there.
import { waitOrDisconnect } from "./common.mjs";

// How long a handoff waits for the user (a sign-in, a CAPTCHA).
const HANDOFF_MS = 10 * 60_000;

export async function handoff({ page, arg, hooks, fail }) {
  hooks.status(arg.say || "Your turn", "you");
  hooks.activity(`Waiting for you: ${arg.say || ""}`);
  const target = arg.until ? page.getByText(arg.until).first().waitFor({ state: "visible", timeout: HANDOFF_MS })
    : page.getByText(arg.untilGone).first().waitFor({ state: "hidden", timeout: HANDOFF_MS });
  // The grant the status above made (when hand-offs go to the channels): asked after it, so it is there.
  const turn = hooks.turnEnded?.() || null;
  let ok;
  try { ok = await waitOrDisconnect(Promise.race([target.then(() => true, () => false), ...(turn ? [turn.then((e) => e || false)] : [])]), hooks.signal); }
  finally { hooks.status("", "clear"); } // also when the participant disconnected
  if (ok && typeof ok === "object") {
    if (ok.reason === "done" || ok.reason === "window" || ok.reason === "cleared") return;
    if (ok.reason === "expired") return fail("Nobody finished the step in time: the hand-off timed out. Stop here, tell the user where you are, and don't retry the step or work around it.");
    return fail(`The hand-off ended before the step was done (${ok.reason}). Take a browser_snapshot to see where the page is, then decide with the user.`);
  }
  if (!ok) return fail(`The user didn't finish within ${HANDOFF_MS / 60_000} minutes.`);
}
