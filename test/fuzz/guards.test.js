// Property-based fuzzing of the guards that protect the user: which files may be uploaded, what is
// masked (saved passwords, card numbers, sensitive fields) and which clicks need the user's OK.
// Each property runs on thousands of generated inputs, including attacker-shaped ones.
// Run with: npm ci && npm run test:fuzz
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import fc from "fast-check";

// A home of our own, so the credential folders are real folders this test can fill.
const root = realpathSync(mkdtempSync(join(tmpdir(), "pb-fuzz-guards-")));
const home = join(root, "home");
mkdirSync(home);
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.PAIRBROWSE_HOME = join(home, ".pairbrowse");
after(() => rmSync(root, { recursive: true, force: true }));

const { uploadProblem, secretInside, MEDIA } = await import("../../scripts/upload.mjs");
const { looksLikeCard, shownValue, SENSITIVE, secretNamesIn, looksLikeSecretName, isRef, trimResult } = await import("../../scripts/policy.mjs");
const { redact, cleanDomains, validSecretName, nameFromLabel, parseSecrets, writeSecrets, setSecret } = await import("../../scripts/secrets.mjs");
const { decide, clickClass, uploadAllowed, CLICK_CLASSES } = await import("../../scripts/guard.mjs");
const { clickRule, dialogRule, strongSignal } = await import("../../scripts/clickrule.mjs");

// Values a tool's JSON arguments can carry where a string is expected.
const loose = fc.oneof(fc.string(), fc.integer(), fc.double(), fc.boolean(), fc.constant(null), fc.constant(undefined), fc.array(fc.string(), { maxLength: 3 }));
const RUNS = Number(process.env.PAIRBROWSE_FUZZ_RUNS) || 5000;
const check = (property) => fc.assert(property, { numRuns: RUNS });
// Properties that touch the disk run a tenth as often.
const checkDisk = (property) => fc.assert(property, { numRuns: Math.max(100, Math.round(RUNS / 10)) });

const uploads = join(home, ".pairbrowse", "files", "uploads");
mkdirSync(uploads, { recursive: true });
// Whether this disk treats ".SSH" and ".ssh" as one folder (macOS and Windows by default).
writeFileSync(join(root, "case-probe"), "");
const caseInsensitive = existsSync(join(root, "CASE-PROBE"));

const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker", "Library/Keychains", ".pairbrowse"];
const mediaExt = fc.constantFrom("png", "jpg", "jpeg", "gif", "webp", "pdf", "mp4", "mov", "csv", "docx", "xlsx", "pptx", "heic");
const segment = fc.stringMatching(/^[a-z0-9_-]{1,8}$/);
const randomCase = (s) => fc.array(fc.boolean(), { minLength: s.length, maxLength: s.length }).map((up) => [...s].map((ch, i) => (up[i] ? ch.toUpperCase() : ch.toLowerCase())).join(""));
let n = 0;
const fresh = () => join(root, `f${n++}`);
const put = (path, body = "x") => { mkdirSync(resolve(path, ".."), { recursive: true }); writeFileSync(path, body); return path; };

// ---- uploads ----------------------------------------------------------------------------------

test("a file in a credential folder is never uploaded, however the path is spelled", () => {
  checkDisk(fc.property(fc.constantFrom(...SECRET_DIRS), fc.array(segment, { maxLength: 3 }), segment, mediaExt, fc.integer({ min: 0, max: 2 ** 31 }), (dir, subs, base, ext, seed) => {
    const real = put(join(home, dir, ...subs, `${base}${n++}.${ext}`));
    assert.equal(uploadProblem(real, uploads) === null, false, real);
    // The same file through ./ and a//b, sub/.. and a trailing slash.
    const rel = real.slice(home.length + 1).split(sep);
    for (const spelled of [join(home, ".", ...rel), `${home}${sep}${sep}${rel.join(sep + sep)}`, join(home, rel[0], "x", "..", ...rel.slice(1)), `${real}${sep}`]) {
      assert.notEqual(uploadProblem(spelled, uploads), null, spelled);
    }
    // Other casing of the folder names: the same folder on a case-insensitive disk.
    if (caseInsensitive) {
      const odd = fc.sample(randomCase(rel.slice(0, -1).join(sep)), { numRuns: 1, seed })[0];
      assert.notEqual(uploadProblem(join(home, odd, rel.at(-1)), uploads), null, odd);
    }
    // Through a symlink that looks like an ordinary image, and through a linked folder.
    const link = join(fresh(), "holiday.png");
    mkdirSync(resolve(link, ".."));
    symlinkSync(real, link);
    assert.notEqual(uploadProblem(link, uploads), null, link);
    const linkedDir = fresh();
    symlinkSync(resolve(real, ".."), linkedDir);
    assert.notEqual(uploadProblem(join(linkedDir, rel.at(-1)), uploads), null, linkedDir);
  }));
});

