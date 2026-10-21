// pairbrowse_run: fast mode (runner.mjs) and saved playbooks, in the agent's tab, bounded: a run
// stops between steps past RUN_MAX_MS, and one stuck on a page that stopped answering is given up on.
import { paths } from "../../../paths.mjs";
import { listPlaybooks, loadPlaybook, outline, preflight, runSteps, savePlaybook, substitute } from "../../../runner.mjs";
import { sleep, within } from "../../../util.mjs";
import { ownerOf } from "../../fields.mjs";

const RUN_MAX_MS = 120_000; // a fast-mode run stops between steps past this

export function createRunTool(conn, api) {
  const { context, facts, host, hud, journal, log, myLabel, onRunStatus, pause, popups, presence, secrets, serverPage, sock } = api;
  const { disconnected, participant } = conn;

  async function runCommand(args) {
    if (args.list) return { text: listPlaybooks().join("\n") || "No saved playbooks yet." };
    let steps;
    try {
      steps = args.playbook ? loadPlaybook(args.playbook) : args.steps;
    } catch {
      return { text: `No playbook "${args.playbook}". Saved: ${listPlaybooks().join(", ") || "none"}.`, error: true };
    }
    let resolved;
    try {
      resolved = substitute(steps, args.vars || {});
    } catch (e) {
      return { text: `${e.message}. Pass it in vars.`, error: true };
    }
    const problem = preflight(resolved, paths.uploads, Object.keys(secrets.get().values || {}));
    if (problem) return { text: problem, error: true };
    const page = (await serverPage()) || (await (await context.getContext()).newPage());
    // A page that answers nothing (its scripts never pause, or it froze): said at once. A run that
    // starts by going elsewhere leaves it (its go step is bounded like any navigation).
    const leaves = Object.keys(resolved[0] || {})[0] === "go";
    if (!leaves && (await within(4000, page.evaluate(() => 1).catch(() => null))) === null) return { text: "The page isn't answering right now (its scripts are busy without pause, or it froze): nothing was done. Wait a moment and try again, or reload it with browser_navigate.", error: true, url: page.url() };
    // A run gets RUN_MAX_MS; past that it stops between steps and says so, and a run stuck
    // inside a step on a page that stopped answering is given up on a little later (never the
    // browser's 10-minute reset for everyone waiting behind it).
    const stuck = Symbol("stuck");
    let lastTrace = "";
    const result = await Promise.race([sleep(RUN_MAX_MS + 15_000).then(() => stuck), runSteps(page, resolved, {
      trace: (t) => { lastTrace = String(t); },
      uploadsDir: paths.uploads,
      secrets: secrets.get(),
      signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(RUN_MAX_MS)]),
      beforeStep: async () => {
        if (sock.destroyed) throw new Error("Participant disconnected. Refresh the browser before continuing.");
        // Paused by a person: stop here (never waiting inside the shared queue).
        const held = pause.heldFor(participant);
        if (held.paused) throw new Error(`Paused by ${held.by}: nothing more was done. Run the remaining steps once someone resumes.`);
        // A person clicking or typing in this tab: every step waits until they're idle, then
        // stops so Claude looks at the page again before the remaining steps.
        const who = presence.actingIn(page);
        if (!who) return;
        await presence.waitForUser(page);
        throw new Error(`${who === host ? "The user" : who} used this tab (${presence.didIn(page) || "clicked"}). Take a snapshot, then run the remaining steps.`);
      },
      owner: (el) => ownerOf(el, hud.key, { host, log, byAgent: presence.typedByAgent, byRemote: presence.byRemote }),
      // Between two fields: paused agents stop; a person using the tab is waited for.
      holdForPeople: async () => {
        const held = pause.heldFor(participant);
        if (held.paused) throw new Error(`Paused by ${held.by}: nothing more was done. Run the remaining steps once someone resumes.`);
        if (presence.actingIn(page)) await presence.waitForUser(page);
      },
      // Mid-step (a long stroke): a person acting in this tab or pausing agents stops it at once.
      interrupted: () => {
        const held = pause.heldFor(participant);
        if (held.paused) return `Paused by ${held.by} mid-step: stopped there. Run the remaining steps once someone resumes.`;
        const who = presence.actingIn(page);
        return who ? `${who === host ? "The user" : who} took over this tab mid-step (${presence.didIn(page) || "clicked"}): stopped there. Take a snapshot, then go on.` : "";
      },
      status: (text, kind) => { hud.setBadge(text, kind).catch(() => {}); try { onRunStatus(participant, text, kind, page, myLabel()); } catch {} },
      // The hand-off a handoff step's status made, when it went to the person's channels (yourturn.mjs ended).
      turnEnded: () => api.yourTurn?.ended?.(page, participant) || null,
      // A saved card on in this browser (yourturn.mjs savedCard, B12): the press step's key rule.
      savedCard: () => !!api.yourTurn?.savedCard?.(),
      activity: (text) => hud.addActivity(text, myLabel(), page),
      cursor: (el, act) => hud.cursorTo(page, el, act, myLabel()),
      remember: facts.seenInForm,
      dialogOpen: () => popups.waitingDialog(page),
    })]);
    if (result === stuck) {
      log(`run given up on at: ${lastTrace || "?"} (${page.url()})`);
      hud.addActivity("That didn't work: the page stopped answering", myLabel(), page);
      return { text: `Stopped: the page stopped answering during this run (its scripts run without pause, or it froze), so the run was given up on after ${Math.round((RUN_MAX_MS + 15_000) / 60_000)} minutes${lastTrace ? `, at ${lastTrace}` : ""}. Take a browser_snapshot; if the page is still stuck, reload it with browser_navigate.`, error: true, url: page.url() };
    }
    const saving = result.ok && args.saveAs && !args.playbook;
    if (saving) savePlaybook(args.saveAs, steps);
    const left = result.skipped?.length ? ` Left to the people filling them: ${result.skipped.map((x) => `${x.label} (${x.who})`).join(", ")}.` : "";
    const head = result.ok
      ? `Done: ${result.done.length} steps in ${(result.ms / 1000).toFixed(1)}s.${left}${saving ? ` Saved as playbook "${args.saveAs}".` : ""}`
      : `Stopped at step ${result.stoppedAt} of ${resolved.length}: ${result.why}${left}`;
    // The page says something it filled is wrong: the agent fixes it before going on.
    const checks = result.checks?.length ? `\nCheck before going on, the page says: ${result.checks.join("; ")}. Fix these (look at the screenshot), then continue.` : "";
    journal.ranLeft(result); // the goal log: what this page still lacks
    // A page waiting on its dialog answers nothing: its outline would hang until it's answered.
    const out = popups.waitingDialog(page) ? `Page: ${page.url()}` : await within(10_000, outline(page)).catch(() => `Page: ${page.url()}`);
    return { text: `${head}${checks}\n${out}`, error: !result.ok, url: page.url() };
  }

  return { pairbrowse_run: runCommand };
}
