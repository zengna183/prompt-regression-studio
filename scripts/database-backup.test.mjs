import assert from "node:assert/strict";
import { test } from "node:test";
import { connectionEnvironment } from "./database-backup.mjs";

test("restore cannot select production, remote, or redirected databases", () => {
  for (const url of [
    undefined,
    "postgres://localhost/eval_studio",
    "postgres://remote/prs_restore_test",
    "postgres://localhost/prs_restore_test?hostaddr=evil",
    "postgres://localhost/prs_restore_test%2Fextra",
    "postgres://localhost/prs_restore_test#ignored",
  ])
    assert.throws(() => connectionEnvironment(url, true));
  const env = connectionEnvironment(
    "postgres://eval:encoded%40password@localhost:5432/prs_restore_test",
    true,
    { PGHOSTADDR: "remote", PGSERVICE: "production", PATH: "test-path" },
  );
  assert.equal(env.PGPASSWORD, "encoded@password");
  assert.equal(env.PGHOSTADDR, undefined);
  assert.equal(env.PGSERVICE, undefined);
  assert.equal(env.PGDATABASE, "prs_restore_test");
});
test("remote backup always verifies server identity", () => {
  assert.equal(
    connectionEnvironment("postgres://u:p@database.example/db").PGSSLMODE,
    "verify-full",
  );
  assert.throws(() => connectionEnvironment("postgres://u:p@database.example/db?sslmode=disable"));
});
