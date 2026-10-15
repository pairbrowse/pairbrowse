import "./helpers/home.mjs";
// Every live view route that reads a JSON body answers a body that isn't JSON with 400 (never a
// 500, nothing logged), and one too large with 413: one body reader (liveview/http.mjs readJsonBody).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startLiveView } from "../scripts/liveview.mjs";

function request(port, method, path, raw) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers: { host: `127.0.0.1:${port}`, "content-type": "application/json" } }, (res) => {
      const chunks = [];
      res.on("data", (d) => chunks.push(d));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(raw);
  });
}

test("a body that isn't JSON: 400 on every route that reads one, never 500", async () => {
  const logged = [];
  const no = () => { throw new Error("must not be reached"); };
  const view = await startLiveView({
    getContext: async () => ({ pages: () => [], on: () => {} }), currentUrl: async () => "about:blank", log: (...a) => logged.push(a.join(" ")),
    devPanel: { act: no }, joinHost: { act: no, state: () => ({}) }, profile: { get: () => ({}) }, picker: { state: () => ({}), pick: no },
    settings: { read: () => ({}), write: no }, reporter: { enabled: () => true, relay: no }, sessionOps: { state: () => ({}), save: no, rename: no },
    timeline: { enabled: true, cards: () => [], note: no, pin: no, onChange: () => () => {} }, onRecord: no, makeInvite: no, onPause: no,
    capture: { reply: () => false },
  });
  try {
    const key = view.url.split("/").at(-2);
    const routes = ["approve", "dev", "joinhost", "profile", "invite", "pick", "layout", "config", "report", "session", "timeline/note", "record", "pause", "input", "tab", "tab-order"];
    for (const route of routes) {
      for (const raw of ["not json", "{", ""]) {
        const r = await request(view.port, "POST", `/${key}/${route}`, raw);
        assert.equal(r.status, 400, `${route} ${JSON.stringify(raw)}: ${r.status} ${r.text}`);
      }
    }
    const r = await request(view.port, "POST", `/${view.pagesKey}/capture/reply`, "not json");
    assert.equal(r.status, 400, "capture reply");
    // A JSON value that isn't an object, where an object is required.
    for (const route of ["dev", "joinhost", "profile", "record", "approve"]) assert.equal((await request(view.port, "POST", `/${key}/${route}`, "[1]")).status, 400, route);
    assert.equal((await request(view.port, "POST", `/${key}/approve`, "null")).status, 400, "approve null");
    // Too large: 413.
    assert.equal((await request(view.port, "POST", `/${key}/approve`, "x".repeat(3000))).status, 413);
    assert.deepEqual(logged.filter((l) => l.startsWith("liveview ")), [], "nothing reached the catch-all");
  } finally {
    view.close();
  }
});
