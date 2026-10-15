// What several step kinds share.

// A step handler's answer that its step is done and the run goes straight on to the next one
// (the step's kind recorded as done, with no look for a page dialog after it).
export const NEXT = Symbol("next step");

// Cancel passive waits when a participant disconnects; active browser operations finish
// before the daemon releases their queued turn.
export async function waitOrDisconnect(promise, signal) {
  if (!signal) return promise;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(new Error("Participant disconnected."));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}

// Why a run stops at a page's confirm or prompt dialog ({ type, message }, popups.mjs).
export const dialogStop = (d, what) => `${what} opened the page's own ${d.type} dialog: "${d.message}". The page waits on it, so nothing more was done. ` +
  `Decide with the user, answer it with browser_handle_dialog (accept, or dismiss), then run the remaining steps.`;
