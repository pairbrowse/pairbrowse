// Fast mode's dates: a typed date as YYYY-MM-DD for date fields, and whether two dates are the same.

// A date written in a common way, as YYYY-MM-DD, or "" when it could mean two days.
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
export function isoDate(v) {
  const t = String(v).trim().toLowerCase();
  const pad = (n) => String(n).padStart(2, "0");
  const ok = (y, m, d) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1000 ? `${y}-${pad(m)}-${pad(d)}` : "");
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const [a, b, y] = [+m[1], +m[2], +m[3]];
    if (a > 12 && b <= 12) return ok(y, b, a); // 15/03/1990
    if (b > 12 && a <= 12) return ok(y, a, b); // 03/15/1990
    return a === b ? ok(y, a, b) : "";
  }
  m = t.match(/^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/) || t.match(/^(\d{1,2}) ([a-z]{3})[a-z]*\.?,? (\d{4})$/);
  if (m) {
    const [mon, day] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const i = MONTHS.indexOf(mon);
    return i >= 0 ? ok(+m[3], i + 1, +day) : "";
  }
  return "";
}

// The same date written the field's way (a shown "Fri, Nov 20" for a filled "Nov 20, 2026"): same
// month and day, and the same year when the field shows one.
// Both must read as a date (a month by name with a day, or day and month in figures): the
// browser's date reading takes almost anything ("nope 1234" is a date in year 1234).
const MONTH = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
const DATE_LIKE = new RegExp(`\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}\\.?\\s+${MONTH}|\\b\\d{1,2}[/.-]\\d{1,2}([/.-]\\d{2,4})?\\b|\\b\\d{4}-\\d{1,2}-\\d{1,2}\\b`, "i");
export function sameDate(a, b) {
  if (!DATE_LIKE.test(String(a)) || !DATE_LIKE.test(String(b))) return false;
  const weekday = /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+/i;
  const d = (t) => { const x = new Date(String(t).replace(weekday, "")); return isNaN(x) ? null : x; };
  const y = d(b);
  // A shown date without a year ("Fri, Nov 20") takes the typed one's to be read at all.
  const x = d(/\d{4}/.test(a) || !y ? a : `${String(a).replace(weekday, "")} ${y.getFullYear()}`);
  if (!x || !y || !/[A-Za-z]{3}|\d{1,2}[/.-]\d{1,2}/.test(a)) return false;
  return x.getMonth() === y.getMonth() && x.getDate() === y.getDate() && (!/\d{4}/.test(a) || x.getFullYear() === y.getFullYear());
}
