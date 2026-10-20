// Hand-off messages through a real ntfy server (spec server-mode B6, B7): a turn, its reminder and
// its end published to a fresh random topic on https://ntfy.sh and read back from the topic, each
// with the step's sentence, the host and the expiry, the link only where the channel's link rule
// allows it, and nothing else. Needs the network and PAIRBROWSE_TEST_NTFY=1. The topic is random and
// used once; the link points at a loopback address no one else can open.
import "../helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { randomBytes } from "node:crypto";
import { createNotifier } from "../../scripts/daemon/notify/index.mjs";

const skip = process.env.PAIRBROWSE_TEST_NTFY !== "1" && "set PAIRBROWSE_TEST_NTFY=1 (needs the network)";

// The topic's messages so far (ntfy's poll API), as JSON lines.
function readTopic(topic) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://ntfy.sh/${topic}/json?poll=1&since=all`, { timeout: 15_000 }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (t += d));
      res.on("end", () => resolve(t.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === "message")));
    });
    req.on("timeout", () => req.destroy(new Error("ntfy didn't answer")));
    req.on("error", reject);
  });
}

test("ntfy: real publish and read back", { skip, timeout: 90_000 }, async () => {
  const topic = `pb-test-${randomBytes(12).toString("hex")}`;
  const values = { PAIRBROWSE_NTFY_TOPIC: topic };
  const notifier = (link) => createNotifier({ channels: [{ type: "ntfy", topicSecret: "PAIRBROWSE_NTFY_TOPIC", link }], secret: (name) => values[name] });
  const link = `http://127.0.0.1:9/${randomBytes(32).toString("hex")}/`;
  const expiresAt = Date.now() + 15 * 60_000;
  const base = { id: "0a1b2c3d", action: "2fa", host: "bank.example", expiresAt };

  // "always": the turn carries the link as the tap's target; "auto" on public ntfy.sh without a token leaves it out.
  assert.deepEqual((await notifier("always").send({ ...base, kind: "turn", link })).sent, ["ntfy"]);
  const auto = await notifier("auto").send({ ...base, kind: "reminder", link });
  assert.deepEqual(auto.sent, ["ntfy"]);
  assert.deepEqual(auto.withheld, ["ntfy"]);
  assert.deepEqual((await notifier("always").send({ ...base, kind: "ended", link: null, reason: "expired" })).sent, ["ntfy"]);

  let got = [];
  for (let i = 0; i < 20 && got.length < 3; i++) {
    got = await readTopic(topic);
    if (got.length < 3) await new Promise((r) => setTimeout(r, 1000));
  }
  assert.equal(got.length, 3, JSON.stringify(got));
  const [turn, reminder, ended] = got;
  for (const m of got) {
    assert.deepEqual(m.tags, ["pairbrowse"]);
    assert.match(`${m.title} ${m.message}`, /bank\.example/);
    assert.doesNotMatch(JSON.stringify(m), /hunter|password|card|screenshot/i, "nothing but the step, host, expiry and link");
  }
  assert.match(`${turn.title} ${turn.message}`, /2FA code on bank\.example/);
  assert.equal(turn.click, link, "the tap opens the link");
  assert.equal(turn.priority, 4);
  assert.equal(reminder.click, undefined, "auto on public ntfy.sh: no link");
  assert.ok(!JSON.stringify(reminder).includes(link));
  assert.equal(ended.click, undefined);
  assert.equal(ended.priority, 3);
  assert.ok(!JSON.stringify(ended).includes(link));
});
