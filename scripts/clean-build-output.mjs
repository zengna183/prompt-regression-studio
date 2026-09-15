import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";

const packageFile = resolve(process.cwd(), "package.json");
const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
const packageName = typeof packageJson.name === "string" ? packageJson.name : "";

if (!packageName.startsWith("@ai-chat-eval/") && !packageName.startsWith("@prompt-regression/")) {
  throw new Error("Refusing to clean build output outside a known workspace package.");
}

await rm(resolve(process.cwd(), "dist"), { recursive: true, force: true });
