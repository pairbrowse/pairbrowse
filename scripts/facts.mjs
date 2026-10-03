// What PairBrowse remembers about the person or company it fills forms for: details they
// entered in the Profile panel, details Claude was told, and values seen in forms (never
// passwords). Stored in ~/.pairbrowse/facts.json, private to the user. Also the pairbrowse_facts
// tool and the live view's Profile panel on top of them (createFacts).
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths.mjs";
import { setSecret, deleteSecret } from "./secrets.mjs";

export const FACTS_FILE = join(paths.home, "facts.json");
const MAX = 400;

const norm = (label) => String(label).trim().replace(/\s+/g, " ").toLowerCase();

export function cleanLabel(label) {
  const s = String(label ?? "").trim().replace(/\s+/g, " ");
  if (!s || s.length > 80 || /[\u0000-\u001f]/.test(s)) return null;
  return s;
}

export function cleanValue(value) {
  const s = String(value ?? "").replace(/\r\n?/g, "\n").trim();
  if (s.length > 2000 || /[\u0000-\u0008\u000b-\u001f]/.test(s)) return null;
  return s;
}

// Old facts.md lines like "- Legal name: ReplyBay B.V." become details once.
export function importMarkdown(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const m = line.match(/^\s*[-*]\s*([^:]{1,80}):\s*(.+?)\s*$/);
    if (m && cleanLabel(m[1]) && cleanValue(m[2])) out.push({ label: cleanLabel(m[1]), value: cleanValue(m[2]) });
  }
  return out;
}

// The details in file, or null when it's there but can't be read or isn't PairBrowse's format.
function readDetails(file) {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(data?.details) ? data.details : null;
  } catch (e) {
    return e.code === "ENOENT" ? [] : null;
  }
}

export function loadFacts(file = FACTS_FILE, log = () => {}) {
  if (existsSync(file)) {
    const details = readDetails(file);
    if (details === null) log(`${file} can't be read; nothing is remembered or saved until it's fixed or removed`);
    return details || [];
  }
  if (file === FACTS_FILE && existsSync(paths.facts)) {
    const imported = importMarkdown(readFileSync(paths.facts, "utf8")).map((d) => ({ ...d, source: "you", updatedAt: new Date().toISOString() }));
    if (imported.length) saveFacts(imported, file);
    return imported;
  }
  return [];
}

// Never over a file that's there but unreadable: it may hold details worth fixing by hand.
export function saveFacts(details, file = FACTS_FILE) {
  if (readDetails(file) === null) throw new Error(`${file} can't be read, so it isn't overwritten. Fix or remove it, then try again.`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify({ details: details.slice(-MAX) }, null, 2));
  renameSync(tmp, file);
}

// source: "you" (the Profile panel), "claude" (told in conversation), "form" (seen in a form).
// What the person set is never overwritten by what Claude or a form saw.
export function setFact(details, { label, value, source, site }) {
  const l = cleanLabel(label);
  const v = cleanValue(value);
  if (!l || !v) return { details, error: "A detail needs a short label and a value." };
  const rank = { you: 3, claude: 2, form: 1 };
  const i = details.findIndex((d) => norm(d.label) === norm(l));
  const entry = { label: l, value: v, source, ...(site ? { site } : {}), updatedAt: new Date().toISOString() };
  if (i === -1) return { details: [...details, entry] };
  if (rank[source] < rank[details[i].source] && details[i].value !== v) return { details };
  const next = [...details];
  next[i] = entry;
  return { details: next };
}

export function forgetFact(details, label) {
  return details.filter((d) => norm(d.label) !== norm(label));
}

function describeFacts(details) {
  if (!details.length) return "Nothing remembered yet.";
  return details.map((d) => `${d.label}: ${d.value}${d.source === "form" ? ` (seen in a form${d.site ? ` on ${d.site}` : ""})` : ""}`).join("\n");
}

// ---- the pairbrowse_facts tool and the Profile panel ---------------------------------------

export const FACTS_TOOL = {
  name: "pairbrowse_facts",
  description:
    'What PairBrowse remembers for filling forms. action "get": the remembered details (company, contact, addresses...) and the names of saved passwords with their sites. ' +
    '"remember" with details {label: value}: save details the user told you (never passwords). "forget" with labels: remove details. Read this before asking the user for anything.',
  inputSchema: {
    type: "object",
    required: ["action"],
    properties: {
      action: { type: "string", enum: ["get", "remember", "forget"] },
      details: { type: "object", additionalProperties: { type: "string" } },
      labels: { type: "array", items: { type: "string" } },
    },
  },
};

// secrets: the password store ({ get, save }, secretStore in secrets.mjs). onChange: after Claude
// or a form changed the details (the Profile panel refreshes itself).
export function createFacts({ secrets, log = () => {}, onChange = () => {}, file = FACTS_FILE }) {
  let facts = loadFacts(file, log);
  // Returns an error message, or null.
  const save = (next) => {
    try { saveFacts(next, file); } catch (e) { log(e.message); return e.message; }
    facts = next;
    return null;
  };
  const remember = (entry) => {
    const r = setFact(facts, entry);
    return r.error || save(r.details);
  };
  const forget = (labels) => save(labels.reduce(forgetFact, facts));

  // What the Profile panel shows: details in full, passwords by name and sites only.
  function summary() {
    const { values, domains, problem } = secrets.get();
    return { details: facts, secrets: Object.keys(values).sort().map((name) => ({ name, domains: domains[name] || [] })), problem };
  }

  // pairbrowse_facts. Returns { text, error }.
  function command({ action, details = {}, labels = [] } = {}) {
    const { values, domains } = secrets.get();
    if (action === "remember") {
      const problems = [];
      for (const [label, value] of Object.entries(details)) {
        if (Object.values(values).includes(String(value))) { problems.push(`${label}: looks like a saved password, not stored`); continue; }
        const error = remember({ label, value, source: "claude" });
        if (error) problems.push(`${label}: ${error}`);
      }
      onChange();
      if (!problems.length) return { text: `Remembered ${Object.keys(details).length} detail(s).` };
      const saved = Object.keys(details).length - problems.length;
      return { text: `${saved ? "Saved the rest. " : ""}Not saved: ${problems.join("; ")}`, error: !saved };
    }
    if (action === "forget") {
      const error = forget(labels);
      onChange();
      return error ? { text: error, error: true } : { text: `Forgot ${labels.length} detail(s).` };
    }
    const names = Object.keys(values);
    return { text: `${describeFacts(facts)}\n\nSaved passwords (type the NAME as the value): ${names.length ? names.map((n) => `${n} (${(domains[n] || []).join(", ")})`).join("; ") : "none. The user adds them in the Profile panel of the live view."}` };
  }

  // A value fast mode saw typed into a form.
  const seenInForm = (label, value, site) => { remember({ label, value, source: "form", site }); onChange(); };

  // What the live view's Profile panel calls.
  const profile = {
    get: summary,
    setDetail: (label, value) => remember({ label, value, source: "you" }),
    forgetDetail: (label) => forget([label]),
    setSecret: (input) => {
      const next = setSecret(secrets.get(), input);
      if (next.error) return next.error;
      secrets.save(next);
      log(`password ${input.name} saved from the Profile panel`);
      return null;
    },
    deleteSecret: (name) => { secrets.save(deleteSecret(secrets.get(), name)); log(`password ${name} deleted from the Profile panel`); },
  };

  return { command, seenInForm, summary, profile };
}
