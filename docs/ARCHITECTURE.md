# Architecture and verification boundaries

## Data flow

```text
Claude agent verdict
       │
       ▼
advance-workflow ──► validated ticket state ──► live shell
       │                     │
       │                     └── memory and arbitration history
       ▼
registered commands ──► clean revision + full-check receipts
       │
       ▼
approved plan + publication preconditions ──► GitLab / Jira / Slack
```

Agents interpret requirements and failures. The router owns the supported transitions,
loop accounting and escalation decisions. The legacy state patch API remains available
for recovery and bookkeeping; publication tools independently enforce their preconditions
even when a caller writes a cursor directly.

## Local storage

- `tickets/`: merge-patched YAML; a per-ticket filesystem mutex serializes writers and an
  atomic rename prevents truncated snapshots. Invariants apply after resolving patches.
- `events/`: replayable JSONL, written before broadcast. Both sides validate the same schema.
- `receipts/`: tool-produced approvals, command/revision proofs, remote bindings and
  publication operation journals. The state patch API cannot manufacture these proofs.
- `memory/`: versioned notes with explicit contradiction handling. Memory updates should be
  serialized across runs; this release does not add isolated memory transactions per ticket.

## Publication rules

Final publication requires the current approved contract, step 13, completed repositories,
passing exit checklists and successful full checks on their current clean commits. A MR
creation additionally requires a receipt for pushing that same revision.

Upstream publication requires step 10.7, a consumer in the approved scope and successful
local checks. CI must contain every required job in `success`; `manual`, `skipped` and
`canceled` do not prove execution. Matching the expected SHA prevents accepting a stale
pipeline. Tag pushes can be retried on the same commit, but cannot move an existing version.

Completed journaled operations can be replayed without repeating their effect. A response
lost after a non-idempotent request is an **unknown outcome**, not proof of failure. Such
operations stop for reconciliation rather than blindly posting twice. GitLab MR and Slack
channel creation also look for the existing target; Jira transitions recognize an already
reached status.

## What the checks establish

- Unit tests cover schema validation, persistence, routing helpers, transport behavior,
  command composition and live-shell state interpretation.
- Workflow tests exercise the actual tools, a real Git repository/remote and fake HTTP
  services. They include rejected publication, stale checks and retries.
- The MCP smoke test checks discovery and validation through the actual stdio server.
- Claude evals assess agent behavior separately. They are not a substitute for measured
  outcomes on representative real tickets, and are not included in deterministic CI.

## Remaining boundaries

This is a local development workflow, not an operating-system sandbox. The main Claude
session, locally configured commands, repository hooks and the filesystem remain trusted.
Agent tool allowlists are enforced by the client; MCP does not independently authenticate
which prompt made a call. Fixed-role commit tools and publication checks reduce accidental
bypasses, but do not isolate malicious local processes or compromised build scripts.

The system does not yet collect and process MR feedback automatically (workflow 2).
Memory learned before external review may therefore still need correction. There is no
published benchmark establishing a productivity or defect-rate improvement over a simpler
agent. Useful measurements are human editing time, accepted-without-rework rate, defects
found after review, total latency and cost per ticket, with task complexity recorded.
