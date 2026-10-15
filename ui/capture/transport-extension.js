// The capture page as the extension's offscreen document (plain Chromium, and a PairBrowse build
// without its own pages): the worker (background.js pbShare, pbRecord) mints the tab's stream id
// and asks here with chrome.runtime messages addressed { to: "share", op }. The ops and answers
// are the ones the offscreen document has always had: has, offer, answer, stop, stopTab, resize,
// take, peers, and rec* for record.js.
import { has, offer, answer, stopPeer, stopTab, resize, take, peers } from "./capture.js";
import { record } from "./record.js";

export function handle(m) {
  if (m.op === "has") return has(m.tabId);
  if (m.op === "offer") return offer(m);
  if (m.op === "answer") return answer(m);
  if (m.op === "stop") { stopPeer(m.peer); return true; }
  if (m.op === "stopTab") { stopTab(m.tabId); return true; }
  if (m.op === "resize") return resize(m);
  if (m.op === "take") return take(m);
  if (m.op === "peers") return peers();
  if (String(m.op).startsWith("rec")) return record(m);
  return { error: "unknown" };
}

export function listen(runtime) {
  runtime.onMessage.addListener((m, _sender, reply) => {
    if (m?.to !== "share") return;
    (async () => handle(m))().then(reply, (e) => reply({ error: String(e?.message || e) }));
    return true;
  });
}
