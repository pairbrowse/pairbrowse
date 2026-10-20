// The proxy credentials' command line (spec server-mode C3), run as
//   node scripts/net/credentials.mjs set <id>      the username, then the password, from stdin
//   node scripts/net/credentials.mjs remove <id>   both deleted
//   node scripts/net/credentials.mjs list          which proxies have them saved (names only)
// A value is never an argument (ps, shell history): at a terminal it is typed with echo off, else
// read from stdin's first two lines. It goes only to secrets.env (rules/secrets.mjs: the file
// checked first, then written whole through a 0600 temporary file and a rename, every other secret
// kept), under the reserved names net/credentials.mjs makes from the id. Nothing printed or
// returned holds a value. A running helper reads the file again when a session using the proxy
// starts, and Settings' Network section each time it is shown.
//
// Node's standard library only.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadSecrets, writeSecrets, setReservedSecret, deleteSecret, RESERVED_PREFIX } from "../rules/secrets.mjs";
import { proxySecretNames } from "./credentials.mjs";

export const USAGE = `Usage:
  node scripts/net/credentials.mjs set <id>      save a proxy's username and password (asked for, or two lines on stdin)
  node scripts/net/credentials.mjs remove <id>   delete them
  node scripts/net/credentials.mjs list          the proxies with credentials saved
<id> is the proxy's id in config.json's network.proxies (lower-case letters, digits and -).`;

// The longest line read from stdin when it isn't a terminal (two lines are used).
const INPUT_MAX = 64 * 1024;

// One line typed at a terminal with echo off (stdin in raw mode): Enter ends it, Backspace takes
// a character back, Ctrl-C or Ctrl-D before anything is typed gives null. prompt goes to out.
export function askHidden(prompt, { input = process.stdin, out = process.stderr } = {}) {
  return new Promise((resolve) => {
    out.write(prompt);
    let value = "";
    const done = (v) => {
      input.off("data", onData);
      try { input.setRawMode(false); } catch {}
      input.pause();
      out.write("\n");
      resolve(v);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return done(value);
        if (ch === "\u0003" || (ch === "\u0004" && !value)) return done(null);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });
}

// Everything on a stream that isn't a terminal, up to INPUT_MAX: { text } or { error }.
export function readAll(input = process.stdin) {
  return new Promise((resolve) => {
    let text = "";
    input.setEncoding("utf8");
    input.on("data", (d) => {
      text += d;
      if (text.length > INPUT_MAX) { input.destroy(); resolve({ error: "stdin is too long: give the username and the password, one line each." }); }
    });
    input.on("end", () => resolve({ text }));
    input.on("error", (e) => resolve({ error: `stdin couldn't be read (${e?.code || "error"}).` }));
  });
}

// The username and password: asked for at a terminal, else stdin's first two lines.
// { username, password } or { error }.
async function readCredentials(input, out) {
  if (input.isTTY && typeof input.setRawMode === "function") {
    const username = await askHidden("Username (not shown): ", { input, out });
    if (username === null) return { error: "Stopped; nothing was saved." };
    const password = await askHidden("Password (not shown): ", { input, out });
    if (password === null) return { error: "Stopped; nothing was saved." };
    return { username, password };
  }
  const read = await readAll(input);
  if (read.error) return read;
  const [username = "", password = ""] = read.text.split("\n").map((l) => l.replace(/\r$/, ""));
  if (!username || !password) return { error: "Give the username on stdin's first line and the password on its second." };
  return { username, password };
}

// The proxy ids with credentials in values, each { id, username, password } (true when saved).
export function savedProxies(values = {}) {
  const found = new Map();
  for (const name of Object.keys(values)) {
    const m = name.match(new RegExp(`^${RESERVED_PREFIX}PROXY_([A-Z0-9][A-Z0-9_]*)_(USERNAME|PASSWORD)$`));
    if (!m) continue;
    const id = m[1].toLowerCase().replaceAll("_", "-");
    if (!proxySecretNames(id)) continue;
    const entry = found.get(id) || { id, username: false, password: false };
    entry[m[2].toLowerCase()] = true;
    found.set(id, entry);
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// Runs one command (argv: what follows the script's path) against secrets.env at file. Prints to
// out and err; resolves the exit code (0 done, 1 refused or failed, 2 usage).
export async function runCredentialsCli(argv, { file, input = process.stdin, out = process.stdout, err = process.stderr } = {}) {
  const say = (s) => out.write(`${s}\n`);
  const fail = (s, code = 1) => { err.write(`${s}\n`); return code; };
  const [command, id, ...extra] = argv;
  if (command === "list" && id === undefined) {
    const now = loadSecrets(file);
    if (now.problem) return fail(now.problem);
    const list = savedProxies(now.values);
    if (!list.length) say("No proxy credentials are saved.");
    for (const p of list) say(`${p.id}: username ${p.username ? "saved" : "not set"}, password ${p.password ? "saved" : "not set"}`);
    return 0;
  }
  if (!["set", "remove"].includes(command) || extra.length) return fail(USAGE, 2);
  const names = proxySecretNames(id);
  if (!names) return fail(`That isn't a proxy id: give 1 to 34 lower-case letters, digits and -, as in config.json's network.proxies.\n${USAGE}`, 2);
  // The file is checked before anything is asked: one that can't be used is never written over.
  const before = loadSecrets(file);
  if (before.problem) return fail(`${before.problem} Nothing was saved.`);
  if (command === "remove") {
    if (!(names.username in before.values) && !(names.password in before.values)) { say(`No credentials are saved for proxy "${id}".`); return 0; }
    try {
      // The file as it is now (the helper or Settings may have changed it meanwhile).
      const now = loadSecrets(file);
      if (now.problem) return fail(`${now.problem} Nothing was removed.`);
      writeSecrets(file, deleteSecret(deleteSecret(now, names.username), names.password));
    } catch (e) { return fail(`secrets.env couldn't be written: ${e?.message || e}`); }
    say(`Removed ${names.username} and _PASSWORD from secrets.env.`);
    return 0;
  }
  const given = await readCredentials(input, err);
  if (given.error) return fail(given.error);
  const now = loadSecrets(file);
  if (now.problem) return fail(`${now.problem} Nothing was saved.`);
  let next = setReservedSecret(now, { name: names.username, value: given.username });
  if (next.error) return fail(`The username: ${next.error} Nothing was saved.`);
  next = setReservedSecret(next, { name: names.password, value: given.password });
  if (next.error) return fail(`The password: ${next.error} Nothing was saved.`);
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeSecrets(file, next);
  } catch (e) { return fail(`secrets.env couldn't be written: ${e?.message || e}`); }
  say(`Saved ${names.username} and _PASSWORD in secrets.env. A session using proxy "${id}" reads them when it next starts; config.json's network.proxies.${id} needs "auth": true.`);
  return 0;
}
