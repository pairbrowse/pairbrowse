import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ensureHud } from "./live.mjs";

const runtime = process.env.PAIRBROWSE_TEST_RUNTIME;

test("the page records what the user did, never what they typed", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript({ content: source });
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: `<label>Email <input id="e"></label>
      <input id="p" type="password" aria-label="Password"> <button id="b">Sign in</button><div style="height:3000px"></div>` }));
    await page.goto("http://pairbrowse.test/");
    await ensureHud(page, source, "__pbtest");
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
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
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
    await ensureHud(page, hud.source, hud.name);
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
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
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
    await ensureHud(page, source, "__pbtest");
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

test("the agent cursor moves like a hand, lands exactly on the target and rings once there", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
    // Test only: open shadow roots, so the test can read where the cursor is drawn each frame. In
    // the script world the page script runs in (see ensureHud), before it starts.
    const openShadows = () => {
      const real = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (o) { return real.call(this, { ...o, mode: "open" }); };
      window.trail = [];
      const loop = () => {
        for (const el of document.documentElement?.children || []) {
          const c = el.shadowRoot?.querySelector(".c");
          const m = c && /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(c.style.transform);
          if (m) window.trail.push({ t: performance.now(), x: +m[1], y: +m[2], click: c.classList.contains("click") });
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    };
    await page.addInitScript({ content: hud.source });
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: "<p>Page</p>" }));
    await page.goto("http://pairbrowse.test/");
    await page.evaluate(openShadows);
    await ensureHud(page, hud.source, hud.name);
    const point = (c) => page.evaluate(([n, t, v]) => window[n](t, v, "cursor"), [hud.name, hud.token, JSON.stringify(c)]);
    await point({ x: 100, y: 500 });
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.trail = []; });
    const { ms } = await point({ x: 850, y: 140, act: "click", w: 20 });
    assert.ok(ms >= 120 && ms <= 350, `says how long it takes to arrive (${ms} ms)`);
    await page.waitForTimeout(ms + 100);
    await page.mouse.click(850, 140);
    await page.waitForTimeout(100);
    const trail = await page.evaluate(() => window.trail);
    const moving = trail.filter((p) => !(p.x === 850 && p.y === 140));
    assert.ok(moving.length >= 5, `it moves over several frames (${moving.length})`);
    assert.ok(moving.some((p) => p.x > 300 && p.x < 650), "passes through the middle");
    const end = trail.at(-1);
    assert.deepEqual([end.x, end.y, end.click], [850, 140, true], "lands exactly and rings on the press");
    const arrived = trail.findIndex((p) => p.x === 850 && p.y === 140);
    assert.ok(trail.slice(arrived).every((p) => p.x === 850 && p.y === 140), "stays once there");
    const took = trail[arrived].t - trail[0].t;
    assert.ok(took > 80 && took < 450, `takes a moment, not long (${took.toFixed(0)} ms)`);

    // Actions one after another, the press at any point inside the target (a humanized click picks
    // its own) and at any time (before the cursor arrives too): at every press the drawn cursor is
    // exactly at the press, never beside it or still on the previous target.
    await page.evaluate(() => {
      window.presses = [];
      addEventListener("pointerdown", (e) => {
        for (const el of document.documentElement.children) {
          const m = el.shadowRoot && /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.shadowRoot.querySelector(".c")?.style.transform || "");
          if (m) window.presses.push({ x: e.clientX, y: e.clientY, cx: +m[1], cy: +m[2] });
        }
      }, true);
    });
    let seed = 7;
    const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 60; i++) {
      const box = { x: r() * 940, y: r() * 600, width: 6 + r() * 54, height: 6 + r() * 34 };
      await point({ x: box.x + box.width / 2, y: box.y + box.height / 2, act: "click", w: Math.min(box.width, box.height) });
      const wait = [0, 0, 30, 120, 400][i % 5];
      if (wait) await page.waitForTimeout(wait);
      await page.mouse.click(Math.round((box.x + r() * box.width) * 4) / 4, Math.round((box.y + r() * box.height) * 4) / 4);
    }
    await page.waitForTimeout(500);
    const presses = await page.evaluate(() => window.presses);
    assert.equal(presses.length, 60);
    const off = presses.map((p) => Math.hypot(p.x - p.cx, p.y - p.cy));
    assert.equal(Math.max(...off), 0, `drawn at the press every time (worst ${Math.max(...off)} px)`);
    const last = (await page.evaluate(() => window.trail)).at(-1);
    assert.deepEqual([last.x, last.y], [presses.at(-1).x, presses.at(-1).y], "and stays there after");

    // With its name, it stays up while the agent waits its turn between actions (seconds), and
    // goes once the agent is done.
    const shown = () => page.evaluate(() => [...document.documentElement.children].some((el) => el.shadowRoot?.querySelector(".c.on span")?.textContent === "Claude (Mac)"));
    await point({ x: 300, y: 300, act: "click", who: "Claude (Mac)" });
    await page.waitForTimeout(6000);
    assert.ok(await shown(), "the cursor and its name stay between actions");
    await page.evaluate(([n, t]) => window[n](t, "", "cursor-off"), [hud.name, hud.token]);
    assert.ok(!(await shown()), "and go when the agent is done");
  } finally {
    await browser.close();
  }
});

