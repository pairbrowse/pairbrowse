import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { shareableUrl, stateForJoiner, readOps, createMirror, createFormSync, createOrderSync, shareFields, readForm, formForJoiner, readPointers, sameOrder, TABS_MAX, OPS_MAX, FIELDS_MAX, VALUE_MAX } from "../scripts/tabsync.mjs";
import { createPresence } from "../scripts/daemon/presence.mjs";

test("only public web addresses cross, and only the safe parts of them", () => {
  for (const bad of ["file:///etc/passwd", "chrome://settings", "data:text/html,x", "javascript:alert(1)", "about:blank", "chrome-extension://abc/x.html",
    "http://localhost:3000/", "http://127.0.0.1/", "http://192.168.1.1/admin", "http://10.0.0.2/", "http://router/", "http://printer.local/", "http://[::1]/", "http://[::ffff:7f00:1]/",
    "https://user:pass@example.com/", "https://user@example.com/", "not a url", `https://example.com/${"a".repeat(3000)}`]) {
    assert.equal(shareableUrl(bad, { full: true }), null, bad);
  }
  const raw = "https://shop.example.com/orders/12?q=shoes&page=2&token=abc&code=991&session=x&email=a%40b.c&ref=eyJhbGciOiJIUzI1NiJ9&id=a8f3k2m9q7x1z5c4v6b8n0d2#access_token=zz";
  assert.equal(shareableUrl(raw), "https://shop.example.com/orders/12", "watch: origin and path");
  assert.equal(shareableUrl(raw, { full: true }), "https://shop.example.com/orders/12?q=shoes&page=2", "drive: no tokens, codes, sessions, emails, JWTs or long ids, no fragment");
  assert.equal(shareableUrl("https://app.example.com/#/inbox/3", { full: true }), "https://app.example.com/#/inbox/3", "route fragments stay");
  assert.equal(shareableUrl("https://app.example.com/#/cb?state=1", { full: true }), "https://app.example.com/", "fragments with values don't");
  assert.equal(shareableUrl(raw, { full: true, secretDomains: ["example.com"] }), "https://shop.example.com/orders/12", "sites with saved passwords: origin and path");
});

test("what a joiner gets: shareable tabs only; secret-domain tabs as addresses only; nothing of their own sent back", () => {
  const tabs = [
    { id: "00000001", url: "https://a.example/p?q=1&token=t", title: "Results for https://a.example/p?token=t", agent: "Bob · Claude Code", person: "Bob", did: [{ n: 1, who: "Bob", line: 'typed in "Email"' }, { n: 2, who: "Alice", line: 'clicked "Go"' }] },
    { id: "00000002", url: "http://localhost:8080/admin", title: "Local admin" },
    { id: "00000003", url: "https://bank.example/account?x=1", title: "Your balance", agent: "Bob · Claude Code", person: "Bob", did: [{ n: 3, who: "Bob", line: 'typed in "Amount"' }] },
  ];
  const activity = [
    { t: 1, text: "Typed hello into Search", who: "Bob · Claude Code", tabId: "00000001" },
    { t: 2, text: "Opened the admin", who: "Bob · Claude Code", tabId: "00000002" },
    { t: 3, text: "Typed 100 into Amount", who: "Bob · Claude Code", tabId: "00000003" },
    { t: 4, text: "Clicked Go", who: "Alice · Codex", tabId: "00000001", from: "inv:alice" },
  ];
  const s = stateForJoiner({ tabs, activity, people: ["Bob · Claude Code", "Alice"] }, { drive: true, secretDomains: ["bank.example"], name: "Alice", from: "inv:alice" });
  assert.deepEqual(s.tabs.map((t) => t.url), ["https://a.example/p?q=1", "https://bank.example/account"]);
  assert.doesNotMatch(JSON.stringify(s), /localhost|Local admin|token|balance|Amount|100/, "nothing about local or secret-domain tabs beyond the address");
  assert.equal(s.tabs[0].title, "Results for https://a.example/p");
  assert.equal(s.tabs[0].person, "Bob");
  assert.deepEqual(s.tabs[0].did.map((e) => e.who), ["Bob"], "the joiner's own input isn't sent back");
  assert.deepEqual(s.activity.map((a) => a.text), ["Typed hello into Search"], "nor their own agent's activity");
  assert.deepEqual(s.people, ["Bob · Claude Code"]);
  const watch = stateForJoiner({ tabs }, { drive: false });
  assert.equal(watch.tabs[0].url, "https://a.example/p");
  const many = stateForJoiner({ tabs: Array.from({ length: 100 }, (_, i) => ({ id: String(i).padStart(8, "0"), url: `https://e.example/${i}` })) });
  assert.equal(many.tabs.length, TABS_MAX);
});

