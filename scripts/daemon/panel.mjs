// The PairBrowse browser's side panel (an extension): it shows the live view and the
// notifications "PairBrowse needs you". Reached through its service worker over the browser's
// own protocol, on the private pipe.
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { panelExtensionId, panelBuild } from "../browser.mjs";
import { sleep } from "../util.mjs";

const NOTIFY_TITLE = "PairBrowse needs you";

// What to do with the side panel's worker, by the build it reports (running: undefined while it
// didn't answer, null for an earlier version's worker that reports none) and the one its file on
// disk declares (expected). A browser can keep running an old cached copy of the worker after an
// update (it then lacks newer functions, such as the join notification's Allow and Deny): it's
// replaced at the next browser start (checkBuild below).
export function workerFreshness({ running, expected }) {
  if (running === undefined) return "unknown"; // no answer yet: ask again later
  if (!expected || running === expected) return "current";
  return "stale";
}

// context(): the browser context's promise, or null while it's closed. liveViewUrl(): starts the
// live view if needed and returns its address. expectedBuild(): the worker build on disk.
// onStale(): the browser runs an old worker (its record is dropped, see checkBuild).
export function createPanel({ context, liveViewUrl, log, expectedBuild = () => panelBuild(), onStale = () => {} }) {
  let panelId = null; // the side panel's extension id as the browser runs it
  const origins = []; // its origin once connected (the live view lets it in)
  const checked = new WeakMap(); // browser context -> what checkBuild found

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

  // Whether the worker the browser runs is the one on disk (workerFreshness), once per browser
  // run. An old one can't be swapped in place (chrome.runtime.reload leaves a command-line
  // extension disabled, and the browser's own update calls keep its cached copy), so its record
  // is dropped (onStale) and the next browser start loads it anew (resetPanelWorker in
  // browser.mjs); meanwhile it's used as it is (a join notification without buttons goes out as
  // the system's). Returns what it found.
  async function checkBuild() {
    const ctx = await context();
    if (!ctx) return "unknown";
    if (checked.has(ctx)) return checked.get(ctx);
    const expected = expectedBuild();
    const running = await call(() => globalThis.pbBuild ?? null, null, 8000).catch(() => undefined);
    const what = workerFreshness({ running, expected });
    if (what === "unknown") return what;
    checked.set(ctx, what);
    if (what === "stale") {
      log(`side panel: the browser runs an old copy of its worker (build ${running ?? "none"}, not ${expected}); it's loaded anew at the next browser start`);
      onStale();
    }
    return what;
  }
  // Tests only: the build is checked again.
  const recheck = async () => { const ctx = await context(); if (ctx) checked.delete(ctx); return checkBuild(); };

  // From the system, when the side panel can't (text only). The text goes as an argument, never
  // into the script.
  function systemNotify(say) {
    if (process.platform === "darwin") execFile("osascript", ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv) sound name \"Glass\"", "-e", "end run", NOTIFY_TITLE, say], () => {});
    else if (process.platform === "linux") execFile("notify-send", [NOTIFY_TITLE, say], () => {});
  }

  // When the user is needed (sign-in, 2FA, CAPTCHA, an approval): a notification through the
  // side panel, else from the system.
  function notify(text) {
    const id = randomBytes(8).toString("hex"); // the same id on a retry: shown once
    const say = String(text).slice(0, 200);
    call(([t, m, i]) => globalThis.pbNotify?.(t, m, i), [NOTIFY_TITLE, say, id], 5000)
      .then((r) => { if (r !== "queued" && r !== "already shown") throw new Error(`the side panel answered ${JSON.stringify(r)}`); log("notification sent"); })
      .catch((e) => {
        log(`notification through the side panel failed (${e?.message || e}); using the system's`);
        systemNotify(say);
      });
  }

  // A join request (daemon/joinprompt.mjs) while the person isn't looking at the browser: a
  // notification with Allow and Deny (the side panel's worker answers a press: background.js),
  // else the system's, text only, pointing to the side panel. who: "Sam (Claude Code)"; role:
  // drive or watch; request: its id.
  function notifyJoin({ who, role, request }) {
    const head = `${String(who).slice(0, 80)} wants to join (${role === "drive" ? "drive" : "watch"}).`;
    call(([t, m, r]) => (globalThis.pbNotifyJoin ? globalThis.pbNotifyJoin(t, m, r) : "no buttons"), [NOTIFY_TITLE, `${head} Allow or Deny here, or in the PairBrowse side panel.`, String(request)], 5000)
      .then((r) => { if (r !== "queued" && r !== "already shown") throw new Error(`the side panel answered ${JSON.stringify(r)}`); log(`notification sent (join request ${request}, with Allow and Deny)`); })
      .catch((e) => {
        log(`notification through the side panel failed (${e?.message || e}); using the system's`);
        systemNotify(`${head} Answer in the PairBrowse side panel.`);
      });
  }
  // The request was answered or is gone: its notification goes (best effort).
  function clearJoin(request) {
    call((r) => globalThis.pbClearJoin?.(r) ?? false, String(request), 3000).catch(() => {});
  }

  // The side panel gets the live view address in memory, through its service worker (session
  // storage, never on disk). Its origin is read from the worker itself. Then its build is checked.
  async function connect() {
    const url = await liveViewUrl();
    await call((u) => globalThis.pbSetView(u), url, 30_000);
    const origin = `chrome-extension://${panelId || panelExtensionId()}`;
    if (!origins.includes(origin)) origins.push(origin);
    log(`side panel connected (${origin})`);
    await checkBuild().catch(() => {});
  }

  return { notify, notifyJoin, clearJoin, connect, origins, call, recheck };
}
