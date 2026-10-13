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
  const hud = createHud({ pages: async () => [page], participants: () => ["a"], labelOf: (id) => ({ a: "Claude a" })[id] || "", waiting: () => null, liveView: () => null, notify: () => {} });
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

test("the helper puts recording on every page's bar only while the recorder runs", async () => {
  const { createHud } = await import("../scripts/daemon/hud.mjs");
  const bars = new Map(); // page -> last bar state
  let sent = 0;
  const fake = (name) => ({ name, isClosed: () => false, url: () => `https://example.com/${name}`, evaluate: async (fn, args) => { if (args?.[3] === "bar") { sent++; bars.set(name, JSON.parse(args[2])); } } });
  const a = fake("a"), b = fake("b");
  const hud = createHud({ pages: async () => [a, b], participants: () => [], waiting: () => null, liveView: () => null, notify: () => {} });
  await hud.setRecording(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bars.get("a").recording, true);
  assert.equal(bars.get("b").recording, true);
  assert.equal(sent, 2, "one bar per page");
  await hud.setRecording(true);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent, 2, "unchanged: nothing sent");
  await hud.setRecording(false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal("recording" in bars.get("a"), false, "off: the key is gone");
  assert.equal("recording" in bars.get("b"), false);
  assert.equal(sent, 4);
  await hud.setRecording(false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent, 4, "a repeated off sends nothing more");
});

test("the bar shows a REC pill while recording and takes it down after", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Shop</h1>" }));
    await page.goto("http://pairbrowse.test/");
    await page.evaluate(() => { const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { return a.call(this, { ...i, mode: "open" }); }; });
    await ensureHud(page, source, "__pbtest");
    const read = () => page.evaluate((tag) => {
      const root = document.querySelector(tag).shadowRoot, rec = root.querySelector(".who .rec");
      return { who: root.querySelector(".who span").textContent, hidden: rec.hidden, text: rec.textContent, display: getComputedStyle(rec).display, dot: getComputedStyle(rec.querySelector("i")).backgroundColor, pz: root.querySelector(".pz").textContent };
    }, hud.tags.bar);
    const send = (v) => page.evaluate((v) => window.__pbtest("tok", JSON.stringify(v), "bar"), v);
    const items = [{ t: Date.now(), text: "Clicked Next", who: "Bob" }];
    await send({ items, recording: true });
    let r = await read();
    assert.equal(r.who, "Bob's Claude is driving", "the who-line is unchanged");
    assert.equal(r.hidden, false);
    assert.equal(r.text, "REC");
    assert.equal(r.display, "flex", "shown (inline-flex, blockified as an item of the flex who-line)");
    assert.equal(r.dot, "rgb(239, 100, 104)", "the dot is the sheet's --bad");
    await send({ items });
    r = await read();
    assert.equal(r.hidden, true, "no recording: no pill");
    assert.equal(r.display, "none");
    await send({ items, recording: true, pause: { by: "Alice" }, canPause: true });
    r = await read();
    assert.match(r.who, /^Paused by Alice/);
    assert.equal(r.pz, "Resume");
    assert.equal(r.hidden, false, "a pause keeps the pill");
  } finally {
    await browser.close();
  }
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

// The test opens the closed shadow roots (in the world the page script runs in) to read them.
const openShadows = () => { const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { return a.call(this, { ...i, mode: "open" }); }; };