test("key, password and credential files are never uploaded, whatever their casing or folder", () => {
  const secretName = fc.oneof(
    fc.constantFrom(".env", ".env.local", ".env.production", ".netrc", ".npmrc", ".pypirc", "credentials", "credentials.json", "secrets.yml", "secret.json", "secrets.env"),
    segment.map((s) => `id_${s.replace(/[-_]/g, "")}x`), segment.map((s) => `id_${s.replace(/[-_]/g, "")}x.pub`),
    fc.tuple(segment, fc.constantFrom("pem", "p12", "pfx", "keychain-db", "kdbx", "asc", "gpg")).map(([b, e]) => `${b}.${e}`),
  ).chain(randomCase);
  const lookalike = fc.constantFrom("", ".", "..", " ", "/", "​", "е"); // trailing dots, space, slash, zero-width, Cyrillic e
  checkDisk(fc.property(fc.array(segment, { maxLength: 3 }), secretName, lookalike, (subs, name, tail) => {
    const p = join(fresh(), ...subs, name);
    put(p, "harmless");
    if (tail) { try { put(p + tail, "harmless"); } catch { /* "/" names a folder */ } }
    assert.notEqual(uploadProblem(p, uploads), null, p);
    assert.notEqual(uploadProblem(p + tail, uploads), null, p + tail);
  }));
});

test("whatever passes the upload check is media, outside credential folders, with nothing secret inside", () => {
  const name = fc.tuple(fc.string({ maxLength: 12 }).map((s) => s.replace(/[\\/\0]/g, "") || "x"), fc.option(mediaExt)).map(([b, e]) => (e ? `${b}.${e}` : b));
  const body = fc.oneof(fc.string({ maxLength: 60 }), fc.constant("API_TOKEN=abcdef123456\n"), fc.constant("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
  checkDisk(fc.property(fc.option(fc.constantFrom(...SECRET_DIRS)), name, body, (dir, base, text) => {
    let p;
    try { p = put(join(dir ? join(home, dir) : fresh(), `${n++}`, base), text); } catch { return; } // a name the disk won't take
    if (uploadProblem(p, uploads) !== null) return;
    const full = realpathSync.native(p);
    assert.match(full, MEDIA);
    assert.equal(secretInside(full), false);
    for (const d of SECRET_DIRS) assert.ok(!full.toLowerCase().startsWith(join(realpathSync.native(home), d).toLowerCase() + sep), full);
  }));
});

test("a private key or a SECRET= line is found inside any text, in UTF-8 or UTF-16", () => {
  const key = fc.constantFrom("RSA ", "EC ", "DSA ", "OPENSSH ", "ENCRYPTED ", "").map((k) => `-----BEGIN ${k}PRIVATE KEY-----`);
  const env = fc.tuple(fc.constantFrom("", "export "), fc.stringMatching(/^[A-Z][A-Z0-9_]{0,6}$/), fc.constantFrom("KEY", "SECRET", "TOKEN", "PASSWORD", "api_key", "client_secret"), fc.constantFrom("=", " = ", ": "), fc.stringMatching(/^[A-Za-z0-9/+_]{6,30}$/))
    .map(([ex, pre, word, eq, v]) => `${ex}${pre}${word}${eq}${v}`);
  const filler = fc.string({ maxLength: 80 }).map((s) => s.replace(/\0/g, ""));
  checkDisk(fc.property(filler, fc.oneof(key, env), filler, fc.boolean(), (before, secret, rest, utf16) => {
    const text = `${before}\n${secret}\n${rest}`;
    const body = utf16 ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]) : Buffer.from(text);
    assert.equal(secretInside(put(join(fresh(), "doc.pdf"), body)), true, JSON.stringify(text));
  }));
});

