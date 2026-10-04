// The joiner side of the two-machine check: runs inside the Linux container (another machine,
// behind its own NAT) with the repository at /repo and the runtime at /runtime.
import { helper, sleep, text } from "./common.mjs";
import { readFileSync, existsSync } from "node:fs";
const say = (o) => console.log(JSON.stringify(o));
const j = await helper({ home: "/home/j", repo: "/repo", runtime: "/runtime", env: { PAIRBROWSE_TEST_SCREEN: "1" },
  config: { executablePath: "/ms-playwright/chromium-1247/chrome-linux-arm64/chrome", chromeArgs: ["--headless=new", "--no-sandbox"], display: "none", screenshots: false, participantName: "Sven", browserDriver: "playwright" } });
while (!existsSync("/tmp/code")) await sleep(300);
say({ join: text(await j.tool("pairbrowse_join", { action: "join", code: readFileSync("/tmp/code", "utf8").trim() })).slice(0, 120) });
for (let i = 0; i < 120; i++) { const s = text(await j.tool("pairbrowse_join", { action: "status" })); if (/You're in/.test(s)) { say({ status: s }); break; } await sleep(1000); }
const screen = async (a) => { try { return JSON.parse(text(await j.tool("pairbrowse_test_screen", a))); } catch { return null; } };
let sc; for (let i = 0; i < 60 && !(sc = await screen({}))?.index; i++) await sleep(500);
const live = text(await j.tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
await fetch(`${live}tab`, { method: "POST", body: JSON.stringify({ i: sc.index }) });
let st; for (let i = 0; i < 60; i++) { st = (await screen({ expr: "window.pbScreen.state()" }))?.value; if (st?.conn === "connected" || st?.view === "frames") break; await sleep(1000); }
say({ state: st });
await sleep(3000);
say({ stats: (await screen({ expr: "window.pbScreen.stats()" }))?.value });
// Click the middle of the picture (Google's search box) and type, as a person.
const size = (await screen({ expr: "[document.getElementById('v').videoWidth, document.getElementById('v').videoHeight, innerWidth, innerHeight]" }))?.value || [0, 0, 1, 1];
say({ size });
const [fw, fh, vw, vh] = size; const k = Math.min(vw / fw, vh / fh), x = Math.round((vw - fw * k) / 2 + 0.5 * fw * k), y = Math.round((vh - fh * k) / 2 + 0.42 * fh * k);
await fetch(`${live}input`, { method: "POST", body: JSON.stringify([{ type: "mouse", action: "mouseMoved", x, y }, { type: "mouse", action: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, { type: "mouse", action: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }]) });
await sleep(500);
await screen({ type: "hello from sven" });
say({ typed: true });
await sleep(6000);
// Sven's own Claude, in the host's browser.
const snap = text(await j.tool("browser_snapshot"));
say({ agentSnapshotSeesGoogle: /Google/.test(snap), refs: (snap.match(/\[ref=e\d+\]/g) || []).length });
say({ done: true, stats: (await screen({ expr: "window.pbScreen.stats()" }))?.value });
while (!existsSync("/tmp/stop")) await sleep(500);
j.stop();
