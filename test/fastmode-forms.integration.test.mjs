// Fast mode on forms as popular sites build them: a form embedded in a frame, a styled dropdown
// whose own input is hidden, a styled checkbox. A payment provider's card frame is left alone.
// Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { session } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

const PAGES = {
  "/": `<!doctype html><title>Signup</title><h1>Start your trial</h1>
<label for=k>Topic</label> <select id=k><option>Sales</option><option>Support</option></select>
<iframe src="/form" style="width:600px;height:420px;border:0"></iframe>
<iframe src="/card" style="width:400px;height:80px;border:0"></iframe>`,
  // The embedded form: a styled dropdown (its input 0x0, a list that opens on a click) and a
  // styled checkbox (the box hidden, its text clicked).
  "/form": `<!doctype html><body>
<label for=f>First name</label> <input id=f>
<div class=field><div class=wrap><input id=co name="field[company]"></div><p class=floating>Company name*</p></div>
<label for=e>Email</label> <input id=e type=email>
<label for=c2>Country</label> <select id=c2 onchange="st.hidden = this.value !== 'United States'"><option>Belgium</option><option>United States</option></select>
<pb-plan></pb-plan>
<script>
// A form part inside a web component (open shadow root), as some sites build theirs.
customElements.define("pb-plan", class extends HTMLElement { connectedCallback() { const r = this.attachShadow({ mode: "open" }); r.innerHTML = '<label for=pl>Plan</label> <select id=pl><option value="" disabled selected>Select plan</option><option>Team</option></select>'; } });
</script>
<span id=st hidden><label for=s2>State</label> <select id=s2><option value="" disabled selected>Select state</option><option>California</option></select></span>
<div id=size style="width:220px;height:32px;border:1px solid #888;cursor:pointer">
  <input id=si aria-label="Company size" style="width:0;height:0;opacity:0;border:0;padding:0" readonly>
  <span id=shown>Select company size</span>
</div>
<ul id=list role=listbox hidden><li role=option onclick="pick(this)">1-20 employees</li><li role=option onclick="pick(this)">21-100 employees</li></ul>
<label for=langf>Language</label> <input id=langf role=combobox aria-autocomplete=list aria-controls=langs oninput="langs.hidden = !this.value; [...langs.children].forEach((o) => o.hidden = !o.textContent.toLowerCase().startsWith(this.value.toLowerCase()))" onblur="setTimeout(() => { if (!this.dataset.picked) this.value = ''; }, 50)">
<ul id=langs role=listbox hidden><li role=option onmousedown="langf.value = this.textContent; langf.dataset.picked = 1; langs.hidden = true">English (US)</li><li role=option onmousedown="langf.value = this.textContent; langf.dataset.picked = 1; langs.hidden = true">German</li></ul>
<label for=rs-input>Team size</label>
<div id=rs style="width:220px;height:32px;border:1px solid #888;cursor:pointer"><input id=rs-input style="width:0;height:0;opacity:0;border:0;padding:0" readonly><span id=rsv>Select...</span></div>
<div id=rsm hidden style="position:absolute;background:#fff;border:1px solid #888"><div onclick="rsv.textContent = 'Team of 20-49'; rs-input; document.getElementById('rs-input').value = '20-49'; rsm.hidden = true">20-49</div><div onclick="document.getElementById('rs-input').value = '1-19'; rsv.textContent = '1-19'; rsm.hidden = true">1-19</div></div>
<p>Number of employees</p><div><input type=radio name=account.size value=1 id=e1><label for=e1>1-9</label><input type=radio name=account.size value=2 id=e2><label for=e2>10-49</label></div>
<div class=fieldbox><label for=mob>Mobile</label> <input id=mob oninput="mobErr.hidden = /^\\+/.test(this.value)"><span id=mobErr class=field-error hidden>Please enter a valid mobile number</span></div>
<p>All fields are required.</p>
<label for=dep-in>Department</label>
<div id=dep style="width:220px;height:30px;border:1px solid #888;cursor:pointer"><input id=dep-in style="width:0;height:0;opacity:0;border:0;padding:0" readonly><span id=depv>Select</span></div>
<div id=depm hidden style="position:absolute;background:#fff;border:1px solid #888"><div><label onclick="document.getElementById('dep-in').value = 'Sales'; depv.textContent = 'Sales'; depm.hidden = true">Sales</label></div><div><label onclick="document.getElementById('dep-in').value = 'Marketing'; depv.textContent = 'Marketing'; depm.hidden = true">Marketing</label></div></div>
<label for=jobrole>Role</label> <input id=jobrole role=combobox aria-autocomplete=list oninput="roles.hidden = !this.value; [...roles.children].forEach((o) => o.hidden = !o.textContent.toLowerCase().startsWith(this.value.toLowerCase()))" onblur="setTimeout(() => { if (!this.dataset.picked) this.value = ''; }, 50)">
<ul id=roles role=listbox hidden style="position:absolute;background:#fff"><li role=option onmousedown="jobrole.value = this.textContent; jobrole.dataset.picked = 1; roles.hidden = true">Software Engineer</li><li role=option onmousedown="jobrole.value = this.textContent; jobrole.dataset.picked = 1; roles.hidden = true">Sales Manager</li></ul><div>Job level</div><select id=jl><option value="">Select...</option><option>Manager</option></select>
<input type=checkbox id=t aria-label="I agree to the terms" style="position:absolute;opacity:0;width:1px;height:1px"><p onclick="t.click()">I agree to the terms</p>
<script>
size.onclick = () => { list.hidden = false; };
rs.onclick = () => { rsm.hidden = false; };
dep.onclick = () => { depm.hidden = false; };
function pick(li) { si.value = li.textContent; shown.textContent = li.textContent; list.hidden = true; }
</script>`,
  "/card": `<!doctype html><label for=c>Card number</label> <input id=c autocomplete="cc-number">`,
};

