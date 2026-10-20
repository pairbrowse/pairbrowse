// pairbrowse_status: what the agent says it is doing, in the side panels, the docks and the badge
// in every tab (bounded per tab), and the goal log.
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
// other parts' own, in order, after these (context.statusParts: the virtual screen, a crash loop).
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
  const { context, hud, journal, myLabel, session, updateNote = () => "" } = api;
  const { participant } = conn;
  return {
    async pairbrowse_status(given) {
      // While the crash-loop guard holds there is no browser to start: the status still goes to
      // the side panels and the goal log, and the line below says why (context.statusParts).
      if (!context.crashLoop?.()) await context.getContext();
      // "agent" is "claude" (working) by another name, for apps that aren't Claude.
      const args = given.kind === "agent" ? { ...given, kind: "claude" } : given;
      // The side panels and docks (session) and the badge in the tabs (hud) say the same. The
      // badge goes to every tab: bounded, so one frozen tab never holds this agent (nor the
      // others behind the shared queue).
      session.setStatus(participant, args.text, args.kind); // the side panels in a shared session show it
      await within(BADGE_MS, hud.setBadgeFor(participant, args.text, args.kind, myLabel()).catch(() => {}));
      if (args.kind === "done" || args.kind === "clear") await within(BADGE_MS, Promise.resolve(hud.hideCursor(hud.sparkPage(participant))).catch(() => {}));
      journal.status(args.kind, args.text); // a hand-off goes to the goal log's yourTurn
      return { text: statusLine(SELECTED, CONFIG_WARNINGS, SANDBOX, updateNote(), [...(context.statusParts?.() || [])]) };
    },
  };
}
