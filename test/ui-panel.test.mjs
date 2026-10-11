// The per-page template. A page subset copies this file as test/ui-<page>.test.mjs, gives
// pageTest the helper fixtures (fake-helper.mjs's names), the shim fixture (`shim: { tabs: [...] }`,
// deep-merged over defaultFixture()) and the replies it needs, drives the page through
// helper.push, helper.set, ctx.shim.* and inPage, and asserts through page.evaluate / until.
// The common checks stay in test/ui.test.mjs; never repeat them here.
import { pageTest } from "./helpers/ui-page.mjs";

pageTest("panel", { fixtures: { session: { name: "Checkout test", where: "Local", temporary: false } } }, async ({ until }) =>
  until("the session pill", () => document.getElementById("where").textContent === "Local · Checkout test"));
