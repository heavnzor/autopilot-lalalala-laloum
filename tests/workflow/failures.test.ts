import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setFlaky } from "../fixtures/repos.ts";
import { openRepo, preparePublication, prepareUpstream, runTests } from "./cycle.ts";
import { createSandbox } from "./harness.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

describe("scenario 5 — boucle rouge", () => {
  it("reboucle sur le developer jusqu'au vert, sans jamais toucher au test", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-600", summary: "Faire passer une suite rouge" } });
    try {
      const { worktree } = await openRepo(sandbox, {
        ticketId: "TJ-600",
        repo: "fixture-flaky",
        title: "Faire passer une suite rouge",
      });

      // 10.3 : la suite est rouge, pour la bonne raison — une assertion.
      setFlaky(worktree, true);
      const red = await runTests(sandbox, "TJ-600", "fixture-flaky");
      assert.equal(red.passed, false);
      assert.match(red.stdout, /answer vaut 42|AssertionError|not ok/i, red.stdout.slice(-600));

      // 10.4 : le developer corrige le code, et seulement le code.
      setFlaky(worktree, false);
      await sandbox.call("create-code-commit", {
        ticketId: "TJ-600",
        repo: "fixture-flaky",
        message: "fix: restore the expected answer\n\nRefs: TJ-600",
      });
      await sandbox.call("write-store-ticket", {
        ticketId: "TJ-600",
        patch: { run: { step: "10.5" }, scope: [{ name: "fixture-flaky", loops: { greenChecker: { __increment: 1 } } }] },
      });

      // 10.5 : vert.
      const green = await runTests(sandbox, "TJ-600", "fixture-flaky");
      assert.equal(green.passed, true, green.stdout.slice(-600));

      const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-600" });
      assert.equal(state.scope[0].loops.greenChecker, 1);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("refuse au developer d'ecrire un test, meme pour faire passer la suite", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-610", summary: "Tentation" } });
    try {
      const { worktree } = await openRepo(sandbox, { ticketId: "TJ-610", repo: "fixture-flaky", title: "Tentation" });

      // Le raccourci evident : reecrire l'assertion plutot que le code.
      writeFileSync(
        join(worktree, "tests", "answer.test.js"),
        "import { test } from 'node:test';\ntest('ok', () => {});\n",
        "utf8",
      );

      const refusal = await sandbox.expectFailure("create-code-commit", {
        ticketId: "TJ-610",
        repo: "fixture-flaky",
        message: "fix: adjust the test\n\nRefs: TJ-610",
      });
      assert.match(refusal, /n'ecrit pas dans cette zone/);

      // Et l'index est propre : rien n'est reste stage apres le refus.
      assert.equal(git(worktree, ["diff", "--cached", "--name-only"]), "");
    } finally {
      await sandbox.cleanup();
    }
  });

  it("refuse au test-writer d'ecrire du code de production", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-620", summary: "Zone inverse" } });
    try {
      const { worktree } = await openRepo(sandbox, { ticketId: "TJ-620", repo: "fixture-flaky", title: "Zone inverse" });
      writeFileSync(join(worktree, "src", "answer.js"), "export const answer = 1;\n", "utf8");

      const refusal = await sandbox.expectFailure("create-test-commit", {
        ticketId: "TJ-620",
        repo: "fixture-flaky",
        message: "test: add coverage\n\nRefs: TJ-620",
      });
      assert.match(refusal, /n'ecrit que des fichiers de test/);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("scenario 6 — budget epuise", () => {
  it("escalade au troisieme tour et ne publie rien", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-700", summary: "Une boucle qui ne converge pas" } });
    try {
      await openRepo(sandbox, { ticketId: "TJ-700", repo: "fixture-flaky", title: "Une boucle qui ne converge pas" });
      const { budgets } = (await sandbox.call<any>("get-autopilot-config", { section: "budgets" })).budgets
        ? await sandbox.call<any>("get-autopilot-config", {})
        : { budgets: { codeAdversary: 3 } };

      for (let turn = 1; turn <= budgets.codeAdversary; turn += 1) {
        await sandbox.call("write-store-ticket", {
          ticketId: "TJ-700",
          patch: { run: { step: "10.6" }, scope: [{ name: "fixture-flaky", loops: { codeAdversary: { __increment: 1 } } }] },
        });
      }

      const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-700" });
      assert.equal(state.scope[0].loops.codeAdversary, budgets.codeAdversary);

      const escalation = await sandbox.call<any>("escalate-to-human", {
        ticketId: "TJ-700",
        reason: "Budget code-adversary epuise apres 3 tours.",
        step: "10.6",
        repo: "fixture-flaky",
      });
      assert.equal(escalation.escalated, true);
      assert.match(escalation.note, /Rien n'est publie/);

      const after = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-700" });
      assert.equal(after.run.phase, "escalated");
      assert.equal(after.run.escalation.step, "10.6");
      assert.equal(after.metrics.humanInterventions, 1);

      // Jamais de livraison en l'etat.
      assert.equal(sandbox.gitlab.mergeRequests.length, 0);
      assert.equal(sandbox.slack.channels.length, 0);
      assert.equal(sandbox.jira.transitions.length, 0);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("scenario 7 — meme test conteste deux fois", () => {
  it("escalade au lieu de laisser deux agents s'entre-convaincre", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-800", summary: "Un test conteste" } });
    try {
      await openRepo(sandbox, { ticketId: "TJ-800", repo: "fixture-flaky", title: "Un test conteste" });
      const config = await sandbox.call<any>("get-autopilot-config", {});
      const limit = config.budgets.disputeBeforeEscalation;
      assert.equal(limit, 2);

      const test = "answer.test.js > answer vaut 42";
      for (let count = 1; count <= limit; count += 1) {
        await sandbox.call("write-store-ticket", {
          ticketId: "TJ-800",
          patch: {
            scope: [
              {
                name: "fixture-flaky",
                disputes: [{ test, count, reason: "assertion inversee", verdict: count < limit ? "refuse" : "refuse" }],
              },
            ],
          },
        });
      }

      const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-800" });
      const dispute = state.scope[0].disputes.find((entry: any) => entry.test === test);
      assert.equal(dispute.count, limit, "le compteur est tenu par test, pas globalement");
      assert.equal(state.scope[0].disputes.length, 1, "le meme test ne cree pas deux entrees");

      await sandbox.call("escalate-to-human", {
        ticketId: "TJ-800",
        reason: `Le test ${test} a ete conteste ${limit} fois.`,
        step: "10.4",
        repo: "fixture-flaky",
      });
      const after = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-800" });
      assert.equal(after.run.phase, "escalated");
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("scenario 8 — reprise", () => {
  it("reprend a l'etape exacte et ne refait pas un repo deja termine", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-900", summary: "Reprendre au milieu" } });
    try {
      // Premier run : le repo 1 est termine, le repo 2 est en cours.
      await openRepo(sandbox, { ticketId: "TJ-900", repo: "fixture-core", title: "Reprendre au milieu" });
      await sandbox.call("write-store-ticket", {
        ticketId: "TJ-900",
        patch: { scope: [{ name: "fixture-core", level: 1, status: "done" }] },
      });
      const app = await openRepo(sandbox, { ticketId: "TJ-900", repo: "fixture-app", title: "Reprendre au milieu" });
      await sandbox.call("write-store-ticket", {
        ticketId: "TJ-900",
        patch: {
          run: { phase: "implementation", step: "10.4", currentRepo: "fixture-app" },
          scope: [{ name: "fixture-app", level: 2, status: "in-progress", commits: ["abc1234"] }],
        },
      });

      // Le run est tue ici. On libere le lock comme le ferait un redemarrage.
      await sandbox.call("release-ticket-lock", { ticketId: "TJ-900" });

      // Second run : /autopilot-start reprend au lieu de repartir de zero.
      await sandbox.call("acquire-ticket-lock", { ticketId: "TJ-900", runId: "run-2" });
      const resumed = await sandbox.call<any>("get-ticket", { ticketId: "TJ-900" });

      assert.equal(resumed.resumable, true);
      assert.deepEqual(resumed.resumeAt, { phase: "implementation", step: "10.4", currentRepo: "fixture-app" });

      const scope = resumed.store.scope as any[];
      assert.equal(scope.find((entry) => entry.name === "fixture-core").status, "done");
      assert.equal(scope.find((entry) => entry.name === "fixture-app").status, "in-progress");
      assert.deepEqual(scope.find((entry) => entry.name === "fixture-app").commits, ["abc1234"]);

      // Le worktree du repo en cours est toujours la, avec son travail.
      assert.ok(existsSync(app.worktree));
      assert.equal(git(app.worktree, ["rev-parse", "--abbrev-ref", "HEAD"]), app.branch);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("scenario 9 — echec en cours de route", () => {
  it("laisse les commits et les tags, et n'a rien publie", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-950", summary: "Mourir au milieu" } });
    try {
      const { worktree, branch } = await openRepo(sandbox, {
        ticketId: "TJ-950",
        repo: "fixture-core",
        title: "Mourir au milieu",
      });

      writeFileSync(join(worktree, "src", "period.js"), "export function clamp(p) {\n  return p ?? '';\n}\n", "utf8");
      const commit = await sandbox.call<any>("create-code-commit", {
        ticketId: "TJ-950",
        repo: "fixture-core",
        message: "feat: clamp the empty period\n\nRefs: TJ-950",
      });
      await prepareUpstream(sandbox, "TJ-950");
      await sandbox.call("push-tag", { ticketId: "TJ-950", repo: "fixture-core", tag: "v1.0.0-TJ-950-1" });

      await sandbox.call("escalate-to-human", {
        ticketId: "TJ-950",
        reason: "Le repo aval ne compile plus apres le bump.",
        step: "10.7",
        repo: "fixture-core",
      });

      // Ce qui reste : le dechet assume.
      assert.ok(existsSync(worktree), "le worktree porte le seul exemplaire du travail");
      assert.equal(git(worktree, ["log", "-1", "--format=%h"]), commit.commitSha);
      assert.ok(git(sandbox.repo("fixture-core").remote, ["tag", "--list"]).includes("v1.0.0-TJ-950-1"));

      // Ce qui n'a pas ete publie.
      assert.equal(git(sandbox.repo("fixture-core").remote, ["branch", "--list", branch]), "", "aucune branche poussee");
      assert.equal(sandbox.gitlab.mergeRequests.length, 0);
      assert.equal(sandbox.slack.channels.length, 0);
      assert.equal(sandbox.jira.transitions.length, 0);
      assert.equal(sandbox.jira.comments.length, 0);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("scenario 10 — allowlist slack", () => {
  it("n'invite personne d'autre que moi quand la squad est inconnue", async () => {
    const sandbox = await createSandbox({
      ticket: { key: "ZZ-1", summary: "Une squad jamais vue" },
      slackAllowlist: { FT: ["a@example.com"] },
      slackUsers: { "a@example.com": "U1" },
    });
    try {
      await preparePublication(sandbox, "ZZ-1");
      const channel = await sandbox.call<any>("create-slack-channel", { ticketId: "ZZ-1", title: "Une squad jamais vue" });
      const result = await sandbox.call<any>("invite-slack-users", { ticketId: "ZZ-1", channelId: channel.id });

      assert.equal(result.squad, "ZZ");
      assert.deepEqual(result.invited, []);
      assert.equal(result.fellBackToDefault, true);
      assert.match(result.note, /personne d'autre que moi/);
      // Le run n'echoue pas : le canal existe, il est juste vide.
      assert.equal(sandbox.slack.channels.length, 1);
      assert.equal(sandbox.slack.invited.length, 0);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("invite l'allowlist de la squad declaree, et rien de plus", async () => {
    const sandbox = await createSandbox({
      ticket: { key: "FT-1", summary: "Une squad connue" },
      slackAllowlist: { FT: ["a@example.com", "b@example.com"] },
      slackUsers: { "a@example.com": "U1", "b@example.com": "U2", "intrus@ailleurs.fr": "U9" },
    });
    try {
      await preparePublication(sandbox, "FT-1");
      const channel = await sandbox.call<any>("create-slack-channel", { ticketId: "FT-1", title: "Une squad connue" });
      const result = await sandbox.call<any>("invite-slack-users", { ticketId: "FT-1", channelId: channel.id });

      assert.deepEqual(result.invited.sort(), ["a@example.com", "b@example.com"]);
      assert.deepEqual(sandbox.slack.invited, [{ channel: channel.id, users: ["U1", "U2"] }]);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("refuse une adresse hors allowlist, meme passee explicitement", async () => {
    const sandbox = await createSandbox({
      ticket: { key: "FT-2", summary: "Tentative de contournement" },
      slackAllowlist: { FT: ["a@example.com"] },
      slackUsers: { "a@example.com": "U1", "intrus@ailleurs.fr": "U9" },
    });
    try {
      await preparePublication(sandbox, "FT-2");
      const channel = await sandbox.call<any>("create-slack-channel", { ticketId: "FT-2", title: "Tentative" });
      const refusal = await sandbox.expectFailure("invite-slack-users", {
        ticketId: "FT-2",
        channelId: channel.id,
        emails: ["intrus@ailleurs.fr"],
      });
      assert.match(refusal, /Hors allowlist/);
      assert.equal(sandbox.slack.invited.length, 0);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("refuse de publier un message qui porte le marqueur @autopilot", async () => {
    const sandbox = await createSandbox({ ticket: { key: "FT-3", summary: "Boucle de retours" } });
    try {
      await preparePublication(sandbox, "FT-3");
      const channel = await sandbox.call<any>("create-slack-channel", { ticketId: "FT-3", title: "Boucle" });
      const refusal = await sandbox.expectFailure("post-slack-message", {
        ticketId: "FT-3",
        channelId: channel.id,
        text: "@autopilot relance le run",
      });
      assert.match(refusal, /@autopilot est interdit/);
      assert.equal(sandbox.slack.messages.length, 0);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("scenario 12 — lock deja pris", () => {
  it("fait echouer le second run immediatement", async () => {
    const sandbox = await createSandbox({ ticket: { key: "TJ-990", summary: "Deux runs a la fois" } });
    try {
      const first = await sandbox.call<any>("acquire-ticket-lock", { ticketId: "TJ-990", runId: "run-1" });
      assert.equal(first.locked, true);

      const refusal = await sandbox.expectFailure("acquire-ticket-lock", { ticketId: "TJ-990", runId: "run-2" });
      assert.match(refusal, /deja verrouille/);

      // Une fois libere, le run suivant passe.
      const released = await sandbox.call<any>("release-ticket-lock", { ticketId: "TJ-990" });
      assert.equal(released.released, true);
      const second = await sandbox.call<any>("acquire-ticket-lock", { ticketId: "TJ-990", runId: "run-2" });
      assert.equal(second.locked, true);
      assert.equal(second.runId, "run-2");
    } finally {
      await sandbox.cleanup();
    }
  });
});
