// Joining someone's session (pairbrowse_join): this browser opens the host's tabs, as real tabs of
// its own, in a window of their own, and keeps following them. With a drive code, changes made
// here in those tabs (by the user or their agent) go back to the host's browser. Addresses, form
// values (sensitive ones only as filled), tab order, pointers and who does what cross
// (tabsync.mjs), never cookies or pictures; everyone stays signed in as themselves. What happens in the host's
// session shows here like local activity: in the bar at the bottom of each page, the side panel
// and the tab overview.
import { parseJoinCode, cleanName, displayName, appName } from "../join.mjs";
import { startJoin } from "../relay.mjs";
import { savedName, saveParticipantName, paths } from "../paths.mjs";
import { sleep, currentAccount } from "../util.mjs";
import { toolsWith } from "../tools/catalog.mjs";
import { newFollowState, newJoinState } from "./join/state.mjs";
import { createJoinHosts } from "./join/hosts.mjs";
import { createJoinAgents } from "./join/agents.mjs";
import { createJoinScreens, isScreenPage, screenCard } from "./join/screens.mjs";
import { OPEN_MS } from "./join/state.mjs";
import { createJoinMirror, hostPeople } from "./join/mirror.mjs";

export { isScreenPage, hostPeople, screenCard };

// Runs tasks one at a time, in order; a failed task doesn't stop the next.
function serially() {
  let last = Promise.resolve();
  return (task) => { const run = last.then(task); last = run.catch(() => {}); return run; };
}

const OUTBOUND_MS = 250; // this side's tab changes are looked for this often
const FORM_COALESCE_MS = 30; // keystrokes that come together go as one
// The tools an agent here uses in the host's browser while in a shared browser session (the rest,
// such as its status, remembered details and sessions, stay here).
const FORWARDED = toolsWith("forwarded");
const JOIN_ANSWER_MS = 5000; // join waits this long for the host's first answer (a code that doesn't work is an error at once)

