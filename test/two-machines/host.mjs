// The host side of the two-machine check (two-machines.docker.test.mjs): this computer, with the
// PairBrowse browser, shares Google through a real Quick Tunnel to a joiner in a Linux container
// (another machine behind its own NAT, joiner.mjs). Prints what happened, one line per step.
import { helper, sleep, text } from "./common.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
const home = mkdtempSync("/tmp/pbh-");
const h = await helper({ home, repo, runtime: process.env.HOME + "/.pairbrowse/runtime",
  config: { executablePath: process.env.HOME + "/.pairbrowse/browser/PairBrowse.app/Contents/MacOS/pairbrowse", chromeArgs: ["--headless=new"], display: "none", screenshots: false, participantName: "Kees", browserDriver: "playwright" } });
console.log("nav:", !(await h.tool("browser_navigate", { url: "https://www.google.com/?hl=en" })).result?.isError);
const joiner = spawn("docker", ["exec", "pb-joiner", "node", "/repo/test/two-machines/joiner.mjs"], { stdio: ["ignore", "inherit", "inherit"] });
const made = text(await h.tool("pairbrowse_invite", { action: "create", role: "drive", label: "Sven", share: "code", name: "Kees" }));
const code = made.match(/Join code: (pb-join:[A-Za-z0-9_-]+)/)?.[1];
console.log("code via", code ? JSON.parse(Buffer.from(code.slice(8), "base64url")).u : made.slice(0, 200));
execFileSync("docker", ["exec", "pb-joiner", "sh", "-c", `echo '${code}' > /tmp/code`]);
let id;
for (let i = 0; i < 90 && !id; i++) { id = text(await h.tool("pairbrowse_invite", { action: "list" })).match(/request (r[0-9a-f]{6}): Sven/)?.[1]; if (!id) await sleep(1000); }
console.log("approve:", text(await h.tool("pairbrowse_invite", { action: "approve", id })).slice(0, 60));
await h.tool("pairbrowse_collaboration", { action: "release" });
let value = "";
for (let i = 0; i < 120; i++) {
  const r = text(await h.tool("browser_evaluate", { function: "() => (document.querySelector('textarea[name=q], input[name=q]') || {}).value || ''" }));
  value = (r.match(/### Result\n"?([^"\n]*)/) || [])[1] || "";
  if (/hello from sven/.test(value)) break;
  await sleep(1000);
}
console.log("host's Google box:", JSON.stringify(value));
console.log("host status:", text(await h.tool("pairbrowse_collaboration", { action: "status" })).slice(0, 300));
await sleep(15000);
execFileSync("docker", ["exec", "pb-joiner", "touch", "/tmp/stop"]);
await sleep(3000);
h.stop(); joiner.kill();
process.exit(0);
