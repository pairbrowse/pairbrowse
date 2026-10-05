import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the page records what the user did, never what they typed", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("playwright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript({ content: source });
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: `<label>Email <input id="e"></label>
      <input id="p" type="password" aria-label="Password"> <button id="b">Sign in</button><div style="height:3000px"></div>` }));
    await page.goto("http://pairbrowse.test/");
    await page.click("#e");
    await page.keyboard.type("me@example.com");
    await page.click("#p");
    await page.keyboard.type("hunter2");
    await page.click("#b");
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(100);
    const events = await page.evaluate(() => window.__pbtest("tok", "", "user"));
    const kinds = events.map((e) => `${e.kind}:${e.what}`);
    assert.ok(kinds.includes("type:Email"), kinds.join(" "));
    assert.ok(kinds.includes("type:a password field"));
    assert.ok(kinds.includes("click:Sign in"));
    assert.ok(kinds.some((k) => k.startsWith("wheel")));
    assert.doesNotMatch(JSON.stringify(events), /me@example|hunter2/, "never what was typed");
    assert.equal(await page.evaluate(() => window.__pbtest("nope", "", "user")), false, "pages without the token get nothing");
    assert.deepEqual(await page.evaluate(() => window.__pbtest("tok", "", "user")), [], "drained");
  } finally {
    await browser.close();
  }
});

test("a page finds no fixed PairBrowse name, attribute or window property, and the bar still shows", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("playwright");
  const { hudScript } = await import("../scripts/browser.mjs");
  const hud = hudScript();
  const other = hudScript();
  assert.notEqual(hud.tags.bar, other.tags.bar, "new names each start");
  assert.notEqual(hud.name, other.name);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript({ content: hud.source });
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: `<link rel="icon" href="data:,"><style>*{position:static!important;display:block}</style><h1>Shop</h1>` }));
    await page.goto("http://pairbrowse.test/");
    await page.evaluate(([n, t]) => { window[n](t, JSON.stringify({ items: [{ t: Date.now(), text: "Clicked Next", who: "Claude" }] }), "bar"); window[n](t, "Your turn", "you"); window[n](t, "#e9763f", "spark"); window[n](t, JSON.stringify({ x: 10, y: 10, act: "click" }), "cursor"); }, [hud.name, hud.token]);
    await page.waitForTimeout(100);
    const seen = await page.evaluate(() => {
      const all = [...document.querySelectorAll("*")];
      return {
        tags: all.map((e) => e.localName).filter((t) => t.includes("pairbrowse") || t.startsWith("pb-")),
        custom: all.filter((e) => e.localName.includes("-")).map((e) => ({ tag: e.localName, attrs: e.getAttributeNames() })),
        props: Object.getOwnPropertyNames(window).filter((k) => /^__pb/i.test(k) || /pairbrowse/i.test(k)),
        linkAttrs: [...document.querySelectorAll("link")].flatMap((l) => l.getAttributeNames()),
        text: document.documentElement.innerText,
      };
    });
    assert.deepEqual(seen.tags, []);
    assert.deepEqual(seen.props, []);
    assert.ok(seen.custom.length >= 2, "bar and badge are there");
    for (const c of seen.custom) assert.deepEqual(c.attrs, [], `${c.tag} has no attributes`);
    assert.ok(!seen.linkAttrs.some((a) => a.startsWith("data-")), seen.linkAttrs.join(","));
    assert.doesNotMatch(seen.text, /Clicked Next|Your turn/, "nothing readable from outside");
    // A page's own CSS can't move or hide it.
    const box = await page.evaluate((tag) => { const r = document.querySelector(tag).getBoundingClientRect(); return { h: r.height, bottom: Math.round(r.bottom), pos: getComputedStyle(document.querySelector(tag)).position }; }, hud.tags.bar);
    assert.ok(box.h > 0);
    assert.equal(box.pos, "fixed");
    assert.equal(box.bottom, await page.evaluate(() => innerHeight));
    // And Claude's own snapshot doesn't see it either.
    const snap = await page.locator("html").ariaSnapshot();
    assert.doesNotMatch(snap, /Clicked Next|Your turn/);
  } finally {
    await browser.close();
  }
});

