// Cross-phase consistency rules (spec server-mode E13; scripts/rules/coherence.mjs). Step 32b's
// locale rules, which the Network section's Test reports (C13); step 35's screen rule, which a
// profile import reports (D16); the graphics rules come with step 43.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { localeVsEgress, regionOf, screenBelievable } from "../scripts/rules/coherence.mjs";
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

test("screen.believable: real screens pass; impossible shapes, areas, pixel counts and ratios warn", () => {
  const ids = (s) => screenBelievable(s).map((i) => [i.id, i.severity]);
  for (const s of [{ width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, devicePixelRatio: 1 }, { width: 1512, height: 982, availWidth: 1512, availHeight: 945, devicePixelRatio: 2 },
    { width: 5120, height: 1440, availWidth: 5120, availHeight: 1400, devicePixelRatio: 1 }, { width: 390, height: 844, availWidth: 390, availHeight: 844, devicePixelRatio: 3 }, { width: 1366, height: 768, devicePixelRatio: 1.25 }]) {
    assert.deepEqual(ids(s), [], JSON.stringify(s));
  }
  assert.deepEqual(ids({ width: 6000, height: 1000, availWidth: 6000, availHeight: 1000, devicePixelRatio: 1 }), [["screen.believable", "warning"]]);
  assert.match(screenBelievable({ width: 1920, height: 1080, availWidth: 1920, availHeight: 400, devicePixelRatio: 1 })[0].text, /Only 1920x400 of the 1920x1080 screen/);
  assert.match(screenBelievable({ width: 8000, height: 4000, availWidth: 8000, availHeight: 4000, devicePixelRatio: 3 })[0].text, /more device pixels than any display/);
  assert.match(screenBelievable({ width: 1920, height: 1080, availWidth: 1920, availHeight: 1080, devicePixelRatio: 1.1 })[0].text, /pixel ratio of 1.1 isn't one/);
  assert.deepEqual(screenBelievable(null), []);
  assert.deepEqual(screenBelievable({ width: 0, height: 10 }), []);
});
