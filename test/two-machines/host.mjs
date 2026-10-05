// The host side of the two-machine check (two-machines.docker.test.mjs): one computer shares
// Google through a real Quick Tunnel with a joiner on another (behind its own NAT, joiner.mjs).
// Either side can be this Mac or a Linux container; they meet in a shared folder (PB_MAIL).
// Prints what happened, one JSON line per step.
import { helper, sleep, text, post, wait, browserPath, chromeArgs } from "./common.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const say = (o) => console.log(JSON.stringify({ host: process.platform, ...o }));
const home = mkdtempSync(join(tmpdir(), "pbh-"));
const h = await helper({ home, repo, runtime: process.env.PB_RUNTIME || process.env.HOME + "/.pairbrowse/runtime",
  config: { executablePath: browserPath(), chromeArgs, display: "none", screenshots: false, participantName: "Kees", browserDriver: "playwright" } });
const tabs = async () => [...text(await h.tool("browser_tabs", { action: "list" })).matchAll(/^- (\d+):( \(current\))? \[[^\n]*\]\(([^)\s]*)\)/gm)].map((m) => ({ index: Number(m[1]), url: m[3] }));
say({ nav: !(await h.tool("browser_navigate", { url: "https://www.google.com/?hl=en" })).result?.isError });
const made = text(await h.tool("pairbrowse_invite", { action: "create", role: "drive", label: "Sven", share: "code", name: "Kees" }));
const code = made.match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
say({ codeVia: code ? JSON.parse(Buffer.from(code.slice(8), "base64url")).u : made.slice(0, 200) });
post("code", code);
let id;
for (let i = 0; i < 90 && !id; i++) { id = text(await h.tool("pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Sven/)?.[1]; if (!id) await sleep(1000); }
say({ approve: text(await h.tool("pairbrowse_invite", { action: "approve", id })).slice(0, 60) });
await h.tool("pairbrowse_collaboration", { action: "release" });
let value = "";
for (let i = 0; i < 120; i++) {
  const r = text(await h.tool("browser_evaluate", { function: "() => (document.querySelector('textarea[name=q], input[name=q]') || {}).value || ''" }));
  value = (r.match(/### Result\n"?([^"\n]*)/) || [])[1] || "";
  if (/hello from sven/.test(value)) break;
  await sleep(1000);
}
say({ googleBox: value });
say({ status: text(await h.tool("pairbrowse_collaboration", { action: "status" })).slice(0, 300) });
await wait("typed-done");

// Two more tabs, and the host back on Google: Sven's agents must start where Sven looks (IANA),
// not in the first tab no agent is in (Example).
for (const url of ["https://example.com/", "https://www.iana.org/"]) { await h.tool("browser_tabs", { action: "new" }); await h.tool("browser_navigate", { url }); }
await h.tool("browser_tabs", { action: "select", index: (await tabs()).find((t) => /google\./.test(t.url)).index });
await h.tool("pairbrowse_collaboration", { action: "release" });
post("two");

// Sven's agent holds the IANA tab; then says release, and it's free here at once.
await wait("held");
await h.tool("browser_tabs", { action: "select", index: (await tabs()).find((t) => /iana\.org/.test(t.url)).index });
let r = await h.tool("browser_press_key", { key: "Shift" });
say({ whileHeld: { refused: !!r.result?.isError, text: text(r).slice(0, 120) } });
post("checked");
await wait("released");
const t0 = Date.now();
r = await h.tool("browser_press_key", { key: "Shift" });
say({ afterRelease: { ok: !r.result?.isError, ms: Date.now() - t0, text: text(r).slice(0, 120) } });
post("host-done");
await wait("stop");
h.stop();
await sleep(1000);
process.exit(0);