test("fields people edit are known as theirs; the bar's Pause button is a person's and never page input", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("playwright");
  const { readFields, applyFields } = await import("../scripts/daemon/forms.mjs");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const key = ["__pbtest", "tok"];
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.addInitScript({ content: source });
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: `<label>Notes <input id="e"></label><label>Name <input id="n"></label>` }));
    await page.goto("http://pairbrowse.test/");
    await page.click("#e");
    await page.keyboard.type("hello");
    const owned = await page.locator("#e").evaluate((el) => window.__pbtest("tok", el, "owned"));
    assert.ok(owned.times.length >= 1 && owned.focused && owned.name === "Notes", JSON.stringify(owned));
    assert.equal((await page.locator("#n").evaluate((el) => window.__pbtest("tok", el, "owned"))).times.length, 0);
    const read = await readFields(page, [], key);
    assert.ok(read.fields.find((f) => f.k === "#e").own.times.length >= 1, "read with the fields");
    await applyFields(page, [{ f: "top", k: "#n", t: "text", v: "Carol C", o: "Carol" }], "Carol", [], key);
    const claimed = await page.locator("#n").evaluate((el) => window.__pbtest("tok", el, "owned"));
    assert.equal(claimed.rw, "Carol", "filled by a person there: theirs here too");
    const told = await page.evaluate(() => window.__pbtest("tok", "", "user"));
    assert.ok(told.some((e) => e.kind === "filled" && e.who === "Carol" && e.what === "Name"), JSON.stringify(told));
    assert.equal(await page.inputValue("#n"), "Carol C");

    await page.evaluate(() => window.__pbtest("tok", "", "user")); // drained
    await page.evaluate(() => window.__pbtest("tok", JSON.stringify({ items: [], canPause: true, pause: null }), "bar"));
    await page.mouse.click(800 - 50, 600 - 15);
    await page.waitForTimeout(100);
    let events = await page.evaluate(() => window.__pbtest("tok", "", "user"));
    assert.deepEqual(events.filter((e) => e.kind !== "move").map((e) => e.kind), ["pause"], JSON.stringify(events));
    assert.equal(await page.evaluate(() => document.activeElement.id), "e", "the button never takes focus from the field");
    await page.evaluate(() => window.__pbtest("tok", JSON.stringify({ items: [], canPause: true, pause: { by: "Alice" } }), "bar"));
    await page.mouse.click(800 - 40, 600 - 15);
    await page.waitForTimeout(100);
    events = await page.evaluate(() => window.__pbtest("tok", "", "user"));
    assert.deepEqual(events.filter((e) => e.kind !== "move").map((e) => e.kind), ["resume"]);
    await page.evaluate(() => window.__pbtest("tok", JSON.stringify({ items: [], canPause: false, pause: { by: "Alice" } }), "bar"));
    await page.mouse.click(800 - 40, 600 - 15);
    await page.waitForTimeout(100);
    events = await page.evaluate(() => window.__pbtest("tok", "", "user"));
    assert.ok(!events.some((e) => e.kind === "pause" || e.kind === "resume"), "a watcher has no button");
  } finally {
    await browser.close();
  }
});

test("a person from the other browser shows as a dot on the tab's icon, in the corner of any agent's spark", async () => {
  const { createHud } = await import("../scripts/daemon/hud.mjs");
  const icons = [];
  const page = { isClosed: () => false, url: () => "https://example.com/", evaluate: async (fn, args) => { if (args?.[3] === "spark") icons.push(args[2]); } };
  const hud = createHud({ pages: async () => [page], participants: () => ["a"], waiting: () => null, liveView: () => null, notify: () => {} });
  hud.setPersonMark(page, "#38bdf8");
  assert.equal(hud.tabIcon(page), "o#38bdf8");
  assert.deepEqual(icons, ["o#38bdf8"]);
  hud.setPersonMark(page, "#38bdf8"); // said again while they're there: nothing new
  assert.equal(icons.length, 1);
  // An agent from the other browser comes in: its spark, with the dot; when it goes, the dot alone.
  hud.setSharedSpark(page, "#4fd1e8");
  hud.setSharedSpark(page, "");
  // An agent here: its spark over the other one's.
  await hud.moveSpark("a", page);
  hud.setPersonMark(page, "");
  await hud.moveSpark("a", null);
  assert.deepEqual(icons, ["o#38bdf8", "#4fd1e8 o#38bdf8", "o#38bdf8", "#e9763f o#38bdf8", "#e9763f", ""]);
  hud.setPersonMark(page, "not a color");
  assert.equal(hud.tabIcon(page), "");
});
