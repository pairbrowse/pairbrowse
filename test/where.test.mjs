// Where the browser runs (scripts/daemon/where.mjs): "Server" once the supervisor marked this
// helper as one (spec server-mode A11) or when it was started in an SSH session, else "Local".
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("Server after markServer or with SSH_CONNECTION", async () => {
  const saved = process.env.SSH_CONNECTION;
  try {
    delete process.env.SSH_CONNECTION;
    const { where, markServer } = await import("../scripts/daemon/where.mjs");
    assert.equal(where(), "Local");
    process.env.SSH_CONNECTION = "10.0.0.2 50000 10.0.0.1 22";
    assert.equal(where(), "Server", "started over SSH");
    delete process.env.SSH_CONNECTION;
    assert.equal(where(), "Local");
    markServer();
    assert.equal(where(), "Server", "marked by the supervisor in server mode");
    markServer();
    assert.equal(where(), "Server", "marking twice changes nothing");
  } finally {
    if (saved === undefined) delete process.env.SSH_CONNECTION; else process.env.SSH_CONNECTION = saved;
  }
});