test("the bar's chips carry the bar's own state: done, the newest while driving, a failure", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Shop</h1>" }));
    await page.goto("http://pairbrowse.test/");
    await page.evaluate(openShadows);
    await ensureHud(page, source, "__pbtest");
    const now = Date.now();
    const items = [{ t: now - 20000, text: "Typed `a` into **B**", who: "" }, { t: now - 15000, text: "That didn't work: x", who: "" }, { t: now - 300, text: "Clicked **Next**", who: "" }];
    await page.evaluate((v) => window.__pbtest("tok", JSON.stringify(v), "bar"), { items });
    const read = () => page.evaluate((tag) => {
      const root = document.querySelector(tag).shadowRoot;
      return {
        chips: [...root.querySelectorAll("li")].map((li) => ({ cls: li.className, text: li.querySelector("span").textContent, g: !!li.querySelector(".g svg"), time: /^\d\d:\d\d/.test(li.getAttribute("title") || "") })),
        dot: getComputedStyle(root.querySelector(".who .dot")).backgroundColor,
      };
    }, hud.tags.bar);
    let r = await read();
    assert.deepEqual(r.chips.map((c) => c.cls), ["chip done", "chip bad", "chip now"]);
    assert.deepEqual(r.chips.map((c) => c.text), ["Typed a into B", "That didn't work: x", "Clicked Next"], "oldest to newest");
    assert.ok(r.chips.every((c) => c.g && c.time), "each chip has its glyph, and its time as a title");
    assert.equal(r.dot, "rgb(233, 118, 63)", "the driver dot is orange with no spark set");
    // Paused by a person: nothing is under way, whatever the newest line's age.
    await page.evaluate((v) => window.__pbtest("tok", JSON.stringify(v), "bar"), { items, pause: { by: "Alice" }, canPause: true });
    r = await read();
    assert.deepEqual(r.chips.map((c) => c.cls), ["chip done", "chip bad", "chip done"], "no 'now' chip while paused");
    await page.evaluate((v) => window.__pbtest("tok", JSON.stringify(v), "bar"), { items });
    await page.evaluate(() => window.__pbtest("tok", "#4fd1e8", "spark"));
    r = await read();
    assert.equal(r.dot, "rgb(79, 209, 232)", "the tab's spark color");
  } finally {
    await browser.close();
  }
});

test("the badge's left edge is the agent's color, accent for Your turn, ok for Done; a plain string still works", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Shop</h1>" }));
    await page.goto("http://pairbrowse.test/");
    await page.evaluate(openShadows);
    await ensureHud(page, source, "__pbtest");
    const badge = (text, kind) => page.evaluate(([v, k, tag]) => {
      window.__pbtest("tok", v, k);
      const host = document.querySelector(tag);
      if (!host) return null;
      const b = host.shadowRoot.querySelector(".b");
      return { edge: getComputedStyle(b).borderLeftColor, text: b.querySelector("span").textContent };
    }, [text, kind, hud.tags.hud]);
    assert.deepEqual(await badge({ text: "filling", color: "#a78bfa" }, "claude"), { edge: "rgb(167, 139, 250)", text: "Claude: filling" });
    assert.deepEqual(await badge("Your turn", "you"), { edge: "rgb(50, 133, 246)", text: "Your turn: Your turn" });
    assert.deepEqual(await badge("done", "done"), { edge: "rgb(32, 201, 151)", text: "Done: done" });
    assert.equal((await badge("plain", "claude")).edge, "rgb(233, 118, 63)", "no color: Claude's orange");
    assert.equal(await badge("", "clear"), null, "cleared: the badge is gone");
  } finally {
    await browser.close();
  }
});

test("the helper sends the participant's spark color with its status", async () => {
  const { createHud } = await import("../scripts/daemon/hud.mjs");
  const calls = [];
  const page = { isClosed: () => false, url: () => "https://example.com/", evaluate: async (fn, args) => { if (!["bar", "spark"].includes(args?.[3])) calls.push(args); } };
  const statuses = [];
  const hud = createHud({ pages: async () => [page], participants: () => ["a", "b"], labelOf: (id) => ({ a: "Alice · Claude Code", b: "Bob · Codex" })[id] || "", waiting: () => null, liveView: () => ({ setStatus: (s) => statuses.push(s) }), notify: () => {} });
  await hud.setBadgeFor("b", "typing", "claude", "Bob · Codex");
  assert.deepEqual(calls.at(-1)[2], { text: "Codex: typing", color: "#9b7bfa" });
  assert.equal(calls.at(-1)[3], "agent");
  assert.equal(statuses.at(-1).text, "Codex: typing", "the live view reads text and kind as before");
  await hud.setBadge("Solve it", "you");
  assert.equal(calls.at(-1)[2], "Solve it", "PairBrowse's own status stays a plain string");
  assert.equal(calls.at(-1)[3], "you");
});

