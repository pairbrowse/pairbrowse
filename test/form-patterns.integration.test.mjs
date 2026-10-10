// Fast mode on common form patterns, each built generically: three date field styles, an address
// that suggests as you type, a multi-step wizard, password rules, a required group of boxes,
// labels in another language, fields inside a closed section, a value a script rewrites late, a
// date the field shows its own way, and a styled dropdown on a big page that renames itself.
// Every check reads the values the page really holds. Live: a real helper and browser (PAIRBROWSE_TEST_RUNTIME).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, existsSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { session } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (r) => (r.result?.content || []).map((c) => c.text || "").join("\n") || r.error?.message || "";

const PAGE = `<!doctype html><title>Patterns</title><body>
<header><nav><a href="#">Employer</a> <div role=button aria-label="Select your country" onclick="this.dataset.opened = 1">Globe</div></nav></header>
<h2>Dates</h2>
<label for=d1>Date of birth</label> <input id=d1 type=date>
<label for=d2>Start date</label> <input id=d2 placeholder="MM/DD/YYYY" oninput="this.value = this.value.replace(/[^0-9/]/g, '')">
<fieldset><legend>Arrival</legend>
<label for=dd>Day</label> <select id=dd><option value="">Day</option>${Array.from({ length: 31 }, (_, i) => `<option>${i + 1}</option>`).join("")}</select>
<label for=mm>Month</label> <select id=mm><option value="">Month</option>${["January","February","March","April","May","June","July","August","September","October","November","December"].map((m) => `<option>${m}</option>`).join("")}</select>
<label for=yy>Year</label> <select id=yy><option value="">Year</option>${Array.from({ length: 60 }, (_, i) => `<option>${2030 - i}</option>`).join("")}</select></fieldset>
<h2>Address</h2>
<label for=ad>Street address</label> <input id=ad role=combobox aria-autocomplete=list oninput="sug.hidden = this.value.length < 3" onblur="setTimeout(() => { if (!this.dataset.picked) this.value = ''; }, 50)">
<ul id=sug role=listbox hidden style="position:absolute;z-index:5;background:#fff;margin-top:90px"><li role=option onmousedown="ad.value = this.textContent; ad.dataset.picked = 1; sug.hidden = true">500 Howard Street, San Francisco, CA</li><li role=option onmousedown="ad.value = this.textContent; ad.dataset.picked = 1; sug.hidden = true">500 Howard Ave, Burlingame, CA</li></ul>
<h2>Password</h2>
<div><label for=pw>Password</label> <input id=pw type=password onblur="pwerr.hidden = this.value.length >= 12"><span id=pwerr class=error hidden>Use at least 12 characters</span></div>
<h2>Interests (choose at least one)</h2>
<label><input type=checkbox name=int value=a> Analytics</label> <label><input type=checkbox name=int value=b> Billing</label>
<h2>Kontakt</h2>
<label for=vn>Vorname</label> <input id=vn> <label for=nn>Nachname</label> <input id=nn>
<label for=pl>Postleitzahl</label> <input id=pl>
<details id=more><summary>More details</summary><label for=ref>Referral code</label> <input id=ref></details>
<label for=em2>Work email</label> <input id=em2 onchange="co2.value = 'Acme Corporation'"> <label for=co2>Company name</label> <input id=co2>
<h2>Phone</h2>
<select id=pcc aria-label="Country code"><option>US +1</option></select> <label for=ph>Mobile number</label> <input id=ph oninput="this.value = this.value.replace(/^\\+\\d{1,3}\\s*/, '')">
<h2>Lists</h2>
<div style="position:relative"><button type=button id=lo role=combobox aria-haspopup=listbox aria-controls=ll aria-label="Country list" onclick="ll.hidden = !ll.hidden">Pick</button>
<ul id=ll role=listbox hidden style="position:absolute;z-index:5;max-height:200px;overflow:auto;background:#fff;margin:0">${Array.from({ length: 200 }, (_, i) => `<li role=option onclick="lo.textContent = this.textContent; ll.hidden = true">Land ${String(i).padStart(3, "0")}</li>`).join("")}<li role=option onclick="lo.textContent = this.textContent; ll.hidden = true">United States</li></ul></div>
<div style="position:relative"><button type=button id=no aria-haspopup=listbox aria-label="Nation" onclick="np.hidden = false; nq.value = ''; nq.oninput(); nq.focus()">Pick</button>
<div id=np hidden style="position:absolute;z-index:5;background:#fff"><input id=nq aria-label="Search nations" oninput="const v = this.value.toLowerCase(); nl.innerHTML = NATIONS.filter((n) => n.toLowerCase().includes(v)).slice(0, 8).map((n) => '<li role=option>' + n + '</li>').join('')">
<ul id=nl role=listbox onclick="if (event.target.matches('li')) { no.textContent = event.target.textContent; np.hidden = true; }"></ul></div></div>
<script>const NATIONS = ${JSON.stringify(Array.from({ length: 150 }, (_, i) => `Nation ${i}`).concat(["Uruguay"]))};</script>
<div><label for=tp>Topic*</label><input id=tp hidden required><input readonly role=combobox aria-haspopup=listbox aria-controls=tl placeholder="Choose" onclick="tl.hidden = false">
<ul id=tl role=listbox hidden style="position:absolute;z-index:5;background:#fff" onclick="if (event.target.matches('li')) { tp.value = event.target.textContent; this.previousElementSibling.value = event.target.textContent; this.hidden = true; }"><li role=option>Sales</li><li role=option>Support</li></ul></div>
<select id=ot><option value="" disabled selected>Organization Type*</option><option>Business</option><option>Nonprofit</option></select>
<div style="position:relative;width:220px;height:28px;border:1px solid #999"><span>Vietnam</span> <span>Change</span><select id=hc aria-label="Change country" style="position:absolute;left:0;top:0;opacity:0;width:0;height:0"><option>Vietnam</option><option>United States</option></select></div>
<div style="position:relative"><label for=nowhere>Product family</label> <button type=button id=pf aria-label="open menu" onclick="pfl.hidden = false">v</button>
<div id=pfl hidden style="position:absolute;z-index:5;background:#fff" onclick="if (event.target.matches('[role=option]')) { pf.textContent = event.target.textContent; this.hidden = true; }"><div role=option>Alpha suite</div><div role=option>Beta suite</div></div></div>
<label for=cs>Country/Region</label> <select id=cs><option value=ca>CA - Canada</option><option value=us>US - United States</option></select>
<label for=csz>Company size</label> <select id=csz><option value="">Choose</option><option>0 - 500</option><option>501 - 1000</option></select>
<div style="position:relative;width:220px;height:28px"><span style="position:relative;z-index:2;background:#fff;display:block;height:28px">Vietnam - Change</span><select id=st aria-label="Ship to" style="position:absolute;inset:0;opacity:0;z-index:1"><option>Vietnam</option><option>United States</option></select></div>
<iframe id=fr style="width:400px;height:260px" srcdoc="${`<div style='position:relative'><button type=button id=fo aria-haspopup=listbox aria-label='Region' onclick='rp.hidden = false; rq.focus()'>Pick</button><div id=rp hidden style='position:absolute;z-index:5;background:#fff'><input id=rq aria-label='Search regions' oninput='const v = this.value.toLowerCase(); rl.innerHTML = Array.from({ length: 120 }, (_, i) => &quot;Region &quot; + i).concat([&quot;Pacific Northwest&quot;]).filter((n) => n.toLowerCase().includes(v)).slice(0, 6).map((n) => &quot;<li role=option>&quot; + n + &quot;</li>&quot;).join(&quot;&quot;)'><ul id=rl role=listbox onclick='if (event.target.matches(&quot;li&quot;)) { fo.textContent = event.target.textContent; rp.hidden = true; }'></ul></div></div>`}"></iframe>
<div><label for=gn>Given name</label><span class=error-mark style="color:red">*</span> <input id=gn></div>
<div><select name=ctry><option></option><option>United States</option></select><span class=label>Country</span></div>
<div><input id=cpy placeholder="&nbsp;"><span class=label>Employer</span></div>
<p>Phone (no spaces fit) <label for=tel2>Phone number</label> <input id=tel2 maxlength=12></p>
<p>Sort results</p><div><select id=lone><option>Alpha</option><option>Beta</option></select></div>
<div style="position:relative"><button type=button id=plo aria-label="Home country" onclick="plb.style.display = 'block'">Pick</button>
<div id=plb style="display:none;position:absolute;z-index:5;background:#fff;max-height:180px;overflow-y:auto">${Array.from({ length: 150 }, (_, i) => `<div class=row onclick="plo.textContent = this.textContent; plb.style.display = 'none'">Place ${i}</div>`).join("")}<div class=row onclick="plo.textContent = this.textContent; plb.style.display = 'none'">Canada</div></div></div>
<div><button type=button id=ipo aria-label="Product line" onclick="ipp.hidden = false">Choose</button>
<div id=ipp hidden><div role=tablist><span role=tab>Cloud</span></div><div role=tabpanel><h5>Apps</h5><div role=option onclick="ipo.textContent = 'Gamma'; ipp.hidden = true"><span>Gamma</span> <small>planning</small></div><div role=option onclick="ipo.textContent = 'Delta'; ipp.hidden = true"><span>Delta</span></div></div></div></div>
<div style="position:relative"><button type=button id=vho aria-label="Plan" onclick="vhl.style.visibility = 'visible'">Choose</button>
<ul id=vhl role=listbox style="visibility:hidden;position:absolute;z-index:5;background:#fff;margin:0" onclick="if (event.target.matches('li')) { vho.textContent = event.target.textContent; this.style.visibility = 'hidden'; }"><li role=option>Starter</li><li role=option>Team</li></ul></div>
<label for=dep>Department</label> <select id=dep aria-invalid=true onchange="/* the page forgets to clear aria-invalid */"><option value="">Choose</option><option>Sales</option></select>
<div style="position:relative"><button type=button id=lto aria-label="Sales region" onclick="setTimeout(() => { ltl.innerHTML = '<li role=option>East</li><li role=option>West</li>'; ltl.hidden = false; }, 1500)">Choose</button>
<ul id=ltl role=listbox hidden style="position:absolute;z-index:5;background:#fff;margin:0" onclick="if (event.target.matches('li')) { lto.textContent = event.target.textContent; this.hidden = true; }"></ul></div>
<h2>Trip</h2>
<label for=lv>Leaving on</label> <input id=lv onblur="const d = new Date(this.value); if (!isNaN(d)) this.value = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })">
<div style="position:relative"><button type=button id=tk aria-haspopup=listbox aria-label="Ticket kind. Return" onclick="tkl.hidden = false">Return</button>
<ul id=tkl role=listbox hidden style="position:absolute;z-index:5;background:#fff;margin:0" onclick="if (event.target.matches('li')) { tk.textContent = event.target.textContent; tk.setAttribute('aria-label', 'Ticket kind. ' + event.target.textContent); this.hidden = true; }"><li role=option>Return</li><li role=option>Single</li></ul></div>
<div id=filler>${Array.from({ length: 300 }, (_, i) => `<div>${Array.from({ length: 15 }, (_, j) => `<span>Deal ${i}-${j}</span> `).join("")}</div>`).join("")}</div>
<h2>Residence</h2>
<label for=lr>Country of residence</label> <input id=lr onblur="setTimeout(() => { this.value = 'Germany'; }, 300)">
<h2>Placeholder labels</h2>
<style>.phl.populated + span { display: none }</style>
<label for=nk><input id=nk class=phl oninput="this.classList.toggle('populated', !!this.value)"><span>Nickname</span></label>
<label for=tn><input id=tn class=phl oninput="this.classList.toggle('populated', !!this.value)"><span>Team name</span></label>
<h2>Wizard</h2>
<div id=s1><label for=w1>Company</label> <input id=w1> <button type=button onclick="s1.hidden = true; s2.hidden = false">Next</button></div>
<div id=s2 hidden><label for=w2>Team size</label> <input id=w2 type=number> <button type=button>Submit</button></div>
</body>`;

