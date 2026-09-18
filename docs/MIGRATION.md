# Migrating from upstream 2.0.0

## Install and run

Run `pnpm install --frozen-lockfile` at the repository root. The live shell is now a
workspace package; it no longer has its own lockfile. `pnpm verify` works without tokens.

For a source checkout, start Claude with the plugin directory explicitly:

```sh
claude --plugin-dir ./plugins/autopilot
```

This uses the source checkout and its installed dependencies. A cached marketplace copy
is a separate installation and must also have access to the project configuration and
dependencies; it is not the development/test path documented here.

## Tool argument changes

| Previous | Current |
|---|---|
| `create-commit` with a caller-supplied `role` | `create-code-commit` or `create-test-commit`; no `role` argument |
| Free-form `filter` | Prefer `packages: ["@acme/web"]`; legacy filter/scope flags accept exact package names only |
| GitLab MR / note / tag write without ticket | Pass `ticketId`; the target must belong to that ticket |
| Slack message / bookmark without ticket | Pass `ticketId`; the channel must have a creation receipt for that ticket |
| Arbitrary GitLab MR patch | Only labels, reviewer IDs and assignee IDs, in addition to title/description |
| Arbitrary Jira finalization fields | Assignee and labels; transitions use the configured target status |
| Notes posted again on resume | Reuse their `operationKey`; default Slack opening / Jira summary keys are stable |

`create-gitlab-note` requires `operationKey`. A confirmed operation returns its existing
result. Reusing a key with different content is rejected. An uncertain operation requires
inspection/reconciliation of the remote service; a new key is an intentional new effect.

## Approval and verification

A timestamp written into `plan.approvedAt` is no longer sufficient. `ask-plan-approval`
must receive its answer through MCP elicitation or the live shell. The textual fallback
can display the plan but cannot authorize publication; launch the live shell to finish
that gate. The submitted repositories must match `plan.repos` exactly.

An old run must pass this gate again once, to create its approval receipt. Its checklists
need `id`, `criterion` and, for multi-repository plans, `repo` on every line. Changing the
contract after approval invalidates that receipt. Updating checklist statuses does not.

After the last commit, run every declared check **without packages, filter or paths**.
`focus` only selects displayed output and does not invalidate a full-suite proof. A dirty
worktree, changed commit, changed approved plan or changed command requires new checks.

Before creating a MR, use `push-branch` on that verified commit. For upstream publication,
pass `ticketId` to `watch-gitlab-pipeline`; its expected SHA comes from the tag receipt.
`advance-workflow` will not finish 10.7 without the matching successful CI receipt.

## State and workflow

- Use `advance-workflow` with `expectedStep` after agent verdicts. It routes and increments counters; do not
  increment the same loop in a second `write-store-ticket` call.
- An outdated or concurrent transition is rejected atomically. Read the current cursor
  before resuming; never reinterpret an old verdict as the result of a new step.
- Incremental arbitrages should have stable IDs. Historical question-shaped rows remain
  mergeable by question; anonymous lists append instead of silently replacing earlier rows.
- For checklist IDs reused across repositories, include `repo` in partial updates.
- Counter replacement, deletion or negative increments cannot reset a consumed budget.
- The live shell uses the current cursor, including backward moves. Set `run.phase: done`
  only after all finalization actions succeed.
- `clear-run` invalidates local approval/verification receipts but preserves remote
  operation journals, because deleting local state does not undo remote effects.

YAML `schemaVersion` remains 1. New receipts live under `~/.autopilot/receipts/<ticket>/`.
They are local operational data, not agent-editable state or a new source of credentials.