test("the field the agent acts on is outlined in its color inside the cursor's shadow root, follows scrolling and goes when the agent is done", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: `<body style="margin:0;height:3000px"><input id="i" style="position:absolute;left:100px;top:300px;width:240px;height:40px;box-sizing:border-box"><button id="b" style="position:absolute;left:100px;top:420px;width:120px;height:36px">Next</button></body>` }));
    await page.goto("http://pairbrowse.test/");
    await page.evaluate(openShadows);
    await ensureHud(page, source, "__pbtest");
    const before = await page.evaluate(() => document.documentElement.children.length);
    const send = (kind, v) => page.evaluate(([v, k]) => window.__pbtest("tok", typeof v === "string" ? v : JSON.stringify(v), k), [v, kind]);
    const outline = () => page.evaluate((tag) => {
      for (const el of document.querySelectorAll(tag)) {
        const f = el.shadowRoot?.querySelector(".f");
        if (!f) continue;
        const r = f.getBoundingClientRect(), cs = getComputedStyle(f);
        const span = el.shadowRoot.querySelector(".c span");
        return { on: f.classList.contains("on"), x: r.x, y: r.y, w: r.width, h: r.height, border: cs.borderTopColor, ink: getComputedStyle(span).color, fill: el.shadowRoot.querySelector(".c path").getAttribute("fill"), edge: el.shadowRoot.querySelector(".c path").getAttribute("stroke") };
      }
      return null;
    }, hud.tags.cursor);
    const near = (a, b) => Math.abs(a - b) <= 1;
    await send("cursor", { x: 220, y: 320, act: "type", who: "Codex", color: "#a78bfa", w: 40, bw: 240, bh: 40 });
    let o = await outline();
    assert.ok(o.on && near(o.x, 100) && near(o.y, 300) && near(o.w, 240) && near(o.h, 40), `around the field: ${JSON.stringify(o)}`);
    assert.equal(o.border, "rgb(167, 139, 250)");
    assert.equal(o.ink, "rgb(11, 20, 33)", "dark ink on the pill");
    assert.equal(o.fill, "#fff", "a white pointer"); assert.equal(o.edge, "#a78bfa", "edged in the agent's color");
    await page.evaluate(() => scrollTo(0, 200));
    await page.waitForTimeout(100);
    o = await outline();
    assert.ok(near(o.y, 100), `moves with the page: ${o.y}`);
    const b = await page.locator("#b").boundingBox();
    await send("press", [{ x: b.x, y: b.y, w: b.width, h: b.height }]);
    o = await outline();
    assert.ok(o.on && near(o.x, b.x) && near(o.y, b.y) && near(o.w, b.width) && near(o.h, b.height), `on the declared press: ${JSON.stringify(o)}`);
    assert.equal(await page.evaluate(() => document.documentElement.children.length), before + 1, "the cursor's element only");
    const attrs = await page.evaluate((tag) => [...document.querySelectorAll(tag)].flatMap((e) => e.getAttributeNames()), hud.tags.cursor);
    assert.deepEqual(attrs, []);
    await send("cursor-off", "");
    assert.equal((await outline()).on, false, "goes when the agent is done");
  } finally {
    await browser.close();
  }
});

