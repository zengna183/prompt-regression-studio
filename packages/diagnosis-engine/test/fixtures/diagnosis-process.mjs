import process from "node:process";

const [mode, command, inputPath, compact, ...unexpected] = process.argv.slice(2);

if (
  command !== "diagnose" ||
  inputPath !== "-" ||
  compact !== "--compact" ||
  unexpected.length > 0
) {
  process.stderr.write("unexpected process arguments");
  process.exitCode = 64;
} else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString("utf8");

  switch (mode) {
    case "success": {
      const bundle = JSON.parse(input);
      process.stdout.write(JSON.stringify({ kind: "DiagnosisReport", received: bundle }));
      break;
    }
    case "environment": {
      process.stdout.write(
        JSON.stringify({
          kind: "DiagnosisReport",
          explicitValue: process.env.DIAGNOSIS_ENGINE_EXPLICIT ?? null,
          inheritedSecret: process.env.DIAGNOSIS_ENGINE_PARENT_SECRET ?? null,
        }),
      );
      break;
    }
    case "nonzero":
      process.stderr.write("sensitive-token=super-secret");
      process.exitCode = 7;
      break;
    case "invalid-input":
      process.stderr.write("sensitive-invalid-bundle-detail");
      process.exitCode = 2;
      break;
    case "hang":
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      process.stdout.write(JSON.stringify({ kind: "DiagnosisReport" }));
      break;
    case "large-output":
      process.stdout.write(JSON.stringify({ data: "x".repeat(32_000) }));
      break;
    case "large-stderr":
      process.stderr.write("sensitive=" + "x".repeat(32_000));
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      break;
    case "invalid-json":
      process.stdout.write("not-json");
      break;
    default:
      process.stderr.write("unknown fixture mode");
      process.exitCode = 64;
  }
}
