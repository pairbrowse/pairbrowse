// A hand-off end to end (spec server-mode section 5, B-AP1, B3, B9, B11, B15): a real helper and
// browser with hand-offs going to a loopback webhook (Away on, decision 8). The agent says "you";
// the webhook gets the step's kind, host, expiry and link; the link's landing page is opened
// (a preview, nothing used up), "Take over" is posted, and the person acts through the real view
// key the way the phone viewer sends input (liveview-turn.js: taps as mouse press and release,
// keys as `char`); the agent is refused in that tab, its wait returns on Done, and it goes on
// signed in. Then a person who never finishes (PAIRBROWSE_TEST_TURN_MS): one reminder, the stop,
// a held tab that keeps what was typed, a new hand-off to that same tab, and the tabs back after
// a helper restart. And T-B18: whether open select and autofill lists reach the phone's picture,
// and the viewer's option list that stands in for the select list. Live: PAIRBROWSE_TEST_RUNTIME;
// the person's side is plain HTTP, so one browser.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { attachDaemon, session } from "../helpers/live.mjs";
import { sleep, text, until } from "../helpers/util.mjs";
import { helperHome, spawnDaemon, stopDaemon } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const SHOP = "http://shop.pbtest.example";

// What a page reports: fetch("/ev?k=..&v=..") from the shop and from its cross-origin frame.
const REPORT = `<script>const ev=(k,v="")=>fetch("/ev?"+new URLSearchParams({k,v:String(v)}),{cache:"no-store"});</script>`;
const ABS = (x, y, w, h) => `position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;box-sizing:border-box`;
// Where the person taps, in page pixels (the viewer's frame is the page at its CSS size).
const AT = { signIn: [120, 45], otp0: [40, 40], agree: [35, 115], frameBox: [345, 45], hold: [120, 230], tap: [120, 310], touchOnly: [120, 390], note: [170, 40] };

