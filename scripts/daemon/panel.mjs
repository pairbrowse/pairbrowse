// The PairBrowse browser's side panel (an extension): it shows the live view and the
// notifications "PairBrowse needs you". Reached through its service worker over the browser's
// own protocol, on the private pipe.
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { panelExtensionId } from "../browser.mjs";
import { sleep } from "../util.mjs";

const NOTIFY_TITLE = "PairBrowse needs you";

// context(): the browser context's promise, or null while it's closed. liveViewUrl(): starts the
// live view if needed and returns its address.
export function createPanel({ context, liveViewUrl, log }) {
  let panelId = null; // the side panel's extension id as the browser runs it
  const origins = []; // its origin once connected (the live view lets it in)

  // Runs code in the side panel's service worker. Patchright hides service workers from
  // Playwright, so ask the browser directly. timeoutMs bounds the whole try, so a worker that
  // stops mid-answer never leaves a debugging session open.
  async function workerEvaluate(expression, timeoutMs = 4000) {
    const ctx = await context();
    const page = ctx?.pages().find((p) => !p.isClosed());
    if (!page) throw new Error("no page");
    const until = Date.now() + timeoutMs;
    const cdp = await ctx.newCDPSession(page);
    let sessionId = null;
    try {
      const find = async () => {
        const { targetInfos } = await cdp.send("Target.getTargets");
        // By shape, not by the expected id: an engine may load the extension from a copy elsewhere,
        // which gives it another id. It's the only extension PairBrowse loads.
        const workers = targetInfos.filter((t) => t.type === "service_worker" && /^chrome-extension:\/\/[a-p]{32}\/background\.js$/.test(t.url));
        return { sw: workers.find((t) => t.url.includes(panelExtensionId())) || workers[0], targetInfos };
      };
      let { sw, targetInfos } = await find();
      if (!sw) {
        // An extension's worker only runs on demand and stops when idle: start it, then wait for
        // it to show (a busy computer can take seconds, so poll rather than a fixed pause).
        await cdp.send("ServiceWorker.enable").catch(() => {});
        await cdp.send("ServiceWorker.startWorker", { scopeURL: `chrome-extension://${panelId || panelExtensionId()}/` }).catch(() => {});
        while (!sw && Date.now() < until) { await sleep(150); ({ sw, targetInfos } = await find()); }
      }
      if (!sw) throw new Error(`side panel worker not running (${targetInfos.filter((t) => t.type === "service_worker").map((t) => t.url.slice(0, 60)).join(", ") || "no workers"})`);
      panelId = new URL(sw.url).host;
      ({ sessionId } = await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: false }));
      let timer;
      const answer = new Promise((ok, no) => {
        timer = setTimeout(() => no(new Error("the side panel's worker didn't answer")), Math.max(500, until - Date.now()));
        cdp.on("Target.receivedMessageFromTarget", (m) => {
          if (m.sessionId !== sessionId) return;
          const msg = JSON.parse(m.message);
          if (msg.id !== 1) return;
          if (msg.error || msg.result?.exceptionDetails) no(new Error(msg.error?.message || msg.result.exceptionDetails.exception?.description?.split("\n")[0] || "error in the side panel"));
          else ok(msg.result?.result?.value);
        });
        // The worker went away while attached (stopped, restarted): ask again, don't wait it out.
        cdp.on("Target.detachedFromTarget", (m) => { if (m.sessionId === sessionId) no(new Error("the side panel's worker stopped")); });
      });
      await cdp.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }) });
      try { return await answer; } finally { clearTimeout(timer); }
    } finally {
      if (sessionId) cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
      cdp.detach().catch(() => {});
    }
  }

  // Calls fn(arg) in the side panel's worker. It can take a while to answer after the browser
  // starts (and a stopped worker never answers), so ask the current worker again until timeoutMs.
  async function call(fn, arg, timeoutMs = 15_000) {
    const until = Date.now() + timeoutMs;
    let last = "timed out";
    for (let tries = 0; tries === 0 || Date.now() < until; tries++) {
      // Each try gets at least 2 s (so a short timeoutMs still has one full try), at most 8 s.
      const r = await workerEvaluate(`(${fn})(${JSON.stringify(arg)})`, Math.min(8000, Math.max(2000, until - Date.now()))).then((v) => ({ v }), (e) => { last = e?.message || String(e); return null; });
      if (r) return r.v;
      if (Date.now() < until) await sleep(Math.min(500, Math.max(0, until - Date.now())));
    }
    throw new Error(`no answer from the side panel (${last})`);
  }

  // When the user is needed (sign-in, 2FA, CAPTCHA, an approval, a join request): a
  // notification through the side panel, else from the system.
  function notify(text) {
    const id = randomBytes(8).toString("hex"); // the same id on a retry: shown once
    const say = String(text).slice(0, 200);
    call(([t, m, i]) => globalThis.pbNotify?.(t, m, i), [NOTIFY_TITLE, say, id], 5000)
      .then((r) => { if (r !== "queued" && r !== "already shown") throw new Error(`the side panel answered ${JSON.stringify(r)}`); log("notification sent"); })
      .catch((e) => {
        // The text goes as an argument, never into the script.
        log(`notification through the side panel failed (${e?.message || e}); using the system's`);
        if (process.platform === "darwin") execFile("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"", "-e", "end run", NOTIFY_TITLE, say], () => {});
        else if (process.platform === "linux") execFile("notify-send", [NOTIFY_TITLE, say], () => {});
      });
  }

  // The side panel gets the live view address in memory, through its service worker (session
  // storage, never on disk). Its origin is read from the worker itself.
  async function connect() {
    const url = await liveViewUrl();
    await call((u) => globalThis.pbSetView(u), url, 30_000);
    const origin = `chrome-extension://${panelId || panelExtensionId()}`;
    if (!origins.includes(origin)) origins.push(origin);
    log(`side panel connected (${origin})`);
  }

  return { notify, connect, origins, call };
}
