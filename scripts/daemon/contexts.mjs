// The driver's stale execution contexts. Patchright keeps, per tab, a map of the page's execution
// contexts (the worlds scripts run in: the page's own and the driver's isolated one). It creates
// them as needed and, so that pages can't notice it, doesn't enable the runtime events that would
// tell it when a navigation destroyed them: the map only grew, a few contexts per navigation, each
// holding its script handles, promises and error scopes (measured: the helper's heap grew 70 MB
// over 740 navigations in 27 minutes; a user's helper went from 143 to 500 MB in 42 minutes).
// Playwright's own driver gets those events and drops the contexts. Here the driver's frame
// commit, the moment it forgets a frame's old worlds for the new document, also drops that frame's
// contexts from the map, with the driver's own call for the runtime event (which also ends their
// pending waits, as a navigation does). Server-side objects are reached over the in-process
// connection; a driver whose internals differ is left alone, said once in the log.
const impl = (o) => o?._connection?.toImpl?.(o);
const PRUNED = Symbol("pairbrowse pruned");

// Installs the pruning once per process, on the frame manager class behind the first tab of the
// browser context (every tab shares it). Only the Patchright driver needs it.
export function pruneStaleContexts(context, { driver = "patchright", log = () => {} } = {}) {
  if (driver !== "patchright") return;
  const tryInstall = (page) => {
    const manager = impl(page)?.frameManager;
    const proto = manager && Object.getPrototypeOf(manager);
    if (!proto) { log("driver: its frame manager isn't reachable; stale execution contexts aren't pruned"); return; }
    if (proto[PRUNED]) return;
    const original = proto.frameCommittedNewDocumentNavigation;
    if (typeof original !== "function") { log("driver: no frame commit to prune stale execution contexts at"); return; }
    proto.frameCommittedNewDocumentNavigation = function (frameId, ...rest) {
      try {
        const frame = this._frames?.get(frameId);
        const session = frame && this._page?.delegate?._sessionForFrame?.(frame);
        const map = session?._contextIdToContext;
        if (map && typeof session._onExecutionContextDestroyed === "function") {
          for (const [id, ctx] of [...map]) if (ctx.frame === frame) session._onExecutionContextDestroyed(id);
        }
      } catch (e) {
        log(`driver: pruning stale execution contexts: ${e?.message || e}`);
      }
      return original.call(this, frameId, ...rest);
    };
    proto[PRUNED] = true;
  };
  const first = context.pages()[0];
  if (first) tryInstall(first);
  else context.once("page", tryInstall);
}

// How many execution contexts the driver holds for the context's tabs, over all their frame
// sessions (tests: the count stays put as a tab navigates).
export function contextCount(context) {
  let n = 0;
  for (const page of context.pages()) {
    const sessions = impl(page)?.delegate?._sessions;
    if (!sessions) continue;
    for (const session of sessions.values()) n += session?._contextIdToContext?.size ?? 0;
  }
  return n;
}