const PAGES = {
  "/login": () => `<!doctype html><title>Sign in</title><body style="margin:0">${REPORT}
<form method="post" action="/login"><button id="signin" style="${ABS(20, 20, 200, 50)}">Sign in</button></form>`,
  // The verification step: a six-box code that moves on keydown, a checkbox Tab reaches and Space
  // ticks, a checkbox in another site's frame, a button that measures a hold, a tap target, a
  // touch-only target (measured), and the way on.
  "/verify": (signedIn) => !signedIn ? "<!doctype html><title>Verify</title><p>Please sign in first</p>" : `<!doctype html><title>Verify</title><body style="margin:0">${REPORT}
<div id="otp">${[0, 1, 2, 3, 4, 5].map((i) => `<input class="d" maxlength="1" autocomplete="one-time-code" style="${ABS(20 + i * 45, 20, 40, 40)}">`).join("")}</div>
<input type="checkbox" id="agree" style="${ABS(20, 100, 30, 30)}">
<iframe src="http://frame.pbtest.example/box" style="${ABS(320, 20, 200, 120)};border:0"></iframe>
<button id="hold" style="${ABS(20, 200, 200, 60)}">Hold</button>
<div id="tap" style="${ABS(20, 280, 200, 60)};background:#ddd">Tap</div>
<div id="touchonly" style="${ABS(20, 360, 200, 60)};background:#eee">Touch</div>
<a href="/account" style="${ABS(20, 440, 200, 40)}">Continue to your account</a>
<script>
const boxes=[...document.querySelectorAll(".d")];
boxes.forEach((b,i)=>b.addEventListener("keydown",(e)=>{if(/^\\d$/.test(e.key)){e.preventDefault();b.value=e.key;(boxes[i+1]||b).focus();ev("code",boxes.map((x)=>x.value).join(""));}}));
const agree=document.getElementById("agree");
agree.addEventListener("focus",()=>ev("focus","agree"));
agree.addEventListener("change",()=>ev("agree",agree.checked));
let down=0;const hold=document.getElementById("hold");
hold.addEventListener("pointerdown",()=>{down=performance.now();});
hold.addEventListener("pointerup",()=>{if(down)ev("held",Math.round(performance.now()-down));down=0;});
document.getElementById("tap").addEventListener("click",()=>ev("tap",1));
const t=document.getElementById("touchonly");
t.addEventListener("touchstart",()=>ev("touchstart",1));t.addEventListener("click",()=>ev("touchclick",1));
ev("verify","loaded");
</script>`,
  // T-B18's lists: a select and a field with a suggestion list (the browser's own autofill list,
  // the one a saved card or an address is picked from), each above plain white, a black square to
  // check where the picture's pixels are, and each control's state as the page sees it.
  "/lists": () => `<!doctype html><title>Lists</title><body style="margin:0;background:#fff">${REPORT}
<select id="s" style="${ABS(20, 20, 220, 32)}">${Array.from({ length: 12 }, (_, i) => `<option>Option ${i + 1}</option>`).join("")}</select>
<input id="d" list="dl" aria-label="Choice" style="${ABS(400, 20, 220, 32)}">
<datalist id="dl">${Array.from({ length: 8 }, (_, i) => `<option value="Choice ${i + 1}">`).join("")}</datalist>
<div style="${ABS(300, 300, 40, 40)};background:#000"></div>
<script>
const s=document.getElementById("s"),d=document.getElementById("d");
const open=()=>{try{return String(s.matches(":open"));}catch{return "unknown";}};
let was="";setInterval(()=>{const now=[s.value,open(),d.value,document.activeElement?.id||"",document.hasFocus()].join("|");if(now!==was){was=now;ev("sel",s.value);ev("selopen",open());ev("dl",d.value);ev("lfocus",(document.activeElement?.id||"none")+(document.hasFocus()?"":" (window not focused)"));}},150);
ev("lists","loaded");
</script>`,
  "/account": (signedIn) => `<!doctype html><title>Account</title><h1>${signedIn ? "Signed in as Ada" : "Sign in required"}</h1>`,
  // A form the person types into, which says what it holds every 300 ms with the page's own id
  // (a reload would give a new one).
  "/form": () => `<!doctype html><title>Form</title><body style="margin:0">${REPORT}
<input id="note" aria-label="Note" style="${ABS(20, 20, 300, 40)}">
<script>const id=Math.random().toString(16).slice(2);setInterval(()=>ev("tick",id+":"+document.getElementById("note").value),300);</script>`,
};
const FRAME_BOX = `<!doctype html><body style="margin:0">${REPORT}<input type="checkbox" id="c" style="${ABS(10, 10, 30, 30)}">
<script>const c=document.getElementById("c");c.addEventListener("change",()=>ev("frame",c.checked));</script>`;

// The shop (and its frame's site, by host name): pages, a sign-in that sets a cookie, the reports.
async function startShop() {
  const reports = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const signedIn = /(?:^|;\s*)sid=ada(?:;|$)/.test(req.headers.cookie || "");
    if (url.pathname === "/ev") {
      reports.push({ host: String(req.headers.host).split(":")[0], k: url.searchParams.get("k"), v: url.searchParams.get("v") });
      res.writeHead(204, { "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/login") {
      res.writeHead(303, { "set-cookie": "sid=ada; Path=/; HttpOnly", location: "/verify" });
      return res.end();
    }
    const html = String(req.headers.host).startsWith("frame.") ? FRAME_BOX : PAGES[url.pathname]?.(signedIn);
    res.writeHead(html ? 200 : 404, { "content-type": "text/html" });
    res.end(html || "not here");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: server.address().port, reports,
    last: (k, host) => reports.filter((r) => r.k === k && (!host || r.host.startsWith(host))).at(-1)?.v ?? null,
    close: () => { server.closeAllConnections?.(); server.close(); },
  };
}

// The person's channel: a loopback webhook that keeps every message.
async function startWebhook() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => { try { got.push(JSON.parse(body)); } catch { got.push({ unreadable: body }); } res.writeHead(204); res.end(); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, got, close: () => server.close() };
}