test("a drive joiner's changes are checked: known tabs, public addresses, bounded", () => {
  const ids = new Set(["0000000a"]);
  assert.deepEqual(readOps({ ops: [{ op: "navigate", id: "0000000a", url: "https://x.example/a?token=1&q=2" }] }, ids).ops, [{ op: "navigate", id: "0000000a", url: "https://x.example/a?q=2" }]);
  for (const url of ["http://192.168.0.1/", "file:///etc/hosts", "javascript:alert(1)", "https://u:p@x.example/"]) assert.match(readOps({ ops: [{ op: "navigate", id: "0000000a", url }] }, ids).problem, /Refused/, url);
  assert.match(readOps({ ops: [{ op: "navigate", id: "0000000b", url: "https://x.example/" }] }, ids).problem, /Unknown/, "a tab they can't know");
  assert.match(readOps({ ops: Array(OPS_MAX + 1).fill({ op: "close", id: "0000000a" }) }, ids).problem, /at most/);
  assert.deepEqual(readOps({ ops: [{ op: "person", id: "0000000a", did: ['typed in "Email"', "x".repeat(500)] }] }, ids).ops[0].did.map((l) => l.length), [16, 80]);
  assert.equal(readOps({ ops: [{ op: "person", id: "0000000b" }] }, ids).problem, "Unknown change.");
});

test("loop safety: an update applied on one side never bounces back", () => {
  let t = 1_000_000;
  const m = createMirror({ now: () => t });
  const local = new Set();
  const tabs = [{ id: "000000a1", url: "https://a.example/1" }];
  let plan = m.fromHost(tabs, local);
  assert.deepEqual(plan.open, [{ id: "000000a1", url: "https://a.example/1" }]);
  local.add("000000a1");
  m.applied("000000a1");
  // The page redirects while it settles: absorbed, not sent.
  assert.equal(m.fromLocal("000000a1", "https://a.example/1/welcome"), null);
  t += 3000;
  assert.equal(m.fromLocal("000000a1", "https://a.example/1/welcome"), null);
  assert.deepEqual(m.fromHost(tabs, local), { open: [], navigate: [], close: [] }, "the same host address again is no news");
  // The host navigates: followed here, and that navigation isn't sent back.
  plan = m.fromHost([{ id: "000000a1", url: "https://a.example/2" }], local);
  assert.deepEqual(plan.navigate, [{ id: "000000a1", url: "https://a.example/2" }]);
  m.applied("000000a1");
  assert.equal(m.fromLocal("000000a1", "https://a.example/2"), null);
  t += 3000;
  assert.equal(m.fromLocal("000000a1", "https://a.example/2"), null);
  // Someone here goes elsewhere: sent once.
  assert.deepEqual(m.fromLocal("000000a1", "https://a.example/3"), { op: "navigate", id: "000000a1", url: "https://a.example/3" });
  assert.equal(m.fromLocal("000000a1", "https://a.example/3"), null);
  // The host's older address (it hasn't applied ours yet) isn't news; its echo of ours isn't either.
  assert.deepEqual(m.fromHost([{ id: "000000a1", url: "https://a.example/2" }], local).navigate, []);
  assert.deepEqual(m.fromHost([{ id: "000000a1", url: "https://a.example/3" }], local).navigate, []);
  // A site that keeps sending each side elsewhere: sending stops after a few rounds.
  let sent = 0;
  for (let i = 0; i < 20; i++) {
    t += 1000;
    if (m.fromLocal("000000a1", `https://a.example/loop${i}`)) sent++;
  }
  assert.ok(sent <= 6, `${sent} sent`);
  // Unshareable addresses here are never sent; tabs the host closed close here.
  t += 60_000;
  assert.equal(m.fromLocal("000000a1", null), null);
  assert.deepEqual(m.fromHost([], local).close, ["000000a1"]);
});

