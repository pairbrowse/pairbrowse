// Report a problem: the payload, sending it through the helper, and the offer on a page's error
// state. Shared by Settings, the picker, Sessions and the right dock (common.js re-exports it; the
// live view serves it). A flat file at the ui/ root; definitions only, nothing runs on import.
import { reportUrl, TOP_SHELL_HOST, settingsPage } from "./urls.js";
import { postJson, UNREACHABLE } from "./helper.js";
import { el } from "./dom.js";

// Report a problem (Settings → About and diagnostics). reportPayload builds exactly the JSON the
// PairBrowse server receives; the review screen shows it before anything is sent. It holds the
// person's words, the app's versions, the platform, the helper's state (counts, never names) and
// the diagnostics report the helper already masks; the tab's address only when the person ticked
// it (origin and path, no query or fragment). Never page contents, form values, passwords,
// secrets, cookies or other tabs. sendReport posts it to the helper's owner route `report`, which
// relays it to the report address in the helper's config: the pages hold no key, token or server
// address (connect-src is the helper's origin only). -> { ok, id? } or { ok: false, error }.
const REPORT_SCHEMA = "pairbrowse-report/1";
const REPORT_WHAT_MAX = 4000;
export function reportPayload({ what = "", host = "", page = "", connection = "", diag = null, report = "", tab = null, now = new Date() } = {}) {
  const h = diag?.helper || {}, b = diag?.browser || {}, c = diag?.connections || {};
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const ua = globalThis.navigator?.userAgentData;
  return {
    schema: REPORT_SCHEMA,
    createdAt: now.toISOString(),
    what: String(what || "").trim().slice(0, REPORT_WHAT_MAX),
    app: {
      // The report service's wire value for the open build stays "chromium" (pairbrowse.com/api/report checks it).
      host: host === "pairbrowse" ? "pairbrowse" : "chromium",
      page: String(page || ""),
      helper: h.version ? String(h.version) : null,
      browser: { engine: b.engine ?? null, version: b.version ?? null, build: b.build ?? null },
    },
    platform: { os: String(ua?.platform || globalThis.navigator?.platform || ""), mobile: !!ua?.mobile, language: String(globalThis.navigator?.language || "") },
    helperState: { connection: String(connection || ""), uptime: num(h.uptime), agents: num(c.agents), viewers: num(c.viewers), joiners: num(c.joiners), streams: num(c.streams), errors: Array.isArray(diag?.errors) ? diag.errors.length : null },
    diagnostics: String(report || ""),
    tab: tab ? { url: String(tab) } : null,
  };
}
export async function sendReport(base, payload) {
  if (!base) return { ok: false, error: "PairBrowse isn't connected." };
  let r;
  try {
    r = await postJson(base + "report", payload);
  } catch {
    return { ok: false, error: UNREACHABLE };
  }
  const body = await r.json().catch(() => null);
  if (r.ok && body?.ok !== false) return { ok: true, ...(typeof body?.id === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(body.id) ? { id: body.id } : {}) };
  if (r.status === 404) return { ok: false, error: "This PairBrowse doesn't send reports." };
  return { ok: false, error: typeof body?.error === "string" && body.error ? body.error.slice(0, 200) : "The report server didn't take it." };
}
// The offer on a page's error state: a "Report a problem" link to Settings' review screen, only
// while the helper relays reports (config.json report). -> the element, or null. A window slot
// page opens Settings with the browser's tabs; a tab page of the browser follows the link itself;
// the extension opens its own settings page.
export async function reportOffer(base) {
  if (!base) return null;
  const c = await fetch(base + "config.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (c?.report !== true) return null;
  // A build with the engine settings' PairBrowse section (580) has Settings there; an older one
  // has its own tab page.
  const section = c.settingsSection === true;
  const a = el("a", { className: "report-offer", href: reportUrl(section), textContent: "Report a problem", target: "_blank", rel: "noopener" });
  a.addEventListener("click", (ev) => {
    const pb = globalThis.pairbrowse;
    if (pb && location.host === TOP_SHELL_HOST) { ev.preventDefault(); pb.tabs.create(settingsPage("report", section), true, -1).catch(() => {}); return; }
    if (pb) return; // a tab page: the link itself
    const tabs = globalThis.chrome?.tabs, runtime = globalThis.chrome?.runtime;
    if (tabs?.create && runtime?.getURL) { ev.preventDefault(); tabs.create({ url: runtime.getURL("settings/index.html#report") }); }
  });
  return a;
}
