// Which processes keep the native browser from being updated (native/install.mjs openFrom): any
// program inside the app's Contents, but never the helper's own PairBrowse Agent there (it runs the
// helper that installs: counting it would block every update of the app it starts from).
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { openFrom } from "../scripts/native/install.mjs";

const app = "/Users/x/.pairbrowse/browser/PairBrowse.app";

test("the browser and its helper processes count", () => {
  assert.equal(openFrom([`${app}/Contents/MacOS/pairbrowse --flag`], app), true);
  assert.equal(openFrom([`  ${app}/Contents/Frameworks/PairBrowse Framework.framework/Helpers/PairBrowse Helper.app/Contents/MacOS/PairBrowse Helper --type=renderer`], app), true);
});

test("the helper's own PairBrowse Agent doesn't", () => {
  const agent = `${app}/Contents/Helpers/PairBrowse Agent.app/Contents/MacOS/PairBrowse Agent /opt/node /p/scripts/daemon.mjs`;
  assert.equal(openFrom([agent], app), false);
  assert.equal(openFrom([agent, `${app}/Contents/MacOS/pairbrowse`], app), true, "the browser beside it still does");
});

test("other apps and look-alike paths don't", () => {
  assert.equal(openFrom(["/Applications/Other.app/Contents/MacOS/x", `${app}x/Contents/MacOS/pairbrowse`, ""], app), false);
  assert.equal(openFrom([`/Users/x/.pairbrowse/browser/PairBrowse-previous.app/Contents/MacOS/pairbrowse`], app), false);
});
