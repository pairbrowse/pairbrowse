export const meta = {
  name: 'design-subset',
  description: 'One subset of the PairBrowse design mission: Fable plans, Opus 5.5 builds, tests run, Fable reviews against the reference, Opus fixes (up to three rounds)',
  whenToUse: 'For each subset in docs/design-progress.md (tokens, hud, panel, liveview, modes): Workflow design-subset with args { subset, brief }',
  phases: [
    { title: 'Plan', detail: 'Fable: files, steps, acceptance checks, guardrails', model: 'fable' },
    { title: 'Build', detail: 'Opus 5.5: implement, lint, unit tests', model: 'opus' },
    { title: 'Check', detail: 'tests and a design review, in parallel' },
    { title: 'Fix', detail: 'Opus 5.5 fixes what the review names', model: 'opus' },
  ],
}

const subset = args?.subset
const brief = args?.brief || ''
if (!subset) throw new Error('args.subset is required (tokens | hud | panel | liveview | modes)')

const RULES = `Rules that override everything else:
- Zero regression: nothing of the measured performance, security or behaviour in docs/engineering-progress.md may get worse. No new timer, observer, poll or animation loop that runs while a panel is hidden or nothing changes; no new screenshot capture or retention anywhere; no new process; no new runtime dependency (Node standard library only outside runtime/); no change to scripts/rules/policy.mjs, scripts/rules/secrets.mjs, scripts/guard.mjs, the screenshot module or the click rules.
- The logo (scripts/browser/icon.svg, product-icon.svg, ui/logo.svg, icon PNGs, icns) is never redrawn or recolored.
- Security is the product: keep docs/security.md true; the live view and side panel stay under their CSP and Trusted Types; nothing in a page can drive the in-page script without its per-start key.
- No fabricated state in the UI: only what the helper really knows (statuses an agent set, the goal log's lines, participants, tabs, join requests). No "reasoning" text, no invented progress.
- Motion: short transitions only, honoring prefers-reduced-motion; no backdrop blur, glow, pulsing or animated gradients.
- Accessibility: keyboard reachable, visible focus, accessible names and roles, contrast at WCAG AA, state never by color alone.
- Keep scripts/core.md unchanged (its size and tool names are tested). Keep existing tests passing; add or update tests for behaviour you change; never weaken a test.
- Reference: the dark navy mockup described in docs/design-progress.md ("The reference, read closely"); tokens there.`

const PLAN_SCHEMA = {
  type: 'object',
  required: ['summary', 'files', 'steps', 'acceptance', 'tests', 'outOfScope'],
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' }, description: 'files to change or add, with what changes in each' },
    steps: { type: 'array', items: { type: 'string' }, description: 'ordered implementation steps, each small and checkable' },
    acceptance: { type: 'array', items: { type: 'string' }, description: 'observable checks a reviewer can make (what shows where, in which state)' },
    tests: { type: 'array', items: { type: 'string' }, description: 'commands to run and tests to add' },
    outOfScope: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['pass', 'findings'],
  properties: {
    pass: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'object', required: ['severity', 'where', 'what', 'fix'], properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] }, where: { type: 'string' }, what: { type: 'string' }, fix: { type: 'string' } } } },
  },
}
const TEST_SCHEMA = {
  type: 'object',
  required: ['lint', 'unit', 'failures'],
  properties: { lint: { type: 'string' }, unit: { type: 'string' }, live: { type: 'string' }, failures: { type: 'array', items: { type: 'string' } } },
}

phase('Plan')
const plan = await agent(
  `You are the principal designer-engineer (Fable) planning the "${subset}" subset of the PairBrowse design mission. Read docs/design-progress.md (the reference reading, the Surfaces map, the tokens, the subset list) and the code the subset touches. Brief for this subset: ${brief}\n${RULES}\n` +
  `Produce a plan an engineer can execute without asking: exact files, ordered steps, acceptance checks, tests to run and add, what is out of scope. Prefer the smallest change that reaches the reference's quality; reuse ui/common.js for shared code; one token sheet shared by the surfaces. Say which existing tests pin the behaviour you touch.`,
  { label: `plan:${subset}`, phase: 'Plan', schema: PLAN_SCHEMA, model: 'fable', effort: 'high' })
