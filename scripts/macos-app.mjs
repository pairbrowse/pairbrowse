// A fixed path: the code lives in scripts/native/macos-app.mjs, and this re-export stays on purpose
// (the PairBrowse Pro repo's Linux build imports this path; test/structure.test.mjs ENTRY).
export * from "./native/macos-app.mjs";