test("an upload without asking stays inside the uploads folder, whatever ../ or links it holds", () => {
  const part = fc.oneof(segment, fc.constant(".."), fc.constant("."), fc.constant(""));
  check(fc.property(fc.array(part, { maxLength: 6 }), segment, mediaExt, (parts, base, ext) => {
    const p = `${uploads}/${parts.join("/")}/${base}.${ext}`;
    if (!uploadAllowed(p, uploads)) return;
    assert.ok(resolve(p).startsWith(uploads + sep), p);
  }));
  // A link in the uploads folder to a file or folder outside it.
  checkDisk(fc.property(fc.constantFrom(...SECRET_DIRS), segment, mediaExt, fc.boolean(), (dir, base, ext, viaDir) => {
    const outside = put(join(home, dir, `${base}${n++}.${ext}`), "harmless");
    const link = join(uploads, `l${n++}`);
    if (viaDir) symlinkSync(resolve(outside, ".."), link);
    else symlinkSync(outside, link + `.${ext}`);
    const p = viaDir ? join(link, outside.split(sep).at(-1)) : `${link}.${ext}`;
    assert.equal(uploadAllowed(p, uploads), false, p);
  }));
});

// ---- masking ----------------------------------------------------------------------------------

const luhnOk = (digits) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
};
// A valid card number: random digits and the Luhn check digit that completes them.
const card = fc.integer({ min: 13, max: 19 }).chain((len) => fc.array(fc.integer({ min: 0, max: 9 }), { minLength: len - 1, maxLength: len - 1 })).map((ds) => {
  const body = ds.join("");
  for (let c = 0; c < 10; c++) if (luhnOk(body + c)) return body + c;
  throw new Error("no check digit");
});
const separated = (digits) => fc.array(fc.constantFrom("", "", "", " ", "-", "  ", "\t", " ", " - "), { minLength: digits.length, maxLength: digits.length })
  .map((seps) => [...digits].map((d, i) => (i ? seps[i] : "") + d).join(""));

test("a card number is caught with any spacing or dashes, and only by its checksum", () => {
  check(fc.property(card.chain((c) => fc.tuple(fc.constant(c), separated(c), fc.constantFrom("", " ", "\n"))), ([digits, spaced, edge]) => {
    assert.equal(looksLikeCard(`${edge}${spaced}${edge}`), true, spaced);
    if (digits[0] !== "0" && Number.isSafeInteger(Number(digits))) assert.equal(looksLikeCard(Number(digits)), true, digits);
  }));
  // One digit changed: Luhn catches every single-digit change.
  check(fc.property(card, fc.nat(), fc.integer({ min: 1, max: 9 }), (digits, at, delta) => {
    const i = at % digits.length;
    const wrong = digits.slice(0, i) + ((Number(digits[i]) + delta) % 10) + digits.slice(i + 1);
    assert.equal(looksLikeCard(wrong), false, wrong);
  }));
  check(fc.property(fc.stringMatching(/^[0-9 -]{0,30}$/), (s) => {
    const digits = s.replace(/[\s-]/g, "");
    assert.equal(looksLikeCard(s), digits.length >= 13 && digits.length <= 19 && luhnOk(digits));
  }));
  check(fc.property(loose, (v) => { looksLikeCard(v); }));
});

const SENSITIVE_WORDS = ["password", "Passcode", "passphrase", "PIN", "otp", "one-time", "one time", "verification", "security code", "code", "token", "secret", "CVV", "cvc", "card", "expiry", "IBAN", "account number", "routing", "SSN", "social security", "passport", "tax id"];
const sensitiveLabel = fc.tuple(fc.constantFrom("", "Your ", "Enter ", "("), fc.constantFrom(...SENSITIVE_WORDS).chain(randomCase), fc.constantFrom("", ":", " *", " number", ")"))
  .map((p) => p.join(""));
// A saved password's NAME is shown on purpose (it is what Claude typed, not the password).
const notAName = (v) => !/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(v);

