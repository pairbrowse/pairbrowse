// Upload rules: which files go without asking (images, video and documents in the uploads folder)
// and which never go (keys, credentials, files with a private key or password inside). Read by the
// guard hook (uploadAllowed) and by pairbrowse_upload (uploadProblem) alike; pure file checks, no
// page code, so the hook loads nothing of the browser's.
import { realpathSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { paths } from "../paths.mjs";

// Images, video and documents: what uploads here, and through browser_file_upload without asking
// (uploadAllowed, below).
export const MEDIA = /\.(png|jpe?g|gif|webp|svg|ico|heic|avif|bmp|tiff?|mp4|mov|webm|m4v|pdf|csv|xlsx?|docx?|pptx?)$/i;
// Credentials and keys: never uploaded, whatever the page asks.
const SECRET_NAME = /(^|[\\/])(\.env(\..*)?|id_[a-z0-9]+(\.pub)?|.*\.(pem|p12|pfx|keychain-db|kdbx|asc|gpg)|credentials(\.json)?|secrets?\.(env|json|ya?ml)|\.netrc|\.npmrc|\.pypirc)$/i;
const SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".config/gcloud", ".kube", ".docker", "Library/Keychains", ".pairbrowse"];
// A key or .env saved under an innocent name (server.pem.png) is still a key: look inside.
const SECRET_CONTENT = /-----BEGIN ((RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----/;
// KEY=..., api_key = ..., "client_secret": "..." with a real-looking value (6+ characters).
const ENV_SECRET = /^\s*(export\s+)?["']?[A-Za-z][A-Za-z0-9_.-]*(key|secret|token|password|passwd)[A-Za-z0-9_.-]*["']?\s*[=:]\s*["']?[^\s"']{6,}/im;
const SCAN_BYTES = 1024 * 1024;

export function secretInside(full) {
  let fd;
  try {
    fd = openSync(full, "r");
    const buf = Buffer.alloc(SCAN_BYTES);
    const head = buf.subarray(0, readSync(fd, buf, 0, buf.length, 0));
    // UTF-16 text (a byte-order mark): read it as text, not as bytes with gaps.
    const utf16 = head[0] === 0xff && head[1] === 0xfe ? "utf16le" : head[0] === 0xfe && head[1] === 0xff ? "utf16be" : null;
    const text = utf16 === "utf16le" ? head.toString("utf16le") : utf16 === "utf16be" ? Buffer.from(head).swap16().toString("utf16le") : head.toString("latin1");
    if (SECRET_CONTENT.test(text)) return true;
    return (utf16 || !head.includes(0)) && ENV_SECRET.test(text); // text files only: binary media can hold anything
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// The path as the disk spells it: links followed and, on a case-insensitive disk (macOS, Windows),
// each name in its real casing, so ~/.SSH is caught as ~/.ssh.
export const realPath = (p) => realpathSync.native(resolve(String(p)));

export function uploadProblem(file, uploadsDir) {
  let full;
  try {
    full = realPath(file);
  } catch {
    return `${file}: not found`;
  }
  let home = homedir();
  try { home = realPath(home); } catch {}
  let uploads = resolve(uploadsDir);
  try { uploads = realPath(uploads); } catch {}
  const inUploads = full.startsWith(uploads + sep);
  if (!inUploads && SECRET_DIRS.some((d) => full.startsWith(join(home, d) + sep))) return `${file}: in a folder with keys or credentials; never uploaded`;
  if (SECRET_NAME.test(full)) return `${file}: looks like a key or credentials file; never uploaded`;
  if (secretInside(full)) return `${file}: contains a private key or password; never uploaded`;
  if (!MEDIA.test(full)) return `${file}: only images, video and documents upload here. For anything else use browser_file_upload, which asks the user`;
  return null;
}

// Judged where the file really is: a link in the uploads folder to a file or folder elsewhere
// is that file. A path that doesn't exist yet is judged as written.
export function uploadAllowed(p, uploadsDir = paths.uploads) {
  const real = (q) => { try { return realPath(q); } catch { return resolve(String(q)); } };
  const full = real(p);
  return full.startsWith(real(uploadsDir) + sep) && MEDIA.test(full) && !secretInside(full);
}

