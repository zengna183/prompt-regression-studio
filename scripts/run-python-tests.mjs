import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { resolvePythonExecutable } from "./python-executable.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = resolvePythonExecutable(
  repositoryRoot,
  process.env.PROMPT_REGRESSION_TEST_PYTHON,
);
const result = spawnSync(
  executable,
  [path.join(repositoryRoot, "scripts", "run-python-tests.py")],
  {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true,
  },
);

if (result.error !== undefined) {
  process.stderr.write(`Could not start Python test runner: ${result.error.message}\n`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
