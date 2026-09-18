# Changelog

## 2.1.0 — 2026-09-18

Independent hardening release of the upstream 2.0.0 project.

### Workflow and publication

- Server-side routing of structured verdicts, bounded loops and escalation.
- Approval receipts bound to the plan, scope, criteria, ticket snapshot and registry.
- Verification receipts bound to a clean Git revision, command and approved plan.
- Publication requires point 13, completed repositories and passing checklists.
- Upstream tags require point 10.7 and a downstream consumer in the approved scope.
- Separate code/test commit tools with fixed roles; read-only diff tool replaces agent Bash.
- Retriable same-commit tag pushes, normal fast-forward branch pushes, and MR target binding.
- Durable publication journal; non-idempotent HTTP requests are not retried blindly.
- Required CI jobs must all exist and succeed. Pagination and expected SHA are checked.

### State and reliability

- Lossless incremental arbitration storage, composite checklist identities and explicit replacement.
- Post-merge budget validation, monotone counters and serialized inter-process state writes.
- Full input/configuration schema validation; bounded command output and process cleanup.
- Ticket path validation, safer memory paths and calendar-date validation.
- A memory commit no longer stages other tickets' state.

### Live shell and development

- One shared event schema, including JSON and payload validation.
- Correct backward transitions, per-repository loop display and explicit completion state.
- Idempotent answer collection, ticket isolation, local-origin checks and bounded request bodies.
- Failed live-shell startup leaves no dead session; missing browser commands and invalid
  saved PIDs cannot crash the run or trigger unsafe process signals.
- One pnpm workspace/lockfile, a disposable demo and a single `pnpm verify` command.
- Regression tests, a real MCP transport smoke test and GitHub Actions on Node 22.18 / 24.

See [migration notes](docs/MIGRATION.md) for the intentional tool API changes.
