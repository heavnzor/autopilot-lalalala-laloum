# autopilot lalalala laloum

[![CI](https://github.com/heavnzor/autopilot-lalalala-laloum/actions/workflows/ci.yml/badge.svg)](https://github.com/heavnzor/autopilot-lalalala-laloum/actions/workflows/ci.yml)

An independently maintained, hardened derivative of
[Elie Laloum's autopilot](https://gitlab.com/e.laloum/autopilot), based on upstream
commit `869d631`. The original MIT license and Git history are preserved.

## What this version adds

- Publication checks enforced by the server: approved contract, completed repositories,
  passing checklists and full checks tied to the current clean Git commit.
- Deterministic routing of agent verdicts and loop budgets through `advance-workflow`.
- Lossless incremental arbitration storage and inter-process state-write serialization.
- Fixed-role code/test commit tools, checked command arguments and strict CI job verdicts.
- Durable publication receipts, bounded HTTP retries and resumable same-commit tag pushes.
- A shared event contract and corrected live-shell handling of retries and backward steps.
- One pnpm workspace, reproducible installation, a disposable demo and GitHub Actions.

See [architecture and boundaries](docs/ARCHITECTURE.md),
[migration from upstream](docs/MIGRATION.md) and the [changelog](CHANGELOG.md).

## The workflow

An autonomous development workflow for [Claude Code](https://claude.com/claude-code). It takes
a Jira ticket and carries it to merge requests: scoping, one human gate, adversarial TDD
repository by repository in dependency order, memory capitalization, then publication in a
single block.

```
/autopilot-start <jira-url-or-key> [--notes "…"] [--figma <url>…] [--live]
```

On a ticket that already has a state file, the command **resumes** instead of starting over.

> **Read this first.** This is one developer's working system, opened up because the design
> may be useful to others — not a product. It assumes Jira, GitLab and Slack, and it was
> shaped against a specific codebase. Nothing here auto-detects your setup: repositories,
> commands and CI jobs are declared by hand in a registry file. Expect to adapt it, not to
> install it. The agent prompts and the live-shell design notes are in French.

## The three ideas that carry the rest

**Any action performed on every run, the same way, is a tool — not an agent instruction.** A
tool makes its implementation deterministic and testable. Its schema and results still
consume context; the gain is avoiding repeated procedural reasoning. Most of the surface
area can be tested without an LLM in the loop.

**Each agent has a narrow responsibility.** The `test-writer` commits tests through its
dedicated tool; the `developer` commits production code through another. Adversaries have
read-only tools, `memory-writer` handles knowledge, and `finalizer` performs guarded
publication. These workflow boundaries do not replace an operating-system sandbox.

**Contradicting the memory is a permitted outcome.** The scouts and the `developer` are given
a `contradict-memory` tool for when what they read does not match the actual code. That is the
mechanism that keeps the knowledge base from rotting.

## The loop

Three phases. **Scoping** (1→9) runs once and writes nothing outside the ticket state.
**Implementation** (10) is replayed for each repository, by ascending `level`, one repository
finished before the next is opened. **Capitalization and publication** (11→13) run once at the
end.

| # | Actor | Produces |
|---|---|---|
| 1-2 | tools | the ticket, the mockups (optional) |
| 3 | `doc-scout` | relevant memory, broad pass |
| 4 | `functional-grill` | functional rulings, unbounded turns |
| 5 | `scope-scout` | impacted repositories, with evidence |
| 6 | `doc-scout` | memory narrowed to the selected repositories |
| 7 | `technical-grill` | technical rulings |
| 8 | `planner` | the plan and the two exit checklists |
| 9 | **human gate** | **the only one in the workflow** |
| 10.1→10.7 | `test-writer` → `test-adversary` → `red-checker` → `developer` → `green-checker` → `code-adversary` → upstream publication | per repository |
| 11-12 | `memory-planner`, `memory-writer` | the memory plan, a single commit |
| 13 | `finalizer` | N cross-referenced MRs, one channel, one transition |

Once step 9 is approved, the workflow proceeds automatically. Publication tools independently
check that the approved contract still matches and that current commits passed full checks.
Claude Code's own tool permission policy also applies; the example permission file documents
the initial allowlist. Operational failures and unknown remote outcomes are escalated.

**Step 10.3 checks sensitivity to the new behavior**: a test intended to demonstrate a
missing behavior should fail before implementation. Existing-behavior regression tests may
already pass; a new API may first need its minimal interface scaffold.

## Where things live

**The project holds the code and the configuration** — it clones, it reads, it reviews.

```
autopilot/
├── autopilot.example.yaml      budgets, timeouts, naming, slack allowlist, jira transitions
├── repositories.example.yaml   the registry: level, commands, ci jobs, dependencies
├── .env.example                the tokens
├── plugins/autopilot/          the 15 agents, the skill, the tool server
│   ├── rules/voice.template.md the voice profile to fill in
│   └── evals/                  one eval suite per agent
├── tools/live-shell/           the live-mode app, tanstack start in ssr
│   ├── DESIGN.md               its design system, derived from what shipped
│   ├── PRODUCT.md              purpose and intended users of the live shell
│   └── .impeccable/            the design pass that produced it
├── shared/                     event and JSON contracts used on both sides
├── docs/                       architecture and migration notes
└── tests/                      unit/, workflow/, fixtures/
```

The `*.example.*` and `*.template.*` files are exactly that — templates. Copy each one to its
real name — `autopilot.yaml`, `repositories.yaml`, `.env`, `rules/voice.md` — and fill it in.
The real files are gitignored: they describe your infrastructure, your tokens and your own
writing voice, so they are never published. When one is missing the loader falls back to its
template, which is what lets a fresh clone run its test suite and `pnpm config:check` before
anything has been configured.

**`~/.autopilot` holds the knowledge and the state** — it does not clone, it accumulates.

```
~/.autopilot/
├── memory/                       the knowledge base, versioned
├── tickets/<ticket-id>.yaml      the tracking state, versioned
├── events/<ticket-id>.jsonl      the live-mode stream, disposable
├── locks/<ticket-id>             the run lock, disposable
├── receipts/<ticket-id>/          tool-produced approvals, checks and publication journal
└── worktrees/<ticket-id>/<repo>/ the worktrees, disposable
```

It is a git repository, but **everything in it is gitignored except `memory/` and `tickets/`**:
what gets versioned is what still has value after the run.

## Requirements

- **Node 22.18+** — the tool server runs TypeScript natively, with no build step.
- **pnpm 10.17.1**, the package-manager version declared by the workspace.
- **macOS or Linux** — command cleanup uses POSIX process groups.
- **Claude Code**, loading the local plugin directory from this checkout.
- **Jira Cloud**, **GitLab**, **Slack** — with a personal access token for each.
- **Figma** is optional. Without a token the `get-figma-*` tools report "no mockup" and the run
  continues; many tickets have none.

The Slack token is a **user** token (`xoxp-`), not a bot token: every action appears under your
own name. With a bot token the channel would be created by an app, and the point of the whole
thing — a colleague seeing that *you* opened the channel — falls away.

## Install

```sh
pnpm install --frozen-lockfile
cp .env.example .env                                # then fill in the tokens
cp autopilot.example.yaml autopilot.yaml            # budgets, naming, allowlist
cp repositories.example.yaml repositories.yaml      # your repositories
cp plugins/autopilot/rules/voice.template.md \
   plugins/autopilot/rules/voice.md                 # your writing voice — see below
pnpm config:check
claude --plugin-dir ./plugins/autopilot
```

This source-checkout command loads the code and dependencies you just installed. The
internal plugin name remains `autopilot`, so `/autopilot-start` and the MCP tool prefix
remain familiar. Follow [migration notes](docs/MIGRATION.md) when replacing an installed copy.

To inspect the live shell without configuring services:

```sh
pnpm demo
```

The demo uses a fresh temporary data directory, prints its local URL and cleans up on exit.
It does not use the real `~/.autopilot` directory.

`pnpm config:check` is the one command to run after any configuration change: it reads the
config, the registry and the environment, and reports what would break a run far from its
cause — an unreadable setting, an incoherent registry, a missing token.

## Adapting it to your own stack

For npm/pnpm/yarn codebases using Jira, GitLab and Slack, most adaptation happens in
`repositories.yaml`. Other package managers or forges require additional adapters.

**Declare each repository** with its `level`, its local path, its GitLab project, its base
branch and its dependencies. `level` carries the processing order: an upstream repository has a
strictly lower level than anything depending on it, and the loader refuses a registry where a
dependency flows the wrong way.

**Declare each command** — `lint`, `typecheck`, `ut`, `it`, `ft`, `ct`, `e2e`. `null` means
"this kind of check does not exist here", and it is a prohibition, not a gap: an agent that
finds `null` escalates instead of inventing a command. Never put a plausible but unverified
command in the registry — a test you believe you are running and that never runs is worse than
no test at all.

A few keys exist because their absence cost real hours: `reports` says where a command writes
its diagnostics when it does not write them to stdout, `containers` says what must be up before
the first test, `localFiles` says which gitignored config files to carry into a fresh worktree,
`targeting` says how a runner accepts being pointed at specific files, and `withoutTests: true`
marks a repository that deliberately has no suite — so that commands silently disappearing from
the registry is caught by the test suite rather than by a run.

Naming, branch and MR templates, Jira transitions and the Slack allowlist live in
`autopilot.yaml`. Committer identity is `git.committer` there; leave it commented out and
commits are signed with the machine's own git identity.

## Your writing voice

Step 13 publishes under **your own name** — a Slack channel, a Jira comment, a reply in an MR
thread. A message that reads as machine-written is worse than no message at all, so the
`finalizer` is required to call `writer-voice-tone` before writing anything public, and that
tool serves `plugins/autopilot/rules/voice.md`.

That file is a profile of how *you* write, derived from what you have actually written. It is
gitignored for the same reason the registry is: it carries your name. Only
`voice.template.md` is published, and while no `voice.md` exists the tool serves the template
with `calibrated: false` — the agent is told the voice is not calibrated and stays factual
instead of imitating a style it does not know.

To produce yours, gather a real corpus — export your own MR comments, Slack messages and
commit messages, a few hundred lines is plenty — and give Claude this prompt alongside it:

> You are building a writing-voice profile that another AI agent will follow to write
> messages published under my name — Slack, Jira comments, GitLab MR thread replies.
>
> The corpus below contains only texts I wrote myself. Work from observation, never from
> assumption: every rule you state must be backed by a pattern that actually recurs in the
> corpus, and you must quote real examples for each one. Where the corpus is too thin to
> conclude, say so explicitly rather than filling the gap — mark those sections as
> extrapolated.
>
> Follow the structure of `voice.template.md` exactly, section by section. Pay particular
> attention to:
>
> - the **invariants** — what holds in every context, especially punctuation and spacing
>   habits, which are the most visible signature and the first thing an agent gets wrong;
> - **restrictive** rules over permissive ones. An agent's reflex is to structure text with
>   labels, headings and bullet lists, and that is what gives away automation fastest. State
>   plainly what I never do.
> - the **lexicon** — the words I use and the words I never use. Two people following the
>   same rules are told apart by this.
> - a final **self-check list** of eight to ten closed questions derived from the rules above,
>   where a single "no" means rewrite.
>
> Keep the `@autopilot` prohibition from the template verbatim: it is a system constraint, not
> a style preference.
>
> Report the corpus volume you actually analysed, per source, in the table at the top.
>
> Here is the corpus:
> [paste]

Then read it back and correct it by hand. A profile you have not reread is a profile that
will publish something you would not have written.

## Verify

| Command | What it answers |
|---|---|
| `pnpm verify` | TypeScript, unit tests, workflow tests and live-shell build |
| `pnpm test` | deterministic functions, transport and boundary regressions |
| `pnpm test:workflow` | tool integration, routing and publication preconditions in a sandbox |
| `pnpm eval` | does this **agent** judge well? one suite per agent |
| `pnpm typecheck` | — |

GitHub Actions runs the deterministic checks on Node 22.18 and Node 24. The integration
suite uses real Git repositories and local fake services. It does not establish a success
rate for real Claude runs; the separate evals and real-ticket measurements serve that purpose.

There is **no** `--dry-run` in autopilot: the `tests/workflow/` sandbox replaces it, and
replaces it better. A flag can be bypassed and verifies nothing; a sandbox verifies what
actually happened. Git is not mocked in it either — the fake repositories are real
repositories, with a real bare remote.

## Measure

Three counters, in the `metrics` block of the tracking file:

- **`mrFeedbackCount`** — the primary indicator: it measures the effect of incrementing the
  memory. Filled in **by hand** for as long as workflow 2 does not exist.
- **`humanInterventions`** — the gate, escalations, answers to `ask-user`.
- **`loopTurnsTotal`** — the sum of the loop counters.

v2 is allowed to be slower than v1 if it is more rigorous.

## Out of scope, deliberately

**Workflow 2** — collecting feedback from Slack, Jira, MR threads and CI, handling it on the
same branch, then archiving — does not exist. Until it does, MR feedback is handled by hand.
The `workflow2` fields of the tracking file and the `jira.workflow2` block of `autopilot.yaml`
are already there: the day it gets wired in, no already-processed ticket will need migrating.

**No semantic index** either. Memory search is a deterministic filter on the frontmatter plus a
grep: exact, free, debuggable, never out of sync. An index gets added the day deterministic
search stops being enough.

## Two deliberate deviations

**On where the evals live.** `claude plugin eval` only resolves its case directory **under the
plugin**, and targeting the plugin by name runs it against the installed copy in the cache
rather than the working tree — so it would never see the agent prompts you just edited. The
suites therefore live in `plugins/autopilot/evals/`, declared by `experimental.evals` in the
manifest. It is the only location where `pnpm eval` evaluates the code in front of you.

**On the fixture repositories.** A git repository **inside** a git repository is a nested
`.git`, which git will not track without a submodule or a rename restored at startup — that is,
a generator, only less readable. They are described in `tests/fixtures/repos.ts` and
materialized at runtime, in a temporary directory per case: four real repositories, with a real
**bare** remote, different `level`s, an upstream/downstream dependency, a monorepo, and a suite
that can be made to fail on demand. Each test starts from a fresh repository, inheriting
nothing from a tag a previous test pushed.

To open them by hand:

```
pnpm fixtures          # writes them to tests/.fixtures/, gitignored
```

## License

MIT — see [LICENSE](LICENSE).