test("a sensitive field never shows its value, and a card number never shows in any field", () => {
  check(fc.property(sensitiveLabel, fc.string({ minLength: 3, maxLength: 40 }).filter(notAName), (label, value) => {
    assert.match(label, SENSITIVE);
    const shown = shownValue(label, value);
    assert.ok(!shown.includes(value), `${label}: ${JSON.stringify(value)} shown as ${JSON.stringify(shown)}`);
    assert.ok(shown.startsWith("••••") && shown.length <= 6, shown);
  }));
  check(fc.property(fc.string({ maxLength: 30 }), card.chain(separated), (label, value) => {
    const shown = shownValue(label, value);
    assert.ok(!shown.includes(value) && !shown.replace(/\D/g, "").includes(value.replace(/\D/g, "").slice(0, 6)), shown);
  }));
  check(fc.property(loose, loose, (label, value) => { shownValue(label, value); }));
});

test("only a saved password's name typed as a whole value counts as using it", () => {
  const nameArb = fc.stringMatching(/^[A-Z][A-Z0-9]{0,4}_[A-Z0-9_]{1,6}$/);
  const typed = fc.oneof(nameArb, fc.string({ maxLength: 12 }), fc.constant(null));
  check(fc.property(fc.array(nameArb, { maxLength: 4 }), fc.array(typed, { maxLength: 5 }), typed, (names, fieldValues, text) => {
    const fill = secretNamesIn("browser_fill_form", { fields: fieldValues.map((value) => ({ name: "x", value })) }, names);
    assert.deepEqual(fill, fieldValues.filter((v) => names.includes(v)));
    assert.deepEqual(secretNamesIn("browser_type", { text }, names), names.includes(text) ? [text] : []);
    assert.deepEqual(secretNamesIn("browser_click", { element: text, fields: fieldValues }, names), []);
    if (fill.length) assert.equal(looksLikeSecretName("browser_fill_form", { fields: fieldValues.map((value) => ({ value })) }), true);
  }));
});

test("only snapshot refs count as refs", () => {
  check(fc.property(fc.option(fc.nat()), fc.nat(), (frame, el) => assert.equal(isRef(`${frame === null ? "" : `f${frame}`}e${el}`), true)));
  check(fc.property(loose, (v) => {
    if (isRef(v)) assert.match(String(v), /^(f\d+)?e\d+$/);
  }));
  check(fc.property(fc.string({ maxLength: 12 }), (s) => assert.equal(isRef(s), /^(f\d+)?e\d+$/.test(s))));
});

