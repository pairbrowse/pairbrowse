export const meta = {
  name: 'design-understand',
  description: 'Map every PairBrowse UI surface (what renders it, how it gets state, what can be styled) for the design mission',
  whenToUse: 'At the start of a design session, or after large UI changes, to refresh docs/design-progress.md',
  phases: [{ title: 'Read', detail: 'one reader per UI surface' }, { title: 'Synthesize', detail: 'one map, decisions marked' }],
}

const SURFACES = [
  { key: 'chrome', files: 'scripts/browser.mjs (prepareProfile, THEME_COLORS, profile preferences), scripts/macos-app.mjs, scripts/native-engine.mjs launch args', ask: 'What of the browser window itself (tab strip, toolbar, colors, new tab, side panel pin) PairBrowse controls, through which mechanism (profile prefs, Chromium color theme, flags, the native build), and what it cannot touch.' },
  { key: 'panel', files: 'ui/panel/index.html, ui/panel/panel.css, ui/panel/panel.js, ui/common.js, ui/background.js, ui/manifest.json', ask: 'The side panel extension: its sections, state source (liveview SSE? messages from the helper?), update cadence, styling, what it shows per agent/participant/session, and every control it offers.' },
  { key: 'hud', files: 'scripts/hud/*.js (joined by scripts/hud/assemble.mjs), scripts/daemon/hud.mjs', ask: 'The in-page script: badge, bottom bar, join request, agent cursor, peers pointers, spark on tab icon; their CSS, how the helper drives them (call kinds), timers, and what state they can show.' },
  { key: 'liveview', files: 'scripts/liveview.html, scripts/liveview.css, scripts/liveview.js, scripts/liveview.mjs (routes and SSE events), ui/common.js', ask: 'The live view page for the Claude desktop workspace: layout, panels (tabs overview, activity, collaboration board, session, dev, record), events it receives, controls it posts, styling.' },
  { key: 'newtab-picker-screen', files: 'ui/newtab/*, ui/picker/*, ui/screen/*, ui/capture/* (index.html, capture.js, record.js)', ask: 'The new tab page, the session picker page, the shared-browser picture page and recording: what they show, their styling, and their state sources.' },
  { key: 'state', files: 'scripts/daemon/board.mjs, scripts/daemon/presence.mjs, scripts/daemon/pause.mjs, scripts/collaboration.mjs, scripts/daemon/journal.mjs, scripts/daemon/joinprompt.mjs, scripts/daemon/sharing.mjs (what reaches liveView.set*)', ask: 'The collaboration and session state the UI could show: participants and labels, who holds which tab, pause, statuses, activity items, the goal log (journal) as a lightweight timeline source, join requests and approvals, sessions. For each: where it lives, how the UI learns of changes (push vs poll), and what is already exposed to the panel/live view.' },
]

const MAP_SCHEMA = {
  type: 'object',
  required: ['surface', 'renderedBy', 'stateSources', 'updateMechanism', 'styling', 'controls', 'constraints', 'notes'],
  properties: {
    surface: { type: 'string' },
    renderedBy: { type: 'string', description: 'files and the mechanism (extension page, injected script, Chromium prefs, served page)' },
    stateSources: { type: 'array', items: { type: 'string' } },
    updateMechanism: { type: 'string', description: 'event-driven (SSE, messages) or polling, with intervals' },
    styling: { type: 'string', description: 'where the CSS lives, colors in use, fonts, any tokens or none' },
    controls: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' }, description: 'CSP, Trusted Types, what cannot be changed, perf-sensitive paths, tests that pin behaviour' },
    notes: { type: 'string' },
  },
}

phase('Read')
const maps = await pipeline(SURFACES, (s) => agent(
  `You are mapping one UI surface of PairBrowse (repo at the working directory) for a design redesign that must not regress performance, security or behaviour. Read-only. Surface: ${s.key}. Files to read: ${s.files}. Question: ${s.ask}\n` +
  `Also list the tests that cover this surface (grep test/ for its file names and tool names). Be exact: file paths with line numbers for every claim. Do not propose designs.`,
  { label: `read:${s.key}`, phase: 'Read', schema: MAP_SCHEMA, model: 'opus', effort: 'medium' }))

phase('Synthesize')
const synthesis = await agent(
  `You are the principal designer-engineer planning a redesign of PairBrowse toward a dark navy collaborative browser (left workspace sidebar optional, right agent panel, agent cursors, contextual approvals, session controls, hidden-by-default timeline; three modes Focus/Collaborate/Inspect). Zero regression in performance, security and behaviour is the top rule.\n` +
  `Here are maps of each UI surface, written by readers:\n${JSON.stringify(maps.filter(Boolean), null, 1)}\n\n` +
  `Write the "Surfaces" section of docs/design-progress.md as Markdown: for each surface, what it is, who renders it, its state source and update mechanism, its constraints, and a classification of the mockup's elements against it: EXISTS (where), REFINE (what), NEW (where it would live, which existing state feeds it), UNSUITABLE (why, e.g. native Chromium tab strip cannot be restyled from the plugin). End with a table "Mockup element -> surface -> classification". Keep every file:line reference from the readers. No fluff. Return only the Markdown.`,
  { label: 'synthesize', phase: 'Synthesize', model: 'fable', effort: 'high' })

return { maps: maps.filter(Boolean), synthesis }
