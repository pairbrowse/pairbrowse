// Joining someone's session (pairbrowse_join): this browser opens the host's tabs, as real tabs of
// its own, in a window of their own, and keeps following them. With a drive code, changes made
// here in those tabs (by the user or their agent) go back to the host's browser. Addresses, form
// values (sensitive ones only as filled), tab order, pointers and who does what cross
// (tabsync.mjs), never cookies or pictures; everyone stays signed in as themselves. What happens in the host's
// session shows here like local activity: in the bar at the bottom of each page, the side panel
// and the tab overview.
import { userInfo } from "node:os";
import { parseJoinCode, cleanName } from "../join.mjs";
import { startJoin } from "../relay.mjs";
import { createMirror, createFormSync, createOrderSync, sameOrder, readForm, readPointer, formUrl, onSecretDomain, shareableUrl, TABS_MAX, OPS_MAX } from "../tabsync.mjs";
import { keepFocus } from "../focus.mjs";
import { sleep } from "../util.mjs";

// Runs tasks one at a time, in order; a failed task doesn't stop the next.
function serially() {
  let last = Promise.resolve();
  return (task) => { const run = last.then(task); last = run.catch(() => {}); return run; };
}

const OPEN_MS = 15_000;
const ADOPT_MS = 10_000; // a tab opened from a shared one has this long to get a web address
const FIRST_ACTIVITY = 3; // on joining, the last few things that happened
const FORM_BYTES = 60_000; // form values read here in one round, before it's sent
const AGENT_AGAIN_MS = 10_000; // an agent here is said again this often (the other side forgets it)
const POINTER_FRESH_MS = 3000; // a pointer still for this long fades out
const POINTER_MS = 40; // pointers go out at most 25 times a second
const PERSON_AGAIN_MS = 500;
const FORMS_ALL_MS = 2000; // every field is read again this often, in case a change went unannounced
const ORDER_MS = 1000; // the tab order here is checked this often
const OUTBOUND_MS = 250; // this side's tab changes are looked for this often
const FORM_COALESCE_MS = 30; // keystrokes that come together go as one
// Logs how long pointers and field values took from the other side's page (for the live check).
const latencyLog = process.env.PAIRBROWSE_LATENCY_LOG === "1";