test("an agent's cursor still goes out when a busy computer is slow to say where the element is", async () => {
  const { createHud } = await import("../scripts/daemon/hud.mjs");
  const sent = [];
  const page = { isClosed: () => false, url: () => "https://example.com/", evaluate: async (fn, args) => { if (args?.[3] === "cursor") { const c = JSON.parse(args[2]); sent.push(c); return { ms: 0, at: { x: c.x, y: c.y, t: Date.now() } }; } } };
  const hud = createHud({ pages: async () => [page], participants: () => ["a"], waiting: () => null, liveView: () => null, notify: () => {} });
  const pointed = [];
  hud.onCursor((p, at) => pointed.push(at));
  const slow = (x, ms) => ({ boundingBox: () => new Promise((r) => setTimeout(() => r({ x, y: 10, width: 20, height: 20 }), ms)) });
  // The cursor is sent at once (a late box: once known); the press declaration waits for the box
  // (bounded), so the press that follows is known as the agent's.
  const t0 = Date.now();
  await hud.cursorTo(page, slow(100, 700), "click");
  const took = Date.now() - t0;
  assert.ok(took >= 650 && took < 1400, `waits for the box to declare the press, not longer (${took} ms)`);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(sent.map((c) => c.x), [110]);
  assert.equal(pointed.length, 1);
  // A box later than even the press declaration waits (the agent has already left for the next
  // element): the newer cursor stands.
  const t1 = Date.now();
  await hud.cursorTo(page, slow(300, 2200), "click");
  assert.ok(Date.now() - t1 < 1800, `the press declaration's wait for the box is bounded (${Date.now() - t1} ms)`);
  await hud.cursorTo(page, slow(500, 0), "click");
  await new Promise((r) => setTimeout(r, 900));
  assert.deepEqual(sent.map((c) => c.x), [110, 510]);
});

test("what PairBrowse is about to press is declared to the page first, and presence hears of it; a page that never answers holds the press up only briefly", async () => {
  const { createHud } = await import("../scripts/daemon/hud.mjs");
  const sent = []; // "press" messages the page took
  let answer = async (list) => { sent.push(list); return true; };
  const page = { isClosed: () => false, url: () => "https://example.com/", evaluate: async (fn, args) => (args?.[3] === "press" ? answer(JSON.parse(args[2])) : args?.[3] === "cursor" ? { ms: 0 } : undefined) };
  const hud = createHud({ pages: async () => [page], participants: () => ["a"], waiting: () => null, liveView: () => null, notify: () => {} });
  const heard = [];
  hud.onPress((p, at) => heard.push(at));
  const el = (box) => ({ boundingBox: async () => box });
  // An element's box: the page has it before the call resolves; presence hears its center and size.
  assert.equal(await hud.pressOn(page, el({ x: 100, y: 200, width: 80, height: 30 })), true);
  assert.deepEqual(sent, [[{ x: 100, y: 200, w: 80, h: 30 }]]);
  assert.deepEqual(heard.map(({ t, ...a }) => a), [{ x: 140, y: 215, w: 80, h: 30, press: true }]);
  // A spot (pairbrowse_click_at, a drawing step): a box with no size.
  await hud.pressOn(page, el({ x: 5, y: 7, width: 0, height: 0 }));
  assert.deepEqual(sent.at(-1), [{ x: 5, y: 7, w: 0, h: 0 }]);
  // The cursor's own path (fast mode, click_at) declares the press as well.
  await hud.cursorTo(page, el({ x: 10, y: 10, width: 20, height: 20 }), "click");
  assert.deepEqual(sent.at(-1), [{ x: 10, y: 10, w: 20, h: 20 }]);
  // No box (the element is gone): nothing declared, nothing waited for.
  assert.equal(await hud.pressOn(page, { boundingBox: async () => null }), false);
  assert.equal(sent.length, 3);
  // A page that never answers: the press goes on after a bounded wait.
  answer = () => new Promise(() => {});
  const t0 = Date.now();
  assert.equal(await hud.pressOn(page, el({ x: 1, y: 1, width: 1, height: 1 })), false);
  const took = Date.now() - t0;
  assert.ok(took >= 900 && took < 1500, `bounded wait (${took} ms)`);
});

