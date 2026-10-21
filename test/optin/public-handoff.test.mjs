// A hand-off link from anywhere (spec server-mode step 21b, U2, handoff.publicLink), over a real
// Cloudflare Quick Tunnel: a real helper and browser here with hand-offs to a loopback webhook (Away
// on, publicLink on); the agent hands a step over; the link (a public trycloudflare.com address) is
// opened from a Linux container behind its own NAT (another network), its link slowed with tc
// netem (300 ms delay, 2% loss): the landing page twice, Take over, the viewer page, its WebSocket
// stream, a tap and typed text through the turn viewer's protocol (test/optin/public-handoff/
// person.mjs), Done. The text lands in the page, the waiting agent returns, and the tunnel is gone
// afterwards (its keeper and cloudflared ended, the address no longer reaches this computer); a
// second hand-off then starts a fresh tunnel of its own, and it too is gone after.
// Needs the network, cloudflared, Docker (OrbStack on the Mac), PAIRBROWSE_TEST_RUNTIME,
// PAIRBROWSE_TEST_REAL_TUNNEL=1 and PAIRBROWSE_TEST_DOCKER=1. One browser (the host's); the
// person's side is plain requests. Cloudflare limits fresh Quick Tunnels: run it sparingly.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { attachDaemon, session } from "../helpers/live.mjs";
import { text, until } from "../helpers/util.mjs";
import { helperHome, spawnDaemon, stopDaemon, root } from "../helpers/daemon.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const skip = !runtime || process.env.PAIRBROWSE_TEST_REAL_TUNNEL !== "1" || process.env.PAIRBROWSE_TEST_DOCKER !== "1";
const NAME = "pb-handoff-person";
const LABEL = "pairbrowse-test=public-handoff";
const sh = (cmd, args, ms = 600_000) => execFileSync(cmd, args, { encoding: "utf8", timeout: ms, stdio: ["ignore", "pipe", "pipe"] });
const removeContainer = () => { try { sh("docker", ["rm", "-f", NAME], 60_000); } catch {} };
const TYPED = "from far away";
const TYPED2 = ", twice";
const NOTE = [170, 40]; // the field, in page pixels