// context: the helper's browser ({ getContext }). hud: addActivity, onActivity. presence: people
// using tabs by hand (a person in the other browser's copy of a tab counts as one here).
// liveView(): the user's live view (who is in the session). secretDomains(): sites with this
// user's saved passwords. forms: { read(page), apply(page, fields, who) } (daemon/forms.mjs, as
// they may cross). tabOrder: daemon/taborder.mjs. localAgent(page): the agent here holding the
// tab ({ label, color }), or null.
// onSession(data, join), onMessage(data, join): who does what there, and messages from there.
export function createFollow({ config, log, context, hud, presence, liveView, secretDomains, forms, tabOrder, localAgent = () => null, onSession = null, onMessage = null }) {
  let s = null; // { join, mirror, pages: Map id -> page, owner, window, lastT, candidates, seen, heard, told, agents, outbox }
  const idOf = (cur, page) => { for (const [id, p] of cur.pages) if (p === page) return id; return null; };

  // This browser's agents' activity in a shared tab goes to the other browser (drive), like its
  // address changes. What came from there is marked and never goes back.
  hud.onActivity((text, who, page, from) => {
    const cur = s;
    if (!cur || from || !page || cur.join.role !== "drive") return;
    const id = idOf(cur, page);
    if (id && cur.outbox.length < OPS_MAX) cur.outbox.push({ op: "activity", id, text, who });
  });

  const pageId = async (ctx, page) => {
    const cdp = await ctx.newCDPSession(page);
    try { return (await cdp.send("Target.getTargetInfo")).targetInfo.targetId; } finally { cdp.detach().catch(() => {}); }
  };

  // A new tab at url: the first one in a new window, the next ones next to it (the browser puts
  // a new tab in the window used last). Found by its target id, so another tab opening at the
  // same moment (an agent's) is never taken for it.
  async function openTab(url) {
    const ctx = await context.getContext();
    const before = new Set(ctx.pages());
    const any = ctx.pages().find((p) => !p.isClosed());
    try {
      if (!any) throw new Error("no tab to ask from");
      const cdp = await ctx.newCDPSession(any);
      let targetId;
      try { ({ targetId } = await cdp.send("Target.createTarget", { url, newWindow: !s.window, background: !!s.window })); } finally { cdp.detach().catch(() => {}); }
      const until = Date.now() + OPEN_MS;
      while (Date.now() < until) {
        for (const p of ctx.pages()) if (!before.has(p) && !p.isClosed() && (await pageId(ctx, p).catch(() => "")) === targetId) { s.window = true; return p; }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("the new tab didn't show up");
    } catch (e) {
      log("shared tab", e?.message || e);
      const page = await keepFocus(() => ctx.newPage());
      await page.goto(url, { waitUntil: "commit", timeout: OPEN_MS }).catch(() => {});
      return page;
    }
  }

  async function closeTab(page) {
    const ctx = await context.getContext();
    if (ctx.pages().length > 1) await page.close().catch(() => {}); else await page.goto("about:blank").catch(() => {});
  }

  // What changed here goes there (drive): run a few times a second, and at once when a field
  // changed. A watcher's changes stay here (their fields are still read: values from there
  // never land on top of what the person here is typing).
  async function outbound(cur) {
    if (s !== cur || cur.join.phase !== "in") return;
    const drive = cur.join.role === "drive";
    const ctx = await context.getContext();
    const mine = { full: drive, secretDomains: secretDomains() };
    const ops = [];
    for (const [id, page] of cur.pages) {
      if (page.isClosed()) { cur.pages.delete(id); const op = cur.mirror.closedHere(id); if (drive && op) ops.push(op); continue; }
      const op = cur.mirror.fromLocal(id, shareableUrl(page.url(), mine));
      if (drive && op) ops.push(op);
      // A person here, using this copy by hand: agents there wait for them too (drive only).
      const person = presence.sharedPerson(page);
      if (drive && person?.local) {
        const fresh = presence.feedAfter(page, cur.told.get(page) || 0).filter((e) => e.local);
        if (fresh.length) cur.told.set(page, fresh.at(-1).n);
        // Still there: said again twice a second (the host's agents wait while it's fresh).
        if (fresh.length || Date.now() - (cur.personSent.get(id) || 0) >= PERSON_AGAIN_MS) {
          cur.personSent.set(id, Date.now());
          ops.push({ op: "person", id, did: fresh.map((e) => e.line) });
        }
      }
    }
    // Values typed here (sensitive ones only as filled), read at most every few hundred ms per
    // tab; and the agents here (drive). A watcher's stay here; reading them still keeps values
    // from there from landing on top of what the person here is typing.
    let formBytes = 0;
    const all = Date.now() - cur.formsAllAt > FORMS_ALL_MS; // in case a change went unannounced
    if (all) cur.formsAllAt = Date.now();
    for (const [id, page] of cur.pages) {
      if (page.isClosed() || cur.quiet.has(id) || formBytes > FORM_BYTES || !(all || cur.dirty.has(page))) continue;
      cur.dirty.delete(page);
      const read = await forms.read(page).catch(() => null);
      if (!read) continue;
      const changed = cur.forms.local(id, read.url, read.fields);
      if (drive && changed.length) { const op = { op: "form", id, url: read.url, fields: changed }; formBytes += JSON.stringify(op).length; ops.push(op); }
    }
    if (drive) {
      for (const [id, page] of cur.pages) {
        if (page.isClosed() || cur.quiet.has(id)) continue;
        const a = localAgent(page);
        const sig = a ? `${a.label}\u0001${a.color}` : "";
        const was = cur.agentSent.get(id);
        if ((was?.sig ?? "") === sig && !(sig && Date.now() - was.at > AGENT_AGAIN_MS)) continue;
        cur.agentSent.set(id, { sig, at: Date.now() });
        ops.push({ op: "agent", id, who: a?.label || "", color: a?.color || "" });
      }
    }
    if (Date.now() - (cur.orderAt || 0) > ORDER_MS) await checkOrder(cur);
    await applyForms(cur); // values from there whose page has loaded here since
    ops.push(...cur.outbox.splice(0));
    // Tabs opened from a shared tab (a link to a new tab, a popup) are shared too.
    const adopting = [];
    if (drive) {
      const mapped = new Set(cur.pages.values());
      for (const p of ctx.pages()) {
        if (mapped.has(p) || p.isClosed() || cur.seen.has(p)) continue;
        let since = cur.candidates.get(p);
        if (since === undefined) { const opener = await p.opener().catch(() => null); since = opener && mapped.has(opener) ? Date.now() : -1; }
        if (since < 0 || Date.now() - since > ADOPT_MS) { cur.seen.add(p); cur.candidates.delete(p); continue; }
        cur.candidates.set(p, since);
        const url = shareableUrl(p.url(), mine);
        if (!url || cur.pages.size + adopting.length >= TABS_MAX) continue;
        const op = cur.mirror.opening(url);
        ops.push(op);
        adopting.push({ op, page: p });
        cur.seen.add(p);
        cur.candidates.delete(p);
      }
    }
    if (ops.length) {
      let answer = null;
      for (let i = 0; i < ops.length; i += OPS_MAX) {
        const r = await cur.join.send(ops.slice(i, i + OPS_MAX));
        if (r) answer = { ...r, opened: { ...answer?.opened, ...r.opened } };
      }
      for (const { op, page } of adopting) if (answer?.opened?.[op.ref] && cur.mirror.opened(answer.opened[op.ref], op.url)) cur.pages.set(answer.opened[op.ref], page);
    }
  }

  // A move made here goes there (drive); else the host's order applies here.
  async function checkOrder(cur) {
    cur.orderAt = Date.now();
    const live = [...cur.pages].filter(([, p]) => !p.isClosed());
    if (live.length < 2) return;
    const sorted = await tabOrder.order(live.map(([, p]) => p)).catch(() => null);
    if (!sorted || s !== cur) return;
    const ids = sorted.map((p) => idOf(cur, p));
    const r = cur.order.fromLocal(ids);
    if (r.send && cur.join.role === "drive") cur.outbox.push(r.send);
    if (r.arrange && !sameOrder(ids, r.arrange) && await tabOrder.arrange(r.arrange.map((id) => cur.pages.get(id))).catch(() => false)) cur.order.arranged(r.arrange);
  }

  // The host's tabs as they changed (pushed): applied here.
  async function applyHost(state, cur) {
    if (s !== cur) return;
    const drive = cur.join.role === "drive";

    const plan = cur.mirror.fromHost(state.tabs, new Set(cur.pages.keys()));
    for (const id of plan.close) { const page = cur.pages.get(id); cur.pages.delete(id); if (page) await closeTab(page); }
    for (const { id, url } of plan.navigate) {
      const page = cur.pages.get(id);
      await page?.goto(url, { waitUntil: "commit", timeout: OPEN_MS }).catch((e) => log("shared tab", e?.message || e));
      cur.mirror.applied(id);
    }
    for (const { id, url } of plan.open) {
      if (s !== cur) return;
      const page = await openTab(url);
      cur.pages.set(id, page);
      cur.seen.add(page);
      cur.mirror.applied(id);
    }

    // Tabs that cross as addresses only (the host's secret domains): nothing else about them.
    cur.quiet = new Set((Array.isArray(state.tabs) ? state.tabs : []).filter((t) => t && t.title === undefined).map((t) => t.id));

    // The same order as there.
    const hostOrder = (Array.isArray(state.tabs) ? state.tabs : []).map((t) => t?.id);
    if (JSON.stringify(hostOrder) !== cur.hostOrderSig) { cur.hostOrderSig = JSON.stringify(hostOrder); cur.order.fromHost(hostOrder); await checkOrder(cur); }

    // Values from there that waited for their page to load here.
    await applyForms(cur);

    // Who is in each tab there: a person using it by hand counts as one here (agents here wait,
    // then hear what they did: names of fields and buttons, never values); the agent holding it
    // shows in the tab overview.
    cur.agents = new Map();
    for (const t of Array.isArray(state.tabs) ? state.tabs : []) {
      const page = cur.pages.get(t.id);
      if (!page || page.isClosed()) continue;
      if (t.agent) cur.agents.set(page, { label: String(t.agent).slice(0, 60), color: /^#[0-9a-f]{6}$/i.test(t.color || "") ? t.color : "" });
      // Their agent's spark, in its color, on the copy here too.
      hud.setSharedSpark(page, t.agent ? (/^#[0-9a-f]{6}$/i.test(t.color || "") ? t.color : "#e9763f") : "");
      const first = !cur.heard.has(t.id);
      const heard = cur.heard.get(t.id) || 0;
      const did = (Array.isArray(t.did) ? t.did : []).filter((e) => Number(e.n) > heard);
      cur.heard.set(t.id, did.length ? Math.max(...did.map((e) => Number(e.n) || 0)) : heard);
      if (first) continue; // on joining, what was done before isn't news
      for (const e of did) presence.elsewhere(page, String(e.who || cur.join.host), [e.line]);
      if (t.person && !did.length) presence.elsewhere(page, String(t.person), []);
    }

    // What happens there shows here, like local activity.
    const fresh = (Array.isArray(state.activity) ? state.activity : []).filter((a) => a.t > cur.lastT);
    for (const a of cur.lastT ? fresh : fresh.slice(-FIRST_ACTIVITY)) hud.addActivity(a.text, a.who || cur.join.host, cur.pages.get(a.tabId) || null, "joined");
    if (fresh.length) cur.lastT = Math.max(...fresh.map((a) => a.t));
    liveView()?.setRemote((Array.isArray(state.people) ? state.people : []).map((label) => ({ label: `${label} (${cur.join.host}'s session)`, role: cur.join.role })));
  }

  // Pointers: this side's (the person's, the agents') go there as they move, up to 25 times a
  // second; theirs come on the stream and are drawn in the copies here. Positions only, never
  // what's under them, and nothing for tabs on secret domains (either side's).
  function sendPointers(cur) {
    if (s !== cur || cur.pointerTimer) return;
    cur.pointerTimer = setTimeout(async () => {
      cur.pointerTimer = null;
      const fresh = (p) => p && Date.now() - Number(p.t) < POINTER_FRESH_MS;
      let me = null;
      const agents = [];
      for (const [id, page] of cur.pages) {
        const r = cur.pointed.get(page);
        if (!r || page.isClosed() || cur.quiet.has(id) || onSecretDomain(page.url(), secretDomains()) || !shareableUrl(page.url())) continue;
        if (fresh(r.me) && (!me || r.me.t > me.t)) me = { id, x: r.me.x, y: r.me.y, t: r.me.t };
        const a = localAgent(page);
        if (a && fresh(r.agent)) agents.push({ id, x: r.agent.x, y: r.agent.y, who: a.label, color: a.color });
      }
      const sig = JSON.stringify([me && [me.id, me.x, me.y], agents]);
      if (sig === cur.pointerSig) return;
      cur.pointerSig = sig;
      await cur.join.pointer({ me: me && { id: me.id, x: me.x, y: me.y }, agents, t: me?.t || Date.now() });
    }, Math.max(0, POINTER_MS - (Date.now() - (cur.pointerAt || 0))));
    cur.pointerAt = Date.now();
  }
  function drawPointers(list, cur) {
    if (s !== cur) return;
    const ids = new Set([...cur.pages.keys()].filter((id) => !cur.quiet.has(id)));
    const byPage = new Map();
    for (const raw of (Array.isArray(list) ? list : []).slice(0, 24)) {
      const p = readPointer(raw, ids);
      const page = p && cur.pages.get(p.id);
      if (!page || page.isClosed() || !p.who || typeof raw.k !== "string") continue;
      if (latencyLog && Number(raw.t)) log(`latency pointer ${Date.now() - Number(raw.t)} ms`);
      byPage.set(page, [...(byPage.get(page) || []), { k: raw.k.slice(0, 100), who: p.who, color: p.color || "#e9763f", x: p.x, y: p.y }]);
    }
    for (const page of cur.drawn) if (!byPage.has(page) && !page.isClosed()) hud.showPointers(page, []);
    cur.drawn = new Set(byPage.keys());
    for (const [page, l] of byPage) hud.showPointers(page, l);
  }

  // Values typed there show in the same fields here (only on the same page).
  async function applyForms(cur, only = null) {
    for (const [id, page] of cur.pages) {
      if ((only && id !== only) || page.isClosed() || cur.quiet.has(id) || onSecretDomain(page.url(), secretDomains())) continue;
      const list = cur.forms.toApply(id, formUrl(page.url()));
      if (!list.length) continue;
      cur.forms.applied(id, await forms.apply(page, list, cur.join.host).catch(() => []));
      if (latencyLog && cur.formT.get(id)) log(`latency form ${Date.now() - cur.formT.get(id)} ms`);
    }
  }
  async function onForm(data, cur) {
    if (s !== cur || !cur.pages.has(data?.id)) return;
    cur.forms.remote(data.id, readForm(data));
    cur.formT.set(data.id, Number(data.t) || 0);
    await applyForms(cur, data.id);
  }

  async function stop(why) {
    const cur = s;
    s = null;
    liveView()?.setRemote([]);
    if (cur) for (const page of cur.pages.values()) if (!page.isClosed()) hud.setSharedSpark(page, "");
    if (cur) await cur.join.leave();
    if (cur && why) log(why);
    return cur;
  }

  // pairbrowse_join. owner: the connection that joined (leaving ends with it). app: its app name.
  async function command(args, { owner, app }) {
    const { action, code, name } = args || {};
    const where = () => `${s.join.message} ${s.pages.size} shared tab(s) open here.`;
    if (action === "status") return { text: s ? where() : "Not in anyone's session." };
    if (action === "leave") {
      const was = await stop();
      return { text: was ? `Left ${was.join.host}'s session. The shared tabs stay open here as your own; they don't follow any more.` : "Not in anyone's session." };
    }
    if (action !== "join") return { text: 'Use "join", "status" or "leave".', error: true };
    let parsed;
    try {
      parsed = parseJoinCode(code, { hosts: Array.isArray(config.joinHosts) ? config.joinHosts.map((h) => String(h).toLowerCase()) : [], allowLocal: process.env.PAIRBROWSE_TEST_JOIN_LOCAL === "1" });
    } catch (e) {
      return { text: `Not joining: ${e.message}`, error: true };
    }
    await stop();
    const who = cleanName(name || config.participantName || process.env.PAIRBROWSE_PARTICIPANT || userInfo().username);
    const cur = { mirror: createMirror(), pages: new Map(), owner, window: false, lastT: 0, candidates: new Map(), seen: new WeakSet(), heard: new Map(), told: new WeakMap(), agents: new Map(), outbox: [],
      forms: createFormSync(), order: createOrderSync(), quiet: new Set(), agentSent: new Map(), personSent: new Map(), dirty: new Set(), formsAllAt: 0,
      formT: new Map(), pointed: new WeakMap(), pointerTimer: null, pointerSig: "", drawn: new Set(), formTimer: null };
    const queue = serially(); // the host's changes and this side's, one at a time
    cur.queue = queue;
    s = cur;
    cur.join = startJoin({
      join: parsed, name: who, app, log,
      onTabs: (state) => queue(() => applyHost(state, cur)),
      on: {
        form: (data) => queue(() => onForm(data, cur)),
        pointers: (list) => drawPointers(list, cur),
        session: (data) => onSession?.(data, cur.join),
        message: (data) => onMessage?.(data, cur.join),
      },
      onChange: (phase) => {
        if (phase === "in") hud.addActivity(`Joined ${parsed.label}'s session (${parsed.role})`, who, null, "joined");
        if ((phase === "denied" || phase === "ended") && s === cur) { s = null; liveView()?.setRemote([]); hud.addActivity(cur.join.message, "", null, "joined"); }
      },
    });
    (async () => { while (s === cur) { await sleep(OUTBOUND_MS); if (s === cur) await queue(() => outbound(cur)).catch((e) => log("shared tabs", e?.message || e)); } })();
    return {
      text: `Asked ${parsed.label} to let ${who} in (${parsed.role}). They have to approve first. Then this browser opens ${parsed.label}'s tabs in a window of their own and keeps following them` +
        (parsed.role === "drive" ? "; what you or your agent change in those tabs (another address, a new tab from one of them, closing one) happens in their browser too." : " (watch: changes here stay here).") +
        " You also see each other's pointers and what's typed in shared tabs (sensitive fields only as filled); logins and cookies are never shared: each of you stays signed in as yourselves. Check with pairbrowse_join status; stop with leave.",
    };
  }

  return {
    command,
    // The connection that joined went away: so does the join.
    ownerGone(owner) { if (s?.owner === owner) stop("left the shared session: its connection closed").catch(() => {}); },
    stop,
    // The agent holding this shared tab in the other browser, for the tab overview.
    agentIn: (page) => s?.agents.get(page) || null,
    // The shared copies here (the page script is read in them, daemon/cobrowse.mjs).
    pages: () => (s ? [...s.pages.values()] : []),
    // A field changed in a shared copy: its values go there within a few tens of ms.
    dirty(page) {
      const cur = s;
      if (!cur || ![...cur.pages.values()].includes(page)) return;
      cur.dirty.add(page);
      if (!cur.formTimer) cur.formTimer = setTimeout(() => { cur.formTimer = null; cur.queue(() => outbound(cur)).catch(() => {}); }, FORM_COALESCE_MS);
    },
    // The person or agent here pointed somewhere in a shared copy.
    pointed(page, value) { const cur = s; if (cur && [...cur.pages.values()].includes(page)) { cur.pointed.set(page, value); sendPointers(cur); } },
    // A message or session update for the host (both roles: it's only text).
    say: (op) => s?.join.say?.(op),
    joined: () => s?.join.phase === "in",
  };
}