// context: the helper's browser ({ getContext }). hud: addActivity, onActivity. presence: people
// using tabs by hand (a person in the other browser's copy of a tab counts as one here).
// liveView(): the user's live view (who is in the session). secretDomains(): sites with this
// user's saved passwords. forms: { read(page), apply(page, fields, who) } (daemon/forms.mjs, as
// they may cross). tabOrder: daemon/taborder.mjs. localAgent(page): the agent here holding the
// tab ({ label, color }), or null.
// onSession(data, join), onMessage(data, join): who does what there, and messages from there.
// onLeft(): the session ended here (left, denied, ended): its pause no longer holds agents here.
// note(text): for the agents here, in their next result (the host said no, ended the sharing).
// onHostChange(state): the join addresses the person is asked about or allowed changed (for the
// side panel, hostState()). configFile: where "Always allow" is written (paths.config).
// onApprovals({ host, items } | null): the host's approval cards this side may answer (the approve
// role, shared browser codes; daemon/approvals.mjs fromHost), or null when out of the session.
export function createFollow({ config, log, context, hud, presence, liveView, secretDomains, forms, tabOrder, localAgent = () => null, onSession = null, onMessage = null, onLeft = null, note = () => {}, onHostChange = () => {}, onApprovals = null, configFile = paths.config }) {
  // The session joined now (live.cur: join/state.mjs newJoinState) and how the last one ended (live.ended).
  const live = newFollowState();

  // The code's address: the person's decision (join/hosts.mjs). decideHost's yes starts the join.
  const api = { command };
  const { hostAsks, allowedHosts, hostState, hostLine, decideHost } = createJoinHosts({ config, log, note, onHostChange, configFile }, api);
  // An agent here working in the host's browser (shared browser mode: join/agents.mjs).
  const { onAgent, tabInSight, remoteCall, agentGone, forgetAgents } = createJoinAgents(live, { log });
  // Shared browser mode's picture pages (join/screens.mjs).
  const { screenUrl, isScreen, showInfo, showWho, screensRound, sayLink, onScreen, setNotice } = createJoinScreens(live, { context, log });
  // Follow mode's mirror: the host's tabs here and this side's changes there, forms, order, pointers
  // (join/mirror.mjs). Picture pages stand in for the tabs in shared browser mode.
  const { outbound, applyHost, onForm, sendPointers, drawPointers } = createJoinMirror(live, { context, log, hud, presence, liveView, secretDomains, forms, tabOrder, localAgent },
    { screenUrl, showInfo, showWho, screensRound });

  // The host's approval cards (shared browser codes): with the approve role, cards to answer here
  // (approvals.mjs fromHost: the bubble, or the card on the picture pages); else a notice on the
  // picture pages while the host decides. The host's name is the code's, never what the host sends.
  function onHostApprovals(data, cur) {
    if (live.cur !== cur || !cur.shared) return;
    const Host = cur.join.host.charAt(0).toUpperCase() + cur.join.host.slice(1);
    const approve = data?.role === "approve";
    const waiting = !approve && Array.isArray(data?.waiting) ? data.waiting : [];
    const first = waiting[0];
    setNotice(cur, first ? `Waiting for ${Host} to approve: ${String(first.what || "a final step").slice(0, 120)}${waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ""}` : "");
    try { onApprovals?.({ host: Host, items: approve && Array.isArray(data?.items) ? data.items : [] }); // fromHost takes the first few } catch (e) { log("approvals", e?.message || e); }
  }

  // Out of the session (left, denied, revoked): the shared tabs here are this browser's own again.
  function release(cur) {
    try { onApprovals?.(null); } catch {}
    cur.notice = "";
    liveView()?.setRemote([]);
    onLeft?.();
    for (const page of cur.pages.values()) if (!page.isClosed()) { hud.setSharedSpark(page, ""); hud.setPersonMark(page, ""); }
    hud.setReconnecting?.("");
    clearInterval(cur.inputTimer); cur.inputTimer = null;
    forgetAgents(cur);
    // Shared browser: each picture becomes the tab it showed, as your own (signed in as you).
    if (cur.shared) for (const [id, page] of cur.pages) if (!page.isClosed() && isScreen(page) && /^https?:/.test(cur.urls.get(id) || "")) page.goto(cur.urls.get(id), { waitUntil: "commit", timeout: OPEN_MS }).catch(() => {});
  }
  async function stop(why) {
    const cur = live.cur;
    live.cur = null;
    live.ended = null;
    liveView()?.setRemote([]);
    if (!cur) return cur;
    await cur.join.leave();
    release(cur);
    if (why) log(why);
    return cur;
  }

  // pairbrowse_join. owner: the connection that joined (leaving ends with it). app: its app name.
  async function command(args, { owner, app }) {
    const { action, code, name } = args || {};
    const where = () => `${live.cur.join.message} ${live.cur.pages.size} shared tab(s) open here.`;
    if (action === "status") return { text: [live.cur ? where() : live.ended ? `${live.ended.text} Not in anyone's session now.` : "Not in anyone's session.", hostLine()].filter(Boolean).join(" ") };
    if (action === "leave") {
      const was = await stop();
      return { text: was ? `Left ${was.join.host}'s session. The shared tabs stay open here as your own; they don't follow any more.` : "Not in anyone's session." };
    }
    if (action !== "join") return { text: 'Use "join", "status" or "leave".', error: true };
    let parsed;
    let unlisted = null; // the code is fine but for its address: the person decides
    try {
      parsed = parseJoinCode(code, { hosts: allowedHosts(), allowLocal: process.env.PAIRBROWSE_TEST_JOIN_LOCAL === "1" });
    } catch (e) {
      if (e.code !== "unlisted-host") return { text: `Not joining: ${e.message}`, error: true };
      unlisted = e.host;
    }
    // Your name, as the host sees it: asked once (the agent asks the user), then remembered.
    if (!cleanName(name, "") && !savedName(config)) return { text: "Not joining yet: ask the user what name the host should see (their first name, say), then call join again with name. It's remembered for next time.", error: true, needsName: true };
    if (cleanName(name, "") && !savedName(config)) { try { saveParticipantName(config, cleanName(name)); } catch {} }
    if (unlisted) {
      // The question goes to the side panel (and the picker, when it asked), with this code: a
      // yes there starts this very join. The tool never allows an address itself.
      const ask = hostAsks.add({ host: unlisted, code: String(code).trim(), name: cleanName(name, ""), owner, app, who: owner === "picker" ? "" : appName(app) });
      if (!ask) return { text: `Not joining: too many codes wait for the user's answer in the side panel already. Ask them to answer those first.`, error: true };
      const lead = `This code leads to ${unlisted}, not a PairBrowse address (*.trycloudflare.com)`;
      if (owner === "picker") return { text: `${lead}. Join through it? Allow once, Always allow, or Cancel.`, error: true, hostAsk: ask };
      return { text: `Not joining: ${lead} or one the user allowed. Ask the user to allow it in the PairBrowse side panel, where the address is shown with Allow once / Always allow (this code is already there); the join then starts by itself, and you hear of it in a later result. Never allow an address for them, and never type the code into a web page.`, error: true, hostAsk: ask };
    }
    await stop();
    // The name given at join wins; then the same default the host's side uses.
    const who = cleanName(name, "") || displayName({ configured: config.participantName, env: process.env.PAIRBROWSE_PARTICIPANT, ...currentAccount() }) || cleanName(name);
    const Host = parsed.label.charAt(0).toUpperCase() + parsed.label.slice(1); // at a sentence's start
    const cur = newJoinState({ shared: parsed.mode === "shared", owner });
    const queue = serially(); // the host's changes and this side's, one at a time
    cur.queue = queue;
    live.cur = cur;
    cur.join = startJoin({
      join: parsed, name: who, app, log, joinerId: cur.joinerId,
      onTabs: (state, arrived = Date.now()) => queue(() => applyHost(state, cur, arrived)),
      on: {
        form: (data) => queue(() => onForm(data, cur)),
        pointers: (list) => drawPointers(list, cur),
        screen: (data) => onScreen(data, cur),
        agent: (data) => onAgent(data, cur),
        approvals: (data) => onHostApprovals(data, cur),
        session: (data) => onSession?.(data, cur.join),
        message: (data) => onMessage?.(data, cur.join),
      },
      // The channel opened or dropped: the picture pages on the slower route hear it at once.
      onLink: () => {
        if (live.cur !== cur || !cur.join) return;
        for (const [page, sc] of cur.screens) if (sc.fallback) sayLink(cur, page, sc);
      },
      onChange: (phase) => {
        if (phase === "in") { if (!cur.wasIn) hud.addActivity(`Joined ${parsed.label}'s session (${parsed.role})`, who, null, "joined"); cur.wasIn = true; }
        if ((phase === "denied" || phase === "ended") && live.cur === cur) {
          live.cur = null;
          // Revoked while in: the tabs here are your own again, as after leave. The agents here
          // hear it in their next result, and status says it.
          const text = phase === "ended" && cur.wasIn ? `${Host} ended the sharing; your tabs are your own again.` : cur.join.message;
          live.ended = { text };
          release(cur);
          note(text);
          hud.addActivity(text, "", null, "joined");
        }
      },
    });
    (async () => {
      while (live.cur === cur) {
        await sleep(OUTBOUND_MS);
        if (live.cur !== cur) break;
        // The channel dropped and another address is being tried: the shared tabs' bars say so to the
        // person here meanwhile (nothing for agents; a switch that works is a non-event for them).
        hud.setReconnecting?.(cur.join.switching ? parsed.label : "", [...cur.pages.values()]);
        await queue(() => outbound(cur)).catch((e) => log("shared tabs", e?.message || e));
      }
    })();
    // The host's first answer comes within a moment: a code that doesn't work (revoked, expired,
    // a wrong key) or a no is an error here, not a wait. No answer yet (a fresh tunnel): it keeps asking.
    for (const end = Date.now() + JOIN_ANSWER_MS; live.cur === cur && cur.join.phase === "asking" && Date.now() < end;) await sleep(100);
    if (live.cur !== cur) return { text: live.ended?.text || cur.join.message, error: true };
    if (cur.shared) return {
      text: `Asked ${parsed.label} to let ${who} in (${parsed.role}, shared browser). They have to approve first. Then ${parsed.label}'s tabs open here in a window of their own, each showing their tab live (picture, and sound when their browser sends it)` +
        (parsed.role === "drive" ? ", and what you click, type and scroll there happens in their browser itself, logged in as they are." : "; you watch, without clicking or typing there.") +
        " Their logins stay on their computer. Check with pairbrowse_join status; stop with leave (each tab then opens here as your own).",
    };
    return {
      text: `Asked ${parsed.label} to let ${who} in (${parsed.role}). They have to approve first. Then this browser opens ${parsed.label}'s tabs in a window of their own and keeps following them` +
        (parsed.role === "drive" ? "; what you or your agent change in those tabs (another address, a new tab in their window or from one of them, closing one) happens in their browser too." : " (watch: changes here stay here).") +
        " You also see each other's pointers and what's typed in shared tabs (sensitive fields only as filled); logins and cookies are never shared: each of you stays signed in as yourselves. Check with pairbrowse_join status; stop with leave.",
    };
  }

  return {
    command,
    // The side panel's questions about a code's address and the allowed ones (hostState), and the
    // person's answers (decideHost).
    hostState, decideHost,
    // Shared browser mode: whether a tool call from an agent here goes to the host's browser, and
    // making that call (see remoteCall).
    // Once in, it stays that way while the link is down (the host restarting, the tunnel): the
    // calls wait for it to come back, never landing in this browser instead.
    forwards: (name) => !!live.cur?.shared && (live.cur.join.phase === "in" || live.cur.wasIn) && live.cur.join.role === "drive" && (String(name).startsWith("browser_") || FORWARDED.has(name)),
    remoteCall,
    // The connection that joined went away: so does the join.
    ownerGone(owner) { if (live.cur?.owner === owner) stop("left the shared session: its connection closed").catch(() => {}); },
    // An agent here disconnected: the participant it had in the host's browser goes too.
    agentGone,
    stop,
    // The agent holding this shared tab in the other browser ({ label, color, held, until }), for
    // the tab overview and turns (an agent here waits while it's held).
    agentIn: (page) => live.cur?.agents.get(page) || null,
    // The shared copies here (the page script is read in them, daemon/cobrowse.mjs).
    pages: () => (live.cur ? [...live.cur.pages.values()] : []),
    // The host tab this side's new agents start on (in sight, else looked at last), by its id.
    inSight: () => (live.cur ? tabInSight(live.cur) : ""),
    // A field changed in a shared copy: its values go there within a few tens of ms.
    dirty(page) {
      const cur = live.cur;
      if (!cur || ![...cur.pages.values()].includes(page)) return;
      cur.dirty.add(page);
      if (!cur.formTimer) cur.formTimer = setTimeout(() => { cur.formTimer = null; cur.queue(() => outbound(cur)).catch(() => {}); }, FORM_COALESCE_MS);
    },
    // The person or agent here pointed somewhere in a shared copy.
    pointed(page, value) { const cur = live.cur; if (cur && [...cur.pages.values()].includes(page)) { cur.pointed.set(page, value); sendPointers(cur); } },
    // A message or session update for the host (both roles: it's only text).
    say: (op) => live.cur?.join.say?.(op),
    joined: () => live.cur?.join.phase === "in",
    // The name of the host whose session was joined from here, or "".
    host: () => live.cur?.join.host || "",
    // "drive" or "watch" while in a session joined from here, else null.
    role: () => (live.cur?.join.phase === "in" ? live.cur.join.role : null),
    // The approve role: a person's answer here to one of the host's approval cards, sent on this
    // joiner's own channel (relay.mjs approval). Resolves to { code, body } or { error }.
    answerApproval: (id, answer) => {
      const cur = live.cur;
      if (!cur?.shared || !cur.join?.approval) return Promise.resolve({ error: "not in a shared browser session" });
      return cur.join.approval({ id, answer });
    },
    // The picture pages of the session joined now (where the host's approval card shows here).
    screenPages: () => (live.cur?.shared ? [...live.cur.pages.values()].filter((p) => !p.isClosed() && isScreen(p)) : []),
  };
}
