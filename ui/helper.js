// Where a page finds its helper: the live view's address with the owner's key,
// `${origin}/${key}/`. One copy for every page. The page's host is decided once (hostKind): the
// PairBrowse browser's own API (window.pairbrowse, ui/pairbrowse-adapter.js) in the native build,
// else the side panel extension's session storage ("view", in memory, never on disk, written by
// background.js), else neither (a plain file: the page renders its defaults and connects to
// nothing). Definitions only: nothing runs on import. A flat file at the ui/ root (the native
// build refuses a ui/<dir> without index.html).

// "native" (the browser's API), "extension" (the extension's storage) or "" (neither).
export function hostKind(scope = globalThis) {
  if (typeof scope.pairbrowse?.session?.helper === "function") return "native";
  try { if (scope.chrome?.storage?.session) return "extension"; } catch {}
  return "";
}

// The browser's answer as an address: both parts non-empty strings, else null (a browser started
// without a helper answers with no address, or with nothing at all).
const addressOf = (h) => (h && typeof h.origin === "string" && h.origin && typeof h.key === "string" && h.key ? `${h.origin}/${h.key}/` : null);

// -> the address, or null when there is none (the browser has no helper; the extension's worker
// has not stored one yet). Rejects when there is no way to ask (hostKind ""), or asking failed.
export async function askHelper(scope = globalThis) {
  const host = hostKind(scope);
  if (host === "native") return addressOf(await scope.pairbrowse.session.helper());
  if (host === "extension") {
    const got = await scope.chrome.storage.session.get("view");
    return typeof got?.view === "string" && got.view ? got.view : null;
  }
  throw new Error("No way to ask for PairBrowse's address here.");
}
// The same, null for every failure.
export const helperAddress = (scope = globalThis) => askHelper(scope).catch(() => null);

// fn(address) each time the extension's worker stores a new address (a helper restarted on a new
// key). The browser's API has no such notice (its helper keeps one address for the browser's
// life), so there it never runs. -> stop().
export function onHelperAddress(fn, scope = globalThis) {
  if (hostKind(scope) !== "extension") return () => {};
  const changed = (changes, area) => {
    const view = area === "session" ? changes?.view?.newValue : undefined;
    if (typeof view === "string" && view) fn(view);
  };
  try { scope.chrome.storage.onChanged.addListener(changed); } catch { return () => {}; }
  return () => { try { scope.chrome.storage.onChanged.removeListener(changed); } catch {} };
}

// A page's whole lookup: connect(address) now and on every later address; none() when there is
// no helper to ask; failed() when asking failed (default: none). wait: an extension page whose
// storage has no address yet waits for one (the side panel's worker stores it when the helper
// starts) instead of calling none(). -> stop() (no further connect).
export function followHelper({ connect, none = () => {}, failed = none, wait = false, scope = globalThis }) {
  let stopped = false;
  const host = hostKind(scope);
  const stop = onHelperAddress((url) => { if (!stopped) connect(url); }, scope);
  askHelper(scope).then((url) => {
    if (stopped) return;
    if (url) connect(url);
    else if (!(wait && host === "extension")) none();
  }, () => { if (!stopped) failed(); });
  return () => { stopped = true; stop(); };
}

// Whether the browser's build has PairBrowse's settings as the engine settings' PairBrowse section
// (580; its manifest's settingsSection): the helper's config.json says so (settingsSection).
// false without an address, an answer or the field (an older helper or build).
export const settingsSectionAt = (base, scope = globalThis) => (base
  ? Promise.resolve().then(() => scope.fetch(base + "config.json")).then((r) => (r.ok ? r.json() : null)).then((c) => c?.settingsSection === true).catch(() => false)
  : Promise.resolve(false));

// ---- asking the helper ----
// The words when the helper couldn't be reached, the same on every page; _RETRY where a press can
// simply go again.
export const UNREACHABLE = "Couldn't reach PairBrowse.";
export const UNREACHABLE_RETRY = `${UNREACHABLE} Try again.`;
// A JSON body POSTed (the owner's routes take JSON only). -> the fetch's promise (a Response).
export const postJson = (url, body, scope = globalThis) => scope.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
// The same, as { status, body } (body: the reply's JSON, else null); status 0 when the helper
// couldn't be reached. Never rejects.
export const postReply = (url, body, scope = globalThis) => postJson(url, body, scope)
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }), () => ({ status: 0, body: null }));
