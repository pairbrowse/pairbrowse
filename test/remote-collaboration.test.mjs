import test from "node:test";
import assert from "node:assert/strict";
import { remoteCommand } from "../scripts/remote.mjs";

test("remote command keeps its legacy form without collaboration settings", () => {
  const { args } = remoteCommand({ remote: "user@example.com" }, {});
  assert.equal(args.at(-1), "PAIRBROWSE_ON_SERVER=1 node ~/.pairbrowse/plugin/scripts/launch.mjs");
});

test("forwards a quoted participant label from config or environment", () => {
  const fromConfig = remoteCommand({ remote: "user@example.com", participantName: "A name '$(touch /tmp/pwned)'" }, {});
  assert.equal(fromConfig.args.at(-1), "PAIRBROWSE_ON_SERVER=1 PAIRBROWSE_PARTICIPANT='A name '\\''$(touch /tmp/pwned)'\\''' node ~/.pairbrowse/plugin/scripts/launch.mjs");

  const fromEnv = remoteCommand({ remote: "user@example.com" }, { PAIRBROWSE_PARTICIPANT: "Remote user" });
  assert.match(fromEnv.args.at(-1), /PAIRBROWSE_PARTICIPANT='Remote user'/);
});

test("removes participant controls and caps labels at 60 characters", () => {
  const { args } = remoteCommand({ remote: "user@example.com", participantName: `a\n\tb${"x".repeat(100)}` }, {});
  const command = args.at(-1);
  assert.match(command, /PAIRBROWSE_PARTICIPANT='abx{58}'/);
});

test("forwards a validated, quoted remote home", () => {
  const { args } = remoteCommand({ remote: "user@example.com", remoteHome: "/srv/pair browse/it's-room" }, {});
  assert.equal(args.at(-1), "PAIRBROWSE_ON_SERVER=1 PAIRBROWSE_HOME='/srv/pair browse/it'\\''s-room' node ~/.pairbrowse/plugin/scripts/launch.mjs");
  assert.throws(() => remoteCommand({ remote: "user@example.com", remoteHome: "relative/path" }, {}), /absolute path/);
  assert.throws(() => remoteCommand({ remote: "user@example.com", remoteHome: "/srv/\0room" }, {}), /control characters/);
});
