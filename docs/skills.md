# Skills

**Always on.** At every session start, in Claude Code and in Codex, PairBrowse gives the agent a
short core (`scripts/core.md`, about 1,000 tokens): what PairBrowse is and that it uses only
PairBrowse's tools; the hard rules (no CAPTCHA solving, passwords only by name, links and join
codes only to you, your confirmation for pay, publish, delete and submit, wait while you use a tab,
one agent per tab); how to work (remembered details first, fast mode per page, hand-offs, saved
runs); and short step lists for sign-ups, listings, testing your own site and working together.
The plugin's `pairbrowse` skill is the longer reference behind it.

**Task skills.** The plugin also ships step-by-step skills for the same jobs, loaded only when a
task needs them: `pairbrowse-signup`, `pairbrowse-listing`, `pairbrowse-test-site` and
`pairbrowse-together`. They come with the plugin in Claude Code and Codex. To use them with other
agents that read skills, install them from this repository:

```bash
npx skills add pairbrowse/pairbrowse                            # all of them
npx skills add pairbrowse/pairbrowse --skill pairbrowse-signup  # one
```

**Companion skills** that go well with PairBrowse (registry results; check each before installing):

| Skill | Why |
|-------|-----|
| `vercel-labs/agent-skills@web-design-guidelines` | Layout and accessibility checks for what a site test finds. |
| `mattpocock/skills@diagnosing-bugs` | Root-causing the bugs a test run finds. |
| `obra/superpowers@systematic-debugging` | A disciplined debugging loop before proposing fixes. |
| `mattpocock/skills` writing-beats / writing-shape | Store descriptions and listing copy. |
| `vercel-labs/agent-skills@vercel-react-best-practices` | React and Next.js fixes. |
| `onmax/nuxt-skills@nuxt` | Nuxt fixes. |
| `anthropics/skills@frontend-design` | Visual design fixes. |

**Skills to avoid with PairBrowse** (registry results; check each before installing):

| Skill | Why |
|-------|-----|
| `vercel-labs/agent-browser@agent-browser` | Drives its own browser, so PairBrowse's guards (click confirmations, review gate, secret domains) don't apply. |
| `anthropics/skills@webapp-testing` | Drives its own Playwright browser, bypassing the same guards. |
| antibrow anti-detect / multi-account skills | Built for bulk accounts and evading bot detection, outside PairBrowse's [intended use](../README.md#intended-use). |
