// The joiner side of the two-machine check: another machine (this Mac or a Linux container)
// behind its own NAT, meeting the host in the shared folder (PB_MAIL).
import { helper, attach, sleep, text, post, wait, browserPath, chromeArgs } from "./common.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const say = (o) => console.log(JSON.stringify({ joiner: process.platform, ...o }));
const home = mkdtempSync(join(tmpdir(), "pbj-"));
const j = await helper({ home, repo, runtime: process.env.PB_RUNTIME || process.env.HOME + "/.pairbrowse/runtime", env: { PAIRBROWSE_TEST_SCREEN: "1" },
  config: { executablePath: browserPath(), chromeArgs, display: "none", screenshots: false, participantName: "Sven", browserDriver: "playwright" } });
const code = (await wait("code")).trim();
say({ join: text(await j.tool("pairbrowse_join", { action: "join", code })).slice(0, 120) });
for (let i = 0; i < 120; i++) { const s = text(await j.tool("pairbrowse_join", { action: "status" })); if (/You're in/.test(s)) { say({ status: s.slice(0, 200) }); break; } await sleep(1000); }
const screen = async (a) => { try { return JSON.parse(text(await j.tool("pairbrowse_test_screen", a))); } catch { return null; } };
let sc; for (let i = 0; i < 60 && !(sc = await screen({}))?.index; i++) await sleep(500);
const live = text(await j.tool("pairbrowse_liveview")).match(/http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\//)[0];
await fetch(`${live}tab`, { method: "POST", body: JSON.stringify({ i: sc.index }) });
let st; for (let i = 0; i < 60; i++) { st = (await screen({ expr: "window.pbScreen.state()" }))?.value; if (st?.conn === "connected" || st?.view === "frames") break; await sleep(1000); }
say({ state: st });
await sleep(3000);
// Click the middle of the picture (Google's search box) and type, as a person.
const size = (await screen({ expr: "[document.getElementById('v').videoWidth, document.getElementById('v').videoHeight, innerWidth, innerHeight]" }))?.value || [0, 0, 1, 1];
const [fw, fh, vw, vh] = size; const k = Math.min(vw / fw, vh / fh), x = Math.round((vw - fw * k) / 2 + 0.5 * fw * k), y = Math.round((vh - fh * k) / 2 + 0.42 * fh * k);
await fetch(`${live}input`, { method: "POST", body: JSON.stringify([{ type: "mouse", action: "mouseMoved", x, y }, { type: "mouse", action: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, { type: "mouse", action: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }]) });
await sleep(500);
await screen({ type: "hello from sven" });
await sleep(6000);
// Sven's own Claude, in the host's browser.
const snap = text(await j.tool("browser_snapshot"));
say({ agentSnapshotSeesGoogle: /Google/.test(snap), stats: (await screen({ expr: "window.pbScreen.stats()" }))?.value });
post("typed-done");

// Three host tabs, the host on Google. Sven looks at IANA: a new agent of his starts there.
await wait("two");
const pictures = async () => { try { return JSON.parse(text(await j.tool("pairbrowse_test_screen", { list: true }))); } catch { return []; } };
let ia, ex, go;
for (let i = 0; i < 60 && !(ia && ex); i++) { const l = await pictures(); ia = l.find((p) => /Internet Assigned/.test(p.title)); ex = l.find((p) => /Example Domain/.test(p.title)); go = l.find((p) => /Google/.test(p.title)); if (!(ia && ex)) await sleep(500); }
say({ pictures: await pictures() });
// Headless, every tab counts as visible: the other pictures say they're in the background, as in a window.
const hide = (at) => screen({ at, expr: "Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }) && 1" });
await hide(go.index); await hide(ex.index);
await fetch(`${live}tab`, { method: "POST", body: JSON.stringify({ i: ia.index }) });
await sleep(3000);
const pageOf = (s) => (s.match(/Page URL: (\S+)/) || [])[1] || s.slice(0, 120);
const a2 = await attach(home);
say({ inSight: { startsOn: pageOf(text(await a2.tool("browser_snapshot"))) } });
a2.close();
// Now neither is in sight (Sven switched to another app): it starts on the one he looked at last.
await hide(ia.index);
await sleep(4000);
const a3 = await attach(home);
say({ lastLookedAt: { startsOn: pageOf(text(await a3.tool("browser_snapshot"))) } });
const r = await a3.tool("browser_press_key", { key: "Shift" });
say({ agentHolds: { ok: !r.result?.isError, text: text(r).slice(0, 120) } });
post("held");
await wait("checked");
say({ release: text(await a3.tool("pairbrowse_collaboration", { action: "release" })).slice(0, 120) });
post("released");
await wait("host-done");
a3.close();
post("stop");
await sleep(1000);
j.stop();
await sleep(1000);
process.exit(0);
