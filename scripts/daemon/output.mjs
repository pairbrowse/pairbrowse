// What Claude reads back: passwords masked in results and in the snapshot files they point to,
// an action's snapshot file brought into its result, long snapshots cut short, and those files
// swept up after a while.
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { redact } from "../secrets.mjs";

// Playwright's own snapshot and console files in the files folder; never your own files there.
const PLAYWRIGHT_OUTPUT = /^(page|console|network)-[\dT:.Z-]+\.(ya?ml|log|md|txt)$/;
// They're only read right after the action that wrote them (one or two per action).
const KEEP_FILES_MS = 60 * 60_000;
const SWEEP_EVERY_MS = 10 * 60_000;
// A snapshot of a long article or feed runs to tens of thousands of tokens, most of it text Claude
// doesn't need for a form. Over SNAPSHOT_MAX characters, Claude gets the start of it (whole lines)
// and the rest goes to a file, with a pointer to the narrower tools.
const SNAPSHOT_MAX = 24_000;
// An action's result links the snapshot the browser server took, in a file: the agent needs the
// refs in it now, not after a second call, so it comes in the result (inlineSnapshot). Typing and
// hovering change little on the page: theirs come inline only up to this many characters, so a
// long page isn't sent again for every field.
const INLINE_SHORT_MAX = 6000;

// dir: the files folder Playwright writes to. secretValues(): the saved passwords by name.
export function createOutput({ dir, secretValues }) {
  const mask = (text) => redact(text, secretValues());

  function maskFile(file) {
    try {
      const text = readFileSync(file, "utf8");
      const clean = mask(text);
      if (clean !== text) writeFileSync(file, clean);
    } catch {}
  }
  // Snapshot files a result links to: masked before Claude sees the link.
  function maskLinkedFiles(text) {
    for (const [, link] of String(text).matchAll(/\]\(([^)\s]+)\)/g)) {
      const file = join(dir, basename(link));
      if (PLAYWRIGHT_OUTPUT.test(basename(file)) && existsSync(file)) maskFile(file);
    }
  }

  function sweep() {
    const old = Date.now() - KEEP_FILES_MS;
    try {
      for (const f of readdirSync(dir)) {
        if (!PLAYWRIGHT_OUTPUT.test(f)) continue;
        const file = join(dir, f);
        try { if (statSync(file).mtimeMs < old) rmSync(file, { force: true }); } catch {}
      }
    } catch {}
  }

  // The "- [Snapshot](files/page-....yml)" line of an action's result becomes the file's text, as
  // browser_snapshot prints it (a yaml block under the "### Snapshot" heading); capSnapshot then
  // cuts a long one as it cuts browser_snapshot's, and only then does a file link stay. short: the
  // link stays (with a word to snapshot for fresh refs) past INLINE_SHORT_MAX characters. Only
  // Playwright's own files in the files folder are read, as maskLinkedFiles masks only those; the
  // file is masked first, so what's on disk is as clean as what the agent reads.
  function inlineSnapshot(text, { short = false } = {}) {
    return String(text).replace(/^- \[Snapshot\]\(([^)\s]+)\)[^\n]*$/m, (line, link) => {
      const file = join(dir, basename(link));
      if (!PLAYWRIGHT_OUTPUT.test(basename(file)) || !existsSync(file)) return line;
      maskFile(file);
      let snap;
      try { snap = readFileSync(file, "utf8"); } catch { return line; }
      snap = snap.replace(/^```ya?ml\r?\n/, "").replace(/\r?\n```\s*$/, "").replace(/\s+$/, "");
      if (short && snap.length > INLINE_SHORT_MAX) return `${line}: long (about ${Math.round(snap.length / 4)} tokens). Take a browser_snapshot for fresh refs.`;
      return `\`\`\`yaml\n${snap}\n\`\`\``;
    });
  }

  // Already masked by now. A dialog that sits past the cut (a consent wall at the end of the
  // tree, over everything) comes along: it's the one thing on the page that matters right now.
  function capSnapshot(text) {
    if (text.length <= SNAPSHOT_MAX * 1.25) return text; // a little over isn't worth cutting
    const file = join(dir, `page-${new Date().toISOString().replace(/:/g, "-")}.yml`);
    try { writeFileSync(file, text); } catch {}
    const cut = text.lastIndexOf("\n", SNAPSHOT_MAX);
    const tokens = Math.round(text.length / 4);
    const kept = text.slice(0, cut > 0 ? cut : SNAPSHOT_MAX);
    const dialogs = dialogsPast(text.slice(kept.length));
    return `${kept}\n${dialogs ? `  # ... (cut) ...\n${dialogs}\n` : ""}\`\`\`\n\n### PairBrowse\n- This page's snapshot is long (about ${tokens} tokens); you got the first part${dialogs ? ", and the dialog open over the page (from further down)" : ""}. ` +
      `For the rest use browser_find (text or regex), or browser_snapshot with depth or target (a ref). The whole snapshot is in ${file}.`;
  }
  // The dialog and alertdialog subtrees in a snapshot's tail (up to 4000 characters of them).
  function dialogsPast(tail) {
    const lines = tail.split("\n");
    const out = [];
    for (let i = 0; i < lines.length && out.join("\n").length < 4000; i++) {
      if (!/^\s*- (alert)?dialog\b/.test(lines[i])) continue;
      const indent = lines[i].match(/^ */)[0].length;
      out.push(lines[i]);
      for (i++; i < lines.length && (lines[i].match(/^ */)[0].length > indent || !lines[i].trim()); i++) if (lines[i].trim()) out.push(lines[i]);
      i--;
    }
    return out.join("\n").slice(0, 4000);
  }
  // A result's links to Playwright's own files, made absolute: they come relative to the
  // helper's working folder, which means nothing to Claude.
  function absoluteLinks(text) {
    return String(text).replace(/\]\(([^)\s]+)\)/g, (m, link) => (PLAYWRIGHT_OUTPUT.test(basename(link)) && !/^(\/|[A-Za-z]:\\|file:|https?:)/.test(link) ? `](${join(dir, basename(link))})` : m));
  }

  // At startup: old files swept (before masking, which would make them look new), the rest
  // masked with today's passwords, then a sweep now and then.
  function start() {
    sweep();
    try { for (const f of readdirSync(dir)) if (PLAYWRIGHT_OUTPUT.test(f)) maskFile(join(dir, f)); } catch {}
    setInterval(sweep, SWEEP_EVERY_MS).unref();
  }

  return { mask, maskLinkedFiles, inlineSnapshot, capSnapshot, absoluteLinks, start };
}

