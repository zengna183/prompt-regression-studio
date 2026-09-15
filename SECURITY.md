# Security Policy

## Project maturity and supported versions

Prompt Regression Studio is currently pre-alpha. Security updates are provided only on the latest revision of the default branch until the project publishes a version-support table.

The current milestone provides a deployment-wide bearer-token gate, rate limits, request-size limits, security headers, and safe public error boundaries. It does **not** provide user accounts, role-based authorization, tenant isolation, complete credential management, or mature SaaS hardening. Use it locally, on an isolated network, or as a controlled single-team deployment. Do not expose the development stack directly to the public internet or store production conversations and provider credentials in it.

## Reporting a vulnerability

Please do not open a public issue, discussion, or pull request that reveals an exploitable vulnerability or sensitive data.

Use GitHub's private vulnerability reporting flow:

1. open the repository's **Security** tab;
2. select **Report a vulnerability**;
3. include the affected revision, prerequisites, impact, a minimal reproduction, and any suggested remediation;
4. remove real credentials, customer conversations, and other personal data from the report.

If private vulnerability reporting is not enabled for the repository, contact a maintainer privately and ask for a secure reporting channel without disclosing the vulnerability details in public. The project will acknowledge receipt, assess severity and affected versions, coordinate a fix, and publish remediation information when users can act safely. As a pre-alpha volunteer project, it does not yet promise a contractual response time.

## Security-sensitive areas

Reports are especially valuable for:

- authentication or project/tenant-boundary bypass;
- provider-key exposure, weak encryption, or secret leakage in logs/errors;
- server-side request forgery through configurable model endpoints;
- SQL/command/template injection or unsafe file import/export;
- stored or reflected cross-site scripting in prompts, responses, or judge rationales;
- queue payload tampering, duplicate execution that corrupts data, or privilege escalation through jobs;
- prompt/response access outside the owning project;
- malicious spreadsheet/JSON dataset import, archive traversal, or denial of service;
- evaluator manipulation that is represented as a trusted score without evidence;
- dependency or build-pipeline compromise.
- a plugin manifest or entry point that causes unreviewed code to execute;
- diagnosis child-process argument, environment, output-size, timeout, or cancellation bypass.
- unauthorized access to persisted diagnosis bundles or reports, which may contain complete prompts, inputs, model outputs, and evaluator rationales.

Prompt injection in evaluated content is expected adversarial input. It becomes a security issue when it escapes the evaluator boundary, accesses secrets/tools, changes platform policy, crosses projects, or is presented as trusted system instruction.

## Deployment guidance

See the plain-language [security deployment guide](./docs/SECURITY_DEPLOYMENT.md) for the implemented controls, required environment variables, recommended topology, deployment checklist, and explicitly unresolved risks.

For any non-local deployment, at minimum:

- replace all sample PostgreSQL/Redis credentials;
- bind stateful services to private networks and require authenticated, encrypted connections;
- terminate TLS at a trusted proxy and set explicit origin/host policies;
- keep provider keys in a managed secret store and rotate them after suspected exposure;
- apply least privilege to database, object storage, and provider accounts;
- set request, token, concurrency, and spending limits;
- back up PostgreSQL and test restoration before relying on the data;
- keep prompts and model responses out of ordinary application logs;
- define retention and deletion rules for conversation data;
- scan dependencies, containers, source, and commits for vulnerabilities and secrets;
- upgrade only with reviewed migrations and a tested recovery plan.

The Docker Compose file and `.env.example` are development conveniences, not a hardened production deployment.

Python plugins run arbitrary code when imported. Manifest validation is data-only, but acknowledging the current in-process trust gate does not create a sandbox. Only load reviewed plugins from an approved source; run untrusted integrations behind an operating-system process or container boundary.

## Data and model safety

Evaluation data may contain personal, confidential, or regulated content. Deployers are responsible for obtaining permission to process it and for selecting compliant model providers and regions. Minimize collection, redact where possible, and make retention visible to users.

The current diagnosis store intentionally preserves the complete canonical input bundle for reproducibility. History-list responses omit that raw input, but database administrators and the detail/report path remain privileged data surfaces. Do not ingest production conversations until authentication, project ownership checks, encryption, retention, and deletion controls are enabled.

Automated judge output is untrusted model content. Parse it against a strict schema, render it as untrusted text, retain the evidence and evaluator version, and never execute code or follow instructions embedded in a model response.

## Coordinated disclosure and safe harbor

We ask reporters to make a good-faith effort to avoid privacy violations, data destruction, service disruption, and access beyond what is necessary to demonstrate the issue. Do not test against systems or data you do not own or have permission to use.

When research follows this policy, the maintainers will treat it as authorized good-faith activity and will work toward coordinated disclosure. This statement does not authorize activity prohibited by applicable law or third-party terms.