// The shop: one form whose field says what it holds.
async function startShop() {
  const reports = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (url.pathname === "/ev") { reports.push(url.searchParams.get("v")); res.writeHead(204); return res.end(); }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Form</title><body style="margin:0"><input id="note" aria-label="Note" style="position:absolute;left:20px;top:20px;width:300px;height:40px">
<script>let was="";setInterval(()=>{const v=document.getElementById("note").value;if(v!==was){was=v;fetch("/ev?v="+encodeURIComponent(v));}},200);</script>`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { port: server.address().port, last: () => reports.at(-1) ?? null, close: () => { server.closeAllConnections?.(); server.close(); } };
}
async function startWebhook() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => { try { got.push(JSON.parse(body)); } catch {} res.writeHead(204); res.end(); });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, got, close: () => server.close() };
}
const keepers = (home) => { try { return sh("pgrep", ["-f", join(home, "run")], 10_000).split(/\s+/).filter(Boolean); } catch { return []; } };

test("a public hand-off link from another network: Take over, the stream and input through a real Quick Tunnel under 300 ms delay and 2% loss, Done, and the tunnel is gone after", { skip, timeout: 900_000 }, async (t) => {
  const shop = await startShop();
  const hook = await startWebhook();
  const home = helperHome(runtime, { prefix: "pb-pubho-", config: {
    sessionPicker: false,
    browserArgs: [`--host-resolver-rules=MAP *.pbtest.example 127.0.0.1:${shop.port}`],
    handoff: { enabled: true, away: true, publicLink: true, channels: [{ type: "webhook", urlSecret: "PAIRBROWSE_WEBHOOK_URL" }] },
  } });
  writeFileSync(join(home, "secrets.env"), `PAIRBROWSE_WEBHOOK_URL=${hook.url}\n`, { mode: 0o600 });
  // The cloudflared already downloaded for this computer, instead of a fresh download per home.
  const tools = join(homedir(), ".pairbrowse", "tools");
  if (existsSync(tools)) symlinkSync(tools, join(home, "tools"), "dir");
  const log = () => { try { return readFileSync(join(home, "daemon.log"), "utf8"); } catch { return ""; } };
  let daemon = null, agent = null, stage = "start";
  try {
    stage = "the person's container, its link slowed";
    removeContainer();
    sh("docker", ["run", "-d", "--rm", "--name", NAME, "--label", LABEL, "--cap-add", "NET_ADMIN", "-v", `${root}:/repo:ro`, "node:22-bookworm", "sleep", "1800"]);
    sh("docker", ["exec", NAME, "sh", "-c", "command -v tc >/dev/null || (apt-get update -qq && apt-get install -y -qq iproute2 >/dev/null)"]);
    sh("docker", ["exec", NAME, "tc", "qdisc", "add", "dev", "eth0", "root", "netem", "delay", "300ms", "loss", "2%"]);
    t.diagnostic(`netem: ${sh("docker", ["exec", NAME, "tc", "qdisc", "show", "dev", "eth0"]).trim()}`);

    stage = "the helper and the agent's tab";
    daemon = spawnDaemon(home);
    const socketPath = join(home, "run", "browser.sock");
    (await attachDaemon({ socketPath, daemon, home })).destroy();
    agent = await session(socketPath, "a");
    assert.ok(!(await agent.tool("browser_navigate", { url: "http://shop.pbtest.example/form" })).result?.isError);

    // Two hand-offs, one after the other: each starts its own tunnel, and none is left between
    // them or after the last.
    const tunnelsDir = join(home, "tunnels");
    const links = [];
    for (const [round, typed] of [[1, TYPED], [2, TYPED2]]) {
      stage = `hand-off ${round}: the agent hands the step over; the link is public`;
      const t0 = Date.now();
      const said = text(await agent.tool("pairbrowse_status", { kind: "you", text: "Type the note", step: "other" }, 90_000));
      assert.match(said, /Your turn (sent \(webhook\)|is on its way)/, said);
      const turn = await until("the webhook's message", () => hook.got.filter((m) => m.event === "pairbrowse.turn")[round - 1], 90_000, 200);
      const linkOut = Date.now();
      t.diagnostic(`hand-off ${round}: link out ${((linkOut - t0) / 1000).toFixed(1)} s after the status`);
      assert.match(turn.link, /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/[0-9a-f]{64}\/$/, JSON.stringify(turn));
      assert.equal(turn.privateOnly, undefined, "the public link started");
      assert.equal(log().match(/hand-off tunnel up: /g)?.length, round);
      assert.ok(!links.some((l) => new URL(l).host === new URL(turn.link).host), "a fresh address for each hand-off");
      links.push(turn.link);
      // Nothing but the grant's routes on that address: an unknown key and a bare path are 404.
      for (const path of ["/", `/${"ab".repeat(32)}/`, `/${"ab".repeat(32)}/config.json`]) {
        const r = await fetch(new URL(path, turn.link), { signal: AbortSignal.timeout(20_000) });
        assert.equal(r.status, 404, `${path} on the public address`);
      }

      stage = `hand-off ${round}: the person, from the container`;
      const waiting = agent.tool("browser_wait_for", {}, 300_000);
      const out = sh("docker", ["exec", NAME, "node", "/repo/test/optin/public-handoff/person.mjs", turn.link, String(NOTE[0]), String(NOTE[1]), typed], 300_000);
      const line = out.split("\n").find((l) => l.startsWith("PERSON "));
      assert.ok(line, out);
      const person = JSON.parse(line.slice(7));
      t.diagnostic(`hand-off ${round}: person: ${JSON.stringify(person.steps.map((s) => ({ ...s, at: undefined })))}`);
      assert.ok(person.ok, person.error);
      const st = (name) => person.steps.filter((s) => s.name === name);
      assert.deepEqual(st("landing").map((s) => [s.status, s.takeOver]), [[200, true], [200, true]], "a GET never uses the link up");
      assert.equal(st("redeem")[0].status, 200);
      assert.equal(st("second tap")[0].status, 404);
      assert.deepEqual([st("viewer")[0].status, st("viewer")[0].ws, st("viewer")[0].csp], [200, true, true]);
      assert.equal(st("viewer script")[0].status, 200);
      assert.equal(st("stream")[0].turn?.state, "on", "the stream's turn event through the tunnel");
      assert.equal(st("tap")[0].status, 204);
      assert.equal(st("typed")[0].status, 204);
      assert.ok(st("frames")[0].count >= 1, "pictures reached the person");
      assert.equal(st("done")[0].status, 200);
      assert.equal(st("ended")[0].reason, "done");
      assert.equal(st("view after")[0].status, 404, "the view key is dead after Done");
      const want = links.length === 1 ? TYPED : TYPED + TYPED2;
      await until("the typed text in the page", () => shop.last() === want, 30_000, 200);
      t.diagnostic(`hand-off ${round}: timings: link to stream ${st("stream")[0].firstTurnMs} ms (from the person's first request), tap ${st("tap")[0].ms} ms, typed ${st("typed")[0].ms} ms, typed to next picture ${st("echo")[0].ms} ms; link sent to the person's first request ${person.steps[0].at - linkOut} ms (clocks of two machines)`);

      stage = `hand-off ${round}: the waiting agent goes on`;
      const woke = text(await waiting);
      assert.match(woke, /ended \(done\)|pressed Done/, woke);

      stage = `hand-off ${round}: the tunnel is gone`;
      await until("the hand-off tunnel stopped", () => log().match(/hand-off tunnel stopped/g)?.length === round, 30_000, 200);
      await until("no keeper or cloudflared of this home left", () => keepers(home).length === 0, 30_000, 500);
      assert.deepEqual(existsSync(tunnelsDir) ? readdirSync(tunnelsDir) : [], [], "no tunnel log left");
      const gone = await until("the address no longer reaches this computer", async () => {
        try { const r = await fetch(turn.link, { signal: AbortSignal.timeout(10_000) }); return r.status >= 500 && r.status; } catch { return "unreachable"; }
      }, 60_000, 2000);
      t.diagnostic(`hand-off ${round}: public address after it: ${gone}`);
    }
  } catch (e) {
    throw new Error(`${stage}: ${e.message}\n--- daemon.log ---\n${log().slice(-4000)}`);
  } finally {
    agent?.sock.destroy();
    await stopDaemon(daemon);
    for (const pid of keepers(home)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    removeContainer();
    shop.close();
    hook.close();
    rmSync(home, { recursive: true, force: true });
  }
});