test("fast mode fills a form inside a frame, opens a styled dropdown, ticks a styled box, and leaves card frames alone", { skip: !runtime, timeout: 180_000 }, async () => {
  const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGES[req.url] || ""); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "forms-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h }, stdio: ["ignore", out, out] });
  let a;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    a = await session(socketPath, "f");
    assert.match(text(await a.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    assert.ok(!(await a.tool("browser_navigate", { url: `http://127.0.0.1:${site.address().port}/` })).result?.isError);
    await sleep(800);
    const r = text(await a.tool("pairbrowse_run", { steps: [
      { fill: { "First name": "Alex", Email: "alex@example.com" } },
      { select: { "Company size": "21-100 employees" } },
      { check: "I agree to the terms" },
    ] }));
    assert.match(r, /^Done: 3 steps/, r);
    // An error shown under a field without marking it (red text in an "error" box) is reported.
    const mob = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Mobile: "4155550142" } }] }));
    assert.match(mob, /"Mobile": Please enter a valid mobile number/, mob);
    // A list whose choices are plain labels (no option role): the one that opened is clicked.
    const dep = text(await a.tool("pairbrowse_run", { steps: [{ select: { Department: "Marketing" } }] }));
    assert.match(dep, /^Done: 1 steps/, dep);
    // A type-to-search field that has nothing for the whole text: a shorter part of it finds the match.
    const role = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Role: "Software engineer, backend" } }] }));
    assert.match(role, /^Done: 1 steps/, role);
    assert.match(text(await a.tool("browser_snapshot")), /combobox "Role"[^\n]*: Software Engineer/);
    // A <select> named only by the text before it; an instruction line is never taken for a name.
    const jl = text(await a.tool("pairbrowse_run", { steps: [{ select: { "Job level": "Manager" } }] }));
    assert.match(jl, /^Done: 1 steps/, jl);
    assert.doesNotMatch(jl, /All fields are required/, jl);
    // A field whose name is only drawn over it (a page builder's floating label, no <label>).
    const co = text(await a.tool("pairbrowse_run", { steps: [{ fill: { "Company name": "Rivera Labs" } }] }));
    assert.match(co, /^Done: 1 steps/, co);
    // A dropdown built from plain elements (no role="option"): the choice that showed is clicked.
    const plain = text(await a.tool("pairbrowse_run", { steps: [{ select: { "Team size": "20-49" } }] }));
    assert.match(plain, /^Done: 1 steps/, plain);
    // What's left is named as a person reads it: the question over a row of choices, not "account.size".
    assert.match(plain, /"Number of employees"/, plain);
    assert.doesNotMatch(plain, /account\.size/, plain);
    // A choice the list doesn't have: the run lists the ones it does.
    const none = text(await a.tool("pairbrowse_run", { steps: [{ select: { "Team size": "5000+" } }] }));
    assert.match(none, /Its options: [^\n]*1-19/, none);
    // A field that suggests as you type: the matching suggestion is picked (typing alone is thrown away).
    const lang = text(await a.tool("pairbrowse_run", { steps: [{ fill: { Language: "English" } }] }));
    assert.match(lang, /^Done: 1 steps/, lang);
    assert.match(text(await a.tool("browser_snapshot")), /combobox "Language"[^\n]*: English \(US\)/);
    // A field the form added on the way (a state once the country is chosen) is reported.
    const added = text(await a.tool("pairbrowse_run", { steps: [{ select: { Country: "United States" } }] }));
    assert.match(added, /"Plan"/, added); // inside a web component, still to choose
    await a.tool("pairbrowse_run", { steps: [{ select: { Plan: "Team" } }] });
    assert.match(added, /still empty and required: [^\n]*"State"/, `${added}\n----\n${text(await a.tool("browser_snapshot")).slice(0, 2500)}`);
    const fixed = text(await a.tool("pairbrowse_run", { steps: [{ select: { State: "California" } }] }));
    assert.doesNotMatch(fixed, /still empty/, fixed);
    const s = text(await a.tool("browser_snapshot"));
    assert.match(s, /textbox "First name"[^\n]*: Alex/, s.slice(0, 1500));
    assert.match(s, /21-100 employees/);
    assert.match(s, /checkbox "I agree to the terms" \[checked\]/);
    // A field the form doesn't have (it dropped it) is never taken for another dropdown.
    const gone = text(await a.tool("pairbrowse_run", { steps: [{ select: { Region: "Europe" } }] }));
    assert.match(gone, /No dropdown "Region"/, gone);
    // A card frame is never filled by fast mode: card details are the user's.
    const card = text(await a.tool("pairbrowse_run", { steps: [{ fill: { "Card number": "4242424242424242" } }] }));
    assert.match(card, /No field "Card number"/, card);
  } catch (e) {
    throw new Error(`${e.message}\n${(() => { try { return readFileSync(join(h, "daemon.log"), "utf8").slice(-1500); } catch { return ""; } })()}`);
  } finally {
    a?.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    site.close();
    rmSync(h, { recursive: true, force: true });
  }
});
