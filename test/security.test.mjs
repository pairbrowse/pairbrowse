import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecrets, loadSecrets, hostAllowed, redact } from "../scripts/secrets.mjs";
import { secretNamesIn, navigationProblem, looksLikeSecretName, BLOCKED_TOOLS } from "../scripts/policy.mjs";

test("secrets carry their allowed domains", () => {
  const s = parseSecrets("# c\nSHOP_PW='p@ss'\nSHOP_PW_DOMAINS=accounts.shopify.com, *.example.com\nLOOSE_PW=x\nEMPTY=\n");
  assert.deepEqual(s.values, { SHOP_PW: "p@ss", LOOSE_PW: "x" });
  assert.deepEqual(s.domains.SHOP_PW, ["accounts.shopify.com", "example.com"]);
  assert.deepEqual(s.domains.LOOSE_PW, []);
});

test("a password with U+2028 or U+2029 in it reads back from the file", () => {
  assert.deepEqual(parseSecrets('SHOP_PW="a b c"\nSHOP_PW_DOMAINS=shopify.com\n').values, { SHOP_PW: "a b c" });
});

test("a password that holds a shorter one is masked whole", () => {
  assert.equal(redact("pw: hunter2hunter2!", { SHORT: "hunter2", LONG: "hunter2hunter2!" }), "pw: <secret>LONG</secret>");
  assert.equal(redact("pw: hunter2", { SHORT: "hunter2", LONG: "hunter2hunter2!" }), "pw: <secret>SHORT</secret>");
});

test("a secret is typed only on its HTTPS domains", () => {
  const d = ["accounts.shopify.com"];
  assert.equal(hostAllowed("https://accounts.shopify.com/login", d), true);
  assert.equal(hostAllowed("https://eu.accounts.shopify.com/login", d), true);
  assert.equal(hostAllowed("http://accounts.shopify.com/login", d), false, "plain http");
  assert.equal(hostAllowed("https://accounts.shopify.com.evil.io/login", d), false, "lookalike suffix");
  assert.equal(hostAllowed("https://evilaccounts.shopify.com/", d), false);
  assert.equal(hostAllowed("https://shopify-login.io/?accounts.shopify.com", d), false);
  assert.equal(hostAllowed("https://accounts.shopify.com/", []), false, "no domains, no typing");
});

test("a secrets file readable by others is refused", { skip: process.platform === "win32" }, () => {
  const f = join(mkdtempSync(join(tmpdir(), "pb-")), "secrets.env");
  writeFileSync(f, "A_PW=x\nA_PW_DOMAINS=a.com\n");
  chmodSync(f, 0o644);
  assert.match(loadSecrets(f).problem, /chmod 600/);
  assert.deepEqual(loadSecrets(f).values, {});
  chmodSync(f, 0o600);
  assert.equal(loadSecrets(f).problem, null);
  assert.equal(loadSecrets(f).values.A_PW, "x");
});

test("secret names are spotted in fills and typing", () => {
  const names = ["SHOP_PW"];
  assert.deepEqual(secretNamesIn("browser_fill_form", { fields: [{ value: "a@b.co" }, { value: "SHOP_PW" }] }, names), ["SHOP_PW"]);
  assert.deepEqual(secretNamesIn("browser_type", { text: "SHOP_PW" }, names), ["SHOP_PW"]);
  assert.deepEqual(secretNamesIn("browser_type", { text: "hello" }, names), []);
  assert.equal(looksLikeSecretName("browser_type", { text: "USA" }), false);
  assert.equal(looksLikeSecretName("browser_type", { text: "META_PASSWORD" }), true);
});

test("the daemon refuses non-web navigation and arbitrary code", () => {
  assert.equal(navigationProblem("https://x.com"), null);
  assert.equal(navigationProblem("about:blank"), null);
  assert.ok(navigationProblem("file:///etc/passwd"));
  assert.ok(navigationProblem("javascript:fetch('//evil')"));
  assert.ok(BLOCKED_TOOLS.has("browser_run_code_unsafe"));
});

test("files PairBrowse creates are private", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pb-"));
  process.env.PAIRBROWSE_HOME = home;
  const { ensureDirs } = await import("../scripts/paths.mjs?private");
  ensureDirs();
  const { statSync } = await import("node:fs");
  for (const d of ["", "profile", "run", "runs", "files/uploads"]) {
    assert.equal(statSync(join(home, d)).mode & 0o077, 0, d || "home");
  }
  writeFileSync(join(home, "x"), "y");
  assert.equal(statSync(join(home, "x")).mode & 0o077, 0, "umask applies to new files");
  assert.ok(readdirSync(home).length > 0);
});

