// The landing page of a hand-off link (spec server-mode B-AP1, B3): opening it uses nothing up,
// so a chat app's link preview is harmless. Only the tap on "Take over" posts redeem, which uses
// the link's key once and answers the viewer's address; the page moves there without leaving
// itself in the history. Served by liveview/grants.mjs under the page's strict CSP.
// The handed-over tab shows above Take over, view only: a still (thumb.jpg, card fields covered)
// fetched about once a second while the page is in view, shown as a data: image (the CSP allows no
// other image source). A link preview runs no script, so it never fetches one.
const take = document.getElementById("take");
const problem = document.getElementById("problem");
const base = location.pathname.replace(/\/?$/, "/");

// The deadline in this device's own time (the server wrote it in UTC).
const expires = Number(document.body.dataset.expires);
if (Number.isFinite(expires) && expires > 0) {
  const at = new Date(expires);
  document.getElementById("until").textContent = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  document.getElementById("until").dateTime = at.toISOString();
}

function say(text) {
  problem.textContent = text;
  problem.hidden = false;
}

take.addEventListener("click", async () => {
  take.disabled = true;
  problem.hidden = true;
  try {
    const r = await fetch(`${base}redeem`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", cache: "no-store" });
    const body = await r.json().catch(() => ({}));
    if (r.ok && typeof body.view === "string" && /^\/[0-9a-f]{64}\/$/.test(body.view)) return location.replace(body.view);
    say(body.error || "This hand-off link was used already or has ended. Ask for a new one if the step is still open.");
  } catch {
    take.disabled = false;
    say("Couldn't reach PairBrowse. Check your connection and tap Take over again.");
  }
});

// The tab as it is now, about once a second while this page is in view.
const peek = document.getElementById("peek");
const peekImg = document.getElementById("peek-img");
const PEEK_MS = 1000;
let peekTimer = 0, peeking = false;
const asDataUrl = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.onerror = () => resolve(null); r.readAsDataURL(blob); });
async function refreshPeek() {
  if (peeking || document.hidden || take.disabled) return;
  peeking = true;
  try {
    const r = await fetch(`${base}thumb.jpg?q=60`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const url = await asDataUrl(await r.blob());
      if (url) { peekImg.src = url; peek.dataset.ready = "true"; }
    }
  } catch {} finally { peeking = false; }
}
function peekLoop() { clearTimeout(peekTimer); refreshPeek().finally(() => { peekTimer = setTimeout(peekLoop, PEEK_MS); }); }
document.addEventListener("visibilitychange", () => { if (!document.hidden) peekLoop(); });
peekLoop();
