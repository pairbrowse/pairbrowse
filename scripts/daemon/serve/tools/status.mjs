// pairbrowse_status: what the agent says it is doing, in the side panels, the docks and the badge
// in every tab (bounded per tab), and the goal log. A "you" also goes to the person's hand-off
// channels when hand-offs go there (daemon/yourturn.mjs): the result says where it went, for which
// tab and until when, never the link; any other kind ends this agent's hand-off.
import { within } from "../../../util.mjs";
import { SELECTED, CONFIG_WARNINGS } from "../../../paths.mjs";
import { SANDBOX } from "../../../engine.mjs";
import { SANDBOX_OFF_WARNING } from "../../../browser-args.mjs";

const BADGE_MS = 4000; // pairbrowse_status waits this long at most for the badge in every tab

// "ok", naming this helper's instance and home when it isn't the default one (several PairBrowse
// helpers on one computer: home.mjs), a project file that couldn't be used, and config.json's
// unknown keys and refused values (paths.mjs loadConfig), and the browser's sandbox: off (Linux
// only) or a request to turn it off refused (engine.mjs SANDBOX). update: a newer PairBrowse
// installed that this helper waits to move to (handoff.mjs pendingLine), said last. more: the
// other parts' own, in order, after these (context.statusParts: the virtual screen, a crash loop,
// the session's network).
export function statusLine(selected = SELECTED, configWarnings = CONFIG_WARNINGS, sandbox = SANDBOX, update = "", more = []) {
  const parts = ["ok"];
  if (selected.instance) parts.push(`PairBrowse instance "${selected.instance}" (${selected.home})`);
  else if (selected.source === "PAIRBROWSE_HOME") parts.push(`PairBrowse home ${selected.home}`);
  if (selected.warning) parts.push(`ignored: ${selected.warning}`);
  for (const w of configWarnings) parts.push(`warning: ${w}`);
  if (sandbox?.on === false) parts.push(`warning: ${SANDBOX_OFF_WARNING} (${sandbox.reason})`);
  if (sandbox?.refused && !configWarnings.some((w) => w.includes(sandbox.refused))) parts.push(`warning: ${sandbox.refused}`);
  for (const m of more) if (m) parts.push(m);
  const line = parts.join("; ");
  return update ? `${line}\n${update}` : line;
}

export function createStatusTool(conn, api) {
  const { context, hud, journal, myLabel, session, updateNote = () => "", yourTurn = null } = api;
  const { participant } = conn;
  return {
    async pairbrowse_status(given) {
      // While the crash-loop guard holds there is no browser to start, nor while the session's
      // proxy failed its check (a start that fails it now too): the status still goes to the side
      // panels and the goal log, and the line below says why (context.statusParts).
      if (!context.crashLoop?.() && !context.networkRefusal?.()) await context.getContext().catch((e) => { if (!context.networkRefusal?.()) throw e; });
      // "agent" is "claude" (working) by another name, for apps that aren't Claude.
      const args = given.kind === "agent" ? { ...given, kind: "claude" } : given;
      // The hand-off first, in the agent's own tab: its step kind is the Tools tab entry's (set
      // before the badge's callback reads it; the channels' answers are awaited below).
      const mine = conn.mine && !conn.mine.isClosed?.() ? conn.mine : null;
      const turn = yourTurn ? yourTurn.onStatus(participant, args, hud.sparkPage(participant) || mine).catch(() => "") : Promise.resolve("");
      // The side panels and docks (session) and the badge in the tabs (hud) say the same. The
      // badge goes to every tab: bounded, so one frozen tab never holds this agent (nor the
      // others behind the shared queue).
      session.setStatus(participant, args.text, args.kind); // the side panels in a shared session show it
      await within(BADGE_MS, hud.setBadgeFor(participant, args.text, args.kind, myLabel()).catch(() => {}));
      if (args.kind === "done" || args.kind === "clear") await within(BADGE_MS, Promise.resolve(hud.hideCursor(hud.sparkPage(participant))).catch(() => {}));
      journal.status(args.kind, args.text); // a hand-off goes to the goal log's yourTurn
      const sent = await turn;
      return { text: [statusLine(SELECTED, CONFIG_WARNINGS, SANDBOX, updateNote(), [...(context.statusParts?.() || [])]), sent].filter(Boolean).join("\n") };
    },
  };
}
