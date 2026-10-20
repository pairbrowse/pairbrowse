// Cross-phase consistency rules (spec server-mode E13; scripts/rules/coherence.mjs). Step 32b's
// locale rules, which the Network section's Test reports (C13); the graphics and screen rules come
// with step 43.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { localeVsEgress, regionOf } from "../scripts/rules/coherence.mjs";
import { countriesOf } from "../scripts/rules/tzcountry.mjs";

test("Europe/Berlin with egress US is an error; language mismatch a warning", () => {
  const items = localeVsEgress({ timezone: "Europe/Berlin", languages: ["de-DE", "de"], country: "US" });
  assert.deepEqual(items.map((i) => [i.id, i.severity]), [["locale.timezone-vs-egress", "error"], ["locale.language-vs-egress", "warning"]]);
  assert.match(items[0].text, /Europe\/Berlin is used in DE.*exit is in US/);
  assert.deepEqual(localeVsEgress({ timezone: "Europe/Berlin", languages: ["de-DE"], country: "DE" }), []);
  assert.deepEqual(localeVsEgress({ timezone: "America/New_York", languages: ["en-US"], country: "US" }), []);
});

test("rules that can't tell say nothing", () => {
  assert.deepEqual(localeVsEgress({ timezone: "UTC", languages: ["en"], country: "US" }), [], "UTC and a language without a region");
  assert.deepEqual(localeVsEgress({ timezone: "Europe/Berlin", languages: ["de-DE"], country: null }), [], "no country");
  assert.deepEqual(localeVsEgress({ timezone: "Not/AZone", languages: [], country: "US" }), []);
  assert.equal(regionOf("zh-Hant-TW"), "TW");
  assert.equal(regionOf("en"), null);
});

test("the time zone table knows each zone by the name Intl gives it too", () => {
  assert.deepEqual(countriesOf("Europe/Berlin").includes("DE"), true);
  assert.deepEqual(countriesOf("Asia/Ho_Chi_Minh"), ["VN"]);
  assert.deepEqual(countriesOf("Asia/Saigon"), ["VN"]);
  assert.deepEqual(countriesOf("US/Eastern"), ["US"]);
  assert.equal(countriesOf("Etc/GMT+5"), null);
  assert.equal(countriesOf(""), null);
});
