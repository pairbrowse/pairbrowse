// The tool server's wire: which tools get which treatment (from the catalog), the client's
// messages as the browser server reads them, and results as they go out (to a joiner's agent, to
// an app without pictures). Pure: no state, no page.
import { homedir, tmpdir } from "node:os";
import { paths } from "../../paths.mjs";
import { isRef } from "../../policy.mjs";
import { HELPER_TOOLS, toolsWith } from "../../tools/catalog.mjs";

// The helper's own tools, listed after the browser's, and each tool's rules below: the catalog's.
export const PAIRBROWSE_TOOLS = HELPER_TOOLS;
// A small picture of the page goes with each result that changes what's on screen, taken once
// the page has loaded and settled for a second: the layout, overlays and images the text
// snapshot can't show. config.screenshots = false turns it off.
export const SCREENSHOT_TOOLS = toolsWith("screenshot");
// Results after which the page may load new popups (checked again a few seconds later); after
// Claude's clicks, overlays already on screen count as Claude's own and stay.
export const LOADING_TOOLS = toolsWith("loading");
// Actions whose result links the page's snapshot in a file: the snapshot comes in the result
// instead (output.inlineSnapshot), so the next action needs no browser_snapshot first. Typing and
// hovering get theirs only when short (INLINE_SHORT_TOOLS).
export const INLINE_SNAPSHOT_TOOLS = toolsWith("inline");
export const INLINE_SHORT_TOOLS = toolsWith("inlineShort");
export const CLICKING_TOOLS = toolsWith("clicking");
// Tools that act in the participant's tab: they take turns per tab (TabClaims) and wait for a
// person using that tab.
export const TAB_TOOLS = toolsWith("tab");
// Tools that fill a field: a field a person is filling is left to them (daemon/fields.mjs).
export const FIELD_TOOLS = toolsWith("field");
// Tools that read the current tab without taking its turn (anyone may watch any tab).
export const PAGE_READ_TOOLS = toolsWith("pageRead");
// PairBrowse's own tools that answer before (or without) the browser being ready.
export const NO_WAIT = toolsWith("noWait");
// Tools that don't wait for the session picker: they choose a session themselves or only talk.
export const NO_PICK_WAIT = toolsWith("noPickWait");
// Its own tools that act in a page: their results get the same notes and screenshot as the
// browser tools'. browser_drag is the helper's own too (daemon/drag.mjs): a drag as a hand does
// it, where Playwright's makes one move and most boards put the card back.
export const DECORATED = toolsWith("decorated");
// Helper tools that act in the agent's tab, refused there when it is one of the browser's own pages.
export const CHROME_GUARDED = toolsWith("chromeGuarded");
// Calls after which other participants' refs may be stale.
export const changesPage = (tool) => tool?.startsWith("browser_") || tool?.startsWith("pairbrowse_click") || ["pairbrowse_run", "pairbrowse_upload", "pairbrowse_session"].includes(tool);

// A client's message as the browser server reads it, or null. The server drops a message it can't
// read (another jsonrpc, an object id, params that aren't an object, a field it doesn't know, a
// malformed _meta) without answering, and a tool call waiting for that answer would hold the
// shared queue until the turn cap. So only the fields it knows go on, and _meta's typed ones only
// when they're the right type.
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const RELATED_TASK = "io.modelcontextprotocol/related-task";
export function wellFormed(msg) {
  if (!isObject(msg) || msg.jsonrpc !== "2.0") return null;
  const { id, method, params } = msg;
  if (id !== undefined && typeof id !== "string" && typeof id !== "number") return null;
  // An answer to one of the server's own requests (roots/list, elicitation).
  if (method === undefined) return id === undefined ? null : "error" in msg ? { jsonrpc: "2.0", id, error: Number.isInteger(msg.error?.code) && typeof msg.error.message === "string" ? msg.error : { code: -32603, message: "Malformed error" } } : { jsonrpc: "2.0", id, result: isObject(msg.result) ? msg.result : {} };
  if (typeof method !== "string" || (params !== undefined && !isObject(params))) return null;
  let p = params;
  if (p && "_meta" in p) {
    const { _meta, ...rest } = p;
    const meta = isObject(_meta) ? { ..._meta } : null;
    if (meta && meta.progressToken !== undefined && typeof meta.progressToken !== "string" && typeof meta.progressToken !== "number") delete meta.progressToken;
    if (meta && meta[RELATED_TASK] !== undefined && typeof meta[RELATED_TASK]?.taskId !== "string") delete meta[RELATED_TASK];
    p = meta ? { ...rest, _meta: meta } : rest;
  }
  return { jsonrpc: "2.0", ...(id !== undefined ? { id } : {}), method, ...(p !== undefined ? { params: p } : {}) };
}

