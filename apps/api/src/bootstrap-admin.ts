import { createDatabaseClient, createIdentityRepository } from "@ai-chat-eval/db";

// Deployment-only command. Do not pass passwords on the command line or print environment values.
const email = process.env.AUTH_BOOTSTRAP_EMAIL;
const password = process.env.AUTH_BOOTSTRAP_PASSWORD;
if (!email || !password) {
  console.error(
    "Set AUTH_BOOTSTRAP_EMAIL and AUTH_BOOTSTRAP_PASSWORD in the process environment before running this command.",
  );
  process.exitCode = 1;
} else {
  const client = createDatabaseClient();
  try {
    await createIdentityRepository(client.db).bootstrap(
      { email, password, displayName: process.env.AUTH_BOOTSTRAP_NAME || "平台管理员" },
      { claimExistingProjects: process.env.AUTH_BOOTSTRAP_CLAIM_EXISTING_PROJECTS === "true" },
    );
    console.log(
      "Administrator created. Remove the bootstrap password from your environment, then enable AUTH_MODE=team and restart the API.",
    );
  } catch {
    console.error(
      "Administrator creation failed. Check the database migration, password length (15-128 characters), and whether an account already exists. Existing accounts were not overwritten.",
    );
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}
