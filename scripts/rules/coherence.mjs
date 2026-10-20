// Cross-phase consistency rules (spec server-mode E13; C13 here): what a browser says about itself
// that sites can see doesn't fit with something else they see. Each rule answers items
// { id, severity: "error" | "warning", text }, text one sentence for a person, naming codes and
// zones only, never an address. Step 32b lands the two locale rules the Network section's Test
// uses; the graphics and screen rules come with step 43.
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