test("with reduced motion the cursor jumps and the click leaves a static dot", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ reducedMotion: "reduce", viewport: { width: 1000, height: 640 } });
    const page = await context.newPage();
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: "<p>Page</p>" }));
    await page.goto("http://pairbrowse.test/");
    await page.evaluate(() => {
      const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { return a.call(this, { ...i, mode: "open" }); };
      window.trail = [];
      const loop = () => {
        for (const el of document.documentElement?.children || []) {
          const m = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(el.shadowRoot?.querySelector(".c")?.style.transform || "");
          if (m) window.trail.push({ x: +m[1], y: +m[2] });
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    await ensureHud(page, source, "__pbtest");
    const point = (c) => page.evaluate((v) => window.__pbtest("tok", v, "cursor"), JSON.stringify(c));
    await point({ x: 100, y: 500 });
    await page.waitForTimeout(150);
    const { ms } = await point({ x: 850, y: 140, act: "click", w: 20 });
    assert.equal(ms, 0, "it jumps");
    await page.waitForTimeout(150);
    const trail = await page.evaluate(() => window.trail);
    assert.ok(trail.every((p) => (p.x === 100 && p.y === 500) || (p.x === 850 && p.y === 140)), "no point in between");
    await page.mouse.click(850, 140);
    await page.waitForTimeout(100);
    const ring = await page.evaluate((tag) => {
      for (const el of document.querySelectorAll(tag)) {
        const r = el.shadowRoot?.querySelector(".c.click .r");
        if (r) { const cs = getComputedStyle(r); return { anim: cs.animationName, opacity: +cs.opacity }; }
      }
      return null;
    }, hud.tags.cursor);
    assert.ok(ring, "the press rang");
    assert.equal(ring.anim, "none");
    assert.ok(ring.opacity > 0, "a static dot stays");
  } finally {
    await browser.close();
  }
});

// ---- participant colors by app ----

test("appOf names Claude Code, Codex and Gemini from a label, and nothing for a person or another agent", async () => {
  const { appOf } = await import("../scripts/daemon/hud.mjs");
  assert.equal(appOf("Claude"), "claude");
  assert.equal(appOf("Claude 3fed"), "claude");
  assert.equal(appOf("Alice · Claude Code"), "claude");
  assert.equal(appOf("Codex"), "codex");
  assert.equal(appOf("Bob · Codex"), "codex");
  assert.equal(appOf("Claude (by hand)"), "", "a person");
  assert.equal(appOf("Ana (by hand)"), "");
  assert.equal(appOf("Agent x"), "");
  assert.equal(appOf("Gemini"), "gemini");
  assert.equal(appOf("Gemini 2"), "gemini");
  assert.equal(appOf("Cleo · Gemini"), "gemini");
  assert.equal(appOf("Gemini (by hand)"), "", "a person named Gemini");
  assert.equal(appOf("Geminis"), "", "a word boundary, not a prefix");
  assert.equal(appOf(""), "");
  assert.equal(appOf(undefined), "");
});

test("assignColors: Claude orange, Codex purple and Gemini blue in any join order, the rest for everyone else", async () => {
  const { assignColors, SPARK_COLORS } = await import("../scripts/daemon/hud.mjs");
  assert.deepEqual(SPARK_COLORS, ["#e9763f", "#9b7bfa", "#4b8ffb", "#4ade80", "#4fd1e8", "#f472b6"], "the mockup's palette (the user, 2026-10-12)");
  assert.deepEqual(assignColors(["Claude", "Codex", "Agent x", "Ana (by hand)", "Claude"]), ["#e9763f", "#9b7bfa", "#4ade80", "#4fd1e8", "#f472b6"]);
  assert.deepEqual(assignColors(["Agent x", "Ana (by hand)", "Codex"]), ["#4ade80", "#4fd1e8", "#9b7bfa"], "Codex after two unknowns keeps its color");
  assert.deepEqual(assignColors(["Codex", "Bob · Codex"]), ["#9b7bfa", "#4ade80"], "a second Codex takes the next free other color");
  assert.deepEqual(assignColors(["Alice · Claude Code", "Claude 3fed"]), ["#e9763f", "#4ade80"], "a second Claude too");
  assert.deepEqual(assignColors(["You (by hand)", "Gemini", "Claude Code", "Codex"]), ["#4ade80", "#4b8ffb", "#e9763f", "#9b7bfa"], "the mockup's four: Gemini blue, the person green");
  assert.deepEqual(assignColors(["Gemini", "Cleo · Gemini"]), ["#4b8ffb", "#4ade80"], "a second Gemini takes the next free other color");
  const many = assignColors(Array.from({ length: 10 }, (_, i) => `Agent ${i}`));
  assert.ok(many.every((c) => SPARK_COLORS.includes(c) && !["#e9763f", "#9b7bfa", "#4b8ffb"].includes(c)), "with every color taken, the others again in turn");
});

test("sparkColor colors by app from labelOf; an unlisted joined:<label> id is labelled from itself; labelOf is optional", async () => {
  const { createHud } = await import("../scripts/daemon/hud.mjs");
  const base = { pages: async () => [], waiting: () => null, liveView: () => null, notify: () => {} };
  const labels = { x: "Agent x", c: "Sam · Codex", k: "Claude" };
  const hud = createHud({ ...base, participants: () => ["x", "c", "k"], labelOf: (id) => labels[id] || "" });
  assert.equal(hud.sparkColor("k"), "#e9763f");
  assert.equal(hud.sparkColor("c"), "#9b7bfa");
  assert.equal(hud.sparkColor("x"), "#4ade80");
  const joined = createHud({ ...base, participants: () => ["k"], labelOf: (id) => labels[id] || "" });
  assert.equal(joined.sparkColor("joined:Sam · Codex"), "#9b7bfa", "an unlisted joined id, by its own label");
  const plain = createHud({ ...base, participants: () => ["a", "b"] });
  assert.equal(plain.sparkColor("a"), "#4ade80", "without labelOf every participant is someone else");
  assert.equal(plain.sparkColor("b"), "#4fd1e8");
});

test("peers' pointers: an agent's is the white agent cursor edged in its color, a person's keeps its colored fill", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    for (const reducedMotion of ["no-preference", "reduce"]) {
      const page = await browser.newPage({ viewport: { width: 1000, height: 700 }, reducedMotion });
      await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: "<body style=\"margin:0;height:2000px\"></body>" }));
      await page.goto("http://pairbrowse.test/");
      await page.evaluate(openShadows);
      await ensureHud(page, source, "__pbtest");
      const list = [
        { k: "host-agent:3", x: 200, y: 150, who: "Codex", color: "#7088f0" },
        { k: "j1:a0", x: 400, y: 150, who: "Gemini", color: "#4fd1e8" },
        { k: "sam", x: 300, y: 300, who: "Sam", color: "#4ade80" },
      ];
      await page.evaluate((v) => window.__pbtest("tok", v, "cursors"), JSON.stringify(list));
      await page.waitForTimeout(reducedMotion === "reduce" ? 50 : 500);
      const peers = await page.evaluate((tag) => {
        for (const el of document.querySelectorAll(tag)) {
          const ps = el.shadowRoot?.querySelectorAll(".p");
          if (!ps?.length) continue;
          return [...ps].map((p) => {
            const path = p.querySelector("path"), svg = p.querySelector("svg"), span = p.querySelector("span");
            return { cls: p.className, fill: path.getAttribute("fill"), stroke: path.getAttribute("stroke"), sw: path.getAttribute("stroke-width"), w: svg.getBoundingClientRect().width, pill: getComputedStyle(span).backgroundColor, left: getComputedStyle(span).left, opacity: getComputedStyle(p).opacity, ph: span.getBoundingClientRect().height, fs: getComputedStyle(span).fontSize };
          });
        }
        return null;
      }, hud.tags.cursor);
      assert.ok(peers && peers.length === 3, `three pointers: ${JSON.stringify(peers)}`);
      const [codex, gemini, sam] = peers;
      for (const [p, color, rgb] of [[codex, "#7088f0", "rgb(112, 136, 240)"], [gemini, "#4fd1e8", "rgb(79, 209, 232)"]]) {
        assert.equal(p.cls, "p a on", reducedMotion);
        assert.deepEqual([p.fill, p.stroke, p.sw, p.w, p.pill, p.left], ["#fff", color, "1.4", 22, rgb, "16px"], `an agent's pointer, ${reducedMotion}`);
        // The name pill: 24 px tall, 12 px text (DESIGN.md B5).
        assert.deepEqual([p.ph, p.fs], [24, "12px"], `an agent's name pill, ${reducedMotion}`);
      }
      assert.deepEqual([sam.cls, sam.fill, sam.stroke, sam.w, sam.pill, sam.left], ["p on", "#4ade80", "#fff", 18, "rgb(74, 222, 128)", "14px"], `a person's pointer, ${reducedMotion}`);
      assert.deepEqual([sam.ph, sam.fs], [24, "12px"], `a person's name pill, ${reducedMotion}`);
      if (reducedMotion === "reduce") assert.equal(codex.opacity, "1", "in place at once under reduced motion");
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