test("a person in the other browser counts as a person here, and isn't sent back", () => {
  mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 2_000_000 });
  try {
    const stale = [];
    const presence = createPresence({ host: "Alice", readEvents: async () => [], pages: () => [], paused: () => true, onUsed() {}, onStale: () => stale.push(1), applyBar() {}, refreshTabs() {} });
    const page = {};
    presence.elsewhere(page, "Bob", ['typed in "Email"']);
    assert.equal(presence.actingIn(page), "Bob", "agents' page changes here wait for Bob");
    assert.deepEqual(presence.sharedPerson(page), { who: "Bob", local: false, acting: true }, "not this browser's person: never sent back");
    assert.match(presence.userNote(page), /Bob used this tab meanwhile: typed in "Email"/);
    assert.equal(stale.length, 1);
    mock.timers.tick(2500);
    assert.equal(presence.personIn(page), null, "and stop waiting once Bob stops");
    presence.userDid([{ kind: "type", t: Date.now(), what: "Name" }], page);
    assert.deepEqual(presence.sharedPerson(page), { who: "Alice", local: true, acting: true });
    assert.deepEqual(presence.feedAfter(page).filter((e) => e.local).map((e) => e.line), ['typed in "Name"']);
  } finally {
    mock.timers.reset();
  }
});

// What a page's fields look like as read in the page (daemon/forms.mjs).
const field = (k, v, t = "text", hints = "") => ({ f: "top", k, t, v, hints });