test("tool results are trimmed to what Claude needs", async () => {
  const { trimResult, HIDDEN_TOOLS } = await import("../scripts/policy.mjs");
  const raw = "### Ran Playwright code\n```js\nawait page.goto('x');\n```\n### Open tabs\n- 0: (current) [A](https://a)\n- 1: [B](https://b)\n### Page\n- Page URL: https://a\n- Console: 1 errors, 0 warnings\n### Events\n- New console entries: x.log\n";
  const navigate = trimResult("browser_navigate", raw);
  assert.ok(!navigate.includes("Open tabs") && !navigate.includes("Events") && !navigate.includes("Console:"));
  assert.ok(navigate.includes("Page URL: https://a") && navigate.includes("Ran Playwright code"));
  assert.ok(trimResult("browser_tabs", raw).includes("[B](https://b)"), "the tabs tool keeps its list");
  assert.ok(HIDDEN_TOOLS.has("browser_take_screenshot") && !HIDDEN_TOOLS.has("browser_fill_form"));
});

test("servers without a screen get a private virtual screen", async () => {
  const { needsVirtualDisplay } = await import("../scripts/display.mjs");
  const cfg = { display: "auto" };
  assert.equal(needsVirtualDisplay(cfg, {}, "linux"), true, "no screen");
  assert.equal(needsVirtualDisplay(cfg, { DISPLAY: ":0" }, "linux"), false, "desktop Linux");
  assert.equal(needsVirtualDisplay(cfg, { WAYLAND_DISPLAY: "wayland-0" }, "linux"), false);
  assert.equal(needsVirtualDisplay(cfg, {}, "darwin"), false, "macOS");
  assert.equal(needsVirtualDisplay({ ...cfg, display: "none" }, {}, "linux"), false);
  assert.equal(needsVirtualDisplay({ ...cfg, display: "xvfb" }, { DISPLAY: ":0" }, "linux"), true);
  assert.equal(needsVirtualDisplay({ ...cfg, display: "none" }, {}, "linux"), false);
});

test("only snapshot refs count as refs, not numbers or short words", async () => {
  const { isRef } = await import("../scripts/policy.mjs");
  for (const ref of ["e42", "f1e7"]) assert.ok(isRef(ref), ref);
  for (const other of ["2024", "x9", "E42", "#e42", "button", "", undefined]) assert.ok(!isRef(other), String(other));
});

test("the launch self-check's virtual screen has its own X cookie, so a running browser's screen keeps working", { skip: process.platform !== "linux" || !(await import("../scripts/display.mjs")).hasCommand("Xvfb") }, async () => {
  const { startVirtualDisplay } = await import("../scripts/display.mjs");
  const { paths } = await import("../scripts/paths.mjs");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const main = await startVirtualDisplay();
  const check = await startVirtualDisplay(() => {}, { name: "Xauthority-check" });
  try {
    assert.notEqual(main.env.DISPLAY, check.env.DISPLAY);
    assert.equal(check.env.XAUTHORITY, join(paths.home, "run", "Xauthority-check"));
    assert.ok(existsSync(main.env.XAUTHORITY) && existsSync(check.env.XAUTHORITY), "both cookies stay");
  } finally {
    main.stop();
    check.stop();
  }
});

test("a tab list comes once: the open-tabs section is dropped when browser_tabs already lists them", async () => {
  const { trimResult } = await import("../scripts/policy.mjs");
  const out = trimResult("browser_tabs", "### Result\n- 0: [A](http://a/)\n- 1: (current) [B](http://b/)\n### Open tabs\n- 0: [A](http://a/)\n- 1: (current) [B](http://b/)\n");
  assert.equal((out.match(/^- \d+: /gm) || []).length, 2, out);
  // A tab change (new, close) without its own list still shows the open tabs.
  assert.match(trimResult("browser_tabs", "### Result\nClosed tab 1\n### Open tabs\n- 0: [A](http://a/)\n"), /### Open tabs/);
  assert.doesNotMatch(trimResult("browser_click", "### Result\nok\n### Open tabs\n- 0: [A](http://a/)\n"), /Open tabs/);
});
