  // A field changed here (typed by a person or an agent, or set by the page): a shared tab's
  // helper reads the fields again at once instead of waiting for its next round.
  let dirtyAt = 0;
  const changed = () => { dirtyAt = now(); };
  addEventListener("input", changed, opts);
  addEventListener("change", changed, opts);

  // Which fields people edit: the times of real (trusted) input in each one. Agents' typing is
  // trusted too, so the helper drops times that fall in an agent's action. A field a person edits
  // stays theirs for a while: agents leave it alone. "claim": a person in the other browser of a
  // shared tab edited it (their value was just set here).
  const edits = new WeakMap(); // field -> { times: [], rw, rt }
  const editOf = (el) => { let x = edits.get(el); if (!x) edits.set(el, (x = { times: [], rw: "", rt: 0 })); return x; };
  const edited = (e) => {
    if (!e.isTrusted) return;
    const el = e.composedPath()[0];
    if (!el || el.nodeType !== 1) return;
    // A text field's "change" comes on leaving it, also after a value set from the other browser
    // of a shared tab: typing there fires "input" anyway, so only that counts.
    if (e.type === "change" && (el.tagName === "TEXTAREA" || el.isContentEditable || (el.tagName === "INPUT" && !/^(checkbox|radio|file|range|color)$/.test(el.type)))) return;
    const x = editOf(el);
    // Typing without key presses (pasting, dictation, the live view) is typing all the same. A
    // tick, a choice or a slider is a click (recorded by its press, judged by where it landed).
    const typed = el.isContentEditable || el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && !/^(checkbox|radio|file|range|color|button|submit|reset|image)$/i.test(el.type));
    if (typed && now() - (x.times.at(-1) || 0) > 1000) record("type", named(el));
    x.times.push(now());
    if (x.times.length > 8) x.times.shift();
  };
  addEventListener("input", edited, opts);
  addEventListener("change", edited, opts);
  function fields(el, kind) {
    if (!el || el.nodeType !== 1) return null;
    if (kind === "claim") return false;
    const x = edits.get(el);
    return { times: x ? x.times.slice() : [], rw: x?.rw || "", rt: x?.rt || 0, focused: focused() === el, name: named(el) };
  }
  function claim(v) {
    if (!Array.isArray(v) || !v[0] || v[0].nodeType !== 1) return false;
    const x = editOf(v[0]);
    x.rw = String(v[1] || "").slice(0, 60);
    x.rt = now();
    // For the agent's next result: which field they filled (its name, never the value).
    if (userEvents.length < 60) { userEvents[userEvents.length] = { t: now(), kind: "filled", what: named(v[0]), who: x.rw }; wake(); }
    return true;
  }
  function tickFrame() {
    const d = dirtyAt;
    dirtyAt = 0;
    return d;
  }

  if (window.top !== window) {
    // Frames only report input; the badge, bar and cursor live in the top page.
    Object.defineProperty(window, NAME, { value: (token, text, kind) => token !== TOKEN ? false : kind === "user" ? drainUser() : kind === "user-wait" ? waitUser(text) : kind === "tick" ? { dirty: tickFrame() } :
      kind === "owned" ? fields(text, kind) : kind === "claim" ? claim(text) : false, enumerable: false, writable: false, configurable: false });
    return;
  }