test("the page takes a declared press: a trusted press inside the box is the agent's (not far), one outside every declared box is a person's", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: `<body style="margin:0;height:3000px"><button id="ok" style="position:absolute;left:100px;top:1200px;width:300px;height:60px">Accept all</button><button id="x" style="position:absolute;left:800px;top:1300px;width:40px;height:40px">Close</button></body>` }));
    await page.goto("http://pairbrowse.test/");
    await ensureHud(page, source, "__pbtest");
    const user = () => page.evaluate(() => window.__pbtest("tok", "", "user").filter((e) => e.kind !== "move")); // presses, not the pointer's moves
    const send = (kind, v) => page.evaluate(([v, k]) => window.__pbtest("tok", JSON.stringify(v), k), [v, kind]);
    // No cursor was ever shown here (the popup closer sends none): the press is declared alone,
    // scrolled into view first, as the helper measures it (viewport pixels).
    await page.evaluate(() => scrollTo(0, 1000));
    const ok = await page.locator("#ok").boundingBox();
    assert.equal(await send("press", [{ x: ok.x, y: ok.y, w: ok.width, h: ok.height }]), true);
    // The page scrolls on before the press lands (the click brings its button into view): the
    // declared box stays put in the document.
    await page.evaluate(() => scrollTo(0, 1100));
    await page.mouse.click(ok.x + ok.width - 5, ok.y + ok.height - 5 - 100); // the far corner, a humanized click's own spot
    await page.mouse.click(ok.x + 2, ok.y + 2 - 100);
    let events = await user();
    assert.deepEqual(events.map((e) => [e.kind, e.what, e.far === true]), [["click", "Accept all", false], ["click", "Accept all", false]]);
    // A press outside every declared box while one is declared: a person's, and where it was is told.
    const x = await page.locator("#x").boundingBox();
    await page.mouse.click(x.x + 20, x.y + 20);
    events = await user();
    assert.equal(events.length, 1);
    assert.equal(events[0].far, true);
    assert.deepEqual([events[0].x, events[0].y], [Math.round(x.x + 20), Math.round(x.y + 20 + 1100)]);
    // The declaration holds for a while (a humanized press takes its time): a press on it after
    // the person's is still the agent's.
    await page.mouse.click(ok.x + 150, ok.y + 30 - 100);
    events = await user();
    assert.deepEqual(events.map((e) => [e.what, e.far === true]), [["Accept all", false]]);
  } finally {
    await browser.close();
  }
});

test("the bar in a tab shows what was done in that tab, not another agent's work elsewhere; news about no tab shows everywhere", async () => {
  const { createHud } = await import("../scripts/daemon/hud.mjs");
  const bars = new Map(); // page -> last bar items' texts
  const fake = (name) => ({ name, isClosed: () => false, url: () => `https://example.com/${name}`, evaluate: async (fn, args) => { if (args?.[3] === "bar") bars.set(name, JSON.parse(args[2]).items.map((i) => i.text)); } });
  const a = fake("a"), b = fake("b");
  const hud = createHud({ pages: async () => [a, b], participants: () => ["x", "y"], waiting: () => null, liveView: () => null, notify: () => {} });
  hud.addActivity("Clicked **Buy**", "Alice · Claude Code", a);
  hud.addActivity("Typed `hi` into **Search**", "Bob · Codex", b);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(bars.get("a"), ["Clicked **Buy**"]);
  assert.deepEqual(bars.get("b"), ["Typed `hi` into **Search**"]);
  hud.addActivity("Joined Sam's session (drive)", "", null, "joined");
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(bars.get("a"), ["Clicked **Buy**", "Joined Sam's session (drive)"]);
  assert.deepEqual(bars.get("b"), ["Typed `hi` into **Search**", "Joined Sam's session (drive)"]);
  // A tab keeps only its last few, newest last.
  for (let i = 0; i < 6; i++) hud.addActivity(`Step ${i}`, "Alice · Claude Code", a);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(bars.get("a"), ["Step 2", "Step 3", "Step 4", "Step 5"]);
  assert.equal(hud.lastIn(a).text, "Step 5");
  // The bar drawn afresh (a page load) shows the same.
  await hud.applyBar(b);
  assert.deepEqual(bars.get("b"), ["Typed `hi` into **Search**", "Joined Sam's session (drive)"]);
});

