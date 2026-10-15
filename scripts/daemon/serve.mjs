// One connected agent (Claude Code, Codex, any MCP client, or a joiner's agent): its own
// Playwright MCP server on the shared browser, with PairBrowse's rules in front of every call and
// its own notes, masking and screenshot added to every result.
import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { paths } from "../paths.mjs";
import { BLOCKED_TOOLS, HIDDEN_TOOLS } from "../rules/policy.mjs";
import { appName, personLabel, computerName } from "../join.mjs";
import { describe } from "../log.mjs";
import { decide, approvalAsk } from "../rules/decide.mjs";
import { keepFocus } from "../focus.mjs";
// pathsIn and withPaths live in upload.mjs now; kept here for one release.
export { pathsIn, withPaths } from "../upload.mjs";
import { within } from "../util.mjs";
import { stopRequestMirroring } from "./browser/tabs.mjs";
import { plainError } from "./output.mjs";
import { PAIRBROWSE_TOOLS, TAB_TOOLS, PAGE_READ_TOOLS, NO_PICK_WAIT, changesPage, wellFormed, withDialogLabel, containsRef, pictureless } from "./serve/wire.mjs";
import { arrivedAt } from "./serve/pageread.mjs";
import { isFileTab, createRefusals } from "./serve/refuse.mjs";
import { createConnectionState } from "./serve/connection.mjs";
import { createTurns } from "./serve/turns.mjs";
import { createOwnTools } from "./serve/tools/index.mjs";
import { createHandle } from "./serve/rewrite.mjs";
import { createCollaborationTool } from "./serve/collaboration.mjs";
import { createResult, TRACING, phaseTrace } from "./serve/result.mjs";
// The pure parts live in serve/; kept here for one release (tests and older imports name serve.mjs).
export { wellFormed, forJoiner, pictureless, dropClosedAlerts } from "./serve/wire.mjs";
export { arrivedAt } from "./serve/pageread.mjs";
export { tabRefusal } from "./serve/refuse.mjs";

const PICK_WAITING = "Nothing was done: the PairBrowse browser is waiting for the person to pick a session (its first tab asks: continue a saved session, start a fresh one, or join a shared one). " +
  "Ask them in chat which they want, then use pairbrowse_session (use, or new with clean: true) or pairbrowse_join; or retry once they've picked.";

// Playwright MCP's own pause after each action (see createConnection): config.settleMs overrides.
const MCP_SETTLE_DEFAULT_MS = 200;
const STALLED_MS = 30_000; // a disconnected participant's action may run this long
// The most one call may hold the shared queue. Past it the browser is reset (as for a stalled
// client that left), so one stuck call can't keep every other agent on this computer waiting.
const TURN_MAX_MS = Number(process.env.PAIRBROWSE_TURN_MAX_MS) || 10 * 60_000;
const TURN_MAX = TURN_MAX_MS >= 60_000 ? `${Math.round(TURN_MAX_MS / 60_000)} minutes` : `${Math.round(TURN_MAX_MS / 1000)} seconds`;