test("trimming a tool result never throws and never makes it longer", () => {
  const section = fc.tuple(fc.constantFrom("### Open tabs\n", "### Events\n", "### Page\n", "### Snapshot\n", "", "- Console: x\n"), fc.string({ maxLength: 300 }), fc.option(fc.string({ minLength: 0, maxLength: 400 })))
    .map(([h, body, url]) => `${h}${body}${url === null ? "" : `\n  - /url: "${url}"\n`}`);
  check(fc.property(fc.constantFrom("browser_tabs", "browser_snapshot", "browser_click", "x"), fc.array(section, { maxLength: 6 }).map((s) => s.join("")), (tool, text) => {
    const out = trimResult(tool, text);
    assert.equal(typeof out, "string");
    assert.ok(out.length <= text.length, `${out.length} > ${text.length}`);
    if (tool !== "browser_tabs") assert.ok(!/^### Open tabs/m.test(out));
    assert.ok(!/^### Events/m.test(out));
  }));
  check(fc.property(fc.string(), fc.string(), (tool, text) => assert.ok(trimResult(tool, text).length <= text.length)));
});

// ---- saved passwords --------------------------------------------------------------------------

// Secrets and text from an alphabet the <secret>NAME</secret> tags don't use, so whatever is left
// of a value can only be the value itself.
const pw = fc.stringMatching(/^[wxyz]{4,10}$/);
const pwName = fc.stringMatching(/^[A-H]{1,4}$/);

test("a masked text shows no saved password, also with passwords inside or overlapping others", () => {
  check(fc.property(fc.dictionary(pwName, pw, { minKeys: 1, maxKeys: 5 }), fc.array(fc.oneof(pw, fc.stringMatching(/^[wxyz]{0,5}$/)), { maxLength: 8 }), (values, parts) => {
    const secrets = Object.values(values);
    const text = parts.concat(secrets).join("");
    const out = redact(text, values);
    for (const piece of out.split(/<secret>[A-H]+<\/secret>/)) for (const v of secrets) assert.ok(!piece.includes(v), `${v} shows in ${out}`);
  }));
  // A password that holds a shorter one is masked whole, under its own name.
  check(fc.property(pw, fc.stringMatching(/^[wxyz]{1,4}$/), fc.stringMatching(/^[wxyz]{0,4}$/), (short, pre, post) => {
    const long = `${pre}${short}${post}`;
    const out = redact(`a ${long} b`, { SHORT: short, LONG: long });
    assert.equal(out, "a <secret>LONG</secret> b", `${short} in ${long}`);
  }));
});

test("password sites are clean host names, whatever was typed", () => {
  check(fc.property(fc.string({ maxLength: 80 }), (typed) => {
    const r = cleanDomains(typed);
    if (r.error) return;
    assert.ok(r.domains.length > 0);
    assert.equal(new Set(r.domains).size, r.domains.length);
    for (const d of r.domains) {
      assert.equal(new URL(`https://${d}/`).hostname, d, d);
      assert.match(d, /^[a-z0-9.-]+$/);
    }
  }));
  const host = fc.domain().filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  check(fc.property(fc.array(host, { minLength: 1, maxLength: 4 }), fc.constantFrom("", "https://", "http://", "*.", "."), fc.constantFrom("", "/", "/login?x=1"), fc.constantFrom(",", " ", ", ", "\n"), (hosts, pre, post, glue) => {
    const r = cleanDomains(hosts.map((h) => `${pre}${h.toUpperCase()}${post}`).join(glue));
    assert.deepEqual(r.domains, [...new Set(hosts)]);
  }));
});

test("password names: valid ones look like SHOPIFY_PASSWORD, and labels turn into names", () => {
  check(fc.property(fc.string({ maxLength: 70 }), (s) => {
    if (validSecretName(s)) assert.ok(/^[A-Z][A-Z0-9_]{1,59}$/.test(s) && !s.endsWith("_DOMAINS"), s);
  }));
  check(fc.property(loose, (label) => {
    const name = nameFromLabel(label);
    assert.match(name, /^([A-Z][A-Z0-9_]*)?$/);
    assert.ok(name.length <= 60);
  }));
  check(fc.property(fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ]{1,40}[A-Za-z0-9]$/), (label) => {
    const name = nameFromLabel(label);
    if (!name.endsWith("_DOMAINS")) assert.equal(validSecretName(name), true, `${label} -> ${name}`);
  }));
});

