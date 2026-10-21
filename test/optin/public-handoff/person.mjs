// The person's side of test/optin/public-handoff.test.mjs, run on another network (a Linux
// container behind its own NAT, its link slowed with tc netem): a hand-off link opened the way the
// phone's browser opens it, as plain requests and the viewer's own WebSocket stream, the protocol
// the turn viewer (liveview-turn.js) speaks. Prints one JSON line of what it saw.
// Usage: node person.mjs <link> <tap x> <tap y> <text>
import https from "node:https";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { connect } from "../../../scripts/ws.mjs";

const [link, x, y, typed] = process.argv.slice(2);
const origin = new URL(link).origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { steps: [] };
const step = (name, data = {}) => { out.steps.push({ name, at: Date.now(), ...data }); };

function request(method, url, body) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { ...(body !== undefined ? { "content-type": "application/json", origin } : {}) };
    const req = lib.request(u, { method, headers, timeout: 30_000 }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve({ status: res.statusCode, text: t, headers: res.headers }));
    });
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}
// A request sent again (as the viewer does) until it answers below 500.
async function retried(method, url, body, tries = 6) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { last = await request(method, url, body); if (last.status < 500) return last; } catch (e) { last = { status: 0, text: String(e?.message || e) }; }
    await sleep(1000);
  }
  return last;
}

try {
  const t0 = Date.now();
  // A chat app's preview, then the person: the landing page twice, nothing used up.
  for (let i = 0; i < 2; i++) {
    const r = await retried("GET", link);
    step("landing", { status: r.status, takeOver: /Take over/.test(r.text) });
  }
  const tap = await retried("POST", new URL("redeem", link).href, {});
  step("redeem", { status: tap.status });
  const view = new URL(JSON.parse(tap.text).view, link).href;
  const again = await request("POST", new URL("redeem", link).href, {});
  step("second tap", { status: again.status });
  const page = await retried("GET", view);
  step("viewer", { status: page.status, ws: /data-stream="ws"/.test(page.text), csp: String(page.headers["content-security-policy"] || "").includes(`wss://${new URL(link).host}`) });
  const turnJs = await retried("GET", new URL("assets/liveview-turn.js", view).href);
  step("viewer script", { status: turnJs.status });

  // The stream: a WebSocket on the public address.
  let text = "";
  const conn = await connect(new URL("events", view).href, { headers: { origin }, timeoutMs: 30_000 });
  conn.onMessage((m) => { text += m; });
  const events = (name) => text.split("\n\n").filter((b) => b.startsWith(`event: ${name}\n`)).map((b) => JSON.parse(b.slice(b.indexOf("data: ") + 6)));
  for (const end = Date.now() + 30_000; Date.now() < end && events("turn").at(-1)?.state !== "on"; await sleep(100));
  const turn = events("turn").at(-1);
  step("stream", { turn: turn ? { action: turn.action, host: turn.host, state: turn.state } : null, firstTurnMs: Date.now() - t0 });

  // The person's hands, as the viewer's queue sends them: one batch at a time, numbered, sent again
  // when an answer is lost.
  const run = randomBytes(8).toString("hex");
  let seq = 0;
  const send = async (batch) => { seq++; return retried("POST", `${new URL("input", view).href}?run=${run}&seq=${seq}`, batch); };
  const X = Number(x), Y = Number(y);
  const tapped = await send([
    { type: "mouse", action: "mouseMoved", x: X, y: Y, button: "none", buttons: 0 },
    { type: "mouse", action: "mousePressed", x: X, y: Y, button: "left", buttons: 1, clickCount: 1 },
    { type: "mouse", action: "mouseReleased", x: X, y: Y, button: "left", buttons: 0, clickCount: 1 },
  ]);
  step("tap", { status: tapped.status });
  const typedR = await send([...typed].map((c) => ({ type: "char", text: c, modifiers: 0 })));
  step("typed", { status: typedR.status });
  // A few seconds of pictures through the slow link, then Done.
  await sleep(4000);
  step("frames", { count: events("frame").length });
  const state = await retried("GET", new URL("state.json", view).href);
  step("state", { status: state.status });
  const done = await retried("POST", new URL("turn-done", view).href, {});
  step("done", { status: done.status });
  for (const end = Date.now() + 20_000; Date.now() < end && !events("turn-ended").length; await sleep(100));
  step("ended", { reason: events("turn-ended")[0]?.reason || null, closed: conn.closed });
  conn.close();
  const after = await request("GET", view).catch((e) => ({ status: 0, text: String(e?.message || e) }));
  step("view after", { status: after.status });
  out.ok = true;
} catch (e) {
  out.ok = false;
  out.error = String(e?.stack || e);
}
console.log(`PERSON ${JSON.stringify(out)}`);
process.exit(0);