log(`plan: ${plan?.summary || 'none'}`)
if (!plan) throw new Error('no plan')

phase('Build')
let build = await agent(
  `Implement this plan in the working directory (branch design/collaborative-browser; commit nothing, the lead commits; never run git commit, git stash, git checkout or git reset). Plan: ${JSON.stringify(plan, null, 1)}\n${RULES}\n` +
  `Work step by step; after the code, run: npm run lint; node --test test/*.test.mjs (no runtime: live tests skip); and the specific tests the plan names. Fix what fails. Return: the files changed with one line each on what changed, the commands you ran with their pass/fail lines, and anything from the plan you could not do and why.`,
  { label: `build:${subset}`, phase: 'Build', model: 'opus', effort: 'medium' })
log('built')

for (let round = 1; round <= 3; round++) {
  phase('Check')
  const [tests, review] = await parallel([
    () => agent(
      `Run the checks for the "${subset}" subset on the working tree and report exactly. Commands: npm run lint; node --test test/*.test.mjs; PAIRBROWSE_TEST_RUNTIME=$HOME/.pairbrowse/runtime node --test ${(plan.tests || []).filter((t) => /test\//.test(t)).map((t) => t.match(/test\/\S+\.mjs/)?.[0]).filter(Boolean).join(' ') || 'test/hud.test.mjs test/liveview.test.mjs test/core.test.mjs test/skills.test.mjs test/manifests.test.mjs'}; claude plugin validate . . Report pass/fail counts and every failing test's name and first assertion line. Change nothing.`,
      { label: `test:${subset}:${round}`, phase: 'Check', schema: TEST_SCHEMA, model: 'opus', effort: 'low' }),
    () => agent(
      `You are Fable reviewing the "${subset}" subset build for design quality and the rules. Read docs/design-progress.md (reference reading and tokens), the plan: ${JSON.stringify(plan, null, 1)}, the builder's report: ${build}\n and the changed files (git diff). ${RULES}\n` +
      `Judge: does it reach the reference's quality (navy surfaces, compact typography, subtle borders, clear states, no clutter)? Are the acceptance checks met? Any rule broken (a new timer, blur, fabricated state, a weakened test, the logo touched)? Any accessibility miss? Findings with severity, where (file:line), what, and the exact fix. pass=true only with no blocker and no major.`,
      { label: `review:${subset}:${round}`, phase: 'Check', schema: REVIEW_SCHEMA, model: 'fable', effort: 'high' }),
  ])
  const failing = tests?.failures?.length ? tests.failures : []
  const findings = (review?.findings || []).filter((f) => f.severity !== 'minor')
  log(`round ${round}: tests ${failing.length ? failing.length + ' failing' : 'green'}, review ${review?.pass ? 'pass' : findings.length + ' findings'}`)
  if (!failing.length && review?.pass) return { subset, plan, build, tests, review, rounds: round }
  phase('Fix')
  build = await agent(
    `Fix the "${subset}" subset build in the working directory (commit nothing: the lead commits; never run git commit, git stash, git checkout or git reset). Failing tests: ${JSON.stringify(failing)}. Review findings (fix every blocker and major; minors if cheap): ${JSON.stringify(review?.findings || [], null, 1)}\n${RULES}\nThen run npm run lint and node --test test/*.test.mjs again. Return the files changed and the command results.`,
    { label: `fix:${subset}:${round}`, phase: 'Fix', model: 'opus', effort: 'medium' })
}
return { subset, plan, build, rounds: 3, note: 'three rounds used; the lead reviews what is left' }
