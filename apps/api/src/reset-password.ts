import { createDatabaseClient, resetAccountPasswordForDeployment } from "@ai-chat-eval/db";

// This command requires deployment/database access, not a public registration or reset endpoint.
// Secret values are accepted only from the environment, never command-line arguments or logs.
const email = process.env.AUTH_RECOVERY_EMAIL;
const password = process.env.AUTH_RECOVERY_PASSWORD;
const confirmedEmail = process.env.AUTH_RECOVERY_CONFIRM_EMAIL;
if (
  !email ||
  !password ||
  !confirmedEmail ||
  email.trim().toLowerCase() !== confirmedEmail.trim().toLowerCase()
) {
  console.error(
    "Set AUTH_RECOVERY_EMAIL, matching AUTH_RECOVERY_CONFIRM_EMAIL, and AUTH_RECOVERY_PASSWORD in the process environment. No account was changed.",
  );
  process.exitCode = 1;
} else {
  const client = createDatabaseClient();
  try {
    await resetAccountPasswordForDeployment(client.db, email, password);
    console.log(
      "Password reset and previous sessions revoked. Remove recovery secrets from the environment. The user should sign in and change this password.",
    );
  } catch {
    console.error(
      "Recovery failed. Check migrations, the active account email, and password length (15-128 characters). Disabled or unknown accounts cannot be recovered with this command.",
    );
    process.exitCode = 1;
  } finally {
    delete process.env.AUTH_RECOVERY_PASSWORD;
    await client.close();
  }
}
