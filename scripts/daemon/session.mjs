// Moved to daemon/board.mjs (the shared session board); this path re-exports it for one release.
export * from "./board.mjs";
export { createBoard as createSession } from "./board.mjs";