// browser_handle_dialog gets an element, like a click: what OK confirms, named with its class
// ("Delete: OK") when it's a final action. The helper reads it and drops it before the browser server.
export function withDialogLabel(t) {
  if (t.name !== "browser_handle_dialog" || !t.inputSchema?.properties) return t;
  const element = { type: "string", description: 'What OK confirms. Start with its class when it pays, deletes, publishes, sends or submits for review ("Delete: OK"): the user confirms.' };
  return { ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, element } } };
}

// Playwright MCP calls it target (ref in older versions); only snapshot refs go stale, not selectors.
export function containsRef(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, v]) => ((key === "ref" || key === "target") && typeof v === "string" && isRef(v)) || containsRef(v));
}

// The tab a result is about: its "- Page URL:" line, or the current tab in a tab list.
export const urlIn = (content) => content.map((c) => c.text || "").join("\n").match(/^- Page URL: (\S+)|\(current\)[^\n]*?\]\(([^)\s]+)\)/m)?.slice(1).find(Boolean);

// Shared browser mode: what a joiner's agent (a remote participant, daemon/remote-agents.mjs) may
// use here, and the paths that name files it sent over.
export const REMOTE_TOOLS = toolsWith("remote");
// A result on its way to a joiner's agent: nothing of this computer's folders. Links to files
// saved here (snapshots, downloads) keep their name only; this computer's home becomes "~".
export function forJoiner(text, homes = [paths.home, homedir(), tmpdir()]) {
  const t = String(text ?? "").replace(/\]\(((?:\.{1,2}[\\/]|[\\/]|~[\\/]|[A-Za-z]:[\\/]|file:)[^)\s]*)\)/g, (_m, p) => `](on the host's computer: ${String(p).split(/[\\/]/).pop()})`)
    // A long snapshot's note (output.mjs capSnapshot) names the whole snapshot's file: as the link does.
    .replace(/\bis in ((?:[\\/]|~[\\/]|[A-Za-z]:[\\/])[^\s]*?page-[^\s)]*\.ya?ml)(?=[.\s]|$)/g, (_m, p) => `is on the host's computer: ${String(p).split(/[\\/]/).pop()}`);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const byLength = homes.filter(Boolean).map(String).sort((a, b) => b.length - a.length);
  // A home only as a whole path ("/tmp" is not in "/private/tmp", "/tmp-files" or "/tmp.txt").
  const end = "(?![\\w-]|\\.\\w)";
  const homeAt = byLength.map((h) => new RegExp(`(?<![\\w.~-])${esc(h)}${end}`, "g"));
  // In a web address, only where a value starts (after "=", "?", "&" or "#"; also percent-encoded),
  // so its own path ("https://a.example/Foo_(b)/tmp") is never touched.
  const homeInUrl = byLength.flatMap((h) => [new RegExp(`(?<=[=?&#])${esc(h)}${end}`, "g"), new RegExp(`(?<=[=?&#])${esc(h).replace(/\//g, "%2F")}(?![\\w-]|\\.\\w|%(?!2F))`, "gi")]);
  return t.split(/(https?:\/\/[^\s"'`<>]+)/i).map((part, i) => (i % 2 ? homeInUrl.reduce((s, re) => s.replace(re, "~"), part) : homeAt.reduce((s, re) => s.replace(re, "~"), part)
    // Other places on this computer (accounts, temp and system folders, other disks): the name only.
    .replace(/(?<![\w.~-])(?:\/(?:Users|home|root|private|tmp|var\/folders|Volumes|mnt|media)|[A-Za-z]:\\(?:Users|Windows|Temp))[\\/][^\s"'`)\]]+/g, (m) => `~/${m.split(/[\\/]/).pop()}`))).join("");
}
// A result's words for an agent that gets no pictures: "the screenshot" becomes a snapshot.
export function pictureless(text) {
  return String(text ?? "")
    .replace(/\b([Ll])ook at the screenshot\b/g, (_, l) => `${l === "L" ? "T" : "t"}ake a browser_snapshot`)
    .replace(/\b([Cc])heck the screenshot\b/g, (_, c) => `${c === "C" ? "T" : "t"}ake a browser_snapshot`)
    .replace(/\bthe screenshot\b/g, "a browser_snapshot");
}

// An alert (or a leave-page question) PairBrowse closes at once (popups.mjs): the browser server's
// "Modal state" still lists it as waiting for browser_handle_dialog. Only the true statement stays
// (PairBrowse's note that it closed it); a confirm or prompt the page waits on stays listed.
export function dropClosedAlerts(text) {
  const t = String(text ?? "");
  if (!/### Modal state/.test(t)) return t;
  const out = t.replace(/^- \["(alert|beforeunload)" dialog with message [^\n]*\]: can be handled by browser_handle_dialog\n?/gm, "");
  return out.replace(/### Modal state\n(?=###|\s*$)/g, "");
}
