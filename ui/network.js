// The Network section (spec server-mode C14): proxies a person adds, edits, tests and removes, the
// default, and each session's choice, over the owner-only routes GET network.json and POST network
// (scripts/liveview/routes/network.mjs). Settings and the live view's owner page (a phone) show it.
// The username and password are write-only: the page shows "saved" or "not set", never a value, and
// clears both fields after every save or test. Real clicks only; nothing ticks. Shared by the pages
// and the live view (common.js re-exports it; the live view serves it). A flat file at the ui/
// root; definitions only, nothing runs on import.
import { postReply, UNREACHABLE } from "./helper.js";
import { el } from "./dom.js";

const TYPES = [["http", "HTTP"], ["https", "HTTPS"], ["socks5", "SOCKS5"]];
const typeName = (t) => TYPES.find(([v]) => v === t)?.[1] || "?";
const real = (fn) => (ev) => { if (ev.isTrusted) fn(ev); };
const opt = (value, text, selected = false) => el("option", { value, textContent: text, selected });

// root: the section's container (emptied and filled here); base(): the live view address (null:
// not connected yet); shown(on): told whether there is a section to show (the page hides its
// heading with it). -> { load(), draw(summary) }: load reads network.json (false when it couldn't:
// an older helper has no such route, and the section stays hidden), draw shows a summary (GET
// network.json, the network event).
export function networkPanel(root, base, { shown = () => {} } = {}) {
  let state = null; // the summary drawn last
  let editing = null; // the proxy id being edited, "" while adding, null: no form
  const msg = el("p", { className: "msg", id: "net-msg" });
  msg.setAttribute("role", "status");
  msg.setAttribute("aria-live", "polite");
  const say = (text, kind = "") => { msg.textContent = text; msg.dataset.kind = kind; };
  const problem = el("p", { className: "net-problem", id: "net-problem", hidden: true });
  // Why secrets.env can't be used (every username and password then reads as not saved).
  const secretsProblem = el("p", { className: "net-problem", id: "net-secrets-problem", hidden: true });
  const list = el("ul", { className: "net-list", id: "net-list" });
  list.setAttribute("aria-label", "Proxies");
  const empty = el("p", { className: "empty", id: "net-empty", textContent: "No proxies yet. Every session connects directly.", hidden: true });
  const addBtn = el("button", { className: "action", type: "button", id: "net-add", textContent: "Add a proxy" });

  // The form, for adding or editing one proxy.
  const field = (id, label, input) => { input.id = id; return el("label", { className: "lab", htmlFor: id }, label, input); };
  const idIn = el("input", { className: "field mono", maxLength: 34, spellcheck: false, autocomplete: "off", placeholder: "e.g. us-east" });
  const typeIn = el("select", { className: "field" }, ...TYPES.map(([v, t]) => opt(v, t)));
  const hostIn = el("input", { className: "field mono", maxLength: 255, spellcheck: false, autocomplete: "off", placeholder: "203.0.113.10 or proxy.example.com" });
  const portIn = el("input", { className: "field num", type: "number", min: 1, max: 65535, step: 1, inputMode: "numeric", placeholder: "3128" });
  const authIn = el("input", { type: "checkbox", id: "net-auth" });
  const userIn = el("input", { className: "field", maxLength: 4096, spellcheck: false, autocomplete: "off" });
  const passIn = el("input", { className: "field", type: "password", maxLength: 4096, autocomplete: "new-password" });
  const credState = el("small", { className: "net-cred", id: "net-cred" });
  const creds = el("div", { className: "pair net-creds", id: "net-creds", hidden: true }, field("net-user", "Username", userIn), field("net-pass", "Password", passIn));
  const save = el("button", { className: "primary", type: "submit", id: "net-save", textContent: "Save" });
  const testBtn = el("button", { className: "action", type: "button", id: "net-test", textContent: "Test" });
  const cancel = el("button", { className: "action", type: "button", id: "net-cancel", textContent: "Cancel" });
  const formH = el("h4", { className: "net-form-h", id: "net-form-h" });
  const form = el("form", { className: "add net-form", id: "net-form", hidden: true, autocomplete: "off" },
    formH,
    el("div", { className: "pair" }, field("net-id", "Name", idIn), field("net-type", "Type", typeIn)),
    el("div", { className: "pair" }, field("net-host", "Host", hostIn), field("net-port", "Port", portIn)),
    el("label", { className: "check", htmlFor: "net-auth" }, authIn, el("span", { textContent: "Needs a username and password" })),
    creds, credState,
    el("div", { className: "acts" }, save, testBtn, cancel));
  form.setAttribute("aria-labelledby", "net-form-h");
  const result = el("div", { className: "net-result", id: "net-result", hidden: true });
  result.setAttribute("role", "status");
  result.setAttribute("aria-live", "polite");

  const defaultIn = el("select", { className: "field", id: "net-default" });
  const sessions = el("ul", { className: "net-list net-sessions", id: "net-sessions" });
  sessions.setAttribute("aria-label", "Each session's network");
  const choices = el("div", { className: "net-choices", id: "net-choices" },
    el("label", { className: "lab", htmlFor: "net-default" }, "Sessions without a choice of their own", defaultIn),
    sessions);
  root.replaceChildren(problem, secretsProblem, list, empty, el("div", { className: "acts" }, addBtn), form, result, choices, msg);

  async function post(body) {
    if (!base()) return { error: "Not connected to PairBrowse." };
    const r = await postReply(base() + "network", body);
    if (r.status === 200 && r.body) return r.body;
    return { error: r.body?.error ? String(r.body.error) : r.status === 0 ? UNREACHABLE : "That didn't save." };
  }
  const proxyIds = () => (state?.proxies || []).map((p) => p.id);
  function credLine(p) {
    if (!p?.auth) return "No username or password.";
    if (state?.secretsProblem) return "Username and password can't be read (secrets.env, above).";
    return `Username ${p.username ? "saved" : "not set"}, password ${p.password ? "saved" : "not set"}.`;
  }

  function draw(raw) {
    const s = raw && typeof raw === "object" && Array.isArray(raw.proxies) ? raw : null;
    state = s;
    root.hidden = !s;
    try { shown(!!s); } catch {}
    if (!s) return;
    problem.hidden = !s.problem;
    problem.textContent = s.problem || "";
    secretsProblem.hidden = !s.secretsProblem;
    secretsProblem.textContent = s.secretsProblem || "";
    list.replaceChildren(...s.proxies.map((p) => {
      const where = p.host ? `${typeName(p.type)} ${p.host}${p.port ? `:${p.port}` : ""}` : "Its address can't be read";
      const edit = el("button", { className: "mini", type: "button", textContent: "Edit", ariaLabel: `Edit ${p.id}` });
      const test = el("button", { className: "mini", type: "button", textContent: "Test", ariaLabel: `Test ${p.id}` });
      const del = el("button", { className: "mini", type: "button", textContent: "Remove", ariaLabel: `Remove ${p.id}` });
      const tools = [edit, test, del];
      const acts = el("span", { className: "net-acts" }, ...tools);
      edit.addEventListener("click", real(() => openForm(p)));
      test.addEventListener("click", real(() => runTest({ op: "test", id: p.id, type: p.type, host: p.host, port: p.port, auth: p.auth }, test)));
      del.addEventListener("click", real(() => {
        // An in-row question (pages in a window slot or a side panel get no confirm() dialog).
        const yes = el("button", { className: "mini bad", type: "button", textContent: "Remove", ariaLabel: `Yes, remove ${p.id}` });
        const keep = el("button", { className: "mini", type: "button", textContent: "Keep" });
        const back = () => { acts.replaceChildren(...tools); del.focus(); };
        keep.addEventListener("click", back);
        yes.addEventListener("click", real(async () => {
          yes.disabled = true;
          const r = await post({ op: "remove", id: p.id });
          if (r.error) { say(r.error, "error"); back(); return; }
          say(r.text, "ok");
          draw(r.network);
        }));
        acts.replaceChildren(el("small", { className: "ask", textContent: "Remove it?" }), yes, keep);
        keep.focus();
      }));
      const row = el("li", { className: "row net-proxy" },
        el("div", { className: "label", title: p.id }, p.id, el("small", { textContent: where })),
        el("div", { className: "sites", textContent: credLine(p) }), acts);
      row.dataset.id = p.id;
      if (p.problem) row.append(el("small", { className: "fail", textContent: p.problem }));
      return row;
    }));
    empty.hidden = s.proxies.length > 0;
    // The default and each session's choice.
    const ids = proxyIds();
    defaultIn.replaceChildren(opt("", "Connect directly", s.default === null), ...ids.map((id) => opt(id, id, s.default === id)));
    const defName = s.default ? `the default (${s.default})` : "the default (direct)";
    sessions.replaceChildren(...(s.sessions || []).map((x) => {
      const pick = el("select", { className: "field", ariaLabel: `Network for session ${x.name}` },
        opt("default", `Follow ${defName}`, x.choice === "default"), opt("direct", "Connect directly", x.choice === "direct"),
        ...ids.map((id) => opt(`proxy:${id}`, id, x.choice === "proxy" && x.id === id)));
      pick.addEventListener("change", async () => {
        const v = pick.value;
        const body = v.startsWith("proxy:") ? { op: "session", session: x.name, choice: "proxy", id: v.slice(6) } : { op: "session", session: x.name, choice: v };
        const r = await post(body);
        if (r.error) { say(r.error, "error"); draw(state); return; }
        say(r.text, "ok");
        draw(r.network);
      });
      const row = el("li", { className: "row net-session" }, el("div", { className: "label", title: x.name, textContent: x.name }), pick);
      row.dataset.session = x.name;
      return row;
    }));
    choices.hidden = !ids.length && !(s.sessions || []).some((x) => x.choice !== "default");
    for (const n of [addBtn, defaultIn, ...sessions.querySelectorAll("select")]) n.disabled = !!s.problem;
    if (editing && !ids.includes(editing)) closeForm();
  }
  defaultIn.addEventListener("change", async () => {
    const r = await post({ op: "default", id: defaultIn.value || null });
    if (r.error) { say(r.error, "error"); draw(state); return; }
    say(r.text, "ok");
    draw(r.network);
  });

  function showCreds() {
    creds.hidden = !authIn.checked;
    const p = editing ? state?.proxies.find((x) => x.id === editing) : null;
    passIn.placeholder = p?.password ? "Saved: leave empty to keep" : "Password";
    userIn.placeholder = p?.username ? "Saved: leave empty to keep" : "Username";
    credState.textContent = authIn.checked && p ? credLine(p) : "";
  }
  function openForm(p = null) {
    editing = p ? p.id : "";
    formH.textContent = p ? `Edit proxy ${p.id}` : "Add a proxy";
    idIn.value = p?.id || "";
    idIn.readOnly = !!p;
    typeIn.value = p?.type || "http";
    hostIn.value = p?.host ? p.host.replace(/^\[|\]$/g, "") : "";
    portIn.value = p?.port ? String(p.port) : "";
    authIn.checked = !!p?.auth;
    userIn.value = ""; passIn.value = "";
    form.hidden = false;
    result.hidden = true;
    showCreds();
    (p ? hostIn : idIn).focus();
  }
  function closeForm() {
    editing = null;
    form.hidden = true;
    userIn.value = ""; passIn.value = "";
  }
  // The form's fields as a body: the username and password only when typed.
  function formBody(op) {
    const body = { op, id: idIn.value.trim() || undefined, type: typeIn.value, host: hostIn.value.trim(), port: portIn.value.trim() ? Number(portIn.value) : null, auth: authIn.checked };
    if (authIn.checked && userIn.value) body.username = userIn.value;
    if (authIn.checked && passIn.value) body.password = passIn.value;
    return body;
  }
  addBtn.addEventListener("click", real(() => openForm()));
  cancel.addEventListener("click", real(() => { closeForm(); addBtn.focus(); }));
  authIn.addEventListener("change", showCreds);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = formBody(editing ? "edit" : "add");
    // Never kept in the page longer than needed.
    userIn.value = ""; passIn.value = "";
    save.disabled = true;
    say("Saving…");
    const r = await post(body);
    save.disabled = false;
    if (r.error) return say(r.error, "error");
    say(r.text, "ok");
    closeForm();
    draw(r.network);
  });
  testBtn.addEventListener("click", real(() => {
    const body = formBody("test");
    userIn.value = ""; passIn.value = "";
    runTest(body, testBtn);
  }));

  // A test's answer: the exit and its country, the leak verdict, any coherence item, and what only
  // a session's start checks.
  async function runTest(body, btn) {
    btn.disabled = true;
    say("Testing… (up to 10 seconds)");
    result.hidden = true;
    const r = await post(body);
    btn.disabled = false;
    if (r.error) return say(r.error, "error");
    say("");
    const ok = r.verdict === "ok";
    const exit = r.exit?.ip ? `Exit address ${r.exit.ip}${r.exit.country ? `, country ${r.exit.country}` : ", country unknown"}.` : "No exit address read.";
    const leak = r.sameAsDirect === true ? "Leak: the exit is this computer's own address." : r.sameAsDirect === false ? "No leak: the exit isn't this computer's own address." : ok ? "No leak found." : "";
    const lines = [
      el("p", { className: "net-verdict", id: "net-verdict", textContent: ok ? "Passed." : `Failed: ${r.reason || "the check didn't pass."}` }),
      el("p", { id: "net-exit", textContent: exit }),
      ...(leak ? [el("p", { id: "net-leak", textContent: leak })] : []),
      ...(Array.isArray(r.coherence) ? r.coherence : []).map((c) => el("p", { className: "net-warn", textContent: String(c?.text || "") })),
      ...(r.locale === "geoip" ? [el("p", { className: "help", textContent: "The time zone and languages follow the exit (geoip), so they match it." })] : []),
      el("p", { className: "help", textContent: String(r.note || "") }),
    ];
    result.dataset.kind = ok ? "ok" : "error";
    result.replaceChildren(...lines);
    result.hidden = false;
  }

  async function load() {
    if (!base()) return false;
    const r = await fetch(base() + "network.json", { signal: AbortSignal.timeout(8000) })
      .then(async (x) => ({ ok: x.ok, body: await x.json().catch(() => null) }), () => ({ ok: false, body: null }));
    if (!r.ok) { draw(null); return false; }
    draw(r.body);
    return true;
  }
  root.hidden = true; // until load or the network event draws a summary
  return { load, draw };
}
