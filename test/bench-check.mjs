// The bench's budget check (test/bench.mjs --check <file>): pure, no browser, so it is unit tested.
// A budgets file names metrics by their path in one bench result ("click.p50"), each with a max,
// a unit and an optional scale (the raw value is divided by it: bytes to MB).

// The value at a dotted path, or undefined.
export function metricAt(result, path) {
  let v = result;
  for (const k of path.split(".")) { if (v == null || typeof v !== "object") return undefined; v = v[k]; }
  return v;
}

// Every budget's row: { metric, value, max, unit, pass }. A missing or non-numeric value fails, and
// so does a result that ended in an error (its numbers are not a whole run's).
export function checkBudgets(results, spec) {
  const list = Array.isArray(results) ? results : [results];
  const want = spec.screenshots ?? true;
  const result = list.find((r) => r && r.screenshots === want) ?? null;
  const rows = [];
  if (!result) return { pass: false, rows, error: `no bench result with screenshots ${want ? "on" : "off"}` };
  for (const [metric, b] of Object.entries(spec.budgets || {})) {
    const raw = metricAt(result, metric);
    const value = typeof raw === "number" && Number.isFinite(raw) ? Math.round((raw / (b.scale || 1)) * 10) / 10 : null;
    rows.push({ metric, value, max: b.max, unit: b.unit || "", pass: value !== null && value <= b.max });
  }
  const error = result.error ? `the bench run failed: ${String(result.error).split("\n")[0]}` : undefined;
  return { pass: !error && rows.length > 0 && rows.every((r) => r.pass), rows, ...(error ? { error } : {}) };
}

// One line per metric, then the verdict.
export function formatCheck({ pass, rows, error }) {
  const w = Math.max(6, ...rows.map((r) => r.metric.length));
  const lines = rows.map((r) => `${r.pass ? "pass" : "FAIL"}  ${r.metric.padEnd(w)}  ${r.value === null ? "missing" : `${r.value} ${r.unit}`.trim()}  (budget <= ${r.max} ${r.unit})`.trimEnd());
  if (error) lines.push(`FAIL  ${error}`);
  lines.push(pass ? "bench check: all budgets met" : `bench check: ${rows.filter((r) => !r.pass).length + (error ? 1 : 0)} miss(es)`);
  return lines.join("\n");
}
