#!/usr/bin/env node
// The native browser's install step, by hand: node scripts/native-install.mjs <archive>. This path
// is fixed (the PairBrowse Pro repo's build scripts and install hints name it); the code lives in
// native/install.mjs.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInstallCli } from "./native/install.mjs";

export * from "./native/install.mjs";

const isMain = () => { try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; } };
if (process.argv[1] && isMain()) runInstallCli(process.argv.slice(2));
