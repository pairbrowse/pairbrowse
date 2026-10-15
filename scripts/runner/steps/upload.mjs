// An upload step: files into a field, an upload button or a drop zone.
import { uploadFiles } from "../../upload.mjs";

export async function upload({ page, arg, hooks, fail }) {
  // Like pairbrowse_upload: files from anywhere (checked, copied into the uploads folder),
  // into a field, an upload button or a drop zone.
  for (const [label, file] of Object.entries(arg)) {
    const r = await uploadFiles(page, { files: [file], target: label }, { uploadsDir: hooks.uploadsDir });
    if (!r.ok) return fail(r.text);
  }
  hooks.activity(`Uploaded ${Object.values(arg).map((p) => String(p).split(/[\\/]/).pop()).join(", ")}`);
}
