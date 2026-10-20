// A channel's own fields in handoff.channels, checked against its sender's rules (spec server-mode
// B6): each sender declares fields as { name: rule }, a rule one of
//   { secret: true, required?, address?, pattern?, what? }  the name of a reserved secret
//     (PAIRBROWSE_..., in secrets.env) whose value is an https address (address) or matches pattern
//   { address: true, default }                               an https address written in config.json
//   { values: [...], default }                               one of these words
// A secret's value is read when a message goes (secretFor), so a token changed in secrets.env is
// used at once, and never appears in a problem, a warning or a log line: only its name does.
import { reservedSecret } from "../../rules/secrets.mjs";
import { addressProblem } from "./post.mjs";

// The value of secret name under rule: { value } or { error } (naming the secret, never its value).
// secret(name): the saved value or undefined.
export function secretFor(secret, name, rule = {}) {
  if (!reservedSecret(name)) return { error: `${JSON.stringify(String(name).slice(0, 60))} isn't a PAIRBROWSE_ secret name` };
  let value;
  try { value = secret(name); } catch { value = undefined; }
  if (typeof value !== "string" || !value) return { error: `${name} isn't saved in secrets.env` };
  if (rule.address) {
    const problem = addressProblem(value);
    if (problem) return { error: `${name} ${problem}` };
  }
  if (rule.pattern && !rule.pattern.test(value)) return { error: `${name} isn't ${rule.what || "in the form this channel takes"}` };
  return { value };
}

// A field's value as written, or its default.
export const fieldOf = (channel, fields, name) => (channel[name] === undefined ? fields[name]?.default : channel[name]);

// Why this channel can't be used: { problem: "" or the first reason, unknown: [field names] }.
// secret(name): the saved value of a secret, read now to check it is there and fits.
export function checkChannel(channel, sender, { secret }) {
  const fields = sender.fields || {};
  const unknown = Object.keys(channel).filter((k) => k !== "type" && !(k in fields));
  for (const [name, rule] of Object.entries(fields)) {
    const given = channel[name];
    if (rule.secret) {
      if (given === undefined) { if (rule.required) return { problem: `${name} (a PAIRBROWSE_ secret's name) is missing`, unknown }; continue; }
      if (typeof given !== "string" || !reservedSecret(given)) return { problem: `${name} isn't a secret name starting with PAIRBROWSE_ (credentials live in secrets.env, never in config.json)`, unknown };
      const read = secretFor(secret, given, rule);
      if (read.error) return { problem: read.error, unknown };
    } else if (rule.address) {
      const value = fieldOf(channel, fields, name);
      if (typeof value !== "string") return { problem: `${name} is an https address`, unknown };
      const problem = addressProblem(value);
      if (problem) return { problem: `${name} ${problem}`, unknown };
    } else if (rule.values) {
      const value = fieldOf(channel, fields, name);
      if (!rule.values.includes(value)) return { problem: `${name} is ${rule.values.map((v) => JSON.stringify(v)).join(", ").replace(/, ([^,]*)$/, " or $1")}`, unknown };
    }
  }
  return { problem: "", unknown };
}
