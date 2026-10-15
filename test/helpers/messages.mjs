// The text of every message a source file returns or answers with, read from the source: each
// string or template literal in a `return` expression or an `error:` field, with pieces joined by
// `+` read as one message and a template's ${...} read as "…". Used by test/refusals.test.mjs.
// kinds: which to read ("return", "error", "problem": an `error:` or `problem:` field). Returns [{ line, text }], each once.
export function messagesIn(src, kinds = ["return", "error"]) {
  const out = [];
  const lineAt = (i) => src.slice(0, i).split("\n").length;
  // Skips a literal starting at i (quote char at src[i]); returns [end index, text].
  function literal(i) {
    const q = src[i];
    let j = i + 1, text = "";
    while (j < src.length && src[j] !== q) {
      if (src[j] === "\\") { text += src[j + 1]; j += 2; continue; }
      if (q === "`" && src[j] === "$" && src[j + 1] === "{") {
        let depth = 1; j += 2;
        while (j < src.length && depth) {
          if (src[j] === "\"" || src[j] === "'" || src[j] === "`") { j = literal(j)[0]; continue; }
          if (src[j] === "{") depth++; else if (src[j] === "}") depth--;
          j++;
        }
        text += "…";
        continue;
      }
      text += src[j++];
    }
    return [j + 1, text];
  }
  // Reads the expression from i to its end (a ; , or closing bracket at depth 0, or a line end
  // with no operator to carry on), collecting messages.
  function expression(i) {
    let depth = 0, cur = null, joined = false;
    const flush = () => { if (cur !== null && cur.text.trim()) out.push(cur); cur = null; };
    while (i < src.length) {
      const c = src[i];
      if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) break; continue; }
      if (c === "\"" || c === "'" || c === "`") {
        const [end, text] = literal(i);
        if (cur !== null && joined) cur.text += text; else { flush(); cur = { line: lineAt(i), text }; }
        joined = false;
        i = end;
        continue;
      }
      if (c === "+") { joined = true; i++; continue; }
      if (/\s/.test(c)) {
        if (c === "\n" && depth === 0 && !joined) {
          const rest = src.slice(i).match(/^\s*(\S)/)?.[1];
          if (!rest || !/[+?:.|&]/.test(rest)) break;
        }
        i++;
        continue;
      }
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) { if (depth === 0) break; depth--; }
      else if ((c === ";" || c === ",") && depth === 0) break;
      joined = false;
      i++;
    }
    flush();
  }
  const re = new RegExp(kinds.map((k) => k === "return" ? "\\breturn\\s+" : `\\b${k}:\\s*`).join("|"), "g");
  for (const m of src.matchAll(re)) expression(m.index + m[0].length);
  const seen = new Set();
  return out.filter((m) => { const k = `${m.line} ${m.text}`; return !seen.has(k) && seen.add(k); });
}
