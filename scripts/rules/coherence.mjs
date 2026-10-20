// Cross-phase consistency rules (spec server-mode E13; C13 here): what a browser says about itself
// that sites can see doesn't fit with something else they see. Each rule answers items
// { id, severity: "error" | "warning", text }, text one sentence for a person, naming codes and
// zones only, never an address. Step 32b lands the two locale rules the Network section's Test
// uses; step 35 the screen rule a profile import reports (D16); the graphics rules come with step 43.
//
// Pure; Node's standard library only.
import { countriesOf } from "./tzcountry.mjs";

const COUNTRY = /^[A-Z]{2}$/;
// A language tag's region ("en-US" -> "US", "zh-Hant-TW" -> "TW"), or null when it names none.
export const regionOf = (tag) => {
  const parts = String(tag || "").split(/[-_]/).slice(1);
  const r = parts.find((p) => /^[A-Za-z]{2}$/.test(p));
  return r ? r.toUpperCase() : null;
};

// The browser's time zone and languages against the country its traffic leaves from (the exit's
// `loc`). timezone: an IANA name; languages: tags, first preferred ("en-US", "de"); country: two
// capital letters. A rule that can't tell (no country, a zone of no country such as UTC, languages
// without a region) says nothing.
// - locale.timezone-vs-egress (error): the time zone isn't one used in the exit's country.
// - locale.language-vs-egress (warning): no language names the exit's country as its region.
export function localeVsEgress({ timezone = null, languages = [], country = null } = {}) {
  if (!COUNTRY.test(String(country || ""))) return [];
  const items = [];
  const zoneCountries = countriesOf(timezone);
  if (zoneCountries && !zoneCountries.includes(country)) {
    items.push({ id: "locale.timezone-vs-egress", severity: "error",
      text: `The browser's time zone ${timezone} is used in ${zoneCountries.join(", ")}, but this proxy's exit is in ${country}: sites can see the two don't match.` });
  }
  const regions = [...new Set((Array.isArray(languages) ? languages : [languages]).map(regionOf).filter(Boolean))];
  if (regions.length && !regions.includes(country)) {
    items.push({ id: "locale.language-vs-egress", severity: "warning",
      text: `The browser's languages name ${regions.join(", ")}, but this proxy's exit is in ${country}; that is common for travellers, but sites may notice.` });
  }
  return items;
}

// Screens people really have: ultrawide 32:9 is about 3.56 to 1, so anything wider is made up.
const MAX_ASPECT = 3.6;
// A screen of a profile (its CSS pixels, as profiles/schema.mjs holds it) as sites would see it.
// Warnings only (an import reports them and never refuses on them, D11):
// - screen.believable: wider or taller than any real screen, an available area under half of the
//   screen, more device pixels than any display (16384 a side), or a pixel ratio that isn't a
//   multiple of 0.25 (operating systems scale in those steps).
export function screenBelievable(screen) {
  if (!screen || typeof screen !== "object") return [];
  const { width, height, availWidth, availHeight, devicePixelRatio: dpr } = screen;
  if (![width, height].every((n) => Number.isFinite(n) && n > 0)) return [];
  const say = (text) => ({ id: "screen.believable", severity: "warning", text });
  const items = [];
  const aspect = Math.max(width, height) / Math.min(width, height);
  if (aspect > MAX_ASPECT) items.push(say(`A ${width}x${height} screen is ${aspect.toFixed(1)} times as wide as it is tall; no real screen is, and sites can see its size.`));
  if ((Number.isFinite(availWidth) && availWidth < width / 2) || (Number.isFinite(availHeight) && availHeight < height / 2)) {
    items.push(say(`Only ${availWidth}x${availHeight} of the ${width}x${height} screen is available to windows; a real desktop leaves most of it free.`));
  }
  if (Number.isFinite(dpr)) {
    if (Math.max(width, height) * dpr > 16384) items.push(say(`At a pixel ratio of ${dpr}, a ${width}x${height} screen has more device pixels than any display.`));
    if (Math.abs(dpr * 4 - Math.round(dpr * 4)) > 1e-9) items.push(say(`A pixel ratio of ${dpr} isn't one a system scales to (they step by 0.25).`));
  }
  return items;
}