test("fast mode fills common form patterns and the page holds every value", { skip: !runtime, timeout: 300_000 }, async (t) => {
  const site = createServer((req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); });
  await new Promise((r) => site.listen(0, "127.0.0.1", r));
  const base = existsSync("/Volumes/BACKUP/PairBrowse") ? "/Volumes/BACKUP/PairBrowse" : tmpdir();
  mkdirSync(base, { recursive: true });
  const h = mkdtempSync(join(base, "patterns-"));
  symlinkSync(runtime, join(h, "runtime"), "dir");
  const executablePath = createRequire(join(runtime, "package.json"))("patchright").chromium.executablePath();
  writeFileSync(join(h, "config.json"), JSON.stringify({ executablePath, chromeArgs: ["--headless=new"], display: "none", screenshots: false }));
  const out = openSync(join(h, "daemon.stderr.log"), "a");
  const daemon = spawn(process.execPath, [join(root, "scripts", "daemon.mjs")], { cwd: root, env: { ...process.env, PAIRBROWSE_HOME: h }, stdio: ["ignore", out, out] });
  let a;
  try {
    const socketPath = join(h, "run", "browser.sock");
    for (let i = 0; i < 600 && !existsSync(socketPath); i++) await sleep(50);
    a = await session(socketPath, "p");
    assert.match(text(await a.tool("pairbrowse_session", { action: "new", clean: true })), /clean/);
    assert.ok(!(await a.tool("browser_navigate", { url: `http://127.0.0.1:${site.address().port}/` })).result?.isError);
    const run = async (steps) => text(await a.tool("pairbrowse_run", { steps }));
    const value = async (id) => text(await a.tool("browser_evaluate", { function: `() => document.getElementById(${JSON.stringify(id)}).value` })).match(/### Result\n"?([^"\n]*)/)?.[1];

    // Dates: a native date field takes the date however it's written; a typed one as given; a
    // day/month/year trio by its choices.
    let r = await run([{ fill: { "Date of birth": "03/15/1990", "Start date": "03/15/2027" } }, { select: { Day: "15", Month: "March", Year: "1990" } }]);
    assert.match(r, /^Done: 2 steps/, r);
    assert.equal(await value("d1"), "1990-03-15");
    assert.equal(await value("d2"), "03/15/2027");
    assert.deepEqual([await value("dd"), await value("mm"), await value("yy")], ["15", "March", "1990"]);
    // An address that suggests as you type: the matching suggestion.
    r = await run([{ fill: { "Street address": "500 Howard Street" } }]);
    assert.match(r, /^Done: 1 steps/, r);
    assert.equal(await value("ad"), "500 Howard Street, San Francisco, CA");
    // Password rules shown on leaving the field come back with the run.
    r = await run([{ fill: { Password: "short" } }]);
    assert.match(r, /"Password": Use at least 12 characters/, r);
    r = await run([{ fill: { Password: "Correct-Horse-42" } }]);
    assert.doesNotMatch(r, /"Password":/, r);
    // A required group: one box ticked.
    r = await run([{ check: "Billing" }]);
    assert.match(r, /^Done: 1 steps/, r);
    // Labels in another language, and a field inside a closed section (opened as a person would).
    r = await run([{ fill: { Vorname: "Alex", Nachname: "Rivera", Postleitzahl: "10115", "Referral code": "RL-2027" } }]);
    assert.match(r, /^Done: 1 steps/, r);
    assert.deepEqual([await value("vn"), await value("nn"), await value("pl"), await value("ref")], ["Alex", "Rivera", "10115", "RL-2027"]);
    // A field the page rewrites from another answer (a lookup from the email) keeps the value given.
    r = await run([{ fill: { "Company name": "Rivera Labs", "Work email": "alex@riveralabs.com" } }]);
    assert.match(r, /^Done: 1 steps/, r);
    assert.equal(await value("co2"), "Rivera Labs");
    // A phone field that drops a typed country code (its country is picked beside it): kept, with a note.
    r = await run([{ fill: { "Mobile number": "+1 415 555 0142" } }]);
    assert.match(r, /^Done: 1 steps/, r);
    assert.match(r, /"Mobile number": shows "415 555 0142": the field dropped \+1/, r);
    assert.equal(await value("ph"), "415 555 0142");
    // A long list that scrolls inside its box: the option far down it. A list with its own search
    // box that shows a few matches at a time: found by typing there.
    r = await run([{ select: { "Country list": "United States" } }, { select: { Nation: "Uruguay" } }]);
    assert.match(r, /^Done: 2 steps/, r);
    const shows = async (id) => text(await a.tool("browser_evaluate", { function: `() => document.getElementById(${JSON.stringify(id)}).textContent` })).match(/### Result\n"?([^"\n]*)/)?.[1];
    assert.equal(await shows("lo"), "United States");
    assert.equal(await shows("no"), "Uruguay");
    // A label pointing at the hidden input that keeps the answer, the list opened by the box beside
    // it; a dropdown named only by its first choice; a native list drawn invisible in its box.
    r = await run([{ select: { Topic: "Sales", "Organization Type": "Business", "Change country": "United States" } }]);
    assert.match(r, /^Done: 1 steps/, r);
    assert.deepEqual([await value("tp"), await value("ot"), await value("hc")], ["Sales", "Business", "United States"]);
    // A label whose field is missing, beside the one unnamed button that opens its list: that
    // list, never the page's one unnamed dropdown elsewhere.
    r = await run([{ select: { "Product family": "Beta suite" } }]);
    assert.match(r, /^Done: 1 steps/, r);
    assert.equal(await shows("pf"), "Beta suite");
    assert.equal(await value("lone"), "Alpha");
    // A native dropdown whose option holds the name ("US - United States"), shown by its text; one
    // drawn invisible under the row a person reads; a list in a frame with its own search box.
    r = await run([{ select: { "Country/Region": "United States", "Ship to": "United States", "Company size": "0-500" } }, { select: { Region: "Pacific Northwest" } }]);
    assert.match(r, /^Done: 2 steps/, r);
    assert.match(r, /Country\/Region \[select\] = US - United States/, r);
    assert.deepEqual([await value("cs"), await value("st"), await value("csz")], ["us", "United States", "0 - 500"]);
    assert.equal(text(await a.tool("browser_evaluate", { function: "() => document.getElementById('fr').contentDocument.getElementById('fo').textContent" })).match(/### Result\n"?([^"\n]*)/)?.[1], "Pacific Northwest");
    // Fields named by text after them, while a menu button up top carries a similar name; a red
    // required mark isn't a page error; a number too long with its spaces is filled in one piece.
    r = await run([{ select: { Country: "United States" } }, { fill: { Employer: "Rivera Labs", "Given name": "Alex", "Phone number": "+1 415 555 0142" } }]);
    assert.match(r, /^Done: 2 steps/, r);
    assert.doesNotMatch(r, /"Given name": \*/, r);
    assert.equal(text(await a.tool("browser_evaluate", { function: "() => document.querySelector('select[name=ctry]').value + '|' + (document.querySelector('[role=button][aria-label]').dataset.opened || '')" })).match(/### Result\n"?([^"\n]*)/)?.[1], "United States|");
    assert.deepEqual([await value("cpy"), await value("gn"), await value("tel2")], ["Rivera Labs", "Alex", "+14155550142"]);
    // Plain rows in a scrolling box (no roles); choices that unfold in place in a panel; a list
    // drawn in advance but invisible until opened; a dropdown the page leaves marked invalid after
    // a valid choice (no error to show) isn't reported.
    // Timed: four ordinary picks are the measure of this machine right now (the suite runs many
    // browsers at once), and the speed checks below are relative to it.
    const p0 = Date.now();
    r = await run([{ select: { "Home country": "Canada", "Product line": "Delta", Plan: "Team", Department: "Sales" } }]);
    const plain = Date.now() - p0;
    assert.match(r, /^Done: 1 steps/, r);
    assert.deepEqual([await shows("plo"), await shows("ipo"), await shows("vho"), await value("dep")], ["Canada", "Delta", "Team", "Sales"]);
    assert.doesNotMatch(r, /"Department": marked as not valid/, r);
    // A list that fills in only after a while: opened again and given longer.
    r = await run([{ select: { "Sales region": "West" } }]);
    assert.match(r, /^Done: 1 steps/, r);
    assert.equal(await shows("lto"), "West");
    // A big page (thousands of elements): a styled dropdown whose name says its choice ("Ticket
    // kind. Return", then "... Single") is picked fast, and the run doesn't wait on the name it was
    // found by. A date the field rewrites its own way ("Nov 20, 2026" shown as "Fri, Nov 20") counts as kept.
    const t0 = Date.now();
    r = await run([{ select: { "Ticket kind. Return": "Single" } }]);
    const took = Date.now() - t0;
    assert.match(r, /^Done: 1 steps/, r);
    assert.equal(await shows("tk"), "Single");
    // Waiting on the stale name would add seconds, whatever the load: one pick allowed what the four took, or 5 s if that's more, never more than 20 s.
    t.diagnostic(`styled pick on a big page: ${took} ms (four plain picks: ${plain} ms)`);
    assert.ok(took < Math.min(20_000, Math.max(5000, plain)), `a styled pick on a big page took ${took} ms (four plain picks: ${plain} ms)`);
    r = await run([{ fill: { "Leaving on": "Nov 20, 2026" } }]);
    assert.match(r, /^Done: 1 steps/, r);
    assert.doesNotMatch(r, /Leaving on"?:/, r);
    assert.equal(await value("lv"), "Fri, Nov 20");
    // Fields named by the text drawn in the box, gone once they hold a value (a label as the
    // placeholder): filled and checked at once, never waited for by the name that went away.
    const t1 = Date.now();
    r = await run([{ fill: { Nickname: "Riv", "Team name": "Rivera Labs" } }]);
    const tookGone = Date.now() - t1;
    assert.match(r, /^Done: 1 steps/, r);
    assert.deepEqual([await value("nk"), await value("tn")], ["Riv", "Rivera Labs"]);
    t.diagnostic(`fields whose names go away once filled: ${tookGone} ms`);
    assert.ok(tookGone < Math.min(20_000, Math.max(6000, plain)), `fields whose names go away once filled took ${tookGone} ms (four plain picks: ${plain} ms)`);
    // A suggestion picked by the run is the agent's click: never taken for a person's.
    r = await run([{ fill: { "Street address": "500 Howard Ave" } }]);
    assert.equal(await value("ad"), "500 Howard Ave, Burlingame, CA");
    // (Its list opens well below the field: a click there without the agent's cursor would be a person's.)
    const after = r + text(await a.tool("browser_snapshot"));
    assert.doesNotMatch(after, /used this tab|by hand/i, after.split("### Page")[0]);
    // A value a script rewrites 300 ms after the field is left: read again once the page is quiet
    // and named in the run's checks with what it shows now. Fields nothing rewrote aren't named.
    r = await run([{ fill: { "Country of residence": "United States", Vorname: "Alex" } }]);
    assert.match(r, /"Country of residence": the page changed it to "Germany" after it was filled \(it was filled with "United States"\); set it back/, r);
    assert.doesNotMatch(r, /"Vorname": the page changed/, r);
    // A wizard: fill, Next, fill the next step; never its submit.
    r = await run([{ fill: { Company: "Rivera Labs" } }, { click: "Next" }, { fill: { "Team size": "40" } }]);
    assert.match(r, /^Done: 3 steps/, r);
    assert.equal(await value("w2"), "40");
  } finally {
    a?.sock.destroy();
    if (daemon.exitCode === null) { daemon.kill("SIGTERM"); await Promise.race([new Promise((r) => daemon.once("exit", r)), sleep(10_000)]); }
    site.close();
    rmSync(h, { recursive: true, force: true });
  }
});
