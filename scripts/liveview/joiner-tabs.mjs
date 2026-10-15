// A drive joiner's changes in the shared tabs: opened, moved to another address, closed, ordered,
// plus who is where, their agents' lines and form values, as the joiner's helper sends them (readOps).
// Returns applyTabs(body, j, heardAt): { ok, opened } or { problem }. The rest: the live view's.
import { keepFocus } from "../focus.mjs";
import { personLabel, cleanName } from "../sharing/join.mjs";
import { readOps, shareableUrl, onSecretDomain, activityBudget } from "../sharing/tabsync.mjs";

const JOINER_NAV_MS = 15_000; // a joiner's change: until the host's tab starts loading it

export function createJoinerTabs({ getContext, idOf, tabsFor, humanQueue, shared, onJoinerPerson, onJoinerActivity, joinerKey, push, devUrl, devShare, secretDomains, log }) {
  async function applyTabs(body, j, heardAt = Date.now()) {
    const ctx = await getContext();
    const known = new Map(ctx.pages().map((p) => [idOf(p), p]));
    const { ops, problem } = readOps(body, new Set((await tabsFor(j)).tabs.map((t) => t.id)));
    if (problem) return { problem };
    const who = personLabel(j.name);
    const opened = {};
    await humanQueue(async () => {
      for (const o of ops) {
        if (o.op === "order") { await shared.arrange(o.ids.map((id) => known.get(id)).filter((p) => p && !p.isClosed())); continue; }
        const page = o.op === "open" ? await keepFocus(() => ctx.newPage()) : known.get(o.id);
        if (!page || page.isClosed()) continue;
        if (o.op === "person") { onJoinerPerson(page, j.name, o.did, o.acting, false, o.ago, heardAt); continue; }
        // Named by who the host knows them as (their join's name), never by what they send: a
        // joiner can't write lines as "Claude" or as someone else. Paced per joiner.
        if (o.op === "activity") {
          j.activityOk ??= activityBudget();
          if (j.activityOk()) onJoinerActivity(page, o.text, o.who ? `${cleanName(j.name)}'s agent` : who, joinerKey(j));
          continue;
        }
        if (o.op === "agent") { shared.onJoinerAgent(page, o.who, o.color, o.left, joinerKey(j), cleanName(j.name)); continue; }
        if (o.op === "form") {
          // Only on the same page; the host's own form reading then carries it to other joiners.
          const here = shareableUrl(devUrl(page.url()) || page.url());
          // was: the value both sides last had, so a card typed over it there clears it here.
          const fields = o.fields.map((x) => (x.m && x.filled ? { ...x, was: push.sharedValue(page, x.f, x.k) } : x));
          if (here === o.url && !onSecretDomain(page.url(), secretDomains())) await shared.applyForm(page, fields, cleanName(j.name));
          push.dirty(page); // on to the other joiners
          continue;
        }
        onJoinerPerson(page, j.name, [], true, true, 0, heardAt);
        if (o.op === "close") {
          // The last tab is emptied instead of closed, so the browser window stays open.
          if (ctx.pages().length > 1) await page.close().catch(() => {}); else await page.goto("about:blank").catch(() => {});
          continue;
        }
        if (o.op === "open") opened[o.ref] = idOf(page);
        // A shared dev server's address goes back to the dev server's own here.
        await page.goto(devShare?.toLocal(o.url) || o.url, { waitUntil: "commit", timeout: JOINER_NAV_MS }).catch((e) => log("joiner tab", e?.message || e));
      }
    });
    return { ok: true, opened };
  }
  return applyTabs;
}