// A helper home with hand-offs to that webhook, Away on (a desktop that sends them).
function turnHome(shop, hook, prefix) {
  const home = helperHome(runtime, { prefix, config: {
    sessionPicker: false,
    browserArgs: [`--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${shop.port}`],
    handoff: { enabled: true, away: true, channels: [{ type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" }] },
  } });
  writeFileSync(join(home, "secrets.env"), `PAIRBROWSE_WEBHOOK_URL=${hook.url}\n`, { mode: 0o600 });
  return home;
}
async function helper(home, env = {}) {
  const daemon = spawnDaemon(home, { env });
  const socketPath = join(home, "run", "browser.sock");
  (await attachDaemon({ socketPath, daemon, home })).destroy();
  return { daemon, agent: await session(socketPath, "a") };
}
const why = (home) => { try { return `\n--- daemon.log ---\n${readFileSync(join(home, "daemon.log"), "utf8").slice(-3000)}`; } catch { return ""; } };

// The person's side, as the phone's browser asks it: plain requests to the link's host.
function request(link, method, path = "", body) {
  const u = new URL(path, link);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: u.pathname, headers: body !== undefined ? { "content-type": "application/json" } : {} }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode, text: t }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
// The view key's event stream, kept open: the events so far, by name.
function stream(viewUrl) {
  const u = new URL("events", viewUrl);
  return new Promise((resolve, reject) => {
    let t = "";
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname }, (res) => {
      res.setEncoding("utf8");
      res.on("data", (d) => (t += d));
      resolve({ status: res.statusCode, count: (name) => t.split(`event: ${name}\n`).length - 1,
        last: (name) => { const i = t.lastIndexOf(`event: ${name}\n`); if (i < 0) return null; const j = t.indexOf("data: ", i) + 6; return JSON.parse(t.slice(j, t.indexOf("\n", j))); }, events: (name) => t.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6))), close: () => req.destroy() });
    });
    req.on("error", reject);
  });
}
// Take over: the landing page (twice, as a link preview and the person), the tap, the stream.
async function takeOver(link) {
  for (let i = 0; i < 2; i++) {
    const landing = await request(link, "GET");
    assert.equal(landing.status, 200, "a GET never uses the link up");
    assert.match(landing.text, /Take over/);
  }
  const r = await request(link, "POST", "redeem", {});
  assert.equal(r.status, 200, r.text);
  const view = new URL(JSON.parse(r.text).view, link).href;
  assert.match(view, /\/[0-9a-f]{64}\/$/);
  assert.equal((await request(link, "POST", "redeem", {})).status, 404, "a second tap is refused");
  const s = await stream(view);
  assert.equal(s.status, 200);
  await until("the hand-off's tab is on screen", () => s.events("turn").at(-1)?.state === "on", 20_000, 100);
  return { view, s, input: (events) => request(view, "POST", "input", events) };
}
// A tap as the viewer sends one: moved, pressed, released at the point.
const tap = ([x, y]) => [
  { type: "mouse", action: "mouseMoved", x, y, button: "none", buttons: 0 },
  { type: "mouse", action: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 },
  { type: "mouse", action: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 },
];
const chars = (s) => [...s].map((c) => ({ type: "char", text: c, modifiers: 0 }));
const turnsFrom = (hook, event) => hook.got.filter((m) => m.event === `pairbrowse.${event}`);
const refOf = (snap, name) => snap.match(new RegExp(`"${name}"[^\\n]*\\[ref=(f?\\d*e\\d+)\\]`))?.[1];
const currentUrl = async (agent) => text(await agent.tool("browser_tabs", { action: "list" })).match(/^- \d+: \(current\) \[[^\n]*\]\(([^)\s]*)\)/m)?.[1];