// deps: the helper's parts (see daemon.mjs). Returns serve(sock, { remote }): runs one participant
// on a socket until it closes. remote ({ name, key, files, startPage }): a joiner's agent working
// in this browser (shared browser mode): no OK it gives counts as the host's, no saved passwords,
// remembered details, sessions or invites, files only from its own folder (files), and it starts
// on startPage (the tab its person looks at).
export function createServe({ config, log, host, createConnection, clients, collaboration, tabClaims, context, hud, presence, popups, output,
  screenshots, secrets, facts, sharing, follow, pause, drainHostNotes, remoteHolder = () => null, reconnecting = () => null, front = async () => null, revision, bumpRevision, session, shareMessage = () => {}, recorder = null, tabNames = { strip: (t) => t }, journal = { status() {}, ranLeft() {} }, timeline = null, testTools = {}, clickApprovals = null, outlines = null, onRunStatus = () => {}, personTabs = { has: () => false } }) {
  const secretNames = () => Object.keys(secrets.get().values);
  // The person's own tabs (a file they opened from Downloads): no agent's tab, ever.
  const personTab = (p) => !!p && (!!personTabs.has(p) || isFileTab(p));
  // What PairBrowse declares it is about to press (an agent's click, a fast-mode step, the popup
  // closer's dismiss button) counts as where an agent pointed: a press there is never a person's.
  hud.onPress?.((page, at) => presence.agentPointed(page, at));
  // The popup closer's own click: its button is declared to the page first (hud.pressOn), so the
  // press is PairBrowse's own, not the person's, however far from the agent's cursor it lands; and
  // it runs as PairBrowse's "popup" action, also after a tool that only reads (a snapshot has no
  // action span of its own, and its tidy pass closes banners too).
  const declare = (page, el) => hud.pressOn(page, el);
  const closing = { declare, clicking: () => presence.busyStart("popup") };
  // When each session last called a tool: only the ones in use hold up a session switch or closing
  // the browser. An open but idle session (a Claude Code window left for hours) doesn't.
  const lastCall = new Map();
  const ACTIVE_MS = Number(process.env.PAIRBROWSE_TEST_ACTIVE_MS) || 10 * 60_000; // (tests: shorter)

  // Each session's browser server (Playwright MCP) listens for the browser closing (once "close"
  // on the context, once "disconnected" on its browser) and never stops listening, so every session that came and went would stay in
  // memory with the browser (about 1 MB each). The browser is handed to one session's server at
  // a time; the listener its server adds right then is noted, and removed when the session ends.
  let handing = Promise.resolve();
  const ENDS = [["close", (ctx) => ctx], ["disconnected", (ctx) => ctx.browser?.()]];
  const listenersOn = (emitter, event) => (emitter?.rawListeners?.(event) || []).map((w) => w.listener || w);
  const contextFor = (noted) => async () => {
    const ctx = await context.getContext();
    const before = handing;
    let done;
    handing = new Promise((r) => { done = r; });
    await before;
    const had = ENDS.map(([event, of]) => new Set(listenersOn(of(ctx), event)));
    // The server builds its backend as soon as this returns, before anything else runs.
    setImmediate(() => {
      ENDS.forEach(([event, of], i) => {
        const emitter = of(ctx);
        for (const fn of listenersOn(emitter, event)) if (!had[i].has(fn) && fn.name === "markDisconnected") noted.push({ emitter, event, fn });
      });
      done();
    });
    return ctx;
  };

  async function serve(sock, { remote = null } = {}) {
    const participant = randomBytes(8).toString("hex");
    // Its state (serve/connection.mjs): the values below change as it works, read as conn.x; the
    // collections and helpers never change identity, so they go by their own names here.
    const conn = createConnectionState(participant, { remote, pauseSeen: pause.seq() });
    const { disconnected, approvedArgs, approvedWhere, fieldNotes, refNames, submitAfter, serverListeners, pending, completed, calls, traces, callArgs, refused, late, openMine, ownTab, noTab } = conn;
    clients.set(participant, sock);
    // The other sessions using the browser: a call in the last ACTIVE_MS, or holding it (acquire).
    const inUse = () => {
      const { owner, participants } = collaboration.state();
      const label = (id) => participants.find((p) => p.id === id)?.label || "an agent";
      // Active: the owner, an agent that acted lately, or one holding a tab now (its claim lasts
      // across its quiet spells: switching would close the tab it holds).
      const holds = (id) => hud.sparkList().some((s) => s.id === id && s.page && !s.page.isClosed() && tabClaims.holder(s.page)?.id === id);
      return [...clients.keys()].filter((id) => id !== participant && (owner?.id === id || Date.now() - (lastCall.get(id) || 0) < ACTIVE_MS || holds(id))).map(label);
    };
    session.join(participant);
    sock.once("close", () => {
      session.forget(participant);
      hud.setBadgeFor(participant, "", "clear").catch(() => {});
      disconnected.abort();
      clients.delete(participant);
      lastCall.delete(participant);
      collaboration.unregister(participant);
      hud.forgetParticipant?.(participant);
      tabClaims.release(participant);
      screenshots.forget(participant);
      follow.ownerGone(participant);
      follow.agentGone?.(participant);
      clickApprovals?.gone(participant);
      pause.forget(participant); // "Pause this agent" ends with its connection
    });
    collaboration.register(participant, `Claude ${participant.slice(0, 4)}`);
    const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
    const myLabel = () => collaboration.participants.get(participant)?.label;
    // What needs the user's OK in an app that can't ask for it: handed to the user. denied: the
    // user said Deny in the browser.
    const handOff = (reason, denied = false) => `${denied ? "Denied in the PairBrowse browser. " : ""}${reason} This needs the user's OK, which this app can't ask for. ` +
      "Set pairbrowse_status to \"you\" and ask the user to do this step themselves in the PairBrowse window, then continue from what they did.";
    // A picture this result carried, kept in the session's timeline (daemon/timeline.mjs) once the
    // result went out: the same bytes, nothing captured or encoded again, nothing on the result's way.
    const rememberPicture = (shot, page, tool, args) => {
      if (!timeline?.enabled || !shot?.data || !page) return;
      setImmediate(() => timeline.record({ data: shot.data, who: myLabel() || "", caption: hud.lastIn(page)?.text || describe(tool, args || {}) || "Looked at the page" }).catch((e) => log("timeline", e?.message || e)));
    };
    const mcpServer = await createConnection({
      browser: { isolated: false },
      webmcp: false, // passwords are swapped in and masked by PairBrowse itself (see handle and finishResult)
      outputDir: paths.files,
      imageResponses: "omit", // the helper adds its own small screenshots, checked for passwords first
      // The browser server's fixed pause after each action (its default: half a second, twice when
      // the action made requests): short here, since the helper waits for the page itself (tidy:
      // until its document is quiet, popups closed) before the picture and the notes.
      timeouts: { settle: Math.max(0, Math.min(5000, Number(config.settleMs ?? MCP_SETTLE_DEFAULT_MS) || 0)) },
    }, contextFor(serverListeners));

    // With pictures off (config screenshots: false) no result carries one: a message pointing at
    // "the screenshot" points at a snapshot instead.
    const toClient = (msg) => {
      if (config.screenshots === false && Array.isArray(msg?.result?.content)) for (const c of msg.result.content) if (c?.type === "text" && typeof c.text === "string") c.text = pictureless(c.text);
      return !sock.destroyed && sock.write(JSON.stringify(msg) + "\n");
    };
    const finish = (id) => { const done = completed.get(id); completed.delete(id); done?.(); };
    const reply = (id, text, isError = false) => {
      if (isError) refused.add(id);
      traces.delete(id);
      // A message naming a ref names it as Claude knows it (the main frame's number off).
      text = refNames.toPlain(text);
      toClient({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) } });
      finish(id);
    };

    // A call of the helper's own to this participant's server (never shown to the client).
    const internal = (name, args) => new Promise((resolve) => {
      const id = `pb-${randomBytes(16).toString("hex")}-${++conn.seq}`;
      pending.set(id, resolve);
      transport.onmessage?.({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    });
    // The helper's parts and this connection's own helpers, for the tool server's parts (serve/):
    // each adds what it makes (createTurns, createResult, ...).
    const api = { config, log, host, createConnection, clients, collaboration, tabClaims, context, hud, presence, popups, output, screenshots, secrets, facts, sharing, follow, pause, drainHostNotes, remoteHolder, reconnecting, front, revision, bumpRevision, session, shareMessage, recorder, tabNames, journal, timeline, testTools, clickApprovals, outlines, onRunStatus, personTabs,
      sock, secretNames, personTab, closing, lastCall, ACTIVE_MS, inUse, cap, myLabel, handOff, rememberPicture, toClient, finish, reply, internal, forwardToHost };

    Object.assign(api, createTurns(conn, api));
    const { myTab, serverPage, takeTurn } = api;

    Object.assign(api, createResult(conn, api));
    const { finishResult, pressEnterAfter } = api;
    Object.assign(api, createRefusals(conn, api));
    const { argProblem } = api;
    // The transport the Playwright MCP server talks to.
    const transport = {
      onmessage: undefined, onclose: undefined, onerror: undefined,
      async start() {},
      async close() { sock.end(); },
      async send(msg) {
        // The server's own requests and notifications (roots/list, list changed) go straight to the
        // client: their ids are the server's, and may equal the id of a call in flight.
        if (msg.method !== undefined) return toClient(msg);
        if (typeof msg.id === "string" && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
          return;
        }
        if (msg.result?.tools) msg.result.tools = [...msg.result.tools.filter((t) => !BLOCKED_TOOLS.has(t.name) && !HIDDEN_TOOLS.has(t.name)).map(withDialogLabel), ...PAIRBROWSE_TOOLS];
        if (late.delete(msg.id)) { calls.delete(msg.id); callArgs.delete(msg.id); return; }
        const tool = calls.get(msg.id);
        const args = callArgs.get(msg.id);
        calls.delete(msg.id);
        callArgs.delete(msg.id);
        if (submitAfter.delete(msg.id) && msg.result && !msg.result.isError) await pressEnterAfter(msg, args).catch((e) => log("enter after typing", e?.message || e));
        if (tool?.startsWith("browser_") && msg.result?.isError) {
          const raw = (msg.result.content || []).map((c) => c.text || "").join("\n");
          // Leaving the browser's own error page (a 404 with no body, a failed load): its late
          // commit "interrupts" the new navigation in Playwright's eyes, though the tab gets
          // there. Where the tab really is decides: the address asked for is a success.
          const landed = tool === "browser_navigate" && /interrupted by another navigation/i.test(raw) ? await within(7000, arrivedAt(await within(2000, serverPage().catch(() => null)), args?.url)) : null;
          if (landed) {
            const snap = await within(10_000, internal("browser_snapshot", {})).catch(() => null);
            const title = await within(1000, landed.title()).catch(() => "");
            msg.result = { content: [{ type: "text", text: `### Page\n- Page URL: ${landed.url()}${title ? `\n- Page Title: ${title}` : ""}` }, ...(snap?.result && !snap.result.isError ? (snap.result.content || []).filter((c) => c.type === "text") : [])] };
          }
          // No dialog to answer: said plainly (the server's "modal state" wording is for developers).
          else if (tool === "browser_handle_dialog" && /modal state/.test(raw)) msg.result.content = [{ type: "text", text: "No dialog is open right now (no alert, confirm or prompt from the page). Take a browser_snapshot and go on." }];
          // A file from outside the folders the browser reads: refused, and the chooser it left
          // open is closed again (nothing else works in the tab while it's open).
          else if (tool === "browser_file_upload" && /outside allowed roots|File access denied/i.test(raw)) {
            await within(3000, internal("browser_file_upload", { paths: [] })).catch(() => {});
            msg.result.content = [{ type: "text", text: `Refused: browser_file_upload takes files from ${paths.files} (or the project folder); ${(args?.paths || []).map((x) => String(x).split(/[\\/]/).pop()).join(", ") || "that file"} is elsewhere. Copy it there, or use pairbrowse_upload, which takes images, video, PDFs and office documents from anywhere. The file chooser was closed again.` }];
          } else {
            const plain = plainError(tool, raw);
            msg.result.content = [{ type: "text", text: plain ? `### Error\n${plain}` : raw.replace(/\x1b\[[0-9;]*m/g, "") }];
          }
        }
        // The bar said what was tried; a failure says so too, or it reads as done.
        if (tool && msg.result?.isError && describe(tool, args || {})) {
          const why = output.mask(String((msg.result.content || []).map((c) => c.text || "").join(" ").replace(/^### Error\s*/i, "").split("\n")[0]).slice(0, 100));
          hud.addActivity(`That didn't work: ${why}`, myLabel(), openMine());
        }
        await finishResult(msg, tool, null, tool === "browser_snapshot" && !args?.target, args);
      },
    };
    api.transport = transport; // (handle passes calls on to the server through it)

    Object.assign(api, createOwnTools(conn, api));

    Object.assign(api, createHandle(conn, api));
    const { handle } = api;
    const { collaborationCall } = createCollaborationTool(conn, api);
    // Shared browser mode, joined from here: the call goes to the host's browser over the join
    // channel (follow.mjs), as this agent's, and its answer comes back as the host gave it.
    async function forwardToHost(msg) {
      const out = await follow.remoteCall(participant, msg, { app: conn.clientName, label: myLabel() });
      if (msg.id !== undefined) toClient({ jsonrpc: "2.0", ...out, id: msg.id });
    }

    // Complete a queued turn only after the MCP result arrives, not when dispatch returns.
    const execute = async (msg) => {
      if (msg.method === "tools/call") lastCall.set(participant, Date.now());
      if (TRACING && msg.method === "tools/call" && msg.id !== undefined) traces.set(msg.id, phaseTrace(log));
      if (sock.destroyed) return;
      if (msg.method === "initialize") {
        // The first initialize names the app for good: a later one can't relabel the connection.
        if (!conn.initialized) {
          conn.initialized = true;
          conn.clientName = String(msg.params?.clientInfo?.name || "").slice(0, 60);
          hud.setApp?.(participant, conn.clientName); // its color: its app's (a joiner's agent's too), unless another agent here has it
          // A joiner's agent: its app's OK (its own user's) never counts as the host's.
          if (remote) { collaboration.register(participant, personLabel(remote.name, appName(conn.clientName))); conn.clientName = `remote:${conn.clientName}`; }
          log(`participant ${participant} is ${conn.clientName || "an unnamed app"}`);
          // The process that started its bridge (launch.mjs: the app's own): which agent a
          // PermissionRequest hook asks for (approvals.mjs whose).
          const parent = Number(msg.params?.clientInfo?.pairbrowseParent);
          clickApprovals?.participant(participant, { client: conn.clientName, remote: !!remote, parent: !remote && Number.isSafeInteger(parent) && parent > 1 ? parent : 0, tab: openMine });
        }
        // "<person> · Claude Code", "<person> · Codex".
        const label = msg.params?.clientInfo?.pairbrowseParticipant;
        if (remote) { /* named by the host's side, above */ } else if (label) collaboration.register(participant, personLabel(label, appName(conn.clientName)));
        else if (conn.clientName !== "claude-code") collaboration.register(participant, `${conn.clientName === "codex-mcp-client" ? "Codex" : "Agent"} ${participant.slice(0, 4)}`);
      }
      if (msg.method === "tools/call" && msg.params?.name === "pairbrowse_collaboration") return collaborationCall(msg);
      // Shared browser mode, joined from here: this agent works in the host's browser, as a
      // participant there (its calls go over the join channel; follow.mjs).
      if (!remote && msg.method === "tools/call" && follow.forwards?.(msg.params?.name)) {
        return forwardToHost(msg);
      }
      const tool = msg.params?.name;
      const dispatchNow = async () => {
        // Refs are good for this agent's own tab: what people or other agents do in that tab
        // makes them stale, work in other tabs never does.
        if (msg.method === "tools/call" && containsRef(msg.params?.arguments) && conn.observedRevision !== revision(ownTab())) {
          return reply(msg.id, "This tab changed since your last snapshot (a person used it, or another agent acted in it). Call browser_snapshot and use its fresh refs before retrying.", true);
        }
        conn.snapshotReturned = false;
        const upToDate = conn.observedRevision === revision(ownTab());
        const response = msg.id === undefined ? Promise.resolve() : new Promise((r) => completed.set(msg.id, r));
        const overran = msg.id === undefined ? null : setTimeout(async () => {
          log(`${tool || msg.method} held the browser for ${TURN_MAX}; resetting the browser so other agents can go on`);
          // The answer first: resetting the browser ends every session's connection (their bridges
          // reconnect by themselves, failing what was in flight).
          late.add(msg.id);
          reply(msg.id, `${tool || "This call"} didn't finish in ${TURN_MAX}, so PairBrowse reset the browser for the other agents waiting on it. Take a browser_snapshot, then try again.`, true);
          try { await (await context.current())?.close(); } catch {}
        }, TURN_MAX_MS);
        // The browser closing (by hand, or a crash) under a call: the call is answered at once,
        // never left hanging while every other call waits in the queue behind it.
        let unwatch = () => {};
        const browserGone = new Promise((resolve) => { unwatch = context.watchClose(() => resolve("closed")); });
        try {
          await handle(msg);
          const outcome = await Promise.race([response, browserGone]);
          if (outcome === "closed" && msg.id !== undefined && completed.has(msg.id)) {
            late.add(msg.id);
            reply(msg.id, "The browser closed while this ran (closed by hand, or it crashed), so nothing more was done. It opens again on your next action: take a browser_snapshot first.", true);
          }
          clearTimeout(overran);
          if (msg.method === "tools/call" && !refused.delete(msg.id) && changesPage(tool)) {
            // A session switch or a tab action may have changed any tab: every tab's refs go.
            bumpRevision(["pairbrowse_session", "browser_tabs"].includes(tool) ? null : ownTab());
            // Your own action doesn't make your refs stale (Playwright tells you if one is gone);
            // the user's or another agent's in your tab does, until you take a snapshot.
            if (conn.snapshotReturned || upToDate) conn.observedRevision = revision(ownTab());
          }
        } catch (e) {
          clearTimeout(overran);
          finish(msg.id);
          throw e;
        } finally {
          unwatch();
        }
      };
      // Only calls that act in a page count as the agent's input time: a person typing while an
      // agent reads (a snapshot, a tab list) is still the person.
      const acting = msg.method === "tools/call" && (TAB_TOOLS.has(tool) || (tool === "browser_tabs" && msg.params?.arguments?.action !== "list"));
      const dispatch = async () => {
        // Actions that never type (a click, a drag, a scroll, a tab): keys meanwhile are a person's.
        const runArgs = msg.params?.arguments || {};
        const keyless = tool === "pairbrowse_run" ? Array.isArray(runArgs.steps) && runArgs.steps.every((s) => s && typeof s === "object" && ["drag", "click", "check", "uncheck", "scroll", "waitFor", "expect", "go"].includes(Object.keys(s)[0]))
          : (tool === "browser_click" && !(Array.isArray(runArgs.modifiers) && runArgs.modifiers.length)) || ["browser_hover", "browser_drag", "browser_tabs", "browser_navigate", "browser_navigate_back", "pairbrowse_scroll", "pairbrowse_click_at"].includes(tool);
        // Its own wheel turns (a scroll, a run with a scroll step) are the agent's, not a person's.
        const wheels = tool === "pairbrowse_scroll" || (tool === "pairbrowse_run" && Array.isArray(runArgs.steps) && runArgs.steps.some((s) => s && typeof s === "object" && Object.keys(s)[0] === "scroll"));
        const done = acting ? presence.busyStart(`${keyless ? "no-keys" : ""}${wheels ? " wheel" : ""}`.trim()) : () => {};
        // Showing another tab (or fast mode bringing its tab up) mustn't pull the browser over the
        // app you're in, like the Claude desktop app with its pane.
        const changesTab = tool === "browser_tabs" && ["select", "new"].includes(msg.params?.arguments?.action);
        try { return await (changesTab ? keepFocus(dispatchNow) : dispatchNow()); } finally { done(); }
      };
      // The session picker: the first browser action waits (outside the shared queue) for the
      // person to pick a session in the browser, and says which; after a while it says it's waiting.
      if (msg.method === "tools/call" && !NO_PICK_WAIT.has(tool)) {
        const r = await context.waitForPick(disconnected.signal);
        // A call the picker turned away did nothing: it doesn't make this agent one that uses the
        // browser (which would stop the others from choosing a session for everyone).
        if (r?.waiting) { if (!conn.acted) lastCall.delete(participant); return reply(msg.id, PICK_WAITING, true); }
        conn.acted = true;
        if (r) fieldNotes.push(r);
        // Who used this session, for the session picker: "Alice · Claude Code" -> Alice, Claude Code.
        if (!conn.recorded) {
          conn.recorded = true;
          const [who, app] = String(myLabel() || "Claude").split(" · ");
          context.recordPerson({ who: who.replace(/ [0-9a-f]{4}$/, ""), app: app || appName(conn.clientName), computer: computerName(), kind: "agent" });
        }
      }
      // Paused by a person: wait before the shared queue (it never holds other work up), and
      // after a while say so, so the agent isn't stuck. Only people resume (no tool does).
      if (acting) {
        const held = await pause.wait(disconnected.signal, participant);
        if (held) return reply(msg.id, `Paused by ${held.by}. Waiting until someone resumes; nothing was done.`, true);
      }
      // Codex and other apps (not Claude Code, never a joiner's agent): a named final action asks
      // in the browser and waits for the answer, before the turn (no tab or busy span held while
      // it waits, so the person's click is never taken for the agent's). Allow lets it go on;
      // anything else is the hand-off, as when the browser can't ask (nothing waits then).
      if (msg.method === "tools/call" && !remote && conn.clientName !== "claude-code" && clickApprovals) {
        const args = msg.params?.arguments;
        const ask = args && typeof args === "object" && !Array.isArray(args) && !argProblem(tool, args) ? approvalAsk(tool, args) : null;
        const r = ask ? await clickApprovals.open({ tool, input: args, ask, participant, client: conn.clientName }) : null;
        if (r?.shown) {
          let onAbort = () => {};
          const left = new Promise((resolve) => {
            onAbort = () => { clickApprovals.withdraw(r.item.id, "the agent disconnected"); resolve("withdrawn"); };
            if (disconnected.signal.aborted) onAbort(); else disconnected.signal.addEventListener("abort", onAbort, { once: true });
          });
          const a = await Promise.race([r.answer, left]);
          disconnected.signal.removeEventListener("abort", onAbort);
          if (a === "allow" || a === "site") { approvedArgs.add(args); approvedWhere.set(args, r.where || null); }
          else {
            log(`handed to the user (${conn.clientName || "unknown app"}): ${tool}, after the browser's ${a}`);
            const reason = String(decide({ tool_name: `mcp__plugin_pairbrowse_browser__${tool}`, tool_input: args }).hookSpecificOutput.permissionDecisionReason || "").replace(/\.?$/, ".");
            return reply(msg.id, handOff(reason, a === "deny"), true);
          }
        }
      }
      if (msg.method === "tools/call" && TAB_TOOLS.has(tool)) return takeTurn(dispatch, msg.id, tool, msg.params?.arguments || {});
      // An agent without a tab of its own reads nothing: it would be reading another agent's tab.
      if (msg.method === "tools/call" && PAGE_READ_TOOLS.has(tool) && !(await myTab()) && (conn.lostTab || remote)) {
        return reply(msg.id, noTab(), true);
      }
      if (msg.method === "tools/call") return collaboration.run(participant, dispatch);
      return dispatch();
    };

    let incoming = Promise.resolve();
    createInterface({ input: sock }).on("line", (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      // Not one the browser server reads (null would even throw here): refused at once (see wellFormed).
      const read = wellFormed(msg);
      if (!read) return void (msg?.id !== undefined && msg?.method !== undefined && toClient({ jsonrpc: "2.0", id: typeof msg.id === "string" || typeof msg.id === "number" ? msg.id : null, error: { code: -32600, message: "Invalid Request: not a JSON-RPC 2.0 message." } }));
      msg = read;
      if (msg.method === "notifications/cancelled") { transport.onmessage?.(msg); return; }
      // Answers to the server's own requests (roots/list, elicitation) go straight through: the
      // tool call that asked is still running, so queueing them behind it would deadlock.
      if (msg.method === undefined && msg.id !== undefined) { transport.onmessage?.(msg); return; }
      incoming = incoming.then(() => execute(msg)).catch((e) => msg.id !== undefined && reply(msg.id, String(e?.message || e), true));
    }).on("error", () => {}); // a client gone mid-write (EPIPE) must not take the helper down
    sock.on("error", () => {});
    sock.on("close", () => {
      hud.hideCursor(hud.sparkPage(participant)).catch(() => {}); // the agent is gone: so is its cursor
      // Let an already-dispatched action finish before disposing this MCP backend. The
      // shared queue stays locked meanwhile; queued requests from this socket are skipped.
      // If a disconnected client leaves an unresponsive action, reset the browser before
      // permitting another agent to run; releasing the queue early could overlap actions.
      const watchdog = setTimeout(async () => {
        if (!collaboration.isActing(participant)) return;
        log("resetting browser after disconnected participant stalled");
        try { await (await context.current())?.close(); } catch {}
        for (const id of completed.keys()) finish(id);
        for (const [id, resolve] of pending) resolve({ jsonrpc: "2.0", id, error: { code: -32002, message: "Browser reset after disconnect" } });
        pending.clear();
      }, STALLED_MS);
      watchdog.unref();
      incoming.finally(() => {
        clearTimeout(watchdog);
        transport.onclose?.();
        return mcpServer.close();
      }).catch((e) => log("participant cleanup", e?.message || e)).finally(() => {
        for (const { emitter, event, fn } of serverListeners.splice(0)) emitter.removeListener(event, fn);
      });
      hud.moveSpark(participant, null).catch(() => {});
      log(`participant disconnected ${participant}`);
    });

    await mcpServer.connect(transport);
    log(`participant connected ${participant}`);
    context.openPages().then((pages) => pages.forEach(stopRequestMirroring)).catch(() => {});
  }
  // The agents at work in this browser now (a call in the last ACTIVE_MS, or holding it), by name:
  // a person's session switch from the browser's own pages asks before closing their tabs
  // (daemon/pick.mjs), as an agent's own switch is refused while others are at work.
  serve.activeAgents = () => {
    const { owner, participants } = collaboration.state();
    const label = (id) => participants.find((p) => p.id === id)?.label || "An agent";
    return [...clients.keys()].filter((id) => owner?.id === id || Date.now() - (lastCall.get(id) || 0) < ACTIVE_MS).map(label);
  };
  return serve;
}
