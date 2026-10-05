// The corner prompt for join requests: "Sam (Claude Code) wants to join (drive)" with Allow, Deny
// and a close, in the host's tab in front (scripts/hud.js draws it), once per request, beside the
// side panel's Allow / Deny. It goes by itself after a while; the request stays pending in the side
// panel. It's taken down wherever the request is answered (the side panel, the live view, an
// agent's approve the user confirmed, a revoke).
//
// An answer from it counts only when it was a person's own click (byPerson: no agent acting then,
// no joiner's or live view's input being replayed), in the very tab it was shown in, for a request
// still waiting, ARM_MS or more after it showed. Then it's answered the way the side panel's
// buttons answer it (approvals.approve / deny).

export const ARM_MS = 600;
const POLL_MS = 300;
const KINDS = new Set(["join-allow", "join-deny"]);

// approvals: createApprovals (join.mjs). front(): the tab in front in the host's browser (a
// Playwright page), or null. show(page, value, kind): one call into the page script (hud.call).
// byPerson(t): whether input at time t was a person's own (presence.mjs). log(text).
export function createJoinPrompt({ approvals, front, show, byPerson, log = () => {} }) {
  const shown = new Map(); // request id -> { page, at }
  const asked = new Set(); // request ids prompted once already (never shown again)
  let chain = Promise.resolve();
  let poll = null;

  async function sync() {
    const pending = approvals.pending();
    const waiting = new Set(pending.map((r) => r.id));
    // Answered or gone (anywhere): down from the page it's on.
    for (const [id, s] of shown) {
      if (waiting.has(id)) continue;
      shown.delete(id);
      if (!s.page.isClosed()) await show(s.page, id, "join-off").catch(() => {});
    }
    for (const id of asked) if (!waiting.has(id)) asked.delete(id);
    const fresh = pending.filter((r) => !asked.has(r.id));
    if (fresh.length) {
      for (const r of fresh) asked.add(r.id);
      const page = await front().catch(() => null);
      if (page && !page.isClosed()) {
        for (const r of fresh) {
          const who = `${r.name || "Someone"}${r.app ? ` (${r.app})` : ""}`;
          if ((await show(page, { id: r.id, who, role: r.role }, "join").catch(() => false)) === true) shown.set(r.id, { page, at: Date.now() });
        }
      }
    }
    watch();
  }
  const refresh = () => { chain = chain.then(sync).catch((e) => log(`join prompt: ${e?.message || e}`)); return chain; };
  approvals.onChange(refresh);

  // While a prompt is up: its answers, read from the page it's in.
  function watch() {
    if (shown.size && !poll) { poll = setInterval(read, POLL_MS); poll.unref?.(); }
    if (!shown.size && poll) { clearInterval(poll); poll = null; }
  }
  let reading = false;
  async function read() {
    if (reading) return;
    reading = true;
    try {
      for (const page of new Set([...shown.values()].map((s) => s.page))) {
        if (page.isClosed()) { for (const [id, s] of shown) if (s.page === page) shown.delete(id); continue; }
        const got = await show(page, "", "join-answers").catch(() => null);
        if (!got || typeof got !== "object") continue; // a page loading: asked again next time
        let a = got.a;
        for (let n = 0; a && typeof a === "object" && n < 5; n++, a = a.next) answer(a.kind, a.what, page, Number(a.t));
        // Gone from the page (its time was up, dismissed, the page went elsewhere): nothing to read there.
        if (!got.open) for (const [id, s] of shown) if (s.page === page) shown.delete(id);
      }
    } finally {
      reading = false;
      watch();
    }
  }

  // An answer from the prompt in page, made at time t. Returns the request it answered, or null.
  function answer(kind, id, page, t) {
    const at = Date.now();
    t = Math.min(at, Number.isFinite(t) ? t : at); // a time from the page is never later than now
    const s = shown.get(String(id));
    if (!KINDS.has(kind) || !s || s.page !== page || t < s.at + ARM_MS || !byPerson(t)) return null;
    if (!approvals.pending().some((r) => r.id === id)) return null;
    const done = kind === "join-allow" ? approvals.approve(id) : approvals.deny(id);
    if (done) log(`join request ${id} ${kind === "join-allow" ? "allowed" : "denied"} in the page's prompt`);
    return done;
  }

  return { refresh, answer, front, shown: () => [...shown.keys()] };
}
