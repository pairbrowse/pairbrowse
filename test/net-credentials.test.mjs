// A proxy's credentials (spec server-mode C3, scripts/net/credentials.mjs): reserved secret names
// made from the proxy's id, both needed, each long enough to be masked, and no message holding a value.
import "./helpers/home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { proxySecretNames, credentialsFor, NETWORK_ID } from "../scripts/net/credentials.mjs";
import { reservedSecret, validSecretName, RESERVED_MIN } from "../scripts/rules/secrets.mjs";

test("proxy secrets reserved: names from the id, upper-cased with - as _, within a secret name's length", () => {
  assert.deepEqual(proxySecretNames("us-east"), { username: "PAIRBROWSE_PROXY_US_EAST_USERNAME", password: "PAIRBROWSE_PROXY_US_EAST_PASSWORD" });
  const longest = "a".repeat(34);
  assert.ok(NETWORK_ID.test(longest));
  for (const id of ["p", "us-east", "0-9", longest]) {
    for (const name of Object.values(proxySecretNames(id))) {
      assert.ok(reservedSecret(name), `${name} is reserved (never typed into a page)`);
      assert.ok(validSecretName(name), `${name} is a valid secret name`);
    }
  }
  for (const id of ["", "US", "a_b", "-a", "a".repeat(35), null, 7]) assert.equal(proxySecretNames(id), null);
});

test("both credentials needed, each masked-long, never named by value", () => {
  const USER = "proxy-user", PASS = "pass-word-1";
  const values = { PAIRBROWSE_PROXY_US_EAST_USERNAME: USER, PAIRBROWSE_PROXY_US_EAST_PASSWORD: PASS };
  assert.deepEqual(credentialsFor("us-east", values), { username: USER, password: PASS });
  assert.equal(credentialsFor("us-east", {}).problem, 'network "us-east" needs PAIRBROWSE_PROXY_US_EAST_USERNAME and _PASSWORD in secrets.env');
  assert.equal(credentialsFor("us-east", { PAIRBROWSE_PROXY_US_EAST_USERNAME: USER }).problem, 'network "us-east" needs PAIRBROWSE_PROXY_US_EAST_USERNAME and _PASSWORD in secrets.env');
  const short = credentialsFor("us-east", { PAIRBROWSE_PROXY_US_EAST_USERNAME: "abc", PAIRBROWSE_PROXY_US_EAST_PASSWORD: "xyz" });
  assert.match(short.problem, new RegExp(`USERNAME and PAIRBROWSE_PROXY_US_EAST_PASSWORD in secrets\\.env are shorter than ${RESERVED_MIN} characters`));
  assert.ok(!short.problem.includes("abc") && !short.problem.includes("xyz"));
  const broken = credentialsFor("us-east", values, { fileProblem: "secrets.env is readable by other users; run chmod 600 on it." });
  assert.match(broken.problem, /can't be used: secrets\.env is readable by other users/);
  assert.equal(broken.username, undefined, "an unreadable file gives no credentials");
  assert.ok(credentialsFor("US_EAST", values).problem);
});
