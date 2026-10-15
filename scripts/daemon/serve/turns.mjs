// One connection's tab: which tab the agent works in (its own; another when that one closed),
// its browser server kept on that tab, and its turn there (a person in the tab goes first,
// another agent holding it is waited for briefly, else the call is refused).
import { keepFocus } from "../../focus.mjs";
import { GONE_MS } from "../../liveview/push.mjs";
import { isChromePage } from "../../rules/policy.mjs";
import { sleep, within } from "../../util.mjs";
import { waitForLink, waitedLine } from "../linkwait.mjs";

const FRONT_WAIT_MS = 5000; // for the side panel's worker to name the tab in front (a new agent's first tab; slow on a busy machine)
const TAB_WAIT_MS = 5000; // a tab another agent's turn frees within this is waited for
const TURN_ROUNDS = 40;

export function createTurns(conn, api) {
  const { collaboration, context, front, hud, internal, log, myLabel, personTab, presence, reconnecting, remoteHolder, reply, tabClaims } = api;
  const { fieldNotes, homes, lostWhy, noTab, participant, remote, traces, used } = conn;

  const tabList = async () => ((await internal("browser_tabs", { action: "list" })).result?.content || []).map((c) => c.text || "").join("\n");

  // The URL of this participant's server's current tab.
  const serverUrl = async () => (await tabList()).match(/\(current\)[^\n]*?\]\(([^)\s]+)\)/)?.[1] || null;

  const serverPage = async () => (conn.mine && !conn.mine.isClosed() && conn.serverAt === conn.mine ? conn.mine : context.pageAt(await serverUrl()));

  const openTabs = async () => (await context.ready()).pages();

  // The page a tab list marks current. Its numbers are the browser server's, which lists the
  // tabs in the order the browser opened them, as context.pages() does.
  async function currentIn(text) {
    const index = text.match(/^- (\d+): \(current\)/m)?.[1];
    return index === undefined ? null : (await openTabs())[Number(index)] || null;
  }

  function setMine(page) {
    if (conn.mine && conn.mine !== page) {
      const before = used.indexOf(conn.mine);
      if (before >= 0) used.splice(before, 1);
      used.push(conn.mine);
    }
    conn.mine = page;
    conn.lostTab = false;
    try { homes.set(context.sessionName(), page); } catch {}
  }

  // A tab no other agent is working in (its spark or turn), for when this one's tab closed.
  const othersTab = (page) => {
    const held = tabClaims.holder(page);
    const spark = hud.sparkOwner(page);
    return (held && held.id !== participant) || (spark && spark.id !== participant);
  };

  // Another agent in it (its turn or spark; release takes both), here or on another computer
  // of a shared session.
  const takenByOther = (page) => othersTab(page) || !!remoteHolder(page);

  async function freeTab() {
    for (const page of [...used].reverse()) if (!page.isClosed() && !othersTab(page) && !isChromePage(page.url()) && !personTab(page)) return page;
    const open = (await openTabs()).filter((page) => !page.isClosed() && !isChromePage(page.url()));
    conn.othersOpen = open.length;
    return open.find((page) => !othersTab(page) && !personTab(page)) || null;
  }

  // Moves this participant's browser server to its own tab, by that tab's number right now.
  async function syncServer() {
    if (!conn.mine || conn.mine.isClosed() || conn.serverAt === conn.mine) return;
    // Unknown, or a tab of a browser that has since closed (a session switch): the server lists
    // the tabs anew first (a select by number before that finds no such tab).
    if (!conn.serverAt || conn.serverAt.isClosed?.()) {
      conn.serverAt = await currentIn(await tabList());
      conn.tabsListed = true;
      if (conn.serverAt === conn.mine) return;
    }
    const index = (await openTabs()).indexOf(conn.mine);
    if (index < 0) return;
    const r = await keepFocus(() => internal("browser_tabs", { action: "select", index }));
    conn.serverAt = r.result?.isError ? null : conn.mine;
  }

  // After browser_tabs: the tab it opened or selected is its own; after closing its own tab it
  // goes back to the one it used before, or a tab no agent holds, never another agent's.
  async function followTabs(msg, action) {
    const text = () => msg.result.content.map((c) => c.text || "").join("\n");
    conn.serverAt = (await currentIn(text())) || (await currentIn(await tabList()));
    if (action === "new" || action === "select") {
      if (conn.serverAt) setMine(conn.serverAt);
      return;
    }
    if (action === "close") {
      if (!conn.mine || conn.mine.isClosed()) {
        const next = await freeTab();
        if (next) setMine(next);
        else { conn.mine = null; conn.lostTab = true; conn.noTabWhy = lostWhy(); }
      }
      await syncServer();
      // The list in the result shows the tab it now has, not the one the browser server picked.
      const lines = (await tabList()).match(/^- \d+:.*$/gm) || [];
      for (const part of msg.result.content) {
        if (part.type === "text" && /^- \d+:/m.test(part.text)) part.text = part.text.replace(/(^- \d+:.*$\n?)+/m, `${lines.join("\n")}\n`);
      }
    }
    // Without a tab of its own, none is its current one (its server's is another agent's).
    if (!conn.lostTab && !(remote && !conn.mine)) return;
    for (const part of msg.result.content) if (part.type === "text") part.text = part.text.replace(/^(- \d+:) \(current\)/gm, "$1");
    msg.result.content.push({ type: "text", text: `\n### PairBrowse\n- ${noTab()}` });
  }

  // Browser actions wait until saved tabs are back, then start on the tab the user was on.
  async function whenReady() {
    await context.ready();
    const want = context.takeRestoredActive();
    if (!want) return;
    const index = (await tabList()).split("\n").find((l) => l.includes(`](${want})`))?.match(/^- (\d+):/)?.[1];
    if (index !== undefined) { await internal("browser_tabs", { action: "select", index: Number(index) }); conn.serverAt = null; }
  }

  // The tab this participant acts in: its own (see mine). Closed by someone else: the one it
  // used before or a free one. None yet: the tab its browser server starts on.
  async function myTab() {
    if (conn.mine && !conn.mine.isClosed() && !personTab(conn.mine)) return conn.mine;
    if (conn.lostTab) return null;
    if (conn.mine) {
      // Its own tab came back as a new page (its session's browser restarted: a switch and
      // back): that one, the same tab, never another agent's on the same address.
      let session = "";
      try { session = context.sessionName(); } catch {}
      const back = [homes.get(session), conn.mine].map((p) => (p && !p.isClosed() ? p : context.successorOf?.(p))).find(Boolean);
      if (back && !takenByOther(back) && !personTab(back)) { setMine(back); return conn.mine; }
      const next = await freeTab();
      if (next) setMine(next);
      else { conn.mine = null; conn.lostTab = true; conn.noTabWhy = lostWhy(); }
      return conn.mine;
    }
    await whenReady();
    conn.serverAt = await currentIn(await tabList());
    conn.tabsListed = true;
    // A joiner's agent starts on the tab its person looks at, and takes its turn there like any
    // agent (it waits, or hears the tab is in use, and tries that tab again next time). Without
    // one, a tab no other agent is in, else one no agent holds now; never its browser server's
    // tab by chance. None: it asks again on its next call.
    if (remote) {
      const start = remote.startPage && !remote.startPage.isClosed() && !personTab(remote.startPage) ? remote.startPage : null;
      const unheld = (page) => !page.isClosed() && !isChromePage(page.url()) && !personTab(page) && !(tabClaims.holder(page) && tabClaims.holder(page).id !== participant);
      const page = start || await freeTab() || (await openTabs()).findLast(unheld);
      if (page) { remote.startPage = null; remote.started = true; setMine(page); }
      else conn.noTabWhy = "every tab here is in use by another agent";
      return conn.mine;
    }
    // Its first tab: the one the person looks at (or looked at last), unless another agent is
    // in it; else its browser server's tab when free, else any free tab. Every tab taken: its
    // browser server's, where it hears "in use".
    const looked = await within(FRONT_WAIT_MS, front().catch(() => null));
    const start = [looked, conn.serverAt].find((p) => p && !p.isClosed() && !takenByOther(p) && !isChromePage(p.url()) && !personTab(p))
      || (await openTabs()).find((p) => !p.isClosed() && !takenByOther(p) && !isChromePage(p.url()) && !personTab(p)) || (conn.serverAt && !personTab(conn.serverAt) ? conn.serverAt : null);
    if (start) setMine(start);
    return conn.mine;
  }

  // Per-tab turns. A person clicking or typing in the tab goes first (moving the pointer or
  // scrolling holds nobody up): wait outside the shared queue, so agents in other tabs carry
  // on. Another agent holding the tab, here or on another computer of a shared session: wait a
  // moment if its turn is about to end, else refuse; never act in this copy meanwhile.
  async function takeTurn(dispatch, id, tool) {
    for (let round = 0; ; round++) {
      const page = await myTab();
      // A joiner's agent never acts without a tab of its own (it would act in someone else's).
      if (!page && (conn.lostTab || remote)) { reply(id, noTab(), true); return; }
      // A joiner's connection is moving to another address: the agents here hold their tab work
      // until it's back (a few seconds, as a rule), so nothing happens while that person can't see.
      // A longer hold is said in one line; reads never come here. Never a joiner's own call
      // because of that joiner's reconnect: it came in on their channel, and only they wait for it.
      const down = () => reconnecting(remote?.key);
      const lostName = down();
      if (lostName) {
        const held = await waitForLink(down, { max: GONE_MS + 5000 });
        log(`${tool} waited ${held} ms for ${lostName}'s connection`);
        const line = waitedLine(held, `${lostName}'s connection`);
        if (line) fieldNotes.push(line);
      }
      const who = presence.actingIn(page), waitFrom = Date.now();
      await presence.waitForUser(page);
      if (who && Date.now() - waitFrom > 300) log(`${tool} waited ${Date.now() - waitFrom} ms for ${who} using the tab`);
      const r = await collaboration.run(participant, async () => {
        if (page && page.isClosed()) return { again: true };
        if (presence.actingIn(page)) return { again: true };
        // Numbered as browser_tabs select takes it.
        const busy = (label) => reply(id, `Tab ${page.context().pages().indexOf(page)} is in use by ${label}. Open or select another tab (browser_tabs), or wait and retry. If your user means you to work in this tab with ${label} (said or clear from their request, such as helping with or checking its work here), join it: pairbrowse_collaboration share (you then take turns). To work at the same time in an app that keeps everyone in sync (a whiteboard, a design file, a shared doc), open the same address in a tab of your own.`, true);
        // A joiner's agent yields to the host's agent that already holds the tab here (a tie
        // when both started at once); else the other computer's agent goes first.
        const remote = page && remoteHolder(page);
        if (remote && !(remote.yields && tabClaims.holder(page)?.id === participant)) {
          const left = remote.until - Date.now();
          if (left < TAB_WAIT_MS && round < 3) return { waitMs: Math.max(250, left + 100) };
          busy(remote.label);
          return { done: true };
        }
        const c = tabClaims.claim(page, participant, myLabel());
        if (!c.ok) {
          const left = c.holder.until - Date.now();
          if (left < TAB_WAIT_MS && round < 3) return { waitMs: left + 100 };
          busy(c.holder.label);
          return { done: true };
        }
        conn.actingIn = page;
        traces.get(id)?.mark("turn");
        try { await dispatch(); } finally { conn.actingIn = null; }
        return { done: true };
      }, page); // its tab's lane: agents in other tabs go on at the same time
      if (r.done) return;
      if (r.waitMs) await sleep(r.waitMs);
      if (round > TURN_ROUNDS) { reply(id, "The tab stayed busy. Retry in a moment.", true); return; }
    }
  }

  return { tabList, serverUrl, serverPage, openTabs, currentIn, setMine, othersTab, takenByOther, freeTab, syncServer, followTabs, whenReady, myTab, takeTurn };
}
