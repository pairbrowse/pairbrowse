// Limits that two sides enforce, so each states them once: the helper and its pages, or the two
// helpers of a shared session. Pure numbers: no DOM, no Node API, nothing runs on import (the
// helper imports it in Node; the extension and the native build ship it as a flat file at the
// ui/ root). test/vocab.test.mjs checks how they fit together.

// ---- the capture page's channel (liveview/capture.mjs, ui/capture/transport-native.js) ----
// An answer's value as JSON, an offer's SDP and an error's text, in characters.
export const CAPTURE_VALUE_MAX = 1_500_000;
export const CAPTURE_SDP_MAX = 100_000;
export const CAPTURE_ERROR_MAX = 300;
// A recording comes over from the capture page in pieces this size, as base64 in one answer
// (daemon/recorder.mjs asks for them; the reply route's body cap, http.mjs BODY_MAX.capture, holds one).
export const PAGE_CHUNK_BYTES = 1024 * 1024;

// ---- files a joiner picks for the host's file dialog (ui/screen/screen.js, daemon/follow.mjs,
// daemon/remote-agents.mjs) ----
export const PICK_FILE_MAX = 50 * 1024 * 1024; // one file
export const PICK_TOTAL_MAX = 50 * 1024 * 1024; // all of one pick: it goes to the helper in one answer
export const PICK_FILES_MAX = 20; // files in one pick, and files kept per joiner on the host at once

// ---- joining from the session picker (ui/picker, ui/sessions, daemon/pick.mjs) ----
export const JOIN_NAME_MAX = 40; // the name the host sees
export const JOIN_CODE_MAX = 4000;

// ---- pictures and pointers ----
// Frames come as fast as they're acknowledged: at most one every FRAME_EVERY_MS (the live view's
// screencast, the shared tab's slower route).
export const FRAME_EVERY_MS = 33;
// A stream reader this far behind gets no new frames until it catches up; this far behind, it is
// cut (the page or the joiner reconnects). liveview.mjs and liveview/push.mjs.
export const FRAME_SKIP_BYTES = 1 << 20;
export const STALLED_BYTES = 16 << 20;
// A joiner's helper sends its person's pointer at most once every JOINER_POINTER_EVERY_MS; the
// host's refuses more than JOINER_POINTERS_PER_SECOND (follow.mjs, liveview/joiner-server.mjs).
export const JOINER_POINTER_EVERY_MS = 40;
export const JOINER_POINTERS_PER_SECOND = 40;

// ---- an agent's state, as the docks show it ----
// "Working" for this long after an agent's last action (ui/left, ui/right, ui/timeline).
export const DRIVING_MS = 8000;
