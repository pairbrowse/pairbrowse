// Fast mode's playbooks: saved step lists in ~/.pairbrowse/playbooks, and {{name}} substitution.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../paths.mjs";
import { slug } from "../runs.mjs";
import { readJson, writeJsonAtomic } from "../util.mjs";

const PLAYBOOKS = join(paths.home, "playbooks");
const playbookFile = (name) => join(PLAYBOOKS, `${slug(name, "playbook")}.json`);

export function listPlaybooks() {
  mkdirSync(PLAYBOOKS, { recursive: true, mode: 0o700 });
  return readdirSync(PLAYBOOKS).filter((f) => f.endsWith(".json")).map((f) => {
    const p = readJson(join(PLAYBOOKS, f));
    if (!Array.isArray(p?.steps)) return null;
    const vars = [...new Set(JSON.stringify(p.steps).match(/\{\{(\w+)\}\}/g) || [])].map((v) => v.slice(2, -2));
    return `${p.name} (${p.steps.length} steps${vars.length ? `; vars: ${vars.join(", ")}` : ""})`;
  }).filter(Boolean);
}

export function loadPlaybook(name) {
  return JSON.parse(readFileSync(playbookFile(name), "utf8")).steps;
}

export function savePlaybook(name, steps) {
  mkdirSync(PLAYBOOKS, { recursive: true, mode: 0o700 });
  writeJsonAtomic(playbookFile(name), { name, steps, savedAt: new Date().toISOString() });
}

export function substitute(value, vars = {}) {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (m, k) => {
      if (!Object.hasOwn(vars, k)) throw new Error(`missing var ${k}`); // not inherited: {{constructor}} is missing too
      return String(vars[k]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [substitute(k, vars), substitute(v, vars)]));
  return value;
}
