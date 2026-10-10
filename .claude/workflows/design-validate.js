export const meta = {
  name: 'design-validate',
  description: 'The zero-regression gate for the design mission: lint, unit and live suites, the bench against the baseline, screenshot and lifecycle tests, accessibility and reduced-motion checks',
  whenToUse: 'After each design subset lands, and before any release',
  phases: [{ title: 'Suites' }, { title: 'Bench' }, { title: 'Verdict', model: 'fable' }],
}

const SUITE_SCHEMA = { type: 'object', required: ['command', 'pass', 'fail', 'skipped', 'failures'], properties: { command: { type: 'string' }, pass: { type: 'integer' }, fail: { type: 'integer' }, skipped: { type: 'integer' }, failures: { type: 'array', items: { type: 'string' } } } }
const BENCH_SCHEMA = { type: 'object', required: ['measures', 'regressions'], properties: { measures: { type: 'object', additionalProperties: true }, regressions: { type: 'array', items: { type: 'string' } } } }

phase('Suites')
const suites = await parallel([
  () => agent('Run `npm run lint` and `node --test test/*.test.mjs` (no runtime) in the working directory and report counts and every failing test name with its first assertion line. Change nothing.', { label: 'lint+unit', phase: 'Suites', schema: SUITE_SCHEMA, model: 'opus', effort: 'low' }),
  () => agent('Run `PAIRBROWSE_TEST_RUNTIME=$HOME/.pairbrowse/runtime node --test --test-reporter=spec test/*.test.mjs` (the full live suite, about 3 minutes, many browsers) and report counts and every failing test name with its first assertion line. One flake is known: form-patterns "a value a script rewrites 300 ms after the field is left" under load; if it fails, rerun that file alone and report both. Change nothing.', { label: 'live', phase: 'Suites', schema: SUITE_SCHEMA, model: 'opus', effort: 'low' }),
  () => agent('Run `npm run test:fuzz` and `claude plugin validate .` and report. Change nothing.', { label: 'fuzz+manifests', phase: 'Suites', schema: SUITE_SCHEMA, model: 'opus', effort: 'low' }),
])

phase('Bench')
const bench = await agent(
  'Run `PAIRBROWSE_TEST_RUNTIME=$HOME/.pairbrowse/runtime node test/bench.mjs --ops 60 --json /tmp/pb-design-bench.json` (several minutes, nothing else heavy meanwhile) and compare with the baseline table in docs/design-progress.md: idle CPU per process kind, click/snapshot/navigate p50, images sent for 20 repeated snapshots, helper RSS, cold start. Also run `node test/bench.mjs --soak 100 --viewers 1` and compare the browser CPU during the soak with the engineering-progress figure (22.7% with two viewers). Report each measure before/after and name regressions beyond ±10% (idle CPU: +0.2 points). Change nothing.',
  { label: 'bench', phase: 'Bench', schema: BENCH_SCHEMA, model: 'opus', effort: 'medium' })

phase('Verdict')
const verdict = await agent(
  `You are Fable, the lead. Suites: ${JSON.stringify(suites.filter(Boolean), null, 1)}\nBench: ${JSON.stringify(bench, null, 1)}\n` +
  'Also check by reading the diff (git diff main) that: no new screenshot capture or retention exists; no timer, interval, observer or animation runs while a panel is hidden; prefers-reduced-motion is honored by every transition added; every new control is keyboard reachable with an accessible name; the logo files are untouched; docs/security.md is still true. Write the "Done" and "Known regressions" entries for docs/design-progress.md as Markdown, and a one-word verdict line first: SHIP or HOLD, with reasons.',
  { label: 'verdict', phase: 'Verdict', model: 'fable', effort: 'high' })
return { suites, bench, verdict }