test("a shared tab's bar says Reconnecting to the host while its connection moves, then who's driving again", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Shop</h1>" }));
    await page.goto("http://pairbrowse.test/");
    // The bar's shadow root is closed; the test opens it (in the world the script runs in) to read the who-line.
    await page.evaluate(() => { const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { return a.call(this, { ...i, mode: "open" }); }; });
    await ensureHud(page, source, "__pbtest");
    const whoLine = () => page.evaluate((tag) => document.querySelector(tag).shadowRoot.querySelector(".who span").textContent, hud.tags.bar);
    const items = [{ t: Date.now(), text: "Clicked Next", who: "Bob" }];
    await page.evaluate((v) => window.__pbtest("tok", JSON.stringify(v), "bar"), { items, reconnecting: "Bob" });
    assert.equal(await whoLine(), "Reconnecting to Bob…");
    await page.evaluate((v) => window.__pbtest("tok", JSON.stringify(v), "bar"), { items });
    assert.equal(await whoLine(), "Bob's Claude is driving", "back to normal once the channel is up");
    await page.evaluate((v) => window.__pbtest("tok", JSON.stringify(v), "bar"), { items, reconnecting: "Bob", pause: { by: "Alice" }, canPause: true });
    assert.match(await whoLine(), /^Paused by Alice/, "a pause still shows (it carries the button)");
  } finally {
    await browser.close();
  }
});

test("the helper marks only the shared tabs as reconnecting, and clears them when the channel is back", async () => {
  const { createHud } = await import("../scripts/daemon/hud.mjs");
  const bars = new Map(); // page -> last bar state
  const fake = (name) => ({ name, isClosed: () => false, url: () => `https://example.com/${name}`, evaluate: async (fn, args) => { if (args?.[3] === "bar") bars.set(name, JSON.parse(args[2])); } });
  const shared = fake("shared"), own = fake("own");
  const hud = createHud({ pages: async () => [shared, own], participants: () => [], waiting: () => null, liveView: () => null, notify: () => {} });
  hud.setReconnecting("Bob", [shared]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bars.get("shared").reconnecting, "Bob");
  assert.equal(bars.get("own"), undefined, "this browser's own tabs hear nothing");
  await hud.applyBar(own);
  assert.equal("reconnecting" in bars.get("own"), false);
  hud.setReconnecting("", [shared]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal("reconnecting" in bars.get("shared"), false, "cleared once the channel is up");
});

// The helper waits on the page for input ("user-wait") instead of asking twice a second: the wait
// answers the moment a person does something, empty after its time, and never two at once.
test("the page answers a wait for input at once when something happens, empty after its time", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addInitScript({ content: source });
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: `<button id="b">Go</button><iframe id="f" srcdoc="<input id='q' aria-label='Code'>"></iframe>` }));
    await page.goto("http://pairbrowse.test/");
    await ensureHud(page, source, "__pbtest");
    // Empty after its time, without input.
    let t = Date.now();
    assert.deepEqual(await page.evaluate(() => window.__pbtest("tok", "300", "user-wait")), []);
    assert.ok(Date.now() - t >= 250, `waited its time: ${Date.now() - t} ms`);
    // Answered at once by a click (the pointer's move to the button answers a wait too: then the
    // next wait brings the click).
    t = Date.now();
    const waiting = page.evaluate(() => window.__pbtest("tok", "5000", "user-wait"));
    await page.waitForTimeout(100);
    await page.click("#b");
    const events = await waiting;
    for (let i = 0; i < 3 && !events.some((e) => e.kind === "click"); i++) events.push(...await page.evaluate(() => window.__pbtest("tok", "5000", "user-wait")));
    assert.ok(Date.now() - t < 2000, `answered at the click, not after 5 s: ${Date.now() - t} ms`);
    assert.ok(events.some((e) => e.kind === "click" && e.what === "Go"), JSON.stringify(events));
    // What was recorded before a wait opens comes back at once.
    await page.click("#b");
    await page.waitForTimeout(50);
    t = Date.now();
    const quick = await page.evaluate(() => window.__pbtest("tok", "5000", "user-wait"));
    assert.ok(quick.some((e) => e.kind === "click"), "the click from before");
    assert.ok(Date.now() - t < 500, `no wait with input already there: ${Date.now() - t} ms`);
    // A second wait ends the first (empty), so a frame never holds two.
    const first = page.evaluate(() => window.__pbtest("tok", "5000", "user-wait"));
    await page.waitForTimeout(50);
    const second = page.evaluate(() => window.__pbtest("tok", "300", "user-wait"));
    assert.deepEqual(await first, [], "the earlier wait ends empty");
    assert.deepEqual(await second, []);
    // Frames wait too.
    const frame = page.frames().find((f) => f !== page.mainFrame());
    await ensureHud(frame, source, "__pbtest");
    const inFrame = frame.evaluate(() => window.__pbtest("tok", "5000", "user-wait"));
    await page.waitForTimeout(100);
    await frame.click("#q");
    await frame.type("#q", "1");
    const fe = await inFrame;
    for (let i = 0; i < 3 && !fe.some((e) => e.kind === "type"); i++) fe.push(...await frame.evaluate(() => window.__pbtest("tok", "5000", "user-wait")));
    assert.ok(fe.some((e) => e.kind === "type" && e.what === "Code"), JSON.stringify(fe));
  } finally {
    await browser.close();
  }
});