test("saved passwords read back exactly as written, and a broken file never throws", () => {
  const file = join(root, "secrets.env");
  // Any value the Profile panel accepts.
  const value = fc.string({ minLength: 1, maxLength: 40, unit: fc.oneof(fc.string({ minLength: 1, maxLength: 1 }), fc.constantFrom('"', "'", "#", "=", " ", "\t", " ", " ", "\u0085", "é", "€")) });
  const nameArb = fc.stringMatching(/^[A-Z][A-Z0-9_]{1,12}$/).filter((x) => validSecretName(x));
  const host = fc.domain().filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  checkDisk(fc.property(fc.array(fc.tuple(nameArb, value, fc.array(host, { minLength: 1, maxLength: 3 })), { minLength: 1, maxLength: 4 }), (entries) => {
    let store = { values: {}, domains: {} };
    for (const [name, v, hosts] of entries) {
      const next = setSecret(store, { name, value: v, domains: hosts.join(",") });
      if (!next.error) store = next;
    }
    writeSecrets(file, store);
    assert.deepEqual(parseSecrets(readFileSync(file, "utf8")), store);
  }));
  check(fc.property(fc.array(fc.oneof(fc.string(), fc.stringMatching(/^ *(export )?[A-Za-z_][A-Za-z0-9_]*(_DOMAINS)? *= *["']?.*$/)), { maxLength: 8 }), fc.constantFrom("\n", "\r\n"), (lines, nl) => {
    const { values, domains } = parseSecrets(lines.join(nl));
    for (const [k, v] of Object.entries(values)) {
      assert.ok(!k.endsWith("_DOMAINS") && typeof v === "string" && v.length > 0, k);
      assert.ok(Array.isArray(domains[k]) && domains[k].every((d) => d && d === d.toLowerCase()), k);
    }
  }));
});

// ---- clicks and the hook ----------------------------------------------------------------------

const PREFIXES = ["mcp__plugin_pairbrowse_browser__", "mcp__pairbrowse_browser__"];
const NOW = Date.parse("2026-10-01T12:00:00Z");
const verdict = (tool_name, tool_input, review = null) => decide({ tool_name, tool_input }, {}, review, NOW).hookSpecificOutput.permissionDecision;
const plain = fc.oneof(fc.string({ maxLength: 20 }), fc.constantFrom("Next", "Pay now", "Note: pay", "Safe: x", ""));
// An element named with a class, in any casing, quoted or spaced.
const named = fc.tuple(fc.constantFrom("", " ", '"', "'", "“", "(", "["), fc.constantFrom(...CLICK_CLASSES).chain(randomCase), fc.constantFrom(":", " :", ":  "), fc.string({ maxLength: 20 }))
  .map(([lead, cls, colon, rest]) => `${lead}${cls}${colon}${rest}`);
const anyInput = fc.dictionary(fc.constantFrom("element", "startElement", "endElement", "accept", "paths", "url", "action", "role", "target", "text"), fc.jsonValue(), { maxKeys: 6 });

test("a click, drag or drop named with a class never goes without the user", () => {
  check(fc.property(fc.constantFrom(...PREFIXES), fc.constantFrom("browser_click", "browser_drag", "browser_drop"), named, plain, fc.constantFrom("element", "startElement", "endElement"), (prefix, tool, name, other, where) => {
    assert.notEqual(clickClass(name), "", name);
    const input = { element: other, startElement: other, endElement: other, [where]: name };
    if (tool === "browser_click") { delete input.startElement; delete input.endElement; input.element = name; }
    assert.notEqual(verdict(`${prefix}${tool}`, input), "allow", JSON.stringify(input));
  }));
  check(fc.property(fc.constantFrom(...PREFIXES), named, (prefix, name) => {
    assert.equal(verdict(`${prefix}browser_handle_dialog`, { accept: true, element: name }), "ask");
  }));
});

test("refused and asked-for tools stay so through either app's name, with any arguments", () => {
  check(fc.property(fc.constantFrom(...PREFIXES), anyInput, (prefix, input) => {
    for (const tool of ["browser_run_code_unsafe", "browser_webmcp_list", "browser_webmcp_call"]) assert.equal(verdict(`${prefix}${tool}`, input), "deny");
    assert.equal(verdict(`${prefix}browser_evaluate`, input), "ask");
  }));
  // The same verdict through Claude Code's and Codex's names; never an allow where the other refuses.
  check(fc.property(fc.constantFrom("browser_click", "browser_drag", "browser_drop", "browser_handle_dialog", "browser_navigate", "browser_tabs", "browser_file_upload", "pairbrowse_invite", "pairbrowse_session", "browser_type"), anyInput, (tool, input) => {
    const run = (prefix) => { try { return verdict(`${prefix}${tool}`, input); } catch { return "ask"; } }; // the hook asks when it throws
    assert.equal(run(PREFIXES[0]), run(PREFIXES[1]), `${tool} ${JSON.stringify(input)}`);
  }));
});

const risk = fc.record({
  level: fc.constantFrom("safe", "weak", "strong"),
  word: fc.constantFrom("", "pay", "delete", "submit", "send", "publish"),
  unreadable: fc.boolean(),
}, { requiredKeys: ["level", "word"] });

test("a click with strong signals is refused until it carries the class they found", () => {
  check(fc.property(risk, fc.oneof(plain, named), (r, element) => {
    const rule = clickRule(r, element);
    if (!strongSignal(r)) return assert.equal(rule, "go");
    const cls = clickClass(element);
    if (!cls) assert.equal(rule, "name", JSON.stringify([r, element]));
    if (["pay", "delete"].includes(r.word) && cls !== r.word) assert.equal(rule, "name", JSON.stringify([r, element]));
  }));
  check(fc.property(fc.boolean(), fc.constantFrom("", "pay", "delete", "submit", null), fc.oneof(plain, named), (accept, prev, element) => {
    const rule = dialogRule(accept, prev, element);
    if (accept && ["pay", "delete"].includes(prev) && clickClass(element) !== prev) assert.equal(rule, "name");
    if (!accept) assert.equal(rule, "go");
  }));
});
