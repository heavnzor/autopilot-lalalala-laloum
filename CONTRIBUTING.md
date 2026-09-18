# Contributing

This is an independently maintained derivative of
[Elie Laloum's autopilot](https://gitlab.com/e.laloum/autopilot), under the original MIT license.

## Development

- Node 22.18 or newer, pnpm 10.17.1 (declared in `packageManager`).
- `pnpm install --frozen-lockfile` installs the entire workspace.
- `pnpm verify` runs TypeScript, unit tests, workflow tests and the live-shell build.
- `pnpm demo` opens a local demo server using a disposable data directory.

The deterministic suite needs no external credentials. Its Git repositories and remotes
are real, temporary repositories; Jira, GitLab and Slack use local fixture servers.
`pnpm eval` is a separate Claude evaluation, not part of deterministic CI.

## Changes to workflow behavior

Add a regression case demonstrating an observable failure, then exercise the actual tool
or transport involved. A test which manually decides to escalate does not prove that the
router will escalate. Test rejection as well as successful execution, and test retries for
operations with remote effects.

- Tool schemas are executable contracts, validated by Ajv.
- Agent tool lists must agree with `mcp/registry.ts`.
- `shared/events.ts` is the event contract for both MCP and the live shell.
- A new publication tool must check the approved plan and verified revision, bind its
  target to the ticket, and define its retry behavior.
- Changes to tool arguments or receipt formats belong in `docs/MIGRATION.md`.

Configuration templates contain examples. Local `.env`, registry, configuration and voice
profiles remain gitignored. Keep upstream attribution when redistributing this project.