test("full path with a loopback webhook: status, link, GET, Take over, click and typed code land, agent click refused, Done, waiting agent returns, next click works; fast-mode handoff step finishes on Done", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 300_000 }, async (t) => {
  const shop = await startShop();
  const hook = await startWebhook();
  const home = turnHome(shop, hook, "pb-yt-");
  let h;
  try {
    h = await helper(home);
    const { agent } = h;
    assert.ok(!(await agent.tool("browser_navigate", { url: `${SHOP}/login` })).result?.isError);

    // The agent hands the sign-in over: the result names where it went and the hand-off, never the link.
    const said = text(await agent.tool("pairbrowse_status", { kind: "you", text: "Please sign in as Ada with password hunter2", step: "login" }));
    assert.match(said, /Your turn sent \(webhook\): hand-off ([0-9a-f]{8}) for tab \d+, until \d\d:\d\d UTC/, said);
    assert.doesNotMatch(said, /http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}/, "the agent never gets the link");
    const id = said.match(/hand-off ([0-9a-f]{8})/)[1];
    const turn = await until("the webhook's message", () => turnsFrom(hook, "turn")[0], 15_000, 100);
    assert.deepEqual(Object.keys(turn).sort(), ["event", "expiresAt", "host", "id", "kind", "link", "reason"]);
    assert.equal(turn.id, id);
    assert.equal(turn.kind, "login");
    assert.equal(turn.host, "shop.pbtest.example");
    assert.ok(Date.parse(turn.expiresAt) > Date.now() + 10 * 60_000, "the default 15 minutes");
    assert.doesNotMatch(JSON.stringify(turn), /hunter2|Ada|password/i, "never the agent's text");
    assert.match(turn.link, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{64}\/$/);

    // The agent keeps out of the tab: its hands and navigation are refused, reading is not.
    const snap = text(await agent.tool("browser_snapshot"));
    const signIn = refOf(snap, "Sign in");
    assert.ok(signIn, snap.slice(0, 600));
    const refused = await agent.tool("browser_click", { target: signIn, element: "Sign in" });
    assert.ok(refused.result?.isError, "an agent click in a handed-off tab");
    assert.match(text(refused), /handed over to the person/);
    assert.match(text(await agent.tool("browser_navigate", { url: `${SHOP}/account` })), /handed over to the person/);

    // The person takes over and signs in with a tap; the agent waits meanwhile.
    const p = await takeOver(turn.link);
    const waiting = agent.tool("browser_wait_for", {}, 150_000);
    assert.equal((await p.input(tap(AT.signIn))).status, 204);
    await until("the verification page", () => shop.last("verify"), 20_000, 100);
    await until("its tab on screen again", () => p.s.events("turn").at(-1)?.state === "on", 10_000, 100);

    // Through the real view key: the one-time-code boxes move on keydown; Tab reaches the checkbox
    // and Space ticks it; another site's frame takes a click; a 2 s hold is 2 s; a tap clicks.
    assert.equal((await p.input(tap(AT.otp0))).status, 204);
    assert.equal((await p.input(chars("123456"))).status, 204);
    await until("the six-digit code", () => shop.last("code") === "123456", 10_000, 100);
    assert.equal((await p.input([{ type: "key", key: "Tab", modifiers: 0 }])).status, 204);
    await until("Tab moved focus to the checkbox", () => shop.last("focus") === "agree", 10_000, 100);
    assert.equal((await p.input(chars(" "))).status, 204);
    await until("Space ticked it", () => shop.last("agree") === "true", 10_000, 100);
    assert.equal((await p.input(tap(AT.frameBox))).status, 204);
    await until("the cross-origin frame's checkbox", () => shop.last("frame", "frame.") === "true", 10_000, 100);
    const [hx, hy] = AT.hold;
    await p.input([{ type: "mouse", action: "mouseMoved", x: hx, y: hy, button: "none", buttons: 0 }, { type: "mouse", action: "mousePressed", x: hx, y: hy, button: "left", buttons: 1, clickCount: 1 }]);
    await sleep(2000);
    await p.input([{ type: "mouse", action: "mouseReleased", x: hx, y: hy, button: "left", buttons: 0, clickCount: 1 }]);
    const held = Number(await until("the hold measured", () => shop.last("held"), 10_000, 100));
    assert.ok(held >= 1900 && held <= 3500, `a 2 s hold was ${held} ms`);
    assert.equal((await p.input(tap(AT.tap))).status, 204);
    await until("the tap's click", () => shop.last("tap") === "1", 10_000, 100);
    // Measurement (T-B18, reports only): whether a touch alone, without the viewer's mouse events, clicks.
    await p.input([{ type: "touch", action: "touchStart", x: AT.touchOnly[0], y: AT.touchOnly[1] }, { type: "touch", action: "touchEnd" }]);
    await sleep(1000);
    t.diagnostic(`T-B18: dispatchTouchEvent alone ${shop.last("touchclick") ? "yields" : "does not yield"} a click (touchstart ${shop.last("touchstart") ? "seen" : "not seen"}); the viewer sends taps as mouse events either way. Select and autofill lists in frames: the Measurement (T-B18) test.`);

    // Done: the waiting agent returns at once, told to look; its hands are back, still signed in.
    assert.equal((await request(p.view, "POST", "turn-done", {})).status, 200);
    const waited = await waiting;
    assert.ok(!waited.result?.isError, text(waited));
    assert.match(text(waited), new RegExp(`hand-off ${id} ended \\(done\\)`));
    await until("the stream hears the end", () => p.s.events("turn-ended").length, 10_000, 100);
    assert.equal(p.s.events("turn-ended")[0].reason, "done");
    p.s.close();
    assert.equal((await p.input(tap(AT.tap))).status, 404, "the view key is over");
    assert.equal(turnsFrom(hook, "ended").length, 0, "the person ended it: no ended message");
    assert.match(await currentUrl(agent), /\/verify$/, "the tab the person left");
    const after = text(await agent.tool("browser_snapshot"));
    const next = refOf(after, "Continue to your account");
    assert.ok(next, after.slice(0, 800));
    const clicked = await agent.tool("browser_click", { target: next, element: "Continue to your account" });
    assert.ok(!clicked.result?.isError, text(clicked));
    assert.match(text(await agent.tool("browser_snapshot")), /Signed in as Ada/, "no second sign-in");

    // A fast-mode handoff step: its own hand-off, finished by Done.
    const run = agent.tool("pairbrowse_run", { steps: [{ handoff: { say: "Approve the order", until: "Text this page never shows" } }] }, 150_000);
    const second = await until("the run step's message", () => turnsFrom(hook, "turn")[1], 20_000, 100);
    assert.equal(second.host, "shop.pbtest.example");
    const q = await takeOver(second.link);
    assert.equal((await request(q.view, "POST", "turn-done", {})).status, 200);
    const ran = await run;
    assert.ok(!ran.result?.isError, text(ran));
    q.s.close();

    // The trail: each step on its own line, never a key or a link.
    const trail = readFileSync(join(home, "audit.jsonl"), "utf8");
    for (const kind of ["minted", "notified", "redeemed", "ended"]) assert.match(trail, new RegExp(`"kind":"${kind}"`), kind);
    assert.doesNotMatch(trail, /[0-9a-f]{64}|127\.0\.0\.1:\d+\//);
  } catch (e) {
    throw new Error(`${e.message}${why(home)}`, { cause: e });
  } finally {
    h?.agent.sock.destroy();
    await stopDaemon(h?.daemon);
    shop.close();
    hook.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("TURN_MS: one reminder, then the stop; the held tab keeps its address and typed values, no agent action reaches it, a new you hands that same tab over; a restarted helper reopens the same tabs", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 300_000 }, async () => {
  const shop = await startShop();
  const hook = await startWebhook();
  const home = turnHome(shop, hook, "pb-yu-");
  const env = { PAIRBROWSE_TEST_TURN_MS: "9000" };
  let h;
  try {
    h = await helper(home, env);
    const { agent } = h;
    assert.ok(!(await agent.tool("browser_navigate", { url: `${SHOP}/form` })).result?.isError);
    const said = text(await agent.tool("pairbrowse_status", { kind: "you", text: "Fill in the note", step: "other" }));
    const tab = said.match(/hand-off ([0-9a-f]{8}) for tab (\d+)/);
    assert.ok(tab, said);
    const turn = await until("the message", () => turnsFrom(hook, "turn")[0], 15_000, 100);

    // The person opens it, types, and goes offline without Done.
    const p = await takeOver(turn.link);
    assert.equal((await p.input(tap(AT.note))).status, 204);
    assert.equal((await p.input(chars("kept"))).status, 204);
    const page = await until("what was typed", () => { const v = shop.last("tick"); return v?.endsWith(":kept") && v.split(":")[0]; }, 10_000, 100);
    p.s.close();

    // The agent waits: at the expiry it is told to stop. One reminder ("opened already": no link), one ended.
    const waited = await agent.tool("browser_wait_for", {}, 60_000);
    assert.ok(waited.result?.isError);
    assert.match(text(waited), new RegExp(`hand-off ${tab[1]} timed out`));
    await until("the ended message", () => turnsFrom(hook, "ended").length, 10_000, 100);
    await sleep(1500);
    const reminders = turnsFrom(hook, "reminder");
    assert.equal(reminders.length, 1, JSON.stringify(hook.got));
    assert.equal(reminders[0].link, null, "the link was opened already");
    assert.deepEqual(turnsFrom(hook, "ended").map((m) => m.reason), ["expired"]);

    // Held: its address and what was typed stay; no agent action reaches it.
    assert.match(await currentUrl(agent), /\/form$/);
    assert.equal(shop.last("tick"), `${page}:kept`, "the same page, its value kept");
    const snap = text(await agent.tool("browser_snapshot"));
    const note = refOf(snap, "Note");
    assert.ok(note, snap.slice(0, 600));
    for (const [name, args] of [["browser_type", { target: note, element: "Note", text: "agent" }], ["browser_click", { target: note, element: "Note" }], ["browser_navigate", { url: `${SHOP}/account` }]]) {
      const r = await agent.tool(name, args);
      assert.ok(r.result?.isError, name);
      assert.match(text(r), /held for the person/, name);
    }
    await sleep(700);
    assert.equal(shop.last("tick"), `${page}:kept`, "nothing the agent tried reached it");

    // A new "you" hands that same tab over again, with a new link.
    const again = text(await agent.tool("pairbrowse_status", { kind: "you", text: "Fill in the note", step: "other" }));
    const tab2 = again.match(/hand-off ([0-9a-f]{8}) for tab (\d+)/);
    assert.ok(tab2 && tab2[1] !== tab[1], again);
    assert.equal(tab2[2], tab[2], "the same tab");
    const turn2 = await until("the second message", () => turnsFrom(hook, "turn")[1], 15_000, 100);
    assert.notEqual(turn2.link, turn.link);
    const q = await takeOver(turn2.link);
    assert.equal(q.s.events("turn").at(-1).host, "shop.pbtest.example");
    assert.equal(shop.last("tick"), `${page}:kept`, "still that page");
    assert.equal((await request(q.view, "POST", "turn-done", {})).status, 200);
    q.s.close();

    // A restarted helper reopens the same tabs.
    h.agent.sock.destroy();
    await stopDaemon(h.daemon);
    h = await helper(home, env);
    const listed = await until("the form's tab back", async () => {
      const l = text(await h.agent.tool("browser_tabs", { action: "list" }));
      return l.includes(`${SHOP}/form`) && l;
    }, 60_000, 1000);
    assert.match(listed, /shop\.pbtest\.example\/form/);
  } catch (e) {
    throw new Error(`${e.message}${why(home)}`, { cause: e });
  } finally {
    h?.agent.sock.destroy();
    await stopDaemon(h?.daemon);
    shop.close();
    hook.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// T-B18's open half (reports, does not fail): what a person sees on the phone when a list opens in
// the handed-off tab. The viewer's picture is the tab's screencast; the browser draws an open
// select list and its suggestion and autofill lists as popups of its own, which may never be in
// it. Measured through the real view key: the share of non-white pixels in the plain white area
// below each control, in the picture before and after it opens, read from the frames the turn
// stream got (decoded with the runtime's JPEG decoder), with the page's own word that the list
// was open (select :open; a suggestion picked by ArrowDown and Enter).
const FRAME_DIFF = 0.02; // more than this share of the area changed: the list is in the picture
function jpegOf() {
  try { return createRequire(join(runtime, "package.json"))("playwright-core/lib/utilsBundle").jpegjs; } catch { return null; }
}
// The share of pixels in a page-pixel box that aren't near white, in a frame { img, w, h }.
function inked(jpeg, frame, [x0, y0, x1, y1]) {
  const { width, height, data } = jpeg.decode(Buffer.from(frame.img, "base64"), { useTArray: true });
  const sx = width / frame.w, sy = height / frame.h;
  let ink = 0, all = 0;
  for (let y = Math.round(y0 * sy); y < Math.min(height, Math.round(y1 * sy)); y++) {
    for (let x = Math.round(x0 * sx); x < Math.min(width, Math.round(x1 * sx)); x++) {
      const i = (y * width + x) * 4;
      all++;
      if (Math.min(data[i], data[i + 1], data[i + 2]) < 200) ink++;
    }
  }
  return all ? ink / all : 0;
}
const BELOW_SELECT = [20, 60, 240, 300], BELOW_FIELD = [400, 60, 620, 300], MARK = [305, 305, 335, 335];
const keyEv = (key) => [{ type: "key", key, modifiers: 0 }];

test("Measurement (T-B18): an open select list and the autofill list in screencast frames; the viewer's option list chooses through the view key", { skip: !runtime && "set PAIRBROWSE_TEST_RUNTIME", timeout: 300_000 }, async (t) => {
  const jpeg = jpegOf();
  assert.ok(jpeg, "the runtime's JPEG decoder");
  const shop = await startShop();
  const hook = await startWebhook();
  const home = turnHome(shop, hook, "pb-yl-");
  let h;
  try {
    h = await helper(home);
    const { agent } = h;
    assert.ok(!(await agent.tool("browser_navigate", { url: `${SHOP}/lists` })).result?.isError);
    await until("the lists page", () => shop.last("lists"), 15_000, 100);
    text(await agent.tool("pairbrowse_status", { kind: "you", text: "Pick an option", step: "other" }));
    const turn = await until("the message", () => turnsFrom(hook, "turn")[0], 15_000, 100);
    const p = await takeOver(turn.link);
    // A frame after this moment (the stream's frames so far are older).
    const fresh = async (what, after) => until(what, () => p.s.count("frame") > after && p.s.last("frame"), 15_000, 100);
    // The picture is the page: the black square is where it should be, the white areas are white.
    const first = await until("a frame with the square", () => { const f = p.s.last("frame"); return f && inked(jpeg, f, MARK) > 0.9 && f; }, 20_000, 200);
    const before = { select: inked(jpeg, first, BELOW_SELECT), field: inked(jpeg, first, BELOW_FIELD) };
    assert.ok(before.select < 0.01 && before.field < 0.01, `the areas start white: ${JSON.stringify(before)}`);

    // The suggestion list (the browser's autofill list), first: on macOS a select's list is a menu of
    // the system's that keys from the page don't close. A tap in the field, then ArrowDown.
    // A second tap in the focused field is the other way the list opens.
    let n = 0, fieldInk = 0, chose = "", how = "";
    for (const way of ["a tap, then ArrowDown", "a second tap, then ArrowDown"]) {
      n = p.s.count("frame");
      assert.equal((await p.input(tap([510, 36]))).status, 204);
      await sleep(500);
      assert.equal((await p.input(keyEv("ArrowDown"))).status, 204);
      await sleep(1500);
      const withList = await fresh("a frame after ArrowDown", n).catch(() => p.s.last("frame"));
      fieldInk = Math.max(fieldInk, inked(jpeg, withList, BELOW_FIELD));
      assert.equal((await p.input(keyEv("Enter"))).status, 204);
      chose = await until("a suggestion picked", () => shop.last("dl") || null, 3000, 100).catch(() => shop.last("dl") || "");
      if (chose) { how = way; break; }
    }
    assert.equal((await p.input(keyEv("Escape"))).status, 204);
    await sleep(800);

    // The select: a tap opens its list.
    n = p.s.count("frame");
    assert.equal((await p.input(tap([130, 36]))).status, 204);
    const focusSel = await until("the select focused", () => shop.last("lfocus")?.startsWith("s") && shop.last("lfocus"), 5000, 100).catch(() => shop.last("lfocus"));
    const opened = await until("the select's list open", () => shop.last("selopen") === "true" && "true", 5000, 100).catch(() => shop.last("selopen"));
    await sleep(1500);
    const withSelect = await fresh("a frame after the tap", n).catch(() => p.s.last("frame"));
    const selectInk = inked(jpeg, withSelect, BELOW_SELECT);
    // The viewer's option list (liveview/options.mjs): the select's options after the tap, and the
    // choice sent as the person's own keys.
    const listed = await request(p.view, "POST", "turn-options", {});
    assert.equal(listed.status, 200, listed.text);
    const list = JSON.parse(listed.text);
    assert.equal(list.options?.length, 12, listed.text);
    assert.equal(list.options[5].label, "Option 6");
    assert.equal(list.selected, 0);
    const chosen = await request(p.view, "POST", "turn-pick", { index: 5, count: 12 });
    const picked = await until("the option chosen from the list", () => shop.last("sel") === "Option 6" && shop.last("sel"), 5000, 100).catch(() => shop.last("sel"));
    const closed = await until("the page's list closed", () => shop.last("selopen") !== "true" && shop.last("selopen"), 3000, 100).catch(() => shop.last("selopen"));
    // Where the list opens on a tap (Linux, the server) by the keys; where it doesn't (macOS) set on the select.
    assert.equal(chosen.status, 200, chosen.text);
    assert.equal(picked, "Option 6");
    assert.notEqual(closed, "true", "the page's list is closed after the choice");
    t.diagnostic(`option list (${process.platform}): turn-pick answered ${chosen.status}${chosen.status === 200 ? "" : ` (${chosen.text})`}, the page's select now "${picked}", its list open: ${closed}.`);
    if (closed === "true") assert.equal((await p.input(keyEv("Escape"))).status, 204);
    await sleep(800);

    const word = (ink, base) => (ink - base > FRAME_DIFF ? "shows" : "does not show");
    t.diagnostic(`T-B18 (${process.platform}): an open select list (page says :open ${opened}) ${word(selectInk, before.select)} in the turn stream's frames (ink below it ${(before.select * 100).toFixed(1)}% -> ${(selectInk * 100).toFixed(1)}%); focus ${focusSel}.`);
    t.diagnostic(`T-B18 (${process.platform}): the autofill (suggestion) list ${chose ? `opened on ${how} from Input.dispatchKeyEvent (Enter picked "${chose}")` : "did not open on a tap and ArrowDown, nor on a second tap and ArrowDown (Enter picked nothing)"} and ${word(fieldInk, before.field)} in the frames (ink below it ${(before.field * 100).toFixed(1)}% -> ${(fieldInk * 100).toFixed(1)}%).`);
    assert.equal((await request(p.view, "POST", "turn-done", {})).status, 200);
    p.s.close();
  } catch (e) {
    throw new Error(`${e.message}${why(home)}`, { cause: e });
  } finally {
    h?.agent.sock.destroy();
    await stopDaemon(h?.daemon);
    shop.close();
    hook.close();
    rmSync(home, { recursive: true, force: true });
  }
});
