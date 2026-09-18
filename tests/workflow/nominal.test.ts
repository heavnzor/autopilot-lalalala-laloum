import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { approvePlan, closeRepo, openRepo, passChecklists, runTests, writeCode, writeTest } from "./cycle.ts";
import { createSandbox } from "./harness.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("scenario 1 — nominal mono-repo, du ticket a la MR", () => {
  it("passe du ticket a la MR sans boucle, et ne publie qu'a la fin", async () => {
    const sandbox = await createSandbox({
      ticket: { key: "TJ-100", summary: "Ajouter le filtre par periode" },
      slackUsers: { "moi@test.fr": "U1" },
    });
    try {
      // --- Phase 1, cadrage ------------------------------------------------
      await sandbox.call("acquire-ticket-lock", { ticketId: "TJ-100", runId: "run-1" });

      const ticket = await sandbox.call<any>("get-ticket", { ticketId: "TJ-100" });
      assert.equal(ticket.jira.title, "Ajouter le filtre par periode");
      assert.equal(ticket.resumable, false);
      assert.equal(ticket.squad, "TJ");

      await sandbox.call("write-store-ticket", {
        ticketId: "TJ-100",
        patch: {
          ticket: { title: ticket.jira.title, type: "feature", statusAtStart: ticket.jira.status },
          plan: { content: "un repo, un test, du code" },
          run: { phase: "implementation", step: "10.1" },
          scope: [{ name: "fixture-core", level: 1, status: "pending" }],
        },
      });

      // --- Phase 2, implementation ----------------------------------------
      await approvePlan(sandbox, "TJ-100", ["fixture-core"]);
      const options = {
        ticketId: "TJ-100",
        repo: "fixture-core",
        title: "Ajouter le filtre par periode",
        test: {
          path: "tests/window.test.js",
          content:
            "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { windowOf } from '../src/window.js';\n\ntest('windowOf rend un intervalle', () => {\n  assert.deepEqual(windowOf('2026-09'), ['2026-09-01', '2026-09-30']);\n});\n",
        },
        code: {
          path: "src/window.js",
          content: "export function windowOf(period) {\n  return [`${period}-01`, `${period}-30`];\n}\n",
        },
      };

      const { worktree, branch } = await openRepo(sandbox, options);
      assert.ok(existsSync(worktree), "le worktree existe");
      assert.equal(branch, "feature/TJ-100-ajouter-le-filtre-par-periode");

      // 10.1 puis 10.3 : le test doit etre rouge avant toute implementation.
      await writeTest(sandbox, { ...options, worktree });
      const red = await runTests(sandbox, "TJ-100", "fixture-core");
      assert.equal(red.passed, false, `un test vert avant implementation ne teste rien — ran=${red.ran} exit=${red.exitCode}\n${red.stdout.slice(-1500)}`);

      // 10.4 puis 10.5 : le code, puis le vert.
      await writeCode(sandbox, { ...options, worktree });
      const green = await runTests(sandbox, "TJ-100", "fixture-core");
      assert.equal(green.passed, true, green.stdout.slice(-800));

      await closeRepo(sandbox, "TJ-100", "fixture-core");
      await passChecklists(sandbox, "TJ-100");

      // Avant le point 13, rien n'est publie.
      assert.equal(sandbox.gitlab.mergeRequests.length, 0);
      assert.equal(sandbox.slack.channels.length, 0);
      assert.equal(sandbox.jira.transitions.length, 0);

      // --- Phase 3, publication --------------------------------------------
      await sandbox.call("write-store-ticket", { ticketId: "TJ-100", patch: { run: { step: "13", phase: "publication" } } });
      await sandbox.call("push-branch", { ticketId: "TJ-100", repo: "fixture-core" });
      const { title } = await sandbox.call<{ title: string }>("generate-mr-name", {
        type: "feature",
        ticketId: "TJ-100",
        title: "Ajouter le filtre par periode",
      });
      const mr = await sandbox.call<{ iid: number; url: string; draft: boolean }>("create-gitlab-mr", {
        ticketId: "TJ-100",
        repo: "fixture-core",
        sourceBranch: branch,
        title,
        description: "Ce que fait ce changement.",
      });
      assert.equal(mr.draft, true, "les MR sont creees en brouillon par defaut");

      const channel = await sandbox.call<{ id: string; name: string }>("create-slack-channel", {
        ticketId: "TJ-100",
        title: "Ajouter le filtre par periode",
      });
      assert.equal(channel.name, "tj-100-ajouter-le-filtre-par-periode");

      await sandbox.call("post-slack-message", { ticketId: "TJ-100", channelId: channel.id, text: `La MR est prete :\n${mr.url}` });
      await sandbox.call("transition-jira-ticket", { ticketId: "TJ-100" });

      // --- Ce qui doit exister a la fin ------------------------------------
      assert.equal(sandbox.gitlab.mergeRequests.length, 1);
      assert.equal(sandbox.slack.channels.length, 1);
      assert.deepEqual(sandbox.jira.transitions, [{ key: "TJ-100", to: "En cours" }]);

      // La branche est bien sur le remote, avec les deux commits.
      const remote = sandbox.repo("fixture-core").remote;
      assert.ok(git(remote, ["branch", "--list", branch]).includes(branch));
      assert.equal(git(remote, ["rev-list", "--count", branch]), "3");

      const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-100" });
      assert.equal(state.scope[0].status, "done");
      assert.equal(state.publication.jiraTransition.to, "En cours");
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("scenario 2 — nominal multi-repo, l'ordre des level", () => {
  it("termine un repo avant d'ouvrir le suivant, amont vers aval", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-200", summary: "Traverser trois repos" } });
    try {
      const registry = await sandbox.call<any>("get-repositories-registry", { includeEvalRepos: true });
      const scope = registry.repositories.filter((repo: any) =>
        ["fixture-core", "fixture-app", "fixture-mono"].includes(repo.name),
      );

      // Le registre rend deja l'ordre de traitement.
      assert.deepEqual(
        scope.map((repo: any) => repo.name),
        ["fixture-core", "fixture-app", "fixture-mono"],
      );

      const done: string[] = [];
      for (const repo of scope) {
        const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-200" });
        const inProgress = (state.scope ?? []).filter((entry: any) => entry.status === "in-progress");
        assert.deepEqual(inProgress, [], "un repo doit etre termine avant qu'on ouvre le suivant");

        await openRepo(sandbox, { ticketId: "TJ-200", repo: repo.name, title: "Traverser trois repos" });
        await closeRepo(sandbox, "TJ-200", repo.name);
        done.push(repo.name);
      }

      assert.deepEqual(done, ["fixture-core", "fixture-app", "fixture-mono"]);

      const final = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-200" });
      assert.deepEqual(
        final.scope.map((entry: any) => entry.status),
        ["done", "done", "done"],
      );
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("scenario 11 — pas de maquette Figma", () => {
  it("continue sans interruption quand le ticket n'en a aucune", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-300", summary: "Un ticket sans maquette" } });
    try {
      const result = await sandbox.call<any>("get-figma-components", { searchIn: "Aucune maquette dans ce ticket." });
      assert.equal(result.found, false);
      assert.deepEqual(result.files, []);
      assert.match(result.note, /pas un echec/);

      // Le run continue : l'etape suivante s'ecrit normalement.
      await sandbox.call("write-store-ticket", { ticketId: "TJ-300", patch: { run: { step: "3" } } });
      const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-300" });
      assert.equal(state.run.step, "3");
    } finally {
      await sandbox.cleanup();
    }
  });
});
