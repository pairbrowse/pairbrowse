import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { runSteps, enterButtonLabel } from "../scripts/runner.mjs";
import { inPage } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

// Enter in a checkout field presses its Pay button: no click for the guard to see.
test("Enter that would press a pay or publish button is refused", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<form onsubmit="window.sent=true;return false"><label>Card name <input id="n" autocomplete="cc-name"></label><button>Pay $49 now</button></form>
      <form role="search" onsubmit="window.searched=true;return false"><label>Search <input id="q"></label><button>Search</button></form>`);
    const hooks = { activity: () => {}, status: () => {}, cursor: () => {}, remember: () => {}, secrets: { values: {}, domains: {} } };
    const r = await runSteps(page, [{ fill: { "Card name": "Ada" } }, { press: "Enter" }], hooks);
    assert.equal(r.ok, false);
    assert.match(r.why, /Pay \$49 now.*pay/);
    assert.equal(await inPage(page, () => !!window.sent), false, "not submitted");
    await page.focus("#q");
    assert.equal(await enterButtonLabel(page), "Search");
    const ok = await runSteps(page, [{ press: "Enter" }], hooks);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(await inPage(page, () => !!window.searched), true, "a harmless Enter still works");
  } finally {
    await browser.close();
  }
});

// Date pickers and masks can throw a pasted value away when focus moves on.
test("a field that drops a filled value is retyped, and one that never keeps it is reported", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <label>Date <input id="d"></label>
      <label>Code <input id="c"></label>
      <script>
        const d = document.getElementById("d"); let typed = false;
        d.addEventListener("keyup", () => { typed = true; });
        d.addEventListener("input", () => { typed = false; }, true);
        d.addEventListener("keydown", () => { typed = true; });
        d.addEventListener("blur", () => { if (!typed) d.value = ""; });
        document.getElementById("c").addEventListener("blur", (e) => { e.target.value = "nope"; });
      </script>`);
    const hooks = { activity: () => {}, status: () => {}, cursor: () => {}, remember: () => {}, secrets: { values: {}, domains: {} } };
    const ok = await runSteps(page, [{ fill: { Date: "12/10/2026" } }], hooks);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(await page.inputValue("#d"), "12/10/2026", "kept after retyping");
    const bad = await runSteps(page, [{ fill: { Code: "1234" } }], hooks);
    assert.equal(bad.ok, false);
    assert.match(bad.why, /didn't keep the value "1234" \(it shows "nope"\)/);
  } finally {
    await browser.close();
  }
});

const hooksFor = () => ({ activity: () => {}, status: () => {}, cursor: () => {}, remember: () => {}, secrets: { values: {}, domains: {} } });
async function withPage(html, fn) {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html);
    await fn(page);
  } finally {
    await browser.close();
  }
}

test("keys that press a button are named for what they'd press", async () => {
  const { activatingKey } = await import("../scripts/runner.mjs");
  assert.equal(activatingKey("Enter"), "enter");
  assert.equal(activatingKey("Shift+Enter"), "enter");
  assert.equal(activatingKey("NumpadEnter"), "enter");
  assert.equal(activatingKey("Space"), "space");
  assert.equal(activatingKey(" "), "space");
  assert.equal(activatingKey("Tab"), "");
  assert.equal(activatingKey("a"), "");
});

test("Shift+Enter in a payment form and Space on its focused button are refused; an ordinary form's Enter goes", { skip: !runtime, timeout: 60_000 }, async () => {
  await withPage(`<form onsubmit="window.sent=true;return false"><label>Name <input id="n"></label><input autocomplete="cc-number"><button id="pay">Pay $49</button></form><button id="ok">Next</button>
    <form onsubmit="window.saved=true;return false"><label>Nickname <input id="nick"></label><button>Save</button></form>`, async (page) => {
    const hooks = hooksFor();
    const shift = await runSteps(page, [{ fill: { Name: "Ada" } }, { press: "Shift+Enter" }], hooks);
    assert.equal(shift.ok, false);
    assert.match(shift.why, /Pay \$49.*final action \(pay\)/);
    assert.equal((await runSteps(page, [{ fill: { Nickname: "ada" } }, { press: "Enter" }], hooks)).ok, true, "an ordinary submit goes");
    assert.equal(await inPage(page, () => !!window.saved), true);
    await page.focus("#pay");
    const space = await runSteps(page, [{ press: "Space" }], hooks);
    assert.equal(space.ok, false);
    assert.match(space.why, /Pay \$49/);
    assert.equal(await inPage(page, () => !!window.sent), false, "not submitted");
    await page.focus("#ok");
    assert.equal((await runSteps(page, [{ press: "Space" }], hooks)).ok, true, "Space on a harmless button works");
  });
});

test("a click step that matches a payment form's submit is refused, by structure", { skip: !runtime, timeout: 60_000 }, async () => {
  await withPage(`<form onsubmit="window.paid=true;return false"><input autocomplete="cc-number"><button>Confirm payment</button></form>`, async (page) => {
    const r = await runSteps(page, [{ click: "Confirm" }], hooksFor());
    assert.equal(r.ok, false);
    assert.match(r.why, /Confirm payment.*final action \(pay\)/);
    assert.equal(await inPage(page, () => !!window.paid), false);
  });
});

test("fields named only by the text before them are found, and never guessed", { skip: !runtime, timeout: 60_000 }, async () => {
  await withPage(`
    <nav><span>Email</span><input id="search" placeholder="Search"></nav>
    <form>
      <div class="row"><div>Date of Birth</div><div><input id="dob"></div></div>
      <div>Phone <input id="phone"></div>
      <div>Email</div><input id="email">
      <h3>Contact details</h3><input id="first" name="first">
      <div>Accept</div><input id="cb" type="checkbox">
    </form>`, async (page) => {
    const hooks = hooksFor();
    assert.equal((await runSteps(page, [{ fill: { "Date of Birth": "15 Mar 1990", Phone: "555" } }], hooks)).ok, true);
    assert.equal(await page.inputValue("#dob"), "15 Mar 1990");
    assert.equal(await page.inputValue("#phone"), "555");
    // "Email" sits before two fields (search box and form field): ambiguous, so not filled.
    const amb = await runSteps(page, [{ fill: { Email: "a@b.co" } }], hooks);
    assert.equal(amb.ok, false);
    assert.equal(await page.inputValue("#search"), "");
    // A section heading doesn't name the field under it; a checkbox isn't a text field.
    assert.equal((await runSteps(page, [{ fill: { "Contact details": "x" } }], hooks)).ok, false);
    assert.equal((await runSteps(page, [{ fill: { Accept: "x" } }], hooks)).ok, false);
    const { outline } = await import("../scripts/runner.mjs");
    const text = await outline(page);
    assert.match(text, /Date of Birth \[text\]/);
    assert.match(text, /Phone \[text\]/);
    assert.doesNotMatch(text, /Contact details \[text\]/);
  });
});

test("waitFor also finds a field by its placeholder", { skip: !runtime, timeout: 60_000 }, async () => {
  await withPage(`<input placeholder="Enter your email address…">`, async (page) => {
    assert.equal((await runSteps(page, [{ waitFor: "Enter your email address…" }], hooksFor())).ok, true);
  });
});
