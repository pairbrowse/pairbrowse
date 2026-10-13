// The Tools tab's Diagnostics (the owner only): the helper's version, the browser in use, who is
// connected, and the last error lines of daemon.log, scrubbed of saved secrets, keys, paths beyond
// ~/.pairbrowse, full addresses, emails and quoted page text. The plain-text report is what a
// later, person-clicked send would carry; nothing here sends anything. Node's standard library only.
import { open, stat } from "node:fs/promises";
import { homedir, platform, arch, release } from "node:os";
import { paths } from "../paths.mjs";

const LINE_MAX = 200;
const TAIL_BYTES = 256 * 1024;
const REPORT_MAX = 64 * 1024;
const ERRORS_MAX = 20;
const ERROR_WORDS = /\b(error|failed|fail|couldn't|can't|cannot|unhandled|uncaught|exception|refused|timed out|crash(ed)?|lost)\b/i;
const WHERE = /^[a-z][a-z-]{1,23}:?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A line safe to show and to leave the computer later. quotes: false keeps quoted text, for a
// sentence of the helper's own that holds no page text (its folders and addresses still go).
// For a person's own words (Report a problem's "What happened?", liveview/report.mjs): max: the
// length kept (default a line's 200); addresses: "path" keeps a web address's origin and path (no
// user info, query or fragment) instead of its host alone; emails: false keeps email addresses.
export function scrub(text, { home = homedir(), mask = (t) => t, quotes = true, max = LINE_MAX, addresses = "host", emails = true } = {}) {
  let s = String(text ?? "");
  try { s = String(mask(s)); } catch {}
  // Addresses: the host alone (no user info, path or query); file:// says only that it was a file.
  // One pass, so a kept address isn't read again: anything that only looks like one goes too.
  s = s.replace(/(?:[a-z][a-z0-9+.-]*)?:\/\/[^\s"'<>]*/gi, (m) => {
    if (m.startsWith(":")) return "[url]";
    if (/^file:/i.test(m)) return "[file]";
    try {
      const u = new URL(m);
      if (addresses === "path" && (u.protocol === "https:" || u.protocol === "http:")) return `${u.origin}${u.pathname}`;
      return u.host || "[url]";
    } catch { return "[url]"; }
  });
  if (emails) s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]");
  const h = String(home || "").replace(/[\\/]+$/, "");
  if (h) {
    s = s.split(`${h}/.pairbrowse`).join("~/.pairbrowse");
    s = s.replace(new RegExp(`${esc(h)}[^\\s"'<>]*`, "g"), "[path]");
  }
  s = s.replace(/~(?!\/\.pairbrowse)\/[^\s"'<>]*/g, "[path]");
  s = s.replace(/(?<![\w.~-])\/(?:Users|home|private|var|tmp|Volumes|opt)\/[^\s"'<>]*/g, "[path]");
  s = s.replace(/\b[A-Za-z]:\\[^\s"'<>]*/g, "[path]");
  s = s.replace(/\b(key|token|secret|password|passwd|authorization)(?:\s*[=:]\s*(?:bearer\s+|basic\s+)?|\s+(?:bearer|basic)\s+)\S+/gi, "$1=[hidden]");
  s = s.replace(/[A-Za-z0-9_-]{32,}/g, "[key]");
  if (quotes) s = s.replace(/"[^"\n]*"/g, "\"…\"");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// The last error lines of the helper's log (it also takes the helper's stderr), read from its
// last 256 KB only, when asked: [{ at, where, text }].
export async function lastErrors({ file = paths.daemonLog, home = homedir(), mask, max = ERRORS_MAX } = {}) {
  let fh;
  try {
    const { size } = await stat(file);
    const from = Math.max(0, size - TAIL_BYTES);
    fh = await open(file, "r");
    const buf = Buffer.alloc(size - from);
    const { bytesRead } = await fh.read(buf, 0, buf.length, from);
    let lines = buf.subarray(0, bytesRead).toString("utf8").split("\n");
    if (from > 0) lines = lines.slice(1); // the first one is cut
    const out = [];
    for (const line of lines) {
      const sp = line.indexOf(" ");
      const stamp = sp > 0 ? line.slice(0, sp) : "";
      const isStamped = ISO.test(stamp);
      const body = isStamped ? line.slice(sp + 1) : line;
      if (!body.trim() || body.startsWith("trace ") || !ERROR_WORDS.test(body)) continue;
      const first = body.split(" ", 1)[0];
      const named = WHERE.test(first);
      out.push({ at: isStamped ? Date.parse(stamp) : 0, where: named ? first.replace(/:$/, "") : "helper", text: scrub(named ? body.slice(first.length + 1) : body, { home, mask }) });
    }
    return out.slice(-max);
  } catch { return []; } finally { await fh?.close().catch(() => {}); }
}

// The browser's version from what the helper already pins, never from the running browser (a
// persistent context has no Browser to ask): the installed native build's record, else the pinned
// ungoogled-chromium on macOS; for Chromium the driver's browsers.json. No launch, no read of the page.
// nativeRecord / browsersJson: the parsed files (or null); null when nothing is known.
export function pinnedBrowserVersion({ engine, nativeRecord = null, ungoogled = null, browsersJson = null } = {}) {
  const str = (v) => (typeof v === "string" && v ? v : null);
  if (engine === "pairbrowse") return str(nativeRecord?.version) ?? str(ungoogled);
  if (engine === "chromium") {
    const c = Array.isArray(browsersJson?.browsers) ? browsersJson.browsers.find((b) => b?.name === "chromium") : null;
    return str(c?.browserVersion) ?? (c?.revision != null ? `r${c.revision}` : null);
  }
  return null;
}

// version: the helper's version. browser(): { engine, version, build } (never a path). agents():
// agents connected now. read() gives the parts the helper knows; the live view adds connections.
export function createDiagnostics({ version = "", browser = async () => ({ engine: null, version: null, build: null }), agents = () => 0, logFile = paths.daemonLog, home = homedir(), mask = (t) => t } = {}) {
  const clean = (t) => scrub(t, { home, mask });
  return {
    async read() {
      let b = { engine: null, version: null, build: null };
      try { b = { ...b, ...(await browser()) }; } catch {}
      return {
        helper: { version: String(version || ""), node: process.versions.node, uptime: Math.round(process.uptime()) },
        browser: { engine: b.engine ?? null, version: b.version ?? null, build: b.build ?? null },
        agents: Number(agents()) || 0,
        errors: await lastErrors({ file: logFile, home, mask }),
      };
    },
    // The plain-text report: people joined as counts per role, never by name.
    reportText(diag = {}) {
      const c = diag.connections || {};
      const roles = { drive: 0, watch: 0 };
      for (const j of diag.joined || []) if (j?.role in roles) roles[j.role]++;
      const lines = [
        "PairBrowse diagnostics report",
        `Created: ${new Date().toISOString()}`,
        `Helper: ${diag.helper?.version || "?"} (Node ${diag.helper?.node || "?"}, up ${diag.helper?.uptime ?? "?"} s)`,
        `OS: ${platform()} ${arch()} ${release()}`,
        `Browser: ${diag.browser?.engine || "none"} ${diag.browser?.version || "?"}${diag.browser?.build ? ` (build ${diag.browser.build})` : ""}`,
        `Connections: ${c.agents ?? 0} agents, ${c.viewers ?? 0} viewers, ${c.joiners ?? 0} joiners, ${c.streams ?? 0} streams`,
        `Joined: ${roles.drive} drive, ${roles.watch} watch`,
        (diag.errors || []).length ? "Errors:" : "Errors: none",
        ...(diag.errors || []).map((e) => `${e.at ? new Date(e.at).toISOString() : "?"} ${e.where}: ${e.text}`),
      ].map(clean);
      let text = "";
      for (const l of lines) { if (text.length + l.length + 1 > REPORT_MAX) break; text += `${l}\n`; }
      return text;
    },
  };
}
