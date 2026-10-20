// The browser profiles' routes on the owner's port (spec server-mode D14, step 38): the person's
// own, the "session" right (no invite link, join code, hand-off grant or agent has it), each write
// from a same-origin page or the browser's own pages, as every owner write (liveview.mjs).
// startLiveView mounts them. profiles: the helper's profile operations
// (daemon/sessions/profile-owner.mjs), or null (404).
//   GET profiles.json: every profile (name, kind, revision, status, engine; never a setting) and
//     which profile each kept session is on.
//   POST profiles { op: "assign", session, profile }: a saved session that isn't open put on a
//     profile from its next start. { op: "validate", profile }: checked on the native build
//     installed now and held to it. 200 { ok, text, ... } or 409 { error }.
//   POST profile-import?source=&license=&terms=&name=&dryRun=1: the body is the file's bytes, at
//     most 1 MiB (413 past it, nothing parsed); 200 { ok, name, id, format, license, items } or
//     409 { error, items }. Never a value from the file in an answer but an applied setting's.
//   GET profile-export?profile=<name or id>&history=1&identity=1: 200 { fileName, text, sha256,
//     warnings } (the page saves text as the file) or 409 { error }.
import { json, plain, readJsonBody, readBytesCapped, BODY_MAX } from "../http.mjs";

const PARAM_MAX = 200;
const param = (q, k) => { const v = q.get(k); return v === null ? undefined : v.slice(0, PARAM_MAX + 1); };
const flag = (q, k) => q.get(k) === "1" || q.get(k) === "true";

export function createProfileRoutes({ profiles }) {
  return [
    { method: "GET", path: "profiles.json", right: "session", needs: () => profiles, handler: ({ res, rest }) => {
      if (rest.length) return plain(res, 404);
      json(res, 200, profiles.state());
    } },
    { method: "POST", path: "profiles", right: "session", needs: () => profiles, handler: async ({ req, res, rest }) => {
      if (rest.length) return plain(res, 404);
      const op = await readJsonBody(req, res, BODY_MAX.approve, { object: true });
      if (op === undefined) return;
      const r = op.op === "assign" ? profiles.assign(op.session, op.profile)
        : op.op === "validate" ? await profiles.validate(op.profile)
        : { error: 'A profile change is { op: "assign", session, profile } or { op: "validate", profile }.' };
      json(res, r.error ? 409 : 200, r);
    } },
    { method: "POST", path: "profile-import", right: "session", needs: () => profiles, handler: async ({ req, res, rest }) => {
      if (rest.length) return plain(res, 404);
      const bytes = await readBytesCapped(req, res, BODY_MAX.profileFile);
      if (bytes === null) return;
      const q = new URL(req.url, "http://x").searchParams;
      const host = { file: param(q, "file") || "upload.json", source: param(q, "source"), license: param(q, "license"), terms: param(q, "terms") ?? null, name: param(q, "name"), dryRun: flag(q, "dryRun") };
      const r = profiles.importFile(bytes, host);
      json(res, r.error ? 409 : 200, r);
    } },
    { method: "GET", path: "profile-export", right: "session", needs: () => profiles, handler: ({ req, res, rest }) => {
      if (rest.length) return plain(res, 404);
      const q = new URL(req.url, "http://x").searchParams;
      const r = profiles.exportOne(param(q, "profile"), { withHistory: flag(q, "history"), includeIdentity: flag(q, "identity") });
      json(res, r.error ? 409 : 200, r);
    } },
  ];
}
