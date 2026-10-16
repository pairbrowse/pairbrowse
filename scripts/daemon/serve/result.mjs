// Every tool result on its way to the agent: popups closed and the page settled, notes (popups
// handled, people, messages, pauses), what a narrow window folded away, masking, the person's
// tabs hidden, and a small picture of the page.
import { isRef, trimResult } from "../../rules/policy.mjs";
import { pageLoaded, within } from "../../util.mjs";
import { hiddenTabsNote, hideBrowserTabs, hidePersonTabs } from "../output.mjs";
import { settle, whileBusy } from "../page.mjs";
import { outline } from "../../runner.mjs";
import { foldedLine, revealNote, scanReveal } from "../reveal.mjs";
import { CLICKING_TOOLS, DECORATED, FIELD_TOOLS, INLINE_SHORT_TOOLS, INLINE_SNAPSHOT_TOOLS, LOADING_TOOLS, PAGE_READ_TOOLS, SCREENSHOT_TOOLS, dropClosedAlerts, forJoiner, urlIn } from "./wire.mjs";
import { resolve as resolvePath } from "node:path";

// PAIRBROWSE_TRACE=1: each result's phases (tidy, notes, screenshot) and their time, in the log.
export const TRACING = process.env.PAIRBROWSE_TRACE === "1";
export const phaseTrace = (log) => {
  if (!TRACING) return { mark() {}, done() {} };
  const t0 = Date.now();
  let last = t0;
  const marks = [];
  return { mark(name) { const now = Date.now(); marks.push(`${name}=${now - last}`); last = now; }, done(tool) { log(`trace ${tool} total=${Date.now() - t0} ${marks.join(" ")}`); } };
};
// No new picture when the page's bytes equal the last picture's (screenshot.mjs): the note says so.
export const SAME_PICTURE = "\n### PairBrowse\n- The page looks exactly as in your last screenshot (no new picture).";
const LOAD_WAIT_MS = 4000; // for the page to load before the screenshot
export const SETTLE_MS = 1000; // after it loaded
export const CLICK_SETTLE_MS = 500; // at least, after a click: in-page changes (menus, single-page apps) don't load a page
const TIDY_MAX_MS = 8000; // the most a result waits for the page to settle
const LATE_POPUP_CHECKS_MS = [3000, 8000]; // an offer that shows up a few seconds later
export const image = (data) => ({ type: "image", data, mimeType: "image/jpeg" });
export const BUSY_MAX_MS = 5000; // a click the page is still at work on is waited for this long, at most
// A result's text without its page snapshot (the "### Snapshot" section, inline or as a file link),
// with put in its place.
export function withoutSnapshot(text, put = "") {
  let t = String(text);
  const linked = /^(### Snapshot\n)?- \[Snapshot\]\([^)\s]+\)[^\n]*(\n|$)/m;
  const inline = /^### Snapshot\n```ya?ml\n[\s\S]*?\n```[^\n]*(\n|$)/m;
  if (linked.test(t)) t = t.replace(linked, () => put);
  else if (inline.test(t)) t = t.replace(inline, () => put);
  return t;
}

export function createResult(conn, api) {
  const { closing, config, context, drainHostNotes, finish, followTabs, hud, internal, log, myLabel, outlines, output, pause, personTab, popups, presence, rememberPicture, reply, screenshots, session, tabClaims, tabNames, toClient } = api;
  const { callArgs, fieldNotes, ownTab, participant, refNames, refused, remote, tabActions, traces } = conn;

  // After an action in page (the tab at seenUrl): close popups (Claude's own dialog stays), let
  // the page settle before a screenshot, hand a CAPTCHA to the user, and look again for late popups.
  async function tidy(tool, page, seenUrl) {
    if (page && CLICKING_TOOLS.has(tool)) await popups.dismissOverlay(page, { markOwn: true, ...closing });
    if (page && SCREENSHOT_TOOLS.has(tool) && config.screenshots !== false) {
      // A page restored by Back (the browser's cache) fires no load event again: ask it (pageLoaded).
      await pageLoaded(page, { maxMs: LOAD_WAIT_MS });
      // Until the page is quiet, at most a second after it loaded (only what's left of it: an
      // old page is ready now) or half a second after a click (menus, single-page apps).
      const left = Math.max(CLICKING_TOOLS.has(tool) ? CLICK_SETTLE_MS : 0, SETTLE_MS - (Date.now() - presence.loadedAt(page)));
      if (left > 0) await settle(page, left);
    }
    await popups.dismissOverlay(page, { closeOffers: true, ...closing });
    await popups.checkChallenge(page);
    if (!page || !(LOADING_TOOLS.has(tool) || CLICKING_TOOLS.has(tool))) return;
    for (const ms of LATE_POPUP_CHECKS_MS) {
      setTimeout(() => {
        if (page.isClosed() || page.url() !== seenUrl || presence.agentActing()) return; // never click alongside an agent
        // Only its click (if it finds a popup) counts as PairBrowse's: a person's click while it
        // looks is theirs (agents wait for it, and hear of it).
        popups.dismissOverlay(page, { closeOffers: true, ...closing }).catch(() => {});
      }, ms).unref();
    }
  }

  // The agents this one shares its tab with (pairbrowse_collaboration share), for each result.
  function sharedNote() {
    const page = ownTab();
    const members = page ? tabClaims.members(page) : [];
    const others = members.some((m) => m.id === participant) ? members.filter((m) => m.id !== participant).map((m) => m.label) : [];
    return others.length ? `- ${others.join(", ")} also ${others.length > 1 ? "work" : "works"} in this tab: your calls take turns.` : "";
  }

  // Notes for this result: popups PairBrowse handled, downloads and join requests, and what a
  // person did in the tab meanwhile.
  function notes() {
    const handled = popups.drain(ownTab());
    // Messages from other participants, and one line on what the other side's agents are
    // doing when it changed: coordination information only, marked as from someone else.
    const paused = pause.noteAfter(conn.pauseSeen, participant);
    conn.pauseSeen = paused.n;
    // The host's notes (join requests, downloads) are for the host's own agents, never a joiner's.
    const lines = [...(remote ? [] : drainHostNotes()).map((n) => `- ${n}`), paused.text, ...fieldNotes.splice(0).map((n) => `- ${n}`), presence.userNote(conn.actingIn || hud.sparkPage(participant), remote?.name), sharedNote(), session.messagesNote(participant), session.note(participant)].filter(Boolean).join("\n");
    return handled && lines ? `${handled}\n${lines}` : handled || (lines && `\n### PairBrowse\n${lines}`);
  }

  // Every tool result on its way to the client. knownUrl: the tab it's about, when the text
  // doesn't say.
  async function finishResult(msg, tool, knownUrl = null, fullSnapshot = false, args = null) {
    const content = () => msg.result?.content || [];
    const trace = traces.get(msg.id) || phaseTrace(log);
    traces.delete(msg.id);
    trace.mark("mcp");
    let shotUrl = null;
    let ownPage = null;
    let inlined = false; // an action's result carries its snapshot inline
    let closedAway = false; // browser_tabs close left the agent in a tab that wasn't its own
    let full = fullSnapshot; // the text holds a whole-page snapshot (refNames)
    if (tool !== undefined) {
      const action = tabActions.get(msg.id);
      tabActions.delete(msg.id);
      const mineBefore = conn.mine;
      if (tool === "browser_tabs" && msg.result && !msg.result.isError) await followTabs(msg, action).catch((e) => log("tab follow", e?.message || e));
      // A tab closed: the tab it leaves the agent in gets no picture or snapshot unless it is the
      // agent's own from before (it closed another one); browser_snapshot reads the new one.
      if (tool === "browser_tabs" && action === "close" && msg.result && !msg.result.isError) {
        closedAway = !(mineBefore && mineBefore === conn.mine && !mineBefore.isClosed());
        if (closedAway) for (const part of content()) if (part.type === "text") part.text = withoutSnapshot(part.text, "### Snapshot\n- Not included: browser_snapshot reads the tab you are in now.\n");
      }
      // A new tab: a short outline of its page (as pairbrowse_run ends with), not its whole
      // snapshot; browser_snapshot gives the whole page with refs.
      if (tool === "browser_tabs" && action === "new" && msg.result && !msg.result.isError && conn.mine && !conn.mine.isClosed()) {
        const short = await within(6000, pageLoaded(conn.mine, { maxMs: 3000 }).then(() => outline(conn.mine))).catch(() => null);
        if (short) for (const part of content()) if (part.type === "text") part.text = withoutSnapshot(part.text, `### Page outline\n${short}\n- Take a browser_snapshot for its refs (the whole page).\n`);
      }
      // The browser tools act in this participant's own tab (see syncServer): the result is about
      // that page, whatever URL another tab shows.
      ownPage = conn.mine && !conn.mine.isClosed() && (tool.startsWith("browser_") || DECORATED.has(tool)) ? conn.mine : null;
      conn.snapshotReturned = tool === "browser_snapshot" || content().some((part) => /\[ref=|\]\([^)\s]*page-[^)\s]*\.ya?ml\)/.test(part.text || ""));
      const seenUrl = ownPage ? ownPage.url() : knownUrl || urlIn(content());
      shotUrl = seenUrl;
      if (seenUrl) {
        context.openPages().then((pages) => context.touch(ownPage || pages.find((p) => p.url() === seenUrl))).catch(() => {});
        context.setCurrentUrl(seenUrl);
        // A read (snapshot, find) of a tab that isn't its own moves no spark: the agent only looked.
        // A read (snapshot, find, tab list) moves no spark to a tab that isn't the reader's: it
        // only looked, and the tab may be another agent's (whose name it carries).
        const read = PAGE_READ_TOOLS.has(tool) || (tool === "browser_tabs" && action === "list");
        const owner = ownPage && hud.sparkOwner(ownPage);
        if (!(read && (!ownPage || (owner && owner.id !== participant)))) hud.moveSpark(participant, ownPage || (conn.lostTab || (remote && !conn.mine) ? null : seenUrl)).catch(() => {});
      }
      for (const part of content()) if (part.type === "text") part.text = dropClosedAlerts(trimResult(tool, part.text));
      if (tool === "browser_handle_dialog" && msg.result && !msg.result.isError && !content().some((c) => /### Result|Accepted|Dismissed/.test(c.text || ""))) {
        // The call's own arguments (callArgs is emptied before this runs): a dismiss says so.
        const a = args ?? callArgs.get(msg.id) ?? msg.params?.arguments;
        content().unshift({ type: "text", text: `${a?.accept === false ? "Dismissed" : "Accepted"} the page's dialog.` });
      }
      if (tool === "browser_snapshot" && msg.result && !msg.result.isError && content().some((c) => /```yaml\s*```/.test(c.text || ""))) {
        (msg.result.content ||= []).push({ type: "text", text: "\n### PairBrowse\n- The page shows nothing yet (still loading, or empty). browser_wait_for a second or two, then snapshot again." });
      }
      // A click the page is still at work on ("Saving…" on its button, a busy region): waited
      // for (at most BUSY_MAX_MS), then the page snapshotted again, so the result shows what the
      // click did rather than the page in the middle of it.
      if (tool === "browser_click" && ownPage && msg.result && !msg.result.isError) {
        const before = conn.busyBefore || "";
        conn.busyBefore = "";
        const busy = await within(BUSY_MAX_MS + 2000, whileBusy(ownPage, null, BUSY_MAX_MS, before)).catch(() => null);
        if (busy?.ms) {
          const fresh = await within(10_000, internal("browser_snapshot", {})).catch(() => null);
          const snap = fresh?.result && !fresh.result.isError ? (fresh.result.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
          if (snap.includes("[ref=")) {
            const kept = content().map((part) => (part.type === "text" ? { ...part, text: withoutSnapshot(part.text).replace(/^### Page\n(?:- .*\n?)*/m, "") } : part));
            msg.result.content = [...kept, { type: "text", text: `${snap.replace(/^### Result\n[\s\S]*?(?=^### )/m, "")}\n### PairBrowse\n- The page was busy ("${busy.what.slice(0, 40)}") for ${(busy.ms / 1000).toFixed(1)} s after the click: this is the page once it was done.` }];
            full = true;
          }
        }
      }
      // The main frame's refs plain, frames' with their number (refNames).
      // A snapshot saved to a file (an action's result links it) is a whole-page snapshot too.
      for (const part of content()) for (const [, link] of String(part.text || "").matchAll(/\]\(([^)\s]+page-[^)\s]*\.ya?ml)\)/g)) refNames.plainFile(resolvePath(process.cwd(), link));
      if (content().some((part) => /\[ref=|\bf\d+e\d+\b/.test(part.text || ""))) {
        // Refs of a frame number not known yet (the page moved on, no whole-page snapshot since):
        // the page says which one is its main frame now, so those come plain too.
        if (!full && ownPage) {
          for (const { seq, ref } of refNames.unknownSeqs(content().map((p) => p.text || "").join("\n"))) {
            const main = await within(1500, ownPage.locator(`aria-ref=${ref}`).elementHandle({ timeout: 1000 }).then(async (h) => { try { return (await h.ownerFrame()) === ownPage.mainFrame(); } finally { h.dispose().catch(() => {}); } })).catch(() => false);
            if (main) { refNames.learnMain(seq); break; }
          }
        }
        for (const part of content()) if (part.type === "text") part.text = refNames.toPlain(part.text, full);
      }
      // The linked snapshot file (its refs plain by now) in the result, as browser_snapshot
      // prints it: the agent acts on these refs at once. A long one is cut below as
      // browser_snapshot's is, and the file link stays only then.
      if (INLINE_SNAPSHOT_TOOLS.has(tool) && msg.result && !msg.result.isError) {
        for (const part of content()) if (part.type === "text") part.text = output.inlineSnapshot(part.text, { short: INLINE_SHORT_TOOLS.has(tool) });
        inlined = content().some((part) => /^```yaml$/m.test(part.text || ""));
        conn.snapshotReturned ||= inlined;
      }
      const tidying = context.current() ? context.openPages().then((pages) => tidy(tool, ownPage || pages.find((p) => p.url() === seenUrl), seenUrl)).catch(() => {}) : null;
      if (tidying && SCREENSHOT_TOOLS.has(tool) && config.screenshots !== false) await within(TIDY_MAX_MS, tidying);
      trace.mark("tidy");
      if (ownPage && CLICKING_TOOLS.has(tool)) await within(1000, popups.settled(ownPage)).catch(() => {});
      const text = notes();
      trace.mark("notes");
      if (text && msg.result) (msg.result.content ||= []).push({ type: "text", text });
      // What a narrow window folded away (a search box behind a button, a menu behind a hamburger).
      const foldPage = ownPage || (seenUrl ? await context.pageAt(seenUrl).catch(() => null) : null);
      const folded = foldPage && !personTab(foldPage) ? await within(3500, foldedNote(msg, tool, foldPage, args, fullSnapshot)).catch(() => "") : "";
      if (folded && msg.result) (msg.result.content ||= []).push({ type: "text", text: refNames.toPlain(folded) });
      trace.mark("folded");
    }
    // The person's own tabs: their lines say only that (indices from the open tabs, read once).
    let personIdx = null;
    for (const part of content()) if (part.type === "text") {
      output.maskLinkedFiles(part.text); part.text = tabNames.strip(output.mask(output.absoluteLinks(part.text)));
      if (tool === "browser_tabs") { const note = hiddenTabsNote(part.text); part.text = hideBrowserTabs(part.text); if (note) part.text += `${part.text.endsWith("\n") ? "" : "\n"}${note}\n`; }
      if (/^- \d+: |file:/m.test(part.text)) {
        personIdx ??= await context.openPages().then((pages) => pages.flatMap((p, i) => (personTab(p) ? [i] : []))).catch(() => []);
        part.text = hidePersonTabs(part.text, personIdx);
      }
      if (remote) part.text = forJoiner(part.text);
    }
    // The cut's note names the whole snapshot's file on this computer: for a joiner, its name only.
    if (tool === "browser_snapshot" || inlined) for (const part of content()) if (part.type === "text") { part.text = output.capSnapshot(part.text); if (remote) part.text = forJoiner(part.text); }
    // A picture also with a failed action (a stopped run, a covered click): the message says to look at it.
    if (tool !== undefined && !closedAway && SCREENSHOT_TOOLS.has(tool) && config.screenshots !== false && msg.result && (!msg.result.isError || CLICKING_TOOLS.has(tool))) {
      const shotPage = ownPage || await context.pageAt(shotUrl || context.currentUrl());
      // Never a picture of the person's own tab.
      const shot = personTab(shotPage) ? null : await screenshots.take(shotPage, participant);
      if (shot?.data) { msg.result.content.push(image(shot.data)); rememberPicture(shot, shotPage, tool, args); }
      else if (shot?.same) msg.result.content.push({ type: "text", text: SAME_PICTURE });
      else if (shot?.skipped) msg.result.content.push({ type: "text", text: `\n### PairBrowse\n- ${shot.skipped}` });
      trace.mark("shot");
    }
    // The Page tab's outline: a whole-page snapshot this agent got for its own tab, as it got it
    // (masked, cut), kept once the result went out (daemon/outline.mjs): nothing on its way.
    const outlineText = outlines && !remote && ownPage && msg.result && !msg.result.isError && ((tool === "browser_snapshot" && fullSnapshot) || inlined)
      ? content().filter((part) => part.type === "text").map((part) => part.text).join("\n") : null;
    trace.done(tool);
    toClient(msg);
    finish(msg.id);
    if (outlineText) setImmediate(() => { try { outlines.record(ownPage, { text: outlineText, who: myLabel() || "" }); } catch (e) { log("outline", e?.message || e); } });
  }

  // Compact layouts (daemon/reveal.mjs): a browser_find that found nothing, or an action on a ref
  // that's hidden or out of view, names the collapsed controls that may unfold it (with refs); a
  // whole-page snapshot of a narrow page names the controls its menus are folded behind. "" else.
  const NARROW_PX = 1024;
  async function foldedNote(msg, tool, page, args, fullSnapshot) {
    if (!msg.result || page.isClosed()) return "";
    const said = (msg.result.content || []).map((c) => c.text || "").join("\n");
    if (tool === "browser_find" && !msg.result.isError && /No matches found/i.test(said)) {
      const note = revealNote(await scanReveal(page, typeof args?.text === "string" ? args.text : ""));
      return note ? `\n### PairBrowse\n-${note}` : "";
    }
    if (FIELD_TOOLS.has(tool) || tool === "browser_click" || tool === "browser_hover") {
      if (!msg.result.isError || !isRef(args?.target) || !/hidden|into view|not visible|outside of the viewport|didn't become ready/i.test(said)) return "";
      const target = page.locator(`aria-ref=${args.target}`).first();
      const note = revealNote(await scanReveal(page, String(args.element || ""), { target }));
      return note ? `\n### PairBrowse\n-${note}` : "";
    }
    if (tool === "browser_snapshot" && fullSnapshot && !msg.result.isError) {
      const width = await within(800, page.evaluate(() => innerWidth).catch(() => null));
      if (!width || width >= NARROW_PX) return "";
      const line = foldedLine(await scanReveal(page, ""));
      return line ? `\n### PairBrowse\n${line}` : "";
    }
    return "";
  }

  // Enter after typing (browser_type with submit): on the field that has the focus now. Returns
  // the result's text: what was done, and the page it left.
  async function enterAfterTyping(page, args) {
    await page.keyboard.press("Enter");
    await within(5000, page.waitForLoadState("domcontentloaded", { timeout: 4500 })).catch(() => {});
    await settle(page, SETTLE_MS).catch(() => {});
    const title = await within(1000, page.title()).catch(() => "");
    return `Typed into ${args?.element || args?.target} and pressed Enter.\n### Page\n- Page URL: ${page.url()}${title ? `\n- Page Title: ${title}` : ""}`;
  }

  async function pressEnterAfter(msg, args) {
    const page = ownTab() || await context.pageAt(context.currentUrl());
    if (!page) return;
    msg.result.content = [{ type: "text", text: await enterAfterTyping(page, args) }];
  }

  async function respond(id, tool, r, args = null) {
    if (r.content) {
      toClient({ jsonrpc: "2.0", id, result: { content: r.content } });
      return finish(id);
    }
    if (!DECORATED.has(tool)) return reply(id, r.text, !!r.error);
    if (r.error) refused.add(id);
    return finishResult({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.text }], ...(r.error ? { isError: true } : {}) } }, tool, r.url, tool === "browser_drag", args);
  }

  return { tidy, sharedNote, notes, finishResult, foldedNote, enterAfterTyping, pressEnterAfter, respond };
}
