import { readFile } from "node:fs/promises";
import process from "node:process";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const paths = {
  bundleSchema: "contracts/regression-bundle/v1alpha1.schema.json",
  reportSchema: "contracts/diagnosis-report/v1alpha1.schema.json",
  pluginManifestSchema: "contracts/plugin-manifest/v1alpha1.schema.json",
  promptfooManifest: "plugins/official/promptfoo/prompt-regression-plugin.json",
  exampleBundle: "examples/missing-information-regression/regression-bundle.json",
};

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read JSON from ${path}`, { cause: error });
  }
}

function assertValid(validate, data, label) {
  if (validate(data)) {
    process.stdout.write(`valid: ${label}\n`);
    return;
  }

  const details = JSON.stringify(validate.errors, null, 2);
  throw new Error(`${label} violates its JSON Schema:\n${details}`);
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);

const [bundleSchema, reportSchema, pluginManifestSchema, exampleBundle, promptfooManifest] =
  await Promise.all([
    readJson(paths.bundleSchema),
    readJson(paths.reportSchema),
    readJson(paths.pluginManifestSchema),
    readJson(paths.exampleBundle),
    readJson(paths.promptfooManifest),
  ]);
const validateBundle = ajv.compile(bundleSchema);
const validateReport = ajv.compile(reportSchema);
const validatePluginManifest = ajv.compile(pluginManifestSchema);
assertValid(validateBundle, exampleBundle, paths.exampleBundle);
assertValid(validatePluginManifest, promptfooManifest, paths.promptfooManifest);

const reportPath = process.argv.slice(2).find((argument) => argument !== "--");
if (reportPath) {
  assertValid(validateReport, await readJson(reportPath), reportPath);
} else {
  process.stdout.write("valid: diagnosis report schema compiled in strict mode\n");
}
