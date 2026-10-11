// The settings page (ui/settings): only what the helper reports, through the side panel's routes.
// The common checks (CSP, names, Tab ring, hidden, reduced motion) stay in test/ui.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pageTest } from "./helpers/ui-page.mjs";

const FX = JSON.parse(readFileSync(new URL("./fixtures/ui-settings.json", import.meta.url), "utf8"));
const fixtures = FX.helper;
const has = (posts, route, body) => posts.some((p) => p.route === route && JSON.stringify(p.body) === JSON.stringify(body));
async function posted(helper, page, what, route, body) {
  for (let i = 0; i < 100; i++) { if (has(helper.posts, route, body)) return; await page.waitForTimeout(50); }
  assert.fail(`no post for ${what}: ${JSON.stringify(helper.posts)}`);
}
const live = () => document.body.dataset.s === "live";

// 1. The sections render from the helper's fixtures.
pageTest("settings", { fixtures, viewport: { width: 1000, height: 900 } }, async ({ helper, until, inPage }) => {
  await until("the stream", live);
  const top = await inPage(() => ({
    ids: [...document.querySelectorAll("main > section.sec")].map((s) => s.id),
    heads: [...document.querySelectorAll(".sec-h")].map((h) => { const s = getComputedStyle(h); return [h.getBoundingClientRect().height, s.fontSize, s.fontWeight]; }),
    host: document.body.dataset.host,
    now: document.getElementById("browser-now").textContent,
    about: document.getElementById("about-host").textContent,
    lines: ["line-pairbrowse", "line-chromium", "line-path"].map((id) => document.getElementById(id).textContent),
  }));
  assert.deepEqual(top.ids, ["browser", "sessions", "sharing", "passwords", "remembered", "timeline", "appearance", "about"]);
  for (const h of top.heads) assert.deepEqual(h, [44, "13px", "500"]);
  assert.equal(top.host, "pairbrowse");
  assert.equal(top.now, "The PairBrowse browser");
  assert.equal(top.about, "The PairBrowse browser");
  assert.deepEqual(top.lines, ['"browserEngine": "pairbrowse"', '"browserEngine": "chromium"', '"executablePath": "/path/to/your/Chromium"']);

  await until("two session rows", () => document.querySelectorAll("#session-list li").length === 2);
  const rows = await inPage(() => [...document.querySelectorAll("#session-list li")].map((li) => ({
    name: li.querySelector(".name").textContent, badges: [...li.querySelectorAll("em")].map((e) => [e.className, e.textContent]),
    meta: li.querySelector("small").textContent, controls: li.querySelectorAll("button, input, a").length,
  })));
  assert.equal(rows[0].name, "Default");
  assert.deepEqual(rows[0].badges, [["", "Last used"]]);
  assert.match(rows[0].meta, /^3 tabs · shop\.example, docs\.example · used /);
  assert.equal(rows[1].name, "checkout-test");
  assert.deepEqual(rows[1].badges, [["live", "Live · 1 other"]]);
  assert.equal(rows[1].meta, "1 tab · shop.example", "used 0 is left out");
  assert.ok(rows.every((r) => r.controls === 0), "no rename or delete control");

  await until("the profile", () => document.querySelectorAll("#details .row").length === 2);
  const prof = await inPage(() => ({
    details: [...document.querySelectorAll("#details .row input")].map((i) => [i.value, i.getAttribute("aria-label")]),
    secrets: [...document.querySelectorAll("#secrets .row.secret")].map((r) => [r.textContent, r.querySelectorAll("input").length]),
  }));
  assert.deepEqual(prof.details, [["DE123456789", "VAT number"], ["Acme GmbH", "Company"]]);
  assert.equal(prof.secrets.length, 1);
  assert.match(prof.secrets[0][0], /SHOPIFY_PASSWORD.*accounts\.shopify\.com/);
  assert.equal(prof.secrets[0][1], 0, "no password field");

  await until("dev and host rows", () => document.querySelectorAll("#devs li").length === 2 && document.querySelectorAll("#host-list li").length === 1);
  const share = await inPage(() => ({
    devs: [...document.querySelectorAll("#devs li span")].map((s) => s.textContent),
    dev: document.getElementById("dev").hidden, devEmpty: document.getElementById("dev-empty").hidden,
    hosts: [...document.querySelectorAll("#host-list li span")].map((s) => s.textContent),
    hostsEmpty: document.getElementById("hosts-empty").hidden,
  }));
  assert.deepEqual(share, { devs: ["localhost:3000 · shared", "localhost:5173 · Vite"], dev: false, devEmpty: true, hosts: ["tunnel.example.com · always"], hostsEmpty: true });

  await until("the timeline", () => document.getElementById("timeline-state").textContent === "On · 1 picture kept");
  assert.equal(helper.streams.size, 1);
  const [stream] = [...helper.streams];
  assert.equal(stream.panel, true, "events?panel=1: no page screencast");
  assert.equal(stream.kind, null);

  helper.set("dev", { shared: [], open: [] });
  helper.set("joinhost", { hosts: [] });
  await until("the empty lines", () => !document.getElementById("dev-empty").hidden && !document.getElementById("hosts-empty").hidden);
});

