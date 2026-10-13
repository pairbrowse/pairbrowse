// Report a problem (the owner-only live view route POST report, liveview.mjs): the browser's own
// Settings page shows the person exactly the JSON it sends (ui/common.js reportPayload, schema
// "pairbrowse-report/1"); the helper checks it, scrubs it again, and relays it over HTTPS to the
// report address in ~/.pairbrowse/config.json (reportUrl), only on that person's click. The pages
// hold no key, token or server address, and neither does the helper: the report server files the
// ticket with its own credentials. Node's standard library only.
//
// readReport(body) -> { report } (the body checked, every key known, every field typed and sized)
// or { error }. scrubReport(report, { home, mask }) -> the same shape with saved passwords masked,
// home paths, keys and tokens removed, addresses in the person's words cut to origin and path, in
// the diagnostics text to the host, and the ticked tab's address to its origin and path.
// postReport(url, text) -> { status, body } or { error }: one HTTPS POST, no credentials, no
// cookies, no redirect followed, 10 s at most, an answer of at most 4 KB.
// createReporter({ url, home, mask, send, now, log }) -> { enabled(), relay(body) -> { status, body } }.
import https from "node:https";
import { homedir } from "node:os";
import { scrub } from "../daemon/diagnostics.mjs";

export const REPORT_SCHEMA = "pairbrowse-report/1";
export const REPORT_BODY_MAX = 64 * 1024;
export const REPORT_WHAT_MAX = 4000;
export const REPORTS_PER_HOUR = 5;
export const REPORT_TIMEOUT_MS = 10_000;
const HOUR_MS = 3_600_000;
const ANSWER_MAX = 4096;
const URL_MAX = 2048;
const DIAG_LINES_MAX = 400;
export const REPORT_ID = /^[A-Za-z0-9._-]{1,40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/; // tabs and newlines are text; nothing else below a space

const plainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const only = (o, keys) => Object.keys(o).find((k) => !keys.includes(k));

// config.reportUrl, checked: an https address with no user info, query or fragment (a token in
// it would be a credential the helper holds). The address, or null.
export function reportUrlFrom(value) {
  if (typeof value !== "string" || !value || value.length > URL_MAX || /[\u0000-\u0020\u007f]/.test(value)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== "https:" || !u.hostname || u.username || u.password || u.search || u.hash) return null;
  return u.href;
}

const SHAPE = 'A report is { schema: "pairbrowse-report/1", createdAt, what, app, platform, helperState, diagnostics, tab }.';
// A short text field: a string of at most max characters with no control characters (or null where allowed).
const shortText = (v, max, nullable = true) => (v === null ? nullable : typeof v === "string" && v.length <= max && !CONTROL.test(v));
const count = (v) => v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1e12);

export function readReport(body) {
  if (!plainObject(body)) return { error: SHAPE };
  const extra = only(body, ["schema", "createdAt", "what", "app", "platform", "helperState", "diagnostics", "tab"]);
  if (extra !== undefined) return { error: `Unknown field "${String(extra).slice(0, 40)}" in the report.` };
  if (body.schema !== REPORT_SCHEMA) return { error: `schema is "${REPORT_SCHEMA}".` };
  if (typeof body.createdAt !== "string" || !ISO.test(body.createdAt) || !Number.isFinite(Date.parse(body.createdAt))) return { error: "createdAt is an ISO time." };
  if (typeof body.what !== "string" || !body.what.trim() || body.what.length > REPORT_WHAT_MAX) return { error: `what is what happened, 1 to ${REPORT_WHAT_MAX} characters.` };
  const { app, platform, helperState: st, tab } = body;
  if (!plainObject(app) || only(app, ["host", "page", "helper", "browser"]) !== undefined) return { error: "app is { host, page, helper, browser }." };
  if (app.host !== "pairbrowse" && app.host !== "chromium") return { error: 'app.host is "pairbrowse" or "chromium".' };
  if (typeof app.page !== "string" || !/^[a-z0-9-]{0,40}$/.test(app.page)) return { error: "app.page is a page's name." };
  if (!shortText(app.helper, 40)) return { error: "app.helper is a version or null." };
  const b = app.browser;
  if (!plainObject(b) || only(b, ["engine", "version", "build"]) !== undefined) return { error: "app.browser is { engine, version, build }." };
  for (const k of ["engine", "version", "build"]) if (!shortText(b[k], 60) && !(k === "build" && typeof b[k] === "number" && Number.isInteger(b[k]) && b[k] >= 0)) return { error: `app.browser.${k} is a short text or null.` };
  if (!plainObject(platform) || only(platform, ["os", "mobile", "language"]) !== undefined) return { error: "platform is { os, mobile, language }." };
  if (!shortText(platform.os, 60, false) || typeof platform.mobile !== "boolean" || !shortText(platform.language, 35, false)) return { error: "platform is { os, mobile, language }." };
  const STATE = ["connection", "uptime", "agents", "viewers", "joiners", "streams", "errors"];
  if (!plainObject(st) || only(st, STATE) !== undefined) return { error: `helperState is { ${STATE.join(", ")} }.` };
  if (!shortText(st.connection, 20, false)) return { error: "helperState.connection is a short text." };
  for (const k of STATE.slice(1)) if (!count(st[k])) return { error: `helperState.${k} is a number or null.` };
  if (typeof body.diagnostics !== "string" || body.diagnostics.length > REPORT_BODY_MAX) return { error: "diagnostics is the helper's report text." };
  if (tab !== null) {
    if (!plainObject(tab) || only(tab, ["url"]) !== undefined || typeof tab.url !== "string" || tab.url.length > URL_MAX) return { error: "tab is null or { url }." };
    let u;
    try { u = new URL(tab.url); } catch { return { error: "tab.url is a web address." }; }
    if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "tab.url is a web address." };
  }
  return { report: body };
}

