import { test } from "node:test";
import assert from "node:assert/strict";
import { describe } from "../scripts/log.mjs";

test("fills are logged with field names and values", () => {
  const line = describe("browser_fill_form", { fields: [{ name: "Email", value: "a@b.co" }, { name: "Password", value: "SHOPIFY_PASSWORD" }] });
  assert.equal(line, "Filled **Email** = `a@b.co`, **Password** = `SHOPIFY_PASSWORD`");
});

test("read-only tools are not logged", () => {
  assert.equal(describe("browser_snapshot", {}), null);
  assert.equal(describe("browser_tabs", { action: "list" }), null);
});

test("card numbers and codes never show in the activity line", () => {
  const line = describe("browser_fill_form", { fields: [
    { name: "Card number", value: "4242 4242 4242 4242" }, { name: "CVC", value: "123" },
    { name: "Notes", value: "5555555555554444" }, { name: "Email", value: "ada@example.com" },
  ] });
  assert.doesNotMatch(line, /4242 4242|5555555555554444|`123`/);
  assert.match(line, /ada@example\.com/, "ordinary values still show");
  assert.doesNotMatch(describe("browser_type", { element: "Security code", text: "987" }), /987/);
});

test("Codex's tool names are logged too", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, readdirSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const home = mkdtempSync(join(tmpdir(), "pb-log-"));
  const hook = new URL("../scripts/log.mjs", import.meta.url).pathname;
  execFileSync(process.execPath, [hook], { env: { ...process.env, PAIRBROWSE_HOME: home }, input: JSON.stringify({ session_id: "abc", tool_name: "mcp__pairbrowse_browser__browser_navigate", tool_input: { url: "https://example.com" } }) });
  const files = readdirSync(join(home, "log"));
  assert.equal(files.length, 1);
  assert.match(readFileSync(join(home, "log", files[0]), "utf8"), /Opened https:\/\/example\.com/);
});

test("a drag is logged by its two ends", () => {
  assert.equal(describe("browser_drag", { startElement: "Card A", startTarget: "e4", endElement: "Done", endTarget: "e6" }), "Dragged **Card A** to **Done**");
  assert.equal(describe("browser_drag", { startTarget: "e4", endTarget: "e6" }), "Dragged **e4** to **e6**");
});

test("a card number inside other text is masked; the name on a card is a name", () => {
  assert.equal(describe("browser_type", { element: "Comment", text: "ref 4242 4242 4242 4242 paid" }), "Typed `ref ••••42 paid` into **Comment**");
  assert.equal(describe("browser_type", { element: "Comment", text: "order 1234567890123 ok" }), "Typed `order 1234567890123 ok` into **Comment**", "digits that aren't a card number stay");
  assert.equal(describe("browser_type", { element: "Name on card", text: "Ada Lovelace" }), "Typed `Ada Lovelace` into **Name on card**");
  assert.equal(describe("browser_type", { element: "Card number", text: "4242424242424242" }), "Typed `••••42` into **Card number**");
});