test("form values: sensitive fields never carry a value, whatever their name or value", () => {
  const raw = [
    field("#name", "Ada Lovelace", "text", "Full name name"),
    field("#email", "ada@example.com", "email", "Email email"),
    field("#pw", "hunter2hunter2", "password", "Password"),
    field("n:cardnumber", "4242 4242 4242 4242", "text", "Card number cardnumber cc-number"),
    field("n:cvc", "123", "text", "CVC cvc"),
    field("#otp", "991245", "text", "Verification code one-time-code"),
    field("#iban", "DE89370400440532013000", "text", "Bank"),
    field("#ssn", "078-05-1120", "text", "Taxpayer"),
    // A made-up live key, built from parts so no secret-shaped text is stored in the repo.
    field("#notes", `my key is ${["sk", "live", "51HxAbCdEfGhIjKlMnOpQrStUv"].join("_")}`, "textarea", "Notes"),
    field("#plain", "Card on file: 4242424242424242", "text", "Comment"),
    field("#saved", "x-correct-horse-battery", "text", "Anything"),
    field("#agree", true, "checkbox", "I agree"),
    field("#size", ["m"], "select", "Size"),
    field("#empty-pw", "", "password", "Password"),
  ];
  const out = shareFields(raw, { secretValues: ["correct-horse-battery"] });
  const by = Object.fromEntries(out.map((x) => [x.k, x]));
  assert.equal(by["#name"].v, "Ada Lovelace");
  assert.equal(by["#email"].v, "ada@example.com");
  assert.deepEqual(by["#agree"], { f: "top", k: "#agree", t: "checkbox", v: true });
  assert.deepEqual(by["#size"].v, ["m"]);
  for (const k of ["#pw", "n:cardnumber", "n:cvc", "#otp", "#iban", "#ssn", "#notes", "#saved"]) assert.deepEqual(by[k], { f: "top", k, t: by[k].t, m: 1, filled: true }, k);
  assert.deepEqual(by["#empty-pw"], { f: "top", k: "#empty-pw", t: "password", m: 1, filled: false });
  const wire = JSON.stringify(out);
  assert.doesNotMatch(wire, /hunter2|4242|123"|991245|DE89|078-05|sk_live|horse|hints/, "no sensitive value and no hints cross");
  // Coming in from the other side: masked stays masked, a password never takes a value, a value
  // that looks sensitive is dropped all the same, and sizes are bounded.
  const back = readForm({ url: "https://a.example/form?x=1", fields: [{ f: "top", k: "#pw", t: "password", v: "leak" }, { f: "top", k: "#c", t: "text", v: "4242424242424242" }, { f: "top", k: "#m", t: "text", m: 1, filled: true, v: "leak" }, { f: "top", k: "#long", t: "text", v: "x".repeat(5000) }, { f: "top", k: "#bad", t: "file", v: "/etc/passwd" }] });
  assert.equal(back.url, "https://a.example/form");
  assert.doesNotMatch(JSON.stringify(back), /leak|4242|passwd/);
  assert.equal(back.fields.find((x) => x.k === "#long").v.length, VALUE_MAX);
  assert.equal(readForm({ url: "https://a.example/", fields: Array(FIELDS_MAX + 1).fill(field("#a", "b")) }), null);
  assert.equal(readForm({ url: "file:///etc/passwd", fields: [] }), null);
  assert.match(readOps({ ops: [{ op: "form", id: "0000000a", url: "javascript:x", fields: [] }] }, new Set(["0000000a"])).problem, /Refused/);
  const op = readOps({ ops: [{ op: "form", id: "0000000a", url: "https://a.example/f", fields: [{ f: "top", k: "#pw", t: "password", v: "hunter2" }] }] }, new Set(["0000000a"])).ops[0];
  assert.doesNotMatch(JSON.stringify(op), /hunter2/);
});

test("form values for joiners: only tabs that fully cross, only for the page they show", () => {
  const form = { url: "https://a.example/f", fields: [{ f: "top", k: "#name", t: "text", v: "Ada" }] };
  assert.equal(formForJoiner("https://a.example/f?step=2", form).fields[0].v, "Ada");
  assert.equal(formForJoiner("https://bank.example/f", { ...form, url: "https://bank.example/f" }, { secretDomains: ["bank.example"] }), null, "secret domains: no values");
  assert.equal(formForJoiner("https://b.example/other", form), null, "another page than the tab's");
  assert.equal(formForJoiner("http://localhost/f", { ...form, url: "http://localhost/f" }), null, "local addresses never cross");
});

test("form values: no echo loops; the person typing here wins", () => {
  let t = 1_000_000;
  const a = createFormSync({ now: () => t }); // the joiner
  const url = "https://a.example/f";
  const read = (v, k = "#name") => [{ f: "top", k, t: "text", v }];
  assert.deepEqual(a.local("x1", url, read("")), [], "an empty field as the page loaded: nothing");
  assert.deepEqual(a.local("x1", url, [{ f: "top", k: "#size", t: "select", v: ["s"] }, { f: "top", k: "#pw", t: "password", m: 1, filled: false }]), [], "nor a default choice or an empty password field: they'd overwrite the other side");
  // The host typed "Ada": it applies here once.
  a.remote("x1", { url, fields: read("Ada") });
  assert.deepEqual(a.toApply("x1", "https://a.example/other"), [], "another page: not applied");
  assert.deepEqual(a.toApply("x1", url).map((x) => x.v), ["Ada"]);
  a.applied("x1", read("Ada"));
  assert.deepEqual(a.local("x1", url, read("Ada")), [], "an applied value isn't sent back");
  a.remote("x1", { url, fields: read("Ada") });
  assert.deepEqual(a.toApply("x1", url), [], "the same value again is no news");
  // The person here types: sent once; the host's echo of it is no news.
  t += 1000;
  assert.deepEqual(a.local("x1", url, read("Ada L")).map((x) => x.v), ["Ada L"]);
  assert.deepEqual(a.local("x1", url, read("Ada L")), []);
  a.remote("x1", { url, fields: read("Ada L") });
  assert.deepEqual(a.toApply("x1", url), []);
  // Typing on while an older value arrives: the person here wins.
  t += 200;
  a.local("x1", url, read("Ada Lo"));
  a.remote("x1", { url, fields: read("Ada L") });
  assert.deepEqual(a.toApply("x1", url), []);
  // Two sides bouncing values: each change crosses once.
  const b = createFormSync({ now: () => t }); // the host
  let sent = 0;
  for (let i = 0; i < 5; i++) {
    t += 2000;
    const fromA = a.local("x1", url, read(`v${i}`));
    sent += fromA.length;
    b.remote("x1", { url, fields: fromA });
    b.applied("x1", b.toApply("x1", url));
    const fromB = b.local("x1", url, read(`v${i}`));
    sent += fromB.length;
    a.remote("x1", { url, fields: fromB });
    assert.deepEqual(a.toApply("x1", url), []);
  }
  assert.equal(sent, 5, "no echo");
  t += 10;
  assert.equal(b.maySend("x1"), true);
  assert.equal(b.maySend("x1"), false, "read at most every few hundred ms");
});

test("tab order: the host's applies here; a move made here goes there once", () => {
  let t = 0;
  const o = createOrderSync({ now: () => t });
  o.fromHost(["0000000a", "0000000b", "0000000c"]);
  assert.deepEqual(o.fromLocal(["0000000a", "0000000c", "0000000b"]), { arrange: ["0000000a", "0000000b", "0000000c"] });
  o.arranged(["0000000a", "0000000b", "0000000c"]);
  assert.deepEqual(o.fromLocal(["0000000a", "0000000b", "0000000c"]), {});
  t += 1000;
  assert.deepEqual(o.fromLocal(["0000000c", "0000000a", "0000000b"]), { send: { op: "order", ids: ["0000000c", "0000000a", "0000000b"] } });
  assert.deepEqual(o.fromLocal(["0000000c", "0000000a", "0000000b"]), {}, "sent once; the host's older order isn't news for a while");
  o.fromHost(["0000000c", "0000000a", "0000000b"]);
  t += 10_000;
  assert.deepEqual(o.fromLocal(["0000000c", "0000000a", "0000000b"]), {}, "the host took it up: no echo");
  assert.ok(sameOrder(["a", "x", "b"], ["a", "b", "y"]));
  assert.deepEqual(readOps({ ops: [{ op: "order", ids: ["0000000a", "ffffffff", "0000000a"] }] }, new Set(["0000000a"])).ops, [{ op: "order", ids: ["0000000a"] }], "only known tabs");
  assert.deepEqual(readOps({ ops: [{ op: "agent", id: "0000000a", who: "Alice · Codex", color: "red;x" }] }, new Set(["0000000a"])).ops, [{ op: "agent", id: "0000000a", who: "Alice · Codex", color: "" }]);
});

test("pointers: a known tab, a clamped position, a name and a color; nothing else", () => {
  const ids = new Set(["0000000a"]);
  const r = readPointers({ me: { id: "0000000a", x: -5, y: 1e12, under: "Password field" }, agents: [{ id: "0000000a", x: 10, y: 20, who: "Bot", color: "#4fd1e8" }, { id: "0000000b", x: 1, y: 1, who: "X" }, { id: "0000000a", x: 1, y: 1 }] }, ids);
  assert.deepEqual(r.me, { id: "0000000a", x: 0, y: 1_000_000 });
  assert.deepEqual(r.agents, [{ id: "0000000a", x: 10, y: 20, who: "Bot", color: "#4fd1e8" }]);
  assert.equal(readPointers({ me: { id: "0000000a", x: "a", y: 1 } }, ids).me, null);
});

test("the side panel extension arranges tabs into the places they hold, per window", async () => {
  const { readFileSync } = await import("node:fs");
  // A stand-in for chrome.tabs: tabs in windows, moved the way Chrome moves them.
  const tabs = [{ id: 1, windowId: 9, index: 0 }, { id: 2, windowId: 9, index: 1 }, { id: 3, windowId: 9, index: 2 }, { id: 4, windowId: 9, index: 3 }];
  const reindex = () => tabs.sort((a, b) => a.index - b.index).forEach((t, i) => { t.index = i; });
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} }, commands: { onCommand: { addListener() {} } }, storage: { session: { set() {} } }, runtime: { getPlatformInfo() {} }, notifications: {},
    tabs: {
      query: async () => tabs.map((t) => ({ ...t, url: `https://x.example/${t.id}` })),
      move: async (id, { index }) => { const t = tabs.find((x) => x.id === id); tabs.splice(tabs.indexOf(t), 1); tabs.splice(index, 0, t); tabs.forEach((x, i) => { x.index = i; }); },
    },
  };
  const g = { chrome, setInterval: () => 0, console };
  new Function("globalThis", "chrome", "setInterval", readFileSync(new URL("../scripts/browser/panel/background.js", import.meta.url), "utf8"))(g, chrome, () => 0);
  reindex();
  // Tabs 1, 3 and 4 are shared (2 is not): put them in the order 4, 1, 3 in the places they hold.
  await g.pbArrange([4, 1, 3]);
  assert.deepEqual(tabs.map((t) => t.id), [4, 2, 1, 3], "the unshared tab keeps its place");
  assert.deepEqual((await g.pbTabs()).map((t) => t.id), [4, 2, 1, 3]);
});

