// One tool call on its way to the browser server: PairBrowse's rules first (arguments, refusals,
// the tab it acts in, approvals), its own tools answered here, and the call's arguments rewritten
// where PairBrowse does the work itself (fields a person fills, date fields, Enter after typing,
// saved passwords swapped in, a form filled by hand in the native browser).
import { describe } from "../../log.mjs";
import { fillSettings, humanFill, humanType } from "../../native-engine.mjs";
import { isRef, secretNamesIn } from "../../rules/policy.mjs";
import { isoDate } from "../../runner.mjs";
import { within } from "../../util.mjs";
import { reason as dragReason } from "../drag.mjs";
import { leftAlone, ownerOf } from "../fields.mjs";
import { sensitiveTarget } from "./pageread.mjs";
import { tabRefusal } from "./refuse.mjs";
import { CLICKING_TOOLS, DECORATED, FIELD_TOOLS, NO_WAIT } from "./wire.mjs";

export function createHandle(conn, api) {
  const { approvalProblem, argProblem, browserToolProblem, collaboration, config, context, enterAfterTyping, finishResult, host, hud, internal, log, myLabel, myTab, openTabs, ownTools, personTab, popups, presence, refusal, reply, respond, secretNames, secrets, serverPage, session, syncServer, tabClaims, whenReady } = api;
  const { callArgs, calls, fieldNotes, openMine, ownTab, participant, refNames, submitAfter, tabActions, traces } = conn;

  async function handle(msg) {
    if (msg.method !== "tools/call") return api.transport.onmessage?.(msg);
    const { name } = msg.params || {};
    let args = msg.params?.arguments || {};
    const denied = argProblem(name, args) || refusal(name, args);
    traces.get(msg.id)?.mark("guard");
    if (denied) { traces.delete(msg.id); return reply(msg.id, denied, true); }
    if (!NO_WAIT.has(name)) await whenReady();
    // "Your turn" is done once Claude acts again: take the badge down.
    // The bar and the docks (session status) together: one cleared alone left the dock saying
    // "your turn" after the bar had cleared.
    if ((hud.statusOf(participant)?.kind === "you" || session.statusOf(participant)?.kind === "you") && (CLICKING_TOOLS.has(name) || name === "browser_navigate" || name === "pairbrowse_click_at")) {
      hud.setBadgeFor(participant, "", "clear").catch(() => {});
      session.setStatus(participant, "", "clear");
    }
    // Act in this participant's own tab (browser_tabs new and select pick a new one).
    const picksTab = name === "browser_tabs" && ["new", "select"].includes(args.action);
    if ((name.startsWith("browser_") && !picksTab) || DECORATED.has(name)) { await myTab(); await syncServer(); }
    const unapproved = await approvalProblem(name, args);
    if (unapproved) { traces.delete(msg.id); return reply(msg.id, unapproved, true); }
    // The main frame's refs Claude got plain get Playwright's frame number back (refNames).
    const framed = refNames.toFrame(args);
    if (framed !== args) {
      msg = structuredClone(msg);
      msg.params.arguments = framed;
      args = framed;
    }
    // browser_drag is the helper's own, after the checks every browser tool gets.
    // The page waits on its own confirm or prompt: nothing else works until it's answered.
    if (name.startsWith("browser_") && !["browser_handle_dialog", "browser_tabs", "browser_close", "browser_file_upload"].includes(name)) {
      const here = ownTab();
      const d = here && popups.waitingDialog(here);
      if (d) return reply(msg.id, `The page is waiting on its ${d.type} dialog ("${String(d.message).slice(0, 120)}"): answer it with browser_handle_dialog (accept, or dismiss) before anything else.`, true);
    }
    // The browser's own pages (chrome://pairbrowse...) and the person's own tabs are never a
    // tab an agent acts in, selects or closes (tabRefusal).
    {
      const here = ownTab() || (conn.serverAt && !conn.serverAt.isClosed() ? conn.serverAt : null);
      const byIndex = name === "browser_tabs" && (args.action === "select" || args.action === "close") && args.index !== undefined;
      const tabNo = tabRefusal(name, args, { here, pages: byIndex ? await openTabs() : [], personTab });
      if (tabNo) return reply(msg.id, tabNo, true);
    }
    // Another agent's tab is theirs to close.
    if (name === "browser_tabs" && args.action === "close") {
      const tabs = await openTabs();
      const target = args.index === undefined ? openMine() : tabs[Number(args.index)] || null;
      const owner = target && hud.sparkOwner(target);
      if (target && owner && owner.id !== participant && !tabClaims.members(target).some((m) => m.id === participant)) {
        return reply(msg.id, `Tab ${tabs.indexOf(target)} is ${collaboration.participants.get(owner.id)?.label || "another agent"}'s: their agent works there. Leave it, and close only your own tabs (browser_tabs close without index).`, true);
      }
      if (target && target === conn.mine) conn.closedByMe = true;
    }
    if (Object.hasOwn(ownTools, name) && name !== "browser_drag") return respond(msg.id, name, await ownTools[name](args), args);

    const problem = await browserToolProblem(name, args);
    if (problem) return reply(msg.id, problem, true);
    if (name === "browser_drag") return respond(msg.id, name, await ownTools.browser_drag(args), args);
    if (name === "browser_handle_dialog" && Object.hasOwn(args, "element")) {
      msg = structuredClone(msg);
      delete msg.params.arguments.element;
      args = msg.params.arguments;
    }
    // A field a person is filling (here or in the other browser) is theirs: left unchanged.
    if (FIELD_TOOLS.has(name)) {
      const page = conn.actingIn || await serverPage();
      // A field can only be a person's where a person has just been: elsewhere the read (slow on
      // a busy page) is skipped, so a quiet page never turns typing away as "too busy".
      const ownerAt = (target) => (page && isRef(target) && presence.personWithin(page, 15_000) ? ownerOf(page.locator(`aria-ref=${target}`).first(), hud.key, { host, byAgent: presence.typedByAgent, byRemote: presence.byRemote, log }) : null);
      if (name === "browser_fill_form" && Array.isArray(args.fields)) {
        const owners = await Promise.all(args.fields.map((f) => ownerAt(f?.target)));
        if (owners.some((o) => o?.unknown)) return reply(msg.id, "The page is too busy right now to tell whether a person is filling these fields; nothing was typed. Try again in a moment.", true);
        const left = owners.map((o, i) => o && leftAlone(o, args.fields[i]?.name)).filter(Boolean);
        if (left.length === args.fields.length && left.length) return reply(msg.id, left.join("\n"), true);
        if (left.length) {
          fieldNotes.push(...left); // the rest are filled
          msg = structuredClone(msg);
          msg.params.arguments.fields = args.fields.filter((_, i) => !owners[i]);
          args = msg.params.arguments;
        }
      } else {
        const o = await ownerAt(args.target);
        if (o?.unknown) return reply(msg.id, `The page is too busy right now to tell whether a person is filling ${args.element || "that field"}; nothing was typed. Try again in a moment.`, true);
        if (o) return reply(msg.id, leftAlone(o, args.element), true);
      }
    }
    // A date, time, month or week field takes one exact shape (YYYY-MM-DD, hh:mm): typing into it
    // key by key, as the PairBrowse browser does, leaves garbage. PairBrowse sets such fields
    // itself, a date in another spelling turned into YYYY-MM-DD when it can only mean one day.
    // A form PairBrowse fills itself (ownFill, below) sets its date fields in their turn; a single
    // browser_type it types itself (ownType) sets a date field here, as before.
    const typingPage = name === "browser_type" || name === "browser_fill_form" ? conn.actingIn || await serverPage() : null;
    const humanized = typingPage?._pairbrowseHumanized === true;
    const ownFill = name === "browser_fill_form" && Array.isArray(args.fields) && args.fields.every((f) => isRef(f?.target)) && humanized;
    const ownType = name === "browser_type" && isRef(args.target) && humanized;
    if ((name === "browser_type" || name === "browser_fill_form") && !ownFill) {
      const page = typingPage;
      const items = name === "browser_type" ? [{ target: args.target, value: args.text, name: args.element }] : args.fields;
      const typeOf = async (t) => (page && isRef(t) ? within(800, page.locator(`aria-ref=${t}`).first().evaluate((n) => (n.tagName === "INPUT" ? String(n.type).toLowerCase() : ""), undefined, { timeout: 700 })).catch(() => "") : "");
      const kinds = await Promise.all(items.map((f) => typeOf(f?.target)));
      const dated = items.filter((_, i) => /^(date|time|month|week|datetime-local)$/.test(kinds[i] || ""));
      if (dated.length && !secretNamesIn(name, args, secretNames()).length) {
        const shape = { date: "YYYY-MM-DD", "datetime-local": "YYYY-MM-DDThh:mm", month: "YYYY-MM", week: "YYYY-Www", time: "hh:mm" };
        const lines = [], said = []; // said: the activity line's, names only
        for (const f of dated) {
          const kind = kinds[items.indexOf(f)];
          const value = kind === "date" ? isoDate(String(f.value ?? "")) || String(f.value ?? "") : String(f.value ?? "");
          const loc = page.locator(`aria-ref=${f.target}`).first();
          const human = page._pairbrowseHumanized === true;
          if (human) page._pairbrowseHumanized = false;
          try {
            await hud.cursorTo(page, loc, "type", myLabel());
            await loc.fill(value, { timeout: 5000 });
            const now = await loc.inputValue({ timeout: 1000 }).catch(() => null);
            lines.push(now === value ? `Filled ${f.name || f.target} with ${value}.` : `${f.name || f.target} didn't take "${String(f.value).slice(0, 40)}": a ${kind} field takes ${shape[kind]}.`);
            said.push(now === value ? `Filled ${f.name || f.target}.` : `${f.name || f.target} didn't take the value: a ${kind} field takes ${shape[kind]}.`);
          } catch (e) {
            lines.push(`${f.name || f.target} didn't take "${String(f.value).slice(0, 40)}": a ${kind} field takes ${shape[kind]} (${dragReason(e)}).`);
            said.push(`${f.name || f.target} didn't take the value: a ${kind} field takes ${shape[kind]}.`);
          } finally {
            if (human) page._pairbrowseHumanized = true;
          }
        }
        hud.addActivity(said.join(" "), myLabel(), page);
        if (name === "browser_type" || dated.length === items.length) return reply(msg.id, lines.join("\n"), lines.some((l) => /didn't take/.test(l)));
        fieldNotes.push(...lines);
        msg = structuredClone(msg);
        msg.params.arguments.fields = args.fields.filter((f) => !dated.includes(f));
        args = msg.params.arguments;
      }
    }
    // Typing with submit: the text goes in through the browser server, Enter is PairBrowse's own
    // press on the field that has the focus then (a search box the page replaces as it's typed
    // in kept the server waiting 10 s on the old one). The guard judged the Enter above. A
    // browser_type PairBrowse types itself (ownType, below) presses it in its turn.
    if (name === "browser_type" && args.submit && !ownType) {
      msg = structuredClone(msg);
      delete msg.params.arguments.submit;
      args = msg.params.arguments;
      submitAfter.add(msg.id);
    }
    // Swap password names for the real values on the way to the browser; Claude's copy keeps names.
    if (secretNamesIn(name, args, secretNames()).length) {
      const { values } = secrets.get();
      const swap = (v) => (Object.hasOwn(values, v) ? values[v] : v);
      msg = structuredClone(msg);
      const a = msg.params.arguments;
      if (name === "browser_type") a.text = swap(a.text);
      else a.fields = a.fields.map((f) => ({ ...f, value: swap(f.value) }));
    }
    // A new session's browser server learns the open tabs when it first lists them: do that
    // before a select or close by number, which would otherwise find no such tab.
    if (name === "browser_tabs" && ["select", "close"].includes(args.action) && !conn.tabsListed) await internal("browser_tabs", { action: "list" });
    if (name === "browser_tabs") conn.tabsListed = true;
    // Claude's args: names, never values; a value typed into a field that is sensitive by its
    // own kind shows masked, however Claude names it.
    let shown = args;
    if (name === "browser_type" && !secretNamesIn(name, args, secretNames()).length && await sensitiveTarget(conn.actingIn || await context.pageAt(context.currentUrl()), args.target)) shown = { ...args, text: "••••" };
    if (name === "browser_fill_form" && Array.isArray(args.fields)) {
      const page = conn.actingIn || await context.pageAt(context.currentUrl());
      shown = { ...args, fields: await Promise.all(args.fields.map(async (f) => (await sensitiveTarget(page, f.target) ? { ...f, value: "••••" } : f))) };
    }
    hud.addActivity(describe(name, shown, { values: false }), myLabel(), conn.actingIn);
    await hud.showCursor(name, args, async () => ownTab() || context.pageAt(context.currentUrl()), myLabel()).catch(() => {});
    traces.get(msg.id)?.mark("cursor");
    if (name === "browser_fill_form") await hud.markTargets(ownTab(), args.fields.map((f) => f.target)).catch(() => {});
    // A form in the native browser with human-like input on: PairBrowse fills it itself, field by
    // field as a person does (Tab to the next field, key by key at typingPace; native-engine.mjs
    // humanFill). The browser server's fill would reach for every field by mouse and type at the
    // engine's own pace: over 2 s a field. Values come from the swapped copy (real secrets), what the
    // result says from Claude's (names, masked).
    if (ownFill) {
      const page = conn.actingIn || await serverPage();
      const items = msg.params.arguments.fields.map((f, i) => ({ ...f, shown: shown.fields[i]?.value }));
      const { lines, failed } = await humanFill(page, items, fillSettings(config), { trace: log, isoDate });
      return reply(msg.id, [...lines, ...fieldNotes.splice(0)].join("\n"), failed);
    }
    // A single browser_type there: PairBrowse types it itself too (humanType), the field focused
    // by the engine's own reach and click (the press declared above), the text at typingPace with
    // the same typist's rhythm as a form fill (slowly: about 90 ms a key), read back. The engine's
    // own typing held every key its full time: 41 characters took 6 s. Enter (submit) is PairBrowse's
    // own press, as before; slowly brings a snapshot, as before (a list of suggestions shows up).
    if (ownType) {
      const { line, failed } = await humanType(typingPage, { target: args.target, name: args.element, value: msg.params.arguments.text, shown: shown.text }, fillSettings(config), { trace: log, slowly: args.slowly === true });
      let text = line;
      if (args.submit && !failed) text = await enterAfterTyping(typingPage, args).catch((e) => { log("enter after typing", e?.message || e); return line; });
      else if (args.slowly === true && !failed) text += `\n${((await within(8000, internal("browser_snapshot", {})).catch(() => null))?.result?.content || []).map((c) => c.text || "").join("\n")}`;
      return finishResult({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], ...(failed ? { isError: true } : {}) } }, name, null, false, args);
    }
    calls.set(msg.id, name);
    callArgs.set(msg.id, args);
    if (name === "browser_tabs") tabActions.set(msg.id, args.action);
    api.transport.onmessage?.(msg);
  }

  return { handle };
}
