// What Claude reads back: passwords masked in results and in the snapshot files they point to,
// long snapshots cut short, and those files swept up after a while.
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

  // Already masked by now.
  function capSnapshot(text) {
    if (text.length <= SNAPSHOT_MAX * 1.25) return text; // a little over isn't worth cutting
    const file = join(dir, `page-${new Date().toISOString().replace(/:/g, "-")}.yml`);
    try { writeFileSync(file, text); } catch {}
    const cut = text.lastIndexOf("\n", SNAPSHOT_MAX);
    const tokens = Math.round(text.length / 4);
    return `${text.slice(0, cut > 0 ? cut : SNAPSHOT_MAX)}\n\`\`\`\n\n### PairBrowse\n- This page's snapshot is long (about ${tokens} tokens); you got the first part. ` +
      `For the rest use browser_find (text or regex), or browser_snapshot with depth or target (a ref). The whole snapshot is in ${file}.`;
  }

  // At startup: old files swept (before masking, which would make them look new), the rest
  // masked with today's passwords, then a sweep now and then.
  function start() {
    sweep();
    try { for (const f of readdirSync(dir)) if (PLAYWRIGHT_OUTPUT.test(f)) maskFile(join(dir, f)); } catch {}
    setInterval(sweep, SWEEP_EVERY_MS).unref();
  }

  return { mask, maskLinkedFiles, capSnapshot, start };
}

// Snapshot refs as Claude reads them. Playwright numbers the main frame anew on every navigation
// to a new page (its refs then read f1e5, f3e5, ...), so a ref from the page before can never
// match one in the page after. To an agent the prefix reads as "inside a frame", which it isn't.
// Claude gets the main frame's refs plain (e5) and frames' refs with their prefix; a plain ref it
// sends gets the main frame's number back when it's one it was given for this page, else it goes
// as it is (a ref from the page before stays one Playwright turns away).
export function createRefNames() {
  const known = new WeakMap(); // tab -> { seq, refs: Set of the plain refs handed out }
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
  // A result's text for Claude, about page.
  function toPlain(page, text) {
    const t = String(text ?? "");
    if (!page) return t;
    let state = known.get(page);
    if (/\[ref=/.test(t)) {
      const seq = mainFrameSeq(t);
      if (seq !== null && seq !== state?.seq) { state = { seq, refs: new Set() }; known.set(page, state); }
    }
    if (!state?.seq) return t;
    return t.replace(new RegExp(`\\bf${state.seq}(e\\d+)\\b`, "g"), (_m, e) => { state.refs.add(e); return e; });
  }
  // Claude's arguments for a call in page, with the main frame's number back on its plain refs.
  function toFrame(page, args) {
    const state = page && known.get(page);
    if (!state?.seq || !args || typeof args !== "object") return args;
    const fix = (v) => (typeof v === "string" && /^e\d+$/.test(v) && state.refs.has(v) ? `f${state.seq}${v}` : v);
    let changed = false;
    const out = { ...args };
    for (const k of ["target", "startTarget", "endTarget", "ref"]) if (typeof out[k] === "string" && fix(out[k]) !== out[k]) { out[k] = fix(out[k]); changed = true; }
    if (Array.isArray(out.fields)) {
      const fields = out.fields.map((f) => (f && typeof f === "object" && fix(f.target) !== f.target ? { ...f, target: fix(f.target) } : f));
      if (fields.some((f, i) => f !== out.fields[i])) { out.fields = fields; changed = true; }
    }
    return changed ? out : args;
  }
  return { toPlain, toFrame, mainFrameSeq };
}