// 2. The browser setting: the host and the config line; Copy copies it.
pageTest("settings", { fixtures, viewport: { width: 1000, height: 900 } }, async ({ page, until, inPage }) => {
  await until("the stream", live);
  await page.click(".copy[data-for=line-chromium]");
  await until("the copied line", () => window.__copied === '"browserEngine": "chromium"');
  const b = await inPage(() => ({
    msg: document.getElementById("browser-msg").textContent,
    note: document.getElementById("browser-note").textContent,
    inputs: document.querySelectorAll("#browser input, #browser select, #browser textarea").length,
  }));
  assert.equal(b.msg, "Copied.");
  assert.ok(b.note.includes("~/.pairbrowse/config.json") && b.note.includes("no settings route"));
  assert.equal(b.inputs, 0, "no path field: nothing saves it");
});

// 3. Forms and buttons post to the same routes as the side panel's.
pageTest("settings", { fixtures, viewport: { width: 1000, height: 900 } }, async ({ page, helper, until, inPage, shim, harness, errors }) => {
  await until("the stream", live);
  await until("the profile", () => document.querySelectorAll("#details .row").length === 2);
  await page.fill("#add-detail [name=label]", "Phone");
  await page.fill("#add-detail [name=value]", "+49 30 1");
  await page.press("#add-detail [name=value]", "Enter");
  await posted(helper, page, "setDetail", "profile", { op: "setDetail", label: "Phone", value: "+49 30 1" });

  await page.fill("#add-secret [name=label]", "Shop");
  await page.fill("#add-secret [name=value]", "hunter2");
  await page.fill("#add-secret [name=domains]", "shop.example");
  await page.click("#add-secret button[type=submit]");
  await posted(helper, page, "setSecret", "profile", { op: "setSecret", name: "SHOP_PASSWORD", value: "hunter2", domains: "shop.example" });
  await until("the result", () => /Saved SHOP_PASSWORD/.test(document.getElementById("profile-msg").textContent));
  assert.equal(await inPage(() => [...document.querySelectorAll("input")].some((i) => i.value === "hunter2") || document.body.textContent.includes("hunter2")), false, "the password stays nowhere in the page");

  await page.fill("#details .row input[aria-label='Company']", "Acme AG");
  await page.press("#details .row input[aria-label='Company']", "Tab");
  await posted(helper, page, "an existing detail", "profile", { op: "setDetail", label: "Company", value: "Acme AG" });

  await page.click("#devs li:first-child button");
  await posted(helper, page, "Stop", "dev", { op: "unshare", port: 3000 });
  await page.click("button[aria-label='Remove tunnel.example.com']");
  await posted(helper, page, "Remove", "joinhost", { op: "forget", host: "tunnel.example.com" });
  await page.click("#switch-btn");
  await posted(helper, page, "Switch session", "picker", null);
  await until("the picker message", () => document.getElementById("sessions-msg").textContent === "The session picker opened in a new tab.");

  await page.click("#chromium-settings");
  for (let i = 0; i < 100; i++) {
    if ((await shim.calls()).some((c) => c.iface === "tabs" && c.method === "create" && c.args[0] === "chrome://settings" && c.args[1] === true)) break;
    assert.ok(i < 99, "tabs.create(chrome://settings, true)");
    await page.waitForTimeout(50);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual((await harness.log()).filter((e) => ["error", "pageerror", "rejection", "csp"].includes(e.kind)), []);
});

// 4. The keyboard: Tab, Enter and Space, each with the ring.
pageTest("settings", { fixtures, viewport: { width: 1000, height: 900 } }, async ({ page, helper, until, inPage, errors }) => {
  await until("the stream", live);
  const ring = await inPage(() => {
    const probe = document.createElement("span");
    probe.style.color = "var(--accent)";
    document.body.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    document.activeElement?.blur?.();
    return c;
  });
  const focusRing = () => inPage(() => { const s = getComputedStyle(document.activeElement); return [s.outlineStyle, s.outlineWidth, s.outlineColor]; });
  await page.keyboard.press("Tab");
  assert.equal(await inPage(() => document.activeElement.hash), "#browser");
  assert.deepEqual(await focusRing(), ["solid", "2px", ring]);
  await page.keyboard.press("Enter");
  await until("the jump", () => location.hash === "#browser");

  await page.focus("#switch-btn");
  await page.keyboard.press("Enter");
  await posted(helper, page, "Switch session by key", "picker", null);
  assert.deepEqual(await focusRing(), ["solid", "2px", ring]);

  await page.focus(".copy");
  await page.keyboard.press("Space");
  await until("the copied line", () => window.__copied === '"browserEngine": "pairbrowse"');
  assert.deepEqual(await focusRing(), ["solid", "2px", ring]);

  await page.focus("#add-detail [name=label]");
  await page.keyboard.type("Fax");
  await page.keyboard.press("Tab");
  await page.keyboard.type("1");
  assert.deepEqual(await focusRing(), ["solid", "2px", ring]);
  await page.keyboard.press("Enter");
  await posted(helper, page, "setDetail by Enter", "profile", { op: "setDetail", label: "Fax", value: "1" });
  assert.deepEqual(errors, []);
});

// 5. Reduced motion and a hidden page; a helper without the timeline.
pageTest("settings", { fixtures: { ...fixtures, timeline: null }, reducedMotion: "reduce", viewport: { width: 1000, height: 900 } }, async ({ page, until, harness }) => {
  await until("the stream", live);
  await until("the timeline", () => document.getElementById("timeline-state").textContent === "Not available from this PairBrowse: it keeps no timeline.");
  await page.hover("#session-list li:first-child");
  await page.focus("#switch-btn");
  await page.hover("#switch-btn");
  assert.deepEqual(await harness.animations(), []);
  const fires0 = await harness.hiddenFires();
  await harness.setHidden(true);
  await page.waitForTimeout(400);
  const { timeouts, intervals, frames, observers, eventSources } = await harness.live();
  assert.deepEqual({ timeouts, intervals, frames, observers, eventSources }, { timeouts: 0, intervals: 0, frames: 0, observers: 0, eventSources: 1 });
  assert.equal(await harness.hiddenFires(), fires0);
  await harness.setHidden(false);
});

// 6. Before the helper's first dev and joinhost events (the stream's burst leaves them out while
// they are null), the empty lines say nothing; the first events bring them.
pageTest("settings", { fixtures: { ...fixtures, dev: null, joinhost: null }, viewport: { width: 1000, height: 900 } }, async ({ helper, page, until, inPage }) => {
  await until("the stream", live);
  await until("the timeline", () => document.getElementById("timeline-state").textContent === "On · 1 picture kept");
  await page.waitForTimeout(200);
  assert.deepEqual(await inPage(() => ({ dev: document.getElementById("dev-empty").hidden, hosts: document.getElementById("hosts-empty").hidden })), { dev: true, hosts: true }, "no empty fact before any dev event");
  helper.set("dev", { asks: [], shared: [], open: [] });
  helper.set("joinhost", { asks: [], hosts: [] });
  await until("the empty lines", () => !document.getElementById("dev-empty").hidden && !document.getElementById("hosts-empty").hidden);
});
