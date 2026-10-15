#!/usr/bin/env node
// What Claude Code runs as the "browser" MCP server: a thin bridge between Claude Code (stdio)
// and the PairBrowse daemon (private socket). Starts the daemon when it isn't running, and
// reconnects transparently if the browser is restarted mid-session.
// The bridge itself lives in launcher/bridge.mjs; this entry's path is fixed (.mcp.json and the
// Codex plugin's mcp.json name it).
import { startBridge } from "./launcher/bridge.mjs";

startBridge();
