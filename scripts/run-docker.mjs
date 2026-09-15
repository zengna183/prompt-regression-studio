import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error("Usage: node scripts/run-docker.mjs <docker arguments>");
  process.exit(2);
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveDockerExecutable() {
  if (process.platform !== "win32") {
    return "docker";
  }

  const candidates = [
    process.env.DOCKER_CLI_PATH,
    process.env.LOCALAPPDATA
      ? join(
          process.env.LOCALAPPDATA,
          "Programs",
          "DockerDesktop",
          "resources",
          "bin",
          "docker.exe",
        )
      : undefined,
    join(
      homedir(),
      "AppData",
      "Local",
      "Programs",
      "DockerDesktop",
      "resources",
      "bin",
      "docker.exe",
    ),
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) {
      return candidate;
    }
  }

  return "docker";
}

const executable = await resolveDockerExecutable();
const child = spawn(executable, args, {
  stdio: "inherit",
  shell: false,
});

child.on("error", (error) => {
  console.error(
    `Unable to start Docker (${executable}). Open Docker Desktop and wait for “Engine running”, then try again.`,
  );
  console.error(error.message);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`Docker stopped because of signal ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