// Playwright's error for a browser tool, said plainly (its call logs, selectors and escape codes
// are for developers). Returns the plain text, or null when the error isn't one of the known
// kinds (it then goes as it is, without escape codes).
export function plainError(tool, text) {
  const t = String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const first = t.replace(/^### Error\s*/i, "").split("\n")[0].replace(/^(Error: )+/, "");
  const el = (() => { const m = t.match(/<(\w+)([^>]*)>/); if (!m) return ""; const a = (n) => (m[2].match(new RegExp(`${n}="([^"]*)"`, "i")) || [])[1]; const name = a("aria-label") || a("title") || a("id"); return `<${m[1]}${name ? ` ${name.slice(0, 40)}` : ""}>`; })();
  const again = "Look at the screenshot, take a browser_snapshot, then act on what's there.";
  if (/intercepts pointer events/i.test(t)) return `Something covers it${el ? ` (${el})` : ""}: a dialog, banner or overlay. Take a browser_snapshot to see it (browser_find finds its buttons), deal with it, then try again.`;
  if (/detached from the DOM|not attached to the DOM|Element is not attached/i.test(t)) return `The page changed under the action (the element was replaced). Take a browser_snapshot and use its fresh ref.`;
  if (/does not handle the modal state|related modal state/i.test(t)) {
    if (/file ?chooser/i.test(t)) return "A file chooser is open: give it files with browser_file_upload (paths), or close it with browser_file_upload and paths: [].";
    if (/dialog/i.test(t)) return "The page is waiting on its dialog (alert, confirm or prompt): answer it with browser_handle_dialog first.";
    return "The page is waiting on something modal (a dialog or a file chooser): browser_handle_dialog answers a dialog, browser_file_upload with paths: [] closes a file chooser.";
  }
  if (/Element is not a <select> element/i.test(t)) return `That ref isn't a dropdown (<select>)${el ? `: it's ${el}` : ""}. For a styled dropdown, click it and then its option; for a <select>, use its own ref.`;
  if (/Element is not an <input>|not an <input>, <textarea>/i.test(t)) return `That ref isn't a field you can type into${el ? ` (${el})` : ""}. ${again}`;
  if (/Unknown key/i.test(t)) return `${first.replace(/^keyboard\.press: /, "")}. Keys are named as in the DOM ("Enter", "Escape", "ArrowDown", "Control+a").`;
  if (/net::ERR_ABORTED/i.test(t)) return "The page load was interrupted (the address started a download, or the page sent the browser elsewhere); the tab still shows what it showed before. Take a browser_snapshot.";
  if (/Malformed value/i.test(t)) return "That field takes one exact shape: a date YYYY-MM-DD, a time hh:mm, a month YYYY-MM, a colour #rrggbb.";
  if (/page\.goto: Timeout/i.test(t)) return `The page didn't finish loading in ${Math.round(Number(t.match(/Timeout (\d+)ms/i)?.[1] || 60000) / 1000)} s: it's slow or stuck. Look at the screenshot; browser_snapshot shows what's there so far.`;
  if (/net::ERR_NAME_NOT_RESOLVED/i.test(t)) return "That address doesn't exist (the name didn't resolve). Check the URL.";
  if (/net::ERR_CONNECTION_REFUSED/i.test(t)) return "Nothing answers at that address (connection refused). Is the server running?";
  if (/net::ERR_(CONNECTION_TIMED_OUT|TIMED_OUT)/i.test(t)) return "That address didn't answer in time.";
  if (/net::ERR_(CERT|SSL)/i.test(t)) return "That site's certificate isn't trusted; the browser won't open it.";
  if (/net::ERR_[A-Z_]+/.test(t)) return `The page couldn't be loaded (${t.match(/net::ERR_[A-Z_]+/)[0]}).`;
  if (/Timeout \d+ms exceeded/i.test(t)) {
    const secs = Math.round(Number(t.match(/Timeout (\d+)ms/i)[1]) / 1000);
    const why = /element is not enabled|disabled/i.test(t) ? "it's disabled right now (wait for the page, or fill what it needs first)"
      : /element is not visible|hidden/i.test(t) ? "it's hidden right now"
      : /outside of the viewport|scrolling into view/i.test(t) ? "it couldn't be brought into view"
      : /waiting for getByText|waitFor/i.test(t) ? "the text didn't show up (or go away) in time"
      : /waiting for locator|waiting for/i.test(t) ? "it didn't become ready (hidden, covered, disabled or still loading)"
      : "the page didn't finish in time";
    return `Couldn't do it in ${secs} s: ${why}. ${again}`;
  }
  if (/^(Error: )?Target page, context or browser has been closed/i.test(first)) return "That tab closed. browser_tabs list shows what's open.";
  if (/Tab (-?\d+) not found/i.test(first)) return `There's no tab ${first.match(/Tab (-?\d+)/i)[1]}. browser_tabs list shows the open tabs and their numbers.`;
  if (/Tab index is required/i.test(first)) return "browser_tabs select and close take index: the tab's number from browser_tabs list.";
  return null;
}

// Snapshot refs as Claude reads them. Playwright numbers the main frame anew on every navigation
// to a new page (its refs then read f1e5, f3e5, ...), so a ref from the page before can never
// match one in the page after. To an agent the prefix reads as "inside a frame", which it isn't.
// Claude gets the main frame's refs plain (e5) and frames' refs with their prefix; a plain ref it
// sends gets the main frame's number back when it's one it was given for this page, else it goes
// as it is (a ref from the page before stays one Playwright turns away).
export function createRefNames() {
  // One state per agent: the whole-page snapshot it last got sets the main frame's number; the
  // refs handed out plain since then are the ones a plain ref it sends can mean.
  let state = null; // { seq, refs: Set }
  // The main frame's number in a snapshot: that of the first ref outside any iframe's subtree
  // (an iframe's own ref is its parent's). null when the text has no ref of the main frame.
  function mainFrameSeq(text) {
    let inFrame = -1; // the indent of the iframe whose subtree is being skipped
    for (const line of String(text).split("\n")) {
      const indent = line.match(/^ */)[0].length;
      if (inFrame >= 0) { if (indent > inFrame) continue; inFrame = -1; }
      const m = line.match(/\[ref=(?:f(\d+))?e\d+\]/);
      if (/^\s*- iframe\b/.test(line)) { if (m) return m[1] === undefined ? 0 : Number(m[1]); inFrame = indent; continue; }
      if (m) return m[1] === undefined ? 0 : Number(m[1]);
    }
    return null;
  }
  // A result's text for Claude. full: the text holds a whole-page snapshot (only that tells the
  // main frame's number; a find result or a snapshot of one element doesn't).
  function toPlain(text, full = false) {
    const t = String(text ?? "");
    if (full && /\[ref=/.test(t)) {
      const seq = mainFrameSeq(t);
      if (seq !== null && seq !== state?.seq) state = { seq, refs: new Set() };
    }
    if (!state?.seq) return t;
    return t.replace(new RegExp(`\\bf${state.seq}(e\\d+)\\b`, "g"), (_m, e) => { state.refs.add(e); return e; });
  }
  // A snapshot file an action's result links to (the whole page): read and rewritten the same way.
  function plainFile(file) {
    try {
      const text = readFileSync(file, "utf8");
      const plain = toPlain(text, true);
      if (plain !== text) writeFileSync(file, plain);
    } catch {}
  }
  // The ref as Claude sent it, for a message about a call whose refs were given their number.
  const sent = new Map(); // framed -> plain, the last few
  const plainOf = (ref) => sent.get(String(ref)) || String(ref ?? "");
  // Claude's arguments for a call, with the main frame's number back on its plain refs.
  function toFrame(args) {
    if (!state?.seq || !args || typeof args !== "object") return args;
    const fix = (v) => { if (!(typeof v === "string" && /^e\d+$/.test(v) && state.refs.has(v))) return v; const f = `f${state.seq}${v}`; sent.set(f, v); if (sent.size > 50) sent.delete(sent.keys().next().value); return f; };
    let changed = false;
    const out = { ...args };
    for (const k of ["target", "startTarget", "endTarget", "ref"]) if (typeof out[k] === "string" && fix(out[k]) !== out[k]) { out[k] = fix(out[k]); changed = true; }
    if (Array.isArray(out.fields)) {
      const fields = out.fields.map((f) => (f && typeof f === "object" && fix(f.target) !== f.target ? { ...f, target: fix(f.target) } : f));
      if (fields.some((f, i) => f !== out.fields[i])) { out.fields = fields; changed = true; }
    }
    return changed ? out : args;
  }
  return { toPlain, toFrame, mainFrameSeq, plainOf, plainFile };
}
