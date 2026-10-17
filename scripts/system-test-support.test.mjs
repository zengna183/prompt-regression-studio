import assert from "node:assert/strict";
import { test } from "node:test";
import { loadSample, testTargets } from "./system-test-support.mjs";

const valid = {
  TEST_SYSTEM_DATABASE_URL: "postgres://eval:eval@127.0.0.1/prs_system_test",
  TEST_SYSTEM_REDIS_URL: "redis://localhost:6379/15",
};
test("requires explicit disposable infrastructure; never reads application connection variables", () => {
  assert.throws(() =>
    testTargets({
      DATABASE_URL: valid.TEST_SYSTEM_DATABASE_URL,
      REDIS_URL: valid.TEST_SYSTEM_REDIS_URL,
    }),
  );
  assert.doesNotThrow(() => testTargets(valid));
  for (const value of [
    "postgres://localhost/eval_studio",
    "postgres://localhost/prs_system_test?host=remote",
    "postgres://remote/prs_system_test",
    "postgres://localhost/prs_system_test%2fother",
  ]) {
    assert.throws(() => testTargets({ ...valid, TEST_SYSTEM_DATABASE_URL: value }));
  }
  for (const value of ["redis://localhost/0", "redis://remote/15", "redis://localhost/15?db=0"]) {
    assert.throws(() => testTargets({ ...valid, TEST_SYSTEM_REDIS_URL: value }));
  }
});
test("bounded load sends exactly the requested count and records failures", async () => {
  let calls = 0;
  let active = 0;
  let peak = 0;
  const result = await loadSample(
    async () => {
      const id = ++calls;
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (id === 5) throw new Error("expected fixture fault");
    },
    23,
    4,
  );
  assert.equal(calls, 23);
  assert.equal(peak, 4);
  assert.equal(result.errors, 1);
});
