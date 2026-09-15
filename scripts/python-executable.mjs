import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export function resolvePythonExecutable(repositoryRoot, override) {
  if (typeof override === "string" && override.trim().length > 0) {
    return override;
  }

  const projectPython =
    process.platform === "win32"
      ? path.join(repositoryRoot, ".venv", "Scripts", "python.exe")
      : path.join(repositoryRoot, ".venv", "bin", "python");

  if (existsSync(projectPython)) {
    return projectPython;
  }

  return process.platform === "win32" ? "python" : "python3";
}
