import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox } from "./harness.ts";

/**
 * Le cycle d'implementation d'un repo, reduit a sa sequence de tools.
 *
 * Ces tests verifient **l'enchainement**, pas le jugement des agents : un
 * workflow peut s'enchainer parfaitement avec un plan mediocre. La qualite du
 * jugement, c'est le role des evals — et c'est pour ca que les trois niveaux
 * coexistent.
 */

export interface CycleOptions {
  readonly ticketId: string;
  readonly repo: string;
  readonly type?: string;
  readonly title: string;
  /** Ce que le `test-writer` ecrit, puis ce que le `developer` ecrit. */
  readonly test?: { path: string; content: string };
  readonly code?: { path: string; content: string };
}

export async function openRepo(sandbox: Sandbox, options: CycleOptions): Promise<{ worktree: string; branch: string }> {
  const created = await sandbox.call<{ worktree: string; branch: string }>("create-worktree", {
    ticketId: options.ticketId,
    repo: options.repo,
    type: options.type ?? "feature",
    title: options.title,
  });
  await sandbox.call("setup-repo", { ticketId: options.ticketId, repo: options.repo });
  await sandbox.call("write-store-ticket", {
    ticketId: options.ticketId,
    patch: {
      run: { phase: "implementation", step: "10.1", currentRepo: options.repo },
      scope: [{ name: options.repo, status: "in-progress", worktree: created.worktree, branch: created.branch }],
    },
  });
  return created;
}

/** 10.1 — le test-writer ecrit un test, et rien d'autre. */
export async function writeTest(sandbox: Sandbox, options: CycleOptions & { worktree: string }): Promise<string> {
  if (!options.test) throw new Error("writeTest sans test");
  writeFileSync(join(options.worktree, options.test.path), options.test.content, "utf8");
  const { message } = await sandbox.call<{ message: string }>("generate-commit-message", {
    type: "test",
    subject: "cover the new behaviour",
    ticketId: options.ticketId,
  });
  const commit = await sandbox.call<{ commitSha: string }>("create-test-commit", {
    ticketId: options.ticketId,
    repo: options.repo,
    message,
  });
  return commit.commitSha;
}

/** 10.3 / 10.5 — on lance la suite et on rend le verdict brut. */
export async function runTests(sandbox: Sandbox, ticketId: string, repo: string): Promise<{ ran: boolean; passed: boolean; exitCode: number; stdout: string }> {
  const result = await sandbox.call<{ ran: boolean; passed?: boolean; exitCode?: number; stdout?: string; stderr?: string }>(
    "run-test-ut",
    { ticketId, repo },
  );
  return {
    ran: Boolean(result.ran),
    passed: Boolean(result.passed),
    exitCode: result.exitCode ?? -1,
    stdout: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** 10.4 — le developer ecrit le code, et jamais un test. */
export async function writeCode(sandbox: Sandbox, options: CycleOptions & { worktree: string }): Promise<string> {
  if (!options.code) throw new Error("writeCode sans code");
  writeFileSync(join(options.worktree, options.code.path), options.code.content, "utf8");
  const { message } = await sandbox.call<{ message: string }>("generate-commit-message", {
    type: "feat",
    subject: "implement the new behaviour",
    ticketId: options.ticketId,
  });
  const commit = await sandbox.call<{ commitSha: string }>("create-code-commit", {
    ticketId: options.ticketId,
    repo: options.repo,
    message,
  });
  return commit.commitSha;
}

export async function closeRepo(sandbox: Sandbox, ticketId: string, repo: string): Promise<void> {
  await sandbox.call("write-store-ticket", {
    ticketId,
    patch: { run: { step: "10.7" }, scope: [{ name: repo, status: "done" }] },
  });
}

export function readFile(worktree: string, path: string): string {
  return readFileSync(join(worktree, path), "utf8");
}

/** Le test emprunte le vrai gate ; il ne forge plus approvedAt dans le YAML. */
export async function approvePlan(sandbox: Sandbox, ticketId: string, names: string[]): Promise<void> {
  const repos = names.map((name) => sandbox.repo(name)).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  const plan = repos.map((repo) => ({ repo: repo.name, level: repo.level, changes: [`Implementer le changement dans ${repo.name}.`], why: "Ordre des dependances." }));
  const tests = repos.map((repo, index) => ({ id: `T${index + 1}`, repo: repo.name, criterion: "Le comportement attendu est verifie.", status: "pending" }));
  const code = repos.map((repo, index) => ({ id: `C${index + 1}`, repo: repo.name, criterion: "Les appelants restent compatibles.", status: "pending" }));
  await sandbox.call("write-store-ticket", { ticketId, patch: {
    run: { step: "9", phase: "cadrage", escalation: null },
    scope: repos.map((repo) => ({ name: repo.name, level: repo.level })),
    plan: { repos: { __replace: plan }, checklists: { tests: { __replace: tests }, code: { __replace: code } } },
  } });
  await sandbox.call("ask-plan-approval", { ticketId, repos: plan }, {
    canAskHuman: true, heartbeat: () => {},
    askHuman: async () => ({ action: "accept", content: { verdict: "approve", note: "" } }),
  });
}

export async function passChecklists(sandbox: Sandbox, ticketId: string, repo?: string): Promise<void> {
  const state = await sandbox.call<any>("get-store-ticket", { ticketId });
  const patch = (kind: string) => state.plan.checklists[kind].filter((row: any) => !repo || row.repo === repo).map((row: any) => ({ id: row.id, status: "passed" }));
  await sandbox.call("write-store-ticket", { ticketId, patch: { plan: { checklists: { tests: patch("tests"), code: patch("code") } } } });
}

/** Preparation realiste des tests de publication qui ne portent pas sur le TDD. */
export async function preparePublication(sandbox: Sandbox, ticketId: string, names = ["fixture-core"]): Promise<void> {
  await approvePlan(sandbox, ticketId, names);
  for (const repo of names) {
    await openRepo(sandbox, { ticketId, repo, title: "Publication fixture" });
    const result = await runTests(sandbox, ticketId, repo);
    if (!result.passed) throw new Error(result.stdout);
    await closeRepo(sandbox, ticketId, repo);
  }
  await passChecklists(sandbox, ticketId);
  await sandbox.call("write-store-ticket", { ticketId, patch: { run: { step: "13", phase: "publication" } } });
}

export async function prepareUpstream(sandbox: Sandbox, ticketId: string): Promise<void> {
  await approvePlan(sandbox, ticketId, ["fixture-core", "fixture-app"]);
  const result = await runTests(sandbox, ticketId, "fixture-core");
  if (!result.passed) throw new Error(result.stdout);
  await passChecklists(sandbox, ticketId, "fixture-core");
  await sandbox.call("write-store-ticket", { ticketId, patch: { run: { step: "10.7", phase: "implementation", currentRepo: "fixture-core" } } });
}
