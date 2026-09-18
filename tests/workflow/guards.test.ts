import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { receiptPath } from "../../plugins/autopilot/mcp/lib/receipts.ts";
import { setFlaky } from "../fixtures/repos.ts";
import { approvePlan, openRepo, passChecklists, preparePublication, prepareUpstream, runTests } from "./cycle.ts";
import { createSandbox } from "./harness.ts";

describe("les outils de publication font respecter leurs preconditions", () => {
  it("un approvedAt dans le YAML ne remplace pas le gate humain", async () => {
    const sandbox = await createSandbox();
    try {
      await preparePublication(sandbox, "TJ-100");
      rmSync(receiptPath("TJ-100", "approval.json"));
      await sandbox.call("write-store-ticket", { ticketId: "TJ-100", patch: { plan: { approvedAt: new Date().toISOString() } } });
      const refusal = await sandbox.expectFailure("push-branch", { ticketId: "TJ-100", repo: "fixture-core" });
      assert.match(refusal, /approbation humaine valide/);
    } finally { await sandbox.cleanup(); }
  });
  it("un plan modifie invalide son ancienne approbation", async () => {
    const sandbox = await createSandbox();
    try {
      await preparePublication(sandbox, "TJ-100");
      await sandbox.call("write-store-ticket", { ticketId: "TJ-100", patch: { plan: { repos: [{ repo: "fixture-core", changes: ["Autre comportement."] }] } } });
      assert.match(await sandbox.expectFailure("create-slack-channel", { ticketId: "TJ-100" }), /approbation humaine valide/);
      assert.equal(sandbox.slack.channels.length, 0);
    } finally { await sandbox.cleanup(); }
  });
  it("refuse une publication prematuree ou une checklist incomplete", async () => {
    const sandbox = await createSandbox();
    try {
      await preparePublication(sandbox, "TJ-100");
      await sandbox.call("write-store-ticket", { ticketId: "TJ-100", patch: { run: { step: "10.1" } } });
      assert.match(await sandbox.expectFailure("push-branch", { ticketId: "TJ-100", repo: "fixture-core" }), /point 13/);
      await sandbox.call("write-store-ticket", { ticketId: "TJ-100", patch: { run: { step: "13" }, plan: { checklists: { code: [{ id: "C1", status: "pending" }] } } } });
      assert.match(await sandbox.expectFailure("push-branch", { ticketId: "TJ-100", repo: "fixture-core" }), /Checklist code non validee/);
    } finally { await sandbox.cleanup(); }
  });
  it("un vert sur l'ancien commit ne valide pas le nouveau", async () => {
    const sandbox = await createSandbox();
    try {
      await preparePublication(sandbox, "TJ-100");
      const cwd = join(sandbox.home, "worktrees", "TJ-100", "fixture-core");
      writeFileSync(join(cwd, "src", "period.js"), "export function clamp(period) { return period ?? ''; }\n");
      await sandbox.call("create-code-commit", { ticketId: "TJ-100", repo: "fixture-core", message: "fix: adjust empty period" });
      assert.match(await sandbox.expectFailure("push-branch", { ticketId: "TJ-100", repo: "fixture-core" }), /verification complete ut/);
      await runTests(sandbox, "TJ-100", "fixture-core");
      assert.equal((await sandbox.call<any>("push-branch", { ticketId: "TJ-100", repo: "fixture-core" })).pushed, true);
    } finally { await sandbox.cleanup(); }
  });
  it("une verification ciblee ne se fait pas passer pour la suite complete", async () => {
    const sandbox = await createSandbox();
    try {
      await preparePublication(sandbox, "TJ-100");
      await sandbox.call("run-test-ut", { ticketId: "TJ-100", repo: "fixture-core", paths: ["tests/period.test.js"] });
      assert.match(await sandbox.expectFailure("push-branch", { ticketId: "TJ-100", repo: "fixture-core" }), /verification complete ut/);
    } finally { await sandbox.cleanup(); }
  });
  it("refuse les effets publics tant qu'un autre depot reste en cours", async () => {
    const sandbox = await createSandbox();
    try {
      await preparePublication(sandbox, "TJ-100", ["fixture-core", "fixture-app"]);
      await sandbox.call("write-store-ticket", { ticketId: "TJ-100", patch: { scope: [{ name: "fixture-app", status: "in-progress" }] } });
      assert.match(await sandbox.expectFailure("push-branch", { ticketId: "TJ-100", repo: "fixture-core" }), /fixture-app n'est pas termine/);
    } finally { await sandbox.cleanup(); }
  });
  it("un agent ne peut pas modifier le role de son outil de commit", async () => {
    const sandbox = await createSandbox();
    try {
      assert.match(await sandbox.expectFailure("create-code-commit", { ticketId: "TJ-100", repo: "fixture-core", message: "test: bypass", role: "test-writer" }), /additional properties/);
    } finally { await sandbox.cleanup(); }
  });
  it("le filtre shell est refuse face a une vraie suite rouge", async () => {
    const sandbox = await createSandbox();
    try {
      const { worktree } = await openRepo(sandbox, { ticketId: "TJ-100", repo: "fixture-flaky", title: "Faux vert" });
      setFlaky(worktree, true);
      assert.equal((await runTests(sandbox, "TJ-100", "fixture-flaky")).passed, false);
      assert.match(await sandbox.expectFailure("run-test-ut", { ticketId: "TJ-100", repo: "fixture-flaky", filter: "; true" }), /filtre/);
    } finally { await sandbox.cleanup(); }
  });
  it("reprend un push de tag sans deplacer ni recreer sa version", async () => {
    const sandbox = await createSandbox();
    try {
      await openRepo(sandbox, { ticketId: "TJ-100", repo: "fixture-core", title: "Tag repris" });
      await prepareUpstream(sandbox, "TJ-100");
      const input = { ticketId: "TJ-100", repo: "fixture-core", tag: "v1.0.0-TJ-100-1" };
      const first = await sandbox.call<any>("push-tag", input);
      const second = await sandbox.call<any>("push-tag", input);
      assert.equal(first.sha, second.sha);
      assert.equal(second.resumed, true);
    } finally { await sandbox.cleanup(); }
  });
});

describe("le serveur route les verdicts et tient les budgets", () => {
  it("prepare une API nouvelle puis revient au controle du rouge", async () => {
    const sandbox = await createSandbox();
    try {
      await approvePlan(sandbox, "TJ-100", ["fixture-core"]);
      await sandbox.call("write-store-ticket", { ticketId: "TJ-100", patch: { run: { step: "10.3", currentRepo: "fixture-core" } } });
      const scaffold = await sandbox.call<any>("advance-workflow", { ticketId: "TJ-100", expectedStep: "10.3", outcome: "scaffold" });
      assert.equal(scaffold.next, "10.4");
      assert.equal(scaffold.mode, "scaffold");
      assert.equal((await sandbox.call<any>("advance-workflow", { ticketId: "TJ-100", expectedStep: "10.4", outcome: "pass" })).next, "10.3");
    } finally { await sandbox.cleanup(); }
  });
  it("route une correction de test, verifie le vert et termine le depot", async () => {
    const sandbox = await createSandbox();
    try {
      await approvePlan(sandbox, "TJ-100", ["fixture-flaky"]);
      const advance = async (outcome: string) => {
        const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-100" });
        return sandbox.call<any>("advance-workflow", { ticketId: "TJ-100", expectedStep: state.run.step, outcome });
      };
      assert.equal((await advance("pass")).next, "10.1");
      await openRepo(sandbox, { ticketId: "TJ-100", repo: "fixture-flaky", title: "Cycle route" });
      assert.equal((await advance("pass")).next, "10.2");
      assert.equal((await advance("retry")).next, "10.1");
      assert.equal((await advance("tests-corrected")).next, "10.2");
      assert.equal((await advance("pass")).next, "10.4");
      assert.equal((await advance("pass")).next, "10.5");
      await runTests(sandbox, "TJ-100", "fixture-flaky");
      assert.equal((await advance("pass")).next, "10.6");
      await passChecklists(sandbox, "TJ-100");
      const completed = await advance("pass");
      assert.equal(completed.next, "11");
      assert.equal(completed.state.scope[0].status, "done");
      assert.equal(completed.state.metrics.loopTurnsTotal, 4);
    } finally { await sandbox.cleanup(); }
  });
  it("escalade lui-meme au dernier verdict negatif, sans tour supplementaire", async () => {
    const sandbox = await createSandbox();
    try {
      await approvePlan(sandbox, "TJ-100", ["fixture-core"]);
      await sandbox.call("write-store-ticket", { ticketId: "TJ-100", patch: { run: { step: "10.6", currentRepo: "fixture-core" }, scope: [{ name: "fixture-core", loops: { codeAdversary: 2 } }] } });
      const result = await sandbox.call<any>("advance-workflow", { ticketId: "TJ-100", expectedStep: "10.6", outcome: "retry" });
      assert.equal(result.escalated, true);
      assert.equal(result.state.scope[0].loops.codeAdversary, 3);
      assert.equal(result.state.run.phase, "escalated");
      assert.equal(sandbox.gitlab.mergeRequests.length, 0);
    } finally { await sandbox.cleanup(); }
  });
  it("ne route qu'une fois deux verdicts concurrents sur le meme curseur", async () => {
    const sandbox = await createSandbox();
    try {
      await approvePlan(sandbox, "TJ-100", ["fixture-core"]);
      await openRepo(sandbox, { ticketId: "TJ-100", repo: "fixture-core", title: "Concurrence" });
      await runTests(sandbox, "TJ-100", "fixture-core");
      await sandbox.call("write-store-ticket", { ticketId: "TJ-100", patch: { run: { step: "10.5" } } });
      const input = { ticketId: "TJ-100", expectedStep: "10.5", outcome: "pass" };
      const results = await Promise.allSettled([sandbox.call("advance-workflow", input), sandbox.call("advance-workflow", input)]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      const state = await sandbox.call<any>("get-store-ticket", { ticketId: "TJ-100" });
      assert.equal(state.run.step, "10.6");
      assert.equal(state.scope[0].loops.greenChecker, 1);
    } finally { await sandbox.cleanup(); }
  });
});
