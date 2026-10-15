// Reads (and with "write", first changes) a PairBrowse home with one version's own loaders, and
// prints what it found as JSON: test/upgrade.test.mjs runs it with the current scripts and with an
// older release's (git archive), each in a process of its own with PAIRBROWSE_HOME set.
// Usage: node home-read.mjs <scripts folder> [write]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dir, mode] = process.argv.slice(2);
const load = (rel) => import(pathToFileURL(join(dir, rel)).href);
const paths = await load("paths.mjs");
const sessions = await load("sessions.mjs");
const tabs = await load("tabs.mjs");
const facts = await load("facts.mjs");
const runs = await load("runs.mjs");
const secrets = await load(existsSync(join(dir, "rules", "secrets.mjs")) ? "rules/secrets.mjs" : "secrets.mjs");

if (mode === "write") {
  paths.saveConfig({ maxTabs: 14 });
  sessions.recordPerson("work", { who: "Cy Example", app: "Claude Code", kind: "agent" });
  runs.saveRun({ name: "Shop setup", done: ["Added shipping rates"] });
  const kept = facts.loadFacts();
  const { details } = facts.setFact(kept, { label: "Country", value: "Netherlands", source: "you" });
  facts.saveFacts(details);
}

const names = sessions.listSessions().map((s) => s.name).sort();
const out = {
  config: paths.loadConfig(),
  warnings: paths.CONFIG_WARNINGS ? [...paths.CONFIG_WARNINGS] : null,
  current: sessions.currentSession(),
  sessions: names,
  tabs: Object.fromEntries(names.map((n) => [n, tabs.readSavedTabs(sessions.tabsFile(n))])),
  people: Object.fromEntries(names.map((n) => [n, sessions.readPeople(n).map((p) => p.who)])),
  facts: facts.loadFacts().map((d) => `${d.label}: ${d.value}`),
  runs: runs.listRuns().map((r) => ({ name: r.name, done: r.done, left: r.left, yourTurn: r.yourTurn })).sort((a, b) => a.name.localeCompare(b.name)),
  review: runs.latestReview()?.site ?? null,
  secrets: Object.keys(secrets.loadSecrets(paths.paths.secrets).values),
};
process.stdout.write(JSON.stringify(out));