// The report as it leaves: every text the person didn't type is the helper's own or a count. Text
// that could hold something private goes through the diagnostics scrub again (secrets.mjs's saved
// passwords masked; home paths, keys and tokens out); the person's words keep emails and quoted
// text but lose queries and fragments; the diagnostics text keeps hosts only; the tab is the one
// address the person ticked, as origin and path.
export function scrubReport(r, { home = homedir(), mask = (t) => t } = {}) {
  const short = (v, max) => (v === null || v === undefined ? null : scrub(String(v), { home, mask, quotes: false, max, addresses: "host" }));
  const lines = String(r.diagnostics).split("\n").slice(0, DIAG_LINES_MAX).map((l) => scrub(l, { home, mask }));
  let tab = null;
  if (r.tab) {
    const u = new URL(r.tab.url);
    tab = { url: scrub(`${u.origin}${u.pathname}`, { home, mask, quotes: false, max: URL_MAX, addresses: "path", emails: false }) };
  }
  return {
    schema: REPORT_SCHEMA,
    createdAt: r.createdAt,
    what: scrub(r.what.trim(), { home, mask, quotes: false, max: REPORT_WHAT_MAX, addresses: "path", emails: false }),
    app: { host: r.app.host, page: r.app.page, helper: short(r.app.helper, 40),
      browser: { engine: short(r.app.browser.engine, 60), version: short(r.app.browser.version, 60), build: r.app.browser.build === null ? null : short(r.app.browser.build, 60) } },
    platform: { os: short(r.platform.os, 60), mobile: r.platform.mobile, language: short(r.platform.language, 35) },
    helperState: { ...r.helperState, connection: short(r.helperState.connection, 20) },
    diagnostics: lines.join("\n"),
    tab,
  };
}

// One HTTPS POST of text (JSON) to url: no credentials, no cookies, no redirect followed (a 3xx is
// a failure), a bounded time and answer. request: https.request (tests pass a stand-in).
export function postReport(url, text, { request = https.request, timeoutMs = REPORT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    const timer = setTimeout(() => { req?.destroy(); finish({ error: `The report server didn't answer within ${Math.round(timeoutMs / 1000)} seconds.` }); }, timeoutMs);
    let u;
    try { u = new URL(url); } catch { return finish({ error: "The report address isn't valid." }); }
    if (u.protocol !== "https:") return finish({ error: "The report address isn't https." });
    try {
      req = request(u, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", "content-length": Buffer.byteLength(text) } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => { body += c; if (body.length > ANSWER_MAX) { req.destroy(); finish({ error: "The report server's answer was too long." }); } });
        res.on("end", () => finish({ status: res.statusCode, body }));
        res.on("error", () => finish({ error: "The report server's answer broke off." }));
      });
      req.on("error", () => finish({ error: "Couldn't reach the report server." }));
      req.end(text);
    } catch { finish({ error: "Couldn't reach the report server." }); }
  });
}

// url(): config.reportUrl as given (checked here each time). send(url, text): postReport. now():
// the clock (tests). A relay is { status, body } for the route: 404 without an address, 409 for a
// report that isn't one, 429 past REPORTS_PER_HOUR in the last hour, 502 when the server didn't
// take it, else 200 { ok: true, id } (id: the server's reference, when it gave a well-formed one).
export function createReporter({ url = () => null, home = homedir(), mask = (t) => t, send = postReport, now = () => Date.now(), log = () => {} } = {}) {
  const sent = []; // when each relay of the last hour started
  const address = () => { try { return reportUrlFrom(url()); } catch { return null; } };
  return {
    enabled: () => address() !== null,
    async relay(body) {
      const to = address();
      if (!to) return { status: 404 };
      const r = readReport(body);
      if (r.error) return { status: 409, body: { error: r.error } };
      while (sent.length && now() - sent[0] >= HOUR_MS) sent.shift();
      if (sent.length >= REPORTS_PER_HOUR) return { status: 429, body: { error: `${REPORTS_PER_HOUR} reports went out in the last hour; try again later, or copy it instead.` } };
      sent.push(now());
      const answer = await Promise.resolve().then(() => send(to, JSON.stringify(scrubReport(r.report, { home, mask })))).catch(() => ({ error: "Couldn't reach the report server." }));
      if (answer?.error) { log(`report not sent: ${answer.error}`); return { status: 502, body: { error: answer.error } }; }
      const status = Number(answer?.status) || 0;
      if (status < 200 || status > 299) {
        log(`report not sent: the server answered ${status}`);
        return { status: 502, body: { error: status >= 300 && status < 400 ? "The report server answered with a redirect; nothing was sent on." : `The report server didn't take it (HTTP ${status}).` } };
      }
      let id = null;
      try { const j = JSON.parse(answer.body); if (typeof j?.id === "string" && REPORT_ID.test(j.id)) id = j.id; } catch {}
      log(`report sent${id ? ` (${id})` : ""}`);
      return { status: 200, body: id ? { ok: true, id } : { ok: true } };
    },
  };
}