test("who filled a field crosses with it (a name, never more), and whether a person is acting there", () => {
  const [plain, masked] = shareFields([{ f: "top", k: "#notes", t: "textarea", v: "Leave at door", o: "Alice" }, { f: "top", k: "#pw", t: "password", v: "x", o: "Alice" }]);
  assert.equal(plain.o, "Alice");
  assert.equal(masked.o, "Alice");
  assert.equal(masked.v, undefined);
  const form = readForm({ url: "https://a.example/f", fields: [{ f: "top", k: "#notes", t: "textarea", v: "hi", o: "Alice\u0000<b>" + "x".repeat(200) }] });
  assert.ok(form.fields[0].o.length <= 60 && !/\u0000/.test(form.fields[0].o));
  const { ops } = readOps({ ops: [{ op: "person", id: "t1", did: [], acting: true }, { op: "person", id: "t1", did: [], acting: "yes" }] }, new Set(["t1"]));
  assert.deepEqual(ops.map((o) => o.acting), [true, false]);
  const st = stateForJoiner({ tabs: [{ id: "t1", url: "https://a.example/", title: "A", person: "Bob", acting: true }] }, { name: "Alice" });
  assert.equal(st.tabs[0].acting, true);
});

test("what someone did, as it crosses: no query strings, local addresses, card numbers, JWTs or saved passwords", async () => {
  const { crossingText, stateForJoiner } = await import("../scripts/tabsync.mjs");
  assert.equal(crossingText("Opened https://shop.example.com/login?next=%2Fa&session=abc123"), "Opened https://shop.example.com/login");
  assert.equal(crossingText("Opened http://127.0.0.1:8080/admin"), "Opened a local page");
  assert.equal(crossingText("Opened http://router/setup and http://192.168.1.1/"), "Opened a local page and a local page");
  assert.equal(crossingText("Typed `card 4111 1111 1111 1111 exp 12/29` into **Notes**"), "Typed `card ••••11 exp 12/29` into **Notes**");
  assert.equal(crossingText("Typed `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_123` into **Token**"), "Typed `••••` into **Token**");
  assert.equal(crossingText("Typed `Hunter2-Secret-77` into **Notes**", { SHOP_PASSWORD: "Hunter2-Secret-77" }), "Typed `[SHOP_PASSWORD]` into **Notes**");
  assert.equal(crossingText("Typed `Ada Lovelace` into **Name**"), "Typed `Ada Lovelace` into **Name**");
  const st = stateForJoiner({ tabs: [{ id: "0000000a", url: "https://a.example/form" }], activity: [{ t: 1, text: "Typed `4242 4242 4242 4242` into **Notes**", who: "Bob", tabId: "0000000a" }] }, { drive: false });
  assert.doesNotMatch(JSON.stringify(st), /4242 4242/);
});