// ---- docked (545, DESIGN.md Part G): inside the PairBrowse browser's own window ----
// The window's agent panel carries the bottom bar's duties (who drives, the steps, Pause) and the
// agent's status, so a docked page draws only a join request's card and only the "your turn" badge.
// Plain Chromium never hears "docked": nothing changes there (the tests above).
test("docked: no bottom bar, the join card still asks, the badge only for your turn; undocked again, all back", { skip: !runtime, timeout: 60_000 }, async () => {
  const { chromium } = createRequire(join(runtime, "package.json"))("patchright");
  const hud = (await import("../scripts/browser.mjs")).hudScript();
  const source = hud.source.replaceAll(hud.name, "__pbtest").replaceAll(hud.token, "tok");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.route("http://pairbrowse.test/", (route) => route.fulfill({ contentType: "text/html", body: "<h1>Shop</h1>" }));
    await page.goto("http://pairbrowse.test/");
    // The shadow roots are closed; the test opens them (in the world the script runs in) to look in.
    await page.evaluate(() => { const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { return a.call(this, { ...i, mode: "open" }); }; });
    await ensureHud(page, source, "__pbtest");
    const send = (v, k) => page.evaluate(([v, k]) => window.__pbtest("tok", typeof v === "string" || k === "join" ? v : JSON.stringify(v), k), [v, k]);
    const look = () => page.evaluate((tags) => {
      const bar = document.querySelector(tags.bar)?.shadowRoot?.querySelector(".bar");
      const shown = (el) => !!el && el.checkVisibility() && el.getBoundingClientRect().height > 0;
      const badge = document.querySelector(tags.hud)?.shadowRoot?.querySelector(".b");
      return {
        barH: bar ? bar.getBoundingClientRect().height : null, who: shown(bar?.querySelector(".who")), chips: shown(bar?.querySelector("ol")), pause: shown(bar?.querySelector(".pz")),
        join: shown(bar?.querySelector(".jq")), joinBottom: bar?.querySelector(".jq") ? innerHeight - Math.round(bar.querySelector(".jq").getBoundingClientRect().bottom) : null,
        dismiss: bar?.querySelector(".jq .x")?.title || "",
        badge: badge && document.querySelector(tags.hud).isConnected ? badge.querySelector("span").textContent : null,
      };
    }, hud.tags);
    const items = [{ t: Date.now() - 1000, text: "Filled **Name**", who: "Claude" }];
    // As the helper sends them in a build with its own pages: docked first, then the bar and badge.
    assert.equal(await send({ on: true }, "docked"), true);
    await send({ items, canPause: true }, "bar");
    await send("Filling the shipping form", "claude");
    let v = await look();
    assert.deepEqual([v.barH, v.who, v.chips, v.pause], [0, false, false, false], "no bar strip: no who line, no steps, no Pause agents");
    assert.equal(v.badge, null, "the agent's status is the panel's Status box, not a badge");
    // A join request still asks in the page (an urgent decision, trusted-click gated), at the corner.
    await send({ id: "r0a1b2c", who: "Sam", role: "drive" }, "join");
    v = await look();
    assert.equal(v.join, true, "the join card shows");
    assert.equal(v.joinBottom, 12, "12 px from the page's bottom (no bar under it)");
    assert.equal(v.dismiss, "Dismiss (it stays in the agent panel)");
    // Your turn: the person must act in the page, and the panel may be a rail or hidden.
    await send("Solve the CAPTCHA", "you");
    v = await look();
    assert.equal(v.badge, "Your turn: Solve the CAPTCHA");
    const lift = await page.evaluate((tags) => { const b = document.querySelector(tags.hud).getBoundingClientRect(), j = document.querySelector(tags.bar).shadowRoot.querySelector(".jq").getBoundingClientRect(); return b.bottom <= j.top; }, hud.tags);
    assert.equal(lift, true, "the badge sits above the join card");
    // A new bar while docked: still no strip (drawBar returns before it draws or arms its re-check).
    await send({ items: [{ t: Date.now(), text: "Clicked Next", who: "Claude" }], canPause: true }, "bar");
    assert.equal((await look()).barH, 0);
    // What no dock shows stays as a note at the bottom left: the agent waiting while a person uses
    // the browser, a shared tab reconnecting, REC. The who line only: no steps, no Pause agents.
    const whoText = () => page.evaluate((tags) => document.querySelector(tags.bar).shadowRoot.querySelector(".who").textContent, hud.tags);
    await send({ items, canPause: true, waiting: true }, "bar");
    v = await look();
    assert.deepEqual([v.barH, v.who, v.chips, v.pause], [30, true, false, false], "docked wait: the who line alone");
    assert.match(await whoText(), /Claude is waiting… you're using the browser/);
    assert.equal(v.joinBottom, 40, "the join card above the note");
    assert.equal(await page.evaluate((tags) => { const b = document.querySelector(tags.hud).getBoundingClientRect(), j = document.querySelector(tags.bar).shadowRoot.querySelector(".jq").getBoundingClientRect(); return b.bottom <= j.top; }, hud.tags), true, "the badge still above the join card");
    await send({ items, canPause: true, reconnecting: "Alice" }, "bar");
    v = await look();
    assert.deepEqual([v.barH, v.who, v.chips, v.pause], [30, true, false, false], "docked reconnect: the who line alone");
    assert.match(await whoText(), /Reconnecting to Alice…/);
    await send({ items, canPause: true, recording: true }, "bar");
    v = await look();
    assert.deepEqual([v.barH, v.who, v.chips, v.pause], [30, true, false, false], "docked REC: the chip alone");
    assert.deepEqual(await page.evaluate((tags) => { const w = document.querySelector(tags.bar).shadowRoot.querySelector(".who"); return [w.querySelector(".rec").checkVisibility(), w.querySelector(":scope>span:not(.rec)").checkVisibility(), w.querySelector(".dot").checkVisibility()]; }, hud.tags), [true, false, false], "REC alone: no driving line to go stale");
    await send({ items, canPause: true }, "bar");
    v = await look();
    assert.deepEqual([v.barH, v.who], [0, false], "nothing to note: no strip again");
    assert.equal(v.joinBottom, 12);
    // Undocked again (the same tab in plain Chromium): the whole bar and the agent's badge are back.
    await send({ on: false }, "docked");
    await send("Filling the shipping form", "claude");
    v = await look();
    assert.ok(v.barH >= 30, `the bar is back (${v.barH} px)`);
    assert.deepEqual([v.who, v.chips, v.pause], [true, true, true]);
    assert.equal(v.badge, "Claude: Filling the shipping form");
    assert.equal(v.dismiss, "Dismiss (it stays in the side panel)");
    assert.equal(await send("not json", "docked"), true, "anything but {on:true} is undocked");
  } finally {
    await browser.close();
  }
});

test("docked: the helper tells a page it is docked before its badge, only in a build with its own pages", async () => {
  const { createHud } = await import("../scripts/daemon/hud.mjs");
  const run = async (opts) => {
    const calls = [];
    const page = { isClosed: () => false, url: () => "https://example.com/", evaluate: async (fn, args) => { if (Array.isArray(args) && typeof args[3] === "string") calls.push(args[3]); return typeof fn === "function" && args === undefined ? true : true; } };
    const hud = createHud({ pages: async () => [page], participants: () => [], waiting: () => null, liveView: () => null, notify: () => {}, ...opts });
    await hud.setBadge("Working", "claude").catch(() => {});
    calls.length = 0;
    await hud.onPageLoad(page);
    return calls;
  };
  const docked = await run({ docked: () => true });
  assert.ok(docked.includes("docked"), docked.join(","));
  assert.ok(docked.indexOf("docked") < docked.indexOf("claude"), `docked before the badge: ${docked.join(",")}`);
  assert.ok(docked.indexOf("docked") < docked.indexOf("bar"), "and before the bar");
  const plain = await run({});
  assert.equal(plain.includes("docked"), false, "plain Chromium: no extra call");
  assert.ok(plain.includes("bar"));
});
